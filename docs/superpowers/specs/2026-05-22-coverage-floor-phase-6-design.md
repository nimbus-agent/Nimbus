# Coverage Floor Phase 6 — CLI Long Tail

**Date:** 2026-05-22
**Spec parent:** [`2026-05-17-coverage-floor-design.md`](./2026-05-17-coverage-floor-design.md) §"Phasing"
**Direct predecessor:** [`2026-05-21-coverage-floor-phase-5-design.md`](./2026-05-21-coverage-floor-phase-5-design.md)
**Branch:** `dev/asafgolombek/coverage-floor-phase-6-2026-05-22`
**Worktree:** `.worktrees/coverage-floor-phase-6-2026-05-22/`
**Branched from:** `origin/main` at `c1bf730f` (Phase 5 merge, PR #398)

---

## Goal

Bring the **CLI bucket** above the 80% per-file line-coverage floor. After Phase 5 the Gateway baseline is effectively empty; the next-largest concentration is the 51 CLI entries under `packages/cli/src/`:

- 39 command files (`commands/*.ts`), most at <20% line coverage
- 9 lib files (`lib/*.ts`), most at <40%
- 3 misc files (`index.ts` 0%, `paths.ts` 46.48%, `types/agents.ts` 6.67%)

The dominant property that distinguishes Phase 6 from Phases 1–5 is **homogeneity**. Every command file has roughly the same shape (parse argv → call gateway IPC → format output to stdout/stderr). The load-bearing technical decision is therefore not "which uncovered branches to target" but "what shared test harness propagates cleanly across 39 files **without** the `mock.module` leak that Phase 5 commit 12 documented".

**Expected outcome:** baseline drops from 92 → 41 entries (51 CLI entries removed: 50 raised to ≥80% + 1 structurally excluded [`cli/src/index.ts`]). The remaining 41 entries are entirely outside the CLI and packaged for Phase 7+:

- 1 gateway leftover (`embedding/model.ts` 13.51%, Phase 5 Task 12 fallback)
- 5 client entries (`@nimbus-dev/client`)
- 3 SDK entries (`crypto/verify-signature.ts`, `ipc/index.ts`, `ipc/ndjson-line-reader.ts`)
- 32 mcp-connector entries (31 `server.ts` files at 0% + `jenkins/src/jenkins-api.ts` at 17.89%)

After Phase 6 the CLI baseline is empty. Every remaining baseline file is either an MCP connector, the SDK, the client package, or the one Phase 5 fallback.

---

## Approach

This phase introduces **the first shared test harness in the coverage-floor program**. Phases 1–5 reused existing patterns; Phase 6 must build one because the 39 command files all need the same scaffolding (IPC client stub, stdout/stderr capture, gateway-state stub for the dispatcher's "Gateway not running" guard). The harness lives in `packages/cli/test/helpers/` and is the **only caller** of `mock.module` for cross-cutting CLI dependencies.

### Why a shared harness — and why mock isolation is load-bearing

Phase 5 commit 12 demonstrated that `mock.module(...)` is process-global under `bun test --coverage`, which [`scripts/coverage-floor/build-lcov.sh`](../../../scripts/coverage-floor/build-lcov.sh) runs **once per package** picking up both colocated `*.test.ts` files and `test/integration/**/*.test.ts` files into a single bun-test process. The `afterAll`-reset pattern documented in the existing [`packages/cli/src/commands/extension.test.ts:33-38`](../../../packages/cli/src/commands/extension.test.ts) therefore does NOT prevent cross-file contamination: sibling test files load their references during module-load (before any `afterAll` fires), and the last `mock.module` call to register wins for the rest of the process.

The fix is structural, not procedural:

- **Exactly one `mock.module` call** per cross-cutting dependency (currently: `@clack/prompts.confirm`, `../lib/gateway-process.ts`). Both live in [`packages/cli/test/helpers/cli-mocks.ts`](../../../packages/cli/test/helpers/cli-mocks.ts) and execute at the helper's module-load time.
- The mock implementations are **delegators**: they read from a per-process global slot (`globalThis.__nimbusCliFixture`) set fresh in each test's `beforeEach` and cleared in `afterEach`.
- Test files import `cli-mocks.ts` for its **module-load side effect** (the `mock.module` calls). Test files do NOT call `mock.module` themselves.
- IPC client mocking is NOT done via `mock.module`; sub-handler functions accept `client: IPCClient` directly, and tests pass a hand-rolled mock client built by `createMockIpcClient` in [`packages/cli/test/helpers/mock-ipc-client.ts`](../../../packages/cli/test/helpers/mock-ipc-client.ts).

### Per-file source refactor

Most commands today either define their own private `withIpc()` helper (e.g. [`packages/cli/src/commands/vault.ts:7-20`](../../../packages/cli/src/commands/vault.ts#L7-L20)), or construct `new IPCClient(state.socketPath)` inline in their top-level `runX(args)` function (e.g. [`packages/cli/src/commands/ask.ts:36-50`](../../../packages/cli/src/commands/ask.ts#L36-L50), [`packages/cli/src/commands/catchup.ts`](../../../packages/cli/src/commands/catchup.ts)). Phase 6's harness shape requires each command to split into:

1. A top-level `runX(args)` dispatcher — reads gateway state, opens IPCClient, dispatches by subcommand.
2. **One exported sub-handler per subcommand** — accepts `client: IPCClient` (and any other deps) as parameters.

Tests target the **sub-handlers**, passing the mock IPC client directly. The dispatcher's "Gateway not running" branch gets one small test per command via the shared `gateway-process.ts` mock.

This refactor is mechanical (~10 lines per command) and lands in the **family commit** for that command, not in a separate pre-sweep commit. Same precedent as Phase 5 commit 12 (extract `load-transformer-pipeline.ts` + add `model.test.ts` together — causally coupled).

### Hybrid: in-process for 46 files, real subprocess for 3

| Strategy | Where | Why |
|---|---|---|
| **(a) In-process** with sub-handler DI + hand-rolled `IPCClient` stub | 39 commands + 6 of 9 lib files + `paths.ts` + `types/agents.ts` | Fast (~50 ms/test), real stack traces, no subprocess flake |
| **(b) Real subprocess** with `Bun.spawn` | `lib/gateway-process.ts`, `lib/spawn-gateway.ts`, `lib/restore-db-from-snapshot.ts` | These files exist to spawn and supervise subprocesses; testing them in-process means mocking `Bun.spawn` heavily, defeating their purpose. `spawn-gateway.test.ts` already exists; extend it. |

---

## Scope

### Tier S — Structural exclusion (1 file)

| File | Baseline | Justification |
|---|---|---|
| `packages/cli/src/index.ts` | 0% | Top-level `await main()` makes in-process testing impossible. Same exemption rationale as `packages/gateway/src/index.ts` (already excluded at [`scripts/coverage-floor/exclusions.ts:87`](../../../scripts/coverage-floor/exclusions.ts#L87)) and `packages/github-actions/*/src/main.ts` (excluded at line 128). |

### Tier H — Harness foundation (1 commit, 3 helpers + 1 reference test)

The harness commit lands the shared helpers + one reference test (`vault.test.ts`) that proves the pattern end-to-end. Vault is the cleanest exemplar — 4 sub-handlers, well-bounded, interactive `confirm()` for the read path, no streaming, no progress reporting.

Files created under `packages/cli/test/helpers/`:

| File | Role |
|---|---|
| `cli-mocks.ts` | Single `mock.module` site for `@clack/prompts` + `../lib/gateway-process.ts`. Reads from `globalThis.__nimbusCliFixture`. |
| `mock-ipc-client.ts` | `createMockIpcClient(responseQueue, notificationHandlers?)` → `{ client, calls }`. Hand-rolled `IPCClient`-shaped object. |
| `cli-output.ts` | `captureOutput()` stubs `process.stdout.write` + `process.stderr.write` + `console.log` per-test; restores in `afterEach`. |

Plus the per-command refactor + test for `vault.ts` (4 sub-handlers: `vaultSet`, `vaultGet`, `vaultDelete`, `vaultList`).

### Tier L — Lib helpers + paths.ts (3 commits, 10 files)

Subdivided by testing strategy.

**Tier L-1 — Pure helpers (1 commit, 4 files):**

| File | Baseline | Approach |
|---|---|---|
| `packages/cli/src/paths.ts` | 46.48% | Mirror gateway's Phase 5 Task 4: `mock.module("./env.ts", ...)` for `envGet`; test `resolveSocketPath` env override + 3 OS arms of `getCliPlatformPaths`. |
| `packages/cli/src/lib/strip-trailing-slashes.ts` | 0% | Pure 1-liner; 3-4 cases (empty, single slash, multiple slashes, no slash). |
| `packages/cli/src/lib/workflow-parse.ts` | 9.09% | Pure parser; cases by input shape (valid YAML, invalid YAML, missing required fields). |
| `packages/cli/src/lib/connector-oauth-env-help.ts` | 31.25% | Pure formatter for the OAuth env-var help message; cases per connector. |

**Tier L-2 — Stateful helpers (1 commit, 3 files):**

| File | Baseline | Approach |
|---|---|---|
| `packages/cli/src/lib/cli-logger.ts` | 18.18% | Use `captureOutput()` from the harness; verify log-level routing + `NO_COLOR` handling. |
| `packages/cli/src/lib/nimbus-toml-config.ts` | 40.11% | Tmp-dir fs ops; write a TOML, parse it, assert shape. Cover the validation branches. |
| `packages/cli/src/lib/with-gateway-ipc.ts` | 18.75% | Pass a tmp `CliPlatformPaths` with a fake `gateway.json` pointing at a real `Bun.listen` socket; verify happy path + "gateway not running" path. |

**Tier L-3 — Subprocess-managing helpers (1 commit, 3 files, option-b real-subprocess pattern):**

| File | Baseline | Approach |
|---|---|---|
| `packages/cli/src/lib/gateway-process.ts` | 15.22% | Real `Bun.spawn` of a no-op echo subprocess; test PID-file write/read/cleanup. |
| `packages/cli/src/lib/spawn-gateway.ts` | 23.4% | `spawn-gateway.test.ts` already exists; extend with the uncovered launch-failure / log-tail branches. |
| `packages/cli/src/lib/restore-db-from-snapshot.ts` | 25% | Tmp dir + fake snapshot file; verify the restore-then-verify flow. |

### Tier F — Command families (8 commits, 39 commands + types/agents.ts)

Ordered low-risk → high-risk per Phase 5 precedent. `vault.ts` is covered in Tier H; the remaining 38 commands distribute across F-1..F-8.

| Commit | Family | Files | Notes |
|---|---|---|---|
| F-1 | Info / observability | `connector`, `data`, `db`, `audit`, `diag`, `doctor`, `status` (7) | Mostly query/list flows; small IPC surface per command. |
| F-2 | CI/CD + remote | `deploy`, `deploy-annotate`, `metrics`, `lan`, `security` (5) | All have partial existing tests; migrate onto harness + fill gaps. |
| F-3 | Query / index | `query`, `search`, `session`, `repl`, `people`, `index-cmd`, `registry` (7) | `repl` is interactive — uses `confirm()`. `index-cmd` already 55%. |
| F-4 | Automation | `workflow`, `run-workflow`, `watch` (3) | |
| F-5 | Lifecycle / dev | `start`, `stop`, `serve`, `update`, `scaffold`, `test` (6) | `start`/`stop` overlap with `lib/gateway-process.ts` (covered in L-3); keep tests narrow to the command's dispatch + output shape. |
| F-6 | Agent / interactive | `ask`, `catchup`, `expert`, `impact`, `tui` (5) + `types/agents.ts` | TUI needs explicit `process.stdout.isTTY` stubbing per Phase 5 lesson. `types/agents.ts` covered here because its three runtime type guards (`isExpertBrief`, `isImpactBrief`, `isCatchupBrief`) are consumed by these commands. |
| F-7 | Config + misc | `config`, `profile`, `telemetry`, `help` (4) | Mostly file I/O + format. |
| F-8 | Extension family migration | `extension`, plus migrating existing `extension.test.ts`, `extension-sync.test.ts`, `extension-tree.test.ts`, `extension-update.test.ts` onto the shared harness | Late because the 4 existing test files all have the latent `afterAll`-reset bug; migration is delicate and the harness pattern is fully proven by F-1..F-7. |

### Tier C — Closeout (1 commit)

| Commit | Subject | Files |
|---|---|---|
| C-1 | `chore(coverage-floor): drop raised entries + Phase 6 plan + status row` | `coverage-baseline.json` + this plan file + `CLAUDE.md` + `GEMINI.md` status row |

### Out of scope (pinned for Phase 7+)

Untouched. These remain in baseline at their current watermarks:

| Bucket | Count | Notes |
|---|---|---|
| Gateway leftover | 1 | `embedding/model.ts` 13.51% — Phase 5 Task 12 fallback. Needs the routing-runtime DI refactor (not a long-tail nudge). |
| Client package | 5 | `client/src/{index,ipc-transport,mock-client,nimbus-client,stream-events}.ts` |
| SDK | 3 | `crypto/verify-signature.ts` 18.68%, `ipc/index.ts` 0%, `ipc/ndjson-line-reader.ts` 2.94% |
| MCP connectors | 32 | 31 `**/server.ts` files at 0% + `jenkins/src/jenkins-api.ts` at 17.89% |

Phase 7 (proposed): MCP connectors via the existing `@nimbus-dev/sdk/testing.runContractTests` harness — the SDK already publishes a contract-test surface; Phase 7 plugs that into the coverage floor. Phase 8: client + SDK final cleanup. Phase 9: revisit gateway `embedding/model.ts` via routing-runtime DI.

---

## Commit Structure

Single PR, 14 commits ordered low-risk → high-risk:

| # | Commit subject | Files | New tests |
|---|---|---|---|
| 1 | `chore(coverage-floor): structurally exclude cli/index.ts` | `exclusions.ts` + `sonar-project.properties` + `coverage-baseline.json` | 0 |
| 2 | `test(cli): shared test harness + vault reference (cli-mocks, mock-ipc-client, cli-output)` | 3 helpers + `vault.ts` refactor + `vault.test.ts` | ~6 |
| 3 | `test(cli): cover paths.ts + small pure lib helpers` | 4 source + 4 tests | ~12 |
| 4 | `test(cli): cover stateful lib helpers (cli-logger, nimbus-toml-config, with-gateway-ipc)` | 3 source + 3 tests | ~9 |
| 5 | `test(cli): cover subprocess-managing lib helpers (gateway-process, spawn-gateway, restore-db-from-snapshot)` | 3 source + 3 tests (option-b subprocess) | ~9 |
| 6 | `test(cli): cover info / observability commands (connector, data, db, audit, diag, doctor, status)` | 7 commands × (refactor + test) | ~28 |
| 7 | `test(cli): cover CI/CD + remote commands (deploy, deploy-annotate, metrics, lan, security)` | 5 commands; 4 already partial — migrate | ~20 |
| 8 | `test(cli): cover query / index commands (query, search, session, repl, people, index-cmd, registry)` | 7 commands | ~28 |
| 9 | `test(cli): cover automation commands (workflow, run-workflow, watch)` | 3 commands | ~12 |
| 10 | `test(cli): cover lifecycle / dev commands (start, stop, serve, update, scaffold, test)` | 6 commands | ~24 |
| 11 | `test(cli): cover agent / interactive commands (ask, catchup, expert, impact, tui) + types/agents.ts` | 5 commands + 1 types file; 4 commands already partial | ~25 |
| 12 | `test(cli): cover config + misc commands (config, profile, telemetry, help)` | 4 commands | ~16 |
| 13 | `test(cli): migrate + extend extension family (raise from 72% baseline)` | `extension.ts` + 3 existing subcommand test files → migrated to shared harness; gaps filled | ~10 |
| 14 | `chore(coverage-floor): drop raised entries + Phase 6 plan + status row` | `coverage-baseline.json` + plan + status row | 0 |

**Totals:** ~199 new tests across ~50 test files + 1 structural exclusion + 51 baseline entries removed (50 raised + 1 excluded).

**Ordering rationale:**

- Commit 1 first because pure-config (zero reversibility risk) — Phase 5 precedent.
- Commit 2 lands the harness with vault as the reference. Vault has no streaming, no progress reporting, and clean sub-handler boundaries — fastest path from "no harness" to "one working test that proves the pattern".
- Lib first (commits 3-5) because some commands depend on lib helpers; lib regressions show up before family commits.
- Family commits 6-12 ordered roughly by IPC surface complexity. Info/data first (one-shot queries), automation/lifecycle middle (multi-step writes), agent/interactive last (streaming + TTY).
- Extension family (commit 13) intentionally late: requires migrating **existing** test files onto the shared harness. The migration is delicate; doing it last means the harness is fully shaken out.
- Commit 14 lands the baseline drop + status row. **The `update-baseline` script is run ONLY in this commit.** Phase 5 Task 9 was reverted because a mid-task `update-baseline` injected local-Windows lcov values that diverged from CI Linux (Phase 5 fixup `06628373`).

---

## Test Infrastructure

### Shared helpers (created in commit 2)

```
packages/cli/test/helpers/
├── cli-mocks.ts            (one mock.module per cross-cutting dep)
├── mock-ipc-client.ts      (hand-rolled IPCClient stub builder)
└── cli-output.ts           (process.stdout/stderr/console.log capture)
```

**`cli-mocks.ts`** — single source of `mock.module` for the CLI test suite:

```typescript
// packages/cli/test/helpers/cli-mocks.ts
import { mock } from "bun:test";

export interface CliTestFixture {
  gatewayState?: { socketPath: string; pid?: number };
  clackAnswer?: boolean | symbol;
}

declare global {
  // eslint-disable-next-line no-var
  var __nimbusCliFixture: CliTestFixture | undefined;
}

const cancelSymbol = Symbol.for("clack:cancel");

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  confirm: async () => globalThis.__nimbusCliFixture?.clackAnswer ?? true,
  isCancel: (v: unknown) => v === cancelSymbol,
}));

mock.module("../lib/gateway-process.ts", () => ({
  readGatewayState: async () => globalThis.__nimbusCliFixture?.gatewayState,
}));

export function setFixture(f: CliTestFixture): void {
  globalThis.__nimbusCliFixture = f;
}

export function clearFixture(): void {
  globalThis.__nimbusCliFixture = undefined;
}

export const CLACK_CANCEL = cancelSymbol;
```

**`mock-ipc-client.ts`** — hand-rolled IPC client builder (no `mock.module`):

```typescript
// packages/cli/test/helpers/mock-ipc-client.ts
import type { IPCClient } from "../../src/ipc-client/index.ts";

export type CallRecord = { method: string; params: unknown };
export type IpcResponse = unknown | Error;

export function createMockIpcClient(
  responseQueue: ReadonlyArray<IpcResponse>,
  notificationHandlers?: Map<string, (params: unknown) => void>,
): { client: IPCClient; calls: CallRecord[]; emit: (method: string, params: unknown) => void } {
  const calls: CallRecord[] = [];
  let idx = 0;
  const handlers = notificationHandlers ?? new Map();
  const client = {
    call: async <T>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params });
      const r = responseQueue[idx++];
      if (r instanceof Error) throw r;
      return r as T;
    },
    on: (event: string, handler: (params: unknown) => void): void => {
      handlers.set(event, handler);
    },
    connect: async (): Promise<void> => {},
    disconnect: async (): Promise<void> => {},
  };
  const emit = (method: string, params: unknown): void => {
    handlers.get(method)?.(params);
  };
  return { client: client as unknown as IPCClient, calls, emit };
}
```

**`cli-output.ts`** — output capture:

```typescript
// packages/cli/test/helpers/cli-output.ts
export interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  reset(): void;
  restore(): void;
}

export function captureOutput(): CapturedOutput {
  let stdout = "";
  let stderr = "";
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleLog = console.log;
  const origConsoleError = console.error;

  process.stdout.write = ((data: string | Uint8Array): boolean => {
    stdout += typeof data === "string" ? data : new TextDecoder().decode(data);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((data: string | Uint8Array): boolean => {
    stderr += typeof data === "string" ? data : new TextDecoder().decode(data);
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]): void => {
    stdout += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };
  console.error = (...args: unknown[]): void => {
    stderr += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };

  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    reset(): void { stdout = ""; stderr = ""; },
    restore(): void {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      console.log = origConsoleLog;
      console.error = origConsoleError;
    },
  };
}
```

### Per-test pattern

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../test/helpers/cli-mocks.ts";  // module-load side effects only
import { clearFixture, setFixture } from "../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../test/helpers/mock-ipc-client.ts";
import { captureOutput } from "../test/helpers/cli-output.ts";
import { runVaultSet } from "./vault.ts";

describe("runVaultSet", () => {
  const out = captureOutput();
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls vault.set with the right key/value", async () => {
    const { client, calls } = createMockIpcClient([null]);
    await runVaultSet(client, "github.pat", "ghp_test");
    expect(calls[0]).toEqual({
      method: "vault.set",
      params: { key: "github.pat", value: "ghp_test" },
    });
    expect(out.stdout).toBe("Stored.\n");
  });
});
```

### Source-shape convention (sub-handler DI)

Every command file exports both:

1. `runX(args: string[]): Promise<void>` — top-level dispatcher (existing entry).
2. **One exported sub-handler per subcommand**, each accepting `client: IPCClient` as a parameter.

Tests target the sub-handlers. The dispatcher's "Gateway not running" branch gets one test per command using the `cli-mocks.ts` `setFixture({ gatewayState: undefined })`.

### Reused patterns

| Pattern | Used by |
|---|---|
| `process.stdout.isTTY` / `.columns` / `.rows` `defineProperty` stubs (TTY guard, Phase 5 lesson) | Commit 11 (`tui` command + any command that uses Ink) |
| `Bun.serve({ port: 0 })` for any test that needs a real listener (Phase 5 lesson) | None expected in Phase 6 (CLI doesn't spawn HTTP servers; sockets are unix domain) |
| `Bun.spawn` real-subprocess + tmp dir | Commit 5 (subprocess-managing lib helpers) |
| `MockVault` from `@nimbus-dev/sdk/testing` | Not expected (CLI doesn't touch Vault directly — it delegates via IPC) |

---

## Carry-forwards

### Phase 4 (still apply)

- **CI Linux is authoritative.** Local Windows lcov diverges on a known set of pinned files. Never lower a baseline watermark to match local Windows lcov — only match CI Linux.
- **TS strictness modes:** `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes: true`.
- `bun:test`'s `test.each(table)` requires a **mutable** array — never `readonly T[]`.
- For `fetch` stubs: closures that throw infer `Promise<never>` and need `as unknown as typeof fetch`; closures that return `Response` use plain `as typeof fetch`.
- IDE false positives to ignore: `await expect(...).rejects.toThrow(...)` "await has no effect", `bun:sqlite` / `bun:test` "declared but never read" on used imports, stale unused-import warnings, `replaceAll` "not on string", `node:path.join` "missing slash" suggestions on Windows.
- `db.run` / `db.exec` in test files is fine (static auditor skips `*.test.ts`).
- Run `bun run lint:fix` before every commit.

### Phase 5 execution (treat as Phase 6 guardrails)

These are the lessons that emerged during Phase 5 PR #398's execution — each is a load-bearing constraint for Phase 6:

1. **`mock.module(...)` is process-global AND only affects FUTURE imports.** `build-lcov.sh` runs `bun test --coverage` once per package, so any `mock.module("./shared.ts", ...)` at the top of one test file leaks to every later test file in the same process. An `afterAll` restore does NOT fix this — consumer files load their references during the module-load phase, before any `afterAll` runs. Phase 5 commit `3901210c` is the reference fix; the earlier `8a4beeb4` attempt with `afterAll` restore explicitly did NOT work.

   **Phase 6 application:** The shared `cli-mocks.ts` helper is the **only** site that calls `mock.module` for `@clack/prompts` or `../lib/gateway-process.ts`. Test files import the helper for module-load side effects only. Per-test state lives in `globalThis.__nimbusCliFixture`. For any other process-env mutation, snapshot/restore in `beforeEach`/`afterEach` — never `afterAll`.

2. **`mock.module` collision avoidance via sibling shim.** When a colocated test needs to mock a module that a sibling already mocks (Phase 5 `model.ts` hit this with `@xenova/transformers`), the reliable fix is to extract the dynamic-import call into a tiny sibling source shim and mock the shim. Phase 6 is unlikely to hit this (CLI doesn't have dynamic imports of the kind that caused the Phase 5 collision), but the rule stands if any command's test surfaces a similar conflict.

3. **`node:path.join` is platform-dependent.** Never hardcode `\\` or `/` separators in path assertions. Always use `join(...)` against the same operands the source uses. Phase 5 commit `a5b5587c` is the reference fix.

4. **Never run `bun run audit:coverage-floor:update-baseline` mid-task.** The auto-updater uses LOCAL lcov measurements which diverge from CI Linux on pinned files. Phase 5 Task 9 implementer ran it and the resulting mass-baseline-edit had to be reverted in fixup `06628373`. Baseline edits belong in the FINAL Task (commit 14) only, hand-curated against CI-Linux-equivalent measurements. **Implementer prompts for commits 2-13 explicitly forbid this.**

5. **TUI tests need explicit `process.stdout.isTTY` stubbing.** Headless CI has `isTTY=false`, which exercises the fallback render path, not the interactive surface. Pattern:
   ```typescript
   let origIsTty: PropertyDescriptor | undefined;
   beforeEach(() => {
     origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
     Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
   });
   afterEach(() => {
     if (origIsTty) Object.defineProperty(process.stdout, "isTTY", origIsTty);
     else delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
   });
   ```
   Applies to commit 11 (`tui` command, plus any command that uses Ink rendering).

6. **`Bun.serve({ port: 0 })` for any test that spawns a real server.** Never hardcode a port. CI workers collide on fixed ports. Not expected in Phase 6 (CLI uses unix sockets, not HTTP) but stated for completeness.

7. **Don't commit auto-modified files unrelated to your task** (e.g. `.claude/settings.local.json` which gets updated by the permissions system). Verify `git status` before each commit; stage explicit paths only — never `git add -A` / `git add .`.

8. **Branch-update strategy.** Origin/main moves fast; Phase 5 merged main into the branch three times during the merge-gate cycle. Phase 6 should expect similar; rebase or merge as needed. `CLAUDE.md` + `GEMINI.md` status rows conflict every time — merge conflict resolution: keep both the Phase 6 row AND any new entries that landed in main.

9. **The plan's per-file case suggestions are guesses.** Read the source FIRST; target the actual uncovered branches; document divergence in implementer reports.

---

## Acceptance

1. `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` exits 0 locally (CI Linux is authoritative for the merge gate).
2. `bun run audit:exclusion-parity` exits 0 — `sonar-project.properties` and `exclusions.ts` agree on the 1 new entry.
3. `bun run audit:invariants` exits 0 — D10 / D12 / vault-key allow-list unchanged.
4. `bun run lint` + `bun run typecheck` exit 0.
5. Baseline file drops 51 entries (50 raised to ≥80% + 1 newly excluded `cli/src/index.ts`); none added. The exception is any CLI file where 80% is genuinely out of reach — that entry stays at a raised watermark, not dropped (spec rule 3 fallback).
6. No file currently above 80% drops below 80% — checked by the floor gate.
7. The 4 explicitly-out-of-scope buckets (gateway `embedding/model.ts`, client, SDK, mcp-connectors) remain untouched at their current baseline watermarks.
8. **`packages/cli/test/helpers/cli-mocks.ts` is the only file in the CLI package that calls `mock.module` for `@clack/prompts` or `../lib/gateway-process.ts`.** Verified via `grep -r 'mock.module' packages/cli/src/ packages/cli/test/ | grep -v 'cli-mocks.ts'` returning no matches against those two targets.

---

## Risks

| Risk | Mitigation |
|---|---|
| `mock.module` leak across the 51 files (the #1 risk) | All `mock.module` calls funnel through `cli-mocks.ts`. Test files import for module-load side effects only. Per-test state lives in `globalThis.__nimbusCliFixture`. The reference test (`vault.test.ts`, commit 2) proves the pattern; all subsequent tests follow the same shape. Acceptance criterion 8 is the structural check. |
| Per-command sub-handler refactor inflates family commit diffs | Each refactor is ~10 lines (extract sub-handlers + parameterize `client`). For a 7-command family commit, total source-refactor lines ≈ 70; tests add ~150 lines. Diff stays reviewable. If a specific command's refactor is unexpectedly invasive, split that command into its own commit. |
| Existing partial-coverage tests (9 commands: extension at 72%, catchup 45%, deploy-annotate 69%, expert 39%, impact 45%, metrics 39%, index-cmd 55%, lan 36%, security 50%) conflict with the new harness during family-commit migration | These 9 tests today all use the same broken `afterAll`-reset pattern (e.g. `extension.test.ts:33-38`). Migration is mechanical: replace per-file `mock.module` with import of `cli-mocks.ts`, replace per-file global state with `setFixture`. The Phase 5 lesson is well-documented; subagent implementers have the pattern in hand. |
| TUI command (`tui.tsx`) and TUI-using commands fail to reach 80% on headless CI | Carry-forward 5 (TTY stubbing) is the primary mitigation. If 80% remains out of reach for `tui.tsx` after the TTY stubs are applied, raise the watermark per spec rule 3 fallback. The TUI surface is React Ink rendering; some render branches may require involved child-component stubbing. |
| `repl.ts` (10.77%) has interactive readline loop that may resist in-process testing | The repl command is an interactive REPL — testing the parse-and-execute step in-process is fine, but testing the readline event loop in-process is not. Cover the parse-and-execute helper functions; raise the watermark on the loop wiring if needed. |
| `extension.ts` migration (commit 13) is the largest single-file investment — 4 existing test files to migrate | Late placement allows the harness to be fully validated by commits 2-12 first. Each existing extension test file migrates independently. If any one's migration is unexpectedly hard, split commit 13 into 13a / 13b / 13c / 13d (one per existing test file). |
| `lib/gateway-process.ts` (commit 5) currently has process-management logic that touches real PID files | Use a tmp dir per test for the PID file location. The `Bun.spawn` target can be `["bun", "-e", "process.stdin.on('data', () => {}); console.log('alive')"]` — a no-op that the test cleans up with `proc.kill()`. |
| Branch falls behind origin/main during the multi-day implementation | Phase 5 carry-forward 8: rebase or merge regularly. Status-row conflicts in CLAUDE.md / GEMINI.md merge clean if you preserve both rows. |
| Coverage gate flakes on Windows lcov local vs CI Linux | Carry-forward 1: never lower a watermark to match local Windows. Run baseline verification on CI before merging. |
| `update-baseline` accidentally run mid-task | Commit-message convention: every commit message includes "baseline updated only in commit 14" in its body. Implementer prompts for commits 2-13 explicitly forbid running `audit:coverage-floor:update-baseline`. |
| `repl.ts` and `tui.tsx` are `.tsx` files — `IPCClient`-sub-handler refactor might affect React component imports | Both files mix dispatch logic with React rendering. Sub-handler extraction targets the dispatch logic only; React components remain as-is. The exported sub-handler returns data; the React component consumes it. |

---

## Out-of-band cleanup

Before starting Phase 6 work, `rm -rf` any stale Phase 5 worktree directory left over from PR #398. The worktree directory at `.worktrees/coverage-floor-phase-5-2026-05-21` may persist after `git worktree remove` if Windows long-path handling failed (the same "Filename too long" symptom Phase 5 documented).

**Windows long-path fallback:** Git Bash's `rm -rf` may fail on deep `node_modules` hierarchies. If it does, drop into PowerShell and run:

```powershell
Remove-Item -LiteralPath '.worktrees/coverage-floor-phase-5-2026-05-21' -Recurse -Force
```

If both fail, leave the stale directory in place (it's git-ignored under `.worktrees/`); the only cost is disk space, not correctness.

Worktree creation itself was handled out-of-band before this spec was authored (Phase 5 precedent), at `.worktrees/coverage-floor-phase-6-2026-05-22/` on branch `dev/asafgolombek/coverage-floor-phase-6-2026-05-22` off `origin/main` at `c1bf730f`.

---

## Phase 6 → Phase 7+ transition

After this PR merges, the baseline should be 41 entries:

- 1 gateway leftover (`embedding/model.ts` — needs Phase 9 routing-runtime DI)
- 5 client entries
- 3 SDK entries
- 32 mcp-connector entries
- **0 CLI entries** — Phase 6 closes the CLI.

Phase 7 (proposed): MCP connectors via the existing `@nimbus-dev/sdk/testing.runContractTests` harness — the SDK already publishes a contract-test surface; Phase 7 plugs that into the coverage floor. Estimate: 1 contract-test commit per connector cluster (cloud, vcs, chat, observability, productivity) ≈ 6-8 commits.

Phase 8: client + SDK final cleanup. Estimate: 3-4 commits.

Phase 9: revisit gateway `embedding/model.ts` via routing-runtime DI refactor. Estimate: 1 commit (parallel to Phase 5 commit 12's pattern but for the routing runtime layer).
