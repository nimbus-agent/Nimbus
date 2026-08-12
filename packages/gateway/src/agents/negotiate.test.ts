import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { SubTaskResult } from "../engine/coordinator.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { NegotiateBrief } from "./_lib/negotiate-types.ts";
import { renderNegotiate } from "./_lib/render.ts";
import {
  emitNegotiateBrief,
  OWNERSHIP_LIMIT,
  reduceLaneResults,
  runNegotiate,
} from "./negotiate.ts";

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

function ctxFor(db: Database, personalSources: string[] = []) {
  return { db, notify: () => {}, sessionId: "negotiate-test-1", personalSources };
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
      personalSources: [],
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

// THE STRUCTURAL-ZERO GUARD. An explicit `--person` is never `personId === null`, so the
// generic unresolved-identity gap cannot fire for it, and `personDisplayNameOrNull` returns
// null for an unknown id — without these, an unresolvable id renders as a person who shipped
// nothing, in a document that may affect their compensation.
test("--person naming an id that matches nothing declares the counts structurally zero", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:me", { additions: 10, deletions: 1, changed_files: 1 });

  const brief = await runNegotiate(
    { personId: "person:typo", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  const gap = brief.gaps.find((g) => g.detail.includes("person:typo"));
  expect(gap).toBeDefined();
  expect(gap?.category).toBe("missing_user_identity");
  expect(gap?.detail).toContain("matched no indexed person");
  expect(gap?.detail).toContain("structurally zero");
  // Every lane still RAN (they are not null) — the gap is what distinguishes their zeroes
  // from a measurement, and the rendered brief must carry it.
  expect(brief.authoredPrs?.count).toBe(0);
  expect(renderNegotiate(brief)).toContain("structurally zero");
  db.close();
});

// The `git:<email>` shape specifically: `resolveOwner` emits it for a blame email with no
// `person` row, so it IS a `graph_entity` (ownership comes back populated, which is what makes
// it look like it worked) while EVERY OTHER LANE is structurally zero.
//
// The count matters and an earlier fix got it wrong: it named only the three `author_id`-keyed
// lanes, on the assumption that the graph-traversing lanes could still measure a `git:` id.
// They cannot. `authored` and `opened` edges are built from `row.authorId`
// (`graph/graph-populator.ts`), which only ever holds a `person.id`, and the ownership pass is
// the only writer that puts a `git:` external id on an entity — emitting `owns` edges alone.
// So PRs authored and tickets are structurally zero too, and a gap that ENUMERATES lanes while
// omitting them is worse than silence: it implies those two were measured. Hence the positive
// assertions below on every lane the gap must name.
test("--person naming a git: blame alias says which lanes are structurally zero", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const ghost = upsertGraphEntity(db, {
    type: "person",
    externalId: "git:jane@example.com",
    label: "jane@example.com",
  });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, ghost, svc, "owns", Date.now(), 0.9);

  const brief = await runNegotiate(
    { personId: "git:jane@example.com", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  const gap = brief.gaps.find((g) => g.detail.includes("git:jane@example.com"));
  expect(gap).toBeDefined();
  expect(gap?.category).toBe("missing_user_identity");
  expect(gap?.detail).toContain("structurally zero");
  // Ownership really did measure something — the gap must not claim otherwise.
  expect(brief.ownership?.services).toEqual(["api"]);
  expect(gap?.detail).not.toContain("every count below is structurally zero");
  // ...and it must name ALL five lanes that are structurally zero, not just the three keyed on
  // `author_id`. Dropping "PRs authored"/"tickets" from this sentence is the exact regression
  // that shipped once already.
  for (const lane of ["PRs authored", "PRs reviewed", "tickets", "decisions", "writing"]) {
    expect(gap?.detail).toContain(lane);
  }
  expect(gap?.remediation).toContain("nimbus people search");
  db.close();
});

test("--person naming a real person raises no structural-zero gap", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:other", "Other Person"]);

  const brief = await runNegotiate(
    { personId: "person:other", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  expect(brief.gaps.some((g) => g.detail.includes("structurally zero"))).toBe(false);
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
      personalSources: [],
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

  // Issues must exist BEFORE the PRs: syncPrGraph only wires `resolves` against
  // issue entities already present at PR-sync time.
  for (const n of [7, 8]) {
    upsertIndexedItem(db, {
      service: "github",
      type: "issue",
      externalId: `acme/app#issue-${String(n)}`,
      title: `Issue ${String(n)}`,
      bodyPreview: "",
      modifiedAt: Date.now(),
      syncedAt: Date.now(),
      authorId: "person:me",
      metadata: { repo: "acme/app", number: n },
    });
  }
  // PR 1 resolves BOTH issues; PR 2 resolves issue 7 a second time. Three `resolves` rows
  // over two distinct issues — so `COUNT(DISTINCT res.to_id)` yields 2 and a `COUNT(*)`
  // regression yields 3, which no single-issue fixture could tell apart.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #7 and closes #8",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: "person:me",
    metadata: { repo: "acme/app", number: 1 },
  });
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#2",
    title: "Fix login again",
    bodyPreview: "closes #7",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: "person:me",
    metadata: { repo: "acme/app", number: 2 },
  });

  const resolvesRows = db
    .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'")
    .get() as { n: number };
  expect(resolvesRows.n).toBe(3);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.tickets?.opened).toBe(2);
  expect(brief.tickets?.closedByAuthoredPr).toBe(2);
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

test("--person reports a count of unmapped git identities in the index, never a guess", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:target", "Target Person"]);
  const target = upsertGraphEntity(db, {
    type: "person",
    externalId: "person:target",
    label: "Target Person",
  });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, target, svc, "owns", Date.now(), 0.7);

  // Unrelated `git:` alias elsewhere in the index — must be COUNTED, never attributed to the
  // named subject by name/email matching (spec § 5.A0).
  const ghost = upsertGraphEntity(db, {
    type: "person",
    externalId: "git:ghost@example.com",
    label: "ghost@example.com",
  });
  const otherSvc = upsertGraphEntity(db, {
    type: "service",
    externalId: "svc:other",
    label: "other",
  });
  upsertGraphRelation(db, ghost, otherSvc, "owns", Date.now(), 0.5);

  const brief = await runNegotiate(
    { personId: "person:target", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  expect(brief.subject.source).toBe("explicit");
  // Round-trips the lane result through JSON.stringify/JSON.parse (the coordinator boundary).
  expect(brief.ownership?.unmappedIdentitiesInIndex).toBe(1);
  expect(brief.ownership?.services).toEqual(["api"]);

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("1 git identities in this index are not mapped");
  db.close();
});

test("ownership truncates at OWNERSHIP_LIMIT owned targets and reports truncated", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const me = upsertGraphEntity(db, { type: "person", externalId: "person:me", label: "Me" });
  const total = OWNERSHIP_LIMIT + 5;
  for (let i = 0; i < total; i += 1) {
    const svc = upsertGraphEntity(db, {
      type: "service",
      externalId: `svc:${String(i)}`,
      label: `svc-${String(i)}`,
    });
    upsertGraphRelation(db, me, svc, "owns", Date.now(), total - i);
  }

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.ownership?.truncated).toBe(true);
  expect(brief.ownership?.services).toHaveLength(OWNERSHIP_LIMIT);
  db.close();
});

test("ownership at exactly OWNERSHIP_LIMIT owned targets is not truncated", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const me = upsertGraphEntity(db, { type: "person", externalId: "person:me", label: "Me" });
  for (let i = 0; i < OWNERSHIP_LIMIT; i += 1) {
    const svc = upsertGraphEntity(db, {
      type: "service",
      externalId: `svc:${String(i)}`,
      label: `svc-${String(i)}`,
    });
    upsertGraphRelation(db, me, svc, "owns", Date.now(), OWNERSHIP_LIMIT - i);
  }

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.ownership?.truncated).toBe(false);
  expect(brief.ownership?.services).toHaveLength(OWNERSHIP_LIMIT);
  db.close();
});

test("ownership reports directories for directory-typed owns targets", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const me = upsertGraphEntity(db, { type: "person", externalId: "person:me", label: "Me" });
  const dir = upsertGraphEntity(db, {
    type: "directory",
    externalId: "dir:root:src/api",
    label: "src/api",
  });
  upsertGraphRelation(db, me, dir, "owns", Date.now(), 0.6);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.ownership?.directories).toEqual(["src/api"]);
  db.close();
});

test("decisions counts authored and reports unattributable separately", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1.1",
    title: "we decided X",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });
  upsertIndexedItem(db, {
    service: "obsidian",
    type: "obsidian_note",
    externalId: "note-1",
    title: "we decided Y",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: null,
    metadata: {},
  });

  for (const [id, src] of [
    ["d1", "slack:C1/1.1"],
    ["d2", "obsidian:note-1"],
  ] as const) {
    db.run(
      `INSERT INTO decision_record
         (id, source_item_id, status, cue_tier, cue_text, priority, confidence, decided_at, updated_at)
       VALUES (?, ?, 'extracted', 'explicit', 'we decided', 1, 0.8, ?, ?)`,
      [id, src, now, now],
    );
  }

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.decisions?.authored).toBe(1);
  expect(brief.decisions?.unattributable).toBe(1);

  // The undercount failure inverted: `unattributable` must never read as work that might
  // belong to the subject — the rendered line has to say it is an index-wide fact, not
  // part of their total (fix round 1). Mirrors the ownership lane's
  // "attributed to them is not counted here" disambiguation.
  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("1 decision(s) attributed to you");
  expect(markdown).toContain("not counted above");
  expect(markdown).toContain("not necessarily yours");
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

test("writing counts work artifacts and reports personal docs as not enabled", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "confluence",
    type: "page",
    externalId: "p1",
    title: "Design doc",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/2.2",
    title: "hello",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.writing?.docs).toBe(1);
  expect(brief.writing?.messages).toBe(1);
  expect(brief.sources.personalDocsConfigured).toBe(false);
  expect(brief.sources.personalDocsConfigKey).toBe("[negotiate] personal_sources");
  db.close();
});

test("personal notes are excluded when [negotiate] personal_sources is empty", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "obsidian",
    type: "obsidian_note",
    externalId: "note-1",
    title: "1:1 notes",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.writing?.notes).toBe(0);
  db.close();
});

test("personal notes are counted once the source is named in [negotiate] personal_sources", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "obsidian",
    type: "obsidian_note",
    externalId: "note-1",
    title: "1:1 notes",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db, ["obsidian"]));

  expect(brief.writing?.notes).toBe(1);
  expect(brief.sources.personalDocsConfigured).toBe(true);
  db.close();
});

// The gate is per-SERVICE, not per-type: `type: "page"` is emitted by both
// `confluence-sync.ts` and `notion-sync.ts`, so Notion (personal-capable) and Confluence
// (work) must be told apart on `service`, never on `type` alone.

// The negative half is the one that actually proves the gate exists — without it, a
// passing "counted once configured" test alone would also pass an ungated implementation.
test("Notion pages are excluded from docs when [negotiate] personal_sources is empty", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "notion",
    type: "page",
    externalId: "n1",
    title: "Notion page",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.writing?.docs).toBe(0);
  db.close();
});

test("Notion pages are counted in docs once notion is named in [negotiate] personal_sources", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "notion",
    type: "page",
    externalId: "n1",
    title: "Notion page",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db, ["notion"]));

  expect(brief.writing?.docs).toBe(1);
  db.close();
});

// Confluence is a work wiki and is never gated. Under-counting a real work artifact is the
// failure direction this whole agent exists to avoid, so it gets its own explicit
// assertion rather than being folded into the combined "writing counts work artifacts"
// test above.
test("Confluence pages are counted in docs even when [negotiate] personal_sources is empty", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "confluence",
    type: "page",
    externalId: "c1",
    title: "Confluence page",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.writing?.docs).toBe(1);
  db.close();
});

// A typo'd/unrecognised service name must silently include nothing — never throw, and
// never widen to "everything" (Task 6 brief's second malformed-input rule).
test("an unrecognised configured service yields zero extra rows and no error", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "obsidian",
    type: "obsidian_note",
    externalId: "note-1",
    title: "1:1 notes",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });

  const brief = await runNegotiate(
    { mePersonIdOverride: "person:me" },
    ctxFor(db, ["obsidain-typo"]),
  );

  expect(brief.writing?.notes).toBe(0);
  expect(brief.gaps.some((g) => g.detail.toLowerCase().includes("writing"))).toBe(false);
  db.close();
});

test("renderNegotiate names the config key when personal docs are not configured", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("[negotiate] personal_sources");
  expect(markdown).toContain("not enabled");
  db.close();
});

// `personalDocsConfigured` must mean "an entry actually widened the query", not "the user
// typed something": a configured entry that matches nothing is an UNDERCOUNT, and rendering
// it as complete coverage inverts the one section whose job is to disclose the opt-in.
function seedObsidianNote(db: Database): void {
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "obsidian",
    type: "obsidian_note",
    externalId: "note-1",
    title: "1:1 notes",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person:me",
    metadata: {},
  });
}

test("a personal source that matches nothing is not reported as configured coverage", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedObsidianNote(db);

  // "Obsidian" reaching the agent uncased is what `parsePersonalSources` now prevents; the
  // agent must still be honest if any other caller hands it one.
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db, ["Obsidian"]));

  expect(brief.writing?.notes).toBe(0);
  expect(brief.sources.personalDocsConfigured).toBe(false);
  expect(brief.sources.personalDocsRecognised).toEqual([]);
  expect(brief.sources.personalDocsUnrecognised).toEqual(["Obsidian"]);

  const markdown = renderNegotiate(brief);
  expect(markdown).not.toContain("configured and included");
  expect(markdown).toContain('1 unrecognised entry ignored: "Obsidian"');
  db.close();
});

test("a wholly unrecognised personal source is disclosed, never dropped silently", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedObsidianNote(db);

  const brief = await runNegotiate(
    { mePersonIdOverride: "person:me" },
    ctxFor(db, ["obsidian-vault"]),
  );

  expect(brief.sources.personalDocsConfigured).toBe(false);
  expect(renderNegotiate(brief)).toContain('1 unrecognised entry ignored: "obsidian-vault"');
  db.close();
});

test("a recognised source is named, and an unrecognised sibling is still disclosed", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedObsidianNote(db);

  const brief = await runNegotiate(
    { mePersonIdOverride: "person:me" },
    ctxFor(db, ["obsidian", "foo", "bar"]),
  );

  expect(brief.writing?.notes).toBe(1);
  expect(brief.sources.personalDocsConfigured).toBe(true);
  expect(brief.sources.personalDocsRecognised).toEqual(["obsidian"]);

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("personal document sources: obsidian — configured and included");
  expect(markdown).toContain('2 unrecognised entries ignored: "foo", "bar"');
  db.close();
});

// Five of six lanes filter on `item.modified_at` (GitHub's `updated_at`, i.e. LAST TOUCH),
// so an undisclosed "last 90d" header overstates every headline count.
test("the window line discloses that it windows on last-modified, not creation", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("ACTIVE in this window");
  expect(markdown).toContain("last-modified, not created");
  db.close();
});

// The counts are already correct for `--person`; it was the PROSE that said "you"/"yours"
// three sections after the subject line said "someone other than you".
test("the decisions section addresses the named subject, not 'you'", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:other", "Other Person"]);
  const brief = await runNegotiate(
    { personId: "person:other", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("decision(s) attributed to Other Person");
  expect(markdown).toContain("not necessarily theirs");
  expect(markdown).not.toContain("attributed to you");
  expect(markdown).not.toContain("not necessarily yours");
  db.close();
});

// The defensive arm: `resolveSubject`'s explicit path always sets a non-null `personId`, so a
// null id with `isOther` is unreachable through `runNegotiate` — but if it ever became
// reachable it must NOT silently revert to addressing the reader as the subject.
test("an other subject with no id at all still reads as a third party", () => {
  const brief: NegotiateBrief = {
    kind: "negotiate",
    agentVersion: 1,
    generatedAt: 0,
    latencyMs: 0,
    gaps: [],
    query: { sinceMs: 1000 },
    subject: { personId: null, source: "explicit", displayName: null, isOther: true },
    sources: {
      personalDocsConfigured: false,
      personalDocsRecognised: [],
      personalDocsUnrecognised: [],
      personalDocsConfigKey: "[negotiate] personal_sources",
    },
    unavailableEvidence: [],
    authoredPrs: null,
    reviewedPrs: null,
    tickets: null,
    ownership: null,
    decisions: { authored: 0, unattributable: 0 },
    writing: null,
  };

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("decision(s) attributed to the subject");
  expect(markdown).toContain("not necessarily theirs");
  expect(markdown).toContain("unknown person");
});

test("an unnamed other subject falls back to the id, never to 'you'", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const brief = await runNegotiate(
    { personId: "person:nameless", mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("decision(s) attributed to person:nameless");
  expect(markdown).not.toContain("attributed to you");
  db.close();
});

// `nimbus owners` states this in EVERY brief; negotiate reads the same `owns` edges, and
// "## Ownership — services: checkout" inside a contribution brief reads as accountability.
test("the ownership section labels itself authorship-derived, unconditionally", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const me = upsertGraphEntity(db, { type: "person", externalId: "person:me", label: "Me" });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, me, svc, "owns", Date.now(), 0.8);

  const withOwnership = renderNegotiate(
    await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db)),
  );
  expect(withOwnership).toContain("authorship-derived ownership");
  expect(withOwnership).toContain("not who is formally accountable");
  db.close();

  // …and with no recorded ownership at all, where the temptation to omit it is highest.
  const empty = freshDb();
  empty.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const bare = renderNegotiate(
    await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(empty)),
  );
  expect(bare).toContain("no recorded ownership");
  expect(bare).toContain("authorship-derived ownership");
  empty.close();
});

// M2: `--person <your own id>` is still a brief about you, resolved from your own git email.
test("an explicit self subject still carries the unmapped-git-identity caveat", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
    "person:me",
    "Me",
    "me@work.example",
  ]);
  // Blame indexed before the person record was linked: the SAME email exists both as the
  // person's canonical email and as an unmapped `git:` graph entity carrying `owns` edges.
  const ghost = upsertGraphEntity(db, {
    type: "person",
    externalId: "git:me@work.example",
    label: "me@work.example",
  });
  const svc = upsertGraphEntity(db, { type: "service", externalId: "svc:api", label: "api" });
  upsertGraphRelation(db, ghost, svc, "owns", Date.now(), 0.9);

  // No `mePersonIdOverride` — an override short-circuits `resolveSelfPerson` before it ever
  // consults git, so the caveat has no git email to be about.
  const brief = await runNegotiate(
    {
      personId: "person:me",
      runGitOverride: async () => "me@work.example",
      osUsernameOverride: "",
    },
    ctxFor(db),
  );

  expect(brief.subject.isOther).toBe(false);
  expect(brief.gaps.some((g) => g.detail.includes("unmapped git identity"))).toBe(true);
  db.close();
});

// M4: "no enriched PR in this window" is a coverage statement, and there is no coverage
// question to answer when the window holds no authored PR at all.
test("the stats-unavailable note is suppressed when there are no authored PRs", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(brief.authoredPrs?.statsCoverage).toEqual({ covered: 0, total: 0 });
  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("0 PR(s), 0 merged");
  expect(markdown).not.toContain("no enriched PR in this window");
  db.close();
});

test("the stats-unavailable note still fires when an unenriched PR exists", async () => {
  const db = freshDb();
  db.run("INSERT INTO person (id, display_name) VALUES (?, ?)", ["person:me", "Me"]);
  seedPr(db, 1, "person:me");
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));

  expect(renderNegotiate(brief)).toContain("no enriched PR in this window");
  db.close();
});
