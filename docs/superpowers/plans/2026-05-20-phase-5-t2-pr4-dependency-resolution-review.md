# Review: Phase 5 T2 PR 4 — Dependency resolution + V31 `extension_dependency` Implementation Plan

Overall, the plan is extremely well-structured and aligns perfectly with the established architectural constraints (I9, I14, I16). It maintains the local-first philosophy and uses appropriate property testing (`fast-check`) to ensure correctness.

Here are a few open questions, suggestions, and improvements to consider before or during implementation:

## 1. Graph Sorting Performance (Task 3)
In Kahn's algorithm for topological sorting, `queue.sort()` is called at the end of every iteration.
* **Suggestion:** While acceptable for small DAGs (e.g., ≤ 15 nodes as tested), calling sort on every iteration is computationally expensive (`O(V^2 \log V)`). If the extension ecosystem is expected to grow to larger dependency trees, consider using a Min-Heap/Priority Queue which reduces the cost significantly while maintaining a stable leaf-first order.

## 2. Crash Consistency and Cleanup (Task 9)
In Task 9, the rollback logic (`for (const d of [...createdDirs].reverse())`) is a best-effort cleanup on failure.
* **Open Question:** What happens if the Gateway process crashes (e.g., OOM, power loss, forced termination) right before the `db.transaction()` but after unpacking some extensions to their `active/` directories? 
* **Improvement:** Consider whether a startup integrity check (perhaps as part of the `MissingDependencyRegistry` guard or a separate garbage collection pass) should sweep the extensions folder for dangling `active/` directories that have no corresponding row in the `extension_state` table.

## 3. Local Manifest Validation (Task 7)
The local-first adapter (`createRegistryFetcher`) reads the `nimbus.extension.json` using `JSON.parse` but does not seem to pass it through `parseManifest` (the Zod schema).
* **Suggestion:** Even though the manifest was validated upon initial installation, disk corruption or manual user tampering could break the schema. Consider wrapping the parsed result with a lightweight structural check or the official `parseManifest` schema to ensure the `dependsOn` field is still safe to consume.

## 4. Conflict Error Context (Task 2)
* **Improvement:** In `DependencyConflictError`, it might be helpful to expose not just the raw `constraints` that caused the failure, but also the versions that *were* available from the registry. This makes it much easier for end-users or connector authors to debug an `unsatisfiable` conflict directly from CLI output.

## 5. Reverse Dependency Check Edge Case (Task 10)
When a user attempts to remove an extension via `--force`, the plan correctly populates `details.danglingDeps` for the HITL review. 
* **Suggestion:** Ensure the `MissingDependencyRegistry` startup guard (Phase G, not fully visible but referenced) handles these intentionally dangling dependents gracefully upon next startup by successfully identifying them and disabling them, rather than crashing the Gateway.
