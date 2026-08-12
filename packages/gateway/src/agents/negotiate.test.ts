import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { emitNegotiateBrief, runNegotiate } from "./negotiate.ts";

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
