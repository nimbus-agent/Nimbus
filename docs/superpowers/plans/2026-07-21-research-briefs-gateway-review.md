# Implementation Plan Review: Research Briefs (Gateway Side)

**Date:** 2026-07-21
**Target Plan:** [2026-07-21-research-briefs-gateway.md](file:///C:/gitrep/Nimbus/.claude/worktrees/research-briefs-gateway/docs/superpowers/plans/2026-07-21-research-briefs-gateway.md)

---

## 1. Concurrency Cap Response Code Inconsistency
- **Observation:** Under the Design Spec's HTTP surface table, an over-concurrency-cap condition is designated to return a `429 Rate Limited` response containing a `Retry-After` header. However, in **Task 11** (`runBriefCreateRoute`), the plan instructs returning a `503 briefs_busy` status with no `Retry-After` header (noting that the client clamps to 120s anyway).
- **Impact:** Returning `503` instead of `429` deviates from standard API semantics where concurrency limits are treated as rate limits. The client might not retry gracefully if it expects a standard `429` + `Retry-After` flow.
- **Suggestion:** Re-align the implementation with the design spec by returning `429 Rate Limited` and injecting the calculated `Retry-After` header based on the oldest run's expiration delta, or update the spec to reflect the `503` behavior explicitly.

---

## 2. Cap Overlap and Memory Bounds
- **Observation:** `MAX_CONCURRENT_RUNS` is capped at 3, and `MAX_RUN_BYTES` is capped at 4 MB. 
- **Details:** If all 3 concurrent runs are fully populated, memory usage scales to 12 MB (excluding metadata/reports), which is extremely safe. However, as noted in the design review, a client feeding 20 sources of ~220 KB each will be blocked at the 16th source because of the 4 MB run budget.
- **Developer Warning:** The implementing developer should be aware that the 4 MB cap acts as a cumulative wall. If a client hits `413 Payload Too Large` midway through a feed, it must be handled gracefully by the client as a partial sweep or synthesis request.

---

## 3. Shared Auth Helper Reuse
- **Observation:** In **Task 12**, `handleBriefGet` is written to parse the bearer token manually:
  ```ts
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  ```
- **Suggestion:** Check if the helper `bearerToken(req)` used in `http-write-routes.ts` can be exported/shared or is already accessible to `http-server.ts`. Reusing the shared helper ensures consistent bearer parsing across write routes and read routes.

---

## 4. Quote Verification Normalization with surrogate pairs
- **Observation:** `normalizeForQuote` processes the string by iterating UTF-16 code units:
  ```ts
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    ...
  }
  ```
- **Details:** This structure maps indices correctly back to the original string for slicing. However, if a source contains characters outside the Basic Multilingual Plane (BMP) represented as surrogate pairs, `ch` will capture half of the surrogate pair.
- **Validation:** Since `GLYPHS` does not match surrogate halves and surrogate halves are not matched by `isSpace`, they are passed through to the normalized text unchanged. Their character offsets in both normalized and original text remain 1-to-1 mapped per code unit, ensuring string slicing via `body.slice(start, lastOrig + 1)` is safe and correct. No changes are strictly necessary here, but developers should keep this mapping characteristic in mind.
