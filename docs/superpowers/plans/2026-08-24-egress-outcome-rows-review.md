# Plan Review: Outcome Rows on the Egress Ledger (U3a)

**Date:** 2026-08-24
**Status:** Plan Review / Feedback
**Target Plan:** [2026-08-24-egress-outcome-rows.md](./2026-08-24-egress-outcome-rows.md)

---

## 1. Summary of Feedback

The implementation plan is extremely detailed, covers every step of the lifecycle cleanly (TDD, implementation, type checking, invariants validation, documentation, and commits), and respects all global constraints.

Here are a few suggestions and validation items to keep in mind when executing this plan:

---

## 2. Detailed Feedback & Open Questions

### Q1. TypeScript Casting for Logger Mock in Task 4 Test

In Task 4, you add a test checking that a throwing outcome append does not abort the fetch and instead warns:

```ts
    logger: {
      warn: (...args: unknown[]) => void warnings.push(args),
    },
```

**Superseded — see the plan.** The plan now injects a `warn` seam on `TargetedFetchDeps` rather
than reaching into `ctx.logger`, so no cast is needed at all. The observation below is correct and
is what prompted the change.

* **Suggestion:**
  * Since `SyncContext["logger"]` is a Pino logger, TypeScript has strict type checks for it and will complain that the mock object is missing fields like `info`, `error`, `child`, etc.
  * Ensure the mock is cast with `as unknown as SyncContext["logger"]` when overriding `fakeCtx` in `depsWith` (similar to the rateLimiter mock structure) to avoid strict typecheck errors.

### Q2. TSC Strictness on Function Return Type Constraints

The plan defines `appendEgress` and `appendOutcome` with explicit `undefined` return values to prevent `async void` assignments.

* **Suggestion:**
  * Some TS configs can be lenient with returning `void` when `undefined` is expected, or vice-versa.
  * When configuring mock implementations in the tests, verify that `() => undefined` (explicitly returning `undefined` or a block returning nothing) is used in place of implicitly typed arrow functions to ensure absolute compliance with compiler expectations.

### Q3. Static D22 Verification

* **Check:**
  * Task 4 imports `FetchOutcomeStatus` from `../egress/outcome-egress.ts` into `targeted-fetch.ts`.
  * Double check that this import only carries type definitions and does not pull in any runtime implementation from `egress/` (which would trigger the static D22 rule if it restricts imports). Since `FetchOutcomeStatus` is a TypeScript `type`, this should be perfectly safe, but using `import type { FetchOutcomeStatus }` explicitly is recommended.

---

## 3. Recommended Actions

* Adopt the `superpowers:subagent-driven-development` sub-skill as suggested to execute this plan incrementally.
* Ensure that `bun run typecheck` is run after Task 4 and Task 5 to catch any residual type mismatches.
