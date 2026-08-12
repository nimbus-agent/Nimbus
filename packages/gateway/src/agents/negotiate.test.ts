import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { SubTaskResult } from "../engine/coordinator.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { renderNegotiate } from "./_lib/render.ts";
import { emitNegotiateBrief, reduceLaneResults, runNegotiate } from "./negotiate.ts";

function seedPr(
  db: Database,
  num: number,
  authorId: string | null,
  extraMeta: Record<string, unknown> = {},
): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: `acme/app#${String(num)}`,
    title: `PR title ${String(num)}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId,
    metadata: { repo: "acme/app", number: num, merged: true, ...extraMeta },
  });
}

function seedReview(db: Database, num: number, reviewerId: string, state: string | null): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: `acme/app#${String(num)}#review-${String(num)}`,
    title: `Review on acme/app#${String(num)}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: reviewerId,
    metadata: { repo: "acme/app", pr_number: num, review_id: num, state },
  });
}

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function ctxFor(db: Database) {
  return { db, notify: () => {}, sessionId: "negotiate-test-1" };
}

test("an empty index yields an empty_index gap, not zeroes", async () => {
  const db = freshDb();
  const brief = await runNegotiate(
    { sinceMs: 90 * 24 * 60 * 60 * 1000, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );
  expect(brief.gaps.map((g) => g.category)).toContain("empty_index");
  db.close();
});

test("an unresolved subject yields missing_user_identity", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  const brief = await runNegotiate(
    { sinceMs: 1000, runGitOverride: async () => null, osUsernameOverride: "" },
    ctxFor(db),
  );
  expect(brief.gaps.map((g) => g.category)).toContain("missing_user_identity");
  expect(brief.subject.personId).toBeNull();
  db.close();
});

test("the brief states its window and subject", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  const brief = await runNegotiate({ sinceMs: 5000, mePersonIdOverride: "person:me" }, ctxFor(db));
  expect(brief.kind).toBe("negotiate");
  expect(brief.query.sinceMs).toBe(5000);
  expect(brief.subject.personId).toBe("person:me");
  expect(brief.subject.source).toBe("override");
  expect(brief.generatedAt).toBeGreaterThan(0);
  db.close();
});

test("the brief always names the evidence that does not exist", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.unavailableEvidence).toEqual([
    "incidents resolved",
    "on-call shifts",
    "deploys triggered",
  ]);
  db.close();
});

test("renders deterministically with no LLM configured", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  let captured: { brief: string } | undefined;
  await emitNegotiateBrief(
    { mePersonIdOverride: "person:me" },
    {
      db,
      sessionId: "s1",
      notify: (method, params) => {
        if (method === "negotiate.briefReady") captured = params as { brief: string };
      },
    },
  );
  // emitBriefWithSynthesis is fire-and-forget: it resolves { sessionId } before the inner
  // build+synthesize+notify chain runs. Give that chain a macrotask tick, matching the
  // pattern in premortem.test.ts's "emitPremortemBrief notifies ..." tests.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(captured?.brief ?? "").toContain("incidents resolved");
  db.close();
});

test("--person naming someone else yields isOther and the other-person line", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:other", "Other Person"]);
  const brief = await runNegotiate(
    { personId: "person:other", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );
  expect(brief.subject.personId).toBe("person:other");
  expect(brief.subject.source).toBe("explicit");
  expect(brief.subject.isOther).toBe(true);
  expect(brief.subject.displayName).toBe("Other Person");

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("Other Person");
  expect(markdown).toContain("brief requested for someone other than you");
  db.close();
});

test("--person naming the resolved local user is not isOther", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const brief = await runNegotiate(
    { personId: "person:me", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );
  expect(brief.subject.personId).toBe("person:me");
  expect(brief.subject.source).toBe("explicit");
  expect(brief.subject.isOther).toBe(false);

  const markdown = renderNegotiate(brief);
  expect(markdown).not.toContain("brief requested for someone other than you");
  expect(markdown).toContain("**Subject:** you");
  db.close();
});

test("reduceLaneResults: a done lane with text yields no gap", () => {
  const results: SubTaskResult[] = [
    { taskIndex: 0, taskType: "agent_step", status: "done", text: "{}" },
  ];
  expect(reduceLaneResults(results, ["decisions"])).toEqual([]);
});

test("reduceLaneResults: an error-status lane names the lane and the error", () => {
  const results: SubTaskResult[] = [
    { taskIndex: 0, taskType: "agent_step", status: "error", errorText: "db locked" },
  ];
  const gaps = reduceLaneResults(results, ["decisions"]);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.category).toBe("missing_connector");
  expect(gaps[0]?.detail).toContain("lane");
  expect(gaps[0]?.detail).toContain("decisions");
  expect(gaps[0]?.detail).toContain("db locked");
});

test("reduceLaneResults: a done lane with no text falls back to an index label", () => {
  const results: SubTaskResult[] = [{ taskIndex: 3, taskType: "agent_step", status: "done" }];
  // laneNames shorter than the result's taskIndex — exercises the `#index` fallback and the
  // no-errorText branch (no trailing `: <message>`).
  const gaps = reduceLaneResults(results, []);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.detail).toBe("negotiate lane `#3` failed");
});

test("emitNegotiateBrief routes through a configured LLM", async () => {
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  let captured: { brief: string } | undefined;
  await emitNegotiateBrief(
    { mePersonIdOverride: "person:me" },
    {
      db,
      sessionId: "s2",
      llm: { generateMarkdown: async () => "# LLM-authored negotiate brief" },
      notify: (method, params) => {
        if (method === "negotiate.briefReady") captured = params as { brief: string };
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(captured?.brief).toBe("# LLM-authored negotiate brief");
  db.close();
});

test("authored PRs are counted, with stats coverage when only some are enriched", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:me", { additions: 100, deletions: 20, changed_files: 3 });
  seedPr(db, 2, "person:me"); // no stats
  seedPr(db, 3, "person:other");

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.authoredPrs?.count).toBe(2);
  expect(brief.authoredPrs?.statsCoverage).toEqual({ covered: 1, total: 2 });
  expect(brief.authoredPrs?.stats?.additions).toBe(100);
  db.close();
});

test("reviewed PRs split by state, with a null-state arm", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:author");
  seedPr(db, 2, "person:author");
  seedPr(db, 3, "person:author");
  seedReview(db, 1, "person:me", "approved");
  seedReview(db, 2, "person:me", "changes_requested");
  seedReview(db, 3, "person:me", null);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.reviewedPrs?.count).toBe(3);
  expect(brief.reviewedPrs?.approved).toBe(1);
  expect(brief.reviewedPrs?.changesRequested).toBe(1);
  expect(brief.reviewedPrs?.otherOrUnknown).toBe(1);
  db.close();
});

test("stats coverage is complete when every authored PR is enriched", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:me", { additions: 10, deletions: 1, changed_files: 1 });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.authoredPrs?.statsCoverage).toEqual({ covered: 1, total: 1 });
  db.close();
});

test("tickets counts opened, and closed via an authored PR's resolves edge", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);

  // Issue must exist BEFORE the PR: syncPrGraph only wires `resolves` against
  // issue entities already present at PR-sync time.
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#issue-7",
    title: "Login broken",
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: "person:me",
    metadata: { repo: "acme/app", number: 7 },
  });
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #7",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: "person:me",
    metadata: { repo: "acme/app", number: 1 },
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.tickets?.opened).toBe(1);
  expect(brief.tickets?.closedByAuthoredPr).toBe(1);
  db.close();
});

test("ownership reports services and cites the pass timestamp", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  db.run("INSERT INTO ownership_pass_state (id, last_pass_at) VALUES (1, 1700000000000)");
  const me = upsertGraphEntity(db, { type: "person", externalId: "person:me", label: "Me" });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, me, svc, "owns", Date.now(), 0.8);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.ownership?.services).toEqual(["api"]);
  expect(brief.ownership?.lastPassAt).toBe(1700000000000);
  db.close();
});

// THE UNDERCOUNT GUARD. Without it, work under an unmapped git alias vanishes silently.
test("an unmapped git identity for the self subject raises a named gap", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
    "person:me",
    "Me",
    "me@work.example",
  ]);
  // Ownership recorded under a DIFFERENT, unmapped email — exactly what resolveOwner emits.
  const ghost = upsertGraphEntity(db, {
    type: "person",
    externalId: "git:me@personal.example",
    label: "me@personal.example",
  });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, ghost, svc, "owns", Date.now(), 0.9);

  const brief = await runNegotiate(
    { runGitOverride: async () => "me@personal.example", osUsernameOverride: "" },
    ctxFor(db),
  );

  const gap = brief.gaps.find((g) => g.detail.includes("unmapped git identity"));
  expect(gap).toBeDefined();
  expect(gap?.category).toBe("missing_user_identity");
  db.close();
});

test("a lane that throws yields a gap note, not a zero", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES ('github:acme/app#1', 'github', 'pr', 'acme/app#1', 'noop', 0, 0)`,
  );
  // Break a table the authored-PR lane depends on so that lane throws.
  db.run("DROP TABLE graph_relation");

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.authoredPrs).toBeNull();
  expect(brief.gaps.some((g) => g.detail.toLowerCase().includes("lane"))).toBe(true);
  db.close();
});
