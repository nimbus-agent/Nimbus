# Review: True Coverage — Sub-project C3: StrykerJS mutation-testing harness — Design

**Date:** 2026-06-13  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Review Completed  
**Target Spec:** [`2026-06-13-true-coverage-C3-stryker-mutation-design.md`](./2026-06-13-true-coverage-C3-stryker-mutation-design.md)

---

## 1. Executive Summary

The design for Sub-project C3 is well-scoped, targeting a dev-only, advisory harness to measure test assertion strength. Wiring StrykerJS as a root-level devDependency with a fallback configuration ensures developer safety and setup flexibility.

We have reviewed the design and identified a few open questions/suggestions to guarantee sandbox runtime stability, monorepo compatibility, and diff-script robustness.

---

## 2. Detailed Feedback & Suggestions

### 2.1. Sandbox Configuration and Symlinks for Monorepo

- **Observation:** StrykerJS executes tests within a sandbox directory (typically `.stryker-tmp/sandbox-<id>`). In a monorepo, module resolution can fail if the package dependencies are not correctly linked/shared with the sandbox.
- **Recommendation:** In the `stryker.conf.json` design:
  1. Ensure `symlinkNodeModules: true` is explicitly enabled (or confirm it is Stryker's default behavior) so that the sandbox can access workspace dependencies.
  2. Verify that workspace configuration files (such as `tsconfig.json`, `package.json` files, and `bun.lockb`) are included in the Stryker `files` array to prevent TypeScript resolution errors during compilation in the sandbox.

---

### 2.2. Robustness of `--diff` Script on Empty Diff (§4)

- **Observation:** The `run-mutation.ts` wrapper computes changed non-test files vs `origin/main` and passes them to Stryker via `--mutate`.
- **Open Question:** What is the fallback behavior when the diff is empty (e.g., when running on the latest `origin/main` directly or when a developer has no local modifications)?
- **Recommendation:** The script should handle an empty diff gracefully by:
  - Falling back to the default security-core scope (e.g., `executor.ts` + `tool-output-envelope.ts`), OR
  - Exiting with a clean, explanatory log message without executing Stryker (to avoid running mutation testing across the entire codebase by default, which would be very slow).

---

### 2.3. Command-Runner Test Scoping Option

- **Observation:** Under the `command` runner fallback, Stryker runs an opaque command.
- **Suggestion:** In `stryker.conf.json`, ensure that if the fallback `command` runner is used, the command is parameterized or scoped to only run the test files corresponding to mutated source files, rather than the entire workspace test suite. Running `bun test packages/gateway/src/` is much faster than running the full workspace test suite for every mutant.

---

## 3. Conclusion

The C3 design is approved for implementation planning. Resolving the monorepo sandbox dependencies and diff-fallback behavior will ensure a smooth developer experience.
