# Review: Coverage Floor Phase 6 Design Spec

**Date:** 2026-05-22
**Target spec:** [`2026-05-22-coverage-floor-phase-6-design.md`](../specs/2026-05-22-coverage-floor-phase-6-design.md)
**Reviewer:** Self-review (same session) + external Antigravity automated review pass on the committed spec file
**Outcome:** All 9 surfaced concerns addressed in-spec (rev 2) without scope change. No follow-up review pass required before plan authoring.

---

## How this review was conducted

The spec was committed at `848eb920` after Brainstorm Q1–Q7. Two passes followed:

1. **Inline self-review** during initial authoring caught three internal-consistency errors (math/counts).
2. **External Antigravity automated review** then appended six structured concerns to the spec file directly. Each was evaluated for validity and either applied or rejected with rationale.

The Antigravity feedback was high-quality — all six points were valid engineering observations worth applying. The dispositions below mirror the in-spec "Review & Suggestions" annotation block, with this doc serving as the canonical trail.

---

## Pass 1 — Internal consistency (self-review)

### A1. Math error: baseline outcome arithmetic

**Concern:** Spec body said "baseline drops from 92 → ~37 entries (about 51 CLI entries removed)" but `92 - 51 = 41`, not 37. The mismatch came from also undercounting the MCP-connector entries as "28+" when the JSON baseline holds 32.

**Disposition:** Fixed. Goal section now reads `92 → 41 entries`. The MCP-connector entry is now explicitly `32` (31 `server.ts` files + `jenkins-api.ts`). The "Phase 6 → Phase 7+ transition" section was updated in lockstep.

### A2. Inconsistent removal counts

**Concern:** Goal section claimed "50 raised + 1 excluded = 51 removed"; acceptance criterion 5 then said "drops ~50 entries (49 raised + 1 excluded)". Off-by-one between two places that should agree.

**Disposition:** Fixed. Acceptance criterion 5 now states "drops 51 entries (50 raised to ≥80% + 1 newly excluded `cli/src/index.ts`)". Commit Structure totals updated to match.

### A3. Commit Structure totals

**Concern:** Commit Structure footer said "50 baseline entries dropped" — also off by one.

**Disposition:** Fixed. Now says "51 baseline entries removed (50 raised + 1 excluded)."

---

## Pass 2 — Antigravity automated review (6 points)

### B1. Test concurrency + globalThis fixture slot

**Original:**
> `globalThis.__nimbusCliFixture` is used to hold per-test state. Bun's test runner can execute tests concurrently. Since `globalThis` is shared across the entire V8 isolate, running tests concurrently would result in race conditions.

**Evaluation:** Valid. Bun's default is serial-within-process for test files in one `bun test` invocation, so today the pattern is safe. But a future addition of `--concurrent` or a cross-file parallelization mode would silently break the harness — the failure mode is non-deterministic test flakes, not a clean error.

**Disposition:** Applied. Added a "Serial-within-process is assumed" bullet to the harness rationale section, locking in the constraint as a documented invariant: "The CLI test harness MUST NOT be invoked with `--concurrent` (or any future option that runs test files in parallel within one process)." Within a single test file, `beforeEach`/`afterEach` already enforce per-test isolation.

The alternative (context-based mocking) was rejected because Bun does not yet support it; revisit if/when Bun adds a per-test mock-isolation primitive.

### B2. Sub-handler API surface — public vs test-only

**Original:**
> Are these sub-handlers intended to become public APIs for the CLI package, or are they exported strictly for testing? Consider `_test_runVaultSet` or `export const __testing = { ... }`.

**Evaluation:** Valid concern. Without a convention, future contributors might consume `runVaultSet` from outside the test/dispatcher pair, creating unintended coupling.

**Disposition:** Applied with a different mechanism than the suggested prefix/namespace. Added the "Sub-handler API surface convention" subsection to the "Per-file source refactor" section. Convention:

- Sub-handlers stay exported by name (e.g. `runVaultSet`).
- Each carries a JSDoc block: `Test entry point — invoked by the dispatcher runVault(args) and the colocated vault.test.ts. Do not call from other command files.`
- `knip` already flags genuinely orphaned exports.

**Rationale for rejecting the suggested mechanisms:**

- `_test_runVaultSet` reads oddly in the dispatcher's call site and violates the project's idiomatic-JS convention (no underscore-prefix "private" markers).
- `export const __testing = { runVaultSet }` complicates the dispatcher's call site (must import the namespace, destructure, or call indirectly) and offers no real safety beyond JSDoc — a determined caller can still reach in.
- Documenting via JSDoc is the simplest convention that scales to 39 commands without ceremony.

### B3. Output capture completeness

**Original:**
> `captureOutput` stubs `process.stdout.write`, `process.stderr.write`, `console.log`, and `console.error`. Modern CLI tools may also log via `console.warn`, `console.info`, or `console.debug`. Add stubs for them.

**Evaluation:** Valid and small. Transitive dependencies (especially anything wrapping `pino` or similar) emit through `warn`/`info`/`debug` channels. Leaking these into the test runner's console pollutes CI logs and can confuse test failure attribution.

**Disposition:** Applied. The `cli-output.ts` reference implementation in the Test Infrastructure section now stubs `console.{log, error, warn, info, debug}`. Routing follows Node convention: `log`/`info`/`debug` → stdout buffer, `warn`/`error` → stderr buffer. `restore()` restores all five.

### B4. mock-ipc-client queue exhaustion

**Original:**
> If the code under test makes more IPC calls than expected, `idx++` will step out of bounds, silently returning `undefined`, which could lead to confusing downstream type errors. Add a bounds check.

**Evaluation:** Valid. The silent-undefined path is exactly the kind of debugging time-sink Phase 5 lessons warn against. The fix is one line and surfaces the offending IPC method name.

**Disposition:** Applied. Updated the `mock-ipc-client.ts` reference:

```typescript
if (idx >= responseQueue.length) {
  throw new Error(
    `Unexpected IPC call: response queue exhausted (got ${method}; provide more entries to createMockIpcClient)`,
  );
}
```

The method name in the error message is the key debugging affordance — tests will print exactly which IPC call ran past the queue end.

### B5. Orphaned subprocesses in tests

**Original:**
> If an assertion fails before `proc.kill()` is reached, the spawned process may become an orphan, lingering in the background. Track at the file level in a `Set<Subprocess>` and kill defensively in `afterEach`/`afterAll`.

**Evaluation:** Valid. Phase 5 didn't hit this because its commits 5 and 11 already had narrow subprocess scopes. Phase 6 commit 5 has three lib files all spawning subprocesses; the multiplicative effect of accumulated orphans across iterative CI runs is the real risk.

**Disposition:** Applied. The Risks table row for `lib/gateway-process.ts` (commit 5) now mandates the file-level `const liveProcs = new Set<Bun.Subprocess>()` pattern. Every spawn adds to the set; `afterEach` and `afterAll` both iterate the set with `try { p.kill(); } catch {}`, then `liveProcs.clear()`. The belt-and-braces pattern (both hooks) covers the case where `afterEach` itself throws.

### B6. TTY stubbing — columns + rows

**Original:**
> Ink often needs `process.stdout.columns` and `process.stdout.rows` to render without throwing layout errors. The Reused Patterns table mentions them, but the Carry-forward #5 code snippet does not. Define all three.

**Evaluation:** Valid. Phase 5's spec actually included all three properties; my Phase 6 carry-forward snippet abbreviated to just `isTTY` for brevity. That abbreviation costs hours of debugging when a TUI test silently hits an Ink layout error.

**Disposition:** Applied. Carry-forward #5 now defines all three properties (`isTTY: true`, `columns: 120`, `rows: 40`) with matching `PropertyDescriptor`-captured originals restored in `afterEach`. The header sentence now also calls out that headless CI leaves `columns`/`rows` undefined and that Ink throws layout errors in that state.

---

## Cross-cutting observation: high signal-to-noise ratio

All six Antigravity points were valid engineering concerns worth applying. None were rejected; only B2's specific mechanism was substituted for a lighter-weight convention. This suggests the spec was already structurally sound and the review primarily caught implementation-detail gaps in the reference code snippets. No structural redesign needed.

---

## Outcome

- **9 concerns surfaced, 9 addressed.** 3 from self-review (math/counts), 6 from Antigravity review.
- **No scope changes.** The 14-commit shape is unchanged. The hybrid harness boundary is unchanged. The lazy per-family refactor placement is unchanged.
- **Spec is ready to inform the implementation plan.** Author the plan at `docs/superpowers/plans/2026-05-22-coverage-floor-phase-6.md` next, mirroring Phase 5's structure (per-task commit messages, file-by-file workflow, the "Pre-implementation guardrails" + "Test hygiene" sections).

---

## Actions for the plan author (carried forward into the implementation plan)

1. **Task 2 (harness + vault reference)** — implement `cli-mocks.ts`, `mock-ipc-client.ts`, `cli-output.ts` exactly as the reference snippets in the spec specify (including B3 console.warn/info/debug stubs, B4 queue-exhaustion bounds check). Add a comment to `cli-mocks.ts` documenting the B1 serial-execution assumption.
2. **Task 2 (vault refactor)** — apply the B2 JSDoc convention to every exported sub-handler. The pattern lands here once and propagates to family commits.
3. **Task 5 (subprocess-managing lib helpers)** — implement the B5 `liveProcs` cleanup pattern in `gateway-process.test.ts`, `spawn-gateway.test.ts`, `restore-db-from-snapshot.test.ts`. Each file gets its own `Set<Bun.Subprocess>`.
4. **Task 11 (agent/interactive family)** — apply the B6 three-property TTY stubbing pattern to `tui.test.tsx` and any other commands that render Ink (verify via grep for `ink` imports under `packages/cli/src/commands/`).
5. **Pre-implementation guardrails section of the plan** — repeat the B1 constraint ("never `--concurrent`") so subagent implementers don't accidentally enable it.
