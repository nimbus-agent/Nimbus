import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { matchesService } from "./decision-service-scope.ts";
import type { DecisionEvidence } from "./decision-types.ts";

let db: Database;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function prEvidence(itemId: string): DecisionEvidence[] {
  return [{ kind: "pr", entityId: null, itemId, label: "#412", url: null, occurredAt: null }];
}

/**
 * Seeds a PR the way `github-sync.ts:201` actually writes one: `external_id` is
 * `owner/repo#number`. Do NOT hand-build a `repository` graph entity here — no
 * populator emits one, so a test that seeds it would pass while production
 * matched nothing.
 */
function seedPrItem(itemId: string, externalId: string, metadata: string | null): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, 'github', 'pr', ?, 'Move billing to Postgres', ?, 1, 1, 0)`,
    [itemId, externalId, metadata],
  );
}

function seedTicket(itemId: string, service: string, metadata: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, ?, 'issue', ?, 't', ?, 1, 1, 0)`,
    [itemId, service, itemId, metadata],
  );
}

test("matches by repository via the PR item external_id", () => {
  seedPrItem("pr1", "acme/billing#412", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

test("matches the full owner/repo form as well as the bare name", () => {
  seedPrItem("pr1", "acme/billing#412", null);
  expect(
    matchesService(db, {
      sourceItemId: "s1",
      evidence: prEvidence("pr1"),
      service: "acme/billing",
    }),
  ).toBe("repo");
});

test("prefers metadata.repo over the external_id prefix", () => {
  seedPrItem("pr1", "acme/wrong#412", JSON.stringify({ repo: "acme/billing" }));
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

test("does not match a different repository", () => {
  seedPrItem("pr1", "acme/payments#412", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBeNull();
});

test("matches a Jira ticket by its project key", () => {
  seedTicket("j1", "jira", JSON.stringify({ key: "BILLING-123" }));
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "billing" })).toBe(
    "ticket-key",
  );
});

test("matches a Linear ticket by its identifier prefix", () => {
  seedTicket("l1", "linear", JSON.stringify({ identifier: "BILLING-7" }));
  expect(matchesService(db, { sourceItemId: "l1", evidence: [], service: "billing" })).toBe(
    "ticket-key",
  );
});

// The spec is explicit that matching is on normalized tokens, not substrings —
// this keeps the flag predictable rather than fuzzy.
test("does not substring-match a shorter query against a longer key", () => {
  seedTicket("j1", "jira", JSON.stringify({ key: "BILLING-123" }));
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "bill" })).toBeNull();
});

test("returns null for a decision with neither route", () => {
  seedTicket("s1", "slack", JSON.stringify({ channel: "C0123" }));
  expect(matchesService(db, { sourceItemId: "s1", evidence: [], service: "billing" })).toBeNull();
});

// A Slack channel ID is opaque — the connector never persists the NAME, which is
// why the spec defers channel matching to a connector-side slice.
test("never matches a Slack channel id", () => {
  seedTicket("s1", "slack", JSON.stringify({ channel: "billing" }));
  expect(matchesService(db, { sourceItemId: "s1", evidence: [], service: "billing" })).toBeNull();
});

test("matching is case-insensitive", () => {
  seedPrItem("pr1", "acme/Billing#412", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "BILLING" }),
  ).toBe("repo");
});
