# Ownership Read Surface (`agents.ownership`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ownership graph that PR A derives on every sync readable, as a built-in read-only agent reachable from the CLI, the local HTTP API and MCP.

**Architecture:** A new read-only module pair under `packages/gateway/src/ownership/` (`ownership-target.ts` resolves a caller path onto a configured repo root; `ownership-store.ts` queries the graph) feeds a new built-in agent `agents/ownership.ts`, which follows the `agents/decisions.ts` shape exactly: parallel `AgentCoordinator` lanes over local SQLite, a typed brief, and `emitBriefWithSynthesis`. Registering the agent in `AGENTS_RPC_HANDLERS` grants HTTP invocation and egress-ledger coverage with no route work. A separate `ownership.refresh` maintenance method gives `OwnershipRefresher.run()` its first production caller.

**Tech Stack:** Bun 1.2+ / TypeScript 7.x strict · `bun:sqlite` · `bun:test` · Biome · Rust (one Tauri allowlist constant)

**Spec:** [`docs/superpowers/specs/2026-08-07-ownership-read-surface-design.md`](../specs/2026-08-07-ownership-read-surface-design.md). Read §5, §6 and §8 before Task 1.

**Worktree:** `C:\gitrep\Nimbus\.claude\worktrees\ownership-agent`, branch `dev/asafgolombek/ownership-agent`, based on `origin/main` = `82c03d27`. `bun install` has already been run. **Every path in this plan is relative to that worktree**, and Read/Edit calls must use its absolute path — the same relative path under `C:\gitrep\Nimbus\` is a different checkout at `main`.

---

## Global Constraints

Every task's requirements implicitly include all of these.

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **No new migration.** `CURRENT_SCHEMA_VERSION` stays **51**. Every table and relation type this plan reads already exists. If you find yourself writing a migration, stop — you have misread the plan.
- **`WRITE_ROUTE_ALLOWLIST` stays at 13.** Do not edit `packages/gateway/src/security-invariants.test.ts` or `packages/gateway/src/ipc/http-write-routes.test.ts`. `POST /v1/agents/{agent}` already exists and `HTTP_AGENT_NAMES` is derived.
- **Do not touch `@nimbus-dev/sdk`.** It is a separate repository consumed as a published package. `AGENT_NAMES` / `AGENT_KIND` in `node_modules/@nimbus-dev/sdk/src/agents/agent-names.ts` list only the nine Phase-5/6 agents; `glossary` and `decisions` are deliberately absent and define their brief types locally. `OwnershipBrief` does the same. `AgentBriefRouter.expect()` takes a plain `string`, not `AgentName`, so nothing forces an SDK change.
- **`GapNote.category` is a closed SDK union** — exactly `"missing_entity_type" | "missing_relation_emit" | "missing_connector" | "missing_user_identity" | "empty_index"`. Inventing a sixth is a compile error.
- **All SQL is bound-param** (I9/I14). Reads go through `db.query(...).get()/.all()`; writes through `dbRun`/`dbExec` from `db/write.ts`.
- **Cross-platform:** build paths with `node:path`, never hardcoded separators. Root paths in tests use POSIX-style literals (`/repo/alpha`), matching `ownership-pass.test.ts:12`.
- **Commit on the worktree branch only.** Verify with `git rev-parse --abbrev-ref HEAD` → `dev/asafgolombek/ownership-agent`.
- **Red-prove every guard.** Each task that adds a test says explicitly which line to break and what failure to expect. Run the break, see the failure, revert exactly. Four tests shipped in PR A that passed whether the feature worked or not.
- **After any patch-based edit, grep the mutated file** to confirm the mutation applied before trusting a green run.

---

## File Structure

**New (gateway)**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/ownership/ownership-target.ts` | Caller path → `{repoRoot, relPath}`, using the merged root set. No graph access. |
| `packages/gateway/src/ownership/ownership-store.ts` | Read queries over `graph_entity` / `graph_relation` / `ownership_pass_state`. No writes. |
| `packages/gateway/src/agents/_lib/ownership-types.ts` | `OwnershipBrief` and its members. |
| `packages/gateway/src/agents/ownership.ts` | The agent: lanes, gap notes, `emitOwnershipBrief`. |
| `packages/gateway/src/ipc/ownership-rpc.ts` | `ownership.refresh`. |

**New (CLI)**

| File | Responsibility |
| --- | --- |
| `packages/cli/src/commands/owners.ts` | `nimbus owners` arg parsing + `runAgentBriefCli` call. |

**Modified**

| File | Change |
| --- | --- |
| `packages/gateway/src/ownership/ownership-pass.ts` | `rankOwners` returns `aboveFloor`; three metadata sites. |
| `packages/gateway/src/ownership/ownership-refresh.ts` | `OwnershipRefresherError`. |
| `packages/gateway/src/agents/_lib/render.ts` | `renderOwnership`. |
| `packages/gateway/src/agents/_lib/synthesize.ts` | Union + two dispatches + exhaustiveness guard. |
| `packages/gateway/src/agents/_lib/emit-brief.ts` | `AnyBrief` union. |
| `packages/gateway/src/ipc/agents-rpc.ts` | Handler, map entry, `newSessionId` kind. |
| `packages/gateway/src/ipc/lan-rpc.ts` | `"ownership"` into `FORBIDDEN_OVER_LAN`. |
| `packages/gateway/src/ipc/server/{options,dispatchers}.ts` | `ownershipRefresher` + `tryDispatchOwnershipRpc`. |
| `packages/gateway/src/platform/assemble.ts` | `ipcOpts.ownershipRefresher`. |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | `agents.ownership`; count 103 → 104. |
| `packages/cli/src/commands/{registry,index}.ts`, `packages/cli/src/index.ts` | `owners` command wiring. |
| `packages/cli/src/mcp/agent-tools.ts` | One `AgentToolDef`. |

---

## Task Dependency Order

Tasks 1–2 are writer-side and independent of everything else. Tasks 3–4 are the read primitives. Task 5 is the brief plumbing. Task 6 needs 3, 4, 5. Task 7 needs 6. Tasks 8–13 follow 7.

---

### Task 1: Separate the share floor from the owner cap

**Files:**
- Modify: `packages/gateway/src/ownership/ownership-pass.ts:60-83` (`rankOwners`), `:471-481`, `:502-512`, `:551-569`
- Test: `packages/gateway/src/ownership/ownership-pass.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `rankOwners(weights, minShare, maxOwners)` now returns
  `{ emitted: { externalId: string; share: number }[]; totalOwners: number; aboveFloor: number; totalWeight: number }`.
  Graph entity metadata for `source_file`, `directory` and `service` becomes
  `{ ownerCount: number; ownersAboveFloor: number; truncated: boolean; totalWeightedLines: number }`.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe("rankOwners", …)` block in `packages/gateway/src/ownership/ownership-pass.test.ts`:

```ts
  test("truncated reflects the CAP alone — thresholded-out owners are not truncation", () => {
    // 23 owners, only 3 clear the 5% floor, cap of 10 never binds.
    const m = new Map<string, number>();
    m.set("a", 40);
    m.set("b", 30);
    m.set("c", 20);
    for (let i = 0; i < 20; i += 1) m.set(`tiny${String(i).padStart(2, "0")}`, 0.5);
    const out = rankOwners(m, 0.05, 10);

    expect(out.totalOwners).toBe(23);
    expect(out.aboveFloor).toBe(3);
    expect(out.emitted).toHaveLength(3);
    // The whole point: nothing was capped, so nothing was truncated.
    expect(out.emitted.length < out.aboveFloor).toBe(false);
  });

  test("aboveFloor counts survivors of the floor, before the cap", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 14; i += 1) m.set(`p${String(i).padStart(2, "0")}`, 10);
    const out = rankOwners(m, 0.05, 10);

    expect(out.totalOwners).toBe(14);
    expect(out.aboveFloor).toBe(14);
    expect(out.emitted).toHaveLength(10);
    expect(out.emitted.length < out.aboveFloor).toBe(true);
  });

  test("a cap exactly equal to aboveFloor does not count as truncation", () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 10; i += 1) m.set(`p${String(i)}`, 10);
    const out = rankOwners(m, 0.05, 10);

    expect(out.aboveFloor).toBe(10);
    expect(out.emitted).toHaveLength(10);
    expect(out.emitted.length < out.aboveFloor).toBe(false);
  });

  test("an all-zero weight map reports zero aboveFloor without dividing by zero", () => {
    const out = rankOwners(new Map([["a", 0]]), 0.05, 10);
    expect(out.totalWeight).toBe(0);
    expect(out.aboveFloor).toBe(0);
    expect(out.emitted).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test packages/gateway/src/ownership/ownership-pass.test.ts -t "rankOwners"
```

Expected: FAIL — `out.aboveFloor` is `undefined`, so `expect(undefined).toBe(3)` fails. The first test is the one that encodes the defect.

- [ ] **Step 3: Add `aboveFloor` to `rankOwners`**

Replace the body of `rankOwners` (`ownership-pass.ts:60-83`) with:

```ts
export function rankOwners(
  weights: ReadonlyMap<string, number>,
  minShare: number,
  maxOwners: number,
): {
  readonly emitted: { externalId: string; share: number }[];
  readonly totalOwners: number;
  readonly aboveFloor: number;
  readonly totalWeight: number;
} {
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;
  const totalOwners = weights.size;
  if (totalWeight <= 0) return { emitted: [], totalOwners, aboveFloor: 0, totalWeight: 0 };

  // `aboveFloor` is captured BETWEEN the floor and the cap, and that ordering is the
  // whole fix. Reporting `emitted.length < totalOwners` as truncation conflated two
  // unrelated facts: owners excluded by `min_share` (a policy the reader chose) and
  // owners dropped by `max_owners_per_path` (a display cap the reader did not).
  const survivors = [...weights.entries()]
    .map(([externalId, w]) => ({ externalId, share: w / totalWeight }))
    .filter((e) => e.share >= minShare)
    .sort((a, b) =>
      b.share !== a.share ? b.share - a.share : a.externalId.localeCompare(b.externalId),
    );

  return {
    emitted: survivors.slice(0, Math.max(0, maxOwners)),
    totalOwners,
    aboveFloor: survivors.length,
    totalWeight,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/ownership/ownership-pass.test.ts -t "rankOwners"
```

Expected: PASS, including the four pre-existing `rankOwners` tests.

- [ ] **Step 5: Update the two existing metadata sites**

In `ownership-pass.ts`, the `source_file` upsert (around `:471`) and the `directory` upsert (around `:502`) each carry a `metadata` block. Replace **both** occurrences of:

```ts
          metadata: {
            ownerCount: ranked.totalOwners,
            truncated: ranked.emitted.length < ranked.totalOwners,
            totalWeightedLines: ranked.totalWeight,
          },
```

with:

```ts
          metadata: {
            ownerCount: ranked.totalOwners,
            ownersAboveFloor: ranked.aboveFloor,
            truncated: ranked.emitted.length < ranked.aboveFloor,
            totalWeightedLines: ranked.totalWeight,
          },
```

Note the two sites differ in indentation (the `directory` one is inside a different block). Match each file's existing indentation exactly rather than pasting blindly, then grep to confirm both applied:

```bash
grep -n "ownersAboveFloor" packages/gateway/src/ownership/ownership-pass.ts
```

Expected: exactly 2 hits so far.

- [ ] **Step 6: Give the `service` entity the same metadata**

The service rollup loop currently upserts the entity and *then* ranks. Hoist the rank above the upsert. Replace (around `:551-569`):

```ts
    for (const [serviceId, weights] of serviceWeights) {
      const svcId = upsertGraphEntity(db, {
        type: "service",
        externalId: `service:${serviceId}`,
        label: serviceId,
        service: "nimbus",
      });
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
```

with:

```ts
    for (const [serviceId, weights] of serviceWeights) {
      // Ranked BEFORE the upsert so the same counts that drive emission also land on
      // the entity. A service's owner list is capped exactly like a file's, and until
      // now carried nothing to say so — leaving `--service`, the one lookup the whole
      // workspace → repo → service bridge exists to serve, unable to report its own
      // truncation.
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
      const svcId = upsertGraphEntity(db, {
        type: "service",
        externalId: `service:${serviceId}`,
        label: serviceId,
        service: "nimbus",
        metadata: {
          ownerCount: ranked.totalOwners,
          ownersAboveFloor: ranked.aboveFloor,
          truncated: ranked.emitted.length < ranked.aboveFloor,
          totalWeightedLines: ranked.totalWeight,
        },
      });
```

- [ ] **Step 7: Write the service-metadata integration test**

Append to the `describe("runOwnershipPass", …)` block:

```ts
  test("a service entity carries the same owner-count metadata as a file", async () => {
    seedLine(d, "src/a.ts", 1, "a@x.com", "A", 1);
    seedLine(d, "src/a.ts", 2, "b@x.com", "B", 1);
    await runOwnershipPass(
      d,
      baseOpts({
        spawn: fakeSpawn("origin\n", "git@github.com:acme/alpha.git"),
        serviceRepoUrns: new Map([["checkout", ["github:acme/alpha"]]]),
      }),
    );

    const row = d
      .query("SELECT metadata FROM graph_entity WHERE type = 'service' AND external_id = ?")
      .get("service:checkout") as { metadata: string | null } | null;
    expect(row).not.toBeNull();
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["ownerCount"]).toBe(2);
    expect(meta["ownersAboveFloor"]).toBe(2);
    expect(meta["truncated"]).toBe(false);
    expect(typeof meta["totalWeightedLines"]).toBe("number");
  });
```

- [ ] **Step 8: Run the full ownership suite**

```bash
bun test packages/gateway/src/ownership/ 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 9: Red-prove the fix**

Temporarily change `truncated: ranked.emitted.length < ranked.aboveFloor` back to `< ranked.totalOwners` at the `source_file` site. Run:

```bash
bun test packages/gateway/src/ownership/ownership-pass.test.ts -t "rankOwners"
```

The first new test must fail. **Revert exactly**, re-run, confirm green.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/ownership/ownership-pass.ts packages/gateway/src/ownership/ownership-pass.test.ts
git commit -m "fix(ownership): separate the share floor from the owner cap in entity metadata"
```

---

### Task 2: Give the refresher an rpcCode-carrying error class

**Files:**
- Modify: `packages/gateway/src/ownership/ownership-refresh.ts:1-20`, `:84-89`
- Test: `packages/gateway/src/ownership/ownership-refresh.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export class OwnershipRefresherError extends Error { readonly rpcCode: number }` — `rpcCode` is `-32000`, `name` is `"OwnershipRefresherError"`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/ownership/ownership-refresh.test.ts`:

```ts
test("run() rejects with an rpcCode-carrying error while a pass is in flight", async () => {
  let release: (() => void) | undefined;
  const r = createOwnershipRefresher({
    debounceMs: 5,
    runPass: async () => {
      await new Promise<void>((res) => {
        release = res;
      });
      return PASS_SUMMARY;
    },
  });

  const first = r.run();
  const err = await r.run().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(OwnershipRefresherError);
  expect((err as OwnershipRefresherError).rpcCode).toBe(-32000);
  expect((err as Error).message).toContain("ERR_OWNERSHIP_PASS_RUNNING");

  release?.();
  await first;
  r.stop();
});

test("run() after stop() rejects with an rpcCode-carrying error", async () => {
  const r = createOwnershipRefresher({ debounceMs: 5, runPass: async () => PASS_SUMMARY });
  r.stop();
  const err = await r.run().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(OwnershipRefresherError);
  expect((err as OwnershipRefresherError).rpcCode).toBe(-32000);
  expect((err as Error).message).toContain("ERR_OWNERSHIP_STOPPED");
});
```

Add `OwnershipRefresherError` to the existing import from `./ownership-refresh.ts`. If the test file has no `PASS_SUMMARY` constant, add one at the top:

```ts
const PASS_SUMMARY = {
  rootsTotal: 0,
  rootsCovered: 0,
  rootsWithRemote: 0,
  filesCovered: 0,
  filesExcluded: 0,
  servicesBound: 0,
  ownersEmitted: 0,
  entitiesReaped: 0,
  durationMs: 0,
} as const;
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/ownership/ownership-refresh.test.ts
```

Expected: FAIL — `OwnershipRefresherError` is not exported.

- [ ] **Step 3: Add the class and use it**

At the top of `packages/gateway/src/ownership/ownership-refresh.ts`, after the existing import:

```ts
/**
 * Carries `rpcCode` so `ipc/ownership-rpc.ts` maps it without re-deriving a code, and so a
 * caller can branch on the CLASS rather than string-matching a message. Mirrors
 * `DecisionRefresherError` (`decisions/decision-refresh.ts`). Both refreshers use -32000
 * (JSON-RPC implementation-defined server error).
 */
export class OwnershipRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "OwnershipRefresherError";
    this.rpcCode = -32000;
  }
}
```

Then replace both throws in `run()` (`:85` and `:88`):

```ts
      if (stopped) {
        throw new OwnershipRefresherError("ERR_OWNERSHIP_STOPPED: the gateway is shutting down");
      }
      if (running) {
        throw new OwnershipRefresherError(
          "ERR_OWNERSHIP_PASS_RUNNING: an ownership pass is already running",
        );
      }
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/gateway/src/ownership/ownership-refresh.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ownership/ownership-refresh.ts packages/gateway/src/ownership/ownership-refresh.test.ts
git commit -m "fix(ownership): carry rpcCode on refresher errors instead of plain Errors"
```

---

### Task 3: Resolve a caller path onto a configured root

**Files:**
- Create: `packages/gateway/src/ownership/ownership-target.ts`
- Test: `packages/gateway/src/ownership/ownership-target.test.ts`

**Interfaces:**
- Consumes: `matchConfiguredRoot` from `../agents/_lib/why-subject.ts`; `gitAwareRootPaths`, `loadRegisteredRoots` from `../index/registered-roots-store.ts`; `loadNimbusFilesystemRootsFromConfigDir` from `../config/filesystem-toml.ts`.
- Produces:
  - `type ResolvedOwnershipPath = { readonly repoRoot: string; readonly relPath: string }` — `relPath` is `""` for the root itself, POSIX-separated otherwise.
  - `function ownershipRoots(configDir: string): string[]`
  - `function resolveOwnershipPath(roots: readonly string[], refPath: string, exists?: (p: string) => boolean): ResolvedOwnershipPath | null`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ownership/ownership-target.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { resolveOwnershipPath } from "./ownership-target.ts";

const ROOTS = ["/repo/alpha", "/repo/beta"];
const onDisk = new Set(["/repo/alpha/src/a.ts", "/repo/alpha/src", "/repo/beta/lib/b.ts"]);
const exists = (p: string): boolean => onDisk.has(p.replaceAll("\\", "/"));

describe("resolveOwnershipPath", () => {
  test("resolves an absolute path inside a root", () => {
    expect(resolveOwnershipPath(ROOTS, "/repo/alpha/src/a.ts", exists)).toEqual({
      repoRoot: "/repo/alpha",
      relPath: "src/a.ts",
    });
  });

  test("resolves a relative path against the root that contains it", () => {
    expect(resolveOwnershipPath(ROOTS, "lib/b.ts", exists)).toEqual({
      repoRoot: "/repo/beta",
      relPath: "lib/b.ts",
    });
  });

  test("resolves the root itself, which the shared why fence rejects", () => {
    // `matchConfiguredRoot` returns null when rel === "" — correct for `why`, whose
    // subject must be a file. The ownership graph HAS a root-directory node
    // (`dir:<root>:`), so this case must resolve here.
    expect(resolveOwnershipPath(ROOTS, "/repo/alpha", exists)).toEqual({
      repoRoot: "/repo/alpha",
      relPath: "",
    });
  });

  test("resolves `.` to the first root", () => {
    expect(resolveOwnershipPath(ROOTS, ".", exists)).toEqual({
      repoRoot: "/repo/alpha",
      relPath: "",
    });
  });

  test("rejects a relative path that escapes its root", () => {
    expect(resolveOwnershipPath(ROOTS, "../outside/x.ts", exists)).toBeNull();
  });

  test("rejects an absolute path outside every root", () => {
    expect(resolveOwnershipPath(ROOTS, "/elsewhere/x.ts", exists)).toBeNull();
  });

  test("rejects a relative path that exists nowhere", () => {
    expect(resolveOwnershipPath(ROOTS, "src/gone.ts", exists)).toBeNull();
  });

  test("returns null when no roots are configured", () => {
    expect(resolveOwnershipPath([], "/repo/alpha/src/a.ts", exists)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/ownership/ownership-target.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/ownership/ownership-target.ts`:

```ts
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { matchConfiguredRoot } from "../agents/_lib/why-subject.ts";
import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { gitAwareRootPaths, loadRegisteredRoots } from "../index/registered-roots-store.ts";

/** A caller path mapped onto a configured root. `relPath` is `""` for the root itself. */
export type ResolvedOwnershipPath = {
  readonly repoRoot: string;
  readonly relPath: string;
};

/**
 * The COMPLETE git-aware root set — BOTH `[[filesystem.roots]]` TOML blocks and the
 * CLI-registered roots in `registered-roots.json`.
 *
 * This must match what `platform/assemble.ts` hands `runOwnershipPass` exactly. Copying
 * `agents/why.ts`'s `whyRoots` (TOML only) would report "no ownership data" for every path
 * under a `nimbus index add` root — paths the pass has already blamed, ranked and written
 * edges for, because `registerFilesystemRootSyncables` runs the blame indexer over the
 * merged set. `gitAwareRootPaths` is the single source of truth for that set and carries
 * the doc comment saying so.
 */
export function ownershipRoots(configDir: string): string[] {
  return gitAwareRootPaths(
    loadNimbusFilesystemRootsFromConfigDir(configDir),
    loadRegisteredRoots(configDir),
  );
}

/**
 * `matchConfiguredRoot` takes the full TOML record but reads only `.path`. The other
 * fields are filled with the inert values a read path cannot act on.
 */
function asRootRecords(roots: readonly string[]): NimbusFilesystemRootToml[] {
  return roots.map((path) => ({
    path,
    gitAware: true,
    codeIndex: false,
    dependencyGraph: false,
    exclude: [],
  }));
}

/** True when `refPath` names one of the roots itself, rather than something inside one. */
function matchRootItself(roots: readonly string[], refPath: string): ResolvedOwnershipPath | null {
  for (const root of roots) {
    const candidate = isAbsolute(refPath) ? resolve(refPath) : resolve(join(root, refPath));
    if (candidate === resolve(root)) return { repoRoot: root, relPath: "" };
  }
  return null;
}

/**
 * Map a caller-supplied path onto a configured root.
 *
 * The containment fence runs FIRST and unconditionally: `matchConfiguredRoot`
 * (`agents/_lib/why-subject.ts`) rejects a `../` escape in both its absolute and its
 * relative branch before touching the filesystem, and this function never bypasses it.
 * The root-itself case is handled only AFTER that helper has declined, because it is the
 * one legitimate subject the helper is deliberately built to reject (`rel === ""`) — see
 * the spec §5.2. Extending that shared helper with an `allowRoot` flag was rejected: one
 * caller's needs should not reshape a security primitive `why` depends on.
 */
export function resolveOwnershipPath(
  roots: readonly string[],
  refPath: string,
  exists: (p: string) => boolean = existsSync,
): ResolvedOwnershipPath | null {
  const records = asRootRecords(roots);
  const matched = matchConfiguredRoot(records, refPath, exists);
  if (matched !== null) return { repoRoot: matched.repoRoot, relPath: matched.filePath };
  return matchRootItself(roots, refPath);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/gateway/src/ownership/ownership-target.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Add the root-set regression test**

This is the single most important test in the plan. Append to `ownership-target.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ownershipRoots } from "./ownership-target.ts";

test("ownershipRoots includes CLI-registered roots, not only TOML roots", () => {
  const configDir = mkdtempSync(join(tmpdir(), "nimbus-own-roots-"));
  const registered = mkdtempSync(join(tmpdir(), "nimbus-own-registered-"));
  mkdirSync(join(registered, ".git"), { recursive: true });

  // No [[filesystem.roots]] block at all — the ONLY root is a registered one.
  writeFileSync(join(configDir, "nimbus.toml"), "[ownership]\nenabled = true\n", "utf8");
  writeFileSync(
    join(configDir, "registered-roots.json"),
    `${JSON.stringify([registered], null, 2)}\n`,
    "utf8",
  );

  // A TOML-only reader returns []; the merged reader returns the registered root. The
  // pass blames this root, so a TOML-only reader would call every path under it unowned.
  expect(ownershipRoots(configDir)).toContain(registered);
});
```

- [ ] **Step 6: Red-prove the root-set trap**

Temporarily replace the body of `ownershipRoots` with:

```ts
  return loadNimbusFilesystemRootsFromConfigDir(configDir)
    .filter((r) => r.gitAware)
    .map((r) => r.path);
```

Run:

```bash
bun test packages/gateway/src/ownership/ownership-target.test.ts -t "CLI-registered"
```

Expected: FAIL — the registered root is absent. **Revert exactly**, re-run, confirm green. Grep to confirm the revert landed:

```bash
grep -n "gitAwareRootPaths" packages/gateway/src/ownership/ownership-target.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ownership/ownership-target.ts packages/gateway/src/ownership/ownership-target.test.ts
git commit -m "feat(ownership): resolve a caller path onto the merged git-aware root set"
```

---

### Task 4: Read the ownership graph

**Files:**
- Create: `packages/gateway/src/ownership/ownership-store.ts`
- Test: `packages/gateway/src/ownership/ownership-store.test.ts`

**Interfaces:**
- Consumes: `ResolvedOwnershipPath` from Task 3 (by shape only — the store takes `repoRoot`/`relPath` as strings).
- Produces:
  - `type OwnershipOwner = { externalId: string; label: string; share: number; resolved: boolean }`
  - `type OwnershipCounts = { ownerCount: number | null; ownersAboveFloor: number | null; truncated: boolean | null }`
  - `type OwnershipEntity = { id: string; label: string; counts: OwnershipCounts }`
  - `type OwnershipCoverage` — the nine `ownership_pass_state` fields plus `lastPassAt`
  - `findFileEntity(db, repoRoot, relPath)`, `findDirectoryEntity(db, repoRoot, relPath)`,
    `findServiceEntity(db, serviceId)`, `ownersOf(db, entityId)`, `serviceForRoot(db, repoRoot)`,
    `readOwnershipCoverage(db)`, `listBoundServices(db)`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ownership/ownership-store.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runOwnershipPass } from "./ownership-pass.ts";
import {
  findDirectoryEntity,
  findFileEntity,
  findServiceEntity,
  listBoundServices,
  ownersOf,
  readOwnershipCoverage,
  serviceForRoot,
} from "./ownership-store.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

let d: Database;

function seedLine(file: string, lineNo: number, email: string, name: string): void {
  d.run(
    `INSERT INTO git_blame_line
       (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ROOT, file, lineNo, `sha${String(lineNo)}`, name, email, NOW - DAY],
  );
}

function spawnWithRemote(): typeof Bun.spawn {
  return ((cmd: string[]) => ({
    exited: Promise.resolve(0),
    stdout: new Response(
      cmd.includes("get-url") ? "git@github.com:acme/alpha.git" : "origin\n",
    ).body,
  })) as unknown as typeof Bun.spawn;
}

async function runPass(): Promise<void> {
  await runOwnershipPass(d, {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map([["checkout", ["github:acme/alpha"]]]),
    spawn: spawnWithRemote(),
  });
}

beforeEach(() => {
  d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
});

describe("ownership-store", () => {
  test("returns a file's owners ranked by share, with resolution state", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    seedLine("src/a.ts", 2, "a@x.com", "Ann");
    seedLine("src/a.ts", 3, "b@x.com", "Bob");
    await runPass();

    const entity = findFileEntity(d, ROOT, "src/a.ts");
    expect(entity).not.toBeNull();
    const owners = ownersOf(d, entity?.id ?? "");
    expect(owners).toHaveLength(2);
    expect(owners[0]?.share).toBeGreaterThan(owners[1]?.share ?? 1);
    // Neither email matches a `person` row, so both fall back to `git:<email>`.
    expect(owners.every((o) => !o.resolved)).toBe(true);
    expect(owners[0]?.externalId.startsWith("git:")).toBe(true);
  });

  test("reads the directory node and the repo-root node", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    expect(findDirectoryEntity(d, ROOT, "src")).not.toBeNull();
    expect(findDirectoryEntity(d, ROOT, "")).not.toBeNull();
  });

  test("walks workspace to repo to service", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    expect(serviceForRoot(d, ROOT)).toBe("checkout");
    expect(findServiceEntity(d, "checkout")).not.toBeNull();
    expect(listBoundServices(d)).toEqual(["checkout"]);
  });

  test("does NOT follow an issue belongs_to repo edge into the service lane", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    // `belongs_to` is polysemous: graph-populator.ts emits issue --belongs_to--> repo.
    // A type-unscoped walk would surface an issue as this root's service.
    const issueId = upsertGraphEntity(d, {
      type: "issue",
      externalId: "acme/alpha#1",
      label: "An issue",
      service: "github",
    });
    const repoRow = d
      .query("SELECT id FROM graph_entity WHERE type = 'repo' AND external_id = ?")
      .get("github:acme/alpha") as { id: string } | null;
    upsertGraphRelation(d, issueId, repoRow?.id ?? "", "belongs_to", NOW);

    expect(serviceForRoot(d, ROOT)).toBe("checkout");
  });

  test("reports null counts when ownersAboveFloor was never recorded", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    // Simulate a row written by PR A's pass, before Task 1 existed.
    d.run(
      `UPDATE graph_entity
          SET metadata = json_object('ownerCount', 23, 'truncated', 1, 'totalWeightedLines', 5.0)
        WHERE type = 'source_file' AND external_id = ?`,
      [`file:${ROOT}:src/a.ts`],
    );

    const entity = findFileEntity(d, ROOT, "src/a.ts");
    expect(entity?.counts.ownerCount).toBe(23);
    expect(entity?.counts.ownersAboveFloor).toBeNull();
    // NOT the stale `true`: without ownersAboveFloor the cap bit is undeterminable.
    expect(entity?.counts.truncated).toBeNull();
  });

  test("coverage reports the pass-state counters, and nulls before any pass", () => {
    expect(readOwnershipCoverage(d).lastPassAt).toBeNull();
    expect(readOwnershipCoverage(d).rootsTotal).toBe(0);
  });

  test("coverage reflects a completed pass", async () => {
    seedLine("src/a.ts", 1, "a@x.com", "Ann");
    await runPass();

    const cov = readOwnershipCoverage(d);
    expect(cov.lastPassAt).toBe(NOW);
    expect(cov.rootsTotal).toBe(1);
    expect(cov.rootsCovered).toBe(1);
    expect(cov.servicesBound).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/ownership/ownership-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/ownership/ownership-store.ts`:

```ts
import type { Database } from "bun:sqlite";

/** One `person --owns--> <target>` edge, presented for a brief. */
export type OwnershipOwner = {
  readonly externalId: string;
  readonly label: string;
  /** The edge weight: this owner's recency-weighted share of the target, 0..1. */
  readonly share: number;
  /** False when the id is the `git:<email>` fallback — no `person` row matched. */
  readonly resolved: boolean;
};

/**
 * The three truncation facts, each independently nullable.
 *
 * `null` means exactly one thing: NOT RECORDED. It never doubles as "no truncation".
 * Rows written before the floor/cap split (spec §6.1) carry no `ownersAboveFloor`, and
 * their `truncated` boolean conflated the share floor with the display cap — so it is
 * discarded rather than reported, and the brief says the breakdown is unavailable.
 */
export type OwnershipCounts = {
  readonly ownerCount: number | null;
  readonly ownersAboveFloor: number | null;
  readonly truncated: boolean | null;
};

export type OwnershipEntity = {
  readonly id: string;
  readonly label: string;
  readonly counts: OwnershipCounts;
};

export type OwnershipCoverage = {
  readonly lastPassAt: number | null;
  readonly lastDurationMs: number;
  readonly rootsTotal: number;
  readonly rootsCovered: number;
  readonly rootsWithRemote: number;
  readonly filesCovered: number;
  readonly filesExcluded: number;
  readonly servicesBound: number;
  readonly ownersEmitted: number;
  readonly entitiesReaped: number;
};

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse entity metadata into counts, tolerating every shape the column has ever held:
 * absent, invalid JSON, the pre-split shape, and the current one.
 */
export function parseCounts(raw: string | null): OwnershipCounts {
  const absent: OwnershipCounts = { ownerCount: null, ownersAboveFloor: null, truncated: null };
  if (raw === null || raw.length === 0) return absent;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return absent;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return absent;
  const m = parsed as Record<string, unknown>;
  const aboveFloor = numberOrNull(m["ownersAboveFloor"]);
  return {
    ownerCount: numberOrNull(m["ownerCount"]),
    ownersAboveFloor: aboveFloor,
    // Gated on `ownersAboveFloor` being present, NOT on `truncated` being present. A
    // pre-split row has a `truncated` boolean whose meaning is wrong; reporting it would
    // put a false "showing top N of M" in front of the reader, which is the exact defect
    // this read surface exists to stop repeating.
    truncated: aboveFloor === null ? null : m["truncated"] === true,
  };
}

function findEntity(db: Database, type: string, externalId: string): OwnershipEntity | null {
  const row = db
    .query("SELECT id, label, metadata FROM graph_entity WHERE type = ? AND external_id = ?")
    .get(type, externalId) as { id: string; label: string; metadata: string | null } | null;
  if (row === null) return null;
  return { id: row.id, label: row.label, counts: parseCounts(row.metadata) };
}

export function findFileEntity(
  db: Database,
  repoRoot: string,
  relPath: string,
): OwnershipEntity | null {
  return findEntity(db, "source_file", `file:${repoRoot}:${relPath}`);
}

export function findDirectoryEntity(
  db: Database,
  repoRoot: string,
  relPath: string,
): OwnershipEntity | null {
  return findEntity(db, "directory", `dir:${repoRoot}:${relPath}`);
}

export function findServiceEntity(db: Database, serviceId: string): OwnershipEntity | null {
  return findEntity(db, "service", `service:${serviceId}`);
}

/** Owners of one target, ranked. Ties break on external id ascending, matching the writer. */
export function ownersOf(db: Database, entityId: string): OwnershipOwner[] {
  const rows = db
    .query(
      `SELECT p.external_id AS external_id, p.label AS label, r.weight AS weight
         FROM graph_relation r
         JOIN graph_entity p ON p.id = r.from_id AND p.type = 'person'
        WHERE r.to_id = ? AND r.type = 'owns'
        ORDER BY r.weight DESC, p.external_id ASC`,
    )
    .all(entityId) as Array<{ external_id: string; label: string; weight: number }>;
  return rows.map((r) => ({
    externalId: r.external_id,
    label: r.label,
    share: r.weight,
    resolved: !r.external_id.startsWith("git:"),
  }));
}

/**
 * The service a root rolls up to: `workspace --tracks_remote--> repo --belongs_to--> service`.
 *
 * BOTH endpoints of BOTH hops are type-scoped. `belongs_to` is not ours alone —
 * `graph/graph-populator.ts` emits `issue --belongs_to--> repo` and
 * `message --belongs_to--> channel` — so an unscoped walk would surface an issue as a
 * service, or a channel as one.
 */
export function serviceForRoot(db: Database, repoRoot: string): string | null {
  const row = db
    .query(
      `SELECT s.label AS id
         FROM graph_entity w
         JOIN graph_relation tr ON tr.from_id = w.id AND tr.type = 'tracks_remote'
         JOIN graph_entity rp   ON rp.id = tr.to_id  AND rp.type = 'repo'
         JOIN graph_relation bt ON bt.from_id = rp.id AND bt.type = 'belongs_to'
         JOIN graph_entity s    ON s.id = bt.to_id   AND s.type = 'service'
        WHERE w.type = 'workspace' AND w.external_id = ?
        ORDER BY s.label ASC
        LIMIT 1`,
    )
    .get(`filesystem:${repoRoot}`) as { id: string } | null;
  return row === null ? null : row.id;
}

/** Every service the last pass bound, sorted for a stable brief. */
export function listBoundServices(db: Database): string[] {
  const rows = db
    .query("SELECT label FROM graph_entity WHERE type = 'service' ORDER BY label ASC")
    .all() as Array<{ label: string }>;
  return rows.map((r) => r.label);
}

const EMPTY_COVERAGE: OwnershipCoverage = {
  lastPassAt: null,
  lastDurationMs: 0,
  rootsTotal: 0,
  rootsCovered: 0,
  rootsWithRemote: 0,
  filesCovered: 0,
  filesExcluded: 0,
  servicesBound: 0,
  ownersEmitted: 0,
  entitiesReaped: 0,
};

/** The single-row pass-state watermark, or an all-zero record when no pass has run. */
export function readOwnershipCoverage(db: Database): OwnershipCoverage {
  const row = db
    .query(
      `SELECT last_pass_at, last_duration_ms, roots_total, roots_covered, roots_with_remote,
              files_covered, files_excluded, services_bound, owners_emitted, entities_reaped
         FROM ownership_pass_state WHERE id = 1`,
    )
    .get() as Record<string, number | null> | null;
  if (row === null) return EMPTY_COVERAGE;
  return {
    lastPassAt: numberOrNull(row["last_pass_at"]),
    lastDurationMs: numberOrNull(row["last_duration_ms"]) ?? 0,
    rootsTotal: numberOrNull(row["roots_total"]) ?? 0,
    rootsCovered: numberOrNull(row["roots_covered"]) ?? 0,
    rootsWithRemote: numberOrNull(row["roots_with_remote"]) ?? 0,
    filesCovered: numberOrNull(row["files_covered"]) ?? 0,
    filesExcluded: numberOrNull(row["files_excluded"]) ?? 0,
    servicesBound: numberOrNull(row["services_bound"]) ?? 0,
    ownersEmitted: numberOrNull(row["owners_emitted"]) ?? 0,
    entitiesReaped: numberOrNull(row["entities_reaped"]) ?? 0,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/gateway/src/ownership/ownership-store.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Red-prove the type-scoping and the null-counts guard**

Two separate breaks, each reverted exactly:

1. In `serviceForRoot`, delete `AND s.type = 'service'`. Run the `issue belongs_to` test — it must fail. Revert.
2. In `parseCounts`, change `truncated: aboveFloor === null ? null : m["truncated"] === true` to `truncated: m["truncated"] === true`. Run the "null counts" test — it must fail. Revert.

```bash
bun test packages/gateway/src/ownership/ownership-store.test.ts
```

Confirm green after both reverts.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ownership/ownership-store.ts packages/gateway/src/ownership/ownership-store.test.ts
git commit -m "feat(ownership): read owners, rollups and coverage from the graph"
```

---

### Task 5: Brief type, renderer, and an exhaustive synthesize dispatch

**Files:**
- Create: `packages/gateway/src/agents/_lib/ownership-types.ts`
- Modify: `packages/gateway/src/agents/_lib/render.ts`, `synthesize.ts:48,61,75`, `emit-brief.ts:16`
- Test: `packages/gateway/src/agents/_lib/synthesize.ownership.test.ts`

**Interfaces:**
- Consumes: `OwnershipOwner`, `OwnershipCounts`, `OwnershipCoverage` from Task 4.
- Produces: `OwnershipBrief`, `OwnershipTargetView`, `renderOwnership(brief): string`.

- [ ] **Step 1: Create the brief types**

Create `packages/gateway/src/agents/_lib/ownership-types.ts`:

```ts
import type { GapNote } from "@nimbus-dev/sdk";

import type { OwnershipCoverage, OwnershipOwner } from "../../ownership/ownership-store.ts";

/** One ranked target — the requested path, its parent directory, or a service. */
export type OwnershipTargetView = {
  readonly kind: "source_file" | "directory" | "service";
  /** What to print: the root-relative path, `(repository root)`, or the service id. */
  readonly displayPath: string;
  readonly owners: OwnershipOwner[];
  readonly ownerCount: number | null;
  readonly ownersAboveFloor: number | null;
  readonly truncated: boolean | null;
};

export type OwnershipInput = {
  readonly path?: string;
  readonly service?: string;
};

export type OwnershipBrief = {
  readonly kind: "ownership";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: { readonly path: string | null; readonly service: string | null };
  /** Null in summary mode, and when a path resolved to no graph entity. */
  readonly target: OwnershipTargetView | null;
  readonly parentDirectory: OwnershipTargetView | null;
  readonly service: { readonly id: string } | null;
  readonly coverage: OwnershipCoverage;
};
```

- [ ] **Step 2: Write the failing synthesize test**

Create `packages/gateway/src/agents/_lib/synthesize.ownership.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { OwnershipBrief } from "./ownership-types.ts";
import { renderOwnership } from "./render.ts";
import { synthesize } from "./synthesize.ts";

const BRIEF: OwnershipBrief = {
  kind: "ownership",
  agentVersion: 1,
  generatedAt: 1_800_000_000_000,
  latencyMs: 4,
  gaps: [],
  query: { path: "src/a.ts", service: null },
  target: {
    kind: "source_file",
    displayPath: "src/a.ts",
    owners: [{ externalId: "p1", label: "Ann", share: 0.75, resolved: true }],
    ownerCount: 3,
    ownersAboveFloor: 1,
    truncated: false,
  },
  parentDirectory: null,
  service: null,
  coverage: {
    lastPassAt: 1_800_000_000_000,
    lastDurationMs: 12,
    rootsTotal: 1,
    rootsCovered: 1,
    rootsWithRemote: 1,
    filesCovered: 1,
    filesExcluded: 0,
    servicesBound: 1,
    ownersEmitted: 1,
    entitiesReaped: 0,
  },
};

describe("ownership brief synthesis", () => {
  test("renders through renderOwnership, never renderHuddle", async () => {
    const out = await synthesize(BRIEF);
    expect(out).toContain("Ownership");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("Ann");
    // The fall-through trap: an unhandled kind silently renders as a huddle.
    expect(out).not.toContain("Huddle");
  });

  test("renderOwnership states the floor separately from the cap", () => {
    const md = renderOwnership(BRIEF);
    expect(md).toContain("1 of 3");
    expect(md).not.toContain("showing top");
  });

  test("an unrecorded breakdown is stated, not guessed", () => {
    const md = renderOwnership({
      ...BRIEF,
      target: { ...(BRIEF.target ?? {}), ownerCount: null, ownersAboveFloor: null, truncated: null },
    } as OwnershipBrief);
    expect(md).toContain("not recorded");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
bun test packages/gateway/src/agents/_lib/synthesize.ownership.test.ts
```

Expected: FAIL — `renderOwnership` is not exported.

- [ ] **Step 4: Write `renderOwnership`**

Append to `packages/gateway/src/agents/_lib/render.ts` (and add `OwnershipBrief` / `OwnershipTargetView` to its imports):

```ts
function renderOwnershipCounts(t: OwnershipTargetView): string {
  if (t.ownerCount === null || t.ownersAboveFloor === null) {
    return "      (owner breakdown not recorded for this path — run `nimbus owners --refresh`)";
  }
  const floor = `${String(t.ownersAboveFloor)} of ${String(t.ownerCount)} contributor(s) clear the share floor`;
  return t.truncated === true
    ? `      (${floor}; showing top ${String(t.owners.length)})`
    : `      (${floor})`;
}

function renderOwnershipTarget(heading: string, t: OwnershipTargetView | null): string[] {
  if (t === null) return [];
  if (t.owners.length === 0) {
    return [`### ${heading} — ${t.displayPath}`, "", "_No owners recorded._", ""];
  }
  const rows = t.owners.map((o, i) => {
    const pct = `${(o.share * 100).toFixed(1)}%`;
    const mark = o.resolved ? "" : "  (unresolved git identity)";
    return `  ${String(i + 1)}. ${o.label.padEnd(28)} ${pct}${mark}`;
  });
  return [`### ${heading} — ${t.displayPath}`, "", ...rows, renderOwnershipCounts(t), ""];
}

export function renderOwnership(brief: OwnershipBrief): string {
  const subject = brief.query.path ?? brief.query.service ?? "coverage";
  const header = `## Ownership · ${subject}`;
  const sections = [
    ...renderOwnershipTarget("Owners", brief.target),
    ...renderOwnershipTarget("Directory", brief.parentDirectory),
  ];
  const svc = brief.service === null ? [] : [`### Rolls up to service: ${brief.service.id}`, ""];
  const cov = [
    "### Coverage",
    "",
    `  roots ${String(brief.coverage.rootsCovered)}/${String(brief.coverage.rootsTotal)} · ` +
      `files ${String(brief.coverage.filesCovered)} · ` +
      `excluded ${String(brief.coverage.filesExcluded)} · ` +
      `services ${String(brief.coverage.servicesBound)}`,
  ];
  const body = [...sections, ...svc, ...cov].join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
}
```

- [ ] **Step 5: Extend the two unions and make both dispatches exhaustive**

In `packages/gateway/src/agents/_lib/synthesize.ts`:

1. Add `import type { OwnershipBrief } from "./ownership-types.ts";` and `renderOwnership` to the `./render.ts` import.
2. Add `| OwnershipBrief` to the `SynthInput` union (`:48`).
3. Add an `assertNeverBrief` helper and replace both fall-throughs:

```ts
/**
 * Turns a missing dispatch arm into a COMPILE error.
 *
 * Both dispatches below previously ended in a bare `return renderHuddle(brief)` /
 * `return "agents.huddle"`. Extending `SynthInput` without extending them therefore
 * compiled, ran, and rendered the new brief as a huddle — reporting itself to the model
 * as `agents.huddle` into the bargain. Nothing failed. Every member of the union carries
 * a distinct `kind` literal, so this guard is a genuine exhaustiveness check.
 *
 * The runtime throw is unreachable while the union and the arms agree, and is safe if it
 * ever is not: `synthesize` is awaited inside `emitBriefWithSynthesis`'s async IIFE, whose
 * `.catch` emits `<agent>.briefError`. A named error beats a plausible wrong answer.
 */
function assertNeverBrief(x: never): never {
  const kind = (x as { kind?: unknown }).kind;
  throw new Error(`synthesize: unhandled brief kind ${String(kind)}`);
}
```

In `deterministicRender`, replace `return renderHuddle(brief);` with:

```ts
  if (brief.kind === "ownership") return renderOwnership(brief);
  if (brief.kind === "huddle") return renderHuddle(brief);
  return assertNeverBrief(brief);
```

In `toolNameFor`, replace `return "agents.huddle";` with:

```ts
  if (brief.kind === "ownership") return "agents.ownership";
  if (brief.kind === "huddle") return "agents.huddle";
  return assertNeverBrief(brief);
```

4. In `packages/gateway/src/agents/_lib/emit-brief.ts`, add the same import and `| OwnershipBrief` to the `AnyBrief` union (`:16`). **Missing this makes `agents/ownership.ts` fail to compile in Task 6.**

- [ ] **Step 6: Run to verify it passes**

```bash
bun test packages/gateway/src/agents/_lib/ 2>&1 | tail -20
```

Expected: PASS — including every pre-existing render/synthesize test, which is the regression net for rewriting both dispatches.

- [ ] **Step 7: Prove the guard at compile time**

Delete the `if (brief.kind === "ownership") return renderOwnership(brief);` line and run:

```bash
bun run typecheck 2>&1 | grep -i "never\|ownership" | head -5
```

Expected: a type error on the `assertNeverBrief(brief)` call — `OwnershipBrief` is not assignable to `never`. **Restore the line**, re-run `bun run typecheck`, confirm clean. Record the observed error text in the PR description; no runtime test can observe a type error.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/agents/_lib/
git commit -m "feat(agents): ownership brief type, renderer, and an exhaustive synthesize dispatch"
```

---

### Task 6: The agent

**Files:**
- Create: `packages/gateway/src/agents/ownership.ts`
- Test: `packages/gateway/src/agents/ownership.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–5.
- Produces:
  - `type OwnershipContext = { db: Database; roots: readonly string[]; notify: (m: string, p: unknown) => void; sessionId: string; llm?: SynthesizerLlm }`
  - `runOwnership(input: OwnershipInput, ctx: OwnershipContext): Promise<OwnershipBrief>`
  - `emitOwnershipBrief(input, ctx): Promise<{ sessionId: string }>`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/ownership.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../config/nimbus-toml.ts";
import { runOwnershipPass } from "../ownership/ownership-pass.ts";
import { runOwnership } from "./ownership.ts";

const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";
let d: Database;

beforeEach(() => {
  d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
});

function ctx() {
  return { db: d, roots: [ROOT], notify: () => {}, sessionId: "s1" };
}

const alwaysExists = (): boolean => true;

async function seedAndRun(): Promise<void> {
  for (const [line, email, name] of [
    [1, "a@x.com", "Ann"],
    [2, "a@x.com", "Ann"],
    [3, "b@x.com", "Bob"],
  ] as const) {
    d.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ROOT, "src/a.ts", line, `sha${String(line)}`, name, email, NOW - 86_400_000],
    );
  }
  await runOwnershipPass(d, {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map<string, readonly string[]>(),
    spawn: (() => {
      throw new Error("git unavailable");
    }) as unknown as typeof Bun.spawn,
  });
}

test("path mode returns the file's owners and its parent directory", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);

  expect(brief.kind).toBe("ownership");
  expect(brief.target?.kind).toBe("source_file");
  expect(brief.target?.owners.length).toBe(2);
  expect(brief.parentDirectory?.displayPath).toBe("src");
});

test("the repo root resolves to the root directory node", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: ROOT }, ctx(), alwaysExists);

  expect(brief.target?.kind).toBe("directory");
  expect(brief.target?.displayPath).toBe("(repository root)");
  expect(brief.parentDirectory).toBeNull();
});

test("an unresolvable path yields a gap, not an error", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "/elsewhere/x.ts" }, ctx(), alwaysExists);

  expect(brief.target).toBeNull();
  expect(brief.gaps.some((g) => g.detail.includes("configured root"))).toBe(true);
});

test("zero configured roots is reported, not silently empty", async () => {
  const brief = await runOwnership({ path: "src/a.ts" }, { ...ctx(), roots: [] }, alwaysExists);
  expect(brief.gaps.some((g) => g.detail.includes("no git-aware"))).toBe(true);
});

test("summary mode reports coverage without a target", async () => {
  await seedAndRun();
  const brief = await runOwnership({}, ctx(), alwaysExists);

  expect(brief.target).toBeNull();
  expect(brief.coverage.rootsTotal).toBe(1);
});

test("the standing authorship limit is always present", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);
  expect(brief.gaps.some((g) => g.detail.includes("who wrote lines"))).toBe(true);
});

test("unresolved git identities are reported as an identity gap", async () => {
  await seedAndRun();
  const brief = await runOwnership({ path: "src/a.ts" }, ctx(), alwaysExists);
  expect(brief.gaps.some((g) => g.category === "missing_user_identity")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/agents/ownership.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the agent**

Create `packages/gateway/src/agents/ownership.ts`:

```ts
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import {
  findDirectoryEntity,
  findFileEntity,
  findServiceEntity,
  listBoundServices,
  type OwnershipCoverage,
  type OwnershipEntity,
  ownersOf,
  readOwnershipCoverage,
  serviceForRoot,
} from "../ownership/ownership-store.ts";
import { resolveOwnershipPath } from "../ownership/ownership-target.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import type {
  OwnershipBrief,
  OwnershipInput,
  OwnershipTargetView,
} from "./_lib/ownership-types.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type OwnershipContext = {
  db: Database;
  /** The COMPLETE git-aware root set, resolved by the caller via `ownershipRoots`. */
  roots: readonly string[];
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  llm?: SynthesizerLlm;
};

function subAgent(fn: () => unknown): SubTask {
  return {
    taskType: "agent_step",
    prompt: "",
    execute: async () => ({ text: JSON.stringify(fn()), tokensIn: 0, tokensOut: 0 }),
  };
}

function decode<T>(text: string | undefined, fallback: T): T {
  if (text === undefined) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toView(
  db: Database,
  kind: OwnershipTargetView["kind"],
  displayPath: string,
  entity: OwnershipEntity | null,
): OwnershipTargetView | null {
  if (entity === null) return null;
  return {
    kind,
    displayPath,
    owners: ownersOf(db, entity.id),
    ownerCount: entity.counts.ownerCount,
    ownersAboveFloor: entity.counts.ownersAboveFloor,
    truncated: entity.counts.truncated,
  };
}

/** The parent directory of a root-relative path, or null when the path IS the root. */
function parentDirOf(relPath: string): string | null {
  if (relPath === "") return null;
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

function displayDir(relPath: string): string {
  return relPath === "" ? "(repository root)" : relPath;
}

/**
 * Gap notes. Every conditional note is gated on the counter that proves it bit, so a
 * fully-covered, fully-bound root says nothing about coverage. Only the authorship limit
 * is unconditional — a standing disclaimer readers learn to skip is worse than none.
 */
function buildGaps(args: {
  readonly rootsConfigured: number;
  readonly coverage: OwnershipCoverage;
  readonly resolved: boolean;
  readonly requestedPath: string | null;
  readonly target: OwnershipTargetView | null;
  readonly unresolvedOwners: number;
  readonly serviceRequested: string | null;
}): GapNote[] {
  const gaps: GapNote[] = [];

  if (args.rootsConfigured === 0) {
    gaps.push({
      category: "missing_connector",
      detail:
        "There are no git-aware filesystem roots configured, so no ownership can be derived.",
      remediation: "Add a `[[filesystem.roots]]` block with `git_aware = true`, or run `nimbus index add <path>`.",
    });
  } else if (args.requestedPath !== null && !args.resolved) {
    gaps.push({
      category: "missing_connector",
      detail: `\`${args.requestedPath}\` is not inside any configured root (${String(args.rootsConfigured)} configured).`,
      remediation: "Pass a path inside a configured root, or register it with `nimbus index add <path>`.",
    });
  } else if (args.requestedPath !== null && args.target === null) {
    gaps.push({
      category: "missing_entity_type",
      detail:
        `\`${args.requestedPath}\` resolved to a configured root but has no ownership node. ` +
        "It may be excluded by `[ownership].ignore_globs`, not yet blamed, or deleted and reaped.",
      remediation: "Run `nimbus owners --refresh`, then check `[ownership].ignore_globs`.",
    });
  }

  if (args.coverage.lastPassAt === null) {
    gaps.push({
      category: "missing_connector",
      detail: "The ownership pass has not run yet.",
      remediation: "Run `nimbus owners --refresh`, or wait for the next connector sync.",
    });
  }

  if (args.coverage.filesExcluded > 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        `${String(args.coverage.filesExcluded)} file(s) were excluded from aggregation by ` +
        "`[ownership].ignore_globs`. Vendored, generated and lock files otherwise inflate " +
        "whoever last ran the generator.",
    });
  }

  if (args.coverage.rootsCovered < args.coverage.rootsTotal) {
    gaps.push({
      category: "missing_connector",
      detail:
        `${String(args.coverage.rootsCovered)} of ${String(args.coverage.rootsTotal)} root(s) ` +
        "were covered by the last pass; the rest are not git repositories or hit the " +
        "per-tick blame bound. Coverage is partial, not complete.",
    });
  }

  if (args.serviceRequested !== null && args.coverage.servicesBound === 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        "No service is bound to a repository, so service ownership cannot be derived. " +
        "A binding needs BOTH a `[ci.service.<id>]` declaration AND a matching origin remote.",
    });
  }

  if (args.unresolvedOwners > 0) {
    gaps.push({
      category: "missing_user_identity",
      detail:
        `${String(args.unresolvedOwners)} owner(s) did not match a known person and are shown ` +
        "by git email. Their lines still count toward every share.",
    });
  }

  gaps.push({
    category: "missing_relation_emit",
    detail:
      "Blame measures who WROTE lines, not who is accountable. There is no CODEOWNERS, no " +
      "reviewer data and no on-call rotation in the index, so this is authorship-derived " +
      "ownership.",
    remediation: "Treat the ranking as a starting point for who to ask, not as an approval list.",
  });

  return gaps;
}

export async function runOwnership(
  input: OwnershipInput,
  ctx: OwnershipContext,
  exists: (p: string) => boolean = existsSync,
): Promise<OwnershipBrief> {
  const start = performance.now();
  const now = Date.now();
  const requestedPath = input.path ?? null;
  const requestedService = input.service ?? null;

  const resolved =
    requestedPath === null ? null : resolveOwnershipPath(ctx.roots, requestedPath, exists);

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `ownership:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const tasks: SubTask[] = [
    // Lane 1 — the requested target.
    subAgent(() => {
      if (requestedService !== null) {
        return toView(
          ctx.db,
          "service",
          requestedService,
          findServiceEntity(ctx.db, requestedService),
        );
      }
      if (resolved === null) return null;
      const file = findFileEntity(ctx.db, resolved.repoRoot, resolved.relPath);
      if (file !== null) return toView(ctx.db, "source_file", resolved.relPath, file);
      const dir = findDirectoryEntity(ctx.db, resolved.repoRoot, resolved.relPath);
      return toView(ctx.db, "directory", displayDir(resolved.relPath), dir);
    }),
    // Lane 2 — the parent directory, so a one-committer file still routes somewhere.
    subAgent(() => {
      if (resolved === null) return null;
      const parent = parentDirOf(resolved.relPath);
      if (parent === null) return null;
      return toView(
        ctx.db,
        "directory",
        displayDir(parent),
        findDirectoryEntity(ctx.db, resolved.repoRoot, parent),
      );
    }),
    // Lane 3 — the service this root rolls up to.
    subAgent(() =>
      resolved === null ? null : { id: serviceForRoot(ctx.db, resolved.repoRoot) },
    ),
    // Lane 4 — coverage + the bound-service list.
    subAgent(() => ({
      coverage: readOwnershipCoverage(ctx.db),
      services: listBoundServices(ctx.db),
    })),
  ];
  const results = await coordinator.run(tasks);

  const target = decode<OwnershipTargetView | null>(results[0]?.text, null);
  const parentDirectory = decode<OwnershipTargetView | null>(results[1]?.text, null);
  const svc = decode<{ id: string | null } | null>(results[2]?.text, null);
  const lane4 = decode<{ coverage: OwnershipCoverage; services: string[] }>(results[3]?.text, {
    coverage: readOwnershipCoverage(ctx.db),
    services: [],
  });

  const unresolvedOwners = (target?.owners ?? []).filter((o) => !o.resolved).length;

  return {
    kind: "ownership",
    agentVersion: 1,
    generatedAt: now,
    latencyMs: Math.round(performance.now() - start),
    gaps: buildGaps({
      rootsConfigured: ctx.roots.length,
      coverage: lane4.coverage,
      resolved: resolved !== null,
      requestedPath,
      target,
      unresolvedOwners,
      serviceRequested: requestedService,
    }),
    query: { path: requestedPath, service: requestedService },
    target,
    parentDirectory,
    service: svc?.id === null || svc?.id === undefined ? null : { id: svc.id },
    coverage: lane4.coverage,
  };
}

export function emitOwnershipBrief(
  input: OwnershipInput,
  ctx: OwnershipContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "ownership.briefReady",
    briefErrorMethod: "ownership.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runOwnership(input, ctx),
  });
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/gateway/src/agents/ownership.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Assert the read-only property**

Append to `packages/gateway/src/agents/ownership.test.ts`:

```ts
test("the agent source is read-only — no executor, no HITL, no graph writes", async () => {
  const src = await Bun.file(new URL("./ownership.ts", import.meta.url)).text();
  expect(src).not.toContain("ToolExecutor");
  expect(src).not.toContain("HITL_REQUIRED");
  expect(src).not.toContain("upsertGraphRelation");
  expect(src).not.toContain("dbRun");
});
```

Note `import.meta.url`, never the process CWD — a CWD-relative read is ENOENT under the sharded CI runner.

- [ ] **Step 6: Run and commit**

```bash
bun test packages/gateway/src/agents/ownership.test.ts
git add packages/gateway/src/agents/ownership.ts packages/gateway/src/agents/ownership.test.ts
git commit -m "feat(agents): ownership brief over the derived ownership graph"
```

---

### Task 7: Register `agents.ownership`

**Files:**
- Modify: `packages/gateway/src/ipc/agents-rpc.ts:195-210`, `:561-574`, plus a new handler
- Test: `packages/gateway/src/ipc/agents-rpc.ownership.test.ts`; update `packages/gateway/src/ipc/agents-rpc.test.ts:637-649`

**Interfaces:**
- Consumes: `emitOwnershipBrief`, `OwnershipInput` from Task 6; `ownershipRoots` from Task 3.
- Produces: the `agents.ownership` method; `HTTP_AGENT_NAMES` grows to 11.

- [ ] **Step 1: Write the failing param test**

Create `packages/gateway/src/ipc/agents-rpc.ownership.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function makeCtx(db: Database) {
  return { db, notify: () => {} };
}

describe("dispatchAgentsRpc — agents.ownership", () => {
  test("accepts an empty payload (summary mode)", async () => {
    const out = await dispatchAgentsRpc("agents.ownership", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("accepts a path", async () => {
    const out = await dispatchAgentsRpc(
      "agents.ownership",
      { path: "src/a.ts" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("accepts a service", async () => {
    const out = await dispatchAgentsRpc(
      "agents.ownership",
      { service: "checkout" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("rejects path and service together", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.ownership",
        { path: "src/a.ts", service: "checkout" },
        makeCtx(freshDb()),
      ),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("rejects a non-string path", async () => {
    await expect(
      dispatchAgentsRpc("agents.ownership", { path: 5 }, makeCtx(freshDb())),
    ).rejects.toThrow(/-?32602|path must be/);
  });

  test("rejects an over-length path", async () => {
    await expect(
      dispatchAgentsRpc("agents.ownership", { path: "x".repeat(2049) }, makeCtx(freshDb())),
    ).rejects.toThrow();
  });

  test("rejects an over-length service", async () => {
    await expect(
      dispatchAgentsRpc("agents.ownership", { service: "s".repeat(65) }, makeCtx(freshDb())),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/ipc/agents-rpc.ownership.test.ts
```

Expected: FAIL — every call returns `{ kind: "miss" }`, so `expect(out.kind).toBe("hit")` fails.

- [ ] **Step 3: Add the handler**

In `packages/gateway/src/ipc/agents-rpc.ts`:

1. Add imports:

```ts
import { emitOwnershipBrief } from "../agents/ownership.ts";
import type { OwnershipInput } from "../agents/_lib/ownership-types.ts";
import { ownershipRoots } from "../ownership/ownership-target.ts";
```

2. Add `| "ownership"` to the `newSessionId` kind union (`:195-207`).

3. Add the validator and handler before `AGENTS_RPC_HANDLERS`:

```ts
function requireOwnershipParams(params: unknown): OwnershipInput {
  if (params === null || params === undefined) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.ownership requires an object payload");
  }
  const p = params as { path?: unknown; service?: unknown };
  if (p.path !== undefined && p.service !== undefined) {
    throw new AgentsRpcError(
      -32602,
      "path and service are mutually exclusive — pass one, or neither for a coverage summary",
    );
  }
  const out: { path?: string; service?: string } = {};
  if (p.path !== undefined) {
    if (typeof p.path !== "string") {
      throw new AgentsRpcError(-32602, "path must be a string");
    }
    const trimmed = p.path.trim();
    if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
      throw new AgentsRpcError(-32602, `path must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars`);
    }
    out.path = trimmed;
  }
  if (p.service !== undefined) {
    if (
      typeof p.service !== "string" ||
      p.service.trim().length === 0 ||
      p.service.length > MAX_SERVICE_LEN
    ) {
      throw new AgentsRpcError(
        -32602,
        `service must be a non-empty string up to ${MAX_SERVICE_LEN} chars`,
      );
    }
    out.service = p.service.trim();
  }
  return out;
}

/**
 * Roots are resolved HERE, not in the agent, so `agents/ownership.ts` keeps no config-file
 * dependency (the rule `handleDecisions` follows for `[decisions].min_confidence`), and are
 * re-read per call so a `[[filesystem.roots]]` edit or a fresh `nimbus index add` applies
 * without a gateway restart. With no configDir — the test/embedded shape — the root set is
 * empty and the brief reports that as its first gap rather than pretending to be complete.
 */
async function handleOwnership(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireOwnershipParams(params);
  return await emitOwnershipBrief(input, {
    db: ctx.db,
    roots: ctx.configDir === undefined ? [] : ownershipRoots(ctx.configDir),
    notify: ctx.notify,
    sessionId: newSessionId("ownership"),
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}
```

4. Add `"agents.ownership": handleOwnership,` to `AGENTS_RPC_HANDLERS` (after `"agents.janitor"`, keeping the map readable).

- [ ] **Step 4: Update the HTTP-set assertions**

In `packages/gateway/src/ipc/agents-rpc.test.ts`, change the test **name** at `:637` from `"is exactly the ten asynchronous, non-preflight agents"` to `"is exactly the eleven asynchronous, non-preflight agents"`, and insert `"ownership",` between `"janitor"` and `"why"` in the array at `:638-649`.

A test name is prose — nothing asserts on it, and a stale one ships green while stating a falsehood.

- [ ] **Step 5: Update the HTTP e2e count**

In `packages/gateway/src/agent-runs/agent-http-e2e.test.ts:154`, change `expect(agents).toHaveLength(10);` to `expect(agents).toHaveLength(11);`.

- [ ] **Step 6: Run the IPC and HTTP suites**

```bash
bun test packages/gateway/src/ipc/agents-rpc.ownership.test.ts packages/gateway/src/ipc/agents-rpc.test.ts packages/gateway/src/agent-runs/ 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.ownership.test.ts packages/gateway/src/ipc/agents-rpc.test.ts packages/gateway/src/agent-runs/agent-http-e2e.test.ts
git commit -m "feat(ipc): serve agents.ownership, reaching HTTP through the derived agent set"
```

---

### Task 8: `ownership.refresh` and its wiring

**Files:**
- Create: `packages/gateway/src/ipc/ownership-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/options.ts:144-152`, `dispatchers.ts:997-1016`, `packages/gateway/src/platform/assemble.ts` (near `:2367`), `packages/gateway/src/ipc/lan-rpc.ts:10`
- Test: `packages/gateway/src/ipc/ownership-rpc.test.ts`; `packages/gateway/src/ipc/lan-rpc.test.ts`

**Interfaces:**
- Consumes: `OwnershipRefresher`, `OwnershipRefresherError` from Task 2.
- Produces: `OwnershipRpcError`, `dispatchOwnershipRpc(method, params, ctx)`, `tryDispatchOwnershipRpc(ctx, method, params)`; `ServerOptions.ownershipRefresher?: OwnershipRefresher`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ipc/ownership-rpc.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { OwnershipRefresherError } from "../ownership/ownership-refresh.ts";
import { dispatchOwnershipRpc } from "./ownership-rpc.ts";

const SUMMARY = {
  rootsTotal: 1,
  rootsCovered: 1,
  rootsWithRemote: 0,
  filesCovered: 2,
  filesExcluded: 0,
  servicesBound: 0,
  ownersEmitted: 3,
  entitiesReaped: 0,
  durationMs: 5,
};

function fakeRefresher(run: () => Promise<typeof SUMMARY>) {
  return { trigger: () => {}, run, stop: () => {} };
}

describe("dispatchOwnershipRpc", () => {
  test("ownership.refresh returns a jobId and emits passDone", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const out = await dispatchOwnershipRpc("ownership.refresh", {}, {
      refresher: fakeRefresher(async () => SUMMARY),
      notify: (method, params) => seen.push({ method, params }),
    });

    expect(out.kind).toBe("hit");
    await Bun.sleep(10);
    expect(seen.some((s) => s.method === "ownership.passDone")).toBe(true);
  });

  test("a refusal from the refresher surfaces as passError", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    await dispatchOwnershipRpc("ownership.refresh", {}, {
      refresher: fakeRefresher(async () => {
        throw new OwnershipRefresherError("ERR_OWNERSHIP_PASS_RUNNING: already running");
      }),
      notify: (method, params) => seen.push({ method, params }),
    });

    await Bun.sleep(10);
    expect(seen.some((s) => s.method === "ownership.passError")).toBe(true);
  });

  test("an unknown ownership.* method misses", async () => {
    const out = await dispatchOwnershipRpc("ownership.nope", {}, {
      refresher: fakeRefresher(async () => SUMMARY),
      notify: () => {},
    });
    expect(out.kind).toBe("miss");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/ipc/ownership-rpc.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the RPC module**

Create `packages/gateway/src/ipc/ownership-rpc.ts`:

```ts
import type { OwnershipRefresher } from "../ownership/ownership-refresh.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

export type OwnershipRpcContext = {
  refresher: OwnershipRefresher;
  notify: (method: string, params: unknown) => void;
};

export class OwnershipRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "OwnershipRpcError";
    this.rpcCode = rpcCode;
  }
}

const registry = new LongRunningJobRegistry();

/**
 * Mirrors `ipc/decisions-rpc.ts`. Two deliberate absences:
 *
 * 1. No "disabled" precondition. `ownershipRefresher` is constructed at all only when
 *    `[ownership].enabled` (`platform/assemble.ts`), so an absent refresher already
 *    surfaces as "Method not found" in `tryDispatchOwnershipRpc`.
 * 2. No `rebuild` verb. The ownership pass clears and re-emits WHOLESALE every run, so a
 *    rebuild would be a synonym for refresh — shipping both would imply a difference that
 *    does not exist.
 *
 * The method takes NO parameters, and that is a safety property rather than tidiness:
 * `runOwnershipPass` clears every `person --owns--> service` edge each pass and re-emits
 * only what is reachable from `opts.roots`, so a caller-supplied root list or filter would
 * ERASE the ownership of every service the omitted roots bind — and report success.
 */
function startPass(ctx: OwnershipRpcContext): { jobId: string } {
  return registry.start({
    jobIdPrefix: "ownership_refresh",
    progressMethod: "ownership.passProgress",
    doneMethod: "ownership.passDone",
    errorMethod: "ownership.passError",
    emit: (m, payload) => {
      ctx.notify(m, payload);
    },
    run: () => ctx.refresher.run(),
  });
}

export async function dispatchOwnershipRpc(
  method: string,
  params: unknown,
  ctx: OwnershipRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<OwnershipRpcContext>(method, params, ctx, {
    "ownership.refresh": (_p, c) => startPass(c),
  });
}
```

If `LongRunningJobRegistry.start` has a different option shape, read `packages/gateway/src/ipc/_lib/long-running.ts` and match it exactly — do not guess. `ipc/decisions-rpc.ts:42-59` is the working call site to copy from.

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/gateway/src/ipc/ownership-rpc.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire the dispatcher and options**

In `packages/gateway/src/ipc/server/options.ts`, beside `decisionsRefresher` (`:152`):

```ts
  /**
   * Present only when `[ownership].enabled`. Absent → `ownership.*` is Method not found,
   * exactly like decisions.
   */
  ownershipRefresher?: OwnershipRefresher;
```

with the matching `import type { OwnershipRefresher } from "../../ownership/ownership-refresh.ts";`

In `packages/gateway/src/ipc/server/dispatchers.ts`, after `tryDispatchDecisionsRpc` (`:1016`):

```ts
export async function tryDispatchOwnershipRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("ownership.")) return phase4RpcSkipped;
  const refresher = ctx.options.ownershipRefresher;
  if (refresher === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchOwnershipRpc(method, params, {
      refresher,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof OwnershipRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
```

Register it in the same chain that calls `tryDispatchDecisionsRpc` — find that call site with:

```bash
grep -rn "tryDispatchDecisionsRpc" packages/gateway/src/ipc/
```

and add `tryDispatchOwnershipRpc` alongside every occurrence.

- [ ] **Step 6: Wire `assemble.ts`**

Near `packages/gateway/src/platform/assemble.ts:2367-2371`, after the `decisionsRefresher` assignment:

```ts
  if (ownershipRefresher !== undefined) {
    ipcOpts.ownershipRefresher = ownershipRefresher;
  }
```

This is the change that gives `OwnershipRefresher.run()` its first production caller — it was constructed at `:551` and stopped at `:2085` but never reachable.

- [ ] **Step 7: Forbid it over LAN**

In `packages/gateway/src/ipc/lan-rpc.ts`, add to `FORBIDDEN_OVER_LAN` beside `"decisions"`:

```ts
  // Ownership on-demand passes are the analogue of glossary's and decisions': a refresh
  // clears and re-emits every `owns`/`contains`/`tracks_remote`/`belongs_to` edge the pass
  // owns, wholesale. The denylist is default-allow, so omitting this would leave a paired
  // peer able to churn the owner's ownership graph on demand. The read-only
  // `agents.ownership` stays admitted, like every other agent.
  "ownership",
```

`checkLanMethodAllowed` (`:144-148`) matches on namespace OR full method, so this one string covers `ownership.refresh` while leaving `agents.ownership` — namespace `agents` — admitted.

Add to `packages/gateway/src/ipc/lan-rpc.test.ts`, beside the existing `agents.glossary` assertion at `:219`:

```ts
    expect(() => checkLanMethodAllowed("agents.ownership", peer)).not.toThrow();
    expect(() => checkLanMethodAllowed("ownership.refresh", peer)).toThrow(
      /not callable over LAN/,
    );
```

- [ ] **Step 8: Run the affected suites**

```bash
bun test packages/gateway/src/ipc/ packages/gateway/src/platform/ 2>&1 | tail -25
```

Expected: PASS.

- [ ] **Step 9: Red-prove the LAN guard**

Remove `"ownership"` from `FORBIDDEN_OVER_LAN`, run `bun test packages/gateway/src/ipc/lan-rpc.test.ts` — the new assertion must fail. Revert exactly, re-run, confirm green.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/ipc/ packages/gateway/src/platform/assemble.ts
git commit -m "feat(ipc): ownership.refresh, wired to the refresher and forbidden over LAN"
```

---

### Task 9: Tauri allowlist

**Files:**
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs:57-70` (list), `:535` (count), plus a new test beside `:519`

**Interfaces:**
- Consumes: the `agents.ownership` method name from Task 7.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the method and bump the count**

In `ALLOWED_METHODS`, insert `"agents.ownership",` between `"agents.janitor"` and `"agents.preflight"` (the list is alphabetical).

At `:535`, change `assert_eq!(ALLOWED_METHODS.len(), 103);` to `104`.

- [ ] **Step 2: Add the named brief-only test**

Beside `allowlist_decisions_brief_only` (`:519`):

```rust
    #[test]
    fn allowlist_ownership_brief_only() {
        // S1 ownership: the read-only brief is renderer-callable; the maintenance verb that
        // re-derives the graph is not (I7). ownership.refresh clears and re-emits every
        // ownership edge wholesale, and is LAN-forbidden, so it must not reach the renderer.
        //
        // Named explicitly for the same reason as the decisions test above: allowlist_exact_size
        // alone stays green if a later change swaps agents.ownership out for ownership.refresh,
        // since the count is unchanged by a one-for-one substitution.
        assert!(is_method_allowed("agents.ownership"));
        assert!(!is_method_allowed("ownership.refresh"));
    }
```

- [ ] **Step 3: Run the Rust tests**

```bash
cd packages/ui/src-tauri && cargo test --lib 2>&1 | tail -20 && cd ../../..
```

Expected: PASS. If Rust is not installed locally, say so explicitly in the PR description rather than skipping silently — CI runs it.

- [ ] **Step 4: Red-prove**

Remove `"agents.ownership"` from the list, re-run `cargo test --lib`. Both the count assertion and `allowlist_ownership_brief_only` must fail. Revert exactly.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(ui): expose agents.ownership to the renderer, not ownership.refresh"
```

---

### Task 10: `nimbus owners` CLI

**Files:**
- Create: `packages/cli/src/commands/owners.ts`, `packages/cli/src/commands/owners.test.ts`
- Modify: `packages/cli/src/commands/registry.ts:1-63`, `packages/cli/src/commands/index.ts`, `packages/cli/src/index.ts:17,99`

**Interfaces:**
- Consumes: `runAgentBriefCli` from `./_agent-brief-cli.ts`; the `agents.ownership` + `ownership.refresh` methods.
- Produces: `parseOwnersArgs(args)`, `runOwnersCommand(args, deps?)`, `OwnersCommandDeps`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/owners.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { parseOwnersArgs, runOwnersCommand } from "./owners.ts";

describe("parseOwnersArgs", () => {
  test("a bare path becomes the path param", () => {
    expect(parseOwnersArgs(["src/a.ts"])).toEqual({
      path: "src/a.ts",
      service: undefined,
      json: false,
      refresh: false,
    });
  });

  test("--service sets the service param", () => {
    expect(parseOwnersArgs(["--service", "checkout"]).service).toBe("checkout");
  });

  test("no args is summary mode", () => {
    expect(parseOwnersArgs([])).toEqual({
      path: undefined,
      service: undefined,
      json: false,
      refresh: false,
    });
  });

  test("--json and --refresh are flags", () => {
    const p = parseOwnersArgs(["src/a.ts", "--json", "--refresh"]);
    expect(p.json).toBe(true);
    expect(p.refresh).toBe(true);
  });

  test("a path plus --service is rejected", () => {
    expect(() => parseOwnersArgs(["src/a.ts", "--service", "checkout"])).toThrow(
      /mutually exclusive/,
    );
  });

  test("an unrecognised flag is rejected, not ignored", () => {
    expect(() => parseOwnersArgs(["--nope"])).toThrow();
  });
});

describe("runOwnersCommand", () => {
  test("sends path and never sends an undefined service key", async () => {
    let seen: Record<string, unknown> | undefined;
    await runOwnersCommand(["src/a.ts"], {
      runAgentBriefCli: async (spec) => {
        seen = spec.params;
      },
    } as unknown as Parameters<typeof runOwnersCommand>[1]);

    expect(seen).toEqual({ path: "src/a.ts" });
  });

  test("summary mode sends an empty param object", async () => {
    let seen: Record<string, unknown> | undefined;
    await runOwnersCommand([], {
      runAgentBriefCli: async (spec) => {
        seen = spec.params;
      },
    } as unknown as Parameters<typeof runOwnersCommand>[1]);

    expect(seen).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/cli/src/commands/owners.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the command**

Create `packages/cli/src/commands/owners.ts`:

```ts
import type { IPCClient } from "../ipc-client/index.ts";
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type OwnersCliArgs = {
  path: string | undefined;
  service: string | undefined;
  json: boolean;
  refresh: boolean;
};

const USAGE =
  "Usage: nimbus owners [<path>] [--service <name>] [--json] [--refresh]\n" +
  "  <path>       a file or directory inside a configured git-aware root\n" +
  "  --service    a [ci.service.<id>] service id\n" +
  "  (no args)    ownership coverage summary";

/**
 * `nimbus owners` hard-rejects an unrecognised flag rather than ignoring it, matching
 * `nimbus glossary`. Silently dropping `--srevice` would return a whole-repo summary that
 * looks like a successful answer to a question nobody asked.
 */
export function parseOwnersArgs(args: string[]): OwnersCliArgs {
  let path: string | undefined;
  let service: string | undefined;
  let json = false;
  let refresh = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") {
      json = true;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--service") {
      service = flagValue(args, i, "--service");
      i++;
    } else if (a.startsWith("--")) {
      throw new Error(`Unrecognised flag: ${a}\n${USAGE}`);
    } else if (path === undefined) {
      path = a;
    } else {
      throw new Error(`Unexpected argument: ${a}\n${USAGE}`);
    }
  }

  if (path !== undefined && service !== undefined) {
    throw new Error(`<path> and --service are mutually exclusive\n${USAGE}`);
  }
  return { path, service, json, refresh };
}

type OwnershipBriefLike = { kind: "ownership"; gaps: unknown[] };

function isOwnershipBriefLike(x: unknown): x is OwnershipBriefLike {
  if (x === null || typeof x !== "object") return false;
  const b = x as { kind?: unknown; gaps?: unknown };
  return b.kind === "ownership" && Array.isArray(b.gaps);
}

function awaitPass(client: IPCClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const teardown = (): void => {
      client.offNotification("ownership.passDone", onDone);
      client.offNotification("ownership.passError", onError);
      client.offClose(onClose);
    };
    function onDone(): void {
      teardown();
      resolve();
    }
    function onError(n: unknown): void {
      teardown();
      reject(new Error((n as { message?: string }).message ?? "ownership pass failed"));
    }
    // A pass runs unbounded, so a gateway that dies mid-pass must be detected explicitly
    // rather than hanging forever — the same reason decisions' awaitPass binds onClose.
    function onClose(err: Error): void {
      teardown();
      reject(new Error(`gateway connection closed during the pass: ${err.message}`));
    }
    client.onNotification("ownership.passDone", onDone);
    client.onNotification("ownership.passError", onError);
    client.onClose(onClose);
    client.call<{ jobId: string }>("ownership.refresh", {}).catch((err: unknown) => {
      teardown();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Testability seam mirroring `DecisionsCommandDeps` — no `mock.module`. */
export type OwnersCommandDeps = {
  runAgentBriefCli: typeof runAgentBriefCli;
};

const defaultOwnersDeps: OwnersCommandDeps = { runAgentBriefCli };

export async function runOwnersCommand(
  args: string[],
  deps: OwnersCommandDeps = defaultOwnersDeps,
): Promise<void> {
  const parsed = parseOwnersArgs(args);

  await deps.runAgentBriefCli<OwnershipBriefLike>({
    kind: "ownership",
    guard: isOwnershipBriefLike,
    json: parsed.json,
    params: {
      ...(parsed.path === undefined ? {} : { path: parsed.path }),
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
    },
    ...(parsed.refresh
      ? {
          beforeCall: async (client: IPCClient) => {
            await awaitPass(client);
          },
        }
      : {}),
  });
}
```

Note `spec.kind: "ownership"` drives BOTH `agents.ownership` and `ownership.briefReady` inside `runAgentBriefCli` (`_agent-brief-cli.ts:61,103`) — the naming must stay aligned.

- [ ] **Step 4: Wire the registry**

1. `packages/cli/src/commands/registry.ts` — add `"owners",` to `COMMAND_NAMES`, alphabetically between `"metrics"` and `"people"`.
2. `packages/cli/src/commands/index.ts` — add `export { runOwnersCommand } from "./owners.ts";` alphabetically.
3. `packages/cli/src/index.ts` — add `runOwnersCommand` to the import list (`:17` area) and `owners: runOwnersCommand,` to the dispatch map (`:99` area).

- [ ] **Step 5: Run to verify it passes**

```bash
bun test packages/cli/src/commands/owners.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 6: Verify the registry has no drift**

```bash
bun test packages/cli/src 2>&1 | tail -25
```

Expected: PASS. A registry-drift test exists and will fail if `COMMAND_NAMES` and the dispatch map disagree.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/owners.ts packages/cli/src/commands/owners.test.ts packages/cli/src/commands/registry.ts packages/cli/src/commands/index.ts packages/cli/src/index.ts
git commit -m "feat(cli): nimbus owners over agents.ownership"
```

---

### Task 11: MCP tool

**Files:**
- Modify: `packages/cli/src/mcp/agent-tools.ts:140-255`, `packages/cli/src/mcp/adapter.test.ts:588,904-905`

**Interfaces:**
- Consumes: the `agents.ownership` method and its param bounds from Task 7.
- Produces: an MCP tool named `findOwners`.

- [ ] **Step 1: Add the tool definition**

Append to the `DEFS` array in `packages/cli/src/mcp/agent-tools.ts`, after the `getGlossary` entry:

```ts
  {
    tool: "findOwners",
    agent: "ownership",
    description:
      "Answer 'who owns this code?' from recency-weighted git blame already in the local index. Pass `path` for a file or directory inside a configured root, or `service` for a [ci.service.<id>] id, or neither for a coverage summary. `path` and `service` are mutually exclusive. This is AUTHORSHIP-derived ownership — who wrote the lines, not who is formally accountable.",
    // Bounds mirror the gateway's requireOwnershipParams: path 1..2048, service 1..64.
    // The mutual exclusion is enforced gateway-side and stated in the description, since a
    // zod schema cannot express it without a refinement the tool surface does not carry.
    schema: {
      path: z.string().min(1).max(2048).optional(),
      service: z.string().min(1).max(MAX_SERVICE_LEN).optional(),
    },
    build: (a) => withOptional({}, { path: optStr(a, "path"), service: optStr(a, "service") }),
  },
```

`MAX_SERVICE_LEN` is already declared at `:21`. `optStr` and `withOptional` already exist at `:117` and `:127`.

- [ ] **Step 2: Update the two count assertions and the stale test name**

In `packages/cli/src/mcp/adapter.test.ts`:
- `:588` — `expect(withheld).toHaveLength(11);` → `12`
- `:905` — `expect(TOOL_SPECS).toHaveLength(17);` → `18`
- `:904` — change the test **name** from `"the registered tool set is the six index tools plus peekWhy plus ten agents"` to `"… plus eleven agents"`.

- [ ] **Step 3: Add a routing test**

Append to `packages/cli/src/mcp/agent-tools.test.ts`, following the existing `agents.glossary` case at `:273`:

```ts
  test("findOwners calls agents.ownership and omits absent params", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    // Reuse this file's existing harness for driving a tool against a fake client;
    // copy the setup from the `agents.glossary` case above rather than inventing one.
    await runToolByName(calls, "findOwners", { path: "src/a.ts" });
    expect(calls[0]).toEqual({ method: "agents.ownership", params: { path: "src/a.ts" } });
  });
```

Read `packages/cli/src/mcp/agent-tools.test.ts:265-290` first and match its existing harness exactly — the helper name above is illustrative, not assumed to exist.

- [ ] **Step 4: Run the MCP suite**

```bash
bun test packages/cli/src/mcp/ 2>&1 | tail -25
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp/
git commit -m "feat(mcp): expose agents.ownership as the findOwners tool"
```

---

### Task 12: End-to-end and egress coverage

**Files:**
- Create: `packages/gateway/test/e2e/scenarios/ownership.e2e.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the e2e test**

Read `packages/gateway/test/e2e/scenarios/decisions.e2e.test.ts` first and mirror its harness exactly — the gateway subprocess setup, temp config dir and IPC client differ from unit tests and must not be invented. Then add scenarios asserting:

1. `agents.ownership` with `{ path }` returns `{ sessionId }` and an `ownership.briefReady` follows with a non-empty `brief` string and `findings.kind === "ownership"`.
2. Zero HITL: no consent prompt notification is observed for the duration of the call.
3. An `agents.ownership` call from a client that declared `kind: "mcp"` appends **exactly one** `egress_ledger` row with `source_type = 'mcp'`.
4. The same call over `POST /v1/agents/ownership` appends exactly one row with `source_type = 'http'`.
5. A CLI-originated call appends **zero** rows.

For 3–5, copy the assertion pattern from the existing agent-egress tests:

```bash
grep -rln "source_type" packages/gateway/src/egress/ packages/gateway/src/agent-runs/ packages/gateway/test/
```

- [ ] **Step 2: Run the e2e scenario**

```bash
bun test packages/gateway/test/e2e/scenarios/ownership.e2e.test.ts 2>&1 | tail -25
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/test/e2e/scenarios/ownership.e2e.test.ts
git commit -m "test(ownership): e2e brief, HITL-free property, and egress-ledger coverage"
```

---

### Task 13: Docs, coverage, and the full pre-flight

**Files:**
- Modify: `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`, `packages/docs/src/content/docs/user-guide/agents.mdx`, `.claude/commands/nimbus-agent-patterns.md`, `.claude/commands/nimbus-file-map.md`, `.claude/commands/nimbus-commands.md`

- [ ] **Step 1: Update the docs**

Find each surface's existing `decisions` entry and add the parallel `ownership` one:

```bash
grep -rn "nimbus decisions" docs/ packages/docs/src/content/docs/ .claude/commands/
```

Required content in each:
- `docs/architecture.md` — `agents.ownership` and `ownership.refresh` in the IPC catalogue.
- `docs/cli-reference.md` — the full `nimbus owners` usage block, matching `USAGE` in `owners.ts` verbatim.
- `docs/CHANGELOG.md` — a dated entry under the current unreleased heading. This is where connector/feature deliveries go; do **not** edit the CLAUDE.md status line.
- `docs/roadmap.md` — mark the S1 ownership row's read surface delivered.
- `packages/docs/src/content/docs/user-guide/agents.mdx` — a user-facing section stating plainly that this is authorship-derived ownership, not accountability.
- The three skill files — one row each.

Do **not** edit `CLAUDE.md` or `GEMINI.md`: no command catalogue, invariant, or non-negotiable changed.

- [ ] **Step 2: Measure coverage on every new file**

```bash
bash scripts/coverage-floor/build-lcov.sh
bun run audit:coverage-floor 2>&1 | tail -30
```

The floor is ≥85 % line **and** ≥80 % branch per file, and `packages/gateway/src/agents/` additionally has an ≥80 % line gate. PR A failed CI at 75 % branch on `ownership-refresh.ts` because this gate was treated as unverifiable locally — it is not. Add targeted tests for any uncovered branch in `ownership-store.ts`, `ownership-target.ts`, `agents/ownership.ts`, `ipc/ownership-rpc.ts` and `cli/src/commands/owners.ts`.

This gate is **CI-Linux-authoritative**. If the local run disagrees with CI, re-run it under Docker:

```bash
bun run verify:docker
```

- [ ] **Step 3: Run the full pre-flight, redirected to a file**

```bash
bun run preflight > /tmp/preflight-ownership.txt 2>&1; echo "EXIT=$?"
grep -nE "FAIL|✗|error|EXIT=" /tmp/preflight-ownership.txt | head -40
```

**Never pipe `preflight` directly into `tail`/`grep`** — a pipe's exit status is the last command's, and that has masked a failing run in this repo before. Redirect first, echo the exit code, then grep the file.

`preflight` fail-fasts: an early lint failure hides the audits, the build and the whole suite. If it fails, fix and re-run from the top until `EXIT=0`.

- [ ] **Step 4: Confirm the untouched invariants**

```bash
grep -n "toHaveLength(13)" packages/gateway/src/security-invariants.test.ts packages/gateway/src/ipc/http-write-routes.test.ts
grep -n "CURRENT_SCHEMA_VERSION = " packages/gateway/src/index/local-index.ts
git diff --stat origin/main -- packages/gateway/src/security-invariants.test.ts
```

Expected: `WRITE_ROUTE_ALLOWLIST` still 13 at all three sites, `CURRENT_SCHEMA_VERSION = 51`, and an **empty** diff for `security-invariants.test.ts`.

- [ ] **Step 5: Check the merge is clean before pushing**

```bash
git fetch origin main && git merge-tree --write-tree origin/main HEAD > /dev/null && echo "CLEAN MERGE"
```

- [ ] **Step 6: Commit and push**

```bash
git add docs/ packages/docs/ .claude/commands/
git commit -m "docs: record the ownership read surface across the doc and skill surfaces"
git push -u origin dev/asafgolombek/ownership-agent
```

- [ ] **Step 7: Open the PR**

Title (release-please parses this): `feat(gateway): read the ownership graph through the agents.ownership brief`

The description is the permanent commit body. It must state:
- What PR B adds and that PR A's graph was previously unreadable.
- The four writer-side corrections (spec §6), each with its defect.
- The count deltas actually applied, and that `WRITE_ROUTE_ALLOWLIST` stayed at 13 and the schema stayed at V51.
- The exact compile error observed in Task 5 Step 7, as evidence the exhaustiveness guard is real.
- Any gate that could not be run locally (e.g. `cargo test` without Rust installed).

**Do not** include a bare `Release-As:` line — it would force a release nobody asked for.

---

## Self-Review

**Spec coverage.** §4.1 request modes → Task 7. §4.2 brief shape → Task 5. §5.1 placement → the File Structure table. §5.2 root-set + root-itself → Task 3. §5.3 four lanes → Task 6. §5.4 three unions + exhaustiveness → Task 5. §5.5 `ownership.refresh` + no-params → Task 8. §6.1 floor/cap → Task 1. §6.2 error class → Task 2. §6.3 first production caller → Task 8 Step 6. §6.4 service metadata → Task 1 Steps 6–7. §7 security (I13/I29/I7/I5) → Global Constraints, Tasks 9, 12, 13 Step 4. §8 gap notes → Task 6 `buildGaps`. §9 tests → distributed. §10 count deltas → Tasks 7, 9, 11, and both prose test names are called out explicitly.

**Type consistency.** `rankOwners` returns `aboveFloor` (Task 1) and only `aboveFloor` is referenced later. `ResolvedOwnershipPath` uses `relPath` throughout Tasks 3, 4 and 6 — note `matchConfiguredRoot` returns `filePath`, and Task 3's implementation renames it at the boundary, deliberately. `OwnershipCounts` fields (`ownerCount`/`ownersAboveFloor`/`truncated`) match between the store (Task 4), the brief (Task 5) and the renderer. `spec.kind: "ownership"` in Task 10 aligns with `emitOwnershipBrief`'s `ownership.briefReady` in Task 6.

**Known soft spots, flagged rather than hidden.** Three steps say "read the existing harness and match it" instead of giving code: Task 8's `LongRunningJobRegistry.start` options, Task 11 Step 3's MCP test harness, and Task 12's e2e harness. Each is a case where inventing a signature is more dangerous than requiring a read — the exact reference file and line range is named in every one. If any of them turns out to differ materially from its named reference, report NEEDS_CONTEXT rather than guessing.
