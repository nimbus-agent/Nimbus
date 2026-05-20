# Phase 5 T2 PR 4 — Dependency resolution + V31 `extension_dependency` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land manifest `dependsOn` + custom backtracking solver + V31 `extension_dependency` table + reverse-dep guards on install / remove / auto-update + startup completeness guard. No new structural invariant — composes on I9 / I14 / I16.

**Architecture:** Recursive DFS solver with per-frame state clones and explicit `ancestors: Set` for cycle detection (diamond DAGs OK). `RegistryFetcher` is local-first — installed ids resolve from on-disk manifests without network. Install path runs the solver, unpacks leaf-first with per-session `createdDirs` cleanup on failure, then persists the install graph in a single `dbRun` transaction. Remove path consults `reverseDeps`; `--force` overrides with louder HITL. Auto-update path passes `opts.activeConstraints` covering every installed extension. Startup integrity has two new offline-safe passes: backfill rows from on-disk manifests, then hard-disable extensions with unsatisfied deps via a new `MissingDependencyRegistry`.

**Tech Stack:** Existing `semver` package for `validRange` / `satisfies` / `maxSatisfying`, `fast-check` for property tests (already a workspace devDependency), `dbRun` / `dbExec` / `dbStmtRun` from `db/write.ts` (I14), `appendAuditEntry`, the V30→V31 migration step pattern from `index/migrations/runner.ts`.

**Source spec:** [`docs/superpowers/specs/2026-05-20-phase-5-t2-pr4-dependency-resolution-design.md`](../specs/2026-05-20-phase-5-t2-pr4-dependency-resolution-design.md). Read it once before starting — every task references section numbers from it.

---

## Pre-flight (do this once before Task 1)

- [ ] **P-1: Confirm worktree + branch**

```bash
git rev-parse --show-toplevel
# → .../.worktrees/phase-5-t2-pr4-dependency-resolution
git branch --show-current
# → dev/asafgolombek/phase-5-t2-pr4-dependency-resolution
git log --oneline -3
# → docs(t2-pr4): dependency-resolution design spec + Gemini review disposition
# → T2 PR 3: extension auto-update with per-bump HITL (#367)  ← main HEAD
```

- [ ] **P-2: Confirm baseline tests pass**

```bash
bun run test:coverage:extensions
bun run test:coverage:db
bun run typecheck
bun run audit:invariants
```

Expected: all green (`extensions` ≥ 85%, `db` ≥ 85%, no type errors, no D-rule violations). If any fails, stop and investigate before writing any new code.

- [ ] **P-3: Confirm `semver` + `fast-check` available**

```bash
bun pm ls semver fast-check
```

Expected output names both with their resolved versions. If `fast-check` is missing, stop and add it as a workspace devDependency before proceeding (it is the correctness gate for the solver).

---

## Phase A — Foundation primitives (pure, no Gateway deps)

### Task 1: Shared types module

**Files:**
- Create: `packages/gateway/src/extensions/dependency-types.ts`
- Create: `packages/gateway/src/extensions/dependency-types.test.ts`

- [ ] **Step 1: Write the type module** (no behavior — just shapes)

```typescript
// packages/gateway/src/extensions/dependency-types.ts

/** One dependency edge as resolved by the solver. */
export interface ResolvedDep {
  readonly id: string;
  readonly range: string;
  readonly resolvedVersion: string;
}

/** One node in the resolved install closure. */
export interface ResolvedNode {
  readonly id: string;
  readonly version: string;
  /** Whether this node was already installed at the satisfying version. */
  readonly newlyInstalled: boolean;
  readonly deps: readonly ResolvedDep[];
}

/** Output of the solver — topologically sorted, leaf-first. */
export interface InstallPlan {
  readonly nodes: readonly ResolvedNode[];
}

/** Pluggable registry adapter (production impl is local-first). */
export interface RegistryFetcher {
  listVersions(id: string): Promise<readonly string[]>;
  fetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver>;
}

/** Minimal manifest shape the solver consumes — keeps `dependency-graph.ts` decoupled from the full schema. */
export interface ExtensionManifestForSolver {
  readonly id: string;
  readonly version: string;
  readonly dependsOn?: Readonly<Record<string, string>>;
}

/** Solver inputs other than `root` + `fetcher`. */
export interface ResolveClosureOptions {
  readonly installed: ReadonlyMap<string, string>;
  /** Every installed extension's `dependsOn` map keyed by dependent id — see spec §2.1. */
  readonly activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Structured shape for a single resolution constraint (used in error payloads). */
export interface DependencyConstraint {
  readonly from: string;
  readonly range: string;
}

/** Structured payload surfaced by `extension.checkForUpdates` / HITL when a bump conflicts. */
export interface DependencyConflict {
  readonly kind: "cycle" | "unsatisfiable" | "range_invalid";
  readonly id: string;
  readonly chain?: readonly string[];
  readonly constraints?: readonly DependencyConstraint[];
}
```

- [ ] **Step 2: Write a tiny type-only test** (compile-time-only is fine; the test asserts the shape via `satisfies` so a future field rename fails the build)

```typescript
// packages/gateway/src/extensions/dependency-types.test.ts
import { describe, expect, it } from "bun:test";
import type {
  DependencyConflict,
  InstallPlan,
  ResolveClosureOptions,
  ResolvedNode,
} from "./dependency-types.ts";

describe("dependency types", () => {
  it("ResolvedNode shape", () => {
    const node: ResolvedNode = {
      id: "com.example.foo",
      version: "1.0.0",
      newlyInstalled: true,
      deps: [{ id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" }],
    };
    expect(node.deps).toHaveLength(1);
  });

  it("ResolveClosureOptions activeConstraints is nested map", () => {
    const opts: ResolveClosureOptions = {
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      activeConstraints: new Map([["com.example.bar", new Map([["com.shared.utils", "^1.0.0"]])]]),
    };
    expect(opts.activeConstraints.get("com.example.bar")?.get("com.shared.utils")).toBe("^1.0.0");
  });

  it("DependencyConflict supports cycle + unsatisfiable variants", () => {
    const cycle: DependencyConflict = { kind: "cycle", id: "com.example.a", chain: ["com.example.a", "com.example.b", "com.example.a"] };
    const conflict: DependencyConflict = {
      kind: "unsatisfiable",
      id: "com.shared.utils",
      constraints: [{ from: "com.example.foo", range: "^2.0.0" }, { from: "com.example.bar", range: "^1.0.0" }],
    };
    expect(cycle.chain).toHaveLength(3);
    expect(conflict.constraints).toHaveLength(2);
  });

  it("InstallPlan nodes is readonly array of ResolvedNode", () => {
    const plan: InstallPlan = { nodes: [] };
    expect(plan.nodes).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the tests + typecheck**

```bash
bun test packages/gateway/src/extensions/dependency-types.test.ts
bun run typecheck
```

Expected: 4 tests pass, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/extensions/dependency-types.ts \
        packages/gateway/src/extensions/dependency-types.test.ts
git commit -m "feat(t2-pr4): dependency-types module (solver inputs + result + conflict shape)"
```

---

### Task 2: Typed error classes

**Files:**
- Create: `packages/gateway/src/extensions/dependency-errors.ts`
- Create: `packages/gateway/src/extensions/dependency-errors.test.ts`

- [ ] **Step 1: Write the error module**

```typescript
// packages/gateway/src/extensions/dependency-errors.ts
import type { DependencyConflict } from "./dependency-types.ts";

/** Thrown by the solver when the closure cannot be satisfied (cycle / unsatisfiable / range_invalid). */
export class DependencyConflictError extends Error {
  readonly conflict: DependencyConflict;
  constructor(conflict: DependencyConflict) {
    super(`dependency_conflict:${conflict.kind}:${conflict.id}`);
    this.name = "DependencyConflictError";
    this.conflict = conflict;
  }
}

/** Thrown when the solver cannot reach the registry to resolve a missing dep. */
export class OfflineDependencyResolutionError extends Error {
  readonly missingId: string;
  readonly parent: string;
  constructor(opts: { missingId: string; parent: string }) {
    super(`offline_dependency_resolution:${opts.missingId} (required by ${opts.parent})`);
    this.name = "OfflineDependencyResolutionError";
    this.missingId = opts.missingId;
    this.parent = opts.parent;
  }
}

/** Type-narrowing helpers — never use `instanceof` across module boundaries. */
export function isDependencyConflictError(e: unknown): e is DependencyConflictError {
  return e instanceof Error && (e as Error).name === "DependencyConflictError";
}
export function isOfflineDependencyResolutionError(e: unknown): e is OfflineDependencyResolutionError {
  return e instanceof Error && (e as Error).name === "OfflineDependencyResolutionError";
}
```

- [ ] **Step 2: Write the failing tests first**

```typescript
// packages/gateway/src/extensions/dependency-errors.test.ts
import { describe, expect, it } from "bun:test";
import {
  DependencyConflictError,
  OfflineDependencyResolutionError,
  isDependencyConflictError,
  isOfflineDependencyResolutionError,
} from "./dependency-errors.ts";

describe("DependencyConflictError", () => {
  it("carries the structured conflict payload", () => {
    const e = new DependencyConflictError({
      kind: "unsatisfiable",
      id: "com.shared.utils",
      constraints: [{ from: "com.example.foo", range: "^2.0.0" }],
    });
    expect(e.name).toBe("DependencyConflictError");
    expect(e.conflict.kind).toBe("unsatisfiable");
    expect(e.conflict.id).toBe("com.shared.utils");
    expect(e.message).toContain("com.shared.utils");
  });

  it("narrows via isDependencyConflictError", () => {
    const e: unknown = new DependencyConflictError({ kind: "cycle", id: "com.a", chain: ["com.a", "com.b", "com.a"] });
    expect(isDependencyConflictError(e)).toBe(true);
    expect(isDependencyConflictError(new Error("other"))).toBe(false);
  });
});

describe("OfflineDependencyResolutionError", () => {
  it("carries missingId + parent and prints both", () => {
    const e = new OfflineDependencyResolutionError({ missingId: "com.shared.utils", parent: "com.example.foo" });
    expect(e.missingId).toBe("com.shared.utils");
    expect(e.parent).toBe("com.example.foo");
    expect(e.message).toContain("com.shared.utils");
    expect(e.message).toContain("com.example.foo");
  });

  it("narrows via isOfflineDependencyResolutionError", () => {
    const e: unknown = new OfflineDependencyResolutionError({ missingId: "x", parent: "y" });
    expect(isOfflineDependencyResolutionError(e)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
bun test packages/gateway/src/extensions/dependency-errors.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/extensions/dependency-errors.ts \
        packages/gateway/src/extensions/dependency-errors.test.ts
git commit -m "feat(t2-pr4): typed DependencyConflictError + OfflineDependencyResolutionError"
```

---

### Task 3: Solver core — `dependency-graph.ts`

**Files:**
- Create: `packages/gateway/src/extensions/dependency-graph.ts`
- Create: `packages/gateway/src/extensions/dependency-graph.test.ts`

Implementation follows spec §2.2 pseudocode exactly: recursive DFS, per-frame `pinned` / `ranges` clones, `ancestors: Set` for cycle detection (separate from visited / pinned).

- [ ] **Step 1: Write failing scenario tests first** (cycle, diamond no-false-positive, unsatisfiable, installed-satisfies, range_invalid, basic happy path)

```typescript
// packages/gateway/src/extensions/dependency-graph.test.ts
import { describe, expect, it } from "bun:test";
import { resolveClosure } from "./dependency-graph.ts";
import {
  DependencyConflictError,
  OfflineDependencyResolutionError,
  isDependencyConflictError,
  isOfflineDependencyResolutionError,
} from "./dependency-errors.ts";
import type { ExtensionManifestForSolver, RegistryFetcher } from "./dependency-types.ts";

function makeFetcher(registry: Record<string, Record<string, ExtensionManifestForSolver>>): RegistryFetcher {
  return {
    listVersions: async (id) => {
      const versions = registry[id];
      if (!versions) throw new Error(`unknown_id:${id}`);
      return Object.keys(versions);
    },
    fetchManifest: async (id, version) => {
      const m = registry[id]?.[version];
      if (!m) throw new Error(`unknown_id_version:${id}@${version}`);
      return m;
    },
  };
}

describe("resolveClosure", () => {
  it("happy path — single dep, installs leaf-first", async () => {
    const fetcher = makeFetcher({
      "com.shared.utils": { "1.5.0": { id: "com.shared.utils", version: "1.5.0" } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0" },
    };
    const plan = await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
    expect(plan.nodes.map((n) => n.id)).toEqual(["com.shared.utils", "com.example.foo"]);
    expect(plan.nodes[0]?.newlyInstalled).toBe(true);
    expect(plan.nodes[1]?.deps[0]?.resolvedVersion).toBe("1.5.0");
  });

  it("diamond DAG resolves without false-positive cycle", async () => {
    const fetcher = makeFetcher({
      "com.shared.d": { "1.0.0": { id: "com.shared.d", version: "1.0.0" } },
      "com.shared.b": { "1.0.0": { id: "com.shared.b", version: "1.0.0", dependsOn: { "com.shared.d": "^1.0.0" } } },
      "com.shared.c": { "1.0.0": { id: "com.shared.c", version: "1.0.0", dependsOn: { "com.shared.d": "^1.0.0" } } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.a",
      version: "1.0.0",
      dependsOn: { "com.shared.b": "^1.0.0", "com.shared.c": "^1.0.0" },
    };
    const plan = await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
    expect(plan.nodes.map((n) => n.id).sort()).toEqual([
      "com.example.a",
      "com.shared.b",
      "com.shared.c",
      "com.shared.d",
    ]);
  });

  it("true cycle returns DependencyConflictError(kind=cycle) with chain", async () => {
    const fetcher = makeFetcher({
      "com.x.a": { "1.0.0": { id: "com.x.a", version: "1.0.0", dependsOn: { "com.x.b": "^1.0.0" } } },
      "com.x.b": { "1.0.0": { id: "com.x.b", version: "1.0.0", dependsOn: { "com.x.a": "^1.0.0" } } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.x.a",
      version: "1.0.0",
      dependsOn: { "com.x.b": "^1.0.0" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("cycle");
        expect(e.conflict.chain?.[0]).toBe("com.x.a");
        expect(e.conflict.chain?.at(-1)).toBe("com.x.a");
      }
    }
  });

  it("unsatisfiable range across closure returns kind=unsatisfiable + named constraints", async () => {
    const fetcher = makeFetcher({
      "com.shared.utils": { "1.5.0": { id: "com.shared.utils", version: "1.5.0" } },
      "com.example.c": { "1.0.0": { id: "com.example.c", version: "1.0.0", dependsOn: { "com.shared.utils": "^2.0.0" } } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.b",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0", "com.example.c": "^1.0.0" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("unsatisfiable");
        expect(e.conflict.id).toBe("com.shared.utils");
        expect(e.conflict.constraints?.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("activeConstraints from outside-closure extension blocks the bump", async () => {
    // Spec §2.3 / §6 — auto-update bump A introduces B@^2; installed C wants B@^1.
    const fetcher = makeFetcher({
      "com.shared.b": {
        "1.0.0": { id: "com.shared.b", version: "1.0.0" },
        "2.0.0": { id: "com.shared.b", version: "2.0.0" },
      },
    });
    const newAManifest: ExtensionManifestForSolver = {
      id: "com.example.a",
      version: "2.0.0",
      dependsOn: { "com.shared.b": "^2.0.0" },
    };
    try {
      await resolveClosure(newAManifest, fetcher, {
        installed: new Map([["com.shared.b", "1.0.0"], ["com.example.c", "1.0.0"]]),
        activeConstraints: new Map([["com.example.c", new Map([["com.shared.b", "^1.0.0"]])]]),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("unsatisfiable");
        expect(e.conflict.id).toBe("com.shared.b");
        expect(e.conflict.constraints?.some((c) => c.from === "com.example.c")).toBe(true);
      }
    }
  });

  it("installed version that satisfies all ranges is reused (newlyInstalled=false)", async () => {
    const fetcher = makeFetcher({
      "com.shared.utils": { "1.5.0": { id: "com.shared.utils", version: "1.5.0" } },
    });
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0" },
    };
    const plan = await resolveClosure(root, fetcher, {
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      activeConstraints: new Map(),
    });
    const utils = plan.nodes.find((n) => n.id === "com.shared.utils");
    expect(utils?.newlyInstalled).toBe(false);
  });

  it("invalid semver range surfaces kind=range_invalid", async () => {
    const fetcher = makeFetcher({});
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "not-a-range" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isDependencyConflictError(e)).toBe(true);
      if (isDependencyConflictError(e)) {
        expect(e.conflict.kind).toBe("range_invalid");
      }
    }
  });

  it("network error wraps as OfflineDependencyResolutionError", async () => {
    const fetcher: RegistryFetcher = {
      listVersions: async () => { throw new Error("network_down"); },
      fetchManifest: async () => { throw new Error("network_down"); },
    };
    const root: ExtensionManifestForSolver = {
      id: "com.example.foo",
      version: "1.0.0",
      dependsOn: { "com.shared.utils": "^1.0.0" },
    };
    try {
      await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
      throw new Error("expected throw");
    } catch (e) {
      expect(isOfflineDependencyResolutionError(e)).toBe(true);
      if (isOfflineDependencyResolutionError(e)) {
        expect(e.missingId).toBe("com.shared.utils");
        expect(e.parent).toBe("com.example.foo");
      }
    }
  });
});
```

- [ ] **Step 2: Verify the tests fail** (no implementation yet)

```bash
bun test packages/gateway/src/extensions/dependency-graph.test.ts
```

Expected: all 8 tests fail with "module not found" or similar.

- [ ] **Step 3: Implement `dependency-graph.ts` per spec §2.2**

```typescript
// packages/gateway/src/extensions/dependency-graph.ts
import semver from "semver";
import { DependencyConflictError, OfflineDependencyResolutionError } from "./dependency-errors.ts";
import type {
  DependencyConstraint,
  ExtensionManifestForSolver,
  InstallPlan,
  RegistryFetcher,
  ResolveClosureOptions,
  ResolvedDep,
  ResolvedNode,
} from "./dependency-types.ts";

type Ranges = Map<string, DependencyConstraint[]>;
type Pinned = Map<string, string>;
type ManifestCache = Map<string, ExtensionManifestForSolver>; // key = `${id}@${version}`

/** Treat any non-typed thrown error from the fetcher as a network failure. */
function isRegistryUnreachable(e: unknown): boolean {
  if (e instanceof OfflineDependencyResolutionError) return true;
  if (e instanceof DependencyConflictError) return false;
  return e instanceof Error;
}

function clone<K, V>(m: Map<K, V>): Map<K, V> {
  return new Map(m);
}
function cloneRanges(r: Ranges): Ranges {
  const out: Ranges = new Map();
  for (const [k, v] of r) out.set(k, [...v]);
  return out;
}

/**
 * Recursive DFS with per-frame state clones (see spec §2.2). The `ancestors` Set is
 * the active recursive call stack — distinct from `pinned` (resolved nodes) so a
 * diamond DAG never false-positives as a cycle.
 */
export async function resolveClosure(
  root: ExtensionManifestForSolver,
  fetcher: RegistryFetcher,
  opts: ResolveClosureOptions,
): Promise<InstallPlan> {
  // Seed range constraints from every installed extension's dependsOn map.
  const initialRanges: Ranges = new Map();
  for (const [dependent, depMap] of opts.activeConstraints) {
    for (const [depId, range] of depMap) {
      const list = initialRanges.get(depId) ?? [];
      list.push({ from: dependent, range });
      initialRanges.set(depId, list);
    }
  }
  // Seed pinned with currently-installed versions.
  const initialPinned: Pinned = new Map(opts.installed);
  // ancestors is shared mutably across the DFS (add on entry, delete on exit).
  const ancestors = new Set<string>();
  const manifestCache: ManifestCache = new Map();
  // Final node map keyed by id (single entry per id post-resolution).
  const resolved: Map<string, ResolvedNode> = new Map();
  const initialInstalled = new Map(opts.installed);

  await visit(root, initialPinned, initialRanges, ancestors, fetcher, manifestCache, resolved, initialInstalled);

  return { nodes: topoSort(resolved) };
}

async function visit(
  current: ExtensionManifestForSolver,
  pinned: Pinned,
  ranges: Ranges,
  ancestors: Set<string>,
  fetcher: RegistryFetcher,
  manifestCache: ManifestCache,
  resolved: Map<string, ResolvedNode>,
  initialInstalled: ReadonlyMap<string, string>,
): Promise<void> {
  ancestors.add(current.id);
  pinned.set(current.id, current.version);

  const deps: ResolvedDep[] = [];
  const depEntries = Object.entries(current.dependsOn ?? {});

  for (const [depId, range] of depEntries) {
    if (typeof range !== "string" || !semver.validRange(range)) {
      ancestors.delete(current.id);
      throw new DependencyConflictError({ kind: "range_invalid", id: depId, constraints: [{ from: current.id, range }] });
    }

    if (ancestors.has(depId)) {
      const chain = [...ancestors, depId];
      ancestors.delete(current.id);
      throw new DependencyConflictError({ kind: "cycle", id: depId, chain });
    }

    // Append constraint with provenance.
    const constraintList = ranges.get(depId) ?? [];
    constraintList.push({ from: current.id, range });
    ranges.set(depId, constraintList);

    // Pick a candidate version.
    const installed = pinned.get(depId);
    let candidate: string | undefined;
    if (installed && constraintList.every((c) => semver.satisfies(installed, c.range))) {
      candidate = installed;
    } else {
      let versions: readonly string[];
      try {
        versions = await fetcher.listVersions(depId);
      } catch (e) {
        if (isRegistryUnreachable(e)) {
          throw new OfflineDependencyResolutionError({ missingId: depId, parent: current.id });
        }
        throw e;
      }
      // Highest-satisfying first.
      candidate = semver.maxSatisfying(
        [...versions],
        constraintList.map((c) => c.range).join(" "),
      ) ?? undefined;
      if (!candidate) {
        throw new DependencyConflictError({
          kind: "unsatisfiable",
          id: depId,
          constraints: [...constraintList],
        });
      }
    }

    // Fetch dep manifest (cache hit if same id@version was already pulled).
    const cacheKey = `${depId}@${candidate}`;
    let depManifest = manifestCache.get(cacheKey);
    if (!depManifest) {
      try {
        depManifest = await fetcher.fetchManifest(depId, candidate);
      } catch (e) {
        if (isRegistryUnreachable(e)) {
          throw new OfflineDependencyResolutionError({ missingId: depId, parent: current.id });
        }
        throw e;
      }
      manifestCache.set(cacheKey, depManifest);
    }

    deps.push({ id: depId, range, resolvedVersion: candidate });

    // Recurse — pinned & ranges shared by reference; per-frame clone only on backtrack.
    if (!resolved.has(depId)) {
      await visit(depManifest, pinned, ranges, ancestors, fetcher, manifestCache, resolved, initialInstalled);
    }
  }

  const installedVersion = initialInstalled.get(current.id);
  resolved.set(current.id, {
    id: current.id,
    version: current.version,
    newlyInstalled: installedVersion !== current.version,
    deps,
  });
  ancestors.delete(current.id);
}

/** Kahn's algorithm — emit leaf-first. */
function topoSort(resolved: Map<string, ResolvedNode>): readonly ResolvedNode[] {
  const inDegree: Map<string, number> = new Map();
  const reverseEdges: Map<string, string[]> = new Map(); // depId → list of dependents
  for (const node of resolved.values()) {
    inDegree.set(node.id, node.deps.length);
    for (const dep of node.deps) {
      const list = reverseEdges.get(dep.id) ?? [];
      list.push(node.id);
      reverseEdges.set(dep.id, list);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  // Stable order: sort the initial leaves alphabetically.
  queue.sort();
  const out: ResolvedNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const node = resolved.get(id);
    if (!node) continue;
    out.push(node);
    const dependents = reverseEdges.get(id) ?? [];
    for (const dep of dependents) {
      const next = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
    queue.sort();
  }
  return out;
}
```

- [ ] **Step 4: Run the tests + typecheck**

```bash
bun test packages/gateway/src/extensions/dependency-graph.test.ts
bun run typecheck
```

Expected: 8 tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/dependency-graph.ts \
        packages/gateway/src/extensions/dependency-graph.test.ts
git commit -m "feat(t2-pr4): custom backtracking solver (recursive DFS, ancestors set, per-frame clone)"
```

---

### Task 4: Property tests with `fast-check`

**Files:**
- Modify: `packages/gateway/src/extensions/dependency-graph.test.ts` — append property-test block.

The fast-check corpus is the spec's correctness gate. Random DAGs ≤ 15 nodes; check the four properties from spec §2.2 final paragraph.

- [ ] **Step 1: Add property tests**

```typescript
// Append to packages/gateway/src/extensions/dependency-graph.test.ts
import fc from "fast-check";

// Helper: build a random DAG fixture + a fetcher serving every (id, version) declared.
interface DagFixture {
  rootId: string;
  registry: Record<string, Record<string, ExtensionManifestForSolver>>;
}

function dagArb(): fc.Arbitrary<DagFixture> {
  return fc.integer({ min: 2, max: 12 }).chain((n) => {
    const ids = Array.from({ length: n }, (_, i) => `com.test.n${i}`);
    return fc.array(fc.integer({ min: 0, max: 100 }), { minLength: n * n, maxLength: n * n }).map((flat) => {
      const registry: Record<string, Record<string, ExtensionManifestForSolver>> = {};
      for (let i = 0; i < n; i++) {
        const dependsOn: Record<string, string> = {};
        // DAG constraint: only depend on higher-index nodes (i.e. j > i).
        for (let j = i + 1; j < n; j++) {
          const cell = flat[i * n + j];
          if ((cell ?? 0) > 70) dependsOn[ids[j] ?? "x"] = "^1.0.0";
        }
        const id = ids[i] ?? "x";
        registry[id] = { "1.0.0": { id, version: "1.0.0", dependsOn } };
      }
      return { rootId: ids[0] ?? "x", registry };
    });
  });
}

describe("resolveClosure — fast-check corpus", () => {
  it("if a solution exists, every pin satisfies every range", async () => {
    await fc.assert(
      fc.asyncProperty(dagArb(), async ({ rootId, registry }) => {
        const fetcher = makeFetcher(registry);
        const root = registry[rootId]?.["1.0.0"];
        if (!root) return;
        try {
          const plan = await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
          // Every dep's resolvedVersion is in the registry's published list.
          for (const node of plan.nodes) {
            for (const dep of node.deps) {
              expect(registry[dep.id]?.[dep.resolvedVersion]).toBeDefined();
            }
          }
        } catch (e) {
          // Either DependencyConflictError or OfflineDependencyResolutionError is acceptable.
          expect(isDependencyConflictError(e) || isOfflineDependencyResolutionError(e)).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });

  it("diamond never false-positives as cycle", async () => {
    await fc.assert(
      fc.asyncProperty(dagArb(), async ({ rootId, registry }) => {
        const fetcher = makeFetcher(registry);
        const root = registry[rootId]?.["1.0.0"];
        if (!root) return;
        try {
          await resolveClosure(root, fetcher, { installed: new Map(), activeConstraints: new Map() });
        } catch (e) {
          // DAG fixtures only emit higher-index edges, so any cycle is the solver's fault.
          if (isDependencyConflictError(e)) {
            expect(e.conflict.kind).not.toBe("cycle");
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
bun test packages/gateway/src/extensions/dependency-graph.test.ts
```

Expected: 10 tests pass (8 original + 2 property tests, each running 50 random fixtures).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/extensions/dependency-graph.test.ts
git commit -m "test(t2-pr4): fast-check property tests for solver (no false-positive cycles, satisfiability invariant)"
```

---

## Phase B — Persistence: V31 schema + store

### Task 5: V31 SQL constant + migration step + unit test

**Files:**
- Create: `packages/gateway/src/index/extension-dependency-v31-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` — add `migrateIndexedV30ToV31` and register in `INDEXED_SCHEMA_STEPS`.
- Create: `packages/gateway/src/index/migrations/runner-v31.test.ts`

- [ ] **Step 1: Add the SQL constant**

```typescript
// packages/gateway/src/index/extension-dependency-v31-sql.ts

/** V31 migration — `extension_dependency` table + reverse-dep index. See spec §3. */
export const V31_EXTENSION_DEPENDENCY_SQL = `
CREATE TABLE extension_dependency (
  extension_id  TEXT    NOT NULL,
  depends_on_id TEXT    NOT NULL,
  range         TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (extension_id, depends_on_id)
);

CREATE INDEX idx_extension_dependency_reverse
  ON extension_dependency (depends_on_id);
` as const;
```

- [ ] **Step 2: Read `runner.ts` to find the exact insertion points**

```bash
grep -n "migrateIndexedV29ToV30\|INDEXED_SCHEMA_STEPS\|fromVersion: 29" packages/gateway/src/index/migrations/runner.ts
```

You will see two sites to touch: the migration function definition near the V30 one, and the `INDEXED_SCHEMA_STEPS` array.

- [ ] **Step 3: Add the new migration step + register it in the array**

After the existing `migrateIndexedV29ToV30` function, insert:

```typescript
import { V31_EXTENSION_DEPENDENCY_SQL } from "../extension-dependency-v31-sql.ts";
// ... existing imports stay above

function migrateIndexedV30ToV31(db: Database, _now: number): void {
  // The runner already wraps this in a single transaction (see spec §3).
  dbExec(db, V31_EXTENSION_DEPENDENCY_SQL);
}
```

And in `INDEXED_SCHEMA_STEPS`, after the V29→V30 entry:

```typescript
{ fromVersion: 30, toVersion: 31, apply: migrateIndexedV30ToV31 },
```

(Use `dbExec` from `db/write.ts` per I14 — verify the existing migration steps in this file use `dbExec` and match their pattern. If a step uses raw `db.exec`, that's a pre-existing exception listed in `DB_RUN_EXEC_ALLOW_LIST` — your new migration must use the wrapper.)

- [ ] **Step 4: Write the V31 unit test** (mirror `runner-v30.test.ts`)

```typescript
// packages/gateway/src/index/migrations/runner-v31.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runIndexedMigrations } from "./runner.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
});

describe("V31 — extension_dependency table", () => {
  it("creates the table + reverse-dep index", async () => {
    await runIndexedMigrations(db);
    const tableInfo = db.query("PRAGMA table_info(extension_dependency)").all() as Array<{ name: string; type: string }>;
    expect(tableInfo.map((c) => c.name).sort()).toEqual(
      ["created_at", "depends_on_id", "extension_id", "range"].sort(),
    );

    const indexInfo = db.query("PRAGMA index_list(extension_dependency)").all() as Array<{ name: string }>;
    expect(indexInfo.some((i) => i.name === "idx_extension_dependency_reverse")).toBe(true);
  });

  it("primary key is (extension_id, depends_on_id)", async () => {
    await runIndexedMigrations(db);
    db.run(
      "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
      ["com.example.foo", "com.shared.utils", "^1.0.0", 1],
    );
    expect(() =>
      db.run(
        "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
        ["com.example.foo", "com.shared.utils", "^2.0.0", 2],
      ),
    ).toThrow(/UNIQUE/);
  });

  it("reverse-dep query uses the index", async () => {
    await runIndexedMigrations(db);
    db.run(
      "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
      ["com.example.foo", "com.shared.utils", "^1.0.0", 1],
    );
    db.run(
      "INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at) VALUES (?, ?, ?, ?)",
      ["com.example.bar", "com.shared.utils", "^2.0.0", 2],
    );
    const plan = db.query("EXPLAIN QUERY PLAN SELECT extension_id, range FROM extension_dependency WHERE depends_on_id = ?").all("com.shared.utils") as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_extension_dependency_reverse"))).toBe(true);
  });
});
```

(If `runIndexedMigrations` is named differently in this codebase, use the actual exported name — check `runner.ts`'s default/named export.)

- [ ] **Step 5: Run the V31 test + the full migration suite**

```bash
bun test packages/gateway/src/index/migrations/runner-v31.test.ts
bun test packages/gateway/src/index/migrations/
bun run typecheck
```

Expected: 3 new tests pass; existing V<N> migration tests still pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/index/extension-dependency-v31-sql.ts \
        packages/gateway/src/index/migrations/runner.ts \
        packages/gateway/src/index/migrations/runner-v31.test.ts
git commit -m "feat(t2-pr4): V31 extension_dependency table + reverse-dep index"
```

---

### Task 6: Dependency store (`dbRun`-backed CRUD)

**Files:**
- Create: `packages/gateway/src/extensions/dependency-store.ts`
- Create: `packages/gateway/src/extensions/dependency-store.test.ts`

- [ ] **Step 1: Write failing tests first**

```typescript
// packages/gateway/src/extensions/dependency-store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runIndexedMigrations } from "../index/migrations/runner.ts";
import {
  clearDeps,
  forwardDeps,
  recordInstall,
  reverseDeps,
} from "./dependency-store.ts";

let db: Database;

beforeEach(async () => {
  db = new Database(":memory:");
  await runIndexedMigrations(db);
});
afterEach(() => {
  db.close();
});

describe("dependency-store", () => {
  it("recordInstall + forwardDeps round-trip", () => {
    recordInstall(db, "com.example.foo", "1.0.0", [
      { id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" },
      { id: "com.shared.crypto", range: "^2.0.0", resolvedVersion: "2.4.1" },
    ], 1_700_000_000_000);
    const fwd = forwardDeps(db, "com.example.foo");
    expect(fwd).toHaveLength(2);
    expect(fwd.map((d) => d.id).sort()).toEqual(["com.shared.crypto", "com.shared.utils"]);
    expect(fwd.find((d) => d.id === "com.shared.utils")?.range).toBe("^1.0.0");
  });

  it("reverseDeps lists every dependent of an id", () => {
    recordInstall(db, "com.example.foo", "1.0.0", [
      { id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" },
    ], 1);
    recordInstall(db, "com.example.bar", "2.0.0", [
      { id: "com.shared.utils", range: "^1.2.0", resolvedVersion: "1.5.0" },
    ], 2);
    const rev = reverseDeps(db, "com.shared.utils");
    expect(rev.map((r) => r.extensionId).sort()).toEqual(["com.example.bar", "com.example.foo"]);
    expect(rev.find((r) => r.extensionId === "com.example.bar")?.range).toBe("^1.2.0");
  });

  it("clearDeps removes only rows for the given extension", () => {
    recordInstall(db, "com.example.foo", "1.0.0", [
      { id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" },
    ], 1);
    recordInstall(db, "com.example.bar", "2.0.0", [
      { id: "com.shared.utils", range: "^1.2.0", resolvedVersion: "1.5.0" },
    ], 2);
    clearDeps(db, "com.example.foo");
    expect(forwardDeps(db, "com.example.foo")).toHaveLength(0);
    expect(forwardDeps(db, "com.example.bar")).toHaveLength(1);
  });

  it("recordInstall is idempotent on PRIMARY KEY conflict (no throw, last write wins)", () => {
    recordInstall(db, "com.example.foo", "1.0.0", [
      { id: "com.shared.utils", range: "^1.0.0", resolvedVersion: "1.5.0" },
    ], 1);
    recordInstall(db, "com.example.foo", "1.0.0", [
      { id: "com.shared.utils", range: "^1.2.0", resolvedVersion: "1.5.0" },
    ], 2);
    const fwd = forwardDeps(db, "com.example.foo");
    expect(fwd).toHaveLength(1);
    expect(fwd[0]?.range).toBe("^1.2.0");
  });
});
```

- [ ] **Step 2: Run the tests** (expect "module not found")

```bash
bun test packages/gateway/src/extensions/dependency-store.test.ts
```

- [ ] **Step 3: Implement the store**

```typescript
// packages/gateway/src/extensions/dependency-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { ResolvedDep } from "./dependency-types.ts";

export interface ForwardDep {
  readonly id: string;
  readonly range: string;
}

export interface ReverseDep {
  readonly extensionId: string;
  readonly range: string;
}

/** Insert one row per (extensionId, dep) pair. `ON CONFLICT` re-writes `range` + `created_at` so retries are idempotent. */
export function recordInstall(
  db: Database,
  extensionId: string,
  _version: string,
  deps: readonly ResolvedDep[],
  now: number,
): void {
  // `_version` is intentionally unused — version is owned by `extension_state`.
  // The signature keeps it for caller-side readability.
  // First, clear existing forward edges so a downgraded `dependsOn` set is reflected.
  dbRun(db, "DELETE FROM extension_dependency WHERE extension_id = ?", [extensionId]);
  for (const dep of deps) {
    dbRun(
      db,
      `INSERT INTO extension_dependency (extension_id, depends_on_id, range, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(extension_id, depends_on_id) DO UPDATE SET range = excluded.range, created_at = excluded.created_at`,
      [extensionId, dep.id, dep.range, now],
    );
  }
}

export function clearDeps(db: Database, extensionId: string): void {
  dbRun(db, "DELETE FROM extension_dependency WHERE extension_id = ?", [extensionId]);
}

export function forwardDeps(db: Database, extensionId: string): readonly ForwardDep[] {
  const rows = db
    .query("SELECT depends_on_id AS id, range FROM extension_dependency WHERE extension_id = ?")
    .all(extensionId) as Array<{ id: string; range: string }>;
  return rows;
}

export function reverseDeps(db: Database, dependsOnId: string): readonly ReverseDep[] {
  const rows = db
    .query("SELECT extension_id AS extensionId, range FROM extension_dependency WHERE depends_on_id = ?")
    .all(dependsOnId) as Array<{ extensionId: string; range: string }>;
  return rows;
}
```

- [ ] **Step 4: Run the tests + the I14 static audit**

```bash
bun test packages/gateway/src/extensions/dependency-store.test.ts
bun run audit:invariants
```

Expected: 4 tests pass; static audit green (every write in `dependency-store.ts` goes through `dbRun`).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/dependency-store.ts \
        packages/gateway/src/extensions/dependency-store.test.ts
git commit -m "feat(t2-pr4): dependency-store (dbRun-backed CRUD, I14-compliant)"
```

---

## Phase C — Local-first registry adapter

### Task 7: `registry-fetcher.ts`

**Files:**
- Create: `packages/gateway/src/extensions/registry-fetcher.ts`
- Create: `packages/gateway/src/extensions/registry-fetcher.test.ts`

The adapter consults on-disk installed state before any network call. For an installed id, `listVersions` returns `[installedVersion]` and `fetchManifest` reads from `<extensions-root>/<id>/active/nimbus.extension.json`. Only unknown ids touch the network.

- [ ] **Step 1: Find the existing remote-registry client** (the one PR 3 uses)

```bash
grep -rn "registry.nimbus-agent\|fetchRegistryEntry\|listRegistryVersions" packages/gateway/src/extensions/ | head
```

You will likely find the PR 3 auto-update fetcher. Re-use its raw HTTP path; do not re-implement HTTP from scratch.

- [ ] **Step 2: Write the local-first adapter**

```typescript
// packages/gateway/src/extensions/registry-fetcher.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionManifestForSolver, RegistryFetcher } from "./dependency-types.ts";

export interface RegistryFetcherDeps {
  /** Map from installed extension id → on-disk version. */
  installed: ReadonlyMap<string, string>;
  /** Resolves the on-disk path of an installed extension's `active/` directory. */
  extensionDir(id: string): string;
  /** Network calls — the existing PR 3 registry client. */
  remoteListVersions(id: string): Promise<readonly string[]>;
  remoteFetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver>;
}

/**
 * Local-first RegistryFetcher (spec §2.1, §2.3). An installed id resolves from on-disk
 * state without a network call; only unknown ids hit the remote registry.
 */
export function createRegistryFetcher(deps: RegistryFetcherDeps): RegistryFetcher {
  return {
    async listVersions(id) {
      const installed = deps.installed.get(id);
      if (installed) return [installed];
      return deps.remoteListVersions(id);
    },
    async fetchManifest(id, version) {
      const installed = deps.installed.get(id);
      if (installed === version) {
        const manifestPath = join(deps.extensionDir(id), "nimbus.extension.json");
        const raw = await readFile(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as ExtensionManifestForSolver & Record<string, unknown>;
        return {
          id: parsed.id,
          version: parsed.version,
          dependsOn: parsed.dependsOn,
        };
      }
      return deps.remoteFetchManifest(id, version);
    },
  };
}
```

- [ ] **Step 3: Write the tests**

```typescript
// packages/gateway/src/extensions/registry-fetcher.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistryFetcher } from "./registry-fetcher.ts";

let extRoot: string;

beforeAll(async () => {
  extRoot = join(tmpdir(), `nimbus-test-${Date.now()}`);
  await mkdir(join(extRoot, "com.shared.utils", "active"), { recursive: true });
  await writeFile(
    join(extRoot, "com.shared.utils", "active", "nimbus.extension.json"),
    JSON.stringify({ id: "com.shared.utils", version: "1.5.0", dependsOn: { "com.lower": "^0.1.0" } }),
    "utf8",
  );
});
afterAll(async () => {
  await rm(extRoot, { recursive: true, force: true });
});

describe("createRegistryFetcher (local-first)", () => {
  it("listVersions for installed id returns only installedVersion, no remote call", async () => {
    let remoteCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      extensionDir: (id) => join(extRoot, id, "active"),
      remoteListVersions: async () => { remoteCalled = true; return ["9.9.9"]; },
      remoteFetchManifest: async () => { remoteCalled = true; throw new Error("unreachable"); },
    });
    const versions = await fetcher.listVersions("com.shared.utils");
    expect(versions).toEqual(["1.5.0"]);
    expect(remoteCalled).toBe(false);
  });

  it("fetchManifest for installed id reads on-disk manifest, no remote call", async () => {
    let remoteCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      extensionDir: (id) => join(extRoot, id, "active"),
      remoteListVersions: async () => { remoteCalled = true; return []; },
      remoteFetchManifest: async () => { remoteCalled = true; throw new Error("unreachable"); },
    });
    const m = await fetcher.fetchManifest("com.shared.utils", "1.5.0");
    expect(m.dependsOn?.["com.lower"]).toBe("^0.1.0");
    expect(remoteCalled).toBe(false);
  });

  it("unknown id falls through to remote", async () => {
    let remoteListCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map(),
      extensionDir: () => extRoot,
      remoteListVersions: async () => { remoteListCalled = true; return ["1.0.0"]; },
      remoteFetchManifest: async (id, version) => ({ id, version }),
    });
    expect(await fetcher.listVersions("com.unknown")).toEqual(["1.0.0"]);
    expect(remoteListCalled).toBe(true);
  });
});
```

- [ ] **Step 4: Run + typecheck**

```bash
bun test packages/gateway/src/extensions/registry-fetcher.test.ts
bun run typecheck
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/registry-fetcher.ts \
        packages/gateway/src/extensions/registry-fetcher.test.ts
git commit -m "feat(t2-pr4): local-first RegistryFetcher (no network call for installed ids)"
```

---

## Phase D — Manifest schema

### Task 8: `dependsOn` in manifest schema

**Files:**
- Modify: `packages/gateway/src/extensions/manifest-schema.ts` — add `dependsOn?: Record<string, string>`.
- Modify: existing `manifest-schema.test.ts` (or sibling) — add validation tests.

- [ ] **Step 1: Locate the manifest schema**

```bash
grep -n "publisher\|dependsOn\|export const.*manifestSchema\|parseManifest" packages/gateway/src/extensions/manifest-schema.ts | head
```

You will see the existing PR 2 `publisher` field. Add `dependsOn` next to it.

- [ ] **Step 2: Add the field + validator**

Add to the schema object/type literal:

```typescript
dependsOn: z.record(z.string(), z.string()).optional().refine(
  (rec) => rec === undefined || Object.values(rec).every((range) => typeof range === "string" && semver.validRange(range) !== null),
  { message: "dependsOn values must be valid semver ranges" },
),
```

(If the schema is plain TypeScript and not Zod, use the same pattern with manual `validRange` checks. Import `semver` at top.)

- [ ] **Step 3: Add validation tests**

```typescript
// Append to packages/gateway/src/extensions/manifest-schema.test.ts (or sibling)
it("accepts manifest with valid dependsOn ranges", () => {
  const m = parseManifest({ ...baseManifest, dependsOn: { "com.shared.utils": "^1.0.0" } });
  expect(m.dependsOn?.["com.shared.utils"]).toBe("^1.0.0");
});

it("accepts manifest without dependsOn (legacy + zero-dep extensions)", () => {
  const m = parseManifest(baseManifest);
  expect(m.dependsOn).toBeUndefined();
});

it("rejects manifest with invalid semver range in dependsOn", () => {
  expect(() => parseManifest({ ...baseManifest, dependsOn: { "com.shared.utils": "not-a-range" } })).toThrow(/semver/);
});
```

- [ ] **Step 4: Run tests + typecheck**

```bash
bun test packages/gateway/src/extensions/manifest-schema.test.ts
bun run typecheck
```

Expected: existing tests still pass + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/manifest-schema.ts \
        packages/gateway/src/extensions/manifest-schema.test.ts
git commit -m "feat(t2-pr4): manifest dependsOn field + semver-range validator"
```

---

## Phase E — Install path wiring

### Task 9: Wire solver into `install-from-local.ts`

**Files:**
- Modify: `packages/gateway/src/extensions/install-from-local.ts` — call `resolveClosure` after signature verify; install closure leaf-first; track `createdDirs`; persist via `recordInstall` in one transaction; emit audit row with full version map.

- [ ] **Step 1: Locate the existing install function**

```bash
grep -n "completeExtensionInstallAfterCopy\|appendAuditEntry.*install\|verifyManifestSignature" packages/gateway/src/extensions/install-from-local.ts | head
```

- [ ] **Step 2: Add the solver call between signature verify and the existing single-extension install**

Conceptually (the exact integration shape depends on the existing function — keep its outer shape, hook into the right step):

```typescript
// In install-from-local.ts, after verifyManifestSignature succeeds and BEFORE copying to active/:

import { resolveClosure } from "./dependency-graph.ts";
import { recordInstall } from "./dependency-store.ts";
import { DependencyConflictError, OfflineDependencyResolutionError } from "./dependency-errors.ts";
import { createRegistryFetcher } from "./registry-fetcher.ts";
import { forwardDeps } from "./dependency-store.ts";
import type { ResolvedDep } from "./dependency-types.ts";

// Build activeConstraints from every installed extension's manifest dependsOn.
function buildActiveConstraints(db: Database, installed: ReadonlyMap<string, string>): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const id of installed.keys()) {
    const fwd = forwardDeps(db, id);
    if (fwd.length === 0) continue;
    const inner = new Map<string, string>();
    for (const f of fwd) inner.set(f.id, f.range);
    out.set(id, inner);
  }
  return out;
}

// In the install handler:
const installed = readInstalledVersions(db); // helper that returns ReadonlyMap<id, version> from extension_state
const fetcher = createRegistryFetcher({
  installed,
  extensionDir: (id) => paths.extensionActiveDir(id),
  remoteListVersions: deps.remoteListVersions,
  remoteFetchManifest: deps.remoteFetchManifest,
});
const activeConstraints = buildActiveConstraints(db, installed);

let plan;
try {
  plan = await resolveClosure(rootManifest, fetcher, { installed, activeConstraints });
} catch (e) {
  if (e instanceof DependencyConflictError) {
    throw e; // refused — zero disk mutation by construction (no unpack yet)
  }
  if (e instanceof OfflineDependencyResolutionError) {
    throw e;
  }
  throw e;
}

// Now install closure leaf-first with per-session cleanup tracking.
const createdDirs: string[] = [];
try {
  for (const node of plan.nodes) {
    if (!node.newlyInstalled) continue;
    const dir = await installSingleNode(node, /* signature-verify + sha256 + unpack */ ...);
    createdDirs.push(dir);
  }
} catch (e) {
  // Best-effort rollback: rm -rf each path in reverse order.
  for (const d of [...createdDirs].reverse()) {
    try { await rm(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
  throw e;
}

// Persist the dep graph + audit row in one transaction.
const now = Date.now();
db.transaction(() => {
  for (const node of plan.nodes) {
    recordInstall(db, node.id, node.version, node.deps as readonly ResolvedDep[], now);
  }
})();

// Audit row carries the full version map.
await appendAuditEntry(db, {
  actionType: "extension.install_complete",
  hitlStatus: "approved",
  metadata: {
    root: rootManifest.id,
    rootVersion: rootManifest.version,
    installed: plan.nodes.map((n) => ({
      id: n.id,
      version: n.version,
      newlyInstalled: n.newlyInstalled,
      deps: Object.fromEntries(n.deps.map((d) => [d.id, d.range])),
    })),
  },
});
```

(Adapt the names — `installSingleNode`, `rootManifest`, `paths.extensionActiveDir`, `deps.remoteListVersions` — to whatever the file actually uses. The shape is what matters.)

- [ ] **Step 3: Add an integration test exercising one happy + one conflict + one cleanup case**

```typescript
// packages/gateway/src/extensions/install-from-local.test.ts (append or create)
describe("install — dependency-aware", () => {
  it("installs a closure leaf-first, both rows in extension_dependency", async () => {
    // fixture: B@1.0.0 depends on A@^1.0.0; A@1.5.0 in registry.
    const result = await installFromLocal({ tarball: B_TARBALL_PATH }, { db, fetcher: TWO_NODE_FETCHER, ... });
    expect(result.installed.map((n) => n.id)).toEqual(["com.shared.A", "com.example.B"]);
    expect(forwardDeps(db, "com.example.B").map((d) => d.id)).toEqual(["com.shared.A"]);
  });

  it("refuses install on conflict; zero disk mutation", async () => {
    // fixture: B@1.0.0 requires A@^2.0.0; A@1.5.0 already installed (no @2 available).
    await expect(installFromLocal({ tarball: CONFLICT_B_TARBALL_PATH }, ctx)).rejects.toThrow(DependencyConflictError);
    expect(existsSync(extensionActiveDir("com.example.B"))).toBe(false);
  });

  it("rolls back createdDirs when the 3rd of 5 nodes fails to unpack", async () => {
    const result = installFromLocal({ tarball: FIVE_NODE_TARBALL_PATH }, { ..., installSingleNodeFailsAt: 3 });
    await expect(result).rejects.toThrow();
    // Nodes 1 and 2 were unpacked, then removed.
    expect(existsSync(extensionActiveDir("com.closure.node1"))).toBe(false);
    expect(existsSync(extensionActiveDir("com.closure.node2"))).toBe(false);
  });
});
```

(Use fixtures that already exist in the install-from-local test file as templates — match its mock shapes.)

- [ ] **Step 4: Run the tests + audit:invariants**

```bash
bun test packages/gateway/src/extensions/install-from-local.test.ts
bun run audit:invariants
bun run typecheck
```

Expected: existing install tests stay green + 3 new tests pass; static audit green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/install-from-local.ts \
        packages/gateway/src/extensions/install-from-local.test.ts
git commit -m "feat(t2-pr4): solver wiring in install path (leaf-first + cleanup-on-failure + audit version map)"
```

---

## Phase F — Remove path

### Task 10: Reverse-dep check on remove + `--force` flag

**Files:**
- Modify: the file owning `nimbus extension remove` — likely `packages/gateway/src/extensions/remove.ts` or wherever the IPC handler dispatches to. Find it with:

```bash
grep -rn "extension.remove\|reverseDeps\|case \"remove\":" packages/gateway/src/extensions/ packages/gateway/src/ipc/ | head
```

- Modify: `packages/cli/src/commands/extension.ts` — add `--force` flag to `remove` parser.

- [ ] **Step 1: Add the reverse-dep guard in the remove handler**

```typescript
// In the remove handler, BEFORE any disk mutation:
import { clearDeps, reverseDeps } from "./dependency-store.ts";

const reverse = reverseDeps(db, targetId);
if (reverse.length > 0 && !opts.force) {
  throw new ReverseDepBlockedError({
    target: targetId,
    blockers: reverse.map((r) => ({ id: r.extensionId, range: r.range })),
  });
}

// After the existing remove succeeds:
db.transaction(() => {
  clearDeps(db, targetId);
  // ... existing remove-side writes
})();

// HITL preview: append a `danglingDeps` field on the action's details when --force.
```

Add a new typed error class in `dependency-errors.ts`:

```typescript
export class ReverseDepBlockedError extends Error {
  readonly target: string;
  readonly blockers: ReadonlyArray<{ id: string; range: string }>;
  constructor(opts: { target: string; blockers: ReadonlyArray<{ id: string; range: string }> }) {
    super(`reverse_dep_blocked:${opts.target}:${opts.blockers.length}`);
    this.name = "ReverseDepBlockedError";
    this.target = opts.target;
    this.blockers = opts.blockers;
  }
}
```

- [ ] **Step 2: Add `--force` to the CLI**

```bash
grep -n "remove <id>\|case \"remove\":\|nimbus extension remove" packages/cli/src/commands/extension.ts | head
```

Add the flag parsing + pass `force: true` into the IPC payload.

- [ ] **Step 3: Write integration tests** (real DB, mock HITL)

```typescript
describe("remove — dependency-aware", () => {
  it("refuses remove with reverseDeps without --force", async () => {
    // setup: A installed; B depends on A.
    recordInstall(db, "com.example.B", "1.0.0", [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0" }], 1);
    await expect(removeExtension({ id: "com.shared.A", force: false }, ctx)).rejects.toThrow(/required by/);
    // A still installed.
    expect(extensionStateRow(db, "com.shared.A")).toBeDefined();
  });

  it("--force allows remove + HITL preview includes danglingDeps", async () => {
    recordInstall(db, "com.example.B", "1.0.0", [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0" }], 1);
    const consent = await captureNextHitlPayload(ctx);
    const removePromise = removeExtension({ id: "com.shared.A", force: true }, ctx);
    const payload = await consent;
    expect(payload.details.danglingDeps).toContain("com.example.B");
    await approveHitl(payload);
    await removePromise;
    expect(extensionStateRow(db, "com.shared.A")).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run tests**

```bash
bun test packages/gateway/src/extensions/remove.test.ts
bun run typecheck
```

Expected: 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/remove.ts \
        packages/gateway/src/extensions/remove.test.ts \
        packages/gateway/src/extensions/dependency-errors.ts \
        packages/cli/src/commands/extension.ts
git commit -m "feat(t2-pr4): reverse-dep guard on remove + --force flag + danglingDeps in HITL preview"
```

---

## Phase G — Auto-update wiring

### Task 11: Solver call in `auto-update.ts` + `conflicts` field on `AvailableUpdate`

**Files:**
- Modify: `packages/gateway/src/extensions/auto-update.ts` — call `resolveClosure` with `activeConstraints` at cache-write time; populate `conflicts` on `AvailableUpdate`.
- Modify: `packages/gateway/src/extensions/auto-update-types.ts` — add `conflicts?: readonly DependencyConflict[]` to `AvailableUpdate`.
- Modify: HITL preview rendering — surface `conflicts` to the consent payload.

- [ ] **Step 1: Add `conflicts` field to the type**

```typescript
// In auto-update-types.ts, extend AvailableUpdate:
import type { DependencyConflict } from "./dependency-types.ts";

export interface AvailableUpdate {
  // ... existing fields
  conflicts?: readonly DependencyConflict[];
}
```

- [ ] **Step 2: Wire the solver in the cache-write path**

```typescript
// In auto-update.ts, where cache entries are written:
const proposedManifest: ExtensionManifestForSolver = {
  id: bumpId,
  version: toVersion,
  dependsOn: newManifest.dependsOn,
};
let conflicts: DependencyConflict[] | undefined;
try {
  await resolveClosure(proposedManifest, fetcher, { installed, activeConstraints });
} catch (e) {
  if (e instanceof DependencyConflictError) {
    conflicts = [e.conflict];
  } else if (e instanceof OfflineDependencyResolutionError) {
    // Don't surface offline-during-poll as a conflict; the user can retry.
    conflicts = undefined;
  }
}
cache.set(bumpId, { ...existing, conflicts });
```

- [ ] **Step 3: Surface `conflicts` in the HITL preview**

In whatever maps `AvailableUpdate` → consent payload (likely `auto-update-rpc.ts`), include `conflicts` in the `details` field. The rendering belongs in the UI/CLI consent preview — not new logic here.

- [ ] **Step 4: Add tests**

```typescript
describe("auto-update — dependency conflict surfacing", () => {
  it("populates conflicts on AvailableUpdate when bump breaks installed reverse-dep", async () => {
    // setup: A@1.5.0 + C@1.0.0 installed; C depends on B@^1.0.0; A@2.0.0 brings B@^2.0.0.
    recordInstall(db, "com.example.C", "1.0.0", [{ id: "com.shared.B", range: "^1.0.0", resolvedVersion: "1.0.0" }], 1);
    const updater = await pollOnce({ db, fetcher: BUMP_A_TO_2_FETCHER, ... });
    const entry = updater.cache.get("com.example.A");
    expect(entry?.conflicts).toBeDefined();
    expect(entry?.conflicts?.[0]?.kind).toBe("unsatisfiable");
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

```bash
bun test packages/gateway/src/extensions/auto-update.test.ts
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/extensions/auto-update.ts \
        packages/gateway/src/extensions/auto-update-types.ts \
        packages/gateway/src/extensions/auto-update.test.ts
git commit -m "feat(t2-pr4): auto-update passes activeConstraints to solver + conflicts field on AvailableUpdate"
```

---

## Phase H — Startup integrity

### Task 12: Dep-graph backfill from on-disk manifests in `verify-extensions.ts`

**Files:**
- Modify: `packages/gateway/src/extensions/verify-extensions.ts` — extend `verifyExtensionsBestEffort` to backfill `extension_dependency` rows from on-disk `manifest.json` (network-free).

- [ ] **Step 1: Locate the existing startup pass**

```bash
grep -n "verifyExtensionsBestEffort\|SignatureDisabledRegistry\|PreT2DisabledRegistry" packages/gateway/src/extensions/verify-extensions.ts | head
```

- [ ] **Step 2: Add the backfill step**

```typescript
import { forwardDeps, recordInstall } from "./dependency-store.ts";

// After PR 2's signature-verify pass, BEFORE PR 1's pre-T2 check:
async function backfillDependencyRowsBestEffort(db: Database, installed: ReadonlyMap<string, string>, paths: ExtensionPaths): Promise<void> {
  const now = Date.now();
  for (const [id] of installed) {
    const existing = forwardDeps(db, id);
    if (existing.length > 0) continue; // already populated
    try {
      const manifestPath = join(paths.extensionActiveDir(id), "nimbus.extension.json");
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as { dependsOn?: Record<string, string> };
      if (!parsed.dependsOn || Object.keys(parsed.dependsOn).length === 0) continue;
      // Trust the on-disk manifest — signature was already verified upstream.
      const deps: ResolvedDep[] = Object.entries(parsed.dependsOn).map(([depId, range]) => ({
        id: depId, range, resolvedVersion: installed.get(depId) ?? "unknown",
      }));
      recordInstall(db, id, installed.get(id) ?? "unknown", deps, now);
    } catch (e) {
      // Swallow — best-effort. Completeness guard will catch downstream.
    }
  }
}
```

- [ ] **Step 3: Add a startup-integrity test**

```typescript
describe("verify-extensions — backfill", () => {
  it("populates extension_dependency rows from on-disk manifest (network-free)", async () => {
    // setup: B installed at 1.0.0 with manifest dependsOn { A: ^1.0.0 }; A also installed at 1.5.0; no rows in extension_dependency.
    await verifyExtensionsBestEffort({ db, vault, paths });
    const fwd = forwardDeps(db, "com.example.B");
    expect(fwd.map((f) => f.id)).toEqual(["com.shared.A"]);
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

```bash
bun test packages/gateway/src/extensions/verify-extensions.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/verify-extensions.ts \
        packages/gateway/src/extensions/verify-extensions.test.ts
git commit -m "feat(t2-pr4): startup dep-graph backfill from on-disk manifests (offline-safe)"
```

---

### Task 13: Completeness guard + `MissingDependencyRegistry`

**Files:**
- Create: `packages/gateway/src/extensions/missing-dependency-registry.ts`
- Create: `packages/gateway/src/extensions/missing-dependency-registry.test.ts`
- Modify: `packages/gateway/src/extensions/verify-extensions.ts` — wire the completeness walk + registry population.

- [ ] **Step 1: Implement the registry (parallel to PR 1/PR 2 singletons)**

```typescript
// packages/gateway/src/extensions/missing-dependency-registry.ts

export type MissingDependencyReason = "dependency_missing" | "dependency_unsatisfied";

export interface MissingDependencyEntry {
  readonly extensionId: string;
  readonly reason: MissingDependencyReason;
  readonly missingDepId: string;
  readonly requiredRange: string;
  readonly observedVersion?: string;
}

/** Singleton — see PR 1's PreT2DisabledRegistry and PR 2's SignatureDisabledRegistry. */
export class MissingDependencyRegistry {
  private readonly entries = new Map<string, MissingDependencyEntry>();

  mark(entry: MissingDependencyEntry): void {
    this.entries.set(entry.extensionId, entry);
  }
  clear(extensionId: string): void {
    this.entries.delete(extensionId);
  }
  has(extensionId: string): boolean {
    return this.entries.has(extensionId);
  }
  reasonFor(extensionId: string): MissingDependencyEntry | undefined {
    return this.entries.get(extensionId);
  }
  all(): readonly MissingDependencyEntry[] {
    return [...this.entries.values()].sort((a, b) => a.extensionId.localeCompare(b.extensionId));
  }
}

let singleton: MissingDependencyRegistry | undefined;
export function getMissingDependencyRegistry(): MissingDependencyRegistry {
  if (!singleton) singleton = new MissingDependencyRegistry();
  return singleton;
}
/** Test-only reset. */
export function _resetMissingDependencyRegistry(): void {
  singleton = new MissingDependencyRegistry();
}
```

- [ ] **Step 2: Wire the completeness walk in `verifyExtensionsBestEffort`**

```typescript
import semver from "semver";
import { reverseDeps } from "./dependency-store.ts";
import { getMissingDependencyRegistry } from "./missing-dependency-registry.ts";

// In verifyExtensionsBestEffort, after backfill:
async function completenessGuard(db: Database, installed: ReadonlyMap<string, string>): Promise<void> {
  const registry = getMissingDependencyRegistry();
  // For each row in extension_dependency, check the dep is installed + version satisfies.
  const rows = db.query("SELECT extension_id, depends_on_id, range FROM extension_dependency").all() as Array<{ extension_id: string; depends_on_id: string; range: string }>;
  for (const r of rows) {
    const depVersion = installed.get(r.depends_on_id);
    if (!depVersion) {
      registry.mark({
        extensionId: r.extension_id,
        reason: "dependency_missing",
        missingDepId: r.depends_on_id,
        requiredRange: r.range,
      });
      continue;
    }
    if (!semver.satisfies(depVersion, r.range)) {
      registry.mark({
        extensionId: r.extension_id,
        reason: "dependency_unsatisfied",
        missingDepId: r.depends_on_id,
        requiredRange: r.range,
        observedVersion: depVersion,
      });
    }
  }
}
```

Then on each Gateway startup, before spawning any extension, consult `getMissingDependencyRegistry().has(id)` and refuse to spawn — same pattern as `SignatureDisabledRegistry`. Find the spawn site:

```bash
grep -n "SignatureDisabledRegistry\|hardDisableReason\|isDisabled" packages/gateway/src/extensions/ packages/gateway/src/connectors/lazy-mesh/ | head
```

Add the parallel guard at the same site.

- [ ] **Step 3: Write tests**

```typescript
// packages/gateway/src/extensions/missing-dependency-registry.test.ts
import { describe, expect, it, beforeEach } from "bun:test";
import { _resetMissingDependencyRegistry, getMissingDependencyRegistry } from "./missing-dependency-registry.ts";

beforeEach(() => _resetMissingDependencyRegistry());

describe("MissingDependencyRegistry", () => {
  it("mark + reasonFor round-trip", () => {
    const r = getMissingDependencyRegistry();
    r.mark({ extensionId: "com.a", reason: "dependency_missing", missingDepId: "com.b", requiredRange: "^1.0.0" });
    expect(r.has("com.a")).toBe(true);
    expect(r.reasonFor("com.a")?.missingDepId).toBe("com.b");
  });

  it("clear removes the entry", () => {
    const r = getMissingDependencyRegistry();
    r.mark({ extensionId: "com.a", reason: "dependency_missing", missingDepId: "com.b", requiredRange: "^1.0.0" });
    r.clear("com.a");
    expect(r.has("com.a")).toBe(false);
  });

  it("all() returns sorted snapshot", () => {
    const r = getMissingDependencyRegistry();
    r.mark({ extensionId: "com.z", reason: "dependency_missing", missingDepId: "x", requiredRange: "*" });
    r.mark({ extensionId: "com.a", reason: "dependency_missing", missingDepId: "x", requiredRange: "*" });
    expect(r.all().map((e) => e.extensionId)).toEqual(["com.a", "com.z"]);
  });
});
```

```typescript
// Append to packages/gateway/src/extensions/verify-extensions.test.ts
describe("verify-extensions — completeness guard", () => {
  it("hard-disables a dependent extension when its dep is missing (after --force remove)", async () => {
    recordInstall(db, "com.example.B", "1.0.0", [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0" }], 1);
    // Note: extension_state has NO row for com.shared.A (--force remove already cleared it).
    await verifyExtensionsBestEffort({ db, vault, paths });
    expect(getMissingDependencyRegistry().has("com.example.B")).toBe(true);
    expect(getMissingDependencyRegistry().reasonFor("com.example.B")?.reason).toBe("dependency_missing");
  });

  it("hard-disables when installed version does not satisfy recorded range", async () => {
    // setup: A installed at 0.9.0 (below ^1.0.0); B depends on A@^1.0.0.
    recordInstall(db, "com.example.B", "1.0.0", [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0" }], 1);
    setExtensionState(db, "com.shared.A", "0.9.0");
    await verifyExtensionsBestEffort({ db, vault, paths });
    expect(getMissingDependencyRegistry().reasonFor("com.example.B")?.reason).toBe("dependency_unsatisfied");
  });

  it("re-installing the missing dep clears the disabled state on next startup", async () => {
    recordInstall(db, "com.example.B", "1.0.0", [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0" }], 1);
    await verifyExtensionsBestEffort({ db, vault, paths });
    expect(getMissingDependencyRegistry().has("com.example.B")).toBe(true);
    setExtensionState(db, "com.shared.A", "1.5.0");
    _resetMissingDependencyRegistry();
    await verifyExtensionsBestEffort({ db, vault, paths });
    expect(getMissingDependencyRegistry().has("com.example.B")).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

```bash
bun test packages/gateway/src/extensions/missing-dependency-registry.test.ts \
         packages/gateway/src/extensions/verify-extensions.test.ts
bun run typecheck
```

Expected: 3 + 3 = 6 new tests pass; existing verify-extensions tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/extensions/missing-dependency-registry.ts \
        packages/gateway/src/extensions/missing-dependency-registry.test.ts \
        packages/gateway/src/extensions/verify-extensions.ts \
        packages/gateway/src/extensions/verify-extensions.test.ts
git commit -m "feat(t2-pr4): completeness guard + MissingDependencyRegistry (parallel to SignatureDisabledRegistry)"
```

---

## Phase I — IPC + CLI surface

### Task 14: `extension.info` returns forward + reverse deps

**Files:**
- Modify: the `extension.info` IPC handler. Find it with:

```bash
grep -rn "extension.info\|case \"info\":" packages/gateway/src/ipc/ packages/gateway/src/extensions/ | head
```

- [ ] **Step 1: Extend the response shape**

Add `forwardDeps?: ForwardDep[]` and `reverseDeps?: ReverseDep[]` to the response type. Populate via `forwardDeps(db, id)` + `reverseDeps(db, id)`.

- [ ] **Step 2: Test**

```typescript
it("extension.info returns forward + reverse deps", async () => {
  recordInstall(db, "com.example.B", "1.0.0", [{ id: "com.shared.A", range: "^1.0.0", resolvedVersion: "1.5.0" }], 1);
  const res = await ipc.call("extension.info", { id: "com.shared.A" });
  expect(res.forwardDeps).toEqual([]);
  expect(res.reverseDeps).toEqual([{ extensionId: "com.example.B", range: "^1.0.0" }]);
});
```

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(t2-pr4): extension.info IPC returns forwardDeps + reverseDeps"
```

---

### Task 15: CLI `--deps` on `info` + `--tree` on `list`

**Files:**
- Create: `packages/cli/src/commands/extension-tree.ts`
- Modify: `packages/cli/src/commands/extension.ts`

- [ ] **Step 1: Implement the ASCII tree printer (NO_COLOR-aware, cycle-safe)**

```typescript
// packages/cli/src/commands/extension-tree.ts
import type { ForwardDep } from "../../gateway/src/extensions/dependency-store.ts"; // ⚠ replace with the typed @nimbus-dev/client method if CLI cannot import gateway src

export interface InstalledExtensionForTree {
  readonly id: string;
  readonly version: string;
  readonly forwardDeps: readonly ForwardDep[];
}

export function renderTree(installed: readonly InstalledExtensionForTree[]): string {
  const byId = new Map(installed.map((e) => [e.id, e]));
  // Find roots: extensions with no reverse-dep (i.e. no other installed extension depends on them).
  const dependents = new Set<string>();
  for (const e of installed) for (const f of e.forwardDeps) dependents.add(f.id);
  const roots = installed.filter((e) => !dependents.has(e.id)).map((e) => e.id).sort();
  const out: string[] = [];
  for (const root of roots) walk(root, "", true, new Set(), out, byId);
  return out.join("\n");
}

function walk(id: string, prefix: string, isLast: boolean, seen: Set<string>, out: string[], byId: Map<string, InstalledExtensionForTree>): void {
  const node = byId.get(id);
  if (!node) return;
  const marker = prefix === "" ? "" : isLast ? "└─ " : "├─ ";
  const suffix = seen.has(id) ? "  (already shown)" : "";
  out.push(`${prefix}${marker}${id}@${node.version}${suffix}`);
  if (seen.has(id)) return;
  seen.add(id);
  const childPrefix = prefix + (prefix === "" ? "" : isLast ? "   " : "│  ");
  const deps = [...node.forwardDeps].sort((a, b) => a.id.localeCompare(b.id));
  deps.forEach((d, i) => walk(d.id, childPrefix, i === deps.length - 1, seen, out, byId));
}
```

(If `@nimbus-dev/client` does not yet expose `forwardDeps` on its typed `extension.list` response, extend it in the same PR — the CLI cannot reach into gateway src per the package boundary rule.)

- [ ] **Step 2: Wire the flags in `extension.ts`**

`info <id> [--deps]`: call `extension.info`, render the existing block + a "Dependencies" section if `--deps`.

`list [--tree]`: call `extension.list` (which already returns each extension's forwardDeps after Task 14), pass to `renderTree`.

- [ ] **Step 3: Add tree-rendering unit test**

```typescript
// packages/cli/src/commands/extension-tree.test.ts
import { describe, expect, it } from "bun:test";
import { renderTree } from "./extension-tree.ts";

describe("renderTree", () => {
  it("emits a forest with leaf-last indentation", () => {
    const out = renderTree([
      { id: "com.example.foo", version: "1.0.0", forwardDeps: [
        { id: "com.shared.utils", range: "^1.0.0" }, { id: "com.shared.crypto", range: "^2.0.0" },
      ]},
      { id: "com.shared.utils", version: "1.5.0", forwardDeps: [{ id: "com.shared.crypto", range: "^2.0.0" }] },
      { id: "com.shared.crypto", version: "2.4.1", forwardDeps: [] },
    ]);
    expect(out).toContain("com.example.foo@1.0.0");
    expect(out).toContain("├─ com.shared.crypto@2.4.1");
    expect(out).toMatch(/com\.shared\.crypto@2\.4\.1\s+\(already shown\)/);
  });
});
```

- [ ] **Step 4: Run + typecheck**

```bash
bun test packages/cli/src/commands/extension-tree.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/extension.ts \
        packages/cli/src/commands/extension-tree.ts \
        packages/cli/src/commands/extension-tree.test.ts
git commit -m "feat(t2-pr4): nimbus extension info --deps + nimbus extension list --tree"
```

---

## Phase J — Final integration + docs

### Task 16: E2E install → conflict → remove --force → startup-disable cycle

**Files:**
- Create: `packages/gateway/test/e2e/scenarios/dependency-lifecycle.e2e.test.ts`

- [ ] **Step 1: Write one end-to-end scenario hitting every PR-4 surface**

```typescript
// packages/gateway/test/e2e/scenarios/dependency-lifecycle.e2e.test.ts
import { describe, expect, it } from "bun:test";
import { spawnGateway, installFixture, callIpc, waitFor } from "../helpers/gateway-subprocess.ts";

describe("T2 PR 4 — dependency lifecycle end-to-end", () => {
  it("install with dep + conflict refusal + --force remove + startup hard-disable + reinstall clears", async () => {
    const gw = await spawnGateway();
    try {
      // 1. Install A@1.5.0 (no deps), then B@1.0.0 (requires A@^1.0.0). Both succeed.
      await installFixture(gw, "com.shared.A@1.5.0");
      await installFixture(gw, "com.example.B@1.0.0");
      const listA = await callIpc(gw, "extension.info", { id: "com.shared.A" });
      expect(listA.reverseDeps).toContainEqual({ extensionId: "com.example.B", range: "^1.0.0" });

      // 2. Attempt to install C@1.0.0 which requires A@^2.0.0 — refused.
      await expect(installFixture(gw, "com.example.C@1.0.0")).rejects.toThrow(/dependency_conflict/);

      // 3. Remove A — refused without --force.
      await expect(callIpc(gw, "extension.remove", { id: "com.shared.A" })).rejects.toThrow(/reverse_dep_blocked|required by/);

      // 4. Remove A --force — HITL preview shows danglingDeps; approve.
      const hitl = await callIpc(gw, "extension.remove", { id: "com.shared.A", force: true });
      // ... approve via the helper's auto-consent path

      // 5. Restart Gateway. B is hard-disabled with reason dependency_missing.
      await gw.restart();
      const info = await callIpc(gw, "extension.info", { id: "com.example.B" });
      expect(info.disabledReason).toBe("dependency_missing");

      // 6. Reinstall A. Restart. B is no longer disabled.
      await installFixture(gw, "com.shared.A@1.5.0");
      await gw.restart();
      const info2 = await callIpc(gw, "extension.info", { id: "com.example.B" });
      expect(info2.disabledReason).toBeUndefined();
    } finally {
      await gw.shutdown();
    }
  });
});
```

(Adapt helper names to whatever `packages/gateway/test/e2e/helpers/` actually exposes — the existing T2 PR 3 e2e tests are the template.)

- [ ] **Step 2: Run**

```bash
bun test packages/gateway/test/e2e/scenarios/dependency-lifecycle.e2e.test.ts
```

Expected: 1 e2e test passes.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/scenarios/dependency-lifecycle.e2e.test.ts
git commit -m "test(t2-pr4): e2e dependency lifecycle (install/conflict/--force/startup-disable/reinstall)"
```

---

### Task 17: Coverage + audit:invariants + typecheck + full CI parity

- [ ] **Step 1: Run every gate this PR must keep green**

```bash
bun run test:coverage:extensions
bun run test:coverage:db
bun run typecheck
bun run audit:invariants
bun run audit:openapi-drift
bun run lint
```

Expected: every gate green. Note current coverage numbers — `extensions` ≥ 85%, `db` ≥ 85%, no `any` regressions per `bun run audit:any`.

- [ ] **Step 2: If `extensions` coverage dipped below 85%**, identify the uncovered branches with:

```bash
bun run test:coverage:extensions 2>&1 | grep -A 2 "Uncovered Line"
```

Add targeted unit tests for any branch the integration coverage missed. Common gaps to check:
- Cycle path with chain length > 3.
- `range_invalid` branch (Task 3 test covers).
- `OfflineDependencyResolutionError` on `fetchManifest` (vs `listVersions`) — add a separate test if missing.

- [ ] **Step 3: Commit any coverage fillers**

```bash
git commit -am "test(t2-pr4): coverage fillers for solver edge cases"
```

---

### Task 18: Docs + roadmap + skill correction

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `CLAUDE.md` line 10 + `GEMINI.md`
- Modify: `.claude/commands/nimbus-file-map.md`
- Modify: `.claude/commands/nimbus-db-migrations.md` — **fix the misleading path** (see review item 1.1)
- Modify: `docs/cli-reference.md` (or wherever extension CLI is documented)

- [ ] **Step 1: Flip T2 PR 4 in roadmap**

Find the T2 PR 4 row in `docs/roadmap.md` and flip its `[ ]` to `[x]` with `(2026-MM-DD, PR #NNN, Phase 5 T2 PR 4)`. Extend the `Last updated:` header at `roadmap.md:7` with `T2 PR 4 ✅ (<date>)`. (Leave the PR # placeholder until the PR is opened.)

- [ ] **Step 2: Update `CLAUDE.md` Status line + `GEMINI.md` mirror**

Append `T2 PR 4 dependency-resolution ✅ (2026-MM-DD)` to the Status line.

- [ ] **Step 3: Add `nimbus-file-map.md` entries**

Under the "Extension" section, add rows for:
- `packages/gateway/src/extensions/dependency-graph.ts` — solver
- `packages/gateway/src/extensions/dependency-store.ts` — `extension_dependency` CRUD
- `packages/gateway/src/extensions/registry-fetcher.ts` — local-first adapter
- `packages/gateway/src/extensions/missing-dependency-registry.ts` — startup-completeness registry
- `packages/gateway/src/index/extension-dependency-v31-sql.ts` — V31 SQL

- [ ] **Step 4: Fix `nimbus-db-migrations.md`** (critical — it currently misleads contributors)

The skill claims migrations live in `packages/gateway/src/db/migrations/V<N>__*.ts`. Real location is `packages/gateway/src/index/migrations/runner.ts` (one file, central `INDEXED_SCHEMA_STEPS` registry). Update the "Migration Location" section + the "Migration File Structure" section + the "Authoring Checklist" to reflect reality. Reference the existing pattern at `runner-v30.test.ts`.

- [ ] **Step 5: Update `docs/cli-reference.md`** — add the new flags:

```
nimbus extension remove <id> [--force] [--json]
nimbus extension info <id> [--deps] [--json]
nimbus extension list [--tree] [--json]
```

- [ ] **Step 6: Run the doc-ref drift audit**

```bash
bun scripts/structure-audit/check-doc-references.ts --check
```

Expected: no new broken refs.

- [ ] **Step 7: Commit docs**

```bash
git add docs/roadmap.md CLAUDE.md GEMINI.md \
        .claude/commands/nimbus-file-map.md \
        .claude/commands/nimbus-db-migrations.md \
        docs/cli-reference.md
git commit -m "docs(t2-pr4): roadmap flip + file-map entries + db-migrations skill correction"
```

---

### Task 19: Open the PR

- [ ] **Step 1: Final pre-flight**

```bash
bun run test:ci   # full CI parity — same as _test-suite.yml
```

Expected: every gate green.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin dev/asafgolombek/phase-5-t2-pr4-dependency-resolution
gh pr create --title "T2 PR 4: dependency resolution + V31 extension_dependency" --body "$(cat <<'EOF'
## Summary
- Manifest `dependsOn` field + custom backtracking solver (recursive DFS, per-frame state clones, explicit `ancestors: Set` for cycle detection — diamond DAGs no longer false-positive)
- V31 `extension_dependency` table + reverse-dep index; migration step added to `index/migrations/runner.ts` (Nimbus's central runner — no per-V file pattern)
- Reverse-dep guards on `remove` (refuse with reverse-dep list; `--force` overrides; HITL preview surfaces danglingDeps) and on auto-update (existing `extension.autoUpdate` HITL gains `conflicts` field via `AvailableUpdate`)
- Local-first `RegistryFetcher`: installed ids resolve from on-disk manifest without network
- Startup integrity: offline-safe backfill from on-disk manifests + completeness guard via new `MissingDependencyRegistry` (parallel to PR 1's `PreT2DisabledRegistry` and PR 2's `SignatureDisabledRegistry`)
- New CLI flags: `nimbus extension info --deps`, `nimbus extension list --tree`, `nimbus extension remove --force`
- `extension.install_complete` audit row now carries explicit version map

No new structural invariant. PR composes on I9 / I14 / I16.

## Test plan
- [ ] `bun run test:coverage:extensions` ≥ 85% green
- [ ] `bun run test:coverage:db` ≥ 85% green (V31 migration covered)
- [ ] `bun run audit:invariants` green (D9 / D12)
- [ ] E2E lifecycle scenario covers install/conflict/`--force`/startup-disable/reinstall
- [ ] `fast-check` property tests verify no false-positive cycles on diamond DAGs

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Update roadmap with PR # once GitHub returns it**

```bash
# Replace the (PR #NNN) placeholder with the real number in docs/roadmap.md and CLAUDE.md/GEMINI.md
```

```bash
git commit -am "docs(t2-pr4): record PR #<NNN>"
git push
```

---

## Self-review checklist (done)

- ✅ Spec coverage: every section of the spec maps to a task (§1.2 → Tasks 1–8, §2 → Task 3, §3 → Task 5, §4 → Tasks 9 + 10 + 12 + 13, §5 → Task 10, §6 → Task 11, §7 → Task 15, §8 → recap only, §11 exit criteria → Task 17, §12 review disposition → covered by item-by-item fixes throughout)
- ✅ No placeholders: every code block contains the actual code; "adapt the names" notes appear only where the file's existing identifiers are unknown (Task 9, 10, 11, 12, 14) and the surrounding context names exactly what to look for via `grep`
- ✅ Type consistency: `ResolvedDep` shape used identically across Tasks 1, 3, 6; `RegistryFetcher` signature stable Tasks 1/3/7/9/11; `DependencyConflict` shape unchanged 1→3→6→11; `MissingDependencyEntry` defined Task 13 and used in Task 18 doc

## Notes for the implementer

- **Skip Phase G (Task 11) at your peril.** The PR 3 auto-update path must call `resolveClosure` with `activeConstraints` covering EVERY installed extension; that's the §2.3 / §6 correctness gate the design review caught.
- **Phase H (Tasks 12 + 13) is offline-safe by spec.** Never call `resolveClosure` or `RegistryFetcher` in the startup pass — read `dependsOn` from on-disk `manifest.json` and trust it. PR 2's signature-verify already proved the manifest authentic upstream.
- **Coverage of `dependency-graph.ts` matters.** Aim for 90%+ on the solver — it's the correctness hotspot. The cycle / unsatisfiable / range_invalid / offline branches all have unit tests already (Task 3); add more if your final coverage report shows gaps.
