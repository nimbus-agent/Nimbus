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

function seedEntity(id: string, type: string, externalId: string, label: string): void {
  db.run(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, ?, ?, ?)`, [
    id,
    type,
    externalId,
    label,
  ]);
}

function seedRelation(fromId: string, toId: string, type: string, at: number): void {
  db.run(`INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES (?, 1)`, [type]);
  db.run(`INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, ?)`, [
    fromId,
    toId,
    type,
    at,
  ]);
}

/**
 * Realistic seed for the path that actually fires in production: an
 * issue-sourced decision, with the PR reachable only via the INCOMING
 * `resolves` edge the graph populator emits PR -> issue
 * (`packages/gateway/src/graph/graph-populator.ts`). A message -> pr
 * `mentions` edge, which the populator never emits, is not a valid fixture.
 */
function seedIssueResolvedByPr(sourceItemId: string, prItemId: string, occurredAt: number): void {
  seedItem(prItemId, "github", "pr", "Move billing to Postgres", occurredAt);
  db.run(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'pr', ?, ?)`, [
    `e-${prItemId}`,
    prItemId,
    "#412",
  ]);
  db.run(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?, 'issue', ?, ?)`, [
    `e-${sourceItemId}`,
    sourceItemId,
    "ISSUE-1",
  ]);
  db.run(
    `INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, 'resolves', ?)`,
    [`e-${prItemId}`, `e-${sourceItemId}`, occurredAt],
  );
}

test("corroborates a PR resolving the source issue inside the forward window", () => {
  seedItem("src", "jira", "issue", "Move billing to Postgres", DECIDED_AT);
  seedIssueResolvedByPr("src", "pr1", DECIDED_AT + 3 * 24 * 3600 * 1000);
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
  seedItem("src", "jira", "issue", "Move billing to Postgres", DECIDED_AT);
  seedIssueResolvedByPr("src", "pr1", DECIDED_AT - 7 * 24 * 3600 * 1000);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(true);
});

test("does not corroborate a PR older than the backward window", () => {
  seedItem("src", "jira", "issue", "Move billing to Postgres", DECIDED_AT);
  seedIssueResolvedByPr("src", "pr1", DECIDED_AT - CORROBORATION_BACKWARD_MS - 1);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "pr")).toBe(false);
});

test("does not corroborate a PR beyond the forward window", () => {
  seedItem("src", "jira", "issue", "Move billing to Postgres", DECIDED_AT);
  seedIssueResolvedByPr("src", "pr1", DECIDED_AT + CORROBORATION_FORWARD_MS + 1);
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

// The OUTGOING code-evidence query, which the `resolves` fixtures above never
// reach. This is the shape the populator really emits for chat: a message
// entity -> commit entity `mentions` edge (graph-populator.ts `syncMessageGraph`,
// via `findCommitEntityIds`), which is what makes `commit` evidence reachable
// for a decision recorded in a thread.
test("a chat message that mentions an indexed commit yields commit evidence", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("github:abc123def", "github", "git_commit", "Swap the billing datastore", DECIDED_AT);
  seedEntity("e-src", "message", "src", "thread");
  seedEntity("e-c1", "commit", "github:abc123def", "abc123def456");
  seedRelation("e-src", "e-c1", "mentions", DECIDED_AT);

  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });

  const commit = ev.find((e) => e.kind === "commit");
  expect(commit).toBeDefined();
  // Classified from the TARGET entity's type, and labelled from the indexed
  // item rather than from the opaque entity id.
  expect(commit?.entityId).toBe("e-c1");
  expect(commit?.itemId).toBe("github:abc123def");
  expect(commit?.label).toBe("Swap the billing datastore");
  expect(commit?.occurredAt).toBe(DECIDED_AT);
  expect(ev.some((e) => e.kind === "pr")).toBe(false);
});

// The review's open point: `merged_as` evidence was specified but never
// exercised. The populator emits it PR entity -> commit entity
// (`graph-populator.ts` `syncPrGraph`), so it fires for a decision recorded in
// the PR itself.
test("a decision recorded in a PR is corroborated by the commit it was merged as", () => {
  seedItem("github:acme/billing#412", "github", "pr", "Move billing to Postgres", DECIDED_AT);
  seedItem("github:deadbeef", "github", "git_commit", "Merge pull request #412", DECIDED_AT + 1000);
  seedEntity("e-pr", "pr", "github:acme/billing#412", "#412");
  seedEntity("e-merge", "commit", "github:deadbeef", "deadbeef");
  seedRelation("e-pr", "e-merge", "merged_as", DECIDED_AT);

  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "github:acme/billing#412",
    decidedAt: DECIDED_AT,
    statement: "Move billing to Postgres",
  });

  expect(ev.filter((e) => e.kind === "commit").map((e) => e.itemId)).toEqual(["github:deadbeef"]);
});

// The window applies to the outgoing code query too, not only to `resolves`.
test("does not corroborate a mentioned commit older than the backward window", () => {
  const old = DECIDED_AT - CORROBORATION_BACKWARD_MS - 1;
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("github:abc123def", "github", "git_commit", "Swap the billing datastore", old);
  seedEntity("e-src", "message", "src", "thread");
  seedEntity("e-c1", "commit", "github:abc123def", "abc123def456");
  seedRelation("e-src", "e-c1", "mentions", old);

  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });
  expect(ev.some((e) => e.kind === "commit")).toBe(false);
});

// A decision outlives its source item: `--rebuild` is the only thing that drops
// stored rows, so a re-sync that removes the item leaves the record behind.
// Corroboration must degrade to "no source row" rather than fabricate one.
test("emits no source evidence when the source item is no longer indexed", () => {
  seedItem("github:abc123def", "github", "git_commit", "Swap the billing datastore", DECIDED_AT);
  seedEntity("e-src", "message", "src", "thread");
  seedEntity("e-c1", "commit", "github:abc123def", "abc123def456");
  seedRelation("e-src", "e-c1", "mentions", DECIDED_AT);

  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "move billing to Postgres",
  });

  expect(ev.some((e) => e.kind === "source")).toBe(false);
  // The graph-derived evidence is unaffected — it keys on the entity, not the item.
  expect(ev.some((e) => e.kind === "commit")).toBe(true);
});

// `tokenOverlap` scores hits against the statement's SIGNIFICANT tokens. A
// statement that has none would divide by an empty set, and `0 * 2 >= 0` would
// otherwise match EVERY ADR-shaped page in the index.
test("a statement carrying no significant tokens matches no ADR", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("adr1", "notion", "page", "ADR: we go on to it", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "we go on to it",
  });
  expect(hasAdrEvidence(ev)).toBe(false);
});

// The SQL pre-filter is deliberately looser than the shape test (`title GLOB
// '[0-9]*'` catches any leading digit), so the regex still has to reject
// numerically-titled pages that are not numbered ADRs — even when every token
// overlaps.
test("a numerically-titled page that is not a numbered ADR is rejected by the shape test", () => {
  seedItem("src", "slack", "message", "thread", DECIDED_AT);
  seedItem("p1", "notion", "page", "2026 billing datastore plan", DECIDED_AT);
  const ev = corroborate(db, {
    decisionId: "d1",
    sourceItemId: "src",
    decidedAt: DECIDED_AT,
    statement: "2026 billing datastore plan",
  });
  expect(hasAdrEvidence(ev)).toBe(false);
});
