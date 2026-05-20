# Phase 5 T2 PR 4 — Dependency resolution + V31 `extension_dependency` — Design

> **Status:** Draft (rev 1, post-brainstorm)
> **Author:** asafgolombek
> **Date:** 2026-05-20
> **Type:** Per-PR design (locks the implementation surface for `phase-5-t2-pr4-dependency-resolution`)
> **Parent:** [T2 sequencing spec](./2026-05-16-phase-5-t2-design.md) §2 PR 4
> **Predecessors:**
> - [T2 PR 1 sandbox design](./2026-05-16-phase-5-t2-pr1-sandbox-design.md) — merged 2026-05-17 (PR #329)
> - [T2 PR 2 verified-publisher design](./2026-05-17-phase-5-t2-pr2-verified-publisher-design.md) — merged 2026-05-18 (PR #343)
> - [T2 PR 3 auto-update design](./2026-05-19-phase-5-t2-pr3-auto-update-design.md) — merged 2026-05-20 (PR #367)

## Purpose

Extension manifests gain an optional `dependsOn: Record<string, string>` field where the string is a semver range. The installer expands the closure via a custom in-tree backtracking solver, validates that all version constraints are simultaneously satisfiable, refuses installs that introduce conflicts or cycles, and persists the resolved install graph in a new V31 `extension_dependency` table. Remove and auto-update paths consult the table's reverse-dependency index before mutating disk, refusing operations that would leave dangling deps unless explicitly overridden.

This PR introduces **no new structural security invariant**. It composes on top of I2 / I3 / I4 (HITL frozen set + gate semantics — the existing `extension.install`, `extension.autoUpdate`, and `extension.downgrade` action types cover every write path), I9 (bound SQL parameters for the new table), I14 (typed `dbRun` / `dbExec` for every write to `extension_dependency`), and I16 (PR 2's signature verification — the solver runs *after* signature verification on every closure node). PR 4's correctness gates are the property tests + the existing coverage thresholds, not a new I-numbered defense.

## Section 1 — Architecture overview

### 1.1 No new invariant

The solver and store add new files but no new structural defense:

- Every closure node is signature-verified (I16) before disk mutation — same code path PR 2 wired; no parallel install path.
- Every write to `extension_dependency` goes through `dbRun` / `dbExec` (I14); `D12` static audit catches violations.
- Every SQL statement uses bound parameters (I9); `D9` static audit catches violations.
- HITL coverage stays via the existing `extension.install` / `extension.autoUpdate` / `extension.downgrade` action types — no new HITL action type is added.
- LAN allowlist (I5), Tauri allowlist (I7), and HTTP write surface (I13) are **not** touched — dep resolution is a Gateway-internal layer behind the existing IPC surfaces.

PR 4's correctness gate is the `fast-check` property-test corpus (cycle / diamond / unsatisfiable / redundant fixtures) plus the `packages/gateway/src/extensions/` ≥85 % coverage threshold.

### 1.2 Component map

| New file | Role |
|---|---|
| `packages/gateway/src/extensions/dependency-types.ts` | Shared types: `ResolvedNode`, `InstallPlan`, `RegistryFetcher`, `DependencyConflict`, channel literals. |
| `packages/gateway/src/extensions/dependency-graph.ts` | Custom backtracking solver. Exports `resolveClosure(root, fetcher, opts)` → `Promise<InstallPlan>` (or throws a typed error). Pure module — the registry fetcher is injected for tests. |
| `packages/gateway/src/extensions/dependency-errors.ts` | Two typed error classes: `DependencyConflictError` (kinds: `cycle`, `unsatisfiable`, `range_invalid`) and `OfflineDependencyResolutionError`. Each carries enough structured fields for the CLI to render a human-readable message without re-parsing. |
| `packages/gateway/src/extensions/dependency-store.ts` | `dbRun` / `dbExec`-backed CRUD over the V31 `extension_dependency` table. Functions: `recordInstall(db, id, version, deps[])`, `clearDeps(db, id)`, `forwardDeps(db, id)`, `reverseDeps(db, id)`. I14-compliant. |
| `packages/gateway/src/extensions/registry-fetcher.ts` | Thin wrapper around the existing registry client that exposes `listVersions(id)` and `fetchManifest(id, version)` shaped exactly to `RegistryFetcher` so `dependency-graph.ts` stays decoupled. **Local-first**: an id that is currently installed resolves from on-disk state without a network call (§2.1, §2.3). |
| `packages/gateway/src/extensions/missing-dependency-registry.ts` | `MissingDependencyRegistry` singleton — parallel to `PreT2DisabledRegistry` (PR 1) and `SignatureDisabledRegistry` (PR 2). Tracks extensions hard-disabled by the §4.4 completeness guard with reason `dependency_missing` or `dependency_unsatisfied`. |
| `packages/gateway/src/index/extension-dependency-v31-sql.ts` | V31 migration SQL constant. The migration step `migrateIndexedV30ToV31` is added directly to `packages/gateway/src/index/migrations/runner.ts` and registered in `INDEXED_SCHEMA_STEPS` — Nimbus migrations are central in `runner.ts`, not separate `db/migrations/V<N>__*.ts` files. |
| `packages/gateway/src/index/migrations/runner-v31.test.ts` | V31 migration unit test, following the `runner-v30.test.ts` pattern (asserts table + index creation; round-trips a sample insert). |
| `packages/gateway/src/extensions/dependency-graph.test.ts` | Unit + `fast-check` property tests for the solver. |
| `packages/gateway/src/extensions/dependency-store.test.ts` | Integration tests over a real SQLite DB. |
| `packages/cli/src/commands/extension-tree.ts` | `nimbus extension list --tree` implementation (ASCII tree printer; respects `NO_COLOR`). |

| Modified file | Change |
|---|---|
| `packages/gateway/src/extensions/manifest-schema.ts` | Add `dependsOn?: Record<string, string>` field. Validator rejects entries whose value is not a syntactically valid semver range (delegated to the `semver` package's `validRange`). |
| `packages/gateway/src/extensions/install-from-local.ts` | After PR 2's signature verify, call `resolveClosure`. On success, install closure nodes leaf-first (each goes through the existing single-extension install path); after the whole closure is on disk, persist via `recordInstall` for each node in a single transaction. On `DependencyConflictError` / `OfflineDependencyResolutionError`: refuse before any disk mutation. |
| `packages/gateway/src/extensions/remove.ts` (or equivalent) | Before any disk delete, query `reverseDeps(id)`. If non-empty, refuse with the structured list unless `--force`. `--force` adds a stronger HITL preview entry (the existing `extension.uninstall` action type already gates the destructive part). |
| `packages/gateway/src/extensions/auto-update.ts` (PR 3) | Before applying an upgrade, run `resolveClosure` with `opts.activeConstraints` covering every installed extension (not just the bump's closure). If the bump would leave any reverse-dep unsatisfied, surface the conflict in the existing `extension.autoUpdate` HITL payload via a new optional `conflicts` field on `AvailableUpdate`. No new HITL action type. |
| `packages/gateway/src/extensions/verify-extensions.ts` | Extend the startup pass to run §4.4: (a) offline-safe dep-graph backfill from on-disk `manifest.json` for installed extensions missing `extension_dependency` rows; (b) completeness-guard walk that hard-disables extensions whose deps are missing or whose installed dep version no longer satisfies the recorded `range`. Both passes are network-free. |
| `packages/gateway/src/extensions/extension-info-rpc.ts` (or wherever `extension.info` lives today) | Return forward + reverse deps in the response so `nimbus extension info <id> --deps` and the Tauri Marketplace can render them. |
| `packages/cli/src/commands/extension.ts` | Add `--deps` flag to `info`; add `--tree` flag to `list` (dispatches to `extension-tree.ts`); add `--force` flag to `remove`. |
| `packages/gateway/src/security-invariants.test.ts` | Add an assertion that every `extension_dependency` write call site uses `dbRun` / `dbExec` (covered transitively by I14's `D12` static rule, but a direct test gives a localized failure message). |

### 1.3 Where the solver runs in the lifecycle

```
install request (id|tarball|url)
    │
    ▼
PR 1 sandbox-manifest validation (I15 wrap)
    │
    ▼
PR 2 signature verification (I16)
    │
    ▼
NEW: dependency-graph.resolveClosure(rootManifest, registryFetcher)
    │
    ├── throws DependencyConflictError      → refuse, zero disk mutation
    ├── throws OfflineDependencyResolutionError → refuse, zero disk mutation
    │
    ▼ InstallPlan { nodes: ResolvedNode[] }
    │
    ▼
for each ResolvedNode (leaf-first topological order):
    download tarball → signature verify (I16) → SHA-256 verify → unpack to active/
    │
    ▼
single dbRun transaction:
    recordInstall(node.id, node.version, node.deps[])  for each node
    │
    ▼
audit row: extension.install_complete (existing)
```

Auto-update applies the same shape with a single root: the bump candidate is the root of a closure that's almost always size 1 (most bumps don't introduce new deps); when the new version pulls in a new dep, the closure is walked exactly as on install.

## Section 2 — The solver

### 2.1 Inputs and outputs

```ts
export interface RegistryFetcher {
  // Local-first by contract: the production adapter (`registry-fetcher.ts`)
  // consults the on-disk extension state before any network call. If `id` is
  // currently installed, `listVersions(id)` returns `[installedVersion]` and
  // `fetchManifest(id, installedVersion)` reads the manifest from
  // `<extensions-root>/<id>/active/nimbus.extension.json`. Only when an id is
  // unknown locally does the adapter hit the remote registry.
  listVersions(id: string): Promise<readonly string[]>;
  fetchManifest(id: string, version: string): Promise<ExtensionManifest>;
}

export interface ResolvedNode {
  readonly id: string;
  readonly version: string;
  readonly deps: ReadonlyArray<{ id: string; range: string; resolvedVersion: string }>;
}

export interface InstallPlan {
  readonly nodes: readonly ResolvedNode[];  // topologically sorted, leaf-first
}

export function resolveClosure(
  root: ExtensionManifest,
  fetcher: RegistryFetcher,
  opts: {
    readonly installed: ReadonlyMap<string, string>;
    // EVERY currently-installed extension's `dependsOn` map, keyed by the
    // dependent's id. The solver seeds its constraint table with these *before*
    // walking the root's closure so that an install / upgrade cannot silently
    // violate a constraint owned by an installed extension that is not in the
    // closure of the new root (see §6 — upgrades must not break uninvolved
    // installed extensions).
    readonly activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
  },
): Promise<InstallPlan>;
```

`opts.installed` is the currently-installed `{id → version}` map. `opts.activeConstraints` is `{dependent-id → {dep-id → range}}` for every installed extension — including those *not* in the root's closure. The solver seeds its constraint table from `activeConstraints` first, then walks `root.dependsOn`. If a pin proposed for the new root violates a constraint contributed by some installed extension that isn't part of the new closure, the solver fails with `DependencyConflictError({ kind: "unsatisfiable", id, constraints })` — and the `constraints` list names the previously-installed dependent so the user sees which existing extension blocks the change.

The solver respects already-installed versions: if every constraint on a given id is satisfied by the installed version, the pin sticks without proposing a change.

### 2.2 Algorithm

The solver is a **recursive DFS with per-frame state clones**, not an iterative DFS-stack with hand-rolled state rollback. Per-frame cloning is the cheap, easy-to-verify pattern for backtracking — `pinned` and `ranges` are small Maps (≤ ~50 entries), so the clone is O(n) per frame and trivially correct. An iterative stack with manual undo bookkeeping is notoriously bug-prone for this exact shape.

Two state structures, both `Map<id, …>`:

- `pinned: Map<id, version>` — versions chosen so far.
- `ranges: Map<id, Array<{ from: string; range: string }>>` — every range constraint seen so far, with provenance.

**Cycle detection uses a separate `ancestors: Set<string>`** — the set of ids on the *current recursive call stack* (i.e. the active ancestor path from `root` to the frame being expanded). Cross-edges and forward-edges (diamond shape: `A → B`, `A → C`, both `B → D` and `C → D`) are valid and must not be flagged as cycles. `D` shows up twice in the visit order but never in the active ancestor path of itself.

```
solve(root, fetcher, opts):
  ranges = clone of opts.activeConstraints, flattened into ranges[id] entries
  pinned = clone of opts.installed
  ancestors = new Set()
  visit(root.id, root.dependsOn ?? {}, pinned, ranges, ancestors)
  return topologicalSort(pinned + every (dep-id, range) edge in ranges)

visit(id, deps, pinned, ranges, ancestors):
  ancestors.add(id)
  for (depId, range) in deps:
    if ancestors.has(depId):  # active path — true cycle
      throw DependencyConflictError({ kind: "cycle", chain: [...ancestors, depId] })
    range entry { from: id, range } is appended to ranges[depId]
    candidate = pickCandidate(depId, ranges[depId], pinned, fetcher)
      # pickCandidate uses pinned[depId] if it satisfies ranges[depId];
      # otherwise lists registry versions, picks the highest satisfying one;
      # if none, throws DependencyConflictError({ kind: "unsatisfiable", id: depId, constraints: ranges[depId] }).
    if candidate != pinned[depId]:
      # Backtrack point: clone the maps before recursing on a different pin,
      # and on conflict in the child, fall back to the next candidate here.
      childPinned = clone(pinned); childPinned.set(depId, candidate)
      childRanges = clone(ranges)
      depManifest = await fetcher.fetchManifest(depId, candidate)
      try { visit(depId, depManifest.dependsOn ?? {}, childPinned, childRanges, ancestors) }
      catch (conflict at depId or below) { try next candidate; if exhausted, rethrow }
      merge childPinned/childRanges back into pinned/ranges
    else:
      depManifest = await fetcher.fetchManifest(depId, candidate)
      visit(depId, depManifest.dependsOn ?? {}, pinned, ranges, ancestors)
  ancestors.delete(id)
```

The topological sort at the end is Kahn's algorithm over the pinned graph, emitting `InstallPlan.nodes` leaf-first.

**`fast-check` corpus**: random DAGs (≤ 15 nodes), random version-range overlaps, with seeded conflicts/cycles. Properties asserted:

- if a solution exists, the solver returns one with every pin satisfying every range;
- if a cycle exists (deliberately seeded by the generator), the solver returns `DependencyConflictError({ kind: "cycle", chain })` naming the cycle;
- if a conflict exists (deliberately seeded), the solver returns `DependencyConflictError({ kind: "unsatisfiable", id, constraints })` naming the package and the conflicting ranges;
- diamond DAGs (a node reachable via multiple paths) do **not** false-positive as cycles.

### 2.3 Offline behavior

The `RegistryFetcher` adapter is **local-first** (see §2.1): for any id that is currently installed, it returns the installed version + manifest without a network call. This means an offline install of a local `.tar.gz` extension that only depends on already-installed extensions resolves cleanly — no `RegistryUnreachableError` is ever thrown.

If a dep is *not* installed and the registry call throws `RegistryUnreachableError`, the solver halts and rethrows `OfflineDependencyResolutionError({ missingId, parent })` where `parent` is the manifest id that introduced the unresolved dep. The CLI renders:

```
Cannot install com.example.foo@1.0.0 — registry unreachable while resolving:
  └─ com.shared.utils  (required by com.example.foo)

Connect to the network and retry, or install com.shared.utils first.
```

No bundle file, no `extension extension cache` CLI, no local mirror. If demand materializes, that scope ships as a follow-up — the typed error is the minimum-viable contract.

### 2.4 Conflict reporting

The CLI renders unsatisfiable conflicts as:

```
Cannot install com.example.B@1.0.0:
  com.example.B@1.0.0 requires com.shared.A @^2.0.0
  com.example.C@1.0.0 requires com.shared.A @^1.0.0

Try `nimbus extension upgrade com.example.C` or `nimbus extension remove com.example.C` and retry.
```

No automated upgrade-suggestion fetch. The error names exactly which extension blocks the install; the user decides.

### 2.5 LOC budget

`dependency-graph.ts` targets 200–300 lines (algorithm + types + topological sort). `dependency-store.ts` targets 80–120 lines (four CRUD functions + bound-param SQL). `dependency-errors.ts` targets 40–60 lines (two error classes + structured fields).

## Section 3 — V31 schema

```sql
CREATE TABLE extension_dependency (
  extension_id  TEXT    NOT NULL,
  depends_on_id TEXT    NOT NULL,
  range         TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (extension_id, depends_on_id)
);
CREATE INDEX idx_extension_dependency_reverse
  ON extension_dependency (depends_on_id);
```

- **`extension_id`** — the dependent extension's id (matches `extension_state.id`).
- **`depends_on_id`** — the id of an extension this one requires.
- **`range`** — the semver range as declared in the dependent's manifest (e.g. `"^1.2.3"`). Resolved version lives in `extension_state.version` for the dep; we deliberately do not duplicate it here.
- **`created_at`** — unix ms; written on every `recordInstall` insert.

No backfill — empty rows mean "no declared deps". Legacy extensions installed before V31 have zero rows; their forward-dep queries return `[]` (correct: they had no `dependsOn` field). The migration is implemented as a new `migrateIndexedV30ToV31(db, now)` function added to `packages/gateway/src/index/migrations/runner.ts` and registered in `INDEXED_SCHEMA_STEPS` (the central migration runner — Nimbus does not use per-V `db/migrations/*.ts` files). The SQL constant lives in `packages/gateway/src/index/extension-dependency-v31-sql.ts`; the unit test sits next to the other migrations at `packages/gateway/src/index/migrations/runner-v31.test.ts` following the `runner-v30.test.ts` pattern. The migration is additive only and runs inside the runner's per-step transaction.

Reverse-dep query uses the index:

```sql
SELECT extension_id, range
FROM extension_dependency
WHERE depends_on_id = ?
```

Forward-dep query uses the primary key:

```sql
SELECT depends_on_id, range
FROM extension_dependency
WHERE extension_id = ?
```

## Section 4 — Install flow

### 4.1 Happy path

1. Manifest validated; signature verified (I16); sandbox manifest validated (I15 wrap on the resulting spawn, not at install time).
2. Build `opts.activeConstraints` by walking installed extensions' on-disk manifests' `dependsOn` maps; build `opts.installed` from `extension_state`.
3. `resolveClosure(rootManifest, registryFetcher, opts)` returns `InstallPlan`.
4. **Track this session's new unpack directories** in a `createdDirs: string[]` array. Wrap the per-node loop in a try-catch:
    - For each `node` in `plan.nodes` (leaf-first):
        - Download tarball; verify signature (I16); verify SHA-256.
        - Unpack to `<extensions-root>/<node.id>/active/` (or, when upgrading, into a fresh `_pending/<version>/` and only rename to `active/` after the whole closure unpacks — PR 3's two-slot layout).
        - Append the freshly-created directory path to `createdDirs`.
    - **On any thrown error in this loop**: walk `createdDirs` in reverse and `rm -rf` each entry (best-effort, log on failure). Then rethrow. This keeps the disk clean even if the startup validator never runs.
5. Open a single `db.transaction(() => { ... })`:
    - For each node: `recordInstall(db, node.id, node.version, node.deps)`.
    - Update `extension_state` rows (existing flow).
6. Emit one consolidated `extension.install_complete` audit row whose metadata JSON contains the explicit version map:
    ```json
    {
      "root": "com.example.foo",
      "rootVersion": "1.0.0",
      "installed": [
        { "id": "com.shared.utils",  "version": "1.5.0", "newlyInstalled": true,  "deps": {} },
        { "id": "com.shared.crypto", "version": "2.4.1", "newlyInstalled": true,  "deps": { "com.shared.utils": "^1.0.0" } },
        { "id": "com.example.foo",   "version": "1.0.0", "newlyInstalled": true,  "deps": { "com.shared.utils": "^1.2.3", "com.shared.crypto": "^2.0.0" } }
      ]
    }
    ```
    `newlyInstalled: false` for closure nodes whose installed version already satisfied the constraint and were therefore not re-downloaded. The version map enables future rollback / impact analysis without re-reading every manifest.

The transaction at step 5 means dep-graph persistence is all-or-nothing. The disk writes at step 4 are *not* in the transaction; a crash between step 4 and step 5 leaves disk and DB out of sync. The startup validator (§4.4) handles this.

### 4.2 Conflict path

`resolveClosure` throws `DependencyConflictError`. The CLI (or IPC caller) receives a structured error with `kind`, `id`, `constraints`, and (for cycles) `chain`. The installer renders the human-readable message from §2.4 / §2.3 templates. Zero disk mutation, zero DB mutation, zero audit row written for the failed install (consistent with the existing "install refused" path).

### 4.3 Offline path

`resolveClosure` throws `OfflineDependencyResolutionError({ missingId, parent })`. Same zero-mutation discipline; the CLI renders the §2.3 template. The error is also surfaced over IPC so the Tauri UI can show the same message in the Marketplace panel.

### 4.4 Startup integrity

Three things happen at every Gateway startup, after PR 2's signature-verify pass and before any extension can spawn. All three run **without network calls** so they work offline.

**Crash-recovery: disk-with-DB-row but no `extension_dependency` rows.** For each installed extension whose `extension_state` row is present but which has zero rows in `extension_dependency`, read its on-disk `manifest.json`. If `dependsOn` is present and non-empty, populate `extension_dependency` directly from the manifest (one row per `(extension_id, depends_on_id, range, now)` tuple) inside a single `dbRun` transaction. **Crucially: this path does not call `resolveClosure` and does not hit the registry.** It trusts the on-disk manifest as authoritative — the same posture PR 2's signature-verify already takes when it accepts the manifest as canonical. If `dependsOn` is absent, no rows are written (matches the "absence == zero deps" rule from §3).

**Crash-recovery: disk-without-DB-row.** Existing pre-PR-4 behavior — hard-disable via the existing registry. No change.

**Completeness guard: dangling deps.** Walk every row in `extension_dependency`. For each row, check that:
1. The `depends_on_id` extension is currently installed (`extension_state` row present and not hard-disabled).
2. The installed version satisfies the row's `range` (semver-range check).

A row failing either check causes the **dependent** extension (the `extension_id`) to be hard-disabled via a new `MissingDependencyRegistry` (parallel to PR 1's `PreT2DisabledRegistry` and PR 2's `SignatureDisabledRegistry`) with reason `dependency_missing` or `dependency_unsatisfied`. The reason carries the failing dep id + range + observed version so the operator sees exactly why. `nimbus extension list` shows the disabled extension with the reason. Re-installing the missing dep (or upgrading it to a satisfying version) clears the disabled state on the next startup pass.

This is the only structural defense against `--force` remove or external disk tampering leaving a dependent extension to run with broken deps.

## Section 5 — Remove flow

`nimbus extension remove <id>`:

1. `reverseDeps(db, id)` query.
2. If non-empty and no `--force`: refuse with the structured list.
3. If empty (or `--force`): proceed through the existing remove path (PR 2's signature-disabled cleanup, vault-key cleanup, audit log).
4. After successful remove: `clearDeps(db, id)` in the same transaction as the existing remove-side DB writes.

`--force` removes the dep-graph guard but does *not* skip HITL — the existing `extension.uninstall` action type (or equivalent) still fires. The HITL preview gains a `"will leave dangling deps for: [B@1.0.0, C@2.1.0]"` line so the user sees the consequence before approving.

The remove error message:

```
Cannot remove com.shared.A — required by:
  com.example.B@1.0.0
  com.example.C@2.1.0

Run `nimbus extension remove com.example.B`, then `nimbus extension remove com.example.C`,
then retry — or pass `--force` to leave dangling deps.
```

`nimbus extension remove` stays single-id in PR 4 (matches the existing CLI surface; batch-remove is not the right scope to fold into a dependency-resolution PR). The error names the blockers in dependency-leaf order so the user can resolve sequentially.

## Section 6 — Auto-update flow

`extension.checkForUpdates` (PR 3): the auto-update cache entries gain an optional `conflicts?: ReadonlyArray<DependencyConflict>` field, populated when the candidate bump's `dependsOn` is unsatisfiable against the current installed set. The field is computed at cache-write time, not at apply time, so the CLI can render conflicts as a warning column.

`extension.update` (PR 3): before fetching the tarball, call `resolveClosure` against the proposed new manifest with `opts.installed` AND `opts.activeConstraints` populated from **every** installed extension's `dependsOn` map — including extensions outside the bump's closure. The new constraint context is exactly what catches the case where bumping `A@1.5.0 → A@2.0.0` introduces `B@^2.0.0` but a third installed extension `C@1.0.0` (not in `A`'s closure) requires `B@^1.0.0`. Without `activeConstraints`, the solver would silently pin `B` to 2.0.0 and break `C` at runtime. If the closure introduces new transitive deps, install them leaf-first as in §4.1. If the bump conflicts with an already-installed reverse-dep, surface the conflict in the existing `extension.autoUpdate` HITL payload (`conflicts` field on the action's `details`) — the user sees the conflict in the consent dialog and can reject. On rejection: zero disk mutation.

No new HITL action type. PR 3's `extension.autoUpdate` and `extension.downgrade` action types cover this path.

## Section 7 — CLI surface

```
nimbus extension install <id|tarball|url>
nimbus extension remove <id> [--force]
nimbus extension info <id> [--deps]
nimbus extension list [--tree]
```

- `--deps` adds a "Dependencies" section to `info`:

  ```
  Dependencies (forward):
    com.shared.utils  ^1.2.3  → 1.5.0
    com.shared.crypto ^2.0.0  → 2.4.1

  Dependents (reverse):
    com.example.bar   wants ^0.5.0
  ```

- `--tree` prints the installed forest:

  ```
  com.example.foo@1.0.0
  ├─ com.shared.utils@1.5.0
  │  └─ com.shared.crypto@2.4.1
  └─ com.shared.crypto@2.4.1  (already shown)
  ```

  ASCII only; respects `NO_COLOR` (per the standard CLI rendering rule). Cycle-safe via a `Set<id>` of already-printed nodes.

- `--force` on `remove` bypasses the reverse-dep refusal; HITL still fires; the preview names the now-dangling deps.

No new IPC methods. The existing `extension.info`, `extension.list`, `extension.remove`, `extension.install`, `extension.checkForUpdates`, `extension.update` cover the surface; their response shapes gain optional `forwardDeps` / `reverseDeps` / `conflicts` fields.

## Section 8 — Cross-cutting (recap from T2 sequencing spec)

| Concern | Disposition |
|---|---|
| **I2 / I3 / I4** (HITL) | No new action type. `extension.install`, `extension.autoUpdate`, `extension.downgrade`, `extension.uninstall` already cover write paths. |
| **I5** (LAN allowlist) | No new methods. Dep resolution is Gateway-internal behind the existing IPC surfaces. |
| **I7** (Tauri allowlist) | No new methods. `allowlist_exact_size` stays at 62 (PR 3's number). |
| **I9** (bound SQL parameters) | Every `extension_dependency` query uses bound parameters. `D9` static audit catches violations. |
| **I11** (tool-output envelope) | Untouched — no new LLM-facing surface. |
| **I13** (HTTP write surface) | Untouched. |
| **I14** (typed `dbRun`) | Every `extension_dependency` write goes through `dbRun` / `dbExec`. `D12` static audit catches violations. |
| **I15** (sandbox runner intrinsic) | Untouched — solver runs Gateway-side, not in an extension. |
| **I16** (signature verification) | Every closure node is verified on download before its tarball lands on disk; same code path PR 2 wired. |

**Coverage gates**:

| Subsystem | Bun script | Threshold |
|---|---|---|
| Extensions (existing) | `bun run test:coverage:extensions` | ≥ 85 % |
| New solver + store (`dependency-*.ts`) | rolled into the same gate | ≥ 85 % targeted in this PR |

**Migration numbering**: V31. T6 used V30 (vec_items_1536); this is next sequential. Migration file: `packages/gateway/src/db/migrations/V31__add_extension_dependency.ts`. SQL constant: `packages/gateway/src/index/extension-dependency-v31-sql.ts`. Pattern: one `up(db)` function, append-only, no `down()`.

## Section 9 — Roadmap interactions

When this PR merges:

- Flip the `T2 PR 4` sub-checkbox in `docs/roadmap.md` to `[x]` with `(2026-MM-DD, PR #NNN, Phase 5 T2 PR 4)`.
- Extend the `Last updated:` header at `roadmap.md:7` with `T2 PR 4 ✅ (<date>)`.
- Update the `Status:` line in `CLAUDE.md:10` (and `GEMINI.md` mirror).
- Append a row to the "Phase 5 T2" status line: `T2 PR 4 ✅`.

When PR 5 merges (T2 complete), the four `T2 PR<N> ✅` entries consolidate to `T2 ✅`.

## Section 10 — Out of scope (locked)

- **Peer dependencies** — declared on parent, satisfied at parent's resolution time. Out of T2.
- **Optional dependencies** — out of T2.
- **Workspace-mode linking** — N/A; extensions are not workspace packages.
- **Automatic upgrade of conflicting installs** — user explicitly upgrades; the conflict report names the blocker but does not auto-fetch newer versions or auto-resolve.
- **Air-gap cache / bundle file** — typed `OfflineDependencyResolutionError` is the minimum-viable contract. `nimbus extension cache <id>` and `.bundle.tgz` formats are deferred follow-ups.
- **Runtime `node_modules` deps** — extension authors' concern, not Nimbus's.
- **Cross-publisher dep restrictions** — an extension from publisher A can depend on publisher B's extension without restriction. Trust posture is per-extension (I16), not per-graph.
- **Dep graph visualization in the Tauri UI beyond a forward/reverse list** — `--tree` ships in the CLI; richer UI deferred.
- **Manifest fuzz testing for the solver** — `fast-check` corpus covers cycle/diamond/unsatisfiable/redundant *valid-manifest* shapes. Adversarial manifest parsing is covered by the existing manifest-schema validator and PR 2's signature verification.

## Section 11 — Exit criteria

- `dependency-graph.test.ts` passes including the `fast-check` property corpus (cycle / diamond / unsatisfiable / redundant).
- `dependency-store.test.ts` passes against a real SQLite DB; reverse-dep queries return correct results for the seeded fixtures.
- V31 migration applies cleanly against a Phase 5 T6-baseline DB and rolls back per the runner contract on a deliberately-thrown error.
- Install integration test: a fixture with `B@1.0.0` depending on `A@^1.0.0` installs both leaf-first; both rows land in `extension_dependency`.
- Install integration test (partial-failure cleanup): tarball download fails on the 3rd of 5 closure nodes; the test asserts the freshly-unpacked directories from this session are removed and that startup does not show any dangling extension state.
- Install integration test (offline-local-tarball): with `A` already installed and the registry network-isolated, installing a local `.tar.gz` of `B@1.0.0` (which depends on `A@^1.0.0`) succeeds without any `RegistryUnreachableError`.
- Solver unit test (diamond DAG): `A → B`, `A → C`, both `B → D` and `C → D`; the solver returns an `InstallPlan` and does not false-positive a cycle.
- Solver unit test (global constraint): an upgrade `A@1.5.0 → A@2.0.0` whose new closure includes `B@^2.0.0` is rejected because installed `C@1.0.0` requires `B@^1.0.0`. The error names `C` even though `C` is not in `A`'s new closure.
- Remove integration test: `nimbus extension remove A` refuses while `B` is installed; `--force` overrides; HITL preview includes the dangling-deps line.
- Auto-update integration test: a bump from `A@1.5.0` → `A@2.0.0` is refused (in HITL preview) when `B@1.0.0` requires `A@^1.0.0`; the conflict surfaces in the existing `extension.autoUpdate` payload.
- Startup-integrity test (offline-safe dep-graph backfill): pre-PR-4 install state (extension on disk, zero `extension_dependency` rows) starts up offline; the on-disk `manifest.json` `dependsOn` is parsed and populated directly into the table without any network call.
- Startup-integrity test (completeness guard): `nimbus extension remove A --force` while `B` requires `A@^1.0.0`; on next startup, `B` is hard-disabled via `MissingDependencyRegistry` with reason `dependency_missing`; reinstalling `A` clears the disabled state on the following startup.
- Audit integration test: a successful closure install of `A → B → C` emits one `extension.install_complete` audit row whose metadata JSON carries the full version map (one entry per closure node, with `newlyInstalled` flags correct).
- `bun run test:coverage:extensions` ≥ 85 % stays green.
- `bun run audit:invariants` green (D9, D12, all `D*` rules).
- `bun run test:ci` green on the 3-OS push matrix.

## Section 12 — Review disposition (2026-05-20)

Source: [`2026-05-20-phase-5-t2-pr4-dependency-resolution-design-review.md`](./2026-05-20-phase-5-t2-pr4-dependency-resolution-design-review.md).

| Review § | Item | Disposition | Where in this spec |
|---|---|---|---|
| 1.1 | Migration path / naming pattern | **FIX** — verified against `packages/gateway/src/index/migrations/runner.ts`. The original SQL constant path was correct; the spurious `db/migrations/V31__*.ts` reference is removed. Migration becomes a new `migrateIndexedV30ToV31` step registered in `INDEXED_SCHEMA_STEPS`. | §1.2 new-files table, §3 |
| 2.1 | DFS cycle context — active ancestor path vs visited set | **FIX** — added explicit `ancestors: Set<string>` distinct from `pinned: Map`. Diamond DAGs no longer false-positive. | §2.2 algorithm + pseudocode |
| 2.2 | Recursive DFS with per-frame state clones | **FIX** — locked recursive DFS with per-frame `clone(pinned)` / `clone(ranges)` as the implementation pattern; rejected iterative-stack-with-undo. | §2.2 algorithm |
| 2.3 | Global constraint context for upgrades | **FIX** — `resolveClosure` signature gains `opts.activeConstraints: ReadonlyMap<id, ReadonlyMap<dep-id, range>>` covering *every* installed extension. The auto-update path passes it. Conflicts name the previously-installed dependent. | §2.1 signature, §6 auto-update flow |
| 3.1 | Offline install of locally-available deps | **FIX** — `RegistryFetcher` adapter is local-first by contract. Installed ids resolve from on-disk manifests without network. | §1.2 (new-files table), §2.1 doc-comment on `RegistryFetcher`, §2.3 |
| 3.2 | Offline-safe startup DB recovery | **FIX** — startup recovery reads `dependsOn` from on-disk `manifest.json` directly and writes rows via `dbRun`. No `resolveClosure` call, no registry call at startup. | §4.4 — Crash-recovery, network-free |
| 3.3 | Partial install failures (cleanup) | **FIX** — install loop wraps node unpacks in try-catch; on failure, freshly-created directories from this session are removed (best-effort) before rethrow. | §4.1 step 4 |
| 4.1 | Startup completeness guard for dangling deps | **FIX** — new §4.4 completeness-guard walks every `extension_dependency` row and hard-disables dependents whose deps are missing or version-incompatible, via a new `MissingDependencyRegistry` (parallel to PR 1/PR 2 patterns). | §4.4 + §1.2 new-files row |
| 4.2 | Audit metadata for bulk installs | **FIX** — `extension.install_complete` audit row's metadata JSON now carries the explicit version map: `{ root, rootVersion, installed: [{ id, version, newlyInstalled, deps }] }`. | §4.1 step 6 |

**Net effect:** four correctness fixes (migration path; ancestor-path cycle detection; global constraint context; offline-safe recovery), three robustness improvements (local-first fetcher; partial-install cleanup; startup completeness guard), and two clarity additions (recursive-DFS algorithm shape; audit-metadata version map). None of the brainstorming-locked decisions changed; the design is tighter on every axis the review flagged.

## See also

- [`../../roadmap.md`](../../roadmap.md#extension-marketplace-v2) — Phase 5 T2 PR 4 row.
- [`./2026-05-16-phase-5-t2-design.md`](./2026-05-16-phase-5-t2-design.md) §2 PR 4 — parent sequencing spec.
- [`../../SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md) — I9, I14, I16.
- [`../../../.claude/commands/nimbus-db-migrations.md`](../../../.claude/commands/nimbus-db-migrations.md) — V31 migration authoring.
- [`../../../.claude/commands/nimbus-security-invariants.md`](../../../.claude/commands/nimbus-security-invariants.md) — invariant triple rule (no new invariant in this PR).
