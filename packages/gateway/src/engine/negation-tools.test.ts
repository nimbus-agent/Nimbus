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

// Same as `seedCoveredPr`, but with a caller-chosen `service` column instead of the hardcoded
// 'github' — needed to exercise the `service` tool argument, which `seedCoveredPr` cannot.
function seedCoveredPrForService(
  db: Database,
  id: string,
  service: string,
  paths: readonly string[],
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, ?, 'pr', ?, ?, 0, 0)`,
    [id, service, id, id],
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

function seedDeploymentWithoutIncident(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
  upsertGraphEntity(db, { type: "deployment", externalId: id, label: id });
}

// Same as `seedDeploymentWithoutIncident`, but with a caller-chosen `service` column — needed to
// exercise the `service` tool argument, which the hardcoded-'github' helper cannot.
function seedDeploymentWithoutIncidentForService(db: Database, id: string, service: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, ?, 'deployment', ?, ?, 0, 0)`,
    [id, service, id, id],
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
        status?: string;
        disclosure?: string;
        note?: string;
      };
      expect(out.refused).toBe(true);
      // Matches `missingSubstrateRefusal`'s shape (`index/negation-predicates.ts`) and the MCP
      // tool descriptions, which instruct the model to check `status === "refused"` — one
      // refusal vocabulary across both surfaces.
      expect(out.status).toBe("refused");
      expect(out.disclosure).toContain("findPrsNotTouching could not be verified");
      // `note` is the only thing telling the model not to fall back to ranked search when a
      // negation refuses.
      expect(out.note).toContain("Do not answer the question from ranked search instead");
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
      const out = (await tools["findPrsNotTouching"]?.execute?.({ pathGlob: "tests/**" })) as {
        disclosure?: string;
      };
      // Record AND embed, both, always: the recorded copy (asserted on `drained` below) is what
      // reaches the user regardless of the model; the embedded copy on the return value itself is
      // the fail-safe if the request store is missing. Deleting `disclosure: line` from
      // `withExclusions`'s payload must fail THIS assertion, not just the one on `drained`.
      expect(out.disclosure).toContain("1 excluded (no file coverage indexed)");
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

  test("a non-object payload is treated as empty input, never crashes", async () => {
    const { index, db } = freshIndex();
    const tools = mkTools(index);
    // `execute` is typed to take `unknown`, so a buggy MCP client can hand it anything: null, a
    // bare string, or an array. `asRecord` must fall back to `{}` for all three rather than throw
    // or read off a wrong property — asserted here by the SAME "pathGlob is required" error the
    // omitted-argument test above gets, proving the malformed shapes are indistinguishable from
    // an empty object rather than silently reading `pathGlob` off something unexpected.
    for (const bad of [null, "not an object", ["array", "input"]]) {
      const out = (await tools["findPrsNotTouching"]?.execute?.(bad)) as { error?: string };
      expect(out.error).toContain("pathGlob is required");
    }
    db.close();
  });

  test("a whitespace-only pathGlob is treated as missing, not passed through as a literal glob", async () => {
    const { index, db } = freshIndex();
    const tools = mkTools(index);
    const out = (await tools["findPrsNotTouching"]?.execute?.({ pathGlob: "   " })) as {
      error?: string;
    };
    // If trimming-to-empty were skipped, "   " would flow into the SQL GLOB as a literal pattern
    // (matching nothing) instead of tripping the required-field check — a silent behavior change,
    // not a crash, which is why asserting the SAME required-field error matters here.
    expect(out.error).toContain("pathGlob is required");
    db.close();
  });

  test("service narrows results to the named forge; omitting it searches every forge", async () => {
    const { index, db } = freshIndex();
    seedCoveredPrForService(db, "gh-pr", "github", ["src/a.ts"]);
    seedCoveredPrForService(db, "gl-pr", "gitlab", ["src/b.ts"]);
    const tools = mkTools(index);
    const scoped = (await tools["findPrsNotTouching"]?.execute?.({
      pathGlob: "tests/**",
      service: "gitlab",
    })) as { items?: Array<{ id: string }> };
    expect(scoped.items?.map((i) => i.id)).toEqual(["gl-pr"]);

    const all = (await tools["findPrsNotTouching"]?.execute?.({
      pathGlob: "tests/**",
    })) as { items?: Array<{ id: string }> };
    expect(all.items?.map((i) => i.id).sort()).toEqual(["gh-pr", "gl-pr"]);
    db.close();
  });

  test("limit: a valid number narrows the result count; a non-finite number falls back to the default cap", async () => {
    const { index, db } = freshIndex();
    // 21 rows, none touching tests/** — one more than the documented default cap of 20, so an
    // un-clamped `Infinity` reaching the query (rather than falling back to 20) is distinguishable
    // from the correctly-clamped behavior.
    for (let i = 0; i < 21; i++) {
      seedCoveredPr(db, `p${i}`, ["src/a.ts"]);
    }
    const tools = mkTools(index);
    const small = (await tools["findPrsNotTouching"]?.execute?.({
      pathGlob: "tests/**",
      limit: 3,
    })) as { items?: Array<{ id: string }> };
    expect(small.items).toHaveLength(3);

    const nonFinite = (await tools["findPrsNotTouching"]?.execute?.({
      pathGlob: "tests/**",
      limit: Number.POSITIVE_INFINITY,
    })) as { items?: Array<{ id: string }> };
    expect(nonFinite.items).toHaveLength(20);
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
        status?: string;
        disclosure?: string;
        note?: string;
      };
      expect(out.refused).toBe(true);
      expect(out.status).toBe("refused");
      expect(out.disclosure).toContain("findDeploymentsWithoutIncident could not be verified");
      expect(out.note).toContain("Do not answer the question from ranked search instead");
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
      const out = (await tools["findDeploymentsWithoutIncident"]?.execute?.({})) as {
        disclosure?: string;
      };
      // See `findPrsNotTouching`'s equivalent test for why both the embedded copy (here) and the
      // recorded copy (asserted on `drained` below) must be checked.
      expect(out.disclosure).toContain("1 excluded (no graph entity of the required type)");
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("1 excluded (no graph entity of the required type)");

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

  test("service narrows results to the named service; omitting it searches every service", async () => {
    const { index, db } = freshIndex();
    seedDeploymentWithIncident(db, "dep-with-incident"); // satisfies the substrate probe
    seedDeploymentWithoutIncidentForService(db, "dep-jenkins", "jenkins");
    seedDeploymentWithoutIncidentForService(db, "dep-circleci", "circleci");
    const tools = mkTools(index);
    const scoped = (await tools["findDeploymentsWithoutIncident"]?.execute?.({
      service: "circleci",
    })) as { items?: Array<{ id: string }> };
    expect(scoped.items?.map((i) => i.id)).toEqual(["dep-circleci"]);

    const all = (await tools["findDeploymentsWithoutIncident"]?.execute?.({})) as {
      items?: Array<{ id: string }>;
    };
    expect(all.items?.map((i) => i.id).sort()).toEqual(["dep-circleci", "dep-jenkins"]);
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
        status?: string;
        disclosure?: string;
        remediation?: string;
        note?: string;
      };
      expect(out.refused).toBe(true);
      expect(out.status).toBe("refused");
      expect(out.disclosure).toContain("findPeopleWithoutReviews could not be verified");
      // The remediation string must not tell a model/MCP client to use a CLI flag that does not
      // exist where they are running (spec ruling 3).
      expect(out.remediation).toContain("widen the time window");
      expect(out.note).toContain("Do not answer the question from ranked search instead");
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
        disclosure?: string;
      };
      expect(out.people).toHaveLength(1);
      const row = out.people?.[0];
      expect(row).toEqual({ id: "silent", displayName: null, canonicalEmail: null });
      // See `findPrsNotTouching`'s equivalent test for why both the embedded copy (here) and the
      // recorded copy (asserted on `drained` below) must be checked.
      expect(out.disclosure).toContain("1 excluded (no graph entity of the required type)");
      return drainNegationDisclosures();
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]).toContain("1 excluded (no graph entity of the required type)");

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
    // Reviewed 3 days ago: INSIDE a 7-day window, so this person has reviewed recently and must
    // NOT appear in the "without reviews" result.
    seedPersonWithReview(db, "recent-reviewer", now - 3 * 86_400_000);
    // Reviewed 20 days ago: OUTSIDE a 7-day window, so within that window this person counts as
    // "has not reviewed" and must appear.
    seedPersonWithReview(db, "stale-reviewer", now - 20 * 86_400_000);
    const tools = mkTools(index);
    const out = (await tools["findPeopleWithoutReviews"]?.execute?.({ sinceDays: 7 })) as {
      people?: Array<{ id: string }>;
      refused?: boolean;
    };
    // A wrong day->ms conversion (e.g. a missing `* 86_400_000`) shrinks the window to
    // milliseconds, so NEITHER review would satisfy a windowed substrate probe that tight and the
    // call would wrongly refuse; a conversion that instead leaves the window effectively
    // unbounded would wrongly include `recent-reviewer` below. Asserting on WHICH person comes
    // back — not merely that the call refused or didn't — catches both failure modes; the
    // now-removed predecessor of this test asserted only `refused === true`, which almost any
    // multiplier (including a missing one) still satisfies near "now".
    expect(out.refused).not.toBe(true);
    expect(out.people?.map((p) => p.id)).toEqual(["stale-reviewer"]);
    db.close();
  });

  test("a pathologically large sinceDays never hands the query a non-finite bound", async () => {
    // Verified: `Date.now() - Math.floor(1e308) * 86_400_000 === -Infinity` with no clamp.
    // A day count this large means "ever" (same as omitting `sinceDays`), so the call must
    // behave like the unbounded case — refuse only because there is no `reviewed` substrate at
    // all, never because a non-finite bound reached the query.
    const { index, db } = freshIndex();
    const tools = mkTools(index);
    const out = (await tools["findPeopleWithoutReviews"]?.execute?.({
      sinceDays: 1e308,
    })) as { refused?: boolean; status?: string };
    expect(out.refused).toBe(true);
    expect(out.status).toBe("refused");
    db.close();

    const { index: index2, db: db2 } = freshIndex();
    seedPersonWithReview(db2, "reviewer", 1000);
    const tools2 = mkTools(index2);
    const out2 = (await tools2["findPeopleWithoutReviews"]?.execute?.({
      sinceDays: 1e308,
    })) as { refused?: boolean; people?: Array<{ id: string }> };
    // With a `reviewed` substrate present, a finite (clamped) bound behaves like "ever": the
    // reviewer from 1000ms after the epoch is well inside it, so the call must not refuse and
    // must not include them in the "without reviews" result.
    expect(out2.refused).not.toBe(true);
    expect(out2.people?.map((p) => p.id)).toEqual([]);
    db2.close();
  });
});
