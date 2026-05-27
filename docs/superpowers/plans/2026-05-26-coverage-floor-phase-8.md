# Coverage Floor Phase 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the per-file coverage-floor baseline from 10 → 0 entries — the finale of the coverage-floor program — by raising 7 CLI command files to ≥80% with test-only changes and structurally excluding 3 entry/seam shims.

**Architecture:** Single PR of 6 commits, low-risk → high-risk. Commit 1 is a config-only structural-exclusion prune (lcov-independent). Commits 2–5 add ~50–60 test cases across 6 test files (1 new, 5 extended) with **zero source changes**. Commit 6 drops the 7 raised entries against the **CI-Linux** `coverage-lcov-merged` artifact and empties the baseline. Four of the seven files (`doctor`, `update`, `connector`, `extension`) are testable through the existing CLI harness with no new module mocks; three (`repl`, `serve`, `test`) need a new `mock.module` of a leaf dependency and use a capture-real/restore-real pattern to avoid poisoning sibling tests in the single-process coverage run.

**Tech Stack:** Bun v1.2+ `bun:test`, TypeScript 6.x strict, the CLI test harness at `packages/cli/test/helpers/` (`cli-mocks.ts` fixture, `cli-output.ts` `captureOutput`, `mock-ipc-client.ts` `createMockIpcClient`), the coverage-floor audit scripts under `scripts/coverage-floor/`.

---

## Spec reference

This plan implements [`docs/superpowers/specs/2026-05-26-coverage-floor-phase-8-design.md`](../specs/2026-05-26-coverage-floor-phase-8-design.md). Read the spec's §"Carry-forwards" before starting — the discipline below depends on it. The branch is already `dev/asafgolombek/coverage-floor-phase-8-2026-05-26`.

### Non-obvious facts the implementer MUST internalize

1. **`captureOutput()` intercepts `console.*` only — NOT `process.stdout.write`/`process.stderr.write`** (see `cli-output.ts` header). For coverage, a `process.*.write` line is covered when it *executes*; you do not need to capture it. Assert on `console.*` output, return values, fs state, or `process.exitCode` — never on `process.*.write` text via `captureOutput()`.
2. **`mock.module` is process-global and `build-lcov` runs `bun test --coverage` once per package** (`cli-mocks.ts` header). A new `mock.module` of a module that another test file depends on can poison that sibling. Of the 7 files, only `repl`/`serve`/`test` need a new module mock; they collide with `spawn-gateway.test.ts` / `node:child_process` / `node:readline/promises` consumers and so use the capture-real/restore-real pattern in Task 4. The verification step there runs the WHOLE package suite to prove no poisoning.
3. **Several target helpers are NOT exported** (`doctor.ts`'s `bunVersionOk`/`doctorPrintBunCheck`/`doctorRunGatewayRpcs`; `connector.ts`'s `runConnectorAuth` + 19 `apply*ConnectorAuth`). Acceptance 8 forbids source changes, so reach them through the exported dispatchers (`runDoctor`, `runConnector`) — never by adding an `export`.
4. **The connector `apply*` functions read `process.env` directly.** Error-path tests MUST clear the credential env vars or an ambient `NIMBUS_GITHUB_PAT` (etc.) turns a "missing flag" error case into a silent success.
5. **CI Linux is authoritative for watermarks. Never run `bun run audit:coverage-floor:update-baseline`.** All baseline edits are hand-made: the 3 exclusion removals in commit 1 (lcov-independent) and the 7 raised drops in commit 6 (gated on the CI-Linux artifact).
6. **Stage explicit paths.** Never `git add -A` / `git add .` — `.claude/settings.local.json` and other auto-modified files must not be committed.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/coverage-floor/exclusions.ts` | Modify | +3 `{ kind: "exact" }` entries (start, tui, gateway-process) |
| `sonar-project.properties` | Modify | Append the 3 paths to `sonar.coverage.exclusions` (line 65) |
| `docs/structure-audit/coverage-baseline.json` | Modify | −3 in commit 1, −7 (→ `{}`) in commit 6 |
| `packages/cli/src/commands/doctor.test.ts` | Extend | `runDoctor` 4-permutation dispatcher coverage |
| `packages/cli/src/commands/update.test.ts` | Extend | `runUpdate` dispatcher coverage |
| `packages/cli/src/commands/repl.test.ts` | Extend | `runRepl` loop via mocked `node:readline/promises` |
| `packages/cli/src/commands/serve.test.ts` | Extend | `runServe` spawn block via mocked `../lib/spawn-gateway.ts` |
| `packages/cli/src/commands/test.test.ts` | Extend | `runTest` spawn block via mocked `node:child_process` |
| `packages/cli/src/commands/extension-keygen-sign.test.ts` | Create | `runExtensionKeygen` + `runExtensionSign` via temp dirs |
| `packages/cli/src/commands/connector.test.ts` | Extend | `auth` machinery — 19 appliers via `test.each` + flag edges |
| `CLAUDE.md`, `GEMINI.md` | Modify | Coverage-floor status line (commit 6) |

---

## Task 1: Commit 1 — structural exclusions (Tier E)

**Files:**
- Modify: `scripts/coverage-floor/exclusions.ts` (after the `packages/cli/src/index.ts` entry, ~line 107)
- Modify: `sonar-project.properties:65`
- Modify: `docs/structure-audit/coverage-baseline.json`

- [ ] **Step 1: Add the 3 exact exclusion entries**

In `scripts/coverage-floor/exclusions.ts`, immediately after the `{ kind: "exact", path: "packages/cli/src/index.ts" },` entry (the CLI entry-point block), insert:

```typescript
  // CLI lifecycle/render entry shims (Phase 8 — coverage-floor closeout).
  // gateway-process.ts: intentional byte-for-byte duplicate of
  // gw-state-helpers.ts. The shared CLI harness `mock.module`s this exact
  // path, shadowing its body in nearly every command test; the identical
  // logic is fully branch-covered by gateway-process.test.ts against the
  // un-mocked twin. The two files must stay separate module records (ESM
  // re-export live-binding propagation defeats the mock isolation on
  // Linux/macOS).
  { kind: "exact", path: "packages/cli/src/lib/gateway-process.ts" },
  // start.ts: dominant uncovered region (spawnGateway detached subprocess +
  // waitForGatewayReady real-socket poll + 30-iteration onboarding IPCClient
  // loop) is structurally unrunnable in a single Ubuntu CI run. The pure
  // decision layer (decideStartAction, wantsNoWizard) is tested in
  // start.test.ts. Same rationale as the gateway/src/index.ts top-level
  // `await main()` exclusion.
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
  // tui.tsx: Ink render shim — inkRender(<App/>) + ink.waitUntilExit() +
  // signal handlers need a real TTY + raw-mode stdin. The dispatch branches
  // (--help, gateway-missing, fallback-to-REPL) are covered by tui.test.tsx;
  // the Ink surface is covered by the e2e suite. `.tsx` matches no existing
  // regex, so an exact entry is required.
  { kind: "exact", path: "packages/cli/src/commands/tui.tsx" },
```

- [ ] **Step 2: Append the 3 paths to the Sonar coverage exclusions**

In `sonar-project.properties`, the `sonar.coverage.exclusions=` value is a single comma-separated line (line 65). Append (no spaces, comma-separated) to the END of that value:

```
,packages/cli/src/commands/start.ts,packages/cli/src/commands/tui.tsx,packages/cli/src/lib/gateway-process.ts
```

The line must remain a single physical line (the parity parser fails closed on `\`-continuations). As of the current source, line 65 ends with `...embedding/load-feature-extraction-pipeline.ts` (no trailing comma), so the single leading comma above is correct — do **not** produce a double comma (`...,foo.ts,,packages/cli/...`), which would inject an empty pattern.

- [ ] **Step 3: Remove the 3 entries from the baseline**

In `docs/structure-audit/coverage-baseline.json`, delete the `packages/cli/src/commands/start.ts`, `packages/cli/src/commands/tui.tsx`, and `packages/cli/src/lib/gateway-process.ts` keys from `files`. Seven keys remain (`connector`, `doctor`, `extension`, `repl`, `serve`, `test`, `update`). Leave `version` and `generated_at` unchanged.

- [ ] **Step 4: Verify exclusion parity**

Run: `bun run audit:exclusion-parity`
Expected: exit 0, prints `check-exclusion-parity: ok (N sonar patterns all covered)` (N is the new total).

- [ ] **Step 5: Verify the floor gate still passes with 7 baselined files**

Run: `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor`
Expected: exit 0. The 3 newly-excluded files are skipped by `isExempt`; the 7 remaining files are each still ≥ their (unchanged) baseline watermark. (This step is lcov-dependent but watermark-safe — no watermark moved, so local Windows lcov cannot fail it.)

- [ ] **Step 6: Lint + commit**

```bash
bun run lint:fix
git add scripts/coverage-floor/exclusions.ts sonar-project.properties docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage-floor): exclude CLI entry/seam shims"
```

---

## Task 2: Commit 2 — doctor + update dispatchers (Tier D)

**Files:**
- Modify: `packages/cli/src/commands/doctor.test.ts` (append a `describe("runDoctor")` block; extend the import destructure)
- Modify: `packages/cli/src/commands/update.test.ts` (append a `describe("runUpdate dispatcher")` block; extend the import destructure)

### 2a — doctor

- [ ] **Step 1: Extend the doctor import + add fixture imports**

In `packages/cli/src/commands/doctor.test.ts`, change the destructure of `doctorMod` to also pull `runDoctor`, and add the fixture + mock-ipc imports below the existing `captureOutput` import:

```typescript
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
```

```typescript
const {
  doctorPrintConfigValidation,
  doctorPrintHealthFromSnapshot,
  doctorPrintIndexFromSnapshot,
  healthStateMark,
  runDoctor,
  worstHealthSeverity,
} = doctorMod;
```

- [ ] **Step 2: Append the `runDoctor` dispatcher describe block**

Append at the end of `doctor.test.ts` (before nothing — it is the last block):

```typescript
describe("runDoctor dispatcher (4 fixture permutations)", () => {
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    origExitCode = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = origExitCode;
    clearFixture();
  });

  it("no gateway state -> prints not-running and exits 2", async () => {
    setFixture({});
    await runDoctor([]);
    expect(out.stdout).toContain("[fail] Gateway: not running");
    expect(process.exitCode).toBe(2);
  });

  it("stale pid -> prints stale-state and exits 2", async () => {
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock", pid: 999999 },
      processAlive: false,
    });
    await runDoctor([]);
    expect(out.stdout).toContain("[fail] Gateway: stale state");
    expect(process.exitCode).toBe(2);
  });

  it("live gateway + IPC ok -> prints gateway/config/index/health lines", async () => {
    const mock = createMockIpcClient([
      { uptime: 5000 },
      { ok: true, errors: [], warnings: [] },
      { index: { totalItems: 10 }, connectorHealth: [{ connectorId: "github", state: "healthy" }] },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock", pid: 1 },
      processAlive: true,
      ipcClient: mock.client,
    });
    await runDoctor([]);
    expect(out.stdout).toContain("[ok] Gateway: IPC OK");
    expect(out.stdout).toContain("[ok] Config: valid.");
    expect(out.stdout).toContain("[ok] Index: 10 items.");
    expect(out.stdout).toContain("github: healthy");
    // exitCode is not asserted here: the Linux secret-tool vault branch can
    // legitimately set it to 2 on CI, which is orthogonal to this path.
  });

  it("live gateway + IPC throws -> prints IPC-failed and exits 2", async () => {
    const mock = createMockIpcClient([new Error("connection refused")]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock", pid: 1 },
      processAlive: true,
      ipcClient: mock.client,
    });
    await runDoctor([]);
    expect(out.stdout).toContain("[fail] Gateway: IPC failed");
    expect(process.exitCode).toBe(2);
  });
});
```

- [ ] **Step 3: Run the doctor test file (expect PASS)**

Run: `cd packages/cli && bun test src/commands/doctor.test.ts`
Expected: PASS, all tests green. (These are characterization tests over existing code; a failure means an assumption about `doctor.ts` is wrong — read the source and fix the test, not the source.)

- [ ] **Step 4: Confirm doctor.ts ≥80% locally**

Run: `cd packages/cli && bun test src/commands/doctor.test.ts --coverage --coverage-reporter=text 2>&1 | findstr doctor.ts`
Expected: the `doctor.ts` row shows ≥80% line coverage (CI Linux is authoritative; local is a directional check). The only expected residual is the Linux `secret-tool` arm in `doctorPrintVaultCheck` (~1–2 lines).

### 2b — update

- [ ] **Step 5: Extend the update import**

In `packages/cli/src/commands/update.test.ts`, add `runUpdate` to the destructure:

```typescript
const { parseUpdateArgs, runUpdate, runUpdateApply, runUpdateCheck } = mod;
```

- [ ] **Step 6: Append the `runUpdate` dispatcher describe block**

Append at the end of `update.test.ts`:

```typescript
describe("runUpdate dispatcher", () => {
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    out.reset();
    origExitCode = process.exitCode;
    process.exitCode = 0;
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
  });
  afterEach(() => {
    process.exitCode = origExitCode;
    clearFixture();
  });

  it("--check routes through withGatewayIpc to updater.checkNow", async () => {
    const mock = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false },
    ]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate(["--check"]);
    expect(mock.calls.map((c) => c.method)).toEqual(["updater.checkNow"]);
    expect(out.stdout).toContain("current: 0.1.0");
    expect(process.exitCode).toBe(0);
  });

  it("--yes applies without prompting", async () => {
    const mock = createMockIpcClient([null]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate(["--yes"]);
    expect(mock.calls.map((c) => c.method)).toEqual(["updater.applyUpdate"]);
    expect(out.stdout).toContain("Update applied. Gateway will restart.");
  });

  it("bare invocation with no update available prints No update available.", async () => {
    const mock = createMockIpcClient([
      { currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false },
    ]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate([]);
    expect(out.stdout).toContain("No update available.");
  });

  it("bare invocation with update available aborts under non-TTY stdin", async () => {
    // The interactive prompt at update.ts:85 (`process.stdout.write`) executes
    // here (so it is covered) but is NOT captured by captureOutput(); assert on
    // the console.log("Aborted.") line, not the prompt text. Under `bun test`
    // stdin is non-TTY, so readLine() returns "" and the abort path runs.
    const mock = createMockIpcClient([
      {
        currentVersion: "0.1.0",
        latestVersion: "0.1.1",
        updateAvailable: true,
        notes: "Bug fixes",
      },
    ]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runUpdate([]);
    expect(out.stdout).toContain("Aborted.");
  });
});
```

- [ ] **Step 7: Run the update test file (expect PASS)**

Run: `cd packages/cli && bun test src/commands/update.test.ts`
Expected: PASS.

- [ ] **Step 8: Confirm update.ts ≥80% locally**

Run: `cd packages/cli && bun test src/commands/update.test.ts --coverage --coverage-reporter=text 2>&1 | findstr update.ts`
Expected: `update.ts` ≥80%. Residual: the TTY-affirmative branch in `readLine` (`update.ts:105-112`).

- [ ] **Step 9: Lint + commit**

```bash
bun run lint:fix
git add packages/cli/src/commands/doctor.test.ts packages/cli/src/commands/update.test.ts
git commit -m "test(cli): cover doctor + update dispatchers"
```

---

## Task 3: Commit 3 — repl + serve + test command tails (Tier N, new module mocks)

These three files each need a NEW `mock.module` of a leaf dependency. Each leaf is consumed by a sibling test (`node:readline/promises`→repl only; `../lib/spawn-gateway.ts`→`spawn-gateway.test.ts`; `node:child_process`→`spawn-gateway.test.ts`, `config.ts`). To avoid poisoning siblings in the single-process coverage run, use the **capture-real-at-top-level → mock-at-run-time → restore-real-in-`afterEach`** pattern shown below, then verify the WHOLE package suite passes (Step 10).

**Files:**
- Modify: `packages/cli/src/commands/repl.test.ts`
- Modify: `packages/cli/src/commands/serve.test.ts`
- Modify: `packages/cli/src/commands/test.test.ts`

### 3a — repl (`runRepl` loop)

- [ ] **Step 1: Add `mock` + `runRepl` + a real-readline capture to repl.test.ts**

Change the `bun:test` import to include `mock`, add `runRepl` to the destructure, the fixture imports, and capture the real `node:readline/promises` at top-level (eval time, before any run-time mock):

```typescript
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
```

```typescript
const { loadReplPreconditions, parseReplArgs, runRepl, runReplTurn } = replMod;

// Captured at module-load so afterEach can restore the genuine module for any
// sibling test that imports node:readline/promises later in the same process.
const realReadline = await import("node:readline/promises");
```

- [ ] **Step 2: Append the `runRepl` describe block**

```typescript
describe("runRepl (readline loop, mocked node:readline/promises)", () => {
  afterEach(() => {
    // Restore the genuine module so no sibling test sees the stub.
    mock.module("node:readline/promises", () => realReadline);
    clearFixture();
  });

  it("prints the banner and exits the loop on `exit`", async () => {
    mock.module("node:readline/promises", () => ({
      ...realReadline,
      createInterface: () => ({
        question: async (): Promise<string> => "exit",
        close: (): void => {},
      }),
    }));
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await runRepl([]);
    // runRepl writes the banner via process.stdout.write (not captured); the
    // assertion that matters is that it returns without hanging.
    expect(true).toBe(true);
  });

  it("runs one turn then quits", async () => {
    let calls = 0;
    mock.module("node:readline/promises", () => ({
      ...realReadline,
      createInterface: () => ({
        question: async (): Promise<string> => {
          calls += 1;
          return calls === 1 ? "what is up" : "quit";
        },
        close: (): void => {},
      }),
    }));
    const mockIpc = createMockIpcClient([{ reply: "all good" }]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mockIpc.client });
    await runRepl([]);
    expect(mockIpc.calls[0]?.method).toBe("agent.invoke");
  });
});
```

- [ ] **Step 3: Run repl in isolation (expect PASS)**

Run: `cd packages/cli && bun test src/commands/repl.test.ts`
Expected: PASS. If either case hangs, the `createInterface` stub is wrong (it must return an object with async `question` + sync `close`).

### 3b — serve (`runServe` spawn block)

- [ ] **Step 4: Add `mock` + capture the real spawn-gateway module**

In `serve.test.ts`, add `mock` to the `bun:test` import, add `createMockIpcClient` is not needed here, and capture the real module at top-level:

```typescript
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
```

```typescript
const mod = await import("./serve.ts");
const { parseServeArgs, runServe, takeFlag } = mod;

// Captured at module-load; afterEach restores it so lib/spawn-gateway.test.ts
// (which imports the real spawnGateway) is never poisoned.
const realSpawnGateway = await import("../lib/spawn-gateway.ts");
```

- [ ] **Step 5: Append the spawn-path describe block**

```typescript
describe("runServe spawn path (mocked ../lib/spawn-gateway.ts)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    mock.module("../lib/spawn-gateway.ts", () => realSpawnGateway);
    clearFixture();
  });

  it("spawns + prints HTTP/socket/log lines when gateway is not running", async () => {
    mock.module("../lib/spawn-gateway.ts", () => ({
      ...realSpawnGateway,
      spawnGateway: async (): Promise<{ pid: number; logPath: string; logStartOffset: number }> => ({
        pid: 4242,
        logPath: "/tmp/nimbus-test.log",
        logStartOffset: 0,
      }),
    }));
    setFixture({}); // readGatewayState -> undefined => gateway not running
    await runServe(["--port", "7474"]);
    expect(out.stdout).toContain("HTTP:");
    expect(out.stdout).toContain("Socket:");
    expect(out.stdout).toContain("Log:");
  });

  it("sets process.exitCode = 1 when spawn rejects", async () => {
    const origExitCode = process.exitCode;
    process.exitCode = 0;
    mock.module("../lib/spawn-gateway.ts", () => ({
      ...realSpawnGateway,
      spawnGateway: async (): Promise<never> => {
        throw new Error("boom");
      },
    }));
    setFixture({});
    await runServe(["--port", "7474"]);
    expect(out.stderr).toContain("boom");
    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;
  });
});
```

- [ ] **Step 6: Run serve in isolation (expect PASS)**

Run: `cd packages/cli && bun test src/commands/serve.test.ts`
Expected: PASS.

### 3c — test (`runTest` spawn block)

- [ ] **Step 7: Add `mock` + capture the real node:child_process**

In `test.test.ts`, add `mock` to the `bun:test` import and capture the real module at top-level. Also add `EventEmitter` for the fake child:

```typescript
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
```

```typescript
const mod = await import("./test.ts");
const { MANIFEST, getTestScript, loadAndValidateManifest, parseTestArgs, runTest } = mod;

// Captured at module-load; afterEach restores it so spawn-gateway.test.ts /
// config.test.ts (real node:child_process consumers) are never poisoned.
const realChildProcess = await import("node:child_process");
```

- [ ] **Step 8: Append the spawn-path describe block**

The fake `spawn` returns an `EventEmitter` augmented with the child-process surface `test.ts` touches (`.on`). A valid full-shape manifest + a `package.json` with `scripts.test` is required so the dispatcher reaches the spawn:

```typescript
describe("runTest spawn path (mocked node:child_process)", () => {
  let tmpDir: string;

  const FULL_MANIFEST = {
    id: "com.test.extension",
    displayName: "test ext",
    version: "0.1.0",
    description: "Test extension for runTest spawn path",
    author: "tester",
    entrypoint: "dist/index.js",
    runtime: "bun" as const,
    permissions: ["read" as const],
    hitlRequired: [],
    minNimbusVersion: "0.1.0",
  };

  beforeEach(() => {
    out.reset();
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-test-spawn-"));
    writeFileSync(join(tmpDir, MANIFEST), JSON.stringify(FULL_MANIFEST), "utf8");
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
  });
  afterEach(() => {
    mock.module("node:child_process", () => realChildProcess);
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function mockSpawnEmitting(event: "close" | "error", arg: number | Error): void {
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      spawn: (): EventEmitter => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit(event, arg));
        return child;
      },
    }));
  }

  it("resolves + prints OK when the test subprocess exits 0", async () => {
    mockSpawnEmitting("close", 0);
    await runTest([tmpDir]);
    expect(out.stdout).toContain("Extension contract OK");
  });

  it("rejects when the test subprocess exits non-zero", async () => {
    mockSpawnEmitting("close", 1);
    await expect(runTest([tmpDir])).rejects.toThrow(/exited with code 1/);
  });

  it("rejects when the test subprocess errors", async () => {
    mockSpawnEmitting("error", new Error("spawn failed"));
    await expect(runTest([tmpDir])).rejects.toThrow(/spawn failed/);
  });
});
```

- [ ] **Step 9: Run test.test.ts in isolation (expect PASS)**

Run: `cd packages/cli && bun test src/commands/test.test.ts`
Expected: PASS.

- [ ] **Step 10: Verify no sibling poisoning — run the WHOLE CLI package suite**

This is the load-bearing safety check for the three new module mocks. Run the entire CLI source suite in one process (the same shape as `build-lcov`):

Run: `cd packages/cli && bun test src/`
Expected: PASS — in particular `src/lib/spawn-gateway.test.ts`, `src/lib/gateway-process.test.ts`, and `src/commands/config.test.ts` must all be green. A failure in any of those means a mock leaked past its `afterEach` restore; re-check that every `mock.module(... realX)` restore is present and that the real module was captured at top-level.

> Execution model: `bun test` runs test *files* serially in a single process by default — `bun test src/` therefore reproduces the exact `build-lcov` leak vector. (Bun has no `--workers` flag; that is Jest/Vitest terminology.) The one thing that would break the capture-real/restore-real pattern is concurrency *within* the process, so **never** pass `--concurrent` to the CLI suite — `cli-mocks.ts` mandates this ("Serial-within-process is assumed. Never invoke `bun test --concurrent`"). If you see flakiness here, confirm no `--concurrent` slipped into the invocation rather than reaching for a worker flag.

- [ ] **Step 11: Confirm the three files ≥80% locally**

Run: `cd packages/cli && bun test src/commands/repl.test.ts src/commands/serve.test.ts src/commands/test.test.ts --coverage --coverage-reporter=text 2>&1 | findstr "repl.ts serve.ts test.ts"`
Expected: each of `repl.ts`, `serve.ts`, `test.ts` ≥80%.

- [ ] **Step 12: Lint + commit**

```bash
bun run lint:fix
git add packages/cli/src/commands/repl.test.ts packages/cli/src/commands/serve.test.ts packages/cli/src/commands/test.test.ts
git commit -m "test(cli): cover repl + serve + test command tails"
```

---

## Task 4: Commit 4 — extension keygen + sign (Tier N, new file, fs-only)

**Files:**
- Create: `packages/cli/src/commands/extension-keygen-sign.test.ts`

`runExtensionKeygen` and `runExtensionSign` return a numeric exit code and touch only `node:fs` + SDK crypto. They write via `process.*.write` (not captured) — assert on the **return code** and **fs state**, never on captured stdout. The sign happy-path key is generated via the file's own `runExtensionKeygen` so it is a real 32-byte Ed25519 key.

- [ ] **Step 1: Write the new test file**

```typescript
// packages/cli/src/commands/extension-keygen-sign.test.ts
//
// Covers runExtensionKeygen + runExtensionSign — both touch only node:fs +
// SDK crypto and return a numeric exit code. We assert on exit codes + fs
// state (process.*.write output is intentionally not captured).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only

const mod = await import("./extension.ts");
const { runExtensionKeygen, runExtensionSign } = mod;

describe("runExtensionKeygen", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("writes the private key to --out and returns 0", async () => {
    const out = join(tmpDir, "publisher-key");
    const code = await runExtensionKeygen(["--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("refuses to overwrite an existing key without --force (exit 2)", async () => {
    const out = join(tmpDir, "publisher-key");
    writeFileSync(out, "existing\n", "utf8");
    const code = await runExtensionKeygen(["--out", out]);
    expect(code).toBe(2);
    expect(readFileSync(out, "utf8")).toBe("existing\n");
  });

  it("overwrites with --force and returns 0", async () => {
    const out = join(tmpDir, "publisher-key");
    writeFileSync(out, "existing\n", "utf8");
    const code = await runExtensionKeygen(["--out", out, "--force"]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).not.toBe("existing\n");
  });
});

describe("runExtensionSign", () => {
  let tmpDir: string;
  let keyPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-"));
    keyPath = join(tmpDir, "publisher-key");
    await runExtensionKeygen(["--out", keyPath]); // real 32-byte key
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("returns 2 when ext dir is missing", async () => {
    expect(await runExtensionSign([])).toBe(2);
  });

  it("returns 2 when first arg is a flag", async () => {
    expect(await runExtensionSign(["--key", keyPath])).toBe(2);
  });

  it("returns 2 when the key file is unreadable", async () => {
    expect(await runExtensionSign([tmpDir, "--key", join(tmpDir, "no-such-key")])).toBe(2);
  });

  it("returns 2 when the key file is not 32 bytes", async () => {
    const shortKey = join(tmpDir, "short-key");
    writeFileSync(shortKey, Buffer.from("too-short").toString("base64"), "utf8");
    expect(await runExtensionSign([tmpDir, "--key", shortKey])).toBe(2);
  });

  it("returns 2 when the manifest is unreadable", async () => {
    // tmpDir has the key but no nimbus.extension.json
    expect(await runExtensionSign([tmpDir, "--key", keyPath])).toBe(2);
  });

  it("signs the manifest and returns 0 (writes a signature field)", async () => {
    const manifestPath = join(tmpDir, "nimbus.extension.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ id: "com.example.ext", version: "0.1.0", permissions: [] }),
      "utf8",
    );
    const code = await runExtensionSign([tmpDir, "--key", keyPath]);
    expect(code).toBe(0);
    const signed = JSON.parse(readFileSync(manifestPath, "utf8")) as { signature?: unknown };
    expect(typeof signed.signature).toBe("string");
  });
});
```

- [ ] **Step 2: Run the new file (expect PASS)**

Run: `cd packages/cli && bun test src/commands/extension-keygen-sign.test.ts`
Expected: PASS, 9 tests green.

- [ ] **Step 3: Confirm extension.ts ≥80% locally**

Run: `cd packages/cli && bun test src/commands/extension.test.ts src/commands/extension-keygen-sign.test.ts --coverage --coverage-reporter=text 2>&1 | findstr extension.ts`
Expected: `extension.ts` ≥80% (the keygen/sign block `397-471` was the ~75-line 0% region).

- [ ] **Step 4: Lint + commit**

```bash
bun run lint:fix
git add packages/cli/src/commands/extension-keygen-sign.test.ts
git commit -m "test(cli): cover extension keygen + sign"
```

---

## Task 5: Commit 5 — connector auth machinery (Tier B)

**Files:**
- Modify: `packages/cli/src/commands/connector.test.ts` (append; the file already imports the harness + `runConnector` + `createMockIpcClient` + `setFixture`/`clearFixture` + `captureOutput`)

The `auth` machinery (`connector.ts:258-928`, >half the file) is reached via `runConnector(["auth", <service>, ...flags])`. All 19 service ids are in `vaultPatServices`, so every success prints the same two lines (`Signed in: <id>` + `Credential: stored in the OS vault (no OAuth scopes).`). Success cases need a fixture with a queued `connector.auth` response; error cases throw inside the applier **before** `withIpc`, so they need no fixture — but the credential env vars MUST be cleared (the appliers read `process.env`). Author the 19 success + 19 error pairs as `test.each` over a **mutable** array (bun:test rejects `readonly`); keep the help/flag edges as bespoke `it()` blocks.

> The 19 `AUTH_ERR_ROWS` regexes below were verified against `connector.ts` at plan-authoring time — each substring matches the exact thrown string, and each applier invoked with no flags + env cleared reaches *that* error (e.g. `discord`/`iac` check the opt-in `--enable` before the token; `jira`/`confluence` hit the `errEmail` branch first; `aws` with no keys + no profile falls to the `--aws-profile only` else-branch). If a regex fails to match on first run, the source error string has drifted (carry-forward #5) — update the regex, never the source.

- [ ] **Step 1: Add `mock` is not needed; add the env-scrub list + success/error tables**

Append to `connector.test.ts`:

```typescript
// The apply* helpers read process.env directly; clear every credential key so
// an ambient value can't turn a "missing flag" error case into a success.
const AUTH_ENV_KEYS: string[] = [
  "NIMBUS_LINEAR_API_KEY",
  "NIMBUS_GITHUB_PAT",
  "NIMBUS_CIRCLECI_API_TOKEN",
  "CIRCLECI_TOKEN",
  "NIMBUS_PAGERDUTY_API_TOKEN",
  "PAGERDUTY_API_TOKEN",
  "NIMBUS_KUBECONFIG",
  "KUBECONFIG",
  "NIMBUS_AWS_ACCESS_KEY_ID",
  "AWS_ACCESS_KEY_ID",
  "NIMBUS_AWS_SECRET_ACCESS_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "NIMBUS_AWS_DEFAULT_REGION",
  "AWS_DEFAULT_REGION",
  "NIMBUS_AWS_PROFILE",
  "AWS_PROFILE",
  "NIMBUS_AZURE_TENANT_ID",
  "AZURE_TENANT_ID",
  "NIMBUS_AZURE_CLIENT_ID",
  "AZURE_CLIENT_ID",
  "NIMBUS_AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_SECRET",
  "NIMBUS_GCP_CREDENTIALS_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "NIMBUS_GCP_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "NIMBUS_GRAFANA_URL",
  "GRAFANA_URL",
  "NIMBUS_GRAFANA_API_TOKEN",
  "GRAFANA_API_TOKEN",
  "NIMBUS_SENTRY_AUTH_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "NIMBUS_SENTRY_ORG",
  "SENTRY_ORG",
  "NIMBUS_SENTRY_URL",
  "NIMBUS_NEW_RELIC_API_KEY",
  "NEW_RELIC_API_KEY",
  "NIMBUS_NEW_RELIC_ACCOUNT_ID",
  "NIMBUS_DATADOG_API_KEY",
  "DD_API_KEY",
  "NIMBUS_DATADOG_APP_KEY",
  "DD_APP_KEY",
  "NIMBUS_DATADOG_SITE",
  "DD_SITE",
  "NIMBUS_GITLAB_PAT",
  "NIMBUS_BITBUCKET_USERNAME",
  "BITBUCKET_USERNAME",
  "NIMBUS_BITBUCKET_APP_PASSWORD",
  "NIMBUS_DISCORD_BOT_TOKEN",
  "NIMBUS_JIRA_EMAIL",
  "ATLASSIAN_EMAIL",
  "NIMBUS_JIRA_API_TOKEN",
  "NIMBUS_JIRA_BASE_URL",
  "JIRA_BASE_URL",
  "NIMBUS_CONFLUENCE_EMAIL",
  "NIMBUS_CONFLUENCE_API_TOKEN",
  "NIMBUS_CONFLUENCE_BASE_URL",
  "CONFLUENCE_BASE_URL",
  "NIMBUS_JENKINS_USERNAME",
  "JENKINS_USERNAME",
  "NIMBUS_JENKINS_API_TOKEN",
  "JENKINS_API_TOKEN",
  "NIMBUS_JENKINS_BASE_URL",
  "JENKINS_BASE_URL",
];

type AuthOkRow = { service: string; flags: string[] };
const AUTH_OK_ROWS: AuthOkRow[] = [
  { service: "linear", flags: ["--token", "k"] },
  { service: "github", flags: ["--token", "ghp_x"] },
  { service: "circleci", flags: ["--token", "k"] },
  { service: "pagerduty", flags: ["--token", "k"] },
  { service: "kubernetes", flags: ["--kubeconfig", "/tmp/kube"] },
  { service: "aws", flags: ["--aws-access-key", "AKIA", "--aws-secret-key", "sk", "--aws-region", "us-east-1"] },
  { service: "azure", flags: ["--azure-tenant-id", "t", "--azure-client-id", "c", "--azure-client-secret", "s"] },
  { service: "gcp", flags: ["--gcp-credentials-json", "/tmp/gcp.json"] },
  { service: "iac", flags: ["--enable"] },
  { service: "grafana", flags: ["--api-base", "https://g.example", "--token", "k"] },
  { service: "sentry", flags: ["--token", "k", "--sentry-org", "org"] },
  { service: "newrelic", flags: ["--token", "k"] },
  { service: "datadog", flags: ["--datadog-api-key", "a", "--datadog-app-key", "b"] },
  { service: "gitlab", flags: ["--token", "glpat"] },
  { service: "bitbucket", flags: ["--username", "u", "--token", "app"] },
  { service: "discord", flags: ["--token", "bot", "--enable"] },
  { service: "jira", flags: ["--username", "e@x.com", "--token", "k", "--api-base", "https://x.atlassian.net"] },
  { service: "confluence", flags: ["--username", "e@x.com", "--token", "k", "--api-base", "https://x.atlassian.net"] },
  { service: "jenkins", flags: ["--username", "u", "--token", "k", "--api-base", "https://ci.example"] },
];

type AuthErrRow = { service: string; match: RegExp };
const AUTH_ERR_ROWS: AuthErrRow[] = [
  { service: "linear", match: /Linear requires an API key/ },
  { service: "github", match: /GitHub requires a PAT/ },
  { service: "circleci", match: /CircleCI requires an API token/ },
  { service: "pagerduty", match: /PagerDuty requires an API token/ },
  { service: "kubernetes", match: /Kubernetes requires --kubeconfig/ },
  { service: "aws", match: /AWS: use --aws-access-key/ },
  { service: "azure", match: /Azure requires tenant id/ },
  { service: "gcp", match: /GCP requires --gcp-credentials-json/ },
  { service: "iac", match: /IaC connector is opt-in/ },
  { service: "grafana", match: /Grafana requires base URL/ },
  { service: "sentry", match: /Sentry requires --token/ },
  { service: "newrelic", match: /New Relic requires --token/ },
  { service: "datadog", match: /Datadog requires --datadog-api-key/ },
  { service: "gitlab", match: /GitLab requires a PAT/ },
  { service: "bitbucket", match: /Bitbucket requires username/ },
  { service: "discord", match: /Discord is off by default/ },
  { service: "jira", match: /Jira requires your Atlassian account email/ },
  { service: "confluence", match: /Confluence requires your Atlassian account email/ },
  { service: "jenkins", match: /Jenkins requires --username/ },
];
```

- [ ] **Step 2: Append the `test.each` success + error blocks + flag edges**

```typescript
describe("runConnector auth — per-applier success", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it.each(AUTH_OK_ROWS)("auth $service succeeds and stores in vault", async ({ service, flags }) => {
    const mock = createMockIpcClient([{ ok: true, serviceId: service, scopesGranted: [] }]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runConnector(["auth", service, ...flags]);
    expect(mock.calls[0]?.method).toBe("connector.auth");
    expect(out.stdout).toContain(`Signed in: ${service}`);
    expect(out.stdout).toContain("Credential: stored in the OS vault (no OAuth scopes).");
  });
});

describe("runConnector auth — per-applier primary error (env cleared)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    out.reset();
    savedEnv = { ...process.env };
    for (const k of AUTH_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    clearFixture();
  });

  it.each(AUTH_ERR_ROWS)("auth $service throws before IPC when required input is missing", async ({ service, match }) => {
    await expect(runConnector(["auth", service])).rejects.toThrow(match);
  });
});

describe("runConnector auth — help + flag edges", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("auth --help with no service prints the pointer", async () => {
    await runConnector(["auth", "--help"]);
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it.each([["google_drive"], ["onedrive"], ["slack"], ["notion"]])(
    "auth %s --help prints OAuth setup help",
    async (service) => {
      await runConnector(["auth", service, "--help"]);
      expect(out.stdout.length).toBeGreaterThan(0);
    },
  );

  it("auth with no service argument throws usage", async () => {
    await expect(runConnector(["auth"])).rejects.toThrow(/Usage: nimbus connector auth/);
  });

  it("rejects an invalid --port", async () => {
    await expect(runConnector(["auth", "github", "--port", "abc", "--token", "k"])).rejects.toThrow(
      /Invalid --port/,
    );
  });

  it("passes --port + --scopes through to the auth params", async () => {
    const mock = createMockIpcClient([{ ok: true, serviceId: "github", scopesGranted: [] }]);
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
    await runConnector(["auth", "github", "--token", "k", "--port", "9000", "--scopes", "a,b"]);
    const params = mock.calls[0]?.params as Record<string, unknown>;
    expect(params["port"]).toBe(9000);
    expect(params["scopes"]).toEqual(["a", "b"]);
  });

  it("covers the env-fallback path (firstEnvTrimmed) for github", async () => {
    const savedEnv = { ...process.env };
    for (const k of AUTH_ENV_KEYS) delete process.env[k];
    process.env["NIMBUS_GITHUB_PAT"] = "ghp_from_env";
    try {
      const mock = createMockIpcClient([{ ok: true, serviceId: "github", scopesGranted: [] }]);
      setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" }, ipcClient: mock.client });
      await runConnector(["auth", "github"]); // no --token => env fallback
      expect(out.stdout).toContain("Signed in: github");
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, savedEnv);
    }
  });
});
```

- [ ] **Step 3: Run the connector file (expect PASS)**

Run: `cd packages/cli && bun test src/commands/connector.test.ts`
Expected: PASS — 19 success + 19 error + ~9 edge cases green. If a success case throws "response queue exhausted", that applier issued more than one IPC call (it should not) — read the applier and adjust. If an error case unexpectedly succeeds, an env var leaked — confirm the key is in `AUTH_ENV_KEYS`.

- [ ] **Step 4: Confirm connector.ts ≥80% locally**

Run: `cd packages/cli && bun test src/commands/connector.test.ts --coverage --coverage-reporter=text 2>&1 | findstr connector.ts`
Expected: `connector.ts` clears 80% with margin (the `auth` machinery is >half the file and was near-zero before this pass). If short, add the remaining env-fallback branch per applier (each `apply*` has one) — all reachable through the same fixture; no source change.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/cli/src/commands/connector.test.ts
git commit -m "test(cli): cover connector auth machinery"
```

---

## Task 6: Commit 6 — empty the baseline + closeout (CI-Linux gated)

**Files:**
- Modify: `docs/structure-audit/coverage-baseline.json` (→ empty `files: {}`)
- Modify: `CLAUDE.md`, `GEMINI.md` (coverage-floor status line)

This is the only commit gated on CI-Linux measurement. Do NOT hand-edit the baseline from local Windows lcov.

- [ ] **Step 1: Push the branch and let CI run**

```bash
git push -u origin dev/asafgolombek/coverage-floor-phase-8-2026-05-26
```

Wait for the push CI matrix to complete. (You may open the PR now; commits 1–5 are already pushed.)

- [ ] **Step 2: Download the CI-Linux merged lcov artifact**

```bash
gh run list --branch dev/asafgolombek/coverage-floor-phase-8-2026-05-26 --limit 1
gh run download <run-id> --name coverage-lcov-merged --dir coverage-ci
```

- [ ] **Step 3: Confirm each of the 7 raised files is ≥80% on CI Linux**

Inspect `coverage-ci/lcov.info` for the 7 files (`connector.ts`, `doctor.ts`, `extension.ts`, `repl.ts`, `serve.ts`, `test.ts`, `update.ts`). Each must show ≥80% line coverage on the CI-Linux run. **Do not drop a file the CI-Linux run shows <80%** — if one is short, hold it at a raised watermark (Acceptance 9) and document the residual in the implementer report; the baseline then stays non-empty for that one file only.

- [ ] **Step 4: Empty the baseline**

Edit `docs/structure-audit/coverage-baseline.json` so `files` is `{}` (assuming all 7 cleared 80% on CI Linux):

```json
{
  "version": 1,
  "generated_at": "2026-05-26T00:00:00.000Z",
  "files": {}
}
```

(Use the actual current UTC timestamp for `generated_at`.)

- [ ] **Step 5: Update the coverage-floor status line in CLAUDE.md + GEMINI.md**

Locate the coverage-floor status line in each file and set it to:

```
Phase 8 ✅ — CLI deep cuts + closeout (baseline 10 → 0; floor fully ratcheted)
```

Keep any other status rows intact (merge, don't replace, if `main` moved).

- [ ] **Step 6: Verify the floor gate reports 0 baselined files**

Run: `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor`
Expected: exit 0 and "0 baselined files" (CI Linux remains authoritative for the merge gate, but the local run must not regress any now-unbaselined file below 80% on your machine; if a vault/secret-tool OS-branch dips a file locally, that is the documented CI-Linux-authoritative divergence — confirm against the artifact, not local).

- [ ] **Step 7: Full preflight**

Run: `bun run preflight:fast`
Expected: exit 0 (typecheck, Biome, exclusion-parity, invariants, openapi-drift, and the other cheap static gates). Then optionally `bun run preflight` for full parity before the final push.

- [ ] **Step 8: Commit + push**

```bash
bun run lint:fix
git add docs/structure-audit/coverage-baseline.json CLAUDE.md GEMINI.md
git commit -m "chore(coverage-floor): empty baseline + Phase 8 closeout"
git push
```

---

## Final Acceptance (maps to spec §"Acceptance")

- [ ] `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` exits 0 with 0 baselined files (CI Linux authoritative).
- [ ] `bun run audit:exclusion-parity` exits 0 (3 new entries agree across `sonar-project.properties` + `exclusions.ts`).
- [ ] `bun run audit:invariants` exits 0 (unchanged).
- [ ] `bun run lint` + `bun run typecheck` exit 0.
- [ ] `coverage-baseline.json` has `files: {}`.
- [ ] The 7 raised files are each ≥80% on CI Linux; the 3 excluded files match `isExempt`.
- [ ] No previously-≥80% file drops below 80% (floor gate).
- [ ] `git diff --stat main...HEAD` shows only `*.test.ts(x)` + the commit-1/6 config/doc files — zero source changes to the 7 test-only files.
- [ ] Whole-package suite (`cd packages/cli && bun test src/`) is green — no `mock.module` sibling poisoning.

---

## Self-Review (against the spec)

**Spec coverage:** Tier E (3 exclusions) → Task 1. Tier D (doctor, update) → Task 2. Tier N (repl, serve, test, extension) → Tasks 3 + 4. Tier B (connector) → Task 5. Commit structure (6 commits) → Tasks 1–6. Carry-forwards #1–#6 → embedded in Tasks 3 (mock isolation + whole-package verify), 5 (env scrub), 6 (CI-Linux gating, never `update-baseline`, explicit staging). External-review dispositions R1 (rmSync retries), R2 (`test.each` table), R5 (no stdout-prompt assertion) → Tasks 4, 5, 2 respectively.

**Divergences from the spec wording (intentional, documented above):**
1. **doctor** is driven entirely through `runDoctor([])` (4 fixture permutations), NOT by export-calling `bunVersionOk`/`doctorPrintBunCheck`/`doctorRunGatewayRpcs` — those are not exported and exporting them would violate Acceptance 8 (zero source changes). Same end coverage, no source change.
2. The spec's carry-forward #1 claim that the leaf mocks "don't collide with a module other tests depend on" is **not fully accurate**: `../lib/spawn-gateway.ts` is imported by `spawn-gateway.test.ts`, and `node:child_process` by `spawn-gateway.test.ts`/`config.ts`. Task 3 therefore uses the capture-real/restore-real pattern + a mandatory whole-package verification (Step 10) rather than relying on `afterAll` restore alone.

**Type consistency:** Fixture shape (`{ gatewayState, processAlive, ipcClient }`) and `createMockIpcClient([...]).client` / `.calls` usage match `cli-mocks.ts` + `mock-ipc-client.ts`. `runDoctor`/`runUpdate`/`runRepl`/`runServe`/`runTest`/`runConnector`/`runExtensionKeygen`/`runExtensionSign` signatures match the read sources. `test.each` tables are mutable `T[]` (not `readonly`) per the Phase-4 carry-forward.

### External plan-review dispositions (2026-05-26)

From [`2026-05-26-coverage-floor-phase-8-review.md`](./2026-05-26-coverage-floor-phase-8-review.md).

- **R1 (verify connector error regexes) — FIXED.** All 19 `AUTH_ERR_ROWS` regexes were checked against `connector.ts` (substring + control-flow). Added a verification note in Task 5 so the implementer treats a mismatch as source drift, not a regex guess.
- **R2 (Sonar trailing-comma guard) — FIXED.** Confirmed line 65 currently ends with `...load-feature-extraction-pipeline.ts` (no trailing comma); added a double-comma guard note to Task 1 Step 2.
- **R3 (`--workers 1` to match CI) — DEFERRED with clarification.** `bun test` has no `--workers` flag and runs files serially in one process by default, so `bun test src/` already reproduces the leak vector. The real control is avoiding `--concurrent` (mandated by `cli-mocks.ts`). Added a clarifying note to Task 3 Step 10 rather than the inapplicable flag.
- **R4 (doctor zero-source-change divergence) — praise, no action.**
