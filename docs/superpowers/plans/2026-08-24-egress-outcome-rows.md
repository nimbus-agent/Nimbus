# Outcome Rows on the Egress Ledger (U3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record how a targeted fetch ended, so the ledger stops reporting every fetch as `authorized` regardless of what came back.

**Architecture:** A second ledger row per completed targeted fetch, written after the connector call. It is a MARKER (`source_type: "outcome"`), so it never counts as outbound egress — it is bookkeeping about a call already counted. It names the row it describes by that row's `row_hash`, carried in `source_id`, which means `appendEgressEntry` must start returning the hash it already computes.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:test`, Biome, markdownlint-cli2.

**Spec:** [`2026-08-24-egress-outcome-rows-design.md`](../specs/2026-08-24-egress-outcome-rows-design.md)
**Review + answers:** [`2026-08-24-egress-outcome-rows-design-review.md`](../specs/2026-08-24-egress-outcome-rows-design-review.md)

**Consumer:** U3b in `nimbus-web-clipper` renders the outcome column. Not in this plan.

## Global Constraints

- **No `any`.** `unknown` for external data, narrowed by a guard. TypeScript strict is non-negotiable.
- **Never commit on `main`.** This work lands on `dev/asafgolombek/egress-outcome` in `.claude/worktrees/egress-outcome`. Verify with `git rev-parse --abbrev-ref HEAD` before the first commit.
- **Biome false-fails in worktrees.** `bun run lint` reports "0 files processed" and exits 1 inside `.claude/worktrees/`. Validate with `bunx biome check packages scripts` instead.
- **`docs/**` is markdownlint-gated.** Validate with `bun run lint:markdown` before committing.
- **`appendEgressEntry` is confined to `egress/*` by the static D22 rule.** Never import it from `sync/`, `ipc/` or anywhere else — the write site receives an injected closure, as `targetedFetch` already does. The rule is a SYMBOL regex (`/appendEgressEntry/`, `scripts/structure-audit/check-nimbus-invariants.ts`), not a path-import rule, so Task 4's `import type { FetchOutcomeStatus } from "../egress/outcome-egress.ts"` is fine — it names no confined symbol, and a type-only import emits nothing at runtime regardless.
- **`() => undefined`, never a bare `() => {}`, for every append seam stub.** The seams return `undefined` rather than `void` on purpose; `targeted-fetch.test.ts` already defaults them as `overrides.appendEgress ?? (() => undefined)`, and new stubs follow that.
- **The outcome row must never count as outbound.** It joins `MARKER_SOURCE_TYPES`. `COVERAGE_CLASSES` is NOT touched, and the existing `I29: COVERAGE_CLASSES is exactly the non-marker source types` test must pass unchanged. If it fails, the member went in the wrong list.
- **The authorising append stays fail-closed; the outcome append swallows and warns.** By the time the outcome runs the request has left the machine — propagating would turn a successful fetch into a 500 and make the caller retry, causing MORE egress than the failure it reports. Swallowing must never be silent.
- **The append seams stay synchronous.** They are typed to return `undefined` (not `void`) so an `async` implementation is a compile error: an async rejection would surface after `targetedFetch` had moved past the call, breaking fail-closed. Widening a return type must preserve that — return a plain object, never a promise.
- **Honesty guardrail (`docs/launch-messaging.md`).** The egress ledger records the agent's dispatched actions at the I29 executor chokepoint, never raw network traffic.
- **Commit messages are discarded on merge.** The PR title and description become the squash commit.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/egress/egress-ledger.ts` (modify) | `appendEgressEntry` returns the `row_hash` it already computes. |
| `packages/gateway/src/egress/egress-source-type.ts` (modify) | `outcome` joins the frozen union AND `MARKER_SOURCE_TYPES`. |
| `packages/gateway/src/egress/outcome-egress.ts` (create) | The outcome appender. Pure of the fetch — takes a status, writes a row. |
| `packages/gateway/src/egress/sync-egress.ts` (modify) | `recordSyncEgress` passes the hash through. |
| `packages/gateway/src/sync/targeted-fetch.ts` (modify) | The seam types and the write site. |
| `packages/gateway/src/platform/assemble.ts` (modify) | Wires the new `appendOutcome` closure. |
| `docs/SECURITY-INVARIANTS.md` (modify) | The I29 note. |

---

## Task 1: `appendEgressEntry` returns the hash it already computes

**Files:**

- Modify: `packages/gateway/src/egress/egress-ledger.ts:54`
- Modify: `packages/gateway/src/egress/sync-egress.ts`
- Test: `packages/gateway/src/egress/egress-ledger.test.ts`, `packages/gateway/src/egress/sync-egress.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `appendEgressEntry(db, entry): { rowHash: string }` and `recordSyncEgress(db, args): { rowHash: string } | undefined`, both consumed by Tasks 3 and 4.

- [x] **Step 1: Write the failing tests**

Add to `packages/gateway/src/egress/egress-ledger.test.ts`:

```ts
test("returns the row hash it stored, so a later row can name this one", () => {
  const out = appendEgressEntry(db, e({ method: "a.x", timestamp: 1 }));
  const stored = listEgress(db, {})[0];
  expect(out.rowHash).toBe(stored?.rowHash);
  expect(out.rowHash).toMatch(/^[0-9a-f]{64}$/);
});
```

Add to `packages/gateway/src/egress/sync-egress.test.ts`:

```ts
test("returns the appended row's hash", () => {
  const out = recordSyncEgress(db, { destination: "github", method: "items.fetch", now: 1_000 });
  expect(out?.rowHash).toBe(listEgress(db, {})[0]?.rowHash);
});

test("returns undefined for a local-only destination, because no row was written", () => {
  // The caller uses this to decide whether an outcome row may be written at all:
  // with no authorising row there is nothing for one to name.
  expect(
    recordSyncEgress(db, { destination: "filesystem", method: "items.fetch", now: 1_000 }),
  ).toBeUndefined();
});
```

If `egress-ledger.test.ts` has no `e()` entry factory or `listEgress` import, copy both from `egress-verify.test.ts`, which has them.

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/egress/egress-ledger.test.ts packages/gateway/src/egress/sync-egress.test.ts`
Expected: FAIL — `out.rowHash` is undefined because both functions return `void`/`undefined`.

- [x] **Step 3: Implement**

In `egress-ledger.ts`, change the signature and add the return. The body is otherwise untouched — `rowHash` is already computed on line 56:

```ts
/**
 * Append one chained row, and return the hash it was stored under.
 *
 * The hash is returned because a later MARKER row may need to name this one —
 * see `outcome-egress.ts`. It is the value the chain already commits to, so a
 * correlation key built on it cannot drift from the row it points at.
 */
export function appendEgressEntry(db: Database, entry: EgressEntry): { rowHash: string } {
  // ... unchanged body ...
  return { rowHash };
}
```

In `sync-egress.ts`, thread it through. Keep the `undefined` arm and its reasoning:

```ts
export function recordSyncEgress(
  db: Database,
  args: { /* ... unchanged ... */ },
): { rowHash: string } | undefined {
  if (LOCAL_ONLY_SYNC_SERVICES.has(args.destination)) {
    return undefined;
  }
  return appendEgressEntry(db, {
    // ... unchanged entry ...
  });
}
```

The return type stays a union with `undefined` rather than becoming `void`, for the reason its doc comment already gives: `void`-return leniency would silently accept an `async` implementation at either seam this function is assigned to.

- [x] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/egress`
Expected: PASS. **Two existing assertions need updating, and this step's original claim that the change is "additive at both call sites" was wrong:** `sync-egress.test.ts`'s first test asserted `expect(out).toBeUndefined()`, which pinned the old return — change it to assert the hash, never delete it. And `assemble.ts`'s `appendEgress` closure is declared `=> undefined`, so it no longer typechecks: make it `(row) => void recordSyncEgress(...)` until Task 4 widens the seam to consume the value. `bun test` will NOT catch the second one — only `bun run typecheck` will.

- [x] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print dev/asafgolombek/egress-outcome
git add packages/gateway/src/egress/egress-ledger.ts packages/gateway/src/egress/sync-egress.ts packages/gateway/src/egress/egress-ledger.test.ts packages/gateway/src/egress/sync-egress.test.ts
git commit -m "refactor(egress): return the row hash the append already computed"
```

---

## Task 2: `outcome` joins the frozen union, as a marker

**Files:**

- Modify: `packages/gateway/src/egress/egress-source-type.ts`
- Modify: `packages/gateway/src/egress/egress-source-type.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `"outcome"` as an `EgressSourceType` and a member of `MARKER_SOURCE_TYPES`, consumed by Task 3.

- [x] **Step 1: Write the failing tests**

The existing test asserts the exact ten-member list, so it must be EDITED, not appended to. In `egress-source-type.test.ts`:

```ts
  test("is exactly these eleven members, in this order", () => {
    expect([...EGRESS_SOURCE_TYPES]).toEqual([
      "task",
      "prune",
      "session",
      "sync",
      "model",
      "peer",
      "mcp",
      "boot",
      "degraded",
      "http",
      "outcome",
    ]);
  });

  test("marker types are the four bookkeeping classes", () => {
    expect([...MARKER_SOURCE_TYPES].sort()).toEqual(["boot", "degraded", "outcome", "prune"]);
  });

  test("outcome is a MARKER, so it can never be counted as outbound egress", () => {
    // The whole argument for admitting an eleventh member: an outcome row is
    // bookkeeping about an outbound call the ledger has ALREADY counted.
    // Counting it again would double every targeted fetch.
    expect(isMarkerSourceType("outcome")).toBe(true);
  });
```

Keep the existing `isMarkerSourceType` test's egress-bearing and unknown cases exactly as they are.

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/egress/egress-source-type.test.ts`
Expected: FAIL — the union has ten members and `MARKER_SOURCE_TYPES` has three.

- [x] **Step 3: Implement**

In `egress-source-type.ts`, append the member and add its decision paragraph — the file's header requires one, and both `mcp` and `http` set the precedent:

```ts
 * `outcome` is the eleventh member, and the first added as a MARKER rather than an egress class.
 * It records how a targeted fetch ENDED: `targetedFetch` appends its egress row before calling the
 * connector (fail-closed — no row, no fetch), so `result_status` records the authorisation
 * decision and nothing in the ledger ever said what came back.
 *
 * Marker, not egress class, is the whole argument. The row is bookkeeping about an outbound call
 * this ledger has already counted; counting it again would double every targeted fetch and inflate
 * the exact number I29 exists to state honestly. Because it joins `MARKER_SOURCE_TYPES` it claims
 * no coverage granularity, `COVERAGE_CLASSES` is untouched, and the existing
 * "COVERAGE_CLASSES is exactly the non-marker source types" invariant proves the two lists stayed
 * in step.
 *
 * Reusing `sync` with a reserved `method` was rejected: `sync` is not a marker, so every outcome
 * row would count as outbound unless the counting predicate grew a method-level special case —
 * reintroducing by hand the miscount `MARKER_SOURCE_TYPES` exists to make structural.
 */
export const EGRESS_SOURCE_TYPES = [
  // ... the existing ten, unchanged and in order ...
  "outcome", // how a targeted fetch ended — a marker, never counted as egress
] as const;
```

and:

```ts
export const MARKER_SOURCE_TYPES: ReadonlySet<EgressSourceType> = new Set<EgressSourceType>([
  "prune",
  "boot",
  "degraded",
  "outcome",
]);
```

- [x] **Step 4: Run the tests, including the invariant that validates the choice**

Run: `bun test packages/gateway/src/egress/egress-source-type.test.ts`
Expected: PASS.

Run: `bun test packages/gateway/src/security-invariants.test.ts`
Expected: PASS, **with no edit to that file**. It asserts `COVERAGE_CLASSES` is exactly the non-marker source types; adding a marker keeps that identity. If it fails, `outcome` was added to `COVERAGE_CLASSES` or omitted from `MARKER_SOURCE_TYPES` — fix the code, never the assertion.

- [x] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/egress-source-type.ts packages/gateway/src/egress/egress-source-type.test.ts
git commit -m "feat(egress): admit outcome to the frozen union, as a marker"
```

---

## Task 3: The outcome appender

**Files:**

- Create: `packages/gateway/src/egress/outcome-egress.ts`
- Test: `packages/gateway/src/egress/outcome-egress.test.ts`

**Interfaces:**

- Consumes: Task 1's `appendEgressEntry`; Task 2's `"outcome"` source type.
- Produces: `recordFetchOutcomeEgress(db, args): undefined` where `args` is `{ destination: string; authorizingRowHash: string; status: FetchOutcomeStatus; itemId?: string; reason?: string; now: number }`, and `export type FetchOutcomeStatus = "indexed" | "not_found" | "rate_limited"`. Consumed by Task 4.

- [x] **Step 1: Write the failing test**

Create `packages/gateway/src/egress/outcome-egress.test.ts`, modelled on `sync-egress.test.ts` (copy its `beforeEach` DB setup and `listEgress` import):

```ts
describe("recordFetchOutcomeEgress", () => {
  test("writes one outcome marker naming the authorising row by hash", () => {
    const authorizing = appendEgressEntry(db, {
      timestamp: 1_000,
      sourceType: "sync",
      sourceId: "asafs-browser",
      destination: "github",
      method: "items.fetch",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });

    recordFetchOutcomeEgress(db, {
      destination: "github",
      authorizingRowHash: authorizing.rowHash,
      status: "indexed",
      itemId: "github:acme/web#482",
      now: 2_000,
    });

    const rows = listEgress(db, {});
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      sourceType: "outcome",
      // The correlation key. `source_id` carries an attested hash on prune
      // tombstones already, so a marker using it this way is established.
      sourceId: authorizing.rowHash,
      destination: "github",
      method: "items.fetch.outcome",
      hitlStatus: "not_required",
      // "was this allowed", not "did it work" — the fetch's success lives in
      // the summary, which is the field with three values.
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
    // The double-count guard. A fetch and its outcome are ONE outbound event.
    appendEgressEntry(db, {
      timestamp: 1_000,
      sourceType: "sync",
      sourceId: null,
      destination: "github",
      method: "items.fetch",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
    recordFetchOutcomeEgress(db, {
      destination: "github",
      authorizingRowHash: "b".repeat(64),
      status: "rate_limited",
      now: 2_000,
    });
    expect(countOutboundEgress(db, {})).toBe(1);
  });

  test("the chain still verifies across the pair", () => {
    const first = appendEgressEntry(db, {
      timestamp: 1_000,
      sourceType: "sync",
      sourceId: null,
      destination: "github",
      method: "items.fetch",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
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
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/egress/outcome-egress.test.ts`
Expected: FAIL — cannot resolve `./outcome-egress.ts`.

- [x] **Step 3: Implement**

Create `packages/gateway/src/egress/outcome-egress.ts`:

```ts
import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * How a targeted fetch ended, for the three arms reachable AFTER the egress append.
 *
 * The other three `TargetedFetchOutcome` arms — `unsupported_url`, `no_targeted_fetch`,
 * `not_configured` — are refused before any row is written, so no outcome row can describe them:
 * there is nothing for one to name.
 */
export type FetchOutcomeStatus = "indexed" | "not_found" | "rate_limited";

/**
 * Append ONE `outcome` marker describing a completed targeted fetch.
 *
 * A MARKER, never an egress class: this is bookkeeping about an outbound call the ledger has
 * already counted, and counting it again would double every targeted fetch.
 *
 * `authorizingRowHash` goes in `source_id` — the column prune tombstones already use to carry an
 * attested hash. It is the value the chain commits to, and every consumer of `GET /v1/egress`
 * receives it as `rowHash`, so the join needs no new field on the wire.
 *
 * Throws on append failure rather than swallowing. The swallow belongs at the call site, which has
 * the logger and the context to say what was lost — see `appendBootMarkerOrWarn` for the shape.
 */
export function recordFetchOutcomeEgress(
  db: Database,
  args: {
    readonly destination: string;
    readonly authorizingRowHash: string;
    readonly status: FetchOutcomeStatus;
    readonly itemId?: string | undefined;
    readonly reason?: string | undefined;
    readonly now: number;
  },
): undefined {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "outcome",
    sourceId: args.authorizingRowHash,
    destination: args.destination,
    method: "items.fetch.outcome",
    payloadSummary: redactEgressSummary({
      status: args.status,
      ...(args.itemId === undefined ? {} : { itemId: args.itemId }),
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    }),
    hitlStatus: "not_required",
    // "was this action allowed", not "did it succeed". The fetch's result lives in the summary.
    resultStatus: "authorized",
  });
  return undefined;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/egress`
Expected: PASS, including the double-count guard and the chain verification.

- [x] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/outcome-egress.ts packages/gateway/src/egress/outcome-egress.test.ts
git commit -m "feat(egress): an outcome marker that names the row it describes"
```

---

## Task 4: The write site

**Files:**

- Modify: `packages/gateway/src/sync/targeted-fetch.ts`
- Modify: `packages/gateway/src/platform/assemble.ts`
- Test: `packages/gateway/src/sync/targeted-fetch.test.ts`

**Interfaces:**

- Consumes: Task 1's `recordSyncEgress` return; Task 3's `recordFetchOutcomeEgress` and `FetchOutcomeStatus`.
- Produces: `TargetedFetchDeps.appendEgress` returning `{ rowHash: string } | undefined`, and a new `TargetedFetchDeps.appendOutcome`.

- [x] **Step 1: Write the failing tests**

Add to `packages/gateway/src/sync/targeted-fetch.test.ts`. The file's `depsWith` factory needs an `appendOutcome` override — add it to `DepsOverrides` and default it to `() => undefined` alongside `appendEgress`:

```ts
type OutcomeRow = {
  readonly destination: string;
  readonly authorizingRowHash: string;
  readonly status: string;
  readonly itemId?: string | undefined;
  readonly reason?: string | undefined;
};

test("an indexed fetch writes one outcome row naming the authorising row, with the item id", async () => {
  const outcomes: OutcomeRow[] = [];
  const deps = depsWith({
    hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
    appendEgress: () => ({ rowHash: "d".repeat(64) }),
    appendOutcome: (r) => {
      outcomes.push(r);
      return undefined;
    },
    syncableFor: (service) => ({
      serviceId: service,
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync() {
        throw new Error("not exercised");
      },
      fetchOne: async (): Promise<FetchOneResult> => ({
        status: "indexed",
        itemId: "github:acme/web#482",
      }),
    }),
  });

  await targetedFetch(deps, "https://github.com/acme/web/pull/482");

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    destination: "github",
    authorizingRowHash: "d".repeat(64),
    status: "indexed",
    itemId: "github:acme/web#482",
  });
});

test("a miss writes an outcome carrying the reason and no item id", async () => {
  const outcomes: OutcomeRow[] = [];
  const deps = depsWith({
    hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
    appendEgress: () => ({ rowHash: "d".repeat(64) }),
    appendOutcome: (r) => {
      outcomes.push(r);
      return undefined;
    },
    syncableFor: (service) => ({
      serviceId: service,
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync() {
        throw new Error("not exercised");
      },
      fetchOne: async (): Promise<FetchOneResult> => ({
        status: "not_found",
        reason: "deleted",
      }),
    }),
  });

  await targetedFetch(deps, "https://github.com/acme/web/pull/482");

  expect(outcomes[0]).toMatchObject({ status: "not_found", reason: "deleted" });
  expect(outcomes[0]?.itemId).toBeUndefined();
});

test("the arms that return BEFORE the authorising append write no outcome row", async () => {
  // There is nothing for an outcome to name: no egress row was written, because
  // nothing left the machine.
  const outcomes: OutcomeRow[] = [];
  const deps = depsWith({
    hostMap: new Map(),
    appendOutcome: (r) => {
      outcomes.push(r);
      return undefined;
    },
  });

  const out = await targetedFetch(deps, "https://unclaimed.example/o/r/pull/1");

  expect(out).toEqual({ status: "not_configured" });
  expect(outcomes).toHaveLength(0);
});

test("a throwing outcome append does not fail the fetch, and warns", async () => {
  // The request has already left the machine. Propagating would turn a fetch
  // that genuinely succeeded into a 500, and the caller would retry — causing
  // MORE egress than the failure it reports.
  const warnings: unknown[] = [];
  const deps = depsWith({
    hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
    appendEgress: () => ({ rowHash: "d".repeat(64) }),
    appendOutcome: () => {
      throw new Error("disk full");
    },
    warn: (...args: unknown[]) => void warnings.push(args),
    syncableFor: (service) => ({
      serviceId: service,
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync() {
        throw new Error("not exercised");
      },
      fetchOne: async (): Promise<FetchOneResult> => ({
        status: "indexed",
        itemId: "github:acme/web#482",
      }),
    }),
  });

  const out = await targetedFetch(deps, "https://github.com/acme/web/pull/482");

  expect(out).toEqual({ status: "indexed", itemId: "github:acme/web#482" });
  expect(warnings).toHaveLength(1);
});
```

The last test needs `warn` on `DepsOverrides`, defaulted to a no-op alongside `appendEgress`.

**Inject `warn`; do not reach into `ctx.logger`.** `SyncContext["logger"]` is a pino `Logger`, so a
`{ warn }` mock does not structurally satisfy it and the test would need an
`as unknown as SyncContext["logger"]` cast. Every other collaborator in `TargetedFetchDeps` is
already injected (`sleep`, `appendEgress`, `urlIsSupported`, `contextFor`) and `targetedFetch` does
not log at all today, so a logger reached through the context would be the odd one out. Narrowing
the dependency to what is actually used is also the precedent `appendBootMarkerOrWarn` sets, taking
`Pick<Logger, "warn">` rather than a whole logger. The production wiring in `assemble.ts` passes
`syncLogger.warn.bind(syncLogger)`.

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/sync/targeted-fetch.test.ts`
Expected: FAIL — `appendOutcome` is not a known dep, and no outcome rows are recorded.

- [x] **Step 3: Implement the seam and the write site**

In `targeted-fetch.ts`, widen `appendEgress` and add `appendOutcome` to `TargetedFetchDeps`:

```ts
  /**
   * ... existing doc comment, unchanged ...
   *
   * Returns the hash of the row it wrote, so the outcome row below can name it. `undefined` means
   * NO row was written (a local-only destination) — and therefore no outcome row may be written
   * either, because there would be nothing for it to name.
   */
  readonly appendEgress: (row: {
    readonly destination: FetchableService;
    readonly sourceType: "sync";
    readonly method: string;
    readonly sourceId?: string | undefined;
  }) => { rowHash: string } | undefined;
  /**
   * Appends ONE `outcome` marker after the connector call. Injected for the same D22 reason
   * `appendEgress` is: `appendEgressEntry` is confined to `egress/*`.
   *
   * Synchronous, like `appendEgress`, and for the same reason — see that comment.
   */
  readonly appendOutcome: (row: {
    readonly destination: FetchableService;
    readonly authorizingRowHash: string;
    readonly status: FetchOutcomeStatus;
    readonly itemId?: string | undefined;
    readonly reason?: string | undefined;
  }) => undefined;
  /**
   * Where a swallowed outcome-append failure is reported. Injected rather than reached through
   * `ctx.logger`: everything else this module collaborates with is injected, and a narrow seam is
   * what `appendBootMarkerOrWarn` takes too (`Pick<Logger, "warn">`).
   */
  readonly warn: (err: unknown, message: string) => void;
```

Import the type: `import type { FetchOutcomeStatus } from "../egress/outcome-egress.ts";`

Then the write site. Replace the tail of `targetedFetch`:

```ts
  // BEFORE the outbound call. A throw here propagates and no fetch happens — fail-closed, no row
  // means no fetch.
  const authorizing = deps.appendEgress({
    destination: service,
    sourceType: "sync",
    method: "items.fetch",
    ...(callerLabel === undefined ? {} : { sourceId: callerLabel }),
  });

  const result = await fetchOneWithRetry(fetchOne, ctx, canonical);

  // AFTER the call, and deliberately the opposite posture: the request has already left the
  // machine, so there is nothing left to abort. Propagating would turn a fetch that succeeded into
  // a failure and make the caller retry — more egress than the failure it reports. Swallow and
  // warn, never silently (see `appendBootMarkerOrWarn`).
  if (authorizing !== undefined) {
    try {
      deps.appendOutcome({
        destination: service,
        authorizingRowHash: authorizing.rowHash,
        status: result.status,
        ...("itemId" in result ? { itemId: result.itemId } : {}),
        ...("reason" in result ? { reason: result.reason } : {}),
      });
    } catch (err) {
      deps.warn(
        { err },
        "I29: failed to append the targeted-fetch outcome marker — the ledger will report this " +
          "fetch as authorised with no recorded outcome",
      );
    }
  }

  return result;
```

`result.status` is `"indexed" | "not_found" | "rate_limited"` here: `fetchOneWithRetry` returns a `FetchOneResult`, whose fourth arm `unsupported_url` is unreachable because the pre-append `willAttempt` check already refused it. If TypeScript does not narrow that automatically, narrow it explicitly with an `if (result.status !== "unsupported_url")` guard rather than casting.

In `assemble.ts`, wire the new closures beside the existing `appendEgress` one. **`syncLogger` is
not in scope inside `bootTargetedFetchIntoHttpSidecar`** — it is declared in the enclosing
`assemble` function, so thread it through that function's deps as
`logger: Pick<Logger, "warn">` (the same narrowing `appendBootMarkerOrWarn` uses) and pass
`logger: syncLogger` at the call site:

```ts
        appendOutcome: (row) => recordFetchOutcomeEgress(db, { ...row, now: Date.now() }),
        warn: (err, message) => syncLogger.warn(err, message),
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/sync packages/gateway/src/egress`
Expected: PASS.

Run: `bun run typecheck`
Expected: 0 errors. **Do not skip this** — `bun test` does not typecheck strictly, and a test file's local row type may need the new optional fields.

- [x] **Step 5: Commit**

```bash
git add packages/gateway/src/sync/targeted-fetch.ts packages/gateway/src/sync/targeted-fetch.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(sync): record how a targeted fetch ended"
```

---

## Task 5: Record it against I29

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (the I29 section)

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Confirm the invariant suite still passes untouched**

Run: `bun test packages/gateway/src/security-invariants.test.ts`
Expected: PASS with no edit to that file. If it fails, stop — the failure is the specification of what went wrong, and it means `outcome` landed in the wrong list.

- [ ] **Step 2: Write the note**

In the I29 section of `docs/SECURITY-INVARIANTS.md`, after the U2a paragraph, record three things:

1. A completed targeted fetch now appends a SECOND row, `source_type='outcome'`, carrying the status (`indexed` / `not_found` / `rate_limited`) and, on success, the item id. It names its authorising row by that row's `row_hash`, in `source_id` — the column prune tombstones already use for an attested hash.
2. It is a MARKER, so it is excluded from the outbound count: a fetch and its outcome are ONE outbound event, not two. `COVERAGE_CLASSES` is untouched and the existing identity test proves it.
3. The two appends have deliberately opposite failure postures. The authorising append is fail-closed. The outcome append swallows and warns, because by then the request has left the machine and propagating would cause more egress than the failure it reports — the `appendBootMarkerOrWarn` precedent. Swallowing is never silent.

Respect the launch-messaging guardrail: the ledger records dispatched actions at the executor chokepoint, not raw network traffic.

- [ ] **Step 3: Lint the docs**

Run: `bun run lint:markdown`
Expected: 0 issues.

- [ ] **Step 4: Full verification**

Run:

```bash
bun test packages/gateway packages/cli packages/mcp-connectors scripts
bunx biome check packages scripts
bun run typecheck
```

Expected: all pass. Remember `bun run lint` false-fails inside a worktree — use the `bunx biome check` form.

- [ ] **Step 5: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md
git commit -m "docs(security): record the outcome marker against I29"
```

---

## Self-Review

**Spec coverage.** The row shape → Task 3. The union decision → Task 2. The `appendEgressEntry` seam change → Task 1. The write site and its asymmetric failure posture → Task 4. The `EgressSink` non-change → nothing to do, and the plan never mentions it beyond this line. The I29 note → Task 5. The page-boundary rule and the client join are U3b, out of scope by the spec's own slicing, and the plan says so in its header.

**Placeholder scan.** No TBD/TODO. Task 5's doc note is prose specified by its three required points rather than verbatim text, because it must read continuously with the paragraphs around it; every claim it must make is enumerated.

**Type consistency.** `{ rowHash: string }` is introduced in Task 1 and consumed under that exact name in Tasks 3 and 4. `FetchOutcomeStatus` is defined in Task 3 and imported in Task 4. `recordFetchOutcomeEgress`'s argument names (`destination`, `authorizingRowHash`, `status`, `itemId`, `reason`, `now`) match Task 4's `appendOutcome` row exactly, less `now`, which the assemble closure supplies — the same split `recordSyncEgress` already uses.

**No D22 caller-pin is added for `recordFetchOutcomeEgress`, deliberately.** Rule (c) pins
`recordAgentBriefEgress` to exactly one caller, which makes its chokepoint total. The closer
analogue here is `recordSyncEgress` — also an `egress/` appender reached through an injected
closure — and it carries no pin either. Adding one for a new appender while its sibling has none
would be inconsistent, and the property this row class needs (never counted as outbound) is already
structural through `MARKER_SOURCE_TYPES` rather than dependent on who calls it.

**The risk worth flagging to the executor.** Task 4 widens a seam's return type. That seam is typed to return `undefined` rather than `void` specifically so an `async` implementation is a compile error, and U2a already produced one silent failure in this exact area — a closure with fewer parameters stayed assignable and dropped its argument. Typecheck cannot catch either shape. The behavioural tests in Task 4 are what prove the value arrives; do not weaken them into type assertions.
