# Coverage Floor Phase 8 Design Review

**Date:** 2026-05-26
**Target Spec:** `2026-05-26-coverage-floor-phase-8-design.md`

## Overview

The Phase 8 design is comprehensive and well-structured, providing a clear path to closing out the coverage floor program by taking the baseline from 10 to 0. The categorization into structural exclusions (Tier E), near-floor nudges (Tier N), dispatchers (Tier D), and the large connector pass (Tier B) breaks down the work into manageable, logically ordered commits.

Below are a few questions, suggestions, and improvements to consider before or during implementation.

## Suggestions & Improvements

### 1. Robust Temp Directory Cleanup (Tier N - `extension.ts`)
**Observation:** The spec mentions using `mkdtempSync(join(tmpdir(), "nimbus-ext-"))` and cleaning it up with `rmSync(tmp, { recursive: true, force: true })` in `afterEach`.
**Improvement:** On Windows, `rmSync` can sometimes fail with `EBUSY` or `EPERM` if the OS or an antivirus scanner momentarily holds a lock on newly created files (like the generated keys or manifest). 
**Suggestion:** Consider adding `maxRetries: 3, retryDelay: 100` to the `rmSync` options to prevent flaky test failures on Windows CI runs.

### 2. Data-Driven Testing for `connector.ts` (Tier B)
**Observation:** The `connector.ts` `auth` machinery has 19 `apply*ConnectorAuth` functions. Covering one success and one primary error for each means adding at least 38 distinct test cases.
**Improvement:** Writing 38 individual `it()` or `test()` blocks could make the test file massive and hard to maintain.
**Suggestion:** Strongly recommend using `test.each(table)` for the connector auth cases. Since Carry-forward #3 notes that `bun:test`'s `test.each` requires a mutable array, you can define a structured array of test cases (e.g., `{ applier: "jira", flags: ["--domain", "x"], mockResponse: {...}, expectedExit: 0 }`) and iterate over it. This will keep the test suite concise and readable.

### 3. Exclusions Syntax in `sonar-project.properties` (Tier E)
**Observation:** The spec states that `packages/cli/src/commands/tui.tsx` will be added to `sonar-project.properties` line 65 (`sonar.coverage.exclusions`).
**Question/Improvement:** Does the current Sonar configuration or exclusions script properly handle exact file matching for `.tsx` extensions, given that previous exclusions might have relied on regexes targeting `.ts`?
**Suggestion:** Verify that the Sonar pattern syntax exactly matches `.tsx` (e.g., `packages/cli/src/commands/tui.tsx`) and doesn't get skipped by a broader filter that only looks for `.ts` files.

### 4. Mock Module Scope Leakage Prevention
**Observation:** Carry-forward #1 explicitly notes that `mock.module` is process-global and affects future imports, mitigating it by calling `mock.module` for distinct leaf paths that don't collide.
**Improvement:** While restoring the real module in `afterAll` is good, another defensive practice in Bun when using process-global mocks is to group the specific tests relying on the mock into their own file, which the plan already naturally aligns with.
**Suggestion:** Ensure that the tests for `repl`, `serve`, and `test` remain completely isolated in their respective test files (`repl.test.ts`, `serve.test.ts`, `test.test.ts`), preventing any chance of cross-pollination. 

### 5. Confirming stdout/stderr Capture
**Observation:** The spec calls out that `extension` keygen/sign use `process.stdout.write` instead of `console.*`, requiring direct capture (the `extension.test.ts:705` pattern).
**Improvement:** If other commands being tested in Phase 8 (e.g., `update` or `doctor`) also happen to write directly to `stdout`/`stderr` instead of `console`, the standard `captureOutput()` fixture might miss them.
**Suggestion:** Double-check if `update.ts` or `doctor.ts` rely on direct stream writes for prompt outputs (like Clack spinners or Ink components that might bypass `console.log`).

## Conclusion

The plan is solid. The commitment to zero source changes and moving the three genuinely un-testable (in a CI unit test context) files to documented exclusions rather than contorting the architecture is a pragmatic and correct engineering decision. The commit structure is sequenced perfectly to isolate the highest-risk changes (the massive `connector.ts` tests) from the easier wins.
