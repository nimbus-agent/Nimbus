# Implementation Plan Review: Agent Brief Synthesis (W6-A0)

This document collects feedback, suggestions, and open questions on the [Agent Brief Synthesis Implementation Plan](file:///C:/gitrep/Nimbus/.claude/worktrees/dev+asafgolombek+agent-brief-synthesis/docs/superpowers/plans/2026-08-16-agent-brief-synthesis.md).

---

## 1. Open Questions & Suggestions

### Q1: Automating Negative Test Cases (Replacing Manual "Red-Proving")
In **Task 2 Step 5**, the plan describes a manual step to verify that the guard fails when reverted:
> Temporarily change `sectionBody` to return the whole `markdown` instead of the scoped body. Re-run...

* **Suggestion:** Rather than relying on a developer to manually break and restore code to "red-prove" the guard, add automated negative test cases directly inside `brief-contract.test.ts` that pass invalid/violated markdown structures and assert that `contractViolations` identifies them.
* **Example Test Case to Add:**
  ```ts
  test("rejects when the disclaimer is missing entirely from a section", () => {
    const md = "## PRs authored\n\n- Some actual PR data here\n\n## PRs reviewed\n\n_could not be computed_";
    const v = contractViolations(twoNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain(`section "PRs authored" dropped required phrase "could not be computed"`);
  });
  ```

### Q2: Aborting Hung LLM Requests on Timeout
In **Task 4**, the plan races the provider generator call against `synthesisTimeoutMs` (defaulting to 20,000ms):
* **Question:** When a timeout occurs, does the pending LLM generation request get aborted (e.g., via an `AbortSignal`), or does it continue running in the background consuming local resources (Ollama CPU/GPU) or remote API tokens?
* **Recommendation:** If the `LlmRouter` or the underlying model generator supports an `AbortSignal`, pass it through so that timing out actively cancels the request and releases the compute resources.

### Q3: Database Lock Resiliency in `recordSynthesisEgress`
In **Task 4 Step 3**:
> 4. Provider is non-local and mode is `"any"` → `recordSynthesisEgress(...)`. If it throws, return `null` without generating — fail-closed.

* **Suggestion:** Ensure the SQLite database is not held in an active transaction that could block write attempts when `recordSynthesisEgress` runs. If the database fails with a temporary busy/locked error, retrying or failing gracefully to deterministic mode is correct, but logging the error detail is highly recommended to distinguish between a database issue and a model issue.
