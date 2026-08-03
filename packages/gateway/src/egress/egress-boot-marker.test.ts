// packages/gateway/src/egress/egress-boot-marker.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendBootMarker } from "./egress-boot-marker.ts";
import { THIS_BINARY_COVERAGE } from "./egress-coverage.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { coverageForWindow, listEgress, verifyEgressChain } from "./egress-verify.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("boot marker", () => {
  test("appends one marker row carrying the serialized vector in the hashed source_id", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceType).toBe("boot");
    expect(rows[0]?.method).toBe("egress.boot");
    expect(rows[0]?.sourceId).toBe("model=none;peer=none;session=none;sync=none;task=per-call");
    // The marker participates in the chain like any other row.
    expect(verifyEgressChain(db).ok).toBe(true);
  });

  test("coverageForWindow with NO covering marker claims nothing", () => {
    expect(coverageForWindow(db, { until: 500 })).toEqual({
      task: "none",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("coverageForWindow uses markers at or before the window, weakest wins", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    appendBootMarker(
      db,
      {
        task: "per-call",
        session: "per-call",
        sync: "per-run",
        model: "per-call",
        peer: "per-call",
      },
      2_000,
    );
    // Window covers both boots → weakest per class.
    expect(coverageForWindow(db, { since: 500, until: 3_000 })).toEqual({
      task: "per-call",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("an unparseable marker forces all-none — it must not be silently skipped", () => {
    // A marker this binary cannot parse: written by a NEWER gateway, or corrupted. Skipping it
    // would let the OTHER (valid, richer) marker vouch for the window — overstating coverage.
    appendEgressEntry(db, {
      timestamp: 1_000,
      sourceType: "boot",
      sourceId: "task=teleportation;wat=none",
      destination: "local",
      method: "egress.boot",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
    appendBootMarker(
      db,
      {
        task: "per-call",
        session: "per-call",
        sync: "per-run",
        model: "per-call",
        peer: "per-call",
      },
      2_000,
    );
    expect(coverageForWindow(db, { since: 500, until: 3_000 })).toEqual({
      task: "none",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
  });
});
