# Review: True Coverage D2 — Heavy/Borderline Exclusion Triage — Implementation Plan

**Date:** 2026-06-14  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Review Completed  
**Target Plan:** [`2026-06-14-true-coverage-D2.md`](./2026-06-14-true-coverage-D2.md)

---

## 1. Executive Summary

The D2 implementation plan is exceptionally thorough, well-reasoned, and aligns perfectly with the project's **honest-shrink** philosophy. The separation of `team.ts` into unit-testable federation and consent-handling functions is structurally elegant and preserves security and licensing invariants.

We have identified one significant improvement that allows us to achieve **100% branch coverage** for the extracted `handleConsentNotification` function, eliminating the need to accept an uncovered cancel branch.

---

## 2. Detailed Feedback & Suggestions

### 2.1. Testing the Cancel Branch in `handleConsentNotification` (Task 2 Step 1)

- **Observation:** The plan states that the `isCancel(ok)` branch in `handleConsentNotification` is an "accepted uncovered residual (1 branch)" because Clack's `CANCEL_SYMBOL` is unexported.
- **Correction:** In the codebase under [cli-mocks.ts](../../../packages/cli/test/helpers/cli-mocks.ts), the cancel symbol is defined as `Symbol.for("clack:cancel")` and exported as `CLACK_CANCEL` (line 117). This means `isCancel` from `@clack/prompts` simply checks if the value is this registered symbol.
- **Suggestion:** We can achieve 100% coverage of `handleConsentNotification` by adding a test case that returns this symbol from the mock prompt:

  ```typescript
  it("cancel → does not call consentRespond and exits early", async () => {
    const { client, calls } = fakeClient();
    const cancelPrompt: ConfirmPrompt = async () => Symbol.for("clack:cancel");
    
    await handleConsentNotification(
      client,
      { requestId: "r1", peerId: "p", namespace: "ns", purpose: "why" },
      cancelPrompt,
    );
    
    expect(calls).toHaveLength(0);
  });
  ```

### 2.2. Suppressing Stderr Noise during Test Execution (Task 2 Step 1)

- **Observation:** The error arm of `handleConsentNotification` writes to `process.stderr.write` when an RPC call fails:

  ```typescript
  process.stderr.write(
    `Error sending consent decision: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  ```

- **Suggestion:** The test `"swallows an rpc error (no throw, no unhandled rejection)"` will trigger this write, which can pollute the test output in the console.
- **Improvement:** While not strictly required for coverage, we can temporarily mock or spy on `process.stderr.write` in that specific test block to keep the unit test output completely clean, or simply document that the console stderr message is expected.

---

## 3. Conclusion

The D2 plan is solid and ready for execution. Applying the cancel-branch test suggestion ensures we leave zero untested branches in the new `handleConsentNotification` function, aligning perfectly with the program's rigor.
