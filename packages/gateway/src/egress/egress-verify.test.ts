import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { appendBootMarker } from "./egress-boot-marker.ts";
import { THIS_BINARY_COVERAGE } from "./egress-coverage.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import type { EgressEntry } from "./egress-record.ts";
import {
  EGRESS_SOURCE_TYPES,
  isMarkerSourceType,
  MARKER_SOURCE_TYPES,
} from "./egress-source-type.ts";
import {
  countOutboundEgress,
  egressHead,
  listEgress,
  proveWindow,
  verifyEgressChain,
} from "./egress-verify.ts";

function e(over: Partial<EgressEntry> = {}): EgressEntry {
  return {
    timestamp: 100,
    sourceType: "task",
    sourceId: "s",
    destination: "email",
    method: "email.send",
    payloadSummary: "{}",
    hitlStatus: "approved",
    resultStatus: "authorized",
    ...over,
  };
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("verifyEgressChain", () => {
  test("an empty ledger verifies ok with 0 rows", () => {
    expect(verifyEgressChain(db)).toEqual({ ok: true, verifiedRows: 0 });
  });
  test("a clean 3-row chain verifies ok", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
    appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
    appendEgressEntry(db, e({ method: "c.z", timestamp: 3 }));
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(true);
    expect(r.verifiedRows).toBe(3);
  });
  test("a tampered data field is detected via row_hash mismatch", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
    appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
    const id = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1`).get() as { id: number }
    ).id;
    db.run(`UPDATE egress_ledger SET destination = 'evil' WHERE id = ?`, [id]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(id);
    expect(r.reason).toMatch(/row_hash mismatch/);
  });
  test("a post-write hitl_status flip is detected via row_hash mismatch", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1, hitlStatus: "rejected" }));
    const id = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1`).get() as { id: number }
    ).id;
    // Flip the persisted consent decision without touching any other field.
    db.run(`UPDATE egress_ledger SET hitl_status = 'approved' WHERE id = ?`, [id]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(id);
    expect(r.reason).toMatch(/row_hash mismatch/);
  });
  test("a tampered prev_hash is detected via linkage check", () => {
    appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
    appendEgressEntry(db, e({ method: "b.y", timestamp: 2 }));
    appendEgressEntry(db, e({ method: "c.z", timestamp: 3 }));
    expect(verifyEgressChain(db).ok).toBe(true);
    // Fetch the second row's id — the one whose prev_hash we'll corrupt.
    const secondId = (
      db.query(`SELECT id FROM egress_ledger ORDER BY id ASC LIMIT 1 OFFSET 1`).get() as {
        id: number;
      }
    ).id;
    // Mutate ONLY prev_hash (no hashed data field changes) so only the linkage check fires.
    db.run(`UPDATE egress_ledger SET prev_hash = ? WHERE id = ?`, ["0".repeat(64), secondId]);
    const r = verifyEgressChain(db);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(secondId);
    expect(r.reason).toMatch(/prev_hash mismatch/);
  });
});

describe("egressHead", () => {
  test("reports the head hash and count", () => {
    appendEgressEntry(db, e());
    const h = egressHead(db);
    expect(h.count).toBe(1);
    expect(h.head).toMatch(/^[0-9a-f]{64}$/);
  });
  test("an empty ledger reports the genesis head and count 0", () => {
    const h = egressHead(db);
    expect(h.count).toBe(0);
    expect(h.head).toBe("0".repeat(64));
  });
});

describe("listEgress", () => {
  test("filters by since/until and respects limit", () => {
    appendEgressEntry(db, e({ timestamp: 10 }));
    appendEgressEntry(db, e({ timestamp: 20 }));
    appendEgressEntry(db, e({ timestamp: 30 }));
    expect(listEgress(db, { since: 15, until: 25 })).toHaveLength(1);
    expect(listEgress(db, { limit: 2 })).toHaveLength(2);
  });
});

describe("proveWindow", () => {
  test("a zero-egress window reports outboundEgressEvents 0 and verifies ok", () => {
    const out = proveWindow(db, { since: 0, until: 1000 });
    expect(out.completeness.outboundEgressEvents).toBe(0);
    expect(out.verify.ok).toBe(true);
    expect(out.rows).toHaveLength(0);
  });
  test("a window with no covering boot marker is indeterminate, never a clean zero", () => {
    const out = proveWindow(db, {});
    expect(out.completeness.outboundEgressEvents).toBe(0);
    // 0 events, intact chain — and STILL not provable, because nothing recorded what was observed.
    expect(out.completeness.indeterminate).toBe(true);
    expect(out.completeness.coverage.task).toBe("none");
  });
  test("with a boot marker, a clean window is determinate and reports its coverage", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    const out = proveWindow(db, {});
    expect(out.completeness.indeterminate).toBe(false);
    expect(out.completeness.coverage.task).toBe("per-call");
    expect(out.completeness.coverage.model).toBe("none");
    expect(out.completeness.outboundEgressEvents).toBe(0); // the marker itself is not counted
    // Whole-shape pin: a field added to (or dropped from) `completeness` shows up here as a visible
    // diff instead of silently passing the single-field probes above.
    expect(out.completeness).toEqual({
      coverage: THIS_BINARY_COVERAGE,
      outboundEgressEvents: 0,
      indeterminate: false,
    });
  });
  test("a window with one dispatch reports exactly that row", () => {
    appendEgressEntry(db, e({ timestamp: 50, method: "email.send" }));
    const out = proveWindow(db, { since: 0, until: 100 });
    expect(out.completeness.outboundEgressEvents).toBe(1);
    expect(out.rows[0]?.method).toBe("email.send");
  });
  test("marker rows are not counted as outbound egress events", () => {
    // One real gated action…
    appendEgressEntry(
      db,
      e({ timestamp: 50, sourceType: "task", destination: "jira", method: "jira.issue.create" }),
    );
    // …and one prune tombstone, which carries resultStatus 'authorized' but sends NOTHING.
    appendEgressEntry(
      db,
      e({
        timestamp: 51,
        sourceType: "prune",
        sourceId: "boundary-hash",
        destination: "local",
        method: "egress.prune",
      }),
    );
    const out = proveWindow(db, {});
    expect(out.completeness.outboundEgressEvents).toBe(1);
  });

  // Fix 1 (soundness): a row appended in the SAME MILLISECOND as a covering boot marker is
  // indistinguishable from it by `timestamp` alone. These regressions insert the egress row FIRST
  // (lower `id` — the true append order) and the boot marker SECOND at an identical timestamp, so
  // the marker cannot honestly vouch for having observed that row. Both must report `indeterminate`
  // — a sound implementation must fail closed on the tie rather than assume the marker came first.
  test("BOUNDED window: an egress row sharing the covering marker's timestamp is NOT covered", () => {
    appendEgressEntry(db, e({ timestamp: 500, destination: "email", method: "email.send" }));
    appendBootMarker(db, THIS_BINARY_COVERAGE, 500); // same millisecond, appended AFTER (higher id)
    const out = proveWindow(db, { since: 500, until: 1000 });
    expect(out.completeness.indeterminate).toBe(true);
    expect(out.completeness.coverage.task).toBe("none");
  });
  test("UNBOUNDED window: an egress row sharing the first marker's timestamp is NOT covered", () => {
    appendEgressEntry(db, e({ timestamp: 500, destination: "email", method: "email.send" }));
    appendBootMarker(db, THIS_BINARY_COVERAGE, 500); // same millisecond, appended AFTER (higher id)
    const out = proveWindow(db, {});
    expect(out.completeness.indeterminate).toBe(true);
    expect(out.completeness.coverage.task).toBe("none");
  });
});

/**
 * `nimbus prove` is the product's honesty primitive: the number it prints is a claim about how
 * much left this machine. Before this, `outboundEgressEvents` was derived by filtering the rows
 * `listEgress` returned — a page capped at 1000 and ordered `id ASC` — so any window with more
 * than a page of rows under-reported, dropped the NEWEST rows while doing it, and still said
 * `indeterminate: false` with `verify.ok: true`. A confident wrong number is worse than an
 * admitted unknown, which is the rule the rest of this module is built around.
 */
describe("proveWindow — the count is not a page", () => {
  const PAGE = 1000; // listEgress' default page size

  test("counts every outbound row in the window, well past the page limit", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1);
    const total = PAGE * 3;
    for (let i = 0; i < total; i++) {
      appendEgressEntry(db, e({ timestamp: 100 + i, method: `m.${String(i)}` }));
    }

    const out = proveWindow(db, {});

    expect(out.completeness.outboundEgressEvents).toBe(total);
    // The page itself stays bounded — that is deliberate, it crosses IPC.
    expect(out.rows).toHaveLength(PAGE);
    // ...but it must announce that it is a page, not the window.
    expect(out.rowsTruncated).toBe(true);
    expect(out.rowsTotal).toBe(total + 1); // + the boot marker row
    expect(out.completeness.indeterminate).toBe(false);
  });

  test("counts past the page limit inside an explicit since/until window too", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1);
    for (let i = 0; i < PAGE + 500; i++) {
      appendEgressEntry(db, e({ timestamp: 100 + i, method: `m.${String(i)}` }));
    }
    const out = proveWindow(db, { since: 100, until: 100 + PAGE + 500 });
    expect(out.completeness.outboundEgressEvents).toBe(PAGE + 500);
  });

  test("a window that fits in one page reports rowsTruncated false", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1);
    appendEgressEntry(db, e({ timestamp: 100 }));
    const out = proveWindow(db, {});
    expect(out.rowsTruncated).toBe(false);
    expect(out.completeness.outboundEgressEvents).toBe(1);
  });

  test("blocked rows are never counted as outbound, at any size", () => {
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1);
    for (let i = 0; i < PAGE + 10; i++) {
      appendEgressEntry(db, e({ timestamp: 100 + i, resultStatus: "blocked" }));
    }
    appendEgressEntry(db, e({ timestamp: 9000 }));
    expect(proveWindow(db, {}).completeness.outboundEgressEvents).toBe(1);
  });
});

/**
 * The SQL predicate in `countOutboundEgress` and the TypeScript predicate `isMarkerSourceType` are
 * two encodings of one rule. Asserting them against each other for EVERY member of the frozen
 * source-type union is what stops them drifting: adding a member to `MARKER_SOURCE_TYPES` without
 * teaching the SQL about it (or the reverse) fails here rather than silently mis-counting egress.
 */
describe("countOutboundEgress — marker parity with isMarkerSourceType", () => {
  test("every source type is counted iff it is not a marker", () => {
    let expected = 0;
    for (const [i, sourceType] of EGRESS_SOURCE_TYPES.entries()) {
      appendEgressEntry(db, e({ timestamp: 100 + i, sourceType, method: `m.${sourceType}` }));
      if (!isMarkerSourceType(sourceType)) expected++;
    }
    expect(countOutboundEgress(db, {})).toBe(expected);
    // Guard against the loop asserting nothing if the union is emptied.
    expect(expected).toBeGreaterThan(0);
    expect(EGRESS_SOURCE_TYPES.length - expected).toBe(MARKER_SOURCE_TYPES.size);
  });

  test("an UNRECOGNISED source type counts, rather than vanishing from the total", () => {
    // isMarkerSourceType documents this: "Unknown values are NOT markers — an unknown row counts."
    // A `NOT IN (...)` predicate would agree, but a naive `IN (known outbound types)` would not,
    // and would under-report — the direction that matters for a proof.
    appendEgressEntry(db, e({ timestamp: 100, sourceType: "not-a-known-type" as never }));
    expect(countOutboundEgress(db, {})).toBe(1);
  });
});
