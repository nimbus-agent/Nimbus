# `nimbus demo` PR 1 — Isolated Demo Root + Invariant I41 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `NIMBUS_DEMO=1` / `nimbus --demo …` runs the CLI and gateway against a separate, isolated root that can neither read nor damage the owner's real install — proven by invariant I41 — so PR 2 can seed a synthetic org into it.

**Architecture:** One env var, read by BOTH mirrored path modules (gateway `platform/paths.ts`, CLI `paths.ts`), relocates every path into `<realDataDir>/demo` and marks the result `demo: true`. Everything else that is host-global rather than path-derived branches on `paths.demo`: the vault factory returns an in-process `EphemeralVault`, and the gateway skips the Windows AppContainer boot reap and the env-selected HTTP/metrics sidecars. The CLI strips a global `--demo` flag and sets the env var before anything resolves a path.

**Tech Stack:** Bun 1.3, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-18-nimbus-demo-design.md` — read § 3, § 6 (PR 1), § 9 and **§ 10** (plan-time corrections: vault, reap, sidecars, macOS subtree rule, hashed Windows pipe). This plan covers **PR 1 only**; PR 2 (corpus, `demo.seed`, tour) gets its own plan after this lands.

## Global Constraints

- Branch `dev/asafgolombek/nimbus-demo`, worktree `C:\gitrep\Nimbus\.claude\worktrees\nimbus-demo`. Run `git rev-parse --abbrev-ref HEAD` before EVERY commit; it must print `dev/asafgolombek/nimbus-demo`.
- Commit with `git commit -F <file>` when a message contains backticks (the shell eats them with `-m`).
- No `any`; external data is `unknown`. TypeScript strict. `exactOptionalPropertyTypes` is on.
- `gateway` imports nothing from `cli`; `cli` imports nothing from `gateway`. Only `scripts/` may import both.
- Build paths with `path.join`, never hardcoded separators.
- `NIMBUS_DEMO` parsing: unset / `""` / `"0"` → off; `"1"` → on; anything else REFUSES with a message containing `NIMBUS_DEMO must be 1 or unset`.
- `NIMBUS_DEMO=1` together with a NON-EMPTY `NIMBUS_CONFIG_DIR` or `NIMBUS_GATEWAY_SOCKET` REFUSES with a message naming the conflicting variable. (Empty values are ignored — the existing override semantics.)
- Demo paths: root `<realDataDir>/demo`; `configDir` = `<root>/config`; `dataDir` = `<root>/data`; `logDir` = `<root>/data/logs`; `extensionsDir` = `<root>/data/extensions`; `tempDir` = `join(tmpdir(), "nimbus-demo")`; socket = `<dirname(realSocket)>/nimbus-gateway-demo.sock` on macOS/Linux, `<realPipe>-demo-<first 12 hex of sha256(root)>` on Windows.
- **Test data NEVER touches real state.** Every test that resolves paths sets `APPDATA`/`LOCALAPPDATA`/`HOME`/`USERPROFILE`/`XDG_*`/`TMPDIR`/`TEMP`/`TMP` to temp dirs, and every subprocess test verifies that premise before booting anything. Never run the demo against the developer's real `%LOCALAPPDATA%`, `~/Library/Application Support/Nimbus` or `~/.local/share/nimbus`.
- A fresh worktree needs the sandbox helper built before the full suite: `bun run build:sandbox-helper:win32` (Windows) or `bun run build:sandbox-helper` (POSIX).
- Nothing in any doc may claim demo isolation before Task 5 (the I41 enforcement test) is committed.
- **Expected `audit:doc-refs` noise until the end:** this plan names files that later tasks create, so `audit:doc-refs` (and therefore `preflight:fast`) reports `broken doc reference … file does not exist` for references IN THIS PLAN FILE until those tasks land; Task 7 then removes `docs/superpowers/` before anything is pushed. Do NOT add `docs/superpowers/` to `DOCS_EXCLUDED_PREFIXES` to silence it. Any doc-refs error in a file OTHER than this plan is real and must be fixed.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/gateway/src/platform/demo-root.ts` | create | Parse `NIMBUS_DEMO`; derive demo paths from real ones (gateway side) |
| `packages/gateway/src/platform/demo-root.test.ts` | create | Unit tests for the above |
| `packages/gateway/src/platform/paths.ts` | modify | `PlatformPaths.demo?: true`; each `create*Paths` applies the demo derivation |
| `packages/gateway/src/platform/paths.test.ts` | modify | Resolver-level demo cases |
| `packages/cli/src/lib/demo-root.ts` | create | Byte-for-byte mirror of the gateway derivation over `CliPlatformPaths` |
| `packages/cli/src/lib/demo-root.test.ts` | create | Unit tests for the mirror |
| `packages/cli/src/paths.ts` | modify | `CliPlatformPaths.demo?: true`; `getCliPlatformPaths` applies the derivation |
| `scripts/parity/demo-root.parity.test.ts` | create | Proves the two mirrors resolve identical demo paths and verdicts |
| `packages/cli/src/lib/demo-flag.ts` | create | Strip global `--demo`, set `NIMBUS_DEMO=1` |
| `packages/cli/src/lib/demo-flag.test.ts` | create | Unit tests |
| `packages/cli/src/index.ts` | modify | Apply the flag before any path resolution; surface refusals cleanly |
| `packages/cli/src/lib/with-gateway-ipc.ts` | modify | Demo-aware "not running" hint |
| `packages/cli/test/e2e/demo-flag.e2e.test.ts` | create | Real CLI subprocess: log placement, argv stripping, refusals, hint |
| `packages/gateway/src/vault/ephemeral.ts` | create | In-process, never-persisted `NimbusVault` |
| `packages/gateway/src/vault/ephemeral.test.ts` | create | Unit tests |
| `packages/gateway/src/vault/mock.ts` | modify | `MockVault extends EphemeralVault` (no duplicate map logic) |
| `packages/gateway/src/vault/factory.ts` | modify | Demo paths → `EphemeralVault`, before the OS switch |
| `packages/gateway/src/vault/factory.test.ts` | modify | Demo case (self-validating under the mocked `freebsd` platform) |
| `packages/gateway/src/platform/demo-boot.ts` | create | Pure boot policy: reap + env sidecars on/off |
| `packages/gateway/src/platform/demo-boot.test.ts` | create | Unit tests |
| `packages/gateway/src/platform/assemble.ts` | modify | Guard the reap call and the sidecar call with the policy |
| `packages/gateway/src/security-invariants.test.ts` | modify | New `describe("I41 — …")` block |
| `docs/SECURITY-INVARIANTS.md` | modify | New `## I41` section + ceiling line |
| `CLAUDE.md`, `GEMINI.md` + every surface `audit:status-drift` flags | modify | I41 bullet; ceiling `I40` → `I41` |
| `packages/gateway/test/e2e/demo-root-isolation.e2e.test.ts` | create | Real gateway entry booted with `NIMBUS_DEMO=1` on temp roots |
| `docs/cli-reference.md`, `docs/architecture.md`, `docs/CHANGELOG.md` | modify | User-facing docs, the data-dir-relocation correction, the dated entry |

---

### Task 1: Gateway demo-root derivation

**Files:**
- Create: `packages/gateway/src/platform/demo-root.ts`
- Create: `packages/gateway/src/platform/demo-root.test.ts`
- Modify: `packages/gateway/src/platform/paths.ts` (interface at lines 6–13; `createWindowsPaths` 53–76; `createDarwinPaths` 78–90; `createLinuxPaths` 92–107)
- Modify: `packages/gateway/src/platform/paths.test.ts` (`TRACKED_ENV_KEYS` at lines 11–19; append a new `describe`)

**Interfaces:**
- Produces (used by Tasks 4, 5, 6):
  - `export type EnvReader = (name: string) => string | undefined;`
  - `export function demoModeRequested(get: EnvReader): boolean` — throws `PlatformInitError`
  - `export function demoRootFor(realDataDir: string): string`
  - `export function demoSocketPathFor(realSocketPath: string, demoRoot: string): string`
  - `export function deriveDemoPaths(real: PlatformPaths): PlatformPaths` — result has `demo: true`
  - `export const DEMO_ENV = "NIMBUS_DEMO"`, `DEMO_DIRNAME = "demo"`, `DEMO_TEMP_DIRNAME = "nimbus-demo"`
  - `PlatformPaths` gains `demo?: true`

- [ ] **Step 1: Write the failing unit tests**

Create `packages/gateway/src/platform/demo-root.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEMO_TEMP_DIRNAME,
  demoModeRequested,
  demoRootFor,
  demoSocketPathFor,
  deriveDemoPaths,
} from "./demo-root.ts";
import { PlatformInitError } from "./errors.ts";
import type { PlatformPaths } from "./paths.ts";

function env(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name];
}

describe("demoModeRequested", () => {
  test.each([
    ["unset", {}],
    ["empty", { NIMBUS_DEMO: "" }],
    ["zero", { NIMBUS_DEMO: "0" }],
  ])("%s means off", (_label, map) => {
    expect(demoModeRequested(env(map))).toBe(false);
  });

  test('"1" means on', () => {
    expect(demoModeRequested(env({ NIMBUS_DEMO: "1" }))).toBe(true);
  });

  test.each(["true", "yes", "2", " 1"])('refuses the ambiguous value "%s"', (v) => {
    expect(() => demoModeRequested(env({ NIMBUS_DEMO: v }))).toThrow(PlatformInitError);
    expect(() => demoModeRequested(env({ NIMBUS_DEMO: v }))).toThrow(
      "NIMBUS_DEMO must be 1 or unset",
    );
  });

  test.each(["NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"])(
    "refuses NIMBUS_DEMO=1 combined with a non-empty %s",
    (name) => {
      expect(() => demoModeRequested(env({ NIMBUS_DEMO: "1", [name]: "/somewhere" }))).toThrow(
        name,
      );
    },
  );

  test("an EMPTY override is ignored, matching the existing override semantics", () => {
    expect(demoModeRequested(env({ NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "" }))).toBe(true);
  });

  test("an override WITHOUT demo mode is not this function's concern", () => {
    expect(demoModeRequested(env({ NIMBUS_CONFIG_DIR: "/x" }))).toBe(false);
  });
});

describe("demoSocketPathFor", () => {
  const pipe = "\\\\.\\pipe\\nimbus-gateway";

  test("a Windows pipe gets a -demo-<12 hex> suffix derived from the demo root", () => {
    const s = demoSocketPathFor(pipe, join("A", "demo"));
    expect(s.startsWith(`${pipe}-demo-`)).toBe(true);
    expect(s.slice(`${pipe}-demo-`.length)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("the pipe suffix is deterministic per root and distinct across roots", () => {
    const a1 = demoSocketPathFor(pipe, join("A", "demo"));
    const a2 = demoSocketPathFor(pipe, join("A", "demo"));
    const b = demoSocketPathFor(pipe, join("B", "demo"));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  test("a unix socket moves to nimbus-gateway-demo.sock in the SAME directory", () => {
    const real = join("run", "user", "nimbus-gateway.sock");
    expect(demoSocketPathFor(real, "ignored")).toBe(
      join(dirname(real), "nimbus-gateway-demo.sock"),
    );
  });
});

describe("deriveDemoPaths", () => {
  const real: PlatformPaths = {
    configDir: join("R", "config"),
    dataDir: join("R", "data"),
    logDir: join("R", "data", "logs"),
    socketPath: join("R", "run", "nimbus-gateway.sock"),
    extensionsDir: join("R", "extensions"),
    tempDir: join(tmpdir(), "nimbus"),
  };

  test("every path moves under <realDataDir>/demo and the result is marked demo", () => {
    const root = demoRootFor(real.dataDir);
    expect(root).toBe(join("R", "data", "demo"));
    expect(deriveDemoPaths(real)).toEqual({
      configDir: join(root, "config"),
      dataDir: join(root, "data"),
      logDir: join(root, "data", "logs"),
      socketPath: join("R", "run", "nimbus-gateway-demo.sock"),
      extensionsDir: join(root, "data", "extensions"),
      tempDir: join(tmpdir(), DEMO_TEMP_DIRNAME),
      demo: true,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/platform/demo-root.test.ts`
Expected: FAIL — `Cannot find module './demo-root.ts'`.

- [ ] **Step 3: Implement `demo-root.ts`**

Create `packages/gateway/src/platform/demo-root.ts`:

```ts
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PlatformInitError } from "./errors.ts";
import type { PlatformPaths } from "./paths.ts";

/**
 * The demo root — a second, throwaway Nimbus inside `<realDataDir>/demo` (invariant I41).
 *
 * MIRRORED in `packages/cli/src/lib/demo-root.ts`: the CLI may not import gateway source, and the
 * two sides must resolve byte-identical demo paths or the CLI dials a gateway that is not there.
 * `scripts/parity/demo-root.parity.test.ts` fails when they diverge — change both or neither.
 */
export const DEMO_ENV = "NIMBUS_DEMO";
export const DEMO_DIRNAME = "demo";
export const DEMO_TEMP_DIRNAME = "nimbus-demo";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const DEMO_UNIX_SOCKET_BASENAME = "nimbus-gateway-demo.sock";
/** A demo process honouring either of these would open the REAL config/Vault or dial the REAL gateway. */
const REAL_ROOT_OVERRIDES = ["NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"] as const;

export type EnvReader = (name: string) => string | undefined;

/**
 * Whether this process is demo-rooted. Unset, `""` and `"0"` mean off and `"1"` means on; any other
 * value REFUSES rather than meaning "off", because a user who typed `NIMBUS_DEMO=true` believes they
 * left their real install and would otherwise be running against it.
 */
export function demoModeRequested(get: EnvReader): boolean {
  const raw = get(DEMO_ENV);
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw !== "1") {
    throw new PlatformInitError(`${DEMO_ENV} must be 1 or unset (got "${raw}").`);
  }
  for (const name of REAL_ROOT_OVERRIDES) {
    const v = get(name);
    if (v !== undefined && v.length > 0) {
      throw new PlatformInitError(
        `${DEMO_ENV}=1 cannot be combined with ${name}: a demo process must never resolve a real config directory or socket. Unset ${name} and retry.`,
      );
    }
  }
  return true;
}

export function demoRootFor(realDataDir: string): string {
  return join(realDataDir, DEMO_DIRNAME);
}

/**
 * The demo IPC endpoint. A Windows named pipe is MACHINE-global, so a fixed name would let a
 * process booted on temp roots (a test) reach a developer's live demo gateway; the suffix is a
 * hash of the demo root, so each root owns its own pipe and the CLI and gateway still agree.
 */
export function demoSocketPathFor(realSocketPath: string, demoRoot: string): string {
  if (realSocketPath.startsWith(WINDOWS_PIPE_PREFIX)) {
    const h = createHash("sha256").update(demoRoot, "utf8").digest("hex").slice(0, 12);
    return `${realSocketPath}-demo-${h}`;
  }
  return join(dirname(realSocketPath), DEMO_UNIX_SOCKET_BASENAME);
}

/** Every path relocated inside `<realDataDir>/demo`; no real path lies inside it (I41 clause 1). */
export function deriveDemoPaths(real: PlatformPaths): PlatformPaths {
  const root = demoRootFor(real.dataDir);
  const dataDir = join(root, "data");
  return {
    configDir: join(root, "config"),
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: demoSocketPathFor(real.socketPath, root),
    extensionsDir: join(dataDir, "extensions"),
    tempDir: join(tmpdir(), DEMO_TEMP_DIRNAME),
    demo: true,
  };
}
```

- [ ] **Step 4: Add `demo?: true` to `PlatformPaths` and wire the three resolvers**

In `packages/gateway/src/platform/paths.ts`, add the import and extend the interface:

```ts
import { demoModeRequested, deriveDemoPaths } from "./demo-root.ts";

export interface PlatformPaths {
  configDir: string;
  dataDir: string;
  logDir: string;
  socketPath: string;
  extensionsDir: string;
  tempDir: string;
  /**
   * Set ONLY by the three `create*Paths` resolvers below, when `NIMBUS_DEMO=1` (invariant I41).
   * Everything host-global that must differ for a demo process — the vault factory, the Windows
   * AppContainer boot reap, the env-selected sidecars — branches on this field, never on the env
   * var, so an injected `PlatformPaths` cannot be half-demo.
   */
  demo?: true;
}
```

Then change each resolver so it builds the real paths into a `real` constant and returns `demo ? deriveDemoPaths(real) : real`, with the demo check FIRST. `createWindowsPaths` becomes:

```ts
export function createWindowsPaths(): PlatformPaths {
  const demo = demoModeRequested(processEnvGet);
  const appData = processEnvGet("APPDATA");
  const localAppData = processEnvGet("LOCALAPPDATA");
  if (appData === undefined || appData.length === 0) {
    throw new PlatformInitError(
      "APPDATA is not set. Nimbus requires a standard Windows user profile.",
    );
  }
  if (localAppData === undefined || localAppData.length === 0) {
    throw new PlatformInitError(
      "LOCALAPPDATA is not set. Nimbus requires a standard Windows user profile.",
    );
  }
  const configDir = configDirOverride() ?? join(appData, "Nimbus");
  const dataDir = join(localAppData, "Nimbus", "data");
  const real: PlatformPaths = {
    configDir,
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: socketPathOverride() ?? String.raw`\\.\pipe\nimbus-gateway`,
    extensionsDir: join(localAppData, "Nimbus", "extensions"),
    tempDir: join(tmpdir(), "nimbus"),
  };
  return demo ? deriveDemoPaths(real) : real;
}
```

Apply the same shape to `createDarwinPaths` and `createLinuxPaths` (their existing bodies unchanged; only `return { … }` becomes `const real: PlatformPaths = { … }; return demo ? deriveDemoPaths(real) : real;`, with `const demo = demoModeRequested(processEnvGet);` as the first statement). `demoModeRequested` has already refused both overrides when demo is on, so `configDirOverride()` / `socketPathOverride()` return `undefined` on the demo path by construction.

- [ ] **Step 5: Add resolver-level tests**

In `packages/gateway/src/platform/paths.test.ts`, add `"NIMBUS_DEMO"` and `"NIMBUS_GATEWAY_SOCKET"` to `TRACKED_ENV_KEYS`, then append:

```ts
describe("NIMBUS_DEMO=1 relocates every resolver into <realDataDir>/demo", () => {
  let snapshot: Record<string, string | undefined>;
  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
    process.env["APPDATA"] = join(FAKE_TMPDIR, "roaming");
    process.env["LOCALAPPDATA"] = join(FAKE_TMPDIR, "local");
    process.env["XDG_CONFIG_HOME"] = join(FAKE_TMPDIR, "xdg-config");
    process.env["XDG_DATA_HOME"] = join(FAKE_TMPDIR, "xdg-data");
    process.env["XDG_RUNTIME_DIR"] = join(FAKE_TMPDIR, "run");
    process.env["TMPDIR"] = FAKE_TMPDIR;
  });
  afterEach(() => {
    restoreEnv(snapshot);
  });

  const RESOLVERS = [
    ["win32", createWindowsPaths],
    ["darwin", createDarwinPaths],
    ["linux", createLinuxPaths],
  ] as const;

  for (const [os, resolve] of RESOLVERS) {
    test(`${os}: demo paths are the derivation of the real ones`, () => {
      const real = resolve();
      process.env["NIMBUS_DEMO"] = "1";
      const demo = resolve();
      expect(demo.demo).toBe(true);
      expect(demo.configDir).toBe(join(real.dataDir, "demo", "config"));
      expect(demo.dataDir).toBe(join(real.dataDir, "demo", "data"));
      expect(real.demo).toBeUndefined();
    });

    test(`${os}: refuses NIMBUS_DEMO=1 with NIMBUS_CONFIG_DIR`, () => {
      process.env["NIMBUS_DEMO"] = "1";
      process.env["NIMBUS_CONFIG_DIR"] = join(FAKE_TMPDIR, "elsewhere");
      expect(() => resolve()).toThrow("NIMBUS_CONFIG_DIR");
    });
  }
});
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/gateway/src/platform/demo-root.test.ts packages/gateway/src/platform/paths.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck` then `bunx biome check packages/gateway/src/platform/`
Expected: no errors. (`demo?: true` is optional, so no existing `PlatformPaths` literal breaks.)

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/platform/demo-root.ts packages/gateway/src/platform/demo-root.test.ts packages/gateway/src/platform/paths.ts packages/gateway/src/platform/paths.test.ts
git commit -m "feat(platform): resolve an isolated demo root when NIMBUS_DEMO=1"
```

---

### Task 2: CLI mirror + parity test

**Files:**
- Create: `packages/cli/src/lib/demo-root.ts`
- Create: `packages/cli/src/lib/demo-root.test.ts`
- Modify: `packages/cli/src/paths.ts` (type at 6–13; `getCliPlatformPaths` at 55–108)
- Create: `scripts/parity/demo-root.parity.test.ts`

**Interfaces:**
- Consumes: Task 1's gateway `demo-root.ts` (the parity test only).
- Produces (used by Task 3): same five exports as Task 1 but over `CliPlatformPaths`, plus `export class DemoModeError extends Error`; `CliPlatformPaths` gains `demo?: true`.

- [ ] **Step 1: Write the failing CLI unit test**

Create `packages/cli/src/lib/demo-root.test.ts` with the SAME cases as Task 1 Step 1, adapted: import from `./demo-root.ts`, type fixtures as `CliPlatformPaths` from `../paths.ts`, and assert refusals with `toThrow(DemoModeError)` instead of `PlatformInitError`. Full file:

```ts
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import {
  DEMO_TEMP_DIRNAME,
  DemoModeError,
  demoModeRequested,
  demoRootFor,
  demoSocketPathFor,
  deriveDemoPaths,
} from "./demo-root.ts";

function env(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name];
}

describe("demoModeRequested (cli mirror)", () => {
  test.each([
    ["unset", {}],
    ["empty", { NIMBUS_DEMO: "" }],
    ["zero", { NIMBUS_DEMO: "0" }],
  ])("%s means off", (_label, map) => {
    expect(demoModeRequested(env(map))).toBe(false);
  });

  test('"1" means on', () => {
    expect(demoModeRequested(env({ NIMBUS_DEMO: "1" }))).toBe(true);
  });

  test.each(["true", "yes", "2", " 1"])('refuses the ambiguous value "%s"', (v) => {
    expect(() => demoModeRequested(env({ NIMBUS_DEMO: v }))).toThrow(DemoModeError);
    expect(() => demoModeRequested(env({ NIMBUS_DEMO: v }))).toThrow(
      "NIMBUS_DEMO must be 1 or unset",
    );
  });

  test.each(["NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"])(
    "refuses NIMBUS_DEMO=1 combined with a non-empty %s",
    (name) => {
      expect(() => demoModeRequested(env({ NIMBUS_DEMO: "1", [name]: "/somewhere" }))).toThrow(
        name,
      );
    },
  );

  test("an EMPTY override is ignored", () => {
    expect(demoModeRequested(env({ NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "" }))).toBe(true);
  });
});

describe("demoSocketPathFor (cli mirror)", () => {
  const pipe = "\\\\.\\pipe\\nimbus-gateway";
  test("Windows pipe: deterministic -demo-<12 hex> suffix", () => {
    const s = demoSocketPathFor(pipe, join("A", "demo"));
    expect(s.slice(`${pipe}-demo-`.length)).toMatch(/^[0-9a-f]{12}$/);
    expect(demoSocketPathFor(pipe, join("A", "demo"))).toBe(s);
    expect(demoSocketPathFor(pipe, join("B", "demo"))).not.toBe(s);
  });
  test("unix socket: same directory, demo basename", () => {
    const real = join("run", "nimbus-gateway.sock");
    expect(demoSocketPathFor(real, "x")).toBe(join(dirname(real), "nimbus-gateway-demo.sock"));
  });
});

describe("deriveDemoPaths (cli mirror)", () => {
  test("relocates under <realDataDir>/demo and marks demo", () => {
    const real: CliPlatformPaths = {
      configDir: join("R", "config"),
      dataDir: join("R", "data"),
      logDir: join("R", "data", "logs"),
      socketPath: join("R", "run", "nimbus-gateway.sock"),
      extensionsDir: join("R", "extensions"),
      tempDir: join(tmpdir(), "nimbus"),
    };
    const root = demoRootFor(real.dataDir);
    expect(deriveDemoPaths(real)).toEqual({
      configDir: join(root, "config"),
      dataDir: join(root, "data"),
      logDir: join(root, "data", "logs"),
      socketPath: join("R", "run", "nimbus-gateway-demo.sock"),
      extensionsDir: join(root, "data", "extensions"),
      tempDir: join(tmpdir(), DEMO_TEMP_DIRNAME),
      demo: true,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/src/lib/demo-root.test.ts`
Expected: FAIL — `Cannot find module './demo-root.ts'`.

- [ ] **Step 3: Implement the mirror**

Create `packages/cli/src/lib/demo-root.ts` — identical logic to Task 1's file; only the error class and the path type differ:

```ts
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";

/**
 * MIRROR of `packages/gateway/src/platform/demo-root.ts` (invariant I41). The CLI may not import
 * gateway source; `scripts/parity/demo-root.parity.test.ts` fails when the two diverge — change
 * both or neither.
 */
export const DEMO_ENV = "NIMBUS_DEMO";
export const DEMO_DIRNAME = "demo";
export const DEMO_TEMP_DIRNAME = "nimbus-demo";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const DEMO_UNIX_SOCKET_BASENAME = "nimbus-gateway-demo.sock";
const REAL_ROOT_OVERRIDES = ["NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"] as const;

export type EnvReader = (name: string) => string | undefined;

export class DemoModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoModeError";
  }
}

export function demoModeRequested(get: EnvReader): boolean {
  const raw = get(DEMO_ENV);
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw !== "1") {
    throw new DemoModeError(`${DEMO_ENV} must be 1 or unset (got "${raw}").`);
  }
  for (const name of REAL_ROOT_OVERRIDES) {
    const v = get(name);
    if (v !== undefined && v.length > 0) {
      throw new DemoModeError(
        `${DEMO_ENV}=1 cannot be combined with ${name}: a demo process must never resolve a real config directory or socket. Unset ${name} and retry.`,
      );
    }
  }
  return true;
}

export function demoRootFor(realDataDir: string): string {
  return join(realDataDir, DEMO_DIRNAME);
}

export function demoSocketPathFor(realSocketPath: string, demoRoot: string): string {
  if (realSocketPath.startsWith(WINDOWS_PIPE_PREFIX)) {
    const h = createHash("sha256").update(demoRoot, "utf8").digest("hex").slice(0, 12);
    return `${realSocketPath}-demo-${h}`;
  }
  return join(dirname(realSocketPath), DEMO_UNIX_SOCKET_BASENAME);
}

export function deriveDemoPaths(real: CliPlatformPaths): CliPlatformPaths {
  const root = demoRootFor(real.dataDir);
  const dataDir = join(root, "data");
  return {
    configDir: join(root, "config"),
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: demoSocketPathFor(real.socketPath, root),
    extensionsDir: join(dataDir, "extensions"),
    tempDir: join(tmpdir(), DEMO_TEMP_DIRNAME),
    demo: true,
  };
}
```

- [ ] **Step 4: Wire `getCliPlatformPaths`**

In `packages/cli/src/paths.ts`: add `demo?: true;` (with a one-line comment pointing at `lib/demo-root.ts` and I41) to `CliPlatformPaths`; import `demoModeRequested, deriveDemoPaths` from `./lib/demo-root.ts`; rename the existing function body to a private `function realCliPlatformPaths(): CliPlatformPaths { … }` (its `switch` unchanged), and add:

```ts
export function getCliPlatformPaths(): CliPlatformPaths {
  // Checked FIRST: a refusal (bad NIMBUS_DEMO value, or demo + a real-root override) must win
  // over everything, including a missing APPDATA.
  const demo = demoModeRequested(envGet);
  const real = realCliPlatformPaths();
  return demo ? deriveDemoPaths(real) : real;
}
```

- [ ] **Step 5: Write the parity test**

Create `scripts/parity/demo-root.parity.test.ts`:

```ts
// The CLI and the gateway each carry a demo-root module because neither may import the other.
// If they drift, `nimbus --demo …` dials a socket the demo gateway never bound, or reads a
// gateway.json it never wrote. This is the only place allowed to import both.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import * as cli from "../../packages/cli/src/lib/demo-root.ts";
import * as gw from "../../packages/gateway/src/platform/demo-root.ts";

const REALS = [
  {
    name: "windows-shaped",
    real: {
      configDir: join("C:", "Users", "u", "AppData", "Roaming", "Nimbus"),
      dataDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "data"),
      logDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "data", "logs"),
      socketPath: "\\\\.\\pipe\\nimbus-gateway",
      extensionsDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "extensions"),
      tempDir: join("T", "nimbus"),
    },
  },
  {
    name: "darwin-shaped (configDir === dataDir)",
    real: {
      configDir: join("Users", "u", "Library", "Application Support", "Nimbus"),
      dataDir: join("Users", "u", "Library", "Application Support", "Nimbus"),
      logDir: join("Users", "u", "Library", "Application Support", "Nimbus", "logs"),
      socketPath: join("var", "folders", "x", "T", "nimbus-gateway.sock"),
      extensionsDir: join("Users", "u", "Library", "Application Support", "Nimbus", "extensions"),
      tempDir: join("T", "nimbus"),
    },
  },
  {
    name: "linux-shaped",
    real: {
      configDir: join("home", "u", ".config", "nimbus"),
      dataDir: join("home", "u", ".local", "share", "nimbus"),
      logDir: join("home", "u", ".local", "share", "nimbus", "logs"),
      socketPath: join("run", "user", "1000", "nimbus-gateway.sock"),
      extensionsDir: join("home", "u", ".local", "share", "nimbus", "extensions"),
      tempDir: join("T", "nimbus"),
    },
  },
] as const;

const ENVS: ReadonlyArray<Record<string, string>> = [
  {},
  { NIMBUS_DEMO: "" },
  { NIMBUS_DEMO: "0" },
  { NIMBUS_DEMO: "1" },
  { NIMBUS_DEMO: "true" },
  { NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "/x" },
  { NIMBUS_DEMO: "1", NIMBUS_GATEWAY_SOCKET: "/x" },
  { NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "" },
];

function verdict(fn: (get: (n: string) => string | undefined) => boolean, map: Record<string, string>) {
  try {
    return { ok: true as const, value: fn((n) => map[n]) };
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
}

describe("demo-root parity: CLI mirror ≡ gateway", () => {
  for (const { name, real } of REALS) {
    test(`deriveDemoPaths agrees for ${name}`, () => {
      expect(cli.deriveDemoPaths({ ...real })).toEqual(gw.deriveDemoPaths({ ...real }));
    });
  }

  test("demoModeRequested gives the same verdict and message for every env shape", () => {
    for (const map of ENVS) {
      expect(verdict(cli.demoModeRequested, map)).toEqual(verdict(gw.demoModeRequested, map));
    }
  });

  test("the exported constants agree", () => {
    expect(cli.DEMO_ENV).toBe(gw.DEMO_ENV);
    expect(cli.DEMO_DIRNAME).toBe(gw.DEMO_DIRNAME);
    expect(cli.DEMO_TEMP_DIRNAME).toBe(gw.DEMO_TEMP_DIRNAME);
  });
});
```

- [ ] **Step 6: Prove the parity test can fail**

Temporarily change `DEMO_UNIX_SOCKET_BASENAME` in `packages/cli/src/lib/demo-root.ts` to `"nimbus-demo.sock"`, run `bun test scripts/parity/demo-root.parity.test.ts`, confirm the darwin/linux cases FAIL, then revert the change and confirm PASS. (A parity test that has never been red proves nothing.)

- [ ] **Step 7: Run all CLI + parity tests touched**

Run: `bun test packages/cli/src/lib/demo-root.test.ts packages/cli/src/paths.test.ts scripts/parity/demo-root.parity.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
bun run typecheck
bunx biome check packages/cli/src/lib/demo-root.ts packages/cli/src/paths.ts scripts/parity/
git rev-parse --abbrev-ref HEAD
git add packages/cli/src/lib/demo-root.ts packages/cli/src/lib/demo-root.test.ts packages/cli/src/paths.ts scripts/parity/demo-root.parity.test.ts
git commit -m "feat(cli): mirror the demo-root derivation, with a parity test against the gateway"
```

---

### Task 3: CLI `--demo` flag, clean refusals, demo-aware hint

**Files:**
- Create: `packages/cli/src/lib/demo-flag.ts`
- Create: `packages/cli/src/lib/demo-flag.test.ts`
- Modify: `packages/cli/src/index.ts` (line 84 `const rawArgv`; `main()` at 203–206)
- Modify: `packages/cli/src/lib/with-gateway-ipc.ts` (class at 17–22; throw at 85)
- Create: `packages/cli/test/e2e/demo-flag.e2e.test.ts`

**Interfaces:**
- Consumes: Task 2's `getCliPlatformPaths()` (demo-aware), `CliPlatformPaths.demo`.
- Produces: `export const DEMO_FLAG = "--demo"`; `export function applyDemoFlag(argv: readonly string[], env: NodeJS.ProcessEnv): string[]`; `GatewayNotRunningError` constructor gains `opts: { demo?: boolean } = {}`.

**Why the ordering matters (spec § 3.1):** `index.ts` resolves paths and opens the CLI file logger at lines 205–206, BEFORE dispatch, and dispatch treats `rawArgv[0]` as the command (line 213). A flag handled inside a command would already have written a log into the REAL `logDir`, and `nimbus --demo oncall` would dispatch the command `--demo`. No CLI module resolves paths at import time (checked 2026-09-18), so setting the env var at the `rawArgv` line — before `main()` runs — is early enough.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/cli/src/lib/demo-flag.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { applyDemoFlag, DEMO_FLAG } from "./demo-flag.ts";
import { GatewayNotRunningError } from "./with-gateway-ipc.ts";

describe("applyDemoFlag", () => {
  test("without the flag: argv unchanged, env untouched", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["oncall", "--json"], env)).toEqual(["oncall", "--json"]);
    expect(env["NIMBUS_DEMO"]).toBeUndefined();
  });

  test("a leading --demo is stripped so the next token is the command", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag([DEMO_FLAG, "oncall"], env)).toEqual(["oncall"]);
    expect(env["NIMBUS_DEMO"]).toBe("1");
  });

  test("--demo anywhere is stripped, every occurrence", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["status", DEMO_FLAG, "--json", DEMO_FLAG], env)).toEqual([
      "status",
      "--json",
    ]);
  });

  test("the flag wins over a pre-existing NIMBUS_DEMO=0", () => {
    const env: NodeJS.ProcessEnv = { NIMBUS_DEMO: "0" };
    applyDemoFlag([DEMO_FLAG, "status"], env);
    expect(env["NIMBUS_DEMO"]).toBe("1");
  });

  test("a token that merely CONTAINS --demo is an argument, not the flag", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["ask", "what does --demo do"], env)).toEqual([
      "ask",
      "what does --demo do",
    ]);
    expect(env["NIMBUS_DEMO"]).toBeUndefined();
  });
});

describe("GatewayNotRunningError", () => {
  test("the default message is unchanged", () => {
    expect(new GatewayNotRunningError().message).toBe(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  test("in demo mode it points at the DEMO gateway, never the real one", () => {
    const m = new GatewayNotRunningError({ demo: true }).message;
    expect(m).toContain("Gateway is not running");
    expect(m).toContain("nimbus --demo start");
    expect(m).not.toContain("Start with: nimbus start");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/cli/src/lib/demo-flag.test.ts`
Expected: FAIL — module `./demo-flag.ts` not found.

- [ ] **Step 3: Implement `demo-flag.ts`**

```ts
/**
 * The global `--demo` flag (spec § 3.1, invariant I41). Applied in `index.ts` BEFORE any path is
 * resolved: the CLI opens its file logger under `logDir` ahead of dispatch, so a flag handled
 * later would already have written into the REAL install. Mutates `env` on purpose — every later
 * `getCliPlatformPaths()` call, and the gateway `nimbus start` spawns (which inherits this
 * process's environment), must see `NIMBUS_DEMO=1`.
 *
 * Only an exact `--demo` token counts; no command defines its own `--demo` (checked 2026-09-18),
 * so stripping it globally shadows nothing.
 */
export const DEMO_FLAG = "--demo";

export function applyDemoFlag(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  if (!argv.includes(DEMO_FLAG)) return [...argv];
  env["NIMBUS_DEMO"] = "1";
  return argv.filter((a) => a !== DEMO_FLAG);
}
```

- [ ] **Step 4: Make the not-running error demo-aware**

In `packages/cli/src/lib/with-gateway-ipc.ts`, replace the class body and the throw:

```ts
export class GatewayNotRunningError extends Error {
  constructor(opts: { demo?: boolean } = {}) {
    super(
      opts.demo === true
        ? "Gateway is not running (demo root). Start with: nimbus --demo start"
        : "Gateway is not running. Start with: nimbus start",
    );
    this.name = "GatewayNotRunningError";
  }
}
```

and at the throw site (line 85): `throw new GatewayNotRunningError({ demo: paths.demo === true });`

(The demo message keeps the substring `Gateway is not running`, which existing smoke tests match on. It must NOT say `nimbus start`: that would start the REAL gateway.)

- [ ] **Step 5: Apply the flag and surface refusals in `index.ts`**

Change line 84 to:

```ts
const rawArgv = applyDemoFlag(process.argv.slice(2), process.env);
```

adding `import { applyDemoFlag } from "./lib/demo-flag.ts";` and changing the paths import to `import { type CliPlatformPaths, getCliPlatformPaths } from "./paths.ts";`. Then in `main()`, replace the two lines `const paths = getCliPlatformPaths();` / `const { logger } = await createCliFileLogger(paths);` with:

```ts
  let paths: CliPlatformPaths;
  try {
    paths = getCliPlatformPaths();
  } catch (e) {
    // A path-resolution refusal (an ambiguous NIMBUS_DEMO value, or NIMBUS_DEMO combined with a
    // real-root override) must reach the user as a message rather than an unhandled rejection —
    // and nothing is logged, because the log directory is exactly what failed to resolve.
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }
  const { logger } = await createCliFileLogger(paths);
```

- [ ] **Step 6: Run the unit tests**

Run: `bun test packages/cli/src/lib/demo-flag.test.ts packages/cli/src/lib/with-gateway-ipc.test.ts`
Expected: PASS. (If `with-gateway-ipc.test.ts` does not exist, run only the first file.)

- [ ] **Step 7: Write the CLI subprocess e2e test**

Create `packages/cli/test/e2e/demo-flag.e2e.test.ts`:

```ts
// Real CLI subprocess, temp OS roots only (never the developer's real install). Proves what a
// unit test cannot: the file logger opens under the DEMO root, the flag is stripped before
// dispatch, refusals surface as messages, and the not-running hint names the demo gateway.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "nd-cli-"));
const dirs = {
  roaming: join(root, "r"),
  local: join(root, "l"),
  home: join(root, "h"),
  xdgConfig: join(root, "c"),
  xdgData: join(root, "d"),
  run: join(root, "u"),
  tmp: join(root, "t"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ["NIMBUS_DEMO", "NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET", "NIMBUS_PROFILE"]) {
    delete env[k];
  }
  return {
    ...env,
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    ...extra,
  };
}

/** The REAL data dir each OS would use under these temp roots (mirrors platform/paths). */
function realDataDir(): string {
  if (process.platform === "win32") return join(dirs.local, "Nimbus", "data");
  if (process.platform === "darwin") {
    return join(dirs.home, "Library", "Application Support", "Nimbus");
  }
  return join(dirs.xdgData, "nimbus");
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", cliEntry, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort — a Windows handle release can lag */
  }
});

describe("nimbus --demo (real CLI subprocess, temp roots)", () => {
  test("premise: the child resolves homedir() to the temp HOME (else every other assertion is about the REAL home)", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", "process.stdout.write(require('node:os').homedir())"],
      stdout: "pipe",
      env: baseEnv(),
    });
    const home = await new Response(proc.stdout).text();
    await proc.exited;
    expect(home).toBe(dirs.home);
  });

  test("--demo --version: version printed, CLI log under the DEMO logDir, real logDir never created", async () => {
    const r = await runCli(["--demo", "--version"], baseEnv());
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const demoLogs = join(realDataDir(), "demo", "data", "logs");
    expect(existsSync(demoLogs)).toBe(true);
    expect(readdirSync(demoLogs).some((f) => f.startsWith("cli-"))).toBe(true);
    expect(existsSync(join(realDataDir(), "logs"))).toBe(false);
  });

  test("--demo is stripped before dispatch: an unknown command is named, not '--demo'", async () => {
    const r = await runCli(["--demo", "no-such-command"], baseEnv());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Unknown command: no-such-command");
    expect(r.stderr).not.toContain("Unknown command: --demo");
  });

  test("an ambiguous NIMBUS_DEMO value refuses with a message, exit 1", async () => {
    const r = await runCli(["--version"], baseEnv({ NIMBUS_DEMO: "true" }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NIMBUS_DEMO must be 1 or unset");
  });

  test("--demo with NIMBUS_CONFIG_DIR refuses, naming the variable", async () => {
    const r = await runCli(["--demo", "--version"], baseEnv({ NIMBUS_CONFIG_DIR: dirs.tmp }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NIMBUS_CONFIG_DIR");
  });

  test("with no demo gateway running, the hint names the DEMO gateway", async () => {
    const r = await runCli(["--demo", "catchup"], baseEnv());
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("nimbus --demo start");
  });
});
```

- [ ] **Step 8: Run the e2e test**

Run: `bun test packages/cli/test/e2e/demo-flag.e2e.test.ts`
Expected: PASS. If the premise test fails on your OS, STOP — do not weaken it; the other assertions would then be about the real home directory.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
bun run typecheck
bunx biome check packages/cli/src/lib/demo-flag.ts packages/cli/src/index.ts packages/cli/src/lib/with-gateway-ipc.ts packages/cli/test/e2e/demo-flag.e2e.test.ts
git rev-parse --abbrev-ref HEAD
git add packages/cli/src/lib/demo-flag.ts packages/cli/src/lib/demo-flag.test.ts packages/cli/src/index.ts packages/cli/src/lib/with-gateway-ipc.ts packages/cli/test/e2e/demo-flag.e2e.test.ts
git commit -m "feat(cli): global --demo flag applied before any path resolves"
```

---

### Task 4: Demo gateway never touches host-global state (vault, reap, sidecars)

**Files:**
- Create: `packages/gateway/src/vault/ephemeral.ts`, `packages/gateway/src/vault/ephemeral.test.ts`
- Modify: `packages/gateway/src/vault/mock.ts`
- Modify: `packages/gateway/src/vault/factory.ts`, `packages/gateway/src/vault/factory.test.ts`
- Create: `packages/gateway/src/platform/demo-boot.ts`, `packages/gateway/src/platform/demo-boot.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (reap call at 3168–3172; sidecar call at 4180)

**Interfaces:**
- Consumes: `PlatformPaths.demo` (Task 1).
- Produces (used by Task 5): `export class EphemeralVault implements NimbusVault`; `export type BootPolicy = { readonly reapAppContainers: boolean; readonly envSidecars: boolean }`; `export function bootPolicyFor(paths: PlatformPaths): BootPolicy`.

**Why (spec § 10):** on macOS the Vault is the Keychain under the fixed service `dev.nimbus` and on Linux it is libsecret with no path at all, so a demo gateway would READ the owner's credentials — and `sweepToolgenCredentials` (every boot AND shutdown, `gateway-main.ts`) would DELETE the owner's `toolgen.*` credentials. The Windows AppContainer reap computes its live set from the gateway's OWN index, so a demo boot would delete the owner's extension profiles. The HTTP/metrics sidecars are selected by env (`NIMBUS_HTTP_PORT`/`NIMBUS_METRICS_PORT`).

- [ ] **Step 1: Write the failing EphemeralVault test**

Create `packages/gateway/src/vault/ephemeral.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { EphemeralVault } from "./ephemeral.ts";

describe("EphemeralVault", () => {
  test("a fresh instance is empty", async () => {
    expect(await new EphemeralVault().listKeys()).toEqual([]);
  });

  test("set / get / delete round-trip", async () => {
    const v = new EphemeralVault();
    await v.set("demo.key", "value");
    expect(await v.get("demo.key")).toBe("value");
    await v.delete("demo.key");
    expect(await v.get("demo.key")).toBeNull();
  });

  test("listKeys is sorted and prefix-filtered", async () => {
    const v = new EphemeralVault();
    await v.set("b.one", "1");
    await v.set("a.two", "2");
    await v.set("a.one", "3");
    expect(await v.listKeys()).toEqual(["a.one", "a.two", "b.one"]);
    expect(await v.listKeys("a.")).toEqual(["a.one", "a.two"]);
  });

  test("two instances share nothing — nothing is persisted anywhere", async () => {
    const a = new EphemeralVault();
    await a.set("demo.key", "x");
    expect(await new EphemeralVault().get("demo.key")).toBeNull();
  });

  test("rejects a malformed key exactly like the OS vaults", async () => {
    await expect(new EphemeralVault().set("NOT A KEY", "x")).rejects.toThrow(
      "Invalid vault key format",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/src/vault/ephemeral.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `EphemeralVault` and make `MockVault` reuse it**

Create `packages/gateway/src/vault/ephemeral.ts`:

```ts
import { compareVaultKeysAlphabetically, validateVaultKeyOrThrow } from "./key-format.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

/**
 * An in-process, never-persisted vault — the ONLY vault a demo-rooted gateway opens (invariant
 * I41 clause 3). Path isolation cannot isolate the OS credential store: on macOS it is the
 * Keychain under a fixed service name and on Linux it is libsecret, neither of which lives under
 * `configDir`. A throwaway demo has no credential worth keeping, so the safe store is one that
 * cannot reach the OS at all and forgets everything when the process exits.
 */
export class EphemeralVault implements NimbusVault {
  private readonly store = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    this.store.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    validateVaultKeyOrThrow(key);
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    this.store.delete(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = [...this.store.keys()].sort(compareVaultKeysAlphabetically);
    if (prefix === undefined || prefix.length === 0) {
      return keys;
    }
    return keys.filter((k) => k.startsWith(prefix));
  }
}
```

Replace the body of `packages/gateway/src/vault/mock.ts` with:

```ts
import { EphemeralVault } from "./ephemeral.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

/** Test double. Same behaviour as the production `EphemeralVault`, kept as a name tests import. */
export class MockVault extends EphemeralVault {}

export function createMockVault(): NimbusVault {
  return new MockVault();
}
```

- [ ] **Step 4: Write the failing factory test**

In `packages/gateway/src/vault/factory.test.ts`, add after the existing imports-by-`await import`:

```ts
const { EphemeralVault } = await import("./ephemeral.ts");
```

and inside the `describe`:

```ts
  test("a demo-rooted process gets an EphemeralVault — decided BEFORE the OS switch", async () => {
    // node:os is mocked to "freebsd" above, so a non-demo call throws (previous test). A demo
    // call must still succeed: that proves the demo check precedes the platform switch, i.e. a
    // demo process never reaches ANY OS credential store.
    const v = await createNimbusVault({ demo: true } as unknown as PlatformPaths);
    expect(v).toBeInstanceOf(EphemeralVault);
    expect(await v.listKeys()).toEqual([]);
  });
```

Run: `bun test packages/gateway/src/vault/factory.test.ts`
Expected: FAIL — rejects with `PlatformInitError` (unsupported platform), because the factory does not branch on `demo` yet.

- [ ] **Step 5: Branch the factory**

In `packages/gateway/src/vault/factory.ts`, add `import { EphemeralVault } from "./ephemeral.ts";` and make the first statement of `createNimbusVault`:

```ts
  // I41 clause 3: a demo-rooted process never opens the OS credential store. On macOS (Keychain,
  // fixed service `dev.nimbus`) and Linux (libsecret) that store is NOT under configDir, so path
  // isolation alone would hand a demo gateway the owner's real credentials.
  if (paths.demo === true) {
    return new EphemeralVault();
  }
```

Run: `bun test packages/gateway/src/vault/`
Expected: PASS (ephemeral, factory, and every existing vault test — `MockVault` behaviour is unchanged).

- [ ] **Step 6: Write the failing boot-policy test**

Create `packages/gateway/src/platform/demo-boot.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { bootPolicyFor } from "./demo-boot.ts";
import type { PlatformPaths } from "./paths.ts";

const base: PlatformPaths = {
  configDir: "c",
  dataDir: "d",
  logDir: "l",
  socketPath: "s",
  extensionsDir: "e",
  tempDir: "t",
};

describe("bootPolicyFor", () => {
  test("a real gateway reaps AppContainers and honours the env sidecars", () => {
    expect(bootPolicyFor(base)).toEqual({ reapAppContainers: true, envSidecars: true });
  });

  test("a demo gateway does neither", () => {
    expect(bootPolicyFor({ ...base, demo: true })).toEqual({
      reapAppContainers: false,
      envSidecars: false,
    });
  });
});
```

Run: `bun test packages/gateway/src/platform/demo-boot.test.ts` → FAIL (module not found).

- [ ] **Step 7: Implement `demo-boot.ts`**

```ts
import type { PlatformPaths } from "./paths.ts";

/**
 * The host-global boot actions a demo-rooted gateway must NOT perform (invariant I41 clause 4).
 *
 * - `reapAppContainers`: `sandbox/win32-reap.ts` deletes every `nimbus-*` AppContainer profile whose
 *   extension id is absent from `liveExtensionIds(db)` — THIS gateway's index. A demo index holds
 *   none of the owner's installed extensions, so a demo boot would delete the real gateway's
 *   profiles (possibly in use) and then sweep their ACEs.
 * - `envSidecars`: the HTTP API and metrics servers are selected by `NIMBUS_HTTP_PORT` /
 *   `NIMBUS_METRICS_PORT`, not config. A demo gateway inheriting them would crash on the port or,
 *   with the real gateway stopped, serve the demo index on the owner's real port.
 *
 * A pure function so the decision is unit-testable; `assemble.ts` is too large to execute in a
 * unit test, and `security-invariants.test.ts` pins that it consults this.
 */
export type BootPolicy = {
  readonly reapAppContainers: boolean;
  readonly envSidecars: boolean;
};

export function bootPolicyFor(paths: PlatformPaths): BootPolicy {
  const demo = paths.demo === true;
  return { reapAppContainers: !demo, envSidecars: !demo };
}
```

Run: `bun test packages/gateway/src/platform/demo-boot.test.ts` → PASS.

- [ ] **Step 8: Wire `assemble.ts`**

Add `import { bootPolicyFor } from "./demo-boot.ts";`. Immediately after `await ensurePlatformDirectories(paths);` (line 3144) add:

```ts
  const bootPolicy = bootPolicyFor(paths);
```

Replace the reap call (lines 3168–3172) with:

```ts
  if (bootPolicy.reapAppContainers) {
    void reapAppContainersAtBoot({
      db,
      logger: syncLogger,
      sweepPaths: resolveRuntimeById("bun").requiredReadPaths(),
    });
  }
```

and the sidecar call (line 4180) with:

```ts
  if (bootPolicy.envSidecars) {
    collectSidecarsFromEnv(db, paths, sidecarStops, httpSidecarOpts);
  }
```

Keep the existing comment above the reap; append one line to it: `// Skipped for a demo-rooted gateway (I41 clause 4, platform/demo-boot.ts).`

Before editing, `grep -n "reapAppContainersAtBoot(\|collectSidecarsFromEnv(" packages/gateway/src/platform/assemble.ts` must show exactly ONE call of each (plus the sidecar definition at line 962). If the line numbers have drifted, locate by these strings, not by number.

- [ ] **Step 9: Run, typecheck, lint, commit**

```bash
bun test packages/gateway/src/vault/ packages/gateway/src/platform/demo-boot.test.ts
bun run typecheck
bunx biome check packages/gateway/src/vault/ packages/gateway/src/platform/demo-boot.ts packages/gateway/src/platform/assemble.ts
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/vault/ephemeral.ts packages/gateway/src/vault/ephemeral.test.ts packages/gateway/src/vault/mock.ts packages/gateway/src/vault/factory.ts packages/gateway/src/vault/factory.test.ts packages/gateway/src/platform/demo-boot.ts packages/gateway/src/platform/demo-boot.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(gateway): a demo-rooted gateway opens no OS vault, reaps nothing, starts no env sidecars"
```

---

### Task 5: Invariant I41 — enforcement test, SECURITY-INVARIANTS section, ceiling sweep

**Files:**
- Modify: `packages/gateway/src/security-invariants.test.ts` (append a `describe` after the I40 block that starts at line 4064; add imports at the top)
- Modify: `docs/SECURITY-INVARIANTS.md` (ceiling line 3; append `## I41` after the I40 section)
- Modify: `CLAUDE.md`, `GEMINI.md` (invariant bullet list + every ceiling range), plus every other surface `audit:status-drift` flags

**Interfaces:**
- Consumes: `createWindowsPaths`/`createDarwinPaths`/`createLinuxPaths`, `PlatformPaths` (Task 1); `createNimbusVault`, `EphemeralVault`, `bootPolicyFor` (Task 4); the file's existing `read(relPathFromRepoRoot)` helper (line 100).

The triple rule: the wiring (Tasks 1–4), this doc section and this test land in ONE commit. The triple-rule commit is THIS task's commit — do not split it.

- [ ] **Step 1: Write the I41 test block**

Add to the imports at the top of `packages/gateway/src/security-invariants.test.ts` (merge into existing import lines for the same modules where they exist; `mkdtempSync`, `tmpdir`, `join` are very likely already imported):

```ts
import { isAbsolute, relative } from "node:path";
import { bootPolicyFor } from "./platform/demo-boot.ts";
import {
  createDarwinPaths,
  createLinuxPaths,
  createWindowsPaths,
  type PlatformPaths,
} from "./platform/paths.ts";
import { EphemeralVault } from "./vault/ephemeral.ts";
import { createNimbusVault } from "./vault/factory.ts";
```

Append after the I40 `describe` block:

```ts
describe("I41 — a demo-rooted process never reaches the real install", () => {
  const ENV_KEYS = [
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
    "NIMBUS_DEMO",
    "NIMBUS_CONFIG_DIR",
    "NIMBUS_GATEWAY_SOCKET",
  ] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const root = mkdtempSync(join(tmpdir(), "nimbus-i41-"));
    process.env["APPDATA"] = join(root, "roaming");
    process.env["LOCALAPPDATA"] = join(root, "local");
    process.env["XDG_CONFIG_HOME"] = join(root, "xdg-config");
    process.env["XDG_DATA_HOME"] = join(root, "xdg-data");
    process.env["XDG_RUNTIME_DIR"] = join(root, "run");
    process.env["TMPDIR"] = join(root, "tmp");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  /**
   * Clause (1)+(2). A SUBTREE rule, not "nothing under the real configDir": on macOS configDir and
   * dataDir are the same directory, so the demo root necessarily sits under the real config dir.
   * What matters is that every demo path is inside a subtree that holds no real path.
   */
  function isolationViolations(real: PlatformPaths, demo: PlatformPaths): string[] {
    const demoRoot = join(real.dataDir, "demo");
    const out: string[] = [];
    for (const k of ["configDir", "dataDir", "logDir", "extensionsDir"] as const) {
      if (!isInside(demo[k], demoRoot)) out.push(`demo ${k} is outside the demo root: ${demo[k]}`);
      if (real[k] === demoRoot || isInside(real[k], demoRoot)) {
        out.push(`real ${k} lies inside the demo root: ${real[k]}`);
      }
    }
    if (demo.tempDir === real.tempDir) out.push(`tempDir is shared: ${demo.tempDir}`);
    if (demo.socketPath === real.socketPath) out.push(`socket is shared: ${demo.socketPath}`);
    return out;
  }

  const RESOLVERS = [
    ["win32", createWindowsPaths],
    ["darwin", createDarwinPaths],
    ["linux", createLinuxPaths],
  ] as const;

  for (const [os, resolve] of RESOLVERS) {
    test(`clauses 1–2 (${os}): every demo path is inside <realDataDir>/demo and no real path is`, () => {
      const real = resolve();
      process.env["NIMBUS_DEMO"] = "1";
      const demo = resolve();
      expect(demo.demo).toBe(true);
      expect(isolationViolations(real, demo)).toEqual([]);
    });

    test(`negative control (${os}): without the flag the same check reports violations`, () => {
      const real = resolve();
      expect(isolationViolations(real, resolve()).length).toBeGreaterThan(0);
    });

    test(`refusal (${os}): demo + a real-root override never resolves at all`, () => {
      process.env["NIMBUS_DEMO"] = "1";
      process.env["NIMBUS_GATEWAY_SOCKET"] = join(tmpdir(), "elsewhere.sock");
      expect(() => resolve()).toThrow("NIMBUS_GATEWAY_SOCKET");
    });
  }

  test("clause 3: a demo-rooted process gets an EphemeralVault, never an OS credential store", async () => {
    process.env["NIMBUS_DEMO"] = "1";
    const demo = createLinuxPaths();
    const vault = await createNimbusVault(demo);
    expect(vault).toBeInstanceOf(EphemeralVault);
  });

  test("clause 4: the demo boot policy disables the reap and the env sidecars (negative control: real enables both)", () => {
    const real = createLinuxPaths();
    process.env["NIMBUS_DEMO"] = "1";
    const demo = createLinuxPaths();
    expect(bootPolicyFor(real)).toEqual({ reapAppContainers: true, envSidecars: true });
    expect(bootPolicyFor(demo)).toEqual({ reapAppContainers: false, envSidecars: false });
  });

  test("clause 4 wiring: assemble.ts calls the reap and the sidecars exactly once each, each behind the policy", async () => {
    const src = await read("packages/gateway/src/platform/assemble.ts");
    expect(src.match(/reapAppContainersAtBoot\(/g)?.length).toBe(1);
    expect(src).toMatch(/if \(bootPolicy\.reapAppContainers\) \{\s*void reapAppContainersAtBoot\(/);
    expect(src.match(/collectSidecarsFromEnv\(db,/g)?.length).toBe(1);
    expect(src).toMatch(/if \(bootPolicy\.envSidecars\) \{\s*collectSidecarsFromEnv\(db,/);
    expect(src).toContain("const bootPolicy = bootPolicyFor(paths);");
  });
});
```

(If `beforeEach`/`afterEach` are not yet imported from `bun:test` in this file, add them to that import.)

- [ ] **Step 2: Run the block**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I41"`
Expected: PASS (Tasks 1–4 already landed the wiring).

- [ ] **Step 3: Red-prove the wiring test**

Temporarily remove the `if (bootPolicy.envSidecars) {` guard in `assemble.ts` (call `collectSidecarsFromEnv` unconditionally), re-run Step 2's command, confirm the "clause 4 wiring" test FAILS, then restore it and confirm PASS.

- [ ] **Step 4: Write the SECURITY-INVARIANTS.md section**

In `docs/SECURITY-INVARIANTS.md` line 3, change `invariants I1–I40` to `invariants I1–I41` and add `I41` to the list of invariants with no static rule (`I31, I32, I34, I36 and I41 have no static rule`). Append after the I40 section:

```markdown
## I41 — a demo-rooted process never reaches the real install

**Statement.** A process started with `NIMBUS_DEMO=1` (the CLI's global `--demo` sets it) (1) resolves every config, data, log and extensions path INSIDE the demo root `<realDataDir>/demo`, and no real path lies inside that root; (2) resolves a `tempDir` (`<tmpdir>/nimbus-demo`) and an IPC endpoint that differ from the real ones — on Windows the pipe name carries a hash of the demo root, because named pipes are machine-global; (3) never opens the OS credential store — `vault/factory.ts` returns an in-process, never-persisted `EphemeralVault` before its platform switch; and (4) never runs a host-global boot action scoped by its OWN index (the Windows AppContainer boot reap) and never starts the env-selected HTTP or metrics sidecars (`platform/demo-boot.ts`). An ambiguous `NIMBUS_DEMO` value (anything but unset, `""`, `"0"` or `"1"`) and `NIMBUS_DEMO=1` combined with `NIMBUS_CONFIG_DIR` or `NIMBUS_GATEWAY_SOCKET` both REFUSE at path resolution rather than choosing a winner.

**Why path isolation alone was not enough.** Three pieces of state are host-global rather than path-derived. On macOS the Vault is the Keychain under the fixed service `dev.nimbus` (only a key index lives under `configDir`), and on Linux it is libsecret with no path at all — so a demo gateway would read the owner's credentials, and `sweepToolgenCredentials`, which runs at every boot and shutdown, would delete the owner's `toolgen.*` credentials. The AppContainer reap deletes every profile whose extension id is absent from `liveExtensionIds(db)`, and a demo index holds none of the owner's installed extensions. The HTTP API and metrics sidecars are selected by `NIMBUS_HTTP_PORT` / `NIMBUS_METRICS_PORT`, so a demo gateway inheriting them would either crash on the port or serve the demo index on the owner's real port.

**Why clause (1) is a subtree rule.** On macOS `configDir` and `dataDir` are the same directory (`~/Library/Application Support/Nimbus`), so the demo root necessarily sits under the real config directory. The property that matters is that a demo process can reach no real FILE, which is exactly "every path it resolves is inside a subtree that holds no real path".

**How a component knows it is in a demo process.** `PlatformPaths.demo` (`true` or absent) is set ONLY by the three `create*Paths` resolvers. The vault factory and the boot policy branch on that field, never on the environment variable, so an injected `PlatformPaths` cannot be half-demo.

**Mirrored resolution.** The CLI may not import gateway source, so `packages/cli/src/lib/demo-root.ts` mirrors `packages/gateway/src/platform/demo-root.ts`; `scripts/parity/demo-root.parity.test.ts` fails when they diverge. The CLI applies `--demo` before it resolves any path, since it opens its log file ahead of dispatch.

**Static rule: none.** Like I34, the property is a computed value (a resolved path, a constructed vault) rather than a source-scannable shape. The one piece of wiring that IS a shape — `assemble.ts` consulting the boot policy at exactly one reap call and one sidecar call — is pinned by the enforcement test.

**Bounds, stated.** A demo gateway still shares the OS itself: the Windows sandbox runner's capability probe creates and deletes a throwaway `nimbus-ext-probe` AppContainer profile at every boot, demo or not, exactly as two real gateways would. And a demo gateway that spawns a first-party connector would use the same per-extension AppContainer profile name as the real gateway; PR 1 configures no connector and nothing spawns one, and the synthetic-corpus slice that follows starts no sync scheduler in a demo gateway at all.

**Wiring:** `platform/{paths,demo-root,demo-boot,assemble}.ts`, `vault/{factory,ephemeral}.ts`, `cli/src/{paths,index}.ts`, `cli/src/lib/{demo-root,demo-flag,with-gateway-ipc}.ts`. **Test:** `security-invariants.test.ts` `I41`; e2e `test/e2e/demo-root-isolation.e2e.test.ts`.
```

- [ ] **Step 5: Add the CLAUDE.md / GEMINI.md bullet**

In both `CLAUDE.md` and `GEMINI.md`, append after the I40 bullet in the Security Invariants list:

```markdown
- **I41** — a demo-rooted process (`NIMBUS_DEMO=1`, the CLI's global `--demo`) never reaches the real install: every config/data/log/extensions path resolves INSIDE `<realDataDir>/demo` and no real path lies inside it (a subtree rule, because macOS `configDir === dataDir`); `tempDir` and the IPC endpoint differ (the Windows pipe name hashes the demo root — named pipes are machine-global); the vault factory returns an in-process `EphemeralVault` BEFORE its OS switch (the macOS Keychain and Linux libsecret are not under `configDir`, and the boot/shutdown `sweepToolgenCredentials` would otherwise delete real `toolgen.*` credentials); and the gateway skips the Windows AppContainer boot reap (scoped by its OWN index) and the env-selected HTTP/metrics sidecars. An ambiguous `NIMBUS_DEMO` value, or demo combined with `NIMBUS_CONFIG_DIR`/`NIMBUS_GATEWAY_SOCKET`, refuses. No static rule — a computed value, like I34; `assemble.ts`'s two guarded call sites are pinned by the test · `platform/{demo-root,demo-boot,paths}.ts`, `vault/{factory,ephemeral}.ts`, `cli/src/lib/{demo-root,demo-flag}.ts`
```

- [ ] **Step 6: Sweep every ceiling the audit derives**

Run: `bun run audit:status-drift`
Expected: FAIL, listing every surface that still says `I…–I40` / "through I40" (the canonical ceiling is now derived as I41 from the new test block). Fix EACH one it names — in `CLAUDE.md` and `GEMINI.md` that includes "Invariants through I40", "(I1–I27, I29–I40)" and the `docs/SECURITY-INVARIANTS.md` "I1–I40 rationale" line in See Also. Re-run until it passes. Then `grep -rn "I40\b" CLAUDE.md GEMINI.md docs/architecture.md docs/README.md .github/SECURITY.md .coderabbit.yaml .claude/commands/` and read every remaining hit: a range or "through" phrasing must now end at I41; a hit that names I40 itself (its own bullet) stays.

- [ ] **Step 7: Run the doc gates**

Run: `bun run audit:status-drift && bun run audit:doc-refs`
Expected: both PASS.

- [ ] **Step 8: Commit (the triple-rule commit)**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git add -u
git commit -m "feat(security): invariant I41 - a demo-rooted process never reaches the real install"
```

(`git add -u` picks up the other surfaces Step 6 edited. Run `git status` first and confirm nothing unrelated is staged.)

---

### Task 6: Gateway e2e — the real entry, booted demo-rooted on temp roots

**Files:**
- Create: `packages/gateway/test/e2e/demo-root-isolation.e2e.test.ts`

**Interfaces:**
- Consumes: the whole of Tasks 1–4 through the REAL entry `packages/gateway/src/index.ts` (NOT `_fixtures/gateway-runner.ts`, which injects `PlatformPaths` via `NIMBUS_E2E_PATHS_JSON` and would bypass the resolution under test). The gateway prints `[gateway] ready (<version>) IPC <socketPath>` once bound (`gateway-main.ts`), and answers `gateway.ping`.

**Why only a demo gateway boots here** (spec § 6, changed at plan time): booting a NON-demo gateway from the real entry would open the developer's real OS credential store on macOS/Linux, and `gateway-main.ts`'s boot sweep deletes `toolgen.*` credentials there — the test would itself be the damage I41 forbids. Distinct socket and state-file paths are already proven by Task 5.

- [ ] **Step 1: Write the test**

```ts
// The real gateway entry, booted with NIMBUS_DEMO=1 on temp OS roots. Proves end-to-end what the
// I41 unit tests prove per function: the resolved demo socket is what binds, the gateway answers
// there, it does not start the env-selected HTTP sidecar, and every file it wrote under the would-be
// REAL Nimbus directories is inside the demo root.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const BOOT_TIMEOUT_MS = 60_000;

// Short names: a macOS unix-socket path must stay under 104 bytes.
const root = mkdtempSync(join(tmpdir(), "nd-"));
const dirs = {
  roaming: join(root, "r"),
  local: join(root, "l"),
  home: join(root, "h"),
  xdgConfig: join(root, "c"),
  xdgData: join(root, "d"),
  run: join(root, "u"),
  tmp: join(root, "t"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

/** The REAL Nimbus directories each OS would use under these temp roots (mirrors platform/paths). */
function realNimbusDirs(): { dataDir: string; others: string[] } {
  if (process.platform === "win32") {
    return {
      dataDir: join(dirs.local, "Nimbus", "data"),
      others: [join(dirs.roaming, "Nimbus"), join(dirs.local, "Nimbus", "extensions")],
    };
  }
  if (process.platform === "darwin") {
    return { dataDir: join(dirs.home, "Library", "Application Support", "Nimbus"), others: [] };
  }
  return { dataDir: join(dirs.xdgData, "nimbus"), others: [join(dirs.xdgConfig, "nimbus")] };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function until(probe: () => boolean, what: string, ms: number): Promise<void> {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One JSON-RPC request over a fresh connection. */
function rpc(socketPath: string, method: string): Promise<{ result?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} })}\n`);
    });
    sock.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      if (msg["id"] !== 1) return; // a notification; keep reading
      sock.end();
      resolve({ result: msg["result"], error: msg["error"] });
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

let proc: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
let socketPath = "";
let httpPort = 0;

beforeAll(async () => {
  httpPort = await freePort();
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of [
    "NIMBUS_CONFIG_DIR",
    "NIMBUS_GATEWAY_SOCKET",
    "NIMBUS_E2E_PATHS_JSON",
    "NIMBUS_PROFILE",
    "NIMBUS_METRICS_PORT",
  ]) {
    delete env[k];
  }
  Object.assign(env, {
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
    NIMBUS_HTTP_PORT: String(httpPort),
    NIMBUS_DEMO: "1",
  });

  // Premise: the child must resolve homedir() to the temp HOME, or on macOS this test would boot
  // against the developer's REAL ~/Library/Application Support/Nimbus. Fail, never proceed.
  const probe = Bun.spawn({
    cmd: [process.execPath, "-e", "process.stdout.write(require('node:os').homedir())"],
    stdout: "pipe",
    env,
  });
  const childHome = await new Response(probe.stdout).text();
  await probe.exited;
  if (childHome !== dirs.home) {
    throw new Error(`premise failed: child homedir() is ${childHome}, expected ${dirs.home}`);
  }

  proc = Bun.spawn([process.execPath, ENTRY], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const collect = async (s: ReadableStream<Uint8Array>): Promise<void> => {
    const d = new TextDecoder();
    for await (const chunk of s) output += d.decode(chunk);
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);
  try {
    await until(() => /\[gateway\] ready \(.+\) IPC (.+)/.test(output), "demo gateway ready", BOOT_TIMEOUT_MS);
  } catch (e) {
    proc.kill();
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- output ---\n${output.slice(-4000)}`);
  }
  socketPath = (/\[gateway\] ready \(.+\) IPC (.+)/.exec(output)?.[1] ?? "").trim();
}, BOOT_TIMEOUT_MS + 30_000);

afterAll(async () => {
  if (proc !== undefined) {
    proc.kill();
    await proc.exited;
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort — a Windows handle release can lag behind process exit */
  }
});

describe("I41 e2e: the real gateway entry, demo-rooted", () => {
  const demoRoot = join(realNimbusDirs().dataDir, "demo");

  test("binds the DEMO endpoint derived from the demo root", () => {
    if (process.platform === "win32") {
      expect(socketPath).toMatch(/^\\\\\.\\pipe\\nimbus-gateway-demo-[0-9a-f]{12}$/);
    } else {
      const dir = process.platform === "darwin" ? dirs.tmp : dirs.run;
      expect(socketPath).toBe(join(dir, "nimbus-gateway-demo.sock"));
    }
  });

  test("answers gateway.ping on that endpoint", async () => {
    const r = await rpc(socketPath, "gateway.ping");
    expect(r.error).toBeUndefined();
  });

  test("the index and the state file are inside the demo root (positive control)", () => {
    expect(existsSync(join(demoRoot, "data", "nimbus.db"))).toBe(true);
    expect(existsSync(join(demoRoot, "data", "gateway.json"))).toBe(true);
  });

  test("does not start the env-selected HTTP sidecar", async () => {
    expect(await canConnect(httpPort)).toBe(false);
  });

  test("every file under the would-be REAL Nimbus directories is inside the demo root", () => {
    const { dataDir, others } = realNimbusDirs();
    const stray = [dataDir, ...others].flatMap(filesUnder).filter((f) => !isInside(f, demoRoot));
    expect(stray).toEqual([]);
    expect(existsSync(join(dirs.tmp, "nimbus"))).toBe(false); // the REAL tempDir
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/test/e2e/demo-root-isolation.e2e.test.ts --timeout 120000`
Expected: PASS. On a fresh worktree build the sandbox helper first (Global Constraints). If boot fails, read the `--- output ---` tail before changing anything.

- [ ] **Step 3: Red-prove the isolation assertion**

Temporarily change `deriveDemoPaths` in `packages/gateway/src/platform/demo-root.ts` so `logDir` is `real.logDir` (the REAL log dir), re-run Step 2, confirm "every file under the would-be REAL Nimbus directories…" FAILS naming a log file, then revert and confirm PASS. Also temporarily delete the `if (bootPolicy.envSidecars)` guard and confirm "does not start the env-selected HTTP sidecar" FAILS; revert.

- [ ] **Step 4: Lint and commit**

```bash
bunx biome check packages/gateway/test/e2e/demo-root-isolation.e2e.test.ts
git rev-parse --abbrev-ref HEAD
git add packages/gateway/test/e2e/demo-root-isolation.e2e.test.ts
git commit -m "test(e2e): the real gateway entry, booted demo-rooted, writes only inside the demo root"
```

---

### Task 7: User docs, CHANGELOG, full preflight, PR

**Files:**
- Modify: `docs/cli-reference.md` (Global Flags table at line 13; env section around 74–76; env table around 4748)
- Modify: `docs/architecture.md` (the platform-paths / PAL section — locate with `grep -n "NIMBUS_CONFIG_DIR\|PlatformPaths" docs/architecture.md`)
- Modify: `docs/CHANGELOG.md` (new top entry under `## Post-Phase-6 deliveries`)

- [ ] **Step 1: Correct every restatement of "the data dir cannot move"**

Run: `grep -rn -i "not relocatable\|no data-directory override\|dataDir. deliberately\|never the data directory\|does \*\*not\*\* move the data directory" docs/ CLAUDE.md GEMINI.md packages/gateway/src/platform/paths.ts packages/cli/src/paths.ts`

For each hit decide: a statement about `NIMBUS_CONFIG_DIR` / `NIMBUS_GATEWAY_SOCKET` alone stays true — leave it. A statement that NO variable can move the data dir (e.g. `cli-reference.md` ~4748 "the data directory is not relocatable by any `NIMBUS_*` variable") is now false — reword to: "…not relocatable by any `NIMBUS_*` variable except `NIMBUS_DEMO=1`, which moves EVERY path into the isolated demo subtree `<dataDir>/demo` (invariant I41) rather than repointing the real one."

- [ ] **Step 2: Document `--demo` / `NIMBUS_DEMO`**

In `docs/cli-reference.md` Global Flags table add:

```markdown
| `--demo` | Run this command against the isolated **demo root** (`<data dir>/demo`) instead of your real install: its own config, data, logs, vault and IPC endpoint. Global — stripped before the command runs, so `nimbus --demo status` runs `status`. Equivalent to `NIMBUS_DEMO=1`. The demo root starts empty. See invariant I41. |
```

and in the env-var table:

```markdown
| `NIMBUS_DEMO` | `1` runs the CLI and any Gateway it starts against the isolated demo root (invariant I41). Unset, empty or `0` is off; any other value is refused. Cannot be combined with `NIMBUS_CONFIG_DIR` or `NIMBUS_GATEWAY_SOCKET` — the combination is refused, because a demo process honouring either would reach your real config, Vault or gateway. A demo Gateway opens no OS credential store (an in-memory vault), does not reap Windows AppContainer profiles, and ignores `NIMBUS_HTTP_PORT` / `NIMBUS_METRICS_PORT`. |
```

Do NOT mention `nimbus demo` (the command ships in PR 2 — a doc must not cite an unshipped command).

- [ ] **Step 3: architecture.md paragraph**

Next to the existing `PlatformPaths` / `NIMBUS_CONFIG_DIR` discussion, add:

```markdown
**The demo root (`NIMBUS_DEMO=1`, the CLI's global `--demo`).** A second, throwaway Nimbus inside
`<dataDir>/demo`, resolved by `platform/demo-root.ts` (mirrored in `cli/src/lib/demo-root.ts`, held
equal by `scripts/parity/demo-root.parity.test.ts`). Every config/data/log/extensions path moves into
that subtree, `tempDir` becomes `<tmpdir>/nimbus-demo`, and the IPC endpoint gets a demo name (hashed
from the demo root on Windows, where pipes are machine-global). The resolvers mark the result
`PlatformPaths.demo = true`, and that field — never the env var — is the one signal the rest of the
gateway reads: the vault factory returns an in-memory `EphemeralVault`, and `platform/demo-boot.ts`
switches off the Windows AppContainer boot reap and the env-selected HTTP/metrics sidecars, the three
pieces of host-global state path isolation cannot reach. Rationale and bounds:
`SECURITY-INVARIANTS.md` § I41.
```

- [ ] **Step 4: CHANGELOG entry**

At the top of `## Post-Phase-6 deliveries` in `docs/CHANGELOG.md`:

```markdown
- **2026-09-18 — An isolated demo root: `nimbus --demo …` / `NIMBUS_DEMO=1` (invariant I41).** The
  first half of the `nimbus demo` First-Run row: a second, throwaway Nimbus inside `<data dir>/demo`
  with its own config, data, logs and IPC endpoint, which the synthetic-org corpus will be seeded into
  next. Path isolation turned out not to be isolation: on macOS the Vault is the Keychain under a
  fixed service name and on Linux it is libsecret, neither under the config dir, so a demo gateway
  would have READ the owner's credentials — and the toolgen credential sweep that runs at every boot
  and shutdown would have DELETED the owner's `toolgen.*` credentials. The Windows AppContainer boot
  reap is scoped by the gateway's OWN index, so a demo boot would have deleted the real gateway's
  extension profiles; and the HTTP/metrics sidecars are env-selected. A demo gateway therefore opens
  an in-memory vault, skips the reap, and starts neither sidecar. `NIMBUS_DEMO` refuses an ambiguous
  value and refuses to combine with `NIMBUS_CONFIG_DIR` / `NIMBUS_GATEWAY_SOCKET`. No schema
  migration, no new egress class, no new IPC method. Design: `2026-09-18-nimbus-demo-design.md`.
```

- [ ] **Step 4b: CLI smoke — `start` / `status` / `stop` against the demo root, on TEMP roots**

Spec § 3.4 promises `nimbus --demo status` against an isolated gateway; Task 6 boots the gateway
directly, so the CLI's own `start` path (which spawns the gateway with the inherited `NIMBUS_DEMO`)
is otherwise unexercised. From Git Bash in the worktree:

```bash
R=$(mktemp -d)
export APPDATA="$R/r" LOCALAPPDATA="$R/l" HOME="$R/h" USERPROFILE="$R/h" \
  XDG_CONFIG_HOME="$R/c" XDG_DATA_HOME="$R/d" XDG_RUNTIME_DIR="$R/u" \
  TMPDIR="$R/t" TEMP="$R/t" TMP="$R/t" NIMBUS_SKIP_EMBEDDING_RUNTIME=1
mkdir -p "$R"/{r,l,h,c,d,u,t}
unset NIMBUS_CONFIG_DIR NIMBUS_GATEWAY_SOCKET NIMBUS_DEMO
bun packages/cli/src/index.ts --demo start
bun packages/cli/src/index.ts --demo status
bun packages/cli/src/index.ts --demo stop
find "$R" -name gateway.json -o -name nimbus.db
```

Expected: `start` reports the gateway up; `status` answers; `stop` stops it; the `find` lists paths
ONLY under `…/demo/data/`. Run it in a fresh shell (the `export`s must not leak into a later
command that should see your real roots). If `status` reports "not running" while `start` succeeded,
the CLI and gateway disagree on the demo socket — the parity test (Task 2) should have caught that,
so investigate before continuing. Then `rm -rf "$R"`.

- [ ] **Step 5: Full preflight**

Run: `bun run preflight`
Expected: PASS. Then `bun run audit:platform-test-gaps` and read what it names — the Windows pipe assertion and the darwin/linux socket assertion each run on only one OS, so CI's cross-platform legs are their first execution elsewhere. If the coverage floor fails for a new file, use the `nimbus-coverage-floor` agent rather than excluding the file.

- [ ] **Step 6: Commit docs**

```bash
git rev-parse --abbrev-ref HEAD
git add docs/cli-reference.md docs/architecture.md docs/CHANGELOG.md
git add -u
git status
git commit -m "docs: the isolated demo root (--demo / NIMBUS_DEMO) and invariant I41"
```

- [ ] **Step 7: Strip the branch-only design docs, then open the PR**

Specs and plans never land on `main` (squash takes the net diff). The spec is still needed for PR 2, so record the SHA first:

```bash
git log --oneline -1 -- docs/superpowers/specs/2026-09-18-nimbus-demo-design.md
git rm -r docs/superpowers
git commit -m "chore: drop branch-only design docs before merge (recoverable from history)"
git push -u origin dev/asafgolombek/nimbus-demo
```

Open the PR with title `feat: isolated demo root for nimbus --demo (invariant I41)` (the title IS the squash commit subject release-please parses — `feat`, no `!`: no existing user has to change anything). The description becomes the permanent commit body: summarise the four I41 clauses, the three host-global findings, the plan-time change to the e2e (no non-demo gateway boots in the test, and why), and "PR 2 of 2 follows: the synthetic corpus, `demo.seed`, and the tour". End it with the attribution line. Do NOT put a bare `Release-As:` line in it. Use `gh pr create` with `--body-file`. Do not merge — wait for `PR quality — required gates`; merging is the owner's call.
```
