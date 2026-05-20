# Phase 5 T2 PR 4 — Dependency Resolution — Design Review

**Status:** Under Review
**Reviewer:** Gemini CLI
**Date:** 2026-05-20
**Target Design:** [2026-05-20-phase-5-t2-pr4-dependency-resolution-design.md](./2026-05-20-phase-5-t2-pr4-dependency-resolution-design.md)

---

## Summary

The design for dependency resolution and the V31 `extension_dependency` store provides a robust, local-first solution to managing extension interdependencies. The solver maintains structural security invariants, leverages existing HITL action gates, and introduces a custom backtracking solver to prevent cycles, version conflicts, and unsatisfiable installations.

Below are critical corrections, structural suggestions, and open questions to refine the implementation prior to code execution.

---

## 1. Critical Corrections & File Paths

### 1.1 DB Migration Path and Naming Pattern
* **Issue:** Section 1.2 and Section 8 list the migration file as `packages/gateway/src/db/migrations/V31__add_extension_dependency.ts`.
* **Correction:** In Nimbus, database migrations are centrally managed in `packages/gateway/src/index/migrations/runner.ts`. Individual migrations are not stored in separate `db/migrations/` files. The SQL schema constant should be placed in `packages/gateway/src/index/extension-dependency-v31-sql.ts`, and the migration step function `migrateIndexedV30ToV31` should be added to `runner.ts`. The matching test file must be created at `packages/gateway/src/index/migrations/runner-v31.test.ts` (following the `runner-v30.test.ts` pattern).

---

## 2. Solver & Algorithm Clarifications

### 2.1 DFS Cycle Checking Context
* **Observation:** In Section 2.2 step 2.1: *"If `depId` is on the current DFS stack → `DependencyConflictError`"*.
* **Question:** Is the DFS stack defined as the *active recursive stack (ancestor path)* or the set of all visited nodes? 
* **Details:** In dependency graphs, cross-edges and forward-edges are valid (e.g., `A` depends on `B` and `C`; both `B` and `C` depend on `D`). D is visited twice but there is no cycle. The cycle check must explicitly track nodes in the *current ancestor path* rather than overall visited nodes.
* **Suggestion:** Clarify in the design that the DFS stack represents active ancestors (using a path tracker set), whereas resolved/pinned nodes are kept in a separate lookup map.

### 2.2 Backtracking State Management
* **Observation:** Section 2.2 describes an iterative DFS stack: *"Pop a frame... Push onto stack... If candidate differs → backtrack"*.
* **Suggestion:** Managing and reverting state (like `pinned` and `ranges` history) is notoriously error-prone when using an iterative DFS loop. Using a simple recursive DFS helper function that accepts copy-on-write Maps (or clones them per stack frame) makes state restoration on backtracking trivial, self-contained, and easier to debug.

### 2.3 Global Constraint Context for Upgrades
* **Observation:** The `resolveClosure` signature in Section 2.1 is:
  ```ts
  export function resolveClosure(
    root: ExtensionManifest,
    fetcher: RegistryFetcher,
    opts: { readonly installed: ReadonlyMap<string, string> },
  ): Promise<InstallPlan>;
  ```
* **Issue:** When upgrading an extension (e.g., `A@1.5.0` → `A@2.0.0`), the upgrade might bring in a new version of a shared dependency `B`. If `B` is also required by another installed extension `C` (which is not part of the `A` closure), the solver might upgrade `B` to a version that violates `C`'s range constraints.
* **Suggestion:** The solver needs visibility of all existing constraints from all installed extensions.
  We suggest expanding the signature to pass currently active dependency constraints:
  ```ts
  opts: {
    readonly installed: ReadonlyMap<string, string>;
    readonly activeConstraints?: ReadonlyMap<string, ReadonlyArray<{ from: string; range: string }>>;
  }
  ```
  This prevents upgrades from silently breaking other extensions.

---

## 3. Offline & Recovery Robustness

### 3.1 Offline Installation of Cached/Local Dependencies
* **Observation:** Section 2.3 notes: *"If any call to `fetcher.listVersions` or `fetcher.fetchManifest` throws ... halt and rethrow `OfflineDependencyResolutionError`"*.
* **Scenario:** If a user is offline and wants to install a local `.tar.gz` extension that depends on `utils` (which is already installed locally), the registry fetcher would try to hit the network for `utils` and crash.
* **Suggestion:** The `RegistryFetcher` (or its adapter `registry-fetcher.ts`) should resolve manifest inquiries from local disk metadata (for already-installed extensions) before querying the remote registry. This makes the solver network-independent for dependencies that are already present.

### 3.2 Offline-Safe Startup DB Recovery
* **Observation:** Section 4.1 says: *"we handle disk-without-`extension_dependency` rows by re-running `resolveClosure` against the installed closure and inserting the inferred rows"*.
* **Issue:** Re-running `resolveClosure` on startup will fail if the machine is offline (due to registry queries), potentially locking the user out of their extensions.
* **Correction:** Startup DB recovery should read the local `manifest.json` files from disk (where the declared `dependsOn` constraints are readily available) and populate the DB directly, bypassing both the remote registry and the backtracking solver.

### 3.3 Partial Installation Failures (Cleanup)
* **Observation:** Section 4.1 performs disk unpacking leaf-first *before* the DB transaction writes are committed.
* **Issue:** If downloading the 3rd out of 5 extensions fails, we are left with orphaned directories on disk (unpacked but not in `extension_state`).
* **Suggestion:** Wrap the download/unpack loop in a try-catch block and perform a cleanup of directories newly created during this install session on failure, rather than relying solely on the startup validator to flag them as unverified/disabled later.

---

## 4. Lifecycle & Runtime Validation

### 4.1 Startup Completeness Guard (Handling Dangling Dependencies)
* **Scenario:** If a user overrides a removal with `--force` or manually tampers with disk directories, a dependent extension is left with missing dependencies.
* **Question:** Does the startup check (`verify-extensions.ts`) validate dependency completeness?
* **Suggestion:** At startup, Nimbus should verify that all targets in `extension_dependency` are active. If an extension's dependency is missing or has an incompatible version, the dependent extension should be disabled automatically with a warning, preventing runtime execution crashes.

### 4.2 Audit Trail for Bulk Operations
* **Observation:** Section 4.1 specifies: *"Emit one consolidated `extension.install_complete` audit row referencing every installed node."*
* **Improvement:** Ensure the audit log row metadata lists the exact version mapping of all installed dependencies (e.g. `{"id": "com.example.foo", "dependencies": {"com.shared.utils": "1.5.0"}}`) for future auditing and rollback tracking.
