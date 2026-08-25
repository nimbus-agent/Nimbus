// packages/gateway/src/egress/outcome-egress.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import type { EgressEntry } from "./egress-record.ts";
import { countOutboundEgress, listEgress, verifyEgressChain } from "./egress-verify.ts";
import { recordFetchOutcomeEgress } from "./outcome-egress.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed by a test that needed it shut */
  }
});

/** The authorising row a targeted fetch appends before calling the connector. */
function authorising(over: Partial<EgressEntry> = {}): { rowHash: string } {
  return appendEgressEntry(db, {
    timestamp: 1_000,
    sourceType: "sync",
    sourceId: "asafs-browser",
    destination: "github",
    method: "items.fetch",
    payloadSummary: "{}",
    hitlStatus: "not_required",
    resultStatus: "authorized",
    ...over,
  });
}

describe("recordFetchOutcomeEgress", () => {
  test("writes one outcome marker naming the authorising row by hash", () => {
    const authorized = authorising();

    recordFetchOutcomeEgress(db, {
      destination: "github",
      authorizingRowHash: authorized.rowHash,
      status: "indexed",
      itemId: "github:acme/web#482",
      now: 2_000,
    });

    const rows = listEgress(db, {});
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      sourceType: "outcome",
      // The correlation key. Prune tombstones already carry an attested hash in
      // `source_id`, so a marker using that column this way is established.
      sourceId: authorized.rowHash,
      destination: "github",
      method: "items.fetch.outcome",
      hitlStatus: "not_required",
      // "was this allowed", not "did it work" — the fetch's result lives in the
      // summary, which is the field that actually has three values.
      resultStatus: "authorized",
    });
    expect(rows[1]?.payloadSummary).toContain("indexed");
    expect(rows[1]?.payloadSummary).toContain("github:acme/web#482");
  });

  test("carries the miss reason on not_found, and no itemId", () => {
    recordFetchOutcomeEgress(db, {
      destination: "jira",
      authorizingRowHash: "a".repeat(64),
      status: "not_found",
      reason: "deleted",
      now: 2_000,
    });
    const summary = listEgress(db, {})[0]?.payloadSummary ?? "";
    expect(summary).toContain("not_found");
    expect(summary).toContain("deleted");
    expect(summary).not.toContain("itemId");
  });

  test("an outcome row does NOT count as outbound egress", () => {
    // The double-count guard. A fetch and its outcome are ONE outbound event —
    // this is the test that fails if `outcome` is ever moved out of
    // MARKER_SOURCE_TYPES.
    authorising({ sourceId: null });
    recordFetchOutcomeEgress(db, {
      destination: "github",
      authorizingRowHash: "b".repeat(64),
      status: "rate_limited",
      now: 2_000,
    });
    expect(listEgress(db, {})).toHaveLength(2);
    expect(countOutboundEgress(db, {})).toBe(1);
  });

  test("the chain still verifies across the pair", () => {
    const first = authorising({ sourceId: null });
    recordFetchOutcomeEgress(db, {
      destination: "github",
      authorizingRowHash: first.rowHash,
      status: "indexed",
      itemId: "github:acme/web#1",
      now: 2_000,
    });
    const verdict = verifyEgressChain(db);
    expect(verdict.ok).toBe(true);
    expect(verdict.verifiedRows).toBe(2);
  });

  test("a throwing append propagates — the caller owns the swallow", () => {
    // Swallowing lives at the call site (targeted-fetch.ts), following
    // `appendBootMarkerOrWarn`. This function must not hide a failure from a
    // caller that may want to warn about it.
    db.close();
    expect(() =>
      recordFetchOutcomeEgress(db, {
        destination: "github",
        authorizingRowHash: "c".repeat(64),
        status: "indexed",
        now: 2_000,
      }),
    ).toThrow();
  });
});
