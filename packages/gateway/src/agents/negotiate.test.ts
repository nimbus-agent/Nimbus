import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { SubTaskResult } from "../engine/coordinator.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
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
