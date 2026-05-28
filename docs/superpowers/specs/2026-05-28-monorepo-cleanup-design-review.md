# Review: Monorepo Cleanup Pass — Design

The monorepo cleanup design is highly ambitious and well-structured, breaking down a massive undertaking into logical passes. However, a few areas stand out as potentially high-risk or warranting further discussion before execution.

## 1. Internal JSDoc Stripping (Pass 3)

* **Risk:** The plan dictates deleting **all** JSDoc blocks outside of the `@nimbus-dev/sdk` and `@nimbus-dev/client` packages. While stripping inline comments forces code to be more self-documenting, stripping all internal JSDoc severely degrades the local Developer Experience (DX). IDE tooltips for complex internal types, configuration objects, and core engine functions will disappear.
* **Suggestion:** Reconsider whether internal JSDoc should be entirely eliminated. If the goal is to remove cruft, perhaps target only inline `//` comments, or retain JSDoc for exported functions/interfaces within internal packages while removing it from internal/private implementations.

## 2. TODO/FIXME Migration (Pass 1 & 3)

* **Observation:** Pass 3 deletes all `TODO/FIXME/XXX/HACK` markers. However, Pass 1's survey grep (`I[0-9]+`, `HITL`, `WHY:`, `NOTE:`, `WORKAROUND`, etc.) does not explicitly search for these markers.
* **Suggestion:** Include `TODO`, `FIXME`, `HACK`, and `XXX` in the Pass 1 survey. Often, these markers contain load-bearing technical debt rationale that should be captured in a tracking issue or `upstream-workarounds.md` before the blanket deletion in Pass 3.

## 3. The `runConnectorSync` "God Function" (Pass 4)

* **Risk:** Extracting `runConnectorSync` to collapse all `<connector>-sync.ts` files into ~40 lines is a great goal. However, dealing with 30+ connectors often reveals wildly different pagination quirks, error handling, rate-limit backoffs, and OAuth token refresh edge cases.
* **Suggestion:** Be cautious of creating a parameter-heavy "god function" (e.g., `runConnectorSync` taking an options object with 15 optional boolean flags). The extraction of `paginate.ts` is a good mitigation, but ensure the resulting abstraction relies on composition (strategies/interfaces) rather than complex internal branching.

## 4. PR Size and Reviewability (Delivery)

* **Risk:** The design specifies "one mega PR on a single branch." Even with meticulous commit separation, a PR that strips all comments monorepo-wide *and* fundamentally refactors the engine, connectors, and IPC dispatchers will be exceptionally difficult to review thoroughly.
* **Suggestion:** Consider splitting this into two sequential PRs:
  1. **PR 1: Documentation & Cruft Removal** (Passes 1–3). This is a massive but primarily mechanical text diff. It can be reviewed and merged quickly without fear of logic regressions.
  2. **PR 2: Deduplication & SOLID Refactoring** (Passes 4–6). This contains the high-risk logic changes. Reviewers can focus entirely on code structure and test integrity without being distracted by thousands of lines of deleted comments.

## Conclusion

The structure of the plan is excellent, particularly the strict adherence to the 16 security invariants and the use of the AST-aware comment stripper. Addressing the internal JSDoc policy and considering a two-PR approach will significantly de-risk the execution.
