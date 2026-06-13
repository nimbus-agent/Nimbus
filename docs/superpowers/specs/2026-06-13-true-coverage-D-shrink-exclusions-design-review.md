# Review: True Coverage — Sub-project D: Shrink exclusions — Design

**Date:** 2026-06-13  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Review Completed  
**Target Spec:** [`2026-06-13-true-coverage-D-shrink-exclusions-design.md`](./2026-06-13-true-coverage-D-shrink-exclusions-design.md)

---

## 1. Executive Summary

The design for Sub-project D (Shrink Exclusions) is highly disciplined, focusing on an "honest-shrink" philosophy that rejects vanity coverage in favor of meaningful DI-based tests. The triage of the ~40 files in `exclusions.ts` into clear categories (DI-refactorable, type-only, test-only, and genuinely-untestable) is precise.

We have reviewed the design and identified a few key points of note and recommendations regarding security boundaries, process state helpers, worker deserialization safety, and file renaming.

---

## 2. Detailed Feedback & Suggestions

### 2.1. Invariant Boundary Protection on DI Seams (§3a)

- **Observation:** `team-tool-spawn.ts` (under I19) and `chatops-bot-spawn-call.ts` (under I15/I23) are security-sensitive paths.
- **Recommendation:** When injecting mock spawners/clients, ensure the tests explicitly assert that security context rules remain intact. For example, verify that the mock environment still rejects unauthorized actions or inputs if they bypass the wrapper, confirming that the DI seam only mocks execution results and does not bypass environment checks (I1/I15/I19).

---

### 2.2. Test State Cleanup for `gateway-process.ts` (§3a)

- **Observation:** `gateway-process.ts` manages state-file helper functions (`gatewayStatePath`, `ensureGatewayDirs`, etc.).
- **Recommendation:** In the unit tests for `gateway-process.ts`:
  1. Ensure all file operations (reads/writes/directories) target temporary directories created dynamically during the test run (e.g. using `os.tmpdir()` or a project-local temp dir).
  2. Implement comprehensive `afterEach` or `afterAll` cleanup to delete these state files, preventing test pollution.
  3. Ensure testing of `isProcessAlive` handles OS differences (e.g., checking own process PID `process.pid` vs an invalid PID, handling potential `ESRCH` or `EPERM` errors gracefully).

---

### 2.3. Deserialization and Queue Safety for extracted Worker Core (§6)

- **Observation:** The plan proposes extracting `embedding-worker.ts` logic into a pure sibling `EmbeddingWorkerCore`.
- **Recommendation:** Worker realms communicate using serialized message events. When testing `EmbeddingWorkerCore` directly:
  1. Verify the serialization/deserialization boundaries of the message queue.
  2. Specifically test that malformed payloads or failed task promises inside the queue do not result in unhandled rejections or silent failures, which would crash the background thread under normal execution.

---

### 2.4. File Relocation Hygiene (§3c)

- **Observation:** Relocating test-helpers (e.g., `identity-test-helpers.ts` under a `testing/` directory) automatically exempts them from coverage checks.
- **Recommendation:** Proactively use Git renaming (`git mv`) rather than deleting and creating files. This preserves git history and ensures that diffs remain clean and readable during the PR review process.

---

## 3. Conclusion

The Sub-project D design is approved. The proposed categorization and slicing strategy are logical and ready to guide the implementation of the final True Coverage milestone.

---

## 4. Dispositions (applied 2026-06-13)

All four points dispositioned **FIX** (corrected in the spec); none rejected. Empirically
validated before recording.

- **2.1 Invariant boundary on DI seams → FIX (§7).** Strengthened the security-invariants bullet:
  D1 tests must assert the **default (no-injection) path resolves the real spawner/builder** (so I1
  `extensionProcessEnv` + I15 `wrapServerSpec` still run on the real path), the fake is test-only
  with no production behavior change, and `security-invariants.test.ts` + `audit:invariants` stay
  green in the same PR. **EXPLAIN nuance recorded in-spec:** the I19/I15 authorization *gate* is
  upstream (`invoke-gate.ts` / `lazy-mesh`), not inside `spawnTeamToolAndCall` /
  `spawnChatopsBotToolAndCall` — those run **post-gate** (verified during the empirical review). So
  the assertion is "the seam does not relocate/weaken the spec-build," not "the spawn fn re-checks
  authorization." The recommendation is honored with this correct framing.

- **2.2 `gateway-process.ts` test hygiene → FIX (§7).** Added a file-based-helper testing bullet:
  `mkdtempSync(join(tmpdir(),…))` temp dirs + `afterEach` cleanup; `isProcessAlive` via own
  `process.pid` (alive) + unused PID (dead). **Empirical note:** the current `process.kill(pid,0)`
  catch treats **EPERM** as not-alive (process exists but no permission) — D **characterizes
  existing behavior** (zero behavior change per §7); any EPERM-semantics fix is a separate
  follow-up, out of D scope (flagged in-spec).

- **2.3 `EmbeddingWorkerCore` queue/payload safety → FIX (§6).** Added explicit test requirements:
  cover malformed/unknown message payloads and a **failed task promise in the `embedChain` queue**,
  asserting **no unhandled rejection** + **no silent failure** (error surfaced/posted back, queue
  keeps draining). The `embedChain` serialized promise queue was confirmed real during the spec's
  own empirical review, so this concern is well-founded.

- **2.4 File-relocation hygiene (`git mv`) → FIX (§3c).** Spec now mandates relocating the test
  helpers via `git mv` to preserve history + keep the diff clean.
