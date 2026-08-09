import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertGraphEntity } from "../graph/relationship-graph.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runPremortemPass } from "./premortem-pass.ts";
import { readPassState, themesForServices } from "./theme-store.ts";

/**
 * Seeds a closed epic AND the graph path that gives it an affected service:
 * epic → child → resolving PR → repo. Without that path the epic resolves to
 * no services and contributes no themes, so every test here needs it.
 *
 * Graph rows are minted through the REAL `upsertGraphEntity` write path, so
 * `graph_entity.id` is the same deterministic `sha256(type, externalId)` hash
 * production writes — never the raw item id. A hand-rolled `INSERT INTO
 * graph_entity` that set `id` to the item id previously made
 * `graph_entity.id == item.id` true only in the fixture, hiding a query that
 * could never match in production. Mirrors `epic-services.test.ts`'s
 * `addEntity` fixture.
 */
function seedClosedEpic(
  db: Database,
  id: string,
  modifiedAt: number,
  body: string,
  service = "acme/billing-api",
): void {
  const key = id.split(":")[1] ?? id;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'T', ?, 1, ?, ?, 1, 0)`,
    [
      id,
      key,
      body,
      JSON.stringify({ meta_v: 1, status_category: "done", issue_type: "Epic", resolved_at_ms: 9 }),
      modifiedAt,
    ],
  );
  const childId = `jira:${key}-child`;
  const prId = `github:pr:${key}`;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'C', ?, 1, 1, 0)`,
    [childId, `${key}-child`, JSON.stringify({ meta_v: 1, parent_key: key })],
  );
  const issueEnt = upsertGraphEntity(db, {
    type: "issue",
    externalId: childId,
    label: childId,
    service: "jira",
    metadata: null,
  });
  // The PR carries its repo as `metadata.repo` — that JSON field IS the
  // service hop, not an `in_repo` edge (which exists only for commits and
  // files).
  const prEnt = upsertGraphEntity(db, {
    type: "pr",
    externalId: prId,
    label: prId,
    service: "github",
    metadata: { repo: service },
  });
  db.run(
    `INSERT OR IGNORE INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, 'resolves', 1)`,
    [prEnt, issueEnt],
  );
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  return db;
}

const okLlm = {
  complete: async () => JSON.stringify({ themes: [{ label: "rate limits", sources: ["jira:A"] }] }),
};

test("writes themes under the AFFECTED service, not the connector", async () => {
  // The single most important assertion in this file. Keying on 'jira' would
  // make PR B's theme lookup — which matches a cohort's affected services —
  // return zero rows for every epic, while this pass looked perfectly healthy.
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us", "acme/billing-api");

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(r.scanned).toBe(1);
  expect(r.themesWritten).toBe(1);
  expect(themesForServices(db, ["acme/billing-api"]).map((t) => t.label)).toEqual(["rate limits"]);
  expect(themesForServices(db, ["jira"])).toEqual([]);
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("an epic touching two services writes the theme under both", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us", "acme/billing-api");
  // A second child of the same epic, landing in a different repo.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES ('jira:A-two', 'jira', 'issue', 'A-two', 'C2', ?, 1, 1, 0)`,
    [JSON.stringify({ meta_v: 1, parent_key: "A" })],
  );
  const issueEnt2 = upsertGraphEntity(db, {
    type: "issue",
    externalId: "jira:A-two",
    label: "C2",
    service: "jira",
    metadata: null,
  });
  const prEnt2 = upsertGraphEntity(db, {
    type: "pr",
    externalId: "github:pr:A2",
    label: "PR",
    service: "github",
    metadata: { repo: "acme/payments-worker" },
  });
  db.run(
    `INSERT OR IGNORE INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, 'resolves', 1)`,
    [prEnt2, issueEnt2],
  );

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(r.themesWritten).toBe(2);
  expect(themesForServices(db, ["acme/billing-api"])).toHaveLength(1);
  expect(themesForServices(db, ["acme/payments-worker"])).toHaveLength(1);
  db.close();
});

test("an epic whose services cannot be resolved contributes no theme", async () => {
  // Correct, not a silent drop: with no service there is no key under which
  // PR B could ever find the theme. The watermark still advances.
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES ('jira:A', 'jira', 'issue', 'A', 'T', 'b', 1, ?, 10, 1, 0)`,
    [JSON.stringify({ meta_v: 1, status_category: "done", issue_type: "Epic" })],
  );

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(r.themesWritten).toBe(0);
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("a second pass over unchanged data scans nothing and calls no model", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us");
  await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });

  let calls = 0;
  const counting = {
    complete: async () => {
      calls += 1;
      return "{}";
    },
  };
  const r = await runPremortemPass(db, { nowMs: 200, maxLlmCalls: 5, llm: counting });
  expect(r.scanned).toBe(0);
  expect(calls).toBe(0);
  db.close();
});

test("with NO model: zero themes, but the watermark still advances", async () => {
  // The watermark must advance so a later pass, once a model is available, does
  // not re-scan the entire corpus from zero.
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us");

  const r = await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5 });
  expect(r.themesWritten).toBe(0);
  expect(r.llmCalls).toBe(0);
  expect(themesForServices(db, ["acme/billing-api"])).toEqual([]);
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("maxLlmCalls bounds the pass and leaves the rest for next time", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "one");
  seedClosedEpic(db, "jira:B", 20, "two");
  seedClosedEpic(db, "jira:C", 30, "three");

  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      return JSON.stringify({ themes: [] });
    },
  };
  const r = await runPremortemPass(db, { nowMs: 100, batchSize: 1, maxLlmCalls: 2, llm });
  expect(calls).toBe(2);
  expect(r.llmCalls).toBe(2);
  // Stopped after B, so C is still ahead of the watermark.
  expect(readPassState(db)).toEqual({ watermarkMs: 20, watermarkId: "jira:B" });
  db.close();
});

test("an aborted pass keeps the watermark it had already checkpointed", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "one");
  seedClosedEpic(db, "jira:B", 20, "two");

  const ctrl = new AbortController();
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls === 1) ctrl.abort();
      return JSON.stringify({ themes: [] });
    },
  };
  await runPremortemPass(db, {
    nowMs: 100,
    batchSize: 1,
    maxLlmCalls: 9,
    llm,
    signal: ctrl.signal,
  });
  expect(readPassState(db)).toEqual({ watermarkMs: 10, watermarkId: "jira:A" });
  db.close();
});

test("the reconcile sweep prunes orphaned evidence and demotes the theme", async () => {
  const db = freshDb();
  seedClosedEpic(db, "jira:A", 10, "Stripe capped us");
  await runPremortemPass(db, { nowMs: 100, maxLlmCalls: 5, llm: okLlm });
  expect(themesForServices(db, ["acme/billing-api"])).toHaveLength(1);

  db.run(`DELETE FROM item WHERE id = 'jira:A'`);
  const r = await runPremortemPass(db, { nowMs: 200, maxLlmCalls: 5, llm: okLlm });
  expect(r.prunedEvidence).toBe(1);
  expect(r.demoted).toBe(1);
  expect(themesForServices(db, ["acme/billing-api"])).toEqual([]);
  // The evidence row is gone, not merely ignored — otherwise dead rows
  // accumulate forever behind every pruned item.
  const left = db.query(`SELECT COUNT(*) AS n FROM premortem_theme_evidence`).get() as {
    n: number;
  };
  expect(left.n).toBe(0);
  db.close();
});
