import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { LocalIndex } from "../index/local-index.ts";
import { recordPrChangedFiles } from "../prfiles/pr-changed-file-store.ts";
import { agentRequestContext } from "./agent-request-context.ts";
import { drainNegationDisclosures } from "./negation-disclosure.ts";
import { createNegationTools } from "./negation-tools.ts";

// Mastra's `Tool['execute']` field type declares `context` as a REQUIRED second parameter
// (`ToolExecuteFunction`), even though every tool in this codebase implements `execute` with
// just one — a narrower implementation is a valid assignment (bivariant params), but the FIELD's
// declared type still requires two, so calling `.execute({})` through that declared type is a
// compile error. `agent.test.ts` works around this the same way: cast to the one-argument shape
// actually implemented, rather than the wider declared type.
type ToolExecute = (input: unknown) => Promise<unknown>;
type ToolsMap = Record<string, { execute?: ToolExecute } | undefined>;

function mkTools(index: LocalIndex): ToolsMap {
  return createNegationTools({ localIndex: index }) as unknown as ToolsMap;
}

// -- seed helpers, copied from `index/negation-query.test.ts` (same convention that file itself
// documents: copied from `ipc/diagnostics-rpc.test.ts`) --------------------------------------

function seedCoveredPr(db: Database, id: string, paths: readonly string[]): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'pr', ?, ?, 0, 0)`,
    [id, id, id],
  );
  recordPrChangedFiles(db, {
    itemId: id,
    repoFull: "o/r",
    files: paths.map((path) => ({ path, status: "modified", counterpartPath: null })),
    apiFileCount: paths.length,
    truncated: false,
    nowMs: 1,
  });
}

function seedUncoveredPr(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'pr', ?, ?, 0, 0)`,
    [id, id, id],
  );
}

function seedDeploymentWithoutIncident(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
  upsertGraphEntity(db, { type: "deployment", externalId: id, label: id });
}

function seedDeploymentNoGraphEntity(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
}

function seedDeploymentWithIncident(db: Database, id: string): void {
  const depEntity = upsertGraphEntity(db, { type: "deployment", externalId: id, label: id });
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
  const incidentEntity = upsertGraphEntity(db, {
    type: "incident",
    externalId: `inc-${id}`,
    label: `inc-${id}`,
  });
  upsertGraphRelation(db, depEntity, incidentEntity, "correlates_with", 0);
}

function insertGraphEntity(db: Database, type: string, externalId: string, label: string): string {
  const id = `entity-${type}-${externalId}`;
  db.query(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?1, ?2, ?3, ?4)`).run(
    id,
    type,
    externalId,
    label,
  );
  return id;
}

function seedPersonWithReview(db: Database, id: string, createdAt: number): void {
  db.run(`INSERT INTO person (id, linked) VALUES (?, 1)`, [id]);
  const entity = insertGraphEntity(db, "person", id, id);
  const reviewedTarget = insertGraphEntity(db, "pr", `pr-${id}`, `pr-${id}`);
  upsertGraphRelation(db, entity, reviewedTarget, "reviewed", createdAt);
}

function seedPersonWithoutReview(db: Database, id: string): void {
  db.run(`INSERT INTO person (id, linked) VALUES (?, 1)`, [id]);
  insertGraphEntity(db, "person", id, id);
}

// No `graph_entity` row at all — this is what `countNotReviewedExclusions` counts as an
// exclusion ("no graph entity of the required type"), NOT a person who simply has no `reviewed`
// edge (that person still appears correctly in the result set, per `seedPersonWithoutReview`).
function seedPersonNoGraphEntity(db: Database, id: string): void {
  db.run(`INSERT INTO person (id, linked) VALUES (?, 1)`, [id]);
}

function freshIndex(): { index: LocalIndex; db: Database } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const index = new LocalIndex(db);
  return { index, db };
}

describe("findPrsNotTouching", () => {
  test("a missing pathGlob is an error result, never an unfiltered answer", async () => {
    const { index, db } = freshIndex();
    const tools = mkTools(index);
    const out = (await tools["findPrsNotTouching"]?.execute?.({})) as { error?: string };
    expect(out.error).toContain("pathGlob is required");
    db.close();
  });

  test("a refusal records a disclosure AND embeds it in the payload", async () => {
    const { index, db } = freshIndex(); // no pr_files_state rows at all
    const tools = mkTools(index);
    const drained = await agentRequestContext.run({}, async () => {
      const out = (await tools["findPrsNotTouching"]?.execute?.({ pathGlob: "tests/**" })) as {
        refused?: boolean;
        disclosure?: string;
      };
      expect(out.refused).toBe(true);
      expect(out.disclosure).toContain("findPrsNotTouching could not be verified");
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("no PR file-coverage data is indexed");
    db.close();
  });

  test("exclusions are recorded; a clean result records nothing", async () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "touches-src", ["src/a.ts"]);
    seedUncoveredPr(db, "unfetched");
    const tools = mkTools(index);
    const drained = await agentRequestContext.run({}, async () => {
      await tools["findPrsNotTouching"]?.execute?.({ pathGlob: "tests/**" });
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("1 excluded (no file coverage indexed)");

    const clean = freshIndex();
    seedCoveredPr(clean.db, "only-covered", ["src/a.ts"]);
    const cleanTools = mkTools(clean.index);
    const none = await agentRequestContext.run({}, async () => {
      await cleanTools["findPrsNotTouching"]?.execute?.({ pathGlob: "tests/**" });
      return drainNegationDisclosures();
    });
    expect(none).toEqual([]);
    clean.db.close();
    db.close();
  });

  test("no itemType parameter exists — the type scope is intrinsic", async () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('github:issue-1','github','issue','i1','an issue',0,0)`,
    );
    const tools = mkTools(index);
    const out = (await tools["findPrsNotTouching"]?.execute?.({
      pathGlob: "tests/**",
      itemType: "issue", // ignored: not part of the schema
    })) as { items?: Array<{ id: string }> };
    expect(out.items?.map((i) => i.id)).toEqual(["p1"]);
    db.close();
  });
});

describe("findDeploymentsWithoutIncident", () => {
  test("a refusal records a disclosure AND embeds it in the payload", async () => {
    const { index, db } = freshIndex(); // no correlates_with edges at all
    const tools = mkTools(index);
    const drained = await agentRequestContext.run({}, async () => {
      const out = (await tools["findDeploymentsWithoutIncident"]?.execute?.({})) as {
        refused?: boolean;
        disclosure?: string;
      };
      expect(out.refused).toBe(true);
      expect(out.disclosure).toContain("findDeploymentsWithoutIncident could not be verified");
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("no `correlates_with` edges are indexed");
    db.close();
  });

  test("exclusions are recorded; a clean result records nothing", async () => {
    const { index, db } = freshIndex();
    // At least one correlates_with edge must exist for the substrate probe to pass.
    seedDeploymentWithIncident(db, "dep-with-incident");
    seedDeploymentWithoutIncident(db, "dep-clean");
    seedDeploymentNoGraphEntity(db, "dep-ungraphed");
    const tools = mkTools(index);
    const drained = await agentRequestContext.run({}, async () => {
      await tools["findDeploymentsWithoutIncident"]?.execute?.({});
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("1 excluded (no graph entity)");

    const clean = freshIndex();
    seedDeploymentWithIncident(clean.db, "dep-with-incident");
    seedDeploymentWithoutIncident(clean.db, "only-clean");
    const cleanTools = mkTools(clean.index);
    const none = await agentRequestContext.run({}, async () => {
      await cleanTools["findDeploymentsWithoutIncident"]?.execute?.({});
      return drainNegationDisclosures();
    });
    expect(none).toEqual([]);
    clean.db.close();
    db.close();
  });

  test("no itemType parameter exists — the type scope is intrinsic", async () => {
    const { index, db } = freshIndex();
    seedDeploymentWithIncident(db, "dep-with-incident");
    seedDeploymentWithoutIncident(db, "d1");
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('github:issue-1','github','issue','i1','an issue',0,0)`,
    );
    const tools = mkTools(index);
    const out = (await tools["findDeploymentsWithoutIncident"]?.execute?.({
      itemType: "issue", // ignored: not part of the schema
    })) as { items?: Array<{ id: string }> };
    expect(out.items?.map((i) => i.id)).toEqual(["d1"]);
    db.close();
  });
});

describe("findPeopleWithoutReviews", () => {
  test("a refusal records a disclosure AND embeds it in the payload, remediation is surface-neutral", async () => {
    const { index, db } = freshIndex(); // no reviewed edges at all
    const tools = mkTools(index);
    const drained = await agentRequestContext.run({}, async () => {
      const out = (await tools["findPeopleWithoutReviews"]?.execute?.({})) as {
        refused?: boolean;
        disclosure?: string;
        remediation?: string;
      };
      expect(out.refused).toBe(true);
      expect(out.disclosure).toContain("findPeopleWithoutReviews could not be verified");
      // The remediation string must not tell a model/MCP client to use a CLI flag that does not
      // exist where they are running (spec ruling 3).
      expect(out.remediation).toContain("widen the time window");
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("no `reviewed` edges are indexed");
    db.close();
  });

  test("exclusions are recorded; a clean result records nothing, and projects the documented shape", async () => {
    const { index, db } = freshIndex();
    seedPersonWithReview(db, "reviewer", 1000);
    seedPersonWithoutReview(db, "silent");
    seedPersonNoGraphEntity(db, "ungraphed");
    const tools = mkTools(index);
    const drained = await agentRequestContext.run({}, async () => {
      const out = (await tools["findPeopleWithoutReviews"]?.execute?.({})) as {
        people?: Array<Record<string, unknown>>;
      };
      expect(out.people).toHaveLength(1);
      const row = out.people?.[0];
      expect(row).toEqual({ id: "silent", displayName: null, canonicalEmail: null });
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("1 excluded (no graph entity)");

    const clean = freshIndex();
    seedPersonWithReview(clean.db, "only-reviewer", 1000);
    const cleanTools = mkTools(clean.index);
    const none = await agentRequestContext.run({}, async () => {
      await cleanTools["findPeopleWithoutReviews"]?.execute?.({});
      return drainNegationDisclosures();
    });
    expect(none).toEqual([]);
    clean.db.close();
    db.close();
  });

  test("sinceDays converts to an epoch-ms lower bound at the tool boundary", async () => {
    const { index, db } = freshIndex();
    const now = Date.now();
    // Reviewed 30 days ago: outside a 7-day window, so within that window this person still
    // counts as "has not reviewed" — the review is too old to satisfy the window.
    seedPersonWithReview(db, "stale-reviewer", now - 30 * 86_400_000);
    const tools = mkTools(index);
    const out = (await tools["findPeopleWithoutReviews"]?.execute?.({ sinceDays: 7 })) as {
      people?: Array<{ id: string }>;
      refused?: boolean;
    };
    // The 7-day probe window has no reviews in it at all, so this call refuses rather than
    // silently reporting everyone as unreviewed — proving the substrate is respected per-window.
    expect(out.refused).toBe(true);
    db.close();
  });
});
