# I29 Phase 1 — Make the Claim True Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nimbus prove` stop overstating what the egress ledger observed — freeze the `source_type` union, require the sink, replace the scalar tier with a per-source coverage vector, and kill the false `0 ✓` — **without adding any new egress coverage.**

**Architecture:** Truth before coverage. Every change here makes the *existing* claim honest; nothing new is instrumented. A per-process boot marker records what the running binary was built to observe, so a window with no covering marker reports `indeterminate` instead of a clean zero. The `source_type` union is frozen at eight members in one commit because a `source_type` value written today is permanent in the data — `verifyEgressChain` recomputes row hashes from stored column values, so widening the union later invalidates no existing row, but marker-exclusion (`isMarkerSourceType`) depends on the set being closed, so the vocabulary must be chosen deliberately up front.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, `bun:sqlite`, `bun:test`, Biome.

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is non-negotiable.
- **All SQLite writes go through `dbRun`/`dbExec`/`dbStmtRun`** (I14/D12). Never call `db.run` directly.
- **`appendEgressEntry` may only be referenced inside `packages/gateway/src/egress/`** (D22). Non-test files elsewhere fail `audit:invariants`.
- **Do not modify** `packages/gateway/src/connectors/**`, `index/item-store.ts`, `sync/rate-limiter.ts`, `string/**`, `ipc/index-rebody-rpc.ts` — a parallel branch owns them.
- **Do not change** `computeEgressRowHash`'s input set. Adding or reordering a hashed field invalidates every existing ledger.
- **Invariant triple rule:** wiring + docs + enforcement test land in the same commit (Task 7).
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- Branch: `dev/asaf/i29-ledger-completeness`. Never commit on `main`.
- Spec: [`2026-08-02-i29-d22-egress-completeness-design.md`](../specs/2026-08-02-i29-d22-egress-completeness-design.md) (record) + [`2026-08-03-i29-ledger-completeness-design.md`](../specs/2026-08-03-i29-ledger-completeness-design.md) (annex).

## Out of Scope for Phase 1

Named explicitly so no task drifts into them: instrumenting `router.ts`/`openai-embedder`/`llm/*` (Phase 4), the sync scheduler seam (Phase 3), `egressFetch`/`recordEgress` (Phases 3–5), the `D22-egress-fetch` static rule (Phase 4), the MCP-mesh execute modality (Phase 2), the `globalThis.fetch` backstop (unscheduled).

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/egress/egress-source-type.ts` *(new)* | The frozen 8-member union, the marker set, and the `isCountedEgressRow` predicate. One concern: what a row *is*. |
| `packages/gateway/src/egress/egress-coverage.ts` *(new)* | `CoverageVector`, `Granularity`, serialization, weakest-merge, and `THIS_BINARY_COVERAGE`. One concern: what the binary *observes*. |
| `packages/gateway/src/egress/egress-boot-marker.ts` *(new)* | Appends the per-process boot marker; resolves the vector covering a window. |
| `packages/gateway/src/egress/egress-ledger.ts` | Narrow `EgressEntry.sourceType` to the union; add `NULL_EGRESS_SINK`. |
| `packages/gateway/src/egress/egress-verify.ts` | `proveWindow` returns the vector, excludes markers, reports `indeterminate` with no covering marker. |
| `packages/gateway/src/engine/executor.ts` | `egressSink` becomes required. |
| `packages/gateway/src/ipc/server/{dispatchers,vault-dispatch}.ts` | Pass `NULL_EGRESS_SINK` at the 7 gate-only sites. |
| `packages/gateway/src/platform/assemble.ts` | Append the boot marker at startup. |
| `packages/cli/src/commands/prove.ts` | Never print a bare `0 ✓`; always print the coverage vector. |

---

### Task 1: Freeze the `source_type` union

**Files:**

- Create: `packages/gateway/src/egress/egress-source-type.ts`
- Create: `packages/gateway/src/egress/egress-source-type.test.ts`
- Modify: `packages/gateway/src/egress/egress-record.ts:11` — `EgressEntry.sourceType`. **Note it is `egress-record.ts`, not `egress-ledger.ts`**; `EgressEntry` is defined there and re-exported.

**Interfaces:**

- Consumes: nothing.
- Produces: `type EgressSourceType`, `const EGRESS_SOURCE_TYPES: readonly EgressSourceType[]`, `const MARKER_SOURCE_TYPES: ReadonlySet<EgressSourceType>`, `function isMarkerSourceType(s: string): boolean`.

**Why this is one commit and cannot be split:** `source_type` is an input to `computeEgressRowHash`, so a value written today is permanent. The union must land complete, including `boot` and `degraded` whose appenders arrive in Task 3.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/egress/egress-source-type.test.ts`:

```ts
// packages/gateway/src/egress/egress-source-type.test.ts
import { describe, expect, test } from "bun:test";
import {
  EGRESS_SOURCE_TYPES,
  isMarkerSourceType,
  MARKER_SOURCE_TYPES,
} from "./egress-source-type.ts";

describe("EGRESS_SOURCE_TYPES — frozen union", () => {
  // IDENTITY assertion, never a length check: widening the union must show up as a diff on this
  // line. Widening is NOT a chain break (verifyEgressChain recomputes each row's hash from that
  // row's own stored source_type, never from this union's current definition) — it's frozen because
  // a value written today is permanent in the data and isMarkerSourceType depends on the set being
  // known and closed. See the doc comment on EGRESS_SOURCE_TYPES.
  test("is exactly these eight members, in this order", () => {
    expect(EGRESS_SOURCE_TYPES).toEqual([
      "task",
      "prune",
      "session",
      "sync",
      "model",
      "peer",
      "boot",
      "degraded",
    ]);
  });

  test("marker types are the three bookkeeping classes", () => {
    expect([...MARKER_SOURCE_TYPES].sort()).toEqual(["boot", "degraded", "prune"]);
  });

  test("isMarkerSourceType: markers true, egress-bearing false, unknown false", () => {
    expect(isMarkerSourceType("prune")).toBe(true);
    expect(isMarkerSourceType("boot")).toBe(true);
    expect(isMarkerSourceType("degraded")).toBe(true);
    expect(isMarkerSourceType("task")).toBe(false);
    expect(isMarkerSourceType("model")).toBe(false);
    // An unrecognized value must NOT be treated as a marker — an unknown row counts as egress.
    expect(isMarkerSourceType("wat")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-source-type.test.ts`
Expected: FAIL — `Cannot find module './egress-source-type.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/egress/egress-source-type.ts`:

```ts
// packages/gateway/src/egress/egress-source-type.ts

/**
 * The FROZEN `egress_ledger.source_type` union.
 *
 * `source_type` IS one of the fields `computeEgressRowHash` hashes, but widening this union later
 * is NOT a chain break: `verifyEgressChain` recomputes each row's hash from that row's OWN STORED
 * column values (`sourceType: r.source_type`, `egress-verify.ts`), never from the current union
 * definition, so adding a ninth TypeScript member changes no stored row and no hash input — every
 * existing row still verifies exactly as before. (What WOULD be a chain break: changing
 * `computeEgressRowHash`'s input set, or rewriting a stored row's values.)
 *
 * The union is frozen anyway, for two real reasons: (1) a `source_type` value written today is
 * permanent IN THE DATA — every row ever appended keeps whatever string it was given, forever, so
 * the vocabulary must be chosen deliberately rather than casually extended; (2) `isMarkerSourceType`
 * (below) depends on the set of source types being known and closed — an unreviewed new member could
 * silently land outside `MARKER_SOURCE_TYPES` and get miscounted as outbound egress, or inside it and
 * get miscounted as bookkeeping. The union therefore lands COMPLETE, including members whose
 * appenders do not exist yet (`boot`, `degraded` arrive with the boot marker; `sync`, `model`, `peer`
 * arrive in later phases).
 *
 * If a ninth class is ever wanted, the answer is NOT to extend this union — it is to reuse
 * `session` with a reserved `method` value, accepting the weaker string-match exclusion.
 */
export const EGRESS_SOURCE_TYPES = [
  "task", // gated connector action (the only appender today)
  "prune", // retention tombstone
  "session", // gateway housekeeping egress (telemetry, updater, JWKS, …)
  "sync", // connector sync run
  "model", // inference + embeddings, local or remote
  "peer", // federated send
  "boot", // per-process marker carrying the coverage vector
  "degraded", // lost-append recovery marker
] as const;

export type EgressSourceType = (typeof EGRESS_SOURCE_TYPES)[number];

/**
 * Rows that record bookkeeping rather than egress. Never counted as outbound events.
 *
 * Exclusion is explicit rather than implied by `result_status`, because markers legitimately carry
 * `result_status='authorized'` — `pruneEgress` already does, which is why prune tombstones were
 * being miscounted before this landed (see Task 2).
 */
export const MARKER_SOURCE_TYPES: ReadonlySet<EgressSourceType> = new Set<EgressSourceType>([
  "prune",
  "boot",
  "degraded",
]);

/** Marker test over a raw DB string. Unknown values are NOT markers — an unknown row counts. */
export function isMarkerSourceType(sourceType: string): boolean {
  return (MARKER_SOURCE_TYPES as ReadonlySet<string>).has(sourceType);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/egress/egress-source-type.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Narrow `EgressEntry.sourceType` to the union**

In `packages/gateway/src/egress/egress-record.ts` (the file that defines `EgressEntry`), add:

```ts
import type { EgressSourceType } from "./egress-source-type.ts";
```

and change the field:

```ts
  readonly sourceType: string;
```

to:

```ts
  readonly sourceType: EgressSourceType;
```

**Do NOT narrow `EgressRowHashInput.sourceType` in `egress-ledger.ts` — leave it `string`.** That type is the *hash* boundary, and `verifyEgressChain` feeds it values read back out of SQLite (`egress-verify.ts:125`). The verifier must faithfully hash whatever bytes are stored, including a `source_type` this binary does not recognize — a row written by a *newer* gateway. Narrowing it would force a cast at that call site which asserts something untrue about DB contents, and a verifier that refused to hash an unknown value would report a false chain break. The union constrains what this binary may **write**; it must not constrain what the verifier can **read**.

- [ ] **Step 6: Verify the whole egress suite and typecheck still pass**

Run: `bun test packages/gateway/src/egress/ && bun run typecheck`
Expected: all PASS, typecheck exit 0. `buildEgressEntry`'s `sourceType: "task"` and `pruneEgress`'s `sourceType: "prune"` both narrow cleanly — if either errors, the union is missing a member that production already writes, which is a **stop-and-report** condition.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/egress/egress-source-type.ts packages/gateway/src/egress/egress-source-type.test.ts packages/gateway/src/egress/egress-record.ts
git commit -m "feat(egress): freeze the source_type union at eight members"
```

---

### Task 2: Stop counting marker rows (fixes a live miscount)

**Files:**

- Modify: `packages/gateway/src/egress/egress-verify.ts` (`proveWindow`, ~line 199-208)
- Test: `packages/gateway/src/egress/egress-verify.test.ts`

**Interfaces:**

- Consumes: `isMarkerSourceType` from Task 1.
- Produces: `proveWindow` with corrected `completeness.outboundEgressEvents`.

**Context — this is a real bug, not a hypothetical.** `pruneEgress` writes `resultStatus: "authorized"` (`egress-prune.ts:97`), and today's filter is `rows.filter((r) => r.resultStatus === "authorized")` with no source-type exclusion. Every prune tombstone is therefore counted as an outbound egress event today.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/egress/egress-verify.test.ts`. Use the file's existing DB-fixture helper (open it and reuse whatever it already uses to make a temp `Database` and append rows — do **not** invent a second fixture style):

```ts
test("marker rows are not counted as outbound egress events", () => {
  const db = makeTestDb(); // reuse this file's existing fixture helper
  const now = Date.now();
  // One real gated action…
  appendEgressEntry(db, {
    timestamp: now,
    sourceType: "task",
    sourceId: null,
    destination: "jira",
    method: "jira.issue.create",
    payloadSummary: "{}",
    hitlStatus: "approved",
    resultStatus: "authorized",
  });
  // …and one prune tombstone, which carries resultStatus 'authorized' but sends NOTHING.
  appendEgressEntry(db, {
    timestamp: now + 1,
    sourceType: "prune",
    sourceId: "boundary-hash",
    destination: "local",
    method: "egress.prune",
    payloadSummary: "{}",
    hitlStatus: "approved",
    resultStatus: "authorized",
  });

  const out = proveWindow(db, {});
  expect(out.completeness.outboundEgressEvents).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-verify.test.ts -t "marker rows"`
Expected: FAIL — `expected 1, received 2`. That failure **is** the bug being fixed; record the number in the commit body.

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/egress/egress-verify.ts`, add the import:

```ts
import { isMarkerSourceType } from "./egress-source-type.ts";
```

and replace the counting line inside `proveWindow`:

```ts
  const outbound = rows.filter((r) => r.resultStatus === "authorized").length;
```

with:

```ts
  const outbound = rows.filter(
    (r) => r.resultStatus === "authorized" && !isMarkerSourceType(r.sourceType),
  ).length;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/egress/`
Expected: PASS. If a pre-existing test asserted a count that included a prune tombstone, it was asserting the bug — update it and note the change in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/egress-verify.ts packages/gateway/src/egress/egress-verify.test.ts
git commit -F - <<'EOF'
fix(egress): stop counting prune tombstones as outbound egress events

pruneEgress writes resultStatus 'authorized' (egress-prune.ts:97) and
proveWindow counted every authorized row, so each prune inflated the
reported egress count by one despite sending nothing off-machine.

Exclusion is by source_type, not result_status, because markers
legitimately carry 'authorized'.
EOF
```

---

### Task 3: Coverage vector + per-process boot marker

**Files:**

- Create: `packages/gateway/src/egress/egress-coverage.ts`
- Create: `packages/gateway/src/egress/egress-coverage.test.ts`
- Create: `packages/gateway/src/egress/egress-boot-marker.ts`
- Create: `packages/gateway/src/egress/egress-boot-marker.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts:1702` — append the marker at startup (Step 9). **Without this the feature is inert in production and no test in this plan catches it.**

**Interfaces:**

- Consumes: `EgressSourceType` (Task 1), `appendEgressEntry` (`egress-ledger.ts`).
- Produces:
  - `type Granularity = "none" | "per-run" | "per-call"`
  - `type CoverageVector = Readonly<Record<CoverageClass, Granularity>>` where `CoverageClass = "task" | "session" | "sync" | "model" | "peer"`
  - `const THIS_BINARY_COVERAGE: CoverageVector`
  - `function serializeCoverage(v: CoverageVector): string`
  - `function parseCoverage(s: string): CoverageVector | null`
  - `function weakestCoverage(vs: readonly CoverageVector[]): CoverageVector`
  - `const ALL_NONE_COVERAGE: CoverageVector`
  - `function appendBootMarker(db: Database, coverage: CoverageVector, now: number): void`
  - `function coverageForWindow(db, opts: { since?: number; until?: number }): CoverageVector`
  - `const BOOT_MARKER_METHOD = "egress.boot"`

**Design note — where the vector is stored.** It goes in `source_id`, which **is** hashed by `computeEgressRowHash`, so the recorded coverage claim is tamper-evident. It must not go in `payload_summary`, which is deliberately unhashed.

- [ ] **Step 1: Write the failing test for the vector**

Create `packages/gateway/src/egress/egress-coverage.test.ts`:

```ts
// packages/gateway/src/egress/egress-coverage.test.ts
import { describe, expect, test } from "bun:test";
import {
  type CoverageVector,
  parseCoverage,
  serializeCoverage,
  THIS_BINARY_COVERAGE,
  weakestCoverage,
} from "./egress-coverage.ts";

const NONE: CoverageVector = {
  task: "none",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

describe("coverage vector", () => {
  test("Phase 1 binary observes gated actions per-call and nothing else", () => {
    expect(THIS_BINARY_COVERAGE).toEqual({
      task: "per-call",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("serialize is stable and key-sorted", () => {
    expect(serializeCoverage(THIS_BINARY_COVERAGE)).toBe(
      "model=none;peer=none;session=none;sync=none;task=per-call",
    );
  });

  test("parse round-trips serialize", () => {
    expect(parseCoverage(serializeCoverage(THIS_BINARY_COVERAGE))).toEqual(THIS_BINARY_COVERAGE);
  });

  test("parse returns null on malformed input rather than guessing", () => {
    expect(parseCoverage("")).toBeNull();
    expect(parseCoverage("task=banana")).toBeNull();
    expect(parseCoverage("task=per-call")).toBeNull(); // missing classes
  });

  test("weakest takes the LOWEST granularity per class across binaries", () => {
    const rich: CoverageVector = {
      task: "per-call",
      session: "per-call",
      sync: "per-run",
      model: "per-call",
      peer: "per-call",
    };
    expect(weakestCoverage([rich, THIS_BINARY_COVERAGE])).toEqual({
      task: "per-call", // both per-call
      session: "none", // Phase 1 binary saw nothing
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  test("weakest of an empty list is all-none — claim nothing without evidence", () => {
    expect(weakestCoverage([])).toEqual(NONE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-coverage.test.ts`
Expected: FAIL — `Cannot find module './egress-coverage.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/gateway/src/egress/egress-coverage.ts`:

```ts
// packages/gateway/src/egress/egress-coverage.ts

/**
 * How completely a binary observed one egress class.
 * Ordered weakest-first; `weakestCoverage` relies on this order.
 */
export const GRANULARITIES = ["none", "per-run", "per-call"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The egress-BEARING source types. Marker classes carry no coverage claim. */
export const COVERAGE_CLASSES = ["model", "peer", "session", "sync", "task"] as const;
export type CoverageClass = (typeof COVERAGE_CLASSES)[number];

export type CoverageVector = Readonly<Record<CoverageClass, Granularity>>;

/**
 * What THIS binary is built to observe. Phase 1 adds no coverage — it only makes the existing
 * claim honest — so only `task` is non-`none`. Later phases raise `sync`, `model`, `peer`,
 * `session`; raising an entry without landing its appender is the exact defect this vector exists
 * to prevent.
 */
export const THIS_BINARY_COVERAGE: CoverageVector = {
  task: "per-call",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/**
 * Claims nothing about any class. Used as the contribution of an UNPARSEABLE boot marker, so the
 * weakest-merge drives the whole window to `none` (→ `indeterminate`) rather than letting a
 * sibling marker's richer claim stand unchallenged.
 */
export const ALL_NONE_COVERAGE: CoverageVector = {
  task: "none",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/** Stable, key-sorted serialization. Stored in the HASHED `source_id`, so it must be canonical. */
export function serializeCoverage(v: CoverageVector): string {
  return COVERAGE_CLASSES.map((c) => `${c}=${v[c]}`).join(";");
}

function isGranularity(s: string): s is Granularity {
  return (GRANULARITIES as readonly string[]).includes(s);
}

/** Parse; returns null (never a guess) if any class is missing or any value is unrecognized. */
export function parseCoverage(s: string): CoverageVector | null {
  const found = new Map<string, string>();
  for (const part of s.split(";")) {
    const [k, val] = part.split("=");
    if (k !== undefined && val !== undefined) found.set(k, val);
  }
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    const val = found.get(c);
    if (val === undefined || !isGranularity(val)) return null;
    out[c] = val;
  }
  return out as CoverageVector;
}

/**
 * The weakest granularity per class across every binary that wrote into a window.
 *
 * An EMPTY list yields all-`none`: with no boot marker there is no evidence of any coverage, and
 * the correct response is to claim nothing.
 */
export function weakestCoverage(vs: readonly CoverageVector[]): CoverageVector {
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    let weakest: Granularity = "none";
    if (vs.length > 0) {
      weakest = vs.reduce<Granularity>((acc, v) => {
        return GRANULARITIES.indexOf(v[c]) < GRANULARITIES.indexOf(acc) ? v[c] : acc;
      }, "per-call");
    }
    out[c] = weakest;
  }
  return out as CoverageVector;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/egress/egress-coverage.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing test for the boot marker**

Create `packages/gateway/src/egress/egress-boot-marker.test.ts`. Reuse the DB fixture style already used by `egress-verify.test.ts`:

```ts
// packages/gateway/src/egress/egress-boot-marker.test.ts
import { describe, expect, test } from "bun:test";
import { appendBootMarker, coverageForWindow } from "./egress-boot-marker.ts";
import { THIS_BINARY_COVERAGE } from "./egress-coverage.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { listEgress, verifyEgressChain } from "./egress-verify.ts";

describe("boot marker", () => {
  test("appends one marker row carrying the serialized vector in the hashed source_id", () => {
    const db = makeTestDb(); // reuse the existing fixture helper
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceType).toBe("boot");
    expect(rows[0]?.method).toBe("egress.boot");
    expect(rows[0]?.sourceId).toBe("model=none;peer=none;session=none;sync=none;task=per-call");
    // The marker participates in the chain like any other row.
    expect(verifyEgressChain(db).ok).toBe(true);
    db.close();
  });

  test("coverageForWindow with NO covering marker claims nothing", () => {
    const db = makeTestDb();
    expect(coverageForWindow(db, { until: 500 })).toEqual({
      task: "none",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
    db.close();
  });

  test("coverageForWindow uses markers at or before the window, weakest wins", () => {
    const db = makeTestDb();
    appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
    appendBootMarker(
      db,
      { task: "per-call", session: "per-call", sync: "per-run", model: "per-call", peer: "per-call" },
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
    db.close();
  });

  test("an unparseable marker forces all-none — it must not be silently skipped", () => {
    const db = makeTestDb();
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
      { task: "per-call", session: "per-call", sync: "per-run", model: "per-call", peer: "per-call" },
      2_000,
    );
    expect(coverageForWindow(db, { since: 500, until: 3_000 })).toEqual({
      task: "none",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
    db.close();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-boot-marker.test.ts`
Expected: FAIL — `Cannot find module './egress-boot-marker.ts'`

- [ ] **Step 7: Write minimal implementation**

Create `packages/gateway/src/egress/egress-boot-marker.ts`:

```ts
// packages/gateway/src/egress/egress-boot-marker.ts
import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import {
  ALL_NONE_COVERAGE,
  type CoverageVector,
  parseCoverage,
  serializeCoverage,
  weakestCoverage,
} from "./egress-coverage.ts";
import { listEgress } from "./egress-verify.ts";

/** `method` for every boot marker row. Stable — `coverageForWindow` selects on it. */
export const BOOT_MARKER_METHOD = "egress.boot";

/**
 * Append this process's boot marker.
 *
 * Without it, a build that never wires a sink produces an empty ledger and every window reads as a
 * clean `0` — a false zero indistinguishable from real silence. The marker is what makes that case
 * report `indeterminate` instead.
 *
 * The vector goes in `source_id` because `source_id` IS an input to `computeEgressRowHash`; a
 * coverage claim that could be edited without breaking the chain would be worthless.
 */
export function appendBootMarker(db: Database, coverage: CoverageVector, now: number): void {
  appendEgressEntry(db, {
    timestamp: now,
    sourceType: "boot",
    sourceId: serializeCoverage(coverage),
    destination: "local",
    method: BOOT_MARKER_METHOD,
    payloadSummary: "{}",
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}

/**
 * The coverage that can be claimed for a window: the weakest granularity per class across every
 * boot marker at or before the window's end.
 *
 * Markers strictly AFTER the window are ignored — a binary that started later cannot vouch for what
 * was observed earlier. No covering marker yields all-`none`, i.e. claim nothing.
 *
 * An UNPARSEABLE marker contributes an all-`none` vector rather than being skipped. Skipping it
 * would let a sibling marker's richer claim stand, overstating coverage; contributing all-`none`
 * drives the weakest-merge to `none` everywhere, so the window reports `indeterminate`. This is the
 * "indeterminate, never a false zero" rule — NOT a throw, because one unreadable row must not take
 * `nimbus egress` down. (Deliberate tampering is already caught elsewhere: `source_id` is hashed,
 * so an edited marker breaks `verifyEgressChain`. The case handled here is a marker written by a
 * NEWER binary using a class or granularity this one does not know.)
 */
export function coverageForWindow(
  db: Database,
  opts: { since?: number | undefined; until?: number | undefined },
): CoverageVector {
  const rows = listEgress(db, {});
  const vectors: CoverageVector[] = [];
  for (const r of rows) {
    if (r.method !== BOOT_MARKER_METHOD) continue;
    if (opts.until !== undefined && r.timestamp > opts.until) continue;
    const v = r.sourceId === null ? null : parseCoverage(r.sourceId);
    // Unreadable marker → claim nothing for every class (see doc comment).
    vectors.push(v ?? ALL_NONE_COVERAGE);
  }
  return weakestCoverage(vectors);
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test packages/gateway/src/egress/ && bun run typecheck`
Expected: all PASS, typecheck exit 0.

- [ ] **Step 9: Wire the marker into gateway startup**

**Without this step the feature is inert in production:** no boot marker is ever written, so every
window has no covering marker and `prove` reports `indeterminate` forever. The tests above all pass
regardless — they append markers themselves — so nothing else in this plan catches the omission.

In `packages/gateway/src/platform/assemble.ts`, add to the imports:

```ts
import { appendBootMarker } from "../egress/egress-boot-marker.ts";
import { THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
```

and immediately after line 1702, `const db = openGatewaySqlite(paths.dataDir, sidecarStops);`:

```ts
  // I29: record what THIS binary is built to observe, before anything can emit egress. Without a
  // covering marker `proveWindow` reports `indeterminate` rather than a false zero, so this append
  // is what makes a clean window provable. Safe here: openGatewaySqlite ran LocalIndex.ensureSchema
  // (assemble.ts:251), so egress_ledger (V44) exists.
  appendBootMarker(db, THIS_BINARY_COVERAGE, Date.now());
```

Placement matters in two directions: it must be **after** `openGatewaySqlite` (the table must exist,
or `appendEgressEntry` throws `no such table`) and **before** any subsystem that could emit egress
is constructed, so no row can precede the marker that describes it.

- [ ] **Step 10: Verify the marker actually lands at startup**

Run the gateway against a scratch data dir and inspect the ledger:

```bash
NIMBUS_DATA_DIR="$(mktemp -d)" bun run packages/gateway/src/index.ts --help >/dev/null 2>&1 || true
```

Then in a `bun repl` or a scratch script, open that dir's `nimbus.db` and confirm exactly one row
with `source_type='boot'` and a `source_id` of `model=none;peer=none;session=none;sync=none;task=per-call`.
**If the gateway entry point does not assemble on `--help`, start it normally and stop it instead** —
the point is to prove the append happens on a real boot, not in a test fixture. A passing unit suite
is not evidence for this step.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/src/egress/egress-coverage.ts packages/gateway/src/egress/egress-coverage.test.ts packages/gateway/src/egress/egress-boot-marker.ts packages/gateway/src/egress/egress-boot-marker.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(egress): per-source coverage vector and per-process boot marker"
```

---

### Task 4: `proveWindow` reports the vector, and `indeterminate` without a marker

**Files:**

- Modify: `packages/gateway/src/egress/egress-verify.ts` (`EgressCompleteness` ~line 181, `proveWindow` ~line 199)
- Test: `packages/gateway/src/egress/egress-verify.test.ts`

**Interfaces:**

- Consumes: `coverageForWindow` (Task 3), `isMarkerSourceType` (Task 1).
- Produces: `type EgressCompleteness = { coverage: CoverageVector; outboundEgressEvents: number; indeterminate: boolean }`.

**Breaking change, intentional:** `EgressCompleteness.tier` is removed. Its only consumers are `proveWindow`, the `egress.proveWindow` IPC handler, and `prove.ts` (Task 6). Grep before editing: `grep -rn "completeness" packages/gateway/src packages/cli/src --include=*.ts | grep -v test`.

- [ ] **Step 1: Write the failing test**

```ts
test("a window with no covering boot marker is indeterminate, never a clean zero", () => {
  const db = makeTestDb();
  const out = proveWindow(db, {});
  expect(out.completeness.outboundEgressEvents).toBe(0);
  // 0 events, intact chain — and STILL not provable, because nothing recorded what was observed.
  expect(out.completeness.indeterminate).toBe(true);
  expect(out.completeness.coverage.task).toBe("none");
  db.close();
});

test("with a boot marker, a clean window is determinate and reports its coverage", () => {
  const db = makeTestDb();
  appendBootMarker(db, THIS_BINARY_COVERAGE, 1_000);
  const out = proveWindow(db, {});
  expect(out.completeness.indeterminate).toBe(false);
  expect(out.completeness.coverage.task).toBe("per-call");
  expect(out.completeness.coverage.model).toBe("none");
  expect(out.completeness.outboundEgressEvents).toBe(0); // the marker itself is not counted
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-verify.test.ts -t "boot marker"`
Expected: FAIL — `completeness.indeterminate` is `undefined`

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/egress/egress-verify.ts`, replace the `EgressCompleteness` type:

```ts
export type EgressCompleteness = { tier: "authorized-actions"; outboundEgressEvents: number };
```

with:

```ts
import type { CoverageVector } from "./egress-coverage.ts";
import { coverageForWindow } from "./egress-boot-marker.ts";

export type EgressCompleteness = {
  /** What the binaries writing into this window were built to observe (§3.6 of the annex). */
  readonly coverage: CoverageVector;
  readonly outboundEgressEvents: number;
  /**
   * True when the count cannot be relied on: no boot marker covers the window, so there is no
   * evidence any egress class was being observed. NEVER report a bare zero in this state.
   */
  readonly indeterminate: boolean;
};
```

and in `proveWindow`, replace the `completeness` construction:

```ts
  const coverage = coverageForWindow(db, opts);
  const indeterminate = COVERAGE_CLASSES.every((c) => coverage[c] === "none");
  return {
    rows,
    completeness: { coverage, outboundEgressEvents: outbound, indeterminate },
    verify: verifyEgressChain(db),
  };
```

adding `COVERAGE_CLASSES` to the `egress-coverage.ts` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/egress/ && bun run typecheck`
Expected: PASS. Typecheck will flag the `egress.proveWindow` IPC handler and `prove.ts` if they read `.tier` — fix the IPC handler now (it forwards the object; no change needed unless it destructures `tier`), and leave `prove.ts` to Task 6 **only if** typecheck still passes; otherwise fix it here.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/egress-verify.ts packages/gateway/src/egress/egress-verify.test.ts
git commit -m "feat(egress): proveWindow reports a coverage vector and flags indeterminate windows"
```

---

### Task 5: Make the executor's egress sink required

**Files:**

- Modify: `packages/gateway/src/egress/egress-ledger.ts` (add `NULL_EGRESS_SINK`)
- Modify: `packages/gateway/src/engine/executor.ts:224` (the `egressSink?:` parameter)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (6 sites: lines ~314, 507, 703, 1020, 1206, 1324)
- Modify: `packages/gateway/src/ipc/server/vault-dispatch.ts:95`
- Test: `packages/gateway/src/security-invariants.test.ts` — import `egressHead` and `makeEgressSink` for the NULL_EGRESS_SINK test

**Interfaces:**

- Consumes: `EgressSink` (`egress-ledger.ts`).
- Produces: `const NULL_EGRESS_SINK: EgressSink`.

**Context — verified site census.** 11 `new ToolExecutor(` sites exist. **4 already wire a real sink**: `engine/run-ask.ts:178`, `ipc/server/dispatchers.ts:892`, `platform/assemble.ts:1416`, and `chatops/chatops-boot.ts:223` (via `deps.egressSink`, supplied at `assemble.ts:1643`). **7 omit it** — the gate-only stubs that pair with a rejecting dispatcher and perform local mutations, not egress. Those 7 get `NULL_EGRESS_SINK`.

- [ ] **Step 1: Write the failing test**

Append to the `I29` describe block in `packages/gateway/src/security-invariants.test.ts`:

```ts
test("I29: the executor's egress sink is a REQUIRED constructor parameter", () => {
  // A required parameter makes an unwired sink a compile error rather than a silent no-op. The
  // named NULL_EGRESS_SINK keeps the "this executor performs no egress" decision on the record.
  const src = readFileSync(
    join(import.meta.dir, "engine", "executor.ts"),
    "utf8",
  );
  expect(src).toContain("private readonly egressSink: EgressSink,");
  expect(src).not.toContain("private readonly egressSink?: EgressSink,");
});

test("I29: NULL_EGRESS_SINK leaves a real ledger untouched, where makeEgressSink writes", () => {
  // Asserts REAL behaviour against a real ledger — not that a spy counted a call. The two sinks
  // are handed the identical entry so the only variable is which sink received it.
  const entry = {
    timestamp: 1,
    sourceType: "task",
    sourceId: null,
    destination: "d",
    method: "m",
    payloadSummary: "{}",
    hitlStatus: "not_required",
    resultStatus: "authorized",
  } as const;

  const db = makeTestDb(); // same fixture helper the egress suite uses
  NULL_EGRESS_SINK.append(entry);
  expect(egressHead(db).count).toBe(0);

  makeEgressSink(db).append(entry);
  expect(egressHead(db).count).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I29"`
Expected: FAIL — `NULL_EGRESS_SINK` is not exported, and the source still reads `egressSink?:`

- [ ] **Step 3: Add `NULL_EGRESS_SINK`**

In `packages/gateway/src/egress/egress-ledger.ts`, after `makeEgressSink`:

```ts
/**
 * The explicit "this executor performs no egress" sink.
 *
 * Gate-only executors (vault, teamvault, reindex, data, auto-update, connector.auth, egress.prune)
 * perform LOCAL mutations and pair with a rejecting dispatcher, so they must not record egress.
 * A NAMED null states that decision; an omitted optional parameter is indistinguishable from
 * forgetting to wire one.
 */
export const NULL_EGRESS_SINK: EgressSink = {
  append(): void {
    /* intentionally empty — see doc comment */
  },
};
```

- [ ] **Step 4: Make the parameter required**

In `packages/gateway/src/engine/executor.ts`, change:

```ts
    private readonly egressSink?: EgressSink,
```

to:

```ts
    private readonly egressSink: EgressSink,
```

Then in `gate()`, simplify the guard — the sink is always present now:

```ts
    if (this.egressSink !== undefined) {
      this.egressSink.append(
```

becomes:

```ts
    this.egressSink.append(
```

(dedent the call and drop the closing `}` of that `if`).

**Note the ordering problem:** `egressSink` currently follows the optional `delegation?` parameter. A required parameter cannot follow an optional one. Change `delegation` to `delegation: ExecutorDelegationDep | undefined` (still explicitly passable as `undefined`) so both are positionally required. Every one of the 11 sites already passes something in that position or omits both — the 7 stub sites must now pass `undefined, NULL_EGRESS_SINK`.

- [ ] **Step 5: Update the 7 gate-only sites**

Add to each file's imports:

```ts
import { NULL_EGRESS_SINK } from "../../egress/egress-ledger.ts"; // adjust depth per file
```

At each of `dispatchers.ts` ~314, 507, 703, 1020, 1206, 1324 and `vault-dispatch.ts:95`, append the two arguments so the call reads `new ToolExecutor(consent, audit, dispatcher, undefined, NULL_EGRESS_SINK)`. Add this comment above each:

```ts
    // I29: gate-only executor — local mutation, no connector dispatch, so no egress to ledger.
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun run typecheck && bun test packages/gateway/src/security-invariants.test.ts && bun test packages/gateway/src/engine/`
Expected: all PASS, typecheck exit 0. Typecheck is the real gate here — it finds every construction site you missed, including in test files.

- [ ] **Step 7: Fix test-file construction sites**

Run: `bun test packages/gateway/src 2>&1 | tail -20`
Any test constructing `ToolExecutor` with 3–4 args now fails to compile. Pass `undefined, NULL_EGRESS_SINK` for gate-only tests, or a recording fake where the test asserts on ledger writes.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/egress/egress-ledger.ts packages/gateway/src/engine/executor.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/server/vault-dispatch.ts packages/gateway/src/security-invariants.test.ts
git commit -m "feat(egress): require the executor's egress sink, with a named NULL_EGRESS_SINK"
```

---

### Task 6: Kill the false `0 ✓`

**Files:**

- Modify: `packages/cli/src/commands/prove.ts` (`ProveResult` ~line 11, `runEgressReport` ~line 121, `runProve` ~line 147)
- Create: `packages/cli/src/commands/prove-format.test.ts` — a new pure-renderer test file, matching the existing `share-replay-format.test.ts` convention of testing a formatter separately from its command
- Modify: `packages/cli/src/commands/prove.test.ts` — this file already exists and exercises the command; expect it to need updating in Step 6

**Interfaces:**

- Consumes: the `EgressCompleteness` shape from Task 4.
- Produces: a `formatProveResult` pure renderer, so the output is testable without a gateway.

**The defect:** `runProve` prints `outbound egress events during this query: 0 ✓` from a head-count delta alone (`prove.ts:147`) — no chain verify, no coverage check. It says "nothing left" when it means "nothing I was built to watch left, and I did not check whether I was watching anything".

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/prove-format.test.ts`:

```ts
// packages/cli/src/commands/prove-format.test.ts
import { describe, expect, test } from "bun:test";
import { formatProveResult } from "./prove.ts";

const COVERED = {
  coverage: { task: "per-call", session: "none", sync: "none", model: "none", peer: "none" },
  outboundEgressEvents: 0,
  indeterminate: false,
} as const;

describe("formatProveResult", () => {
  test("a zero window never prints a bare 0 — it names what was observed", () => {
    const out = formatProveResult({ delta: 0, completeness: COVERED, chainOk: true });
    // Assert the whole first line, not just that a "0" appears somewhere: the defect being fixed
    // is a count printed WITHOUT its scope, so the scope must be on the same line as the number.
    expect(out.split("\n")[0]).toBe(
      "outbound egress events during this query: 0 (scope: gated connector actions)",
    );
    expect(out).toContain("not observed: model, peer, session, sync");
  });

  test("an indeterminate window reports indeterminate, never zero", () => {
    const out = formatProveResult({
      delta: 0,
      completeness: { ...COVERED, indeterminate: true },
      chainOk: true,
    });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });

  test("a broken chain reports indeterminate even when the count is zero", () => {
    const out = formatProveResult({ delta: 0, completeness: COVERED, chainOk: false });
    expect(out).toContain("indeterminate");
    expect(out).not.toContain("0 ✓");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/prove-format.test.ts`
Expected: FAIL — `formatProveResult` is not exported from `./prove.ts`

- [ ] **Step 3: Write minimal implementation**

Add to `packages/cli/src/commands/prove.ts`:

```ts
export interface ProveCompleteness {
  readonly coverage: Readonly<Record<string, string>>;
  readonly outboundEgressEvents: number;
  readonly indeterminate: boolean;
}

/** Pure renderer — the whole point is that this is testable without a gateway. */
export function formatProveResult(input: {
  readonly delta: number;
  readonly completeness: ProveCompleteness;
  readonly chainOk: boolean;
}): string {
  if (!input.chainOk || input.completeness.indeterminate) {
    const why = !input.chainOk
      ? "the egress chain is unverifiable"
      : "no boot marker covers this window, so nothing recorded what was being observed";
    return `indeterminate — cannot prove zero egress: ${why}`;
  }
  const observed = Object.entries(input.completeness.coverage)
    .filter(([, g]) => g !== "none")
    .map(([c]) => c)
    .sort();
  const unobserved = Object.entries(input.completeness.coverage)
    .filter(([, g]) => g === "none")
    .map(([c]) => c)
    .sort();
  const scope = observed.includes("task") ? "gated connector actions" : observed.join(", ");
  const lines = [
    `outbound egress events during this query: ${String(input.delta)} (scope: ${scope})`,
  ];
  if (unobserved.length > 0) {
    lines.push(`  not observed: ${unobserved.join(", ")}`);
  }
  return lines.join("\n");
}
```

Then replace the `runProve` branch at `prove.ts:145-150`:

```ts
    const delta = after.count - before.count;
    if (delta === 0) {
      console.log("outbound egress events during this query: 0 ✓");
    } else {
```

with a call that always consults `egress.proveWindow` — a delta alone can no longer justify a claim:

```ts
    const delta = after.count - before.count;
    const window = await client.call<ProveResult>("egress.proveWindow", {});
    console.log(
      formatProveResult({
        delta,
        completeness: window.completeness,
        chainOk: window.verify.ok,
      }),
    );
    if (window.verify.ok === false || window.completeness.indeterminate) {
      process.exitCode = 1;
    }
    if (delta !== 0) {
```

- [ ] **Step 4: Update `runEgressReport`'s tier line**

Replace `prove.ts:121-123`:

```ts
  console.log(
    `outbound egress events: ${String(out.completeness.outboundEgressEvents)} (tier: ${out.completeness.tier})`,
  );
```

with:

```ts
  console.log(
    formatProveResult({
      delta: out.completeness.outboundEgressEvents,
      completeness: out.completeness,
      chainOk: out.verify.ok,
    }),
  );
```

and update the `ProveResult` interface at line 11 to `completeness: ProveCompleteness`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/cli/src/commands/prove-format.test.ts && bun run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 6: Run the existing prove/egress CLI tests**

Run: `bun test packages/cli/src/commands/ 2>&1 | tail -10`
Expected: PASS. Any e2e asserting the literal string `0 ✓` is asserting the defect — update it and say so in the commit body.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/prove.ts packages/cli/src/commands/prove-format.test.ts
git commit -F - <<'EOF'
fix(cli): nimbus prove no longer prints a bare "0 ✓"

The zero branch printed a clean proof from a head-count delta alone,
with no chain verify and no coverage check — claiming "nothing left the
machine" when it meant "nothing I was built to watch left, and I did not
check whether I was watching anything".

Every report now names its scope and lists the unobserved classes, and a
window with no covering boot marker or a broken chain reports
indeterminate and exits 1.
EOF
```

---

### Task 7: The invariant triple — docs + enforcement test

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (I29 section, ~line 531-546)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (the D22 comment asserting totality)
- Modify: `CLAUDE.md` and `GEMINI.md` (the I29 bullet — **both**, they mirror each other)
- Modify: `.claude/commands/nimbus-egress.md`
- Modify: `docs/CHANGELOG.md`
- Test: `packages/gateway/src/security-invariants.test.ts` — import `egressHead` and `makeEgressSink` for the NULL_EGRESS_SINK test

**This is the honesty task and the reason Phase 1 exists.** D22's own source comment claims *"there is no escape hatch, no 'approved wrapper' carve-out … Any future shortcut or custom-wrapper bypass therefore fails this preflight static check immediately."* That is false: D22 is a regex over the literal string `connectors.dispatch`, and `connectors/connector-write-dispatch.ts:21` is a dispatcher decorator calling `inner.dispatch(action)` that passes it. The comment must describe the mechanism, not the intent.

- [ ] **Step 1: Write the failing test**

```ts
test("I29: the D22 comment does not claim totality it cannot enforce", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "..", "..", "scripts", "structure-audit", "check-nimbus-invariants.ts"),
    "utf8",
  );
  // D22 matches a literal string; it cannot see `inner.dispatch(action)`. Claiming otherwise is
  // the defect Phase 1 fixes — a label that leads its mechanism.
  expect(src).not.toContain("no escape hatch");
  expect(src).toContain("matches the literal string");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "D22 comment"`
Expected: FAIL — the file still contains "no escape hatch"

- [ ] **Step 3: Correct the D22 comment**

In `scripts/structure-audit/check-nimbus-invariants.ts`, replace the totality claim with:

```ts
/**
 * D22 — the egress chokepoint confinement.
 *
 * SCOPE, stated precisely because the previous comment overstated it: this rule matches the literal
 * string `connectors.dispatch` line by line. It CANNOT see a dispatcher decorator that calls
 * `inner.dispatch(action)` (see connectors/connector-write-dispatch.ts), a façade that re-exposes
 * execution under another name, or a raw `tool.execute()` on a lazy-mesh tool record. Those paths
 * are addressed by removing the capability (Phase 2 of the I29 security spec), not by this regex.
 *
 * What it does enforce: no NEW site may spell `connectors.dispatch` outside engine/executor.ts, and
 * `appendEgressEntry` stays inside egress/.
 */
```

- [ ] **Step 4: Rewrite the I29 section in `docs/SECURITY-INVARIANTS.md`**

Replace the **Statement** paragraph with one that scopes the claim to what holds, and add a **Known limits** block naming: the three bypass classes above; that coverage is `task`-only in this phase; and that the coverage vector, not prose, is the machine-readable claim. Keep the existing *Wired at* / *Anti-pattern* / *How to comply* structure. Add to *Wired at*:

- `packages/gateway/src/egress/egress-source-type.ts` — the frozen union (a value written today is permanent in the data, and marker-exclusion depends on the set being closed).
- `packages/gateway/src/egress/egress-coverage.ts` + `egress-boot-marker.ts` — the per-process coverage claim.

- [ ] **Step 5: Update the mirrored I29 bullet in `CLAUDE.md` and `GEMINI.md`**

Both files carry the same bullet. Replace the "no wrapper/allowlist exemption — any custom-wrapper or shortcut bypass fails the preflight static check" clause, which is the same false claim, with: "D22 confines the literal `connectors.dispatch` to `executor.ts` and `appendEgressEntry` to `egress/*`; wrapper/façade/raw-execute paths are out of its reach and are addressed by capability removal."

- [ ] **Step 6: Update `.claude/commands/nimbus-egress.md`**

Fix the same overstatement in its **Static `D22`** paragraph, replace `tier: "authorized-actions"` with the coverage vector in the surfaces section, and note that `prove` never prints a bare `0 ✓`.

- [ ] **Step 7: Add the `docs/CHANGELOG.md` entry**

Under the unreleased heading, note: the prune-tombstone miscount fix (user-visible count change), the frozen union, the required sink, the coverage vector replacing the tier, and the `prove` output change.

- [ ] **Step 8: Run the full gate set**

```bash
bun run typecheck
bun run audit:invariants
bun test packages/gateway/src/egress/ packages/gateway/src/security-invariants.test.ts packages/cli/src/commands/
bunx biome check --error-on-warnings --config-path=. $(git diff --name-only main...HEAD | grep -E '\.ts$')
```

Expected: all exit 0. **Do not use `bun run preflight:fast` from inside `.claude/worktrees/` — biome resolves the outer repo config, ignores everything, and exits 1 on "0 files processed".** Run the full `bun run preflight` from a checkout outside the worktree before opening the PR.

- [ ] **Step 9: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md .claude/commands/nimbus-egress.md docs/CHANGELOG.md scripts/structure-audit/check-nimbus-invariants.ts packages/gateway/src/security-invariants.test.ts
git commit -F - <<'EOF'
docs(security): scope the I29 claim to what D22 actually enforces

D22 matches the literal string connectors.dispatch, so it cannot see a
dispatcher decorator calling inner.dispatch(action), a session façade,
or a raw tool.execute() on a mesh tool record. Its own comment claimed
there was no escape hatch. The comment, the I29 section, the mirrored
CLAUDE.md/GEMINI.md bullets and the nimbus-egress skill now describe the
mechanism rather than the intent.

Phase 1 adds no coverage; it makes the existing claim true.
EOF
```

---

## Self-Review

**Spec coverage.** The spec of record's Phase 1 lists five items: freeze the taxonomy (Task 1), make the sink required (Task 5), replace the scalar tier (Tasks 3–4), correct the documentation including D22's comment (Task 7), kill the false `0 ✓` (Task 6). The annex adds the boot marker (Task 3), the marker-exclusion miscount fix (Task 2), and the eight-member union amendment (Task 1). All covered.

**Deliberately deferred, not missed:** the degraded-marker *appender* (there is no degrade path until a Phase 3+ call site can fail an append; the union member exists so the appender needs no chain-breaking change), and `isLoopbackDestination` (nothing writes a `model` row until Phase 4).

**Type consistency.** `EgressSourceType` (Task 1) is consumed by `EgressEntry.sourceType`, `MARKER_SOURCE_TYPES` and `isMarkerSourceType` (Task 2). `CoverageVector`/`CoverageClass`/`Granularity` (Task 3) are consumed by `coverageForWindow` (Task 3), `EgressCompleteness` (Task 4) and `ProveCompleteness` (Task 6). `NULL_EGRESS_SINK` (Task 5) satisfies the `EgressSink` interface already defined at `egress-ledger.ts:87`. `BOOT_MARKER_METHOD` is defined and consumed in Task 3 only. No name appears in two spellings.

**Ordering hazard flagged in Task 5:** making `egressSink` required while `delegation?` precedes it is a TypeScript error — the plan changes `delegation` to an explicit `| undefined` rather than leaving the engineer to discover it.

---

## Review Disposition

Against [`2026-08-03-i29-phase1-make-the-claim-true-review.md`](./2026-08-03-i29-phase1-make-the-claim-true-review.md).

| # | Finding | Disposition |
|---|---|---|
| 1.1 | No task wires `appendBootMarker` into `assemble.ts`, so the marker never lands in production | **Fixed — the most serious finding.** Task 3 Steps 9–11 added. See below. |
| 1.2 | Task 1's Files header names `egress-ledger.ts`; `EgressEntry` lives in `egress-record.ts` | **Fixed.** Header corrected and the muddled Step 5 wording rewritten. |
| 2.1 | Narrow `EgressRowHashInput.sourceType` to the union | **Rejected**, with the reasoning recorded inline in Task 1 Step 5. |
| 2.2 | An unparseable boot marker is silently skipped | **Fixed**, via all-`none` contribution rather than the suggested throw. |

### On 1.1 — why this one mattered most

The gap was real and the whole feature hinged on it: with no startup append, every window has no
covering marker and `prove` reports `indeterminate` forever — a feature that is worse than not
shipping it. What makes it dangerous is that **every test in Task 3 passes anyway**, because each
one appends its own marker. Unit tests could not have caught this.

The fix therefore includes Step 10, which verifies against a *real gateway boot* rather than a
fixture. The reviewer's suggested insertion point (`assemble.ts:1702`) was verified correct:
`openGatewaySqlite` calls `LocalIndex.ensureSchema` at line 251, so `egress_ledger` (V44) exists by
the time it returns. The plan adds the second ordering constraint the review did not mention — the
append must also precede construction of anything that can emit egress, so no row predates the
marker describing it.

### On 2.1 — why the hash boundary keeps `string`

`computeEgressRowHash` is called by `verifyEgressChain` (`egress-verify.ts:125`) with values read
back out of SQLite. Narrowing its input to the union would force a cast there asserting something
untrue about DB contents: a ledger can legitimately hold a `source_type` written by a *newer*
gateway. A verifier that would not hash an unrecognized value would report a false chain break —
precisely the false-negative class this work exists to remove.

The union belongs on the **write** path (`EgressEntry`), which Task 1 narrows. It must not constrain
the **read** path. Type safety at the hash boundary would be safety against the wrong thing.

### On 2.2 — accepted, but not as a throw

The concern is right and the hole is specific: with two markers where one is unreadable, skipping it
lets the *other*, richer marker vouch for the window — overstating coverage. Contributing an
all-`none` vector instead drives the weakest-merge to `none` everywhere, so the window reports
`indeterminate`.

The suggested alternative — throw an integrity exception — is rejected because one unreadable row
would take `nimbus egress` down entirely, and this codebase's established rule is "indeterminate,
never a false zero", not "fail hard". Worth noting the review's tampering premise is already covered
elsewhere: `source_id` is hashed, so an *edited* marker breaks `verifyEgressChain` and the window is
indeterminate on that path. The case this fix actually addresses is a forward-compatibility one — a
marker from a newer binary using a class or granularity this one does not know.
