# Review of Ownership Graph — PR A (Derivation) Plan

Here are the open questions, suggestions, and performance improvements identified during the review of [2026-08-06-ownership-graph-pr-a-derivation.md](file:///C:/gitrep/Nimbus/.claude/worktrees/ownership-graph/docs/superpowers/plans/2026-08-06-ownership-graph-pr-a-derivation.md).

---

## Performance & Optimization Suggestions (Critical)

### 1. Compiling Globs Outside the Loop in `blame-aggregate.ts`

- **Context:** In Task 3, `aggregateBlameForRoot` calls `isIgnoredPath(r.file_path, opts.ignoreGlobs)` for every single row returned from `git_blame_line`. Inside `isIgnoredPath`, `new Bun.Glob(g)` is instantiated in a loop for every glob pattern.
- **Problem:** If a repository has tens of thousands of blame lines, instantiating `new Bun.Glob` millions of times (lines × ignore patterns) will cause significant CPU overhead and garbage collection pressure.
- **Suggestion:** Compile the glob patterns once at the beginning of `aggregateBlameForRoot` and pass the pre-compiled `Bun.Glob` instances to the matching logic:

  ```ts
  const compiledGlobs = opts.ignoreGlobs.map(g => new Bun.Glob(g));
  // In the loop:
  if (compiledGlobs.some(glob => glob.match(r.file_path))) { ... }
  ```

### 2. Bulk Database Queries Instead of Per-ID Loop in `ownership-pass.ts`

- **Context:** In Task 6, `clearOwnershipEdgesFor` and `reapOrphans` run multiple queries (`DELETE`, `SELECT`, `DELETE`) for *each* candidate ID in a loop:

  ```ts
  // clearOwnershipEdgesFor
  for (const id of entityIds) {
    dbRun(db, "DELETE FROM graph_relation WHERE to_id = ? ...", [id]);
    dbRun(db, "DELETE FROM graph_relation WHERE from_id = ? ...", [id]);
  }
  ```

- **Problem:** In large repositories with thousands of files and directories, executing individual queries in a loop will create massive overhead (query parsing, transaction overhead, IPC round-trips inside `dbRun`).
- **Suggestion:** Use bulk SQL operations to perform the entire clear and reap in a few flat queries:
  - **Clear relations:**

    ```sql
    DELETE FROM graph_relation 
    WHERE type IN ('owns', 'contains') 
      AND (to_id IN (SELECT id FROM graph_entity WHERE service = ?1)
           OR from_id IN (SELECT id FROM graph_entity WHERE service = ?1))
    ```

  - **Reap orphans (in one batch):**

    ```sql
    DELETE FROM graph_entity 
    WHERE service = ?1 
      AND type IN ('source_file', 'directory')
      AND id NOT IN (SELECT from_id FROM graph_relation)
      AND id NOT IN (SELECT to_id FROM graph_relation)
    ```

    *(Note: Be sure to return the count of deleted rows via SQLite `changes()` to maintain the `entitiesReaped` stat).*

### 3. Parallel Git Remote Spawning

- **Context:** In Task 6, `runOwnershipPass` iterates through `opts.roots` and sequentially `awaits resolveRepoRemote(root)`.
- **Problem:** Resolving the git remote spawns up to two shell subprocesses sequentially per root. If the user has 10+ git-aware roots, the sequential spawning of 20 subprocesses will block the pass progress for several seconds.
- **Suggestion:** Resolve the remotes in parallel before entering the main loop using `Promise.all`:

  ```ts
  const remotes = await Promise.all(
    opts.roots.map(async (root) => {
      const remote = await resolveRepoRemote(root, opts.spawn);
      return { root, remote };
    })
  );
  ```

---

## Open Questions

### 1. Re-run / Crash Safety of `simpleStep`

- **Context:** The migration registers V50 as a no-op and V51 to insert relation types and create `ownership_pass_state`.
- **Question:** Does the migration runner guarantee that if a crash occurs mid-V51 migration (e.g. after inserting relation types but before creating the table), the runner can resume safely? Since it uses `INSERT OR IGNORE` and `CREATE TABLE IF NOT EXISTS` inside a transaction, it should be safe, but it's worth double-checking that `migrateIndexedSchema` wraps the entire step execution in a transaction.
