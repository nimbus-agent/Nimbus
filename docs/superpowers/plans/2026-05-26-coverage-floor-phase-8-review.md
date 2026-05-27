# Coverage Floor Phase 8 Implementation Plan Review

**Date:** 2026-05-26
**Target Plan:** `2026-05-26-coverage-floor-phase-8.md`

## Overview

The implementation plan is an exceptionally well-translated execution sequence of the Phase 8 design spec. It correctly recognizes constraints (such as `bunVersionOk` being unexported) and accurately incorporates feedback from the design review (e.g., `rmSync` retries for Windows, `test.each` mutable arrays for the massive `connector.ts` test block, and avoiding `process.stdout` capture snags).

Below are a few minor questions, suggestions, and improvements to consider before executing the plan.

## Suggestions & Improvements

### 1. Verification of Error Regexes in `connector.ts` (Task 5, Step 1)
**Observation:** You have defined `AUTH_ERR_ROWS` with exact regexes (e.g., `match: /Linear requires an API key/`) for all 19 appliers. 
**Improvement:** While this is a highly efficient way to data-drive the error paths, ensuring that these 19 string segments perfectly match what `connector.ts` throws is crucial. 
**Suggestion:** Before committing this chunk, a quick manual verification that the `connector.ts` source code exactly matches those string errors (especially spacing and punctuation) will prevent confusing test failures on the first run.

### 2. Sonar Exclusions Formatting (Task 1, Step 2)
**Observation:** The append instruction for `sonar-project.properties` indicates appending `,packages/cli/src/commands/start.ts,packages/cli/src/commands/tui.tsx,packages/cli/src/lib/gateway-process.ts` to line 65.
**Suggestion:** Just double-check that line 65 does not end with a trailing comma before appending, to avoid an empty entry in the comma-separated list (e.g., `...,foo.ts,,packages/cli/...`) which can sometimes trip up strict configuration parsers.

### 3. `mock.module` Worker Concurrency (Task 3, Step 10)
**Observation:** The plan correctly identifies the need to verify no sibling poisoning by running `bun test src/` to mimic the single-process coverage run.
**Improvement:** `bun test` can sometimes spawn multiple workers depending on the version and configuration. If the coverage run in CI (`bun test --coverage`) strictly executes in a single process, the `capture-real/restore-real` pattern is completely airtight.
**Suggestion:** If you encounter unexpected flakiness during the whole-suite verification step, verify if `bun test` is running concurrently across workers. If so, passing `--workers 1` (or whatever `build-lcov` uses) might be necessary to accurately simulate the exact leak vector.

### 4. Zero Source Changes constraint vs CLI Dispatchers (Self-Review divergence 1)
**Observation:** The plan successfully avoids altering the source code of `doctor.ts` by leveraging the existing exported CLI dispatcher `runDoctor([])` with fixture permutations rather than exporting pure helpers.
**Praise:** This is a fantastic catch. It maintains the rigid "zero source changes" acceptance criteria while still achieving the necessary coverage, strictly adhering to the architectural rules of the floor-raising exercise.

## Conclusion

The plan is extremely robust, addressing all edge cases and mitigating potential CI/CD flakes (like the temp dir cleanup). The commit ordering correctly protects the branch, and the reliance on CI-Linux artifacts to prevent local OS discrepancies is properly enforced. The plan is ready for execution.
