# Review of Ownership Graph Design Spec

Here are the open questions, suggestions, and potential improvements identified during the review of [2026-08-06-ownership-graph-design.md](./2026-08-06-ownership-graph-design.md).

## Key Strengths

- **Clear Roadmap Correction:** Excellent analysis of the actual data indexing state versus the roadmap assumptions. Deriving ownership from `git_blame_line` rather than nonexistent PagerDuty team mappings is pragmatically correct.
- **Transitive Rollup Design:** Rolling up ownership from files to directories and services using weighted line totals (rather than simple averages of shares) avoids standard statistical skewing.
- **Parallel Work Isolation:** The separation of PR A (no IPC/CLI/Tauri changes) and PR B avoids collision with the concurrently active HTTP-agents PR.

---

## Open Questions & Design Suggestions

### 1. Vendor, Lock-file, and Generated-file Exclusion

- **Context:** The plan notes that vendored/generated files inflate a single author's share (whoever checked them in or ran the generator).
- **Suggestion:** Introduce an optional `ignore_globs` array in the `[ownership]` configuration (defaulting to standard lock-files and common generated folders, e.g. `["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml"]`). While filesystem roots may exclude `node_modules`, lock-files and check-in assets remain in the Git blame index and can heavily skew overall ownership statistics.

### 2. Tie-Breaking with Mixed Person ID Formats

- **Context:** The plan states: *"Ties are broken by person id ascending, so the emitted set is deterministic."*
- **Question:** How is this handled when there is a mix of resolved persons (using DB integer/UUID `person` IDs) and unresolved authors (using string-based `git:<normalized-email>` external IDs)?
- **Suggestion:** Explicitly state in the spec that the tie-breaker sorts by the graph entity's string external ID (or canonical representation) to ensure uniform sorting behavior regardless of whether the person was resolved.

### 3. Caching and Fallbacks for Git Remote Resolution

- **Context:** `repo-remote.ts` queries `git remote get-url origin` per root on every pass.
- **Suggestion:**
  - **Caching:** Running shell commands on every tick/sync pass can add latency. We should cache the resolved remote URL in-memory or in the DB per root, only re-querying it if a filesystem workspace sync detects a change or config refresh.
  - **Remote Fallbacks:** If `origin` is missing, the code should fall back to the first available remote (e.g. `upstream`), rather than yielding an empty remote and breaking the service rollup.

### 4. Graph Cleanup for Deleted/Moved Paths

- **Context:** The pass clears `owns` and `contains` relations for the roots it processes and re-emits them.
- **Question:** Does the clear operation also clean up the `directory` and `source_file` entities themselves if they no longer exist in the directory tree (e.g. after a file or folder is deleted/moved)? Or does it only delete relations? If entities remain as orphans, it might pollute the graph index over time.
