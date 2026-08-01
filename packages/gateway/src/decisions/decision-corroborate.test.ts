import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  CORROBORATION_BACKWARD_MS,
  CORROBORATION_FORWARD_MS,
  corroborate,
  hasAdrEvidence,
} from "./decision-corroborate.ts";

let db: Database;
const DECIDED_AT = 1_000_000_000;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function seedItem(
  id: string,
  service: string,
  type: string,
  title: string,
  modifiedAt: number,
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, service, type, id, title, modifiedAt, modifiedAt],
  );
}

function seedPrMentionedBy(sourceItemId: string, prItemId: string, occurredAt: number): void {
  seedItem(prItemId, "github", "pr", "Move billing to Postgres", occurredAt);
  db.run(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'pr', ?, ?)`, [
    `e-${prItemId}`,
    prItemId,
    "#412",
  ]);
  db.run(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'message', ?, ?)`, [
    `e-${sourceItemId}`,
    sourceItemId,
    "thread",
  ]);
  db.run(
    `INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, 'mentions', ?)`,
    [`e-${sourceItemId}`, `e-${prItemId}`, occurredAt],
  );
}

test("corroborates a PR mentioned by the source thread inside the forward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT + 3 * 24 * 3600 * 1000);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(true);
});

// The review's point 2: ship-then-write-it-up is the common case, not an edge.
test("corroborates a PR that PREDATES the decision inside the backward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT - 7 * 24 * 3600 * 1000);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(true);
});

test("does not corroborate a PR older than the backward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT - CORROBORATION_BACKWARD_MS - 1);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(false);
});

test("does not corroborate a PR beyond the forward window", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedPrMentionedBy("src", "pr1", DECIDED_AT + CORROBORATION_FORWARD_MS + 1);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(false);
});

test("always emits a 'source' evidence row for the originating item", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "anything",
  });
  expect(ev.filter((e) => e.kind === "source")).toHaveLength(1);
});

test("detects an ADR page sharing most of its tokens with the statement", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("adr1", "notion", "page", "ADR: move billing to Postgres", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(hasAdrEvidence(ev)).toBe(true);
});

test("ADR candidate selection is deterministic under the cap", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  for (let i = 0; i < 5; i++) {
    seedItem(`adr${i}`, "notion", "page", `ADR: move billing to Postgres v${i}`, DECIDED_AT + i);
  }
  const first = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  const second = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(first.filter((e) => e.kind === "adr").map((e) => e.label)).toEqual(
    second.filter((e) => e.kind === "adr").map((e) => e.label),
  );
});

test("a page whose title carries no ADR shape is never considered", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("p1", "notion", "page", "move billing to Postgres", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(hasAdrEvidence(ev)).toBe(false);
});

test("an unrelated ADR page is not matched", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("adr1", "notion", "page", "ADR: retire the legacy cron runner", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(hasAdrEvidence(ev)).toBe(false);
});
