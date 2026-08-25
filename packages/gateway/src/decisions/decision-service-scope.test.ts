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

test("matches a commit evidence item, not just a pr", () => {
  seedPrItem("c1", "acme/billing#9", null);
  const evidence: DecisionEvidence[] = [
    { kind: "commit", entityId: null, itemId: "c1", label: "abc123", url: null, occurredAt: null },
  ];
  expect(matchesService(db, { sourceItemId: "s1", evidence, service: "billing" })).toBe("repo");
});

// The repo route reads only pr/commit evidence. A decision corroborated solely
// by, say, an ADR document must fall through to the ticket route rather than
// running a repo lookup against an unrelated item.
test("ignores evidence kinds other than pr and commit", () => {
  seedPrItem("m1", "acme/billing#9", null);
  const evidence: DecisionEvidence[] = [
    { kind: "adr", entityId: null, itemId: "m1", label: "ADR-7", url: null, occurredAt: null },
  ];
  expect(matchesService(db, { sourceItemId: "s1", evidence, service: "billing" })).toBeNull();
});

test("ignores pr evidence that carries no itemId", () => {
  const evidence: DecisionEvidence[] = [
    { kind: "pr", entityId: "e1", itemId: null, label: "#1", url: null, occurredAt: null },
  ];
  expect(matchesService(db, { sourceItemId: "s1", evidence, service: "billing" })).toBeNull();
});

// Evidence can outlive the item it points at (a prune, a connector removal).
// The lookup must return null rather than throwing on the missing row.
test("survives evidence pointing at an item that is no longer indexed", () => {
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("gone"), service: "billing" }),
  ).toBeNull();
});

// GitLab-shaped metadata: `project` rather than `repo`. This fallback is the
// documented reason `repoOfItem` reads two metadata fields.
test("falls back to metadata.project when metadata.repo is absent", () => {
  seedPrItem("pr1", "acme/wrong#412", JSON.stringify({ project: "acme/billing" }));
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

test("falls back to the external_id prefix when metadata.repo is an empty string", () => {
  seedPrItem("pr1", "acme/billing#412", JSON.stringify({ repo: "" }));
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

test("falls back to the external_id prefix when metadata is not JSON", () => {
  seedPrItem("pr1", "acme/billing#412", "{not json");
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

test("falls back to the external_id prefix when metadata parses to a non-object", () => {
  seedPrItem("pr1", "acme/billing#412", "null");
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});

// `github-sync.ts` writes `owner/repo#number`. An external_id with no `#` —
// any other connector's id shape — carries no repo, and inferring one from the
// whole string would match arbitrary services.
test("does not infer a repo from an external_id with no '#' separator", () => {
  seedPrItem("pr1", "billing", null);
  expect(
    matchesService(db, { sourceItemId: "s1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBeNull();
});

test("does not match a jira source item whose metadata is not JSON", () => {
  seedTicket("j1", "jira", "{not json");
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "billing" })).toBeNull();
});

test("does not match a jira source item whose metadata parses to a non-object", () => {
  seedTicket("j1", "jira", "null");
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "billing" })).toBeNull();
});

test("does not match a jira item carrying neither key nor identifier", () => {
  seedTicket("j1", "jira", JSON.stringify({ summary: "billing" }));
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "billing" })).toBeNull();
});

test("does not match a ticket identifier with an empty project prefix", () => {
  seedTicket("j1", "jira", JSON.stringify({ key: "-123" }));
  expect(matchesService(db, { sourceItemId: "j1", evidence: [], service: "billing" })).toBeNull();
});

test("does not match a source item that is not indexed at all", () => {
  expect(matchesService(db, { sourceItemId: "gone", evidence: [], service: "billing" })).toBeNull();
});

// The repo route is consulted first: when both routes would match, the reported
// route must be `repo` so a brief's provenance line stays deterministic.
test("reports the repo route when both routes would match", () => {
  seedPrItem("pr1", "acme/billing#412", null);
  seedTicket("j1", "jira", JSON.stringify({ key: "BILLING-1" }));
  expect(
    matchesService(db, { sourceItemId: "j1", evidence: prEvidence("pr1"), service: "billing" }),
  ).toBe("repo");
});
