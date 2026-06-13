# SonarCloud Cleanup 7 — Design Review

**Date:** 2026-06-13
**Target:** [2026-06-13-sonar-cleanup-7-design.md](./2026-06-13-sonar-cleanup-7-design.md)

---

## Open Questions & Suggestions

### 1. Correction for Rule S7781 Description

* **Problem:** The design document lists the description for rule **S7781** (in `sdk/src/distribution-channel.ts:59`) as `Set.has over multi-=== (verify rule intent)`.
* **Fact Check:** Sonar rule **S7781** actually flags using `String.prototype.replace()` with a global regular expression (e.g. `/\\/g`), suggesting the modern and cleaner `String.prototype.replaceAll()` instead.
* **Suggestion:** Update the design document to state the correct rule intent: replacing `.replace(/\\/g, "/")` with `.replaceAll("\\", "/")`. This is fully supported in Bun and ES2021+.

### 2. Pragmatic Skipping of Windows Tests in `obsidian-daily-note.test.ts:186`

* **Problem:** Rule **S5914** flags using an `expect(true).toBe(true)` placeholder in tests.
* **Suggestion:** Instead of keeping the inline platform check:

  ```typescript
  if (platform() === "win32") {
    expect(true).toBe(true);
    return;
  }
  ```

  We should use Bun's native test skipping features. Refactor the test definition to use `test.skipIf`:

  ```typescript
  test.skipIf(platform() === "win32")("resolveDailyNotePath emits a warning when daily-notes.json exists but is unreadable", () => {
    // Test body without any early returns or expect(true) sentinel placeholders
  });
  ```

  This is a cleaner test pattern, completely eliminates the code smell, and avoids executing dummy assertions.

### 3. Cognitive Complexity (S3776) Refactoring Strategies

* **`gateway/src/platform/assemble.ts:921` (`assemblePlatformServices`)**:
  * **Approach:** This function is ~230 lines long and handles a long chain of platform initializations sequentially.
  * **Suggestion:** Extract cohesive logical steps into private named helper functions inside `packages/gateway/src/platform/assemble.ts`. For instance:
    * `bootCoreStorage(paths)`: Handles directory creation, vault setup, and DB opening.
    * `bootPolicyAndAuditing(db, paths, auditCfg)`: Handles policy gate booting, tool call log retention, and the audit shipper.
    * `bootTribalKnowledge(rt, db, tribalCfg, syncLogger)`: Handles tribal knowledge watcher logic and synthesis mapping.
  * This preserves exact execution order, makes the bootstrap sequence highly readable, and dramatically reduces cognitive complexity.
* **`gateway/src/agents/huddle.ts:44` (`runHuddle`)**:
  * **Approach:** The complexity is concentrated in the triple-nested loop formatting contributions under query results.
  * **Suggestion:** Extract the nested processing loop into a dedicated helper function:

    ```typescript
    function aggregateContributions(queryResults: QueryResult[], cutoff: number): HuddleContribution[]
    ```

    This leaves `runHuddle` as a clean, high-level coordinator function.
* **`gateway/src/config/nimbus-toml.ts:1288` (`applyTribalEntry`)**:
  * **Approach:** This is a long `switch (key)` block.
  * **Suggestion:** Ensure the refactoring remains strictly behavior-preserving and is guarded by the config-parse tests. We can extract case handlers if the cognitive complexity remains high, or map the properties cleanly.

### 4. Collapse Identical Functions (S4144) in `nimbus-toml.ts`

* **Problem:** `applyQuorumKvLine` (line 1028) and `applyPreflightKvLine` (line 1211) have identical implementations.
* **Suggestion:** Remove both and replace them with a single helper function `applyKvLine` in `packages/gateway/src/config/nimbus-toml.ts`:

  ```typescript
  function applyKvLine(bucket: Record<string, string> | undefined, trimmed: string): void {
    if (bucket === undefined) return;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) bucket[kv.key] = kv.valRaw;
  }
  ```

  This cleanly resolves the duplication smell while keeping the code clean.

---

## Alignment with Invariants

* **I22/I25 Integrity:** All refactorings under `assemblePlatformServices` and tribal knowledge parsing must preserve the policy gate and tribal write-gate wiring.
* **Behavior Preservation:** Refactoring for cognitive complexity or duplication must not alter runtime side-effects or configuration validation. Per-package `tsc --noEmit` and the existing test suite serve as the definitive validator.
