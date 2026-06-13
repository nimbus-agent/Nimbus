# Review: True Coverage C3 — StrykerJS mutation-testing harness — Implementation Plan

**Date:** 2026-06-13  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Review Completed  
**Target Plan:** [`2026-06-13-true-coverage-C3-stryker-mutation.md`](./2026-06-13-true-coverage-C3-stryker-mutation.md)

---

## 1. Executive Summary

The implementation plan for C3 is exceptionally well-structured, incorporating true TDD for the custom path filter and providing a robust contingency fallback path for the experimental Bun runner. We have reviewed the steps and have a key improvement suggestion for the git-diff reference check to prevent script crashes on local developer machines.

---

## 2. Detailed Feedback & Suggestions

### 2.1. Git Reference Robustness for `--diff` Scoping (Task 2 Step 3)

- **Observation:** The `run-mutation.ts` script executes `git diff --name-only origin/main...HEAD`. If a developer is running this script locally and has not fetched from the remote (or does not have an `origin` remote set up), this command will fail, raising a git exit error and terminating execution.
- **Recommendation:** Implement a fallback check in `diffMutableFiles()` to see if `origin/main` is a valid ref before using it, falling back to local `main` if needed:

  ```typescript
  function diffMutableFiles(): string[] {
    let baseRef = "origin/main";
    const checkRef = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { encoding: "utf8" });
    if (checkRef.status !== 0) {
      baseRef = "main"; // Fallback to local main branch if origin/main is not fetched/present
    }

    const out = spawnSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
      encoding: "utf8",
    });
    if (out.status !== 0) {
      const err = (out.stderr ?? "").trim();
      throw new Error(`git diff failed: ${err || `exit ${out.status}`}`);
    }
    const lines = out.stdout.split("\n").filter((l) => l.length > 0);
    return filterMutableFiles(lines);
  }
  ```

---

### 2.2. Safety of `inPlace` Mutation Runs (Task 1 Step 3)

- **Observation:** `stryker.conf.json` specifies `"inPlace": true` which modifies the developer's working files directly.
- **Validation:** This successfully avoids complex monorepo node_modules resolution failures. However, if a developer aborts a Stryker run (e.g. via `Ctrl+C`), they may be left with mutated/broken code.
- **Action:** Ensure this risk is prominently documented in the `docs/contributors/mutation-testing.md` contributor guide (which the plan already does: *"if a run is killed mid-restore, `git restore` recovers"*).

---

### 2.3. Empty Diff Behavior Unit Test (Task 2 Step 1)

- **Observation:** The plan includes:

  ```typescript
  test("returns [] for an empty diff", () => {
    expect(filterMutableFiles([])).toEqual([]);
  });
  ```

- **Validation:** This correctly tests that the filter behaves as expected, validating the graceful exit condition where Stryker is bypassed entirely when no source changes are detected.

---

## 3. Conclusion

The C3 implementation plan is approved. Integrating the git ref fallback logic will make the local developer workflow significantly more resilient.
