import type { Database } from "bun:sqlite";
import { GENESIS_HASH } from "../db/audit-chain.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { BOOT_MARKER_METHOD } from "./egress-boot-marker.ts";
import {
  ALL_NONE_COVERAGE,
  COVERAGE_CLASSES,
  type CoverageVector,
  parseCoverage,
  weakestCoverage,
} from "./egress-coverage.ts";
import { computeEgressRowHash } from "./egress-ledger.ts";
import { isMarkerSourceType } from "./egress-source-type.ts";

/** Hard ceiling on `listEgress` rows — bounds the cost of an IPC-supplied `limit`. */
const MAX_EGRESS_LIST_LIMIT = 5000;

export type EgressRow = {
  id: number;
  timestamp: number;
  sourceType: string;
  sourceId: string | null;
  destination: string;
  method: string;
  payloadSummary: string;
  hitlStatus: string;
  resultStatus: string;
  rowHash: string;
  prevHash: string;
};

type RawRow = {
  id: number;
  timestamp: number;
  source_type: string;
  source_id: string | null;
  destination: string;
  method: string;
  payload_summary: string;
  hitl_status: string;
  result_status: string;
  row_hash: string;
  prev_hash: string;
};

function toRow(r: RawRow): EgressRow {
  return {
    id: r.id,
    timestamp: r.timestamp,
    sourceType: r.source_type,
    sourceId: r.source_id,
    destination: r.destination,
    method: r.method,
    payloadSummary: r.payload_summary,
    hitlStatus: r.hitl_status,
    resultStatus: r.result_status,
    rowHash: r.row_hash,
    prevHash: r.prev_hash,
  };
}

export type EgressVerifyResult = {
  ok: boolean;
  verifiedRows: number;
  brokenAt?: number;
  reason?: string;
};

/**
 * Walk the chain from `fromId` (exclusive), recompute each row hash, and compare with the
 * constant-time hex comparator (I10 — `sha256HexEqualConstantTime` works on any 64-char hex,
 * which is BLAKE3's output width — never `===`). A `prev_hash` discontinuity or a hash mismatch
 * fails closed with `brokenAt`.
 *
 * Attested-boundary rule: after a tombstone-boundary prune the first surviving segment starts
 * at a pruned boundary — its `prev_hash` equals the `row_hash` of the last deleted row, which is
 * no longer present. This is legitimate: the tombstone (`source_type='prune'`) records that
 * boundary hash in `source_id` (a field that IS part of `computeEgressRowHash`, making the
 * attestation tamper-evident). The verifier pre-scans all prune tombstones to collect the set of
 * attested boundaries and accepts a `prev_hash` mismatch at the START of the walk if (and only if)
 * the mismatched `prev_hash` is one of those attested boundaries. A mid-chain mismatch is still
 * a real break and fails closed.
 */
export function verifyEgressChain(db: Database, fromId = 0): EgressVerifyResult {
  const start = Math.max(0, Math.floor(fromId));

  // Pre-scan: collect every boundary hash attested by a prune tombstone (source_id on prune rows).
  const attestedBoundaries = new Set<string>(
    (
      db
        .query(
          `SELECT source_id FROM egress_ledger WHERE source_type = 'prune' AND source_id IS NOT NULL`,
        )
        .all() as { source_id: string }[]
    ).map((r) => r.source_id),
  );

  const rows = db
    .query(
      `SELECT id, timestamp, source_type, source_id, destination, method, payload_summary,
              hitl_status, result_status, row_hash, prev_hash
       FROM egress_ledger WHERE id > ? ORDER BY id ASC`,
    )
    .all(start) as RawRow[];

  let prev =
    start > 0
      ? ((
          db.query(`SELECT row_hash FROM egress_ledger WHERE id = ?`).get(start) as
            | { row_hash: string }
            | undefined
        )?.row_hash ?? GENESIS_HASH)
      : GENESIS_HASH;

  let verified = 0;
  let isFirst = true;
  for (const r of rows) {
    if (!sha256HexEqualConstantTime(r.prev_hash, prev)) {
      // Accept a boundary mismatch only at the very first row of the walk when the prev_hash is
      // an attested prune boundary. A mid-chain mismatch is always a real break (fail-closed).
      if (isFirst && attestedBoundaries.has(r.prev_hash)) {
        // Legitimate prune boundary: advance `prev` to the attested boundary so the row_hash
        // recomputation below uses the correct prevHash the row was originally written with.
        prev = r.prev_hash;
      } else {
        return {
          ok: false,
          verifiedRows: verified,
          brokenAt: r.id,
          reason: `prev_hash mismatch at id ${String(r.id)}`,
        };
      }
    }
    const expected = computeEgressRowHash({
      prevHash: prev,
      timestamp: r.timestamp,
      sourceType: r.source_type,
      sourceId: r.source_id,
      destination: r.destination,
      method: r.method,
      hitlStatus: r.hitl_status,
      resultStatus: r.result_status,
    });
    if (!sha256HexEqualConstantTime(expected, r.row_hash)) {
      return {
        ok: false,
        verifiedRows: verified,
        brokenAt: r.id,
        reason: `row_hash mismatch at id ${String(r.id)}`,
      };
    }
    prev = r.row_hash;
    verified += 1;
    isFirst = false;
  }
  return { ok: true, verifiedRows: verified };
}

export function egressHead(db: Database): { head: string; count: number } {
  const head =
    (
      db.query(`SELECT row_hash FROM egress_ledger ORDER BY id DESC LIMIT 1`).get() as
        | { row_hash: string }
        | undefined
    )?.row_hash ?? GENESIS_HASH;
  const count = (db.query(`SELECT COUNT(*) as c FROM egress_ledger`).get() as { c: number }).c;
  return { head, count };
}

export function listEgress(
  db: Database,
  opts: { since?: number | undefined; until?: number | undefined; limit?: number | undefined },
): EgressRow[] {
  const since = opts.since ?? 0;
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  // Clamp to a hard ceiling: `egress.list` flows from IPC, so an arbitrarily large positive limit
  // could force an expensive scan/allocation on a large ledger.
  const requested = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : 1000;
  const limit = Math.min(requested, MAX_EGRESS_LIST_LIMIT);
  const rows = db
    .query(
      `SELECT id, timestamp, source_type, source_id, destination, method, payload_summary,
              hitl_status, result_status, row_hash, prev_hash
       FROM egress_ledger WHERE timestamp >= ? AND timestamp <= ? ORDER BY id ASC LIMIT ?`,
    )
    .all(since, until, limit) as RawRow[];
  return rows.map(toRow);
}

type MarkerRow = { timestamp: number; source_id: string | null };

/**
 * The single boot-marker row (if any) at or before `ts`. Queried DIRECTLY against
 * `egress_ledger` — NOT via `listEgress`, whose default 1000-row page (oldest-first) would make a
 * marker appended after row 1000 invisible on any ledger past that size (fix 1). Restricted in SQL
 * to `method = BOOT_MARKER_METHOD` so no pagination limit is needed here at all.
 */
function lastMarkerAtOrBefore(db: Database, ts: number): MarkerRow | undefined {
  // bun:sqlite `.get()` returns `null` (not `undefined`) for an empty result — normalize so
  // callers can use a single `!== undefined` check.
  //
  // `AND source_type = 'boot'` is load-bearing, not redundant with `method = ?`: `method` alone
  // would let ANY ledger row whose method happens to collide with `BOOT_MARKER_METHOD` (a bug, or
  // a future row class reusing the string) vouch for coverage regardless of its actual class. Only
  // a genuine `appendBootMarker` row (`source_type='boot'`) may claim coverage.
  const row = db
    .query(
      `SELECT timestamp, source_id FROM egress_ledger
       WHERE method = ? AND source_type = 'boot' AND timestamp <= ?
       ORDER BY timestamp DESC, id DESC LIMIT 1`,
    )
    .get(BOOT_MARKER_METHOD, ts) as MarkerRow | null;
  return row ?? undefined;
}

/** Every boot-marker row strictly after `sinceExclusive` and at or before `until`, oldest first. */
function markersInRange(db: Database, sinceExclusive: number, until: number): MarkerRow[] {
  // See `lastMarkerAtOrBefore` above for why `source_type = 'boot'` must accompany `method = ?`.
  return db
    .query(
      `SELECT timestamp, source_id FROM egress_ledger
       WHERE method = ? AND source_type = 'boot' AND timestamp > ? AND timestamp <= ?
       ORDER BY timestamp ASC, id ASC`,
    )
    .all(BOOT_MARKER_METHOD, sinceExclusive, until) as MarkerRow[];
}

/** True if ANY ledger row (marker or not) falls in `[since, beforeTs)`. */
function hasRowBefore(db: Database, since: number, beforeTs: number): boolean {
  // bun:sqlite `.get()` returns `null` (not `undefined`) for an empty result — `!= null` catches
  // both so an empty result isn't mistaken for a found row.
  const row = db
    .query(`SELECT 1 as x FROM egress_ledger WHERE timestamp >= ? AND timestamp < ? LIMIT 1`)
    .get(since, beforeTs) as { x: number } | null;
  return row != null;
}

function coverageOf(r: MarkerRow): CoverageVector {
  // Unreadable/unparseable marker → claim nothing for every class (see doc comment below).
  return r.source_id === null
    ? ALL_NONE_COVERAGE
    : (parseCoverage(r.source_id) ?? ALL_NONE_COVERAGE);
}

/**
 * The coverage that can be claimed for a window `[since, until]`: the weakest granularity per
 * class across the boot marker that covers the window's START, merged with every boot marker that
 * booted DURING the window.
 *
 * Sound rule (fix 4): a window may claim coverage only if a marker covers its start. A window
 * whose first-ever marker boots mid-window (e.g. `since=500` but the earliest marker is at
 * `t=1000`) must not silently claim coverage for the unobserved `[500, 1000)` slice just because a
 * marker eventually shows up before `until` — that slice had no marker vouching for it, so nothing
 * can be said about it, and the honest answer is `indeterminate`.
 *
 * Implementation: `since`'s covering marker (the LAST marker at or before `since`) plus every
 * marker within `(since, until]`. If no marker covers `since` AND the caller asked for that
 * specific `since` explicitly, the window claims nothing (`ALL_NONE_COVERAGE`) — the "may claim
 * coverage only if a marker covers its start" rule applied literally.
 *
 * UNBOUNDED-QUERY CARVE-OUT (`since` omitted, e.g. plain `nimbus egress`/`nimbus prove`): an
 * omitted `since` means "from the beginning of recorded history", and there is by definition
 * nothing before that beginning to be silently uncovered — UNLESS the ledger's own earliest rows
 * predate its first-ever boot marker (a real, if rare, gap: e.g. a build old enough not to call
 * `appendBootMarker`). So for the omitted-`since` case only, the window still claims coverage from
 * the markers within it as long as no ledger row precedes the earliest of those markers; a fresh
 * database (whose very first row IS the boot marker) is therefore NOT punished into permanent
 * `indeterminate` just because `since` defaults to 0 and no marker literally covers timestamp 0.
 *
 * An UNPARSEABLE marker (any marker, whether covering `since` or booted mid-window) contributes an
 * all-`none` vector rather than being skipped. Skipping it would let a sibling marker's richer
 * claim stand, overstating coverage; contributing all-`none` drives the weakest-merge to `none`
 * everywhere, so the window reports `indeterminate`. This is the "indeterminate, never a false
 * zero" rule — NOT a throw, because one unreadable row must not take `nimbus egress` down.
 * (Deliberate tampering is already caught elsewhere: `source_id` is hashed, so an edited marker
 * breaks `verifyEgressChain`. The case handled here is a marker written by a NEWER binary using a
 * class or granularity this one does not know.)
 *
 * Lives here (not in `egress-boot-marker.ts`) because a two-way import between the two files is
 * forbidden by `.dependency-cruiser.cjs` `no-circular` (enforced via `audit:boundaries`).
 *
 * RECONCILED (was a recorded known limitation): coverage no longer merges over the ENTIRE ledger
 * history for a bounded window — only the marker covering `since` plus markers booted within the
 * window count, so coverage CAN rise for a window entirely after a more-capable binary booted; an
 * old, weaker marker from long before `since` no longer permanently caps it. The unbounded query
 * (no `--since`) is the one case that still merges across all history, and that is correct, not a
 * limitation: asking about the whole ledger genuinely requires the weakest coverage across every
 * binary that ever wrote into it.
 */
export function coverageForWindow(
  db: Database,
  opts: { since?: number | undefined; until?: number | undefined },
): CoverageVector {
  const since = opts.since ?? 0;
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  const sinceOmitted = opts.since === undefined;

  const priorMarker = lastMarkerAtOrBefore(db, since);
  const inWindow = markersInRange(db, since, until);

  if (priorMarker === undefined) {
    if (inWindow.length === 0) return ALL_NONE_COVERAGE; // no marker anywhere near this window
    if (!sinceOmitted) {
      // The caller asked for a specific `since` and no marker covers it — the window's start is
      // genuinely unobserved. Claim nothing (see "sound rule" above).
      return ALL_NONE_COVERAGE;
    }
    // Unbounded carve-out: only withhold the claim if real rows precede the first in-window
    // marker — i.e. there is an actual observed gap, not just an unmarked timestamp 0.
    const firstMarkerTs = inWindow[0]?.timestamp;
    if (firstMarkerTs !== undefined && hasRowBefore(db, since, firstMarkerTs)) {
      return ALL_NONE_COVERAGE;
    }
  }

  const markerRows = priorMarker === undefined ? inWindow : [priorMarker, ...inWindow];
  return weakestCoverage(markerRows.map(coverageOf));
}

export type EgressCompleteness = {
  /** What the binaries writing into this window were built to observe (§3.6 of the annex). */
  readonly coverage: CoverageVector;
  readonly outboundEgressEvents: number;
  /**
   * True when the count cannot be relied on: no boot marker covers the window, so there is no
   * evidence any egress class was being observed. NEVER report a bare zero in this state.
   */
  readonly indeterminate: boolean;
  /**
   * DEPRECATED additive compatibility shim, owner-decided, for one cycle: the published
   * `@nimbus-dev/client@0.15.0`'s `validateEgressCompleteness` hard-throws unless a `tier` field
   * equal to `"authorized-actions"` is present (it predates the `coverage`/`indeterminate` shape),
   * so any published-client consumer — including nimbus-vscode — hard-fails against a gateway that
   * dropped it outright. Emitted ALONGSIDE `coverage`/`outboundEgressEvents`/`indeterminate`, never
   * in place of them.
   *
   * This value is TRUE TODAY ONLY because Phase 1 coverage is task-only (`THIS_BINARY_COVERAGE` has
   * exactly one non-"none" class, `task`, and only at `"per-call"` granularity) — "authorized
   * gated-connector actions, one row per call" is in fact the whole of what this binary observes.
   * It becomes FALSE the moment any later phase raises another coverage class (`session`/`sync`/
   * `model`/`peer`) above `"none"`, because at that point the binary observes more than
   * "authorized-actions" describes and this field would misstate coverage exactly the way the old
   * scalar `tier` used to. It MUST be removed — not merely "deprecated, remove eventually" — before
   * any phase raises another coverage class. Nothing in the gateway or CLI reads this field for a
   * decision; it exists solely for old-client wire compatibility.
   */
  readonly tier: "authorized-actions";
};

/**
 * The `nimbus prove` window: the rows in [since, until], the completeness (a per-source coverage
 * vector — what the binaries writing into this window were built to observe — plus an
 * `indeterminate` flag when no boot marker covers the window), and the chain verify result. A
 * degraded chain surfaces `verify.ok === false` — the CLI prints `indeterminate`, never a false
 * `0` (the EAF "indeterminate, never a false zero" rule).
 *
 * NOTE — `verify` runs `verifyEgressChain` over the WHOLE ledger (fromId = 0), not just the
 * window rows. This is intentional and fail-closed: the "zero egress in window W" inference is
 * only sound if the entire chain is intact. A row deleted or relinked outside the window would
 * corrupt the `prev_hash` linkage of a later row without touching any row inside the window, so a
 * window-scoped verify would silently miss it. If `verify.ok === false`, the ledger's integrity is
 * in question even when the window's own rows appear fine.
 */
export function proveWindow(
  db: Database,
  opts: { since?: number | undefined; until?: number | undefined },
): { rows: EgressRow[]; completeness: EgressCompleteness; verify: EgressVerifyResult } {
  const rows = listEgress(db, {
    ...(opts.since !== undefined && { since: opts.since }),
    ...(opts.until !== undefined && { until: opts.until }),
  });
  const outbound = rows.filter(
    (r) => r.resultStatus === "authorized" && !isMarkerSourceType(r.sourceType),
  ).length;
  const coverage = coverageForWindow(db, opts);
  const indeterminate = COVERAGE_CLASSES.every((c) => coverage[c] === "none");
  return {
    rows,
    // `tier: "authorized-actions"` is the deprecated additive compat shim documented on
    // `EgressCompleteness` — see that doc comment before touching this literal.
    completeness: {
      coverage,
      outboundEgressEvents: outbound,
      indeterminate,
      tier: "authorized-actions",
    },
    verify: verifyEgressChain(db),
  };
}
