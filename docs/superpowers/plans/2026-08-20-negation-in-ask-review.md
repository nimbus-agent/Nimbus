# Review: Negation in Ask (2026-08-20) Implementation Plan

Below is a detailed review of the implementation plan proposed in [2026-08-20-negation-in-ask.md](./2026-08-20-negation-in-ask.md), including clarifications and suggestions for alignment.

---

## 1. Technical Observations & Recommendations

### A. Mastra Input Schema Convention

* **Observation:** The plan defines the engine-side Mastra tools inside `negation-tools.ts` with dynamic type-checking (`asRecord` and type guards inside `execute`) rather than using Mastra's `inputSchema` property.
* **Suggestion:** This matches the existing design of `searchLocalIndex` and other tools in `packages/gateway/src/engine/agent.ts`. Keeping this pattern prevents introducing inconsistent input validation styles between standard engine tools and negation tools.

### B. Provider Independence in the Test Agent

* **Observation:** Task 1 Step 6 sets up a test using `new Agent({ model: "openai/gpt-4o-mini", ... })`. Although construction does not execute model calls and does not fail on missing `OPENAI_API_KEY`, future updates to Mastra might validate environment keys during instantiation.
* **Suggestion:** Consider adding a small note to use a mock model provider or a mock agent structure (similar to `fakeConversationalAgent` in `run-ask.test.ts`) if construction ever throws due to missing API keys.

---

## 2. Validation & Alignment for Sibling Tools

To avoid any ambiguity in the implementation of the sibling tools described in Task 3:

### A. `findDeploymentsWithoutIncident`

* **Intrinsics:** `itemType` is constrained to `"deployment"`.
* **Parameter:** `service` (optional string).
* **Refusal Outcome:**

  ```json
  {
    "refused": true,
    "reason": "missing_substrate",
    "message": "no correlates_with edges are indexed, so which deployments have no downstream incident cannot be verified",
    "remediation": "run a sync that populates deployment-to-incident correlation, then retry"
  }
  ```

### B. `findPeopleWithoutReviews`

* **Intrinsics:** No service filtering is supported (matching the database `person` table scope).
* **Parameters:** `since` (optional string/number duration), `limit` (optional number).
* **Refusal Outcome:**

  ```json
  {
    "refused": true,
    "reason": "missing_substrate",
    "message": "no reviewed edges are indexed within the --since window, so who has not reviewed anything in that window cannot be verified",
    "remediation": "widen --since to include older reviews, or sync a connector that populates PR review activity and run nimbus index regraph"
  }
  ```
