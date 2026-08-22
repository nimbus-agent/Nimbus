# Sandboxed Code Execution (S2 Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the machine's owner run arbitrary code inside the existing three-OS sandbox, behind the HITL consent gate, with a complete audit record — the first thing to ship in the S2 (Local Compute Fleet) slot.

**Architecture:** A single dedicated chokepoint, `exec/exec-gate.ts`, owns the whole path: resolve runtime from a registry → build a `SandboxPolicy` with network unconditionally empty → assert the runner will actually confine → read the script once → get owner consent on those exact bytes → spawn through the existing `createSandboxRunner()` → capture bounded output → append one audit row. This mirrors the established pattern for high-blast-radius *local* capabilities (`share/share-gate.ts` I27, `tribal/tribal-write-gate.ts` I25, `federation/preflight-gate.ts` I24) rather than routing through the connector-shaped `ToolExecutor.gate()`.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:sqlite`, `@noble/hashes/blake3.js`, Biome. No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-22-s2-sandboxed-code-execution-design.md`](../specs/2026-08-22-s2-sandboxed-code-execution-design.md) — read it before starting; this plan argues from it.

## Global Constraints

- **No `any`.** External/cross-process data is `unknown` and must be validated at the boundary. TypeScript strict is non-negotiable.
- **Local-first.** No remote sandbox adapters. No network egress of any kind from this slice.
- **HITL is structural.** The consent gate lives in `exec-gate.ts`, never in a prompt, and cannot be configured away. Standing approvals are explicitly unsupported.
- **Invariant triple rule.** Wiring + `docs/SECURITY-INVARIANTS.md` entry + `security-invariants.test.ts` case land in **one commit** (Task 7).
- **Cross-platform.** Build paths with `path.join()` / `path.resolve()`; never hardcode separators. `bun run audit:cross-platform` must stay green.
- **Default off.** `[code_execution] enabled = false`.
- **Config values:** `max_wall_clock_ms = 30000`, `max_output_bytes = 1048576`, `allowed_runtimes = ["bun"]`.
- **Digests are BLAKE3**, via `import { blake3 } from "@noble/hashes/blake3.js"` — the same primitive `db/audit-chain.ts` uses.
- **Exit codes:** `10` denied · `11` timeout · `12` refused-before-consent · `13` wall-clock kill · `14` output-cap kill. A script's own code passes through unchanged.
- **Never commit on `main`.** Work on `dev/asaf/s2-code-execution`.
- **Before pushing:** `bun run preflight:fast`, and `bun run preflight` if logic or tests changed.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/config/nimbus-toml.ts` (modify) | `[code_execution]` block parse |
| `packages/gateway/src/exec/exec-runtimes.ts` (create) | Runtime registry: id → detect + argv; extension mapping |
| `packages/gateway/src/exec/exec-policy.ts` (create) | Grants → `SandboxPolicy`; absolute-path precondition; network refusal |
| `packages/gateway/src/exec/exec-consent-broker.ts` (create) | Owner approval round-trip |
| `packages/gateway/src/exec/exec-run.ts` (create) | Confined spawn + bounded capture + kills |
| `packages/gateway/src/exec/exec-result.ts` (create) | `ExecResult` / `TerminationReason` types |
| `packages/gateway/src/policy/{types,policy-toml,policy-gate}.ts` (modify) | `capabilities.disabled` set, union resolution |
| `packages/gateway/src/exec/exec-gate.ts` (create) | **The chokepoint.** Everything above, in order |
| `packages/gateway/src/ipc/exec-rpc.ts` (create) | `exec.run` / `exec.approvalRespond` |
| `packages/cli/src/commands/exec.ts` (create) | `nimbus exec`, path resolution, exit codes |

---

## Task 1: `[code_execution]` config block

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `NimbusCodeExecutionToml`, `DEFAULT_NIMBUS_CODE_EXECUTION_TOML`, `parseNimbusCodeExecutionToml(raw, defaults?)`, `loadNimbusCodeExecutionFromConfigDir(configDir)`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/config/nimbus-toml.test.ts`. Copy the file's existing cleanup hooks into this describe if it has any — a describe appended to an existing test file that omits them is a known recurring defect here.

```ts
describe("[code_execution] config", () => {
  test("defaults are off with the documented caps", () => {
    const c = parseNimbusCodeExecutionToml("");
    expect(c.enabled).toBe(false);
    expect(c.maxWallClockMs).toBe(30_000);
    expect(c.maxOutputBytes).toBe(1_048_576);
    expect(c.allowedRuntimes).toEqual(["bun"]);
  });

  test("parses an explicit block", () => {
    const c = parseNimbusCodeExecutionToml(
      `[code_execution]\nenabled = true\nmax_wall_clock_ms = 5000\nmax_output_bytes = 2048\nallowed_runtimes = ["bun"]\n`,
    );
    expect(c.enabled).toBe(true);
    expect(c.maxWallClockMs).toBe(5000);
    expect(c.maxOutputBytes).toBe(2048);
  });

  test("rejects non-positive limits rather than accepting them", () => {
    const c = parseNimbusCodeExecutionToml(
      `[code_execution]\nmax_wall_clock_ms = 0\nmax_output_bytes = -1\n`,
    );
    expect(c.maxWallClockMs).toBe(30_000);
    expect(c.maxOutputBytes).toBe(1_048_576);
  });

  test("an unknown runtime name in allowed_runtimes is dropped, not carried", () => {
    const c = parseNimbusCodeExecutionToml(
      `[code_execution]\nallowed_runtimes = ["bun", "cobol"]\n`,
    );
    expect(c.allowedRuntimes).toEqual(["bun"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts -t "code_execution"`
Expected: FAIL — `parseNimbusCodeExecutionToml is not defined`.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/gateway/src/config/nimbus-toml.ts`, following the `NimbusLanToml` block at `:456-540` exactly.

```ts
/** Runtime ids this build can actually execute. Config naming an unknown id drops it. */
export const KNOWN_EXEC_RUNTIMES = ["bun"] as const;

export type NimbusCodeExecutionToml = {
  enabled: boolean;
  maxWallClockMs: number;
  maxOutputBytes: number;
  allowedRuntimes: string[];
};

export const DEFAULT_NIMBUS_CODE_EXECUTION_TOML: NimbusCodeExecutionToml = {
  enabled: false,
  maxWallClockMs: 30_000,
  maxOutputBytes: 1_048_576,
  allowedRuntimes: ["bun"],
};

function parseAllowedRuntimes(valRaw: string): string[] {
  const known = new Set<string>(KNOWN_EXEC_RUNTIMES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of parseStringArray(valRaw)) {
    const id = v.trim().toLowerCase();
    if (id === "" || seen.has(id) || !known.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function applyNimbusCodeExecutionKey(
  out: Partial<NimbusCodeExecutionToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "max_wall_clock_ms": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxWallClockMs = n;
      break;
    }
    case "max_output_bytes": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxOutputBytes = n;
      break;
    }
    case "allowed_runtimes":
      out.allowedRuntimes = parseAllowedRuntimes(valRaw);
      break;
    default:
      break;
  }
}

function parseNimbusTomlCodeExecutionSection(
  source: string,
): Partial<NimbusCodeExecutionToml> {
  const out: Partial<NimbusCodeExecutionToml> = {};
  forEachSectionEntry(source, "[code_execution]", (key, valRaw) => {
    applyNimbusCodeExecutionKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusCodeExecutionToml(
  raw: string,
  defaults: NimbusCodeExecutionToml = DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
): NimbusCodeExecutionToml {
  return { ...defaults, ...parseNimbusTomlCodeExecutionSection(raw) };
}

export function loadNimbusCodeExecutionFromPath(tomlPath: string): NimbusCodeExecutionToml {
  return loadTomlSection(
    tomlPath,
    DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
    parseNimbusCodeExecutionToml,
  );
}

export function loadNimbusCodeExecutionFromConfigDir(
  configDir: string,
): NimbusCodeExecutionToml {
  return loadNimbusCodeExecutionFromPath(join(configDir, "nimbus.toml"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts -t "code_execution"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.test.ts
git commit -m "feat(exec): add the default-off [code_execution] config block"
```

---

## Task 2: `ExecRuntime` registry

**Files:**
- Create: `packages/gateway/src/exec/exec-runtimes.ts`
- Test: `packages/gateway/src/exec/exec-runtimes.test.ts`

**Interfaces:**
- Consumes: `KNOWN_EXEC_RUNTIMES` from Task 1.
- Produces:
  - `interface ExecRuntime { readonly id: string; detect(): string | null; argvFor(scriptPath: string): { cmd: string; args: string[] } }`
  - `resolveRuntimeById(id: string): ExecRuntime` — throws `ExecRuntimeError`
  - `resolveRuntimeForFile(filePath: string): ExecRuntime` — throws `ExecRuntimeError`
  - `class ExecRuntimeError extends Error { readonly code: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import {
  ExecRuntimeError,
  resolveRuntimeById,
  resolveRuntimeForFile,
} from "./exec-runtimes.ts";

describe("ExecRuntime registry", () => {
  test("resolves bun by id and produces a runnable argv", () => {
    const rt = resolveRuntimeById("bun");
    expect(rt.id).toBe("bun");
    const { cmd, args } = rt.argvFor("/tmp/s.ts");
    expect(cmd).not.toBe("");
    expect(args).toEqual(["run", "/tmp/s.ts"]);
  });

  test("an unknown id is a named error, not a fallback", () => {
    expect(() => resolveRuntimeById("cobol")).toThrow(ExecRuntimeError);
    try {
      resolveRuntimeById("cobol");
    } catch (e) {
      expect((e as ExecRuntimeError).code).toBe("ERR_EXEC_UNKNOWN_RUNTIME");
    }
  });

  test("maps a .ts/.js/.mjs file to bun", () => {
    for (const p of ["/tmp/a.ts", "/tmp/a.js", "/tmp/a.mjs"]) {
      expect(resolveRuntimeForFile(p).id).toBe("bun");
    }
  });

  test("an unrecognised extension is REJECTED, never defaulted to the sole entry", () => {
    try {
      resolveRuntimeForFile("/tmp/a.py");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExecRuntimeError);
      expect((e as ExecRuntimeError).code).toBe("ERR_EXEC_UNKNOWN_EXTENSION");
    }
  });

  test("extension matching is case-insensitive", () => {
    expect(resolveRuntimeForFile("/tmp/A.TS").id).toBe("bun");
  });

  test("detect() returns an absolute path to a real binary", () => {
    expect(resolveRuntimeById("bun").detect()).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/exec/exec-runtimes.test.ts`
Expected: FAIL — cannot resolve `./exec-runtimes.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { extname } from "node:path";

/** A named error so a caller can distinguish refusal reasons without string matching. */
export class ExecRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecRuntimeError";
  }
}

export interface ExecRuntime {
  readonly id: string;
  /** Absolute path to the interpreter, or null when it is not installed. */
  detect(): string | null;
  argvFor(scriptPath: string): { cmd: string; args: string[] };
}

const BUN_RUNTIME: ExecRuntime = {
  id: "bun",
  // The Gateway IS a Bun process, so the interpreter is always the one running us.
  // That is why bun needs no PATH probing and can never be "allowed but missing".
  detect: () => process.execPath,
  argvFor: (scriptPath) => ({ cmd: process.execPath, args: ["run", scriptPath] }),
};

const REGISTRY: ReadonlyMap<string, ExecRuntime> = new Map([["bun", BUN_RUNTIME]]);

/**
 * Extension -> runtime id. Adding Python later adds a row here; it does NOT change what an
 * already-mapped extension does. An unmapped extension is rejected rather than defaulted,
 * so `script.py` fails loudly today instead of silently changing meaning later.
 */
const EXTENSION_MAP: ReadonlyMap<string, string> = new Map([
  [".ts", "bun"],
  [".js", "bun"],
  [".mjs", "bun"],
]);

export function resolveRuntimeById(id: string): ExecRuntime {
  const rt = REGISTRY.get(id.trim().toLowerCase());
  if (rt === undefined) {
    throw new ExecRuntimeError("ERR_EXEC_UNKNOWN_RUNTIME", `unknown runtime: ${id}`);
  }
  return rt;
}

export function resolveRuntimeForFile(filePath: string): ExecRuntime {
  const ext = extname(filePath).toLowerCase();
  const id = EXTENSION_MAP.get(ext);
  if (id === undefined) {
    throw new ExecRuntimeError(
      "ERR_EXEC_UNKNOWN_EXTENSION",
      `no runtime is registered for extension "${ext}"`,
    );
  }
  return resolveRuntimeById(id);
}

/** Fail before consent when a registered runtime is not installed on this machine. */
export function requireInstalled(rt: ExecRuntime): string {
  const bin = rt.detect();
  if (bin === null) {
    throw new ExecRuntimeError(
      "ERR_EXEC_RUNTIME_NOT_INSTALLED",
      `runtime "${rt.id}" is registered but not installed`,
    );
  }
  return bin;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/exec/exec-runtimes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/exec/exec-runtimes.ts packages/gateway/src/exec/exec-runtimes.test.ts
git commit -m "feat(exec): add the ExecRuntime registry with bun wired"
```

---

## Task 3: `exec-policy.ts` — grants to `SandboxPolicy`

**Files:**
- Create: `packages/gateway/src/exec/exec-policy.ts`
- Test: `packages/gateway/src/exec/exec-policy.test.ts`

**Interfaces:**
- Consumes: `SandboxPolicy` from `../platform/sandbox/sandbox-policy.ts`.
- Produces:
  - `interface ExecGrants { readonly fsRead: readonly string[]; readonly fsWrite: readonly string[]; readonly network?: readonly string[] }`
  - `buildExecPolicy(executionId: string, grants: ExecGrants): SandboxPolicy`
  - `class ExecPolicyError extends Error { readonly code: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildExecPolicy, ExecPolicyError } from "./exec-policy.ts";

const ABS = process.platform === "win32" ? "C:\\tmp\\work" : "/tmp/work";

describe("buildExecPolicy", () => {
  test("network is always empty", () => {
    const p = buildExecPolicy("e1", { fsRead: [ABS], fsWrite: [] });
    expect(p.permissions.network).toEqual([]);
  });

  test("a REQUESTED network grant is rejected, never silently dropped", () => {
    try {
      buildExecPolicy("e1", { fsRead: [], fsWrite: [], network: ["example.com"] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ExecPolicyError);
      expect((e as ExecPolicyError).code).toBe("ERR_EXEC_NETWORK_UNSUPPORTED");
    }
  });

  test("an empty requested network array is fine (nothing was asked for)", () => {
    expect(() =>
      buildExecPolicy("e1", { fsRead: [], fsWrite: [], network: [] }),
    ).not.toThrow();
  });

  test("a RELATIVE path is rejected, not resolved gateway-side", () => {
    try {
      buildExecPolicy("e1", { fsRead: ["./src"], fsWrite: [] });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ExecPolicyError).code).toBe("ERR_EXEC_RELATIVE_PATH");
    }
  });

  test("rejects a relative WRITE path too", () => {
    expect(() => buildExecPolicy("e1", { fsRead: [], fsWrite: ["out"] })).toThrow(
      ExecPolicyError,
    );
  });

  test("carries absolute grants through and names the policy by execution id", () => {
    const p = buildExecPolicy("exec-42", { fsRead: [ABS], fsWrite: [ABS] });
    expect(p.id).toBe("exec-exec-42");
    expect(p.permissions.filesystem.read).toEqual([ABS]);
    expect(p.permissions.filesystem.write).toEqual([ABS]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/exec/exec-policy.test.ts`
Expected: FAIL — cannot resolve `./exec-policy.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { isAbsolute } from "node:path";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";

export class ExecPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecPolicyError";
  }
}

export interface ExecGrants {
  readonly fsRead: readonly string[];
  readonly fsWrite: readonly string[];
  /** Present only so a request for network can be REJECTED rather than ignored. */
  readonly network?: readonly string[];
}

function requireAbsolute(paths: readonly string[], what: string): string[] {
  for (const p of paths) {
    if (!isAbsolute(p)) {
      // Deliberately NOT resolved here. The gateway's cwd is not the CLI's cwd, so resolving
      // would grant a real directory that is not the one the user named -- wrong, and invisible
      // from this side. The CLI resolves; this side refuses anything it did not.
      throw new ExecPolicyError(
        "ERR_EXEC_RELATIVE_PATH",
        `${what} grant must be an absolute path: ${p}`,
      );
    }
  }
  return [...paths];
}

/**
 * The single grants -> policy derivation for a one-shot execution (I33).
 *
 * `permissions.network` is empty by CONSTRUCTION, not by a caller remembering to omit it, and a
 * caller that asks for network is refused. Slice 1 has no network path at all; the refusal is what
 * keeps that claim true rather than merely customary.
 */
export function buildExecPolicy(executionId: string, grants: ExecGrants): SandboxPolicy {
  if (grants.network !== undefined && grants.network.length > 0) {
    throw new ExecPolicyError(
      "ERR_EXEC_NETWORK_UNSUPPORTED",
      "network access is not available to sandboxed executions in this release",
    );
  }
  return {
    id: `exec-${executionId}`,
    permissions: {
      network: [],
      filesystem: {
        read: requireAbsolute(grants.fsRead, "read"),
        write: requireAbsolute(grants.fsWrite, "write"),
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/exec/exec-policy.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/exec/exec-policy.ts packages/gateway/src/exec/exec-policy.test.ts
git commit -m "feat(exec): derive a network-free SandboxPolicy from execution grants"
```

---

## Task 4: `ExecConsentBroker`

**Files:**
- Create: `packages/gateway/src/exec/exec-consent-broker.ts`
- Test: `packages/gateway/src/exec/exec-consent-broker.test.ts`

**Interfaces:**
- Consumes: `ConsentBroker` from `../util/consent-broker.ts`.
- Produces: `interface ExecApprovalInput`, `class ExecConsentBroker extends ConsentBroker<ExecApprovalInput>`, `const execConsent: ExecConsentBroker`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { ExecConsentBroker } from "./exec-consent-broker.ts";

const brokers: ExecConsentBroker[] = [];
function makeBroker(): ExecConsentBroker {
  const b = new ExecConsentBroker();
  brokers.push(b);
  return b;
}

// Every pending request holds a live (deliberately non-unref'd) TTL timer. Without this hook a
// test that leaves one pending hangs `bun test` teardown on Windows.
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
});

const INPUT = {
  executionId: "e1",
  runtime: "bun",
  codeBody: "console.log(1)",
  grants: { fsRead: [], fsWrite: [], network: [] as string[] },
  wallClockMs: 1000,
  cwd: "/tmp",
};

describe("ExecConsentBroker", () => {
  test("broadcasts exec.approvalRequest with a requestId", async () => {
    const b = makeBroker();
    const seen: Array<{ method: string; params: unknown }> = [];
    b.setBroadcast((method, params) => {
      seen.push({ method, params });
    });
    const p = b.request(INPUT, 5000);
    expect(seen[0]?.method).toBe("exec.approvalRequest");
    const id = (seen[0]?.params as { requestId: string }).requestId;
    b.respond(id, true);
    expect(await p).toBe(true);
  });

  test("TWO concurrent requests resolve independently", async () => {
    const b = makeBroker();
    const ids: string[] = [];
    b.setBroadcast((_m, params) => {
      ids.push((params as { requestId: string }).requestId);
    });
    const first = b.request(INPUT, 5000);
    const second = b.request(INPUT, 5000);
    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);

    b.respond(ids[1] as string, true);
    expect(await second).toBe(true);
    // Answering one must NOT settle the other.
    expect(b.pendingIds()).toEqual([ids[0] as string]);

    b.respond(ids[0] as string, false);
    expect(await first).toBe(false);
  });

  test("fails closed when the owner never answers", async () => {
    const b = makeBroker();
    b.setBroadcast(() => {});
    expect(await b.request(INPUT, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/exec/exec-consent-broker.test.ts`
Expected: FAIL — cannot resolve `./exec-consent-broker.ts`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { ConsentBroker } from "../util/consent-broker.ts";

export interface ExecApprovalInput {
  readonly executionId: string;
  readonly runtime: string;
  /** The VERBATIM body the owner is consenting to -- never a digest. */
  readonly codeBody: string;
  readonly grants: {
    readonly fsRead: readonly string[];
    readonly fsWrite: readonly string[];
    readonly network: readonly string[];
  };
  readonly wallClockMs: number;
  readonly cwd: string;
}

/**
 * Owner-approval round-trip for a sandboxed code execution (I33): broadcasts
 * `exec.approvalRequest` and resolves when the owner answers via `exec.approvalRespond`
 * (fail-closed on TTL). Third thin binding over the shared {@link ConsentBroker}, after
 * `share/share-consent-broker.ts` and `federation/preflight-consent-broker.ts` -- concurrent
 * approvals therefore work with no extra machinery: the base keys each pending request by a
 * random `requestId` and gives it its own timer.
 */
export class ExecConsentBroker extends ConsentBroker<ExecApprovalInput> {
  constructor() {
    super("exec.approvalRequest");
  }
}

/** Process singleton shared by the IPC dispatcher and the exec-gate path. */
export const execConsent = new ExecConsentBroker();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/exec/exec-consent-broker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/exec/exec-consent-broker.ts packages/gateway/src/exec/exec-consent-broker.test.ts
git commit -m "feat(exec): add the owner-approval consent broker for executions"
```

---

## Task 5: Confined run with bounded output

**Files:**
- Create: `packages/gateway/src/exec/exec-result.ts`
- Create: `packages/gateway/src/exec/exec-run.ts`
- Test: `packages/gateway/src/exec/exec-run.test.ts`

**Interfaces:**
- Consumes: `SandboxRunner` from `../platform/sandbox/sandbox-runner.ts`; `SandboxPolicy` from Task 3.
- Produces:
  - `type TerminationReason = "exited" | "output_cap" | "wall_clock"`
  - `interface ExecResult { exitCode: number | null; stdout: string; stderr: string; durationMs: number; truncated: boolean; terminationReason: TerminationReason }`
  - `runConfined(runner, cmd, args, opts): Promise<ExecResult>` where `opts = { policy, cwd, maxOutputBytes, maxWallClockMs, now?: () => number }`

- [ ] **Step 1: Write the failing test**

A fake runner keeps this unit test off the real sandbox; the real spawn is covered by Task 10.

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { runConfined } from "./exec-run.ts";

const POLICY = {
  id: "exec-t",
  permissions: { network: [], filesystem: { read: [], write: [] } },
};

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (sig?: string) => boolean;
    killed: string[];
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = [];
  child.kill = (sig = "SIGTERM") => {
    child.killed.push(sig);
    return true;
  };
  return child;
}

function fakeRunner(child: ReturnType<typeof fakeChild>): SandboxRunner {
  return {
    platform: process.platform as "linux" | "darwin" | "win32",
    spawn: () => child as never,
    isFullyActive: () => true,
    degradedReason: () => null,
  };
}

describe("runConfined", () => {
  test("captures output and reports a clean exit", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", ["run", "s.ts"], {
      policy: POLICY,
      cwd: "/tmp",
      maxOutputBytes: 1024,
      maxWallClockMs: 5000,
    });
    child.stdout.write("hello");
    child.stderr.write("warn");
    child.emit("close", 0);
    const r = await p;
    expect(r.stdout).toBe("hello");
    expect(r.stderr).toBe("warn");
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.terminationReason).toBe("exited");
  });

  test("KILLS the process when output exceeds the cap", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], {
      policy: POLICY,
      cwd: "/tmp",
      maxOutputBytes: 4,
      maxWallClockMs: 5000,
    });
    child.stdout.write("aaaaaaaaaa");
    const r = await p;
    expect(r.terminationReason).toBe("output_cap");
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(4);
    expect(child.killed.length).toBeGreaterThan(0);
  });

  test("KILLS the process when the wall clock expires", async () => {
    const child = fakeChild();
    const r = await runConfined(fakeRunner(child), "bun", [], {
      policy: POLICY,
      cwd: "/tmp",
      maxOutputBytes: 1024,
      maxWallClockMs: 5,
    });
    expect(r.terminationReason).toBe("wall_clock");
    expect(child.killed[0]).toBe("SIGTERM");
  });

  test("a spawn error settles rather than hanging", async () => {
    const child = fakeChild();
    const p = runConfined(fakeRunner(child), "bun", [], {
      policy: POLICY,
      cwd: "/tmp",
      maxOutputBytes: 1024,
      maxWallClockMs: 5000,
    });
    child.emit("error", new Error("ENOENT"));
    const r = await p;
    expect(r.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/exec/exec-run.test.ts`
Expected: FAIL — cannot resolve `./exec-run.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `exec-result.ts`:

```ts
/** Why the child stopped. `truncated` alone cannot distinguish these, which is why it exists. */
export type TerminationReason = "exited" | "output_cap" | "wall_clock";

export interface ExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly terminationReason: TerminationReason;
}
```

Create `exec-run.ts`:

```ts
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { ExecResult, TerminationReason } from "./exec-result.ts";

export interface RunConfinedOptions {
  readonly policy: SandboxPolicy;
  readonly cwd: string;
  readonly maxOutputBytes: number;
  readonly maxWallClockMs: number;
  readonly now?: () => number;
}

/** Escalation delay before SIGKILL when SIGTERM is ignored (POSIX; on Windows SIGTERM is forceful). */
const KILL_ESCALATION_MS = 2_000;

/**
 * Spawn `cmd` through the platform sandbox runner and capture bounded output.
 *
 * Two hard stops, both of which KILL rather than merely stop reading: the wall clock, and the
 * output cap. Truncating the buffer while letting the child run would leave a `while(true)
 * console.log()` burning CPU until the wall clock with every byte discarded. This is resource
 * hygiene on owner-approved code, not a security boundary -- the confinement is the boundary.
 */
export function runConfined(
  runner: SandboxRunner,
  cmd: string,
  args: string[],
  opts: RunConfinedOptions,
): Promise<ExecResult> {
  const now = opts.now ?? Date.now;
  const started = now();

  return new Promise<ExecResult>((resolve) => {
    const child = runner.spawn(cmd, args, {
      policy: opts.policy,
      env: {},
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let bytes = 0;
    let truncated = false;
    let reason: TerminationReason = "exited";
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    // NB: do NOT unref() these timers -- an awaited promise settling from an unref'd timer makes
    // `bun test` spin forever on Windows. Both are cleared on settle.
    const wallTimer = setTimeout(() => {
      reason = "wall_clock";
      stop();
    }, opts.maxWallClockMs);

    function stop(): void {
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
      // A killed child still emits "close"; settle there so durationMs is real. If the platform
      // never delivers it, the escalation timer's own SIGKILL will.
    }

    function settle(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      if (escalation !== undefined) clearTimeout(escalation);
      resolve({
        exitCode,
        stdout: out,
        stderr: err,
        durationMs: now() - started,
        truncated,
        terminationReason: reason,
      });
    }

    function absorb(chunk: unknown, into: "out" | "err"): void {
      const text = String(chunk);
      const room = opts.maxOutputBytes - bytes;
      if (room <= 0) return;
      const slice = text.length > room ? text.slice(0, room) : text;
      bytes += slice.length;
      if (into === "out") out += slice;
      else err += slice;
      if (text.length > room) {
        truncated = true;
        if (reason === "exited") reason = "output_cap";
        stop();
      }
    }

    child.stdout?.on("data", (c: unknown) => absorb(c, "out"));
    child.stderr?.on("data", (c: unknown) => absorb(c, "err"));
    child.on("error", () => settle(null));
    child.on("close", (code: number | null) => settle(code));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/exec/exec-run.test.ts`
Expected: PASS (4 tests). If the output-cap test hangs, the `stop()` path is not settling — the fake child must emit `close` after `kill`; add `child.kill = () => { child.emit("close", null); return true; }` semantics to the fake rather than changing production code.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/exec/exec-result.ts packages/gateway/src/exec/exec-run.ts packages/gateway/src/exec/exec-run.test.ts
git commit -m "feat(exec): run confined with wall-clock and output-cap kills"
```

---

## Task 6: Org-policy capability lockoff

**Files:**
- Modify: `packages/gateway/src/policy/types.ts`
- Modify: `packages/gateway/src/policy/policy-toml.ts`
- Modify: `packages/gateway/src/policy/policy-gate.ts:9-24`
- Test: `packages/gateway/src/policy/policy-gate.test.ts`, `packages/gateway/src/policy/policy-toml.test.ts`

**Interfaces:**
- Consumes: `OrgPolicy`, `LocalBaseline`, `computeEnforced` (existing).
- Produces: `OrgPolicy.capabilities: { readonly disabled: readonly string[] }`; `LocalBaseline.capabilitiesDisabled: ReadonlySet<string>`; `EnforcedPolicy.capabilitiesDisabled: ReadonlySet<string>`; `AI_V2_CAPABILITIES` constant.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/policy/policy-gate.test.ts` and `policy-toml.test.ts` (copy each file's existing cleanup hooks into the new describes).

```ts
// --- policy-toml.test.ts ---
describe("[policy.capabilities.ai_v2]", () => {
  test("false DISABLES a capability", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "acme"\n[policy.capabilities.ai_v2]\ncode_execution = false\n`,
    );
    expect(p.capabilities.disabled).toContain("code_execution");
  });

  test("true is a NO-OP, not a grant -- policy can only tighten", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "acme"\n[policy.capabilities.ai_v2]\ncode_execution = true\n`,
    );
    expect(p.capabilities.disabled).not.toContain("code_execution");
  });

  test("an unknown capability name is ignored", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "acme"\n[policy.capabilities.ai_v2]\nmind_reading = false\n`,
    );
    expect(p.capabilities.disabled).not.toContain("mind_reading");
  });

  test("absent block yields an empty set", () => {
    const p = parsePolicyToml(`[policy]\nversion = 1\norg = "acme"\n`);
    expect(p.capabilities.disabled).toEqual([]);
  });
});

// --- policy-gate.test.ts ---
describe("capability lockoff resolution", () => {
  const baseline = {
    retentionDays: 1,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set<string>(),
  };

  test("UNIONS org policy with the local baseline", () => {
    const e = computeEnforced(
      { ...emptyPolicy(), capabilities: { disabled: ["code_execution"] } },
      baseline,
    );
    expect(e.capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("a policy naming NOTHING cannot re-enable a locally disabled capability", () => {
    const e = computeEnforced(
      { ...emptyPolicy(), capabilities: { disabled: [] } },
      { ...baseline, capabilitiesDisabled: new Set(["code_execution"]) },
    );
    expect(e.capabilitiesDisabled.has("code_execution")).toBe(true);
  });
});
```

Add an `emptyPolicy()` helper in the test file returning a minimal valid `OrgPolicy` if one does not already exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/policy/policy-toml.test.ts packages/gateway/src/policy/policy-gate.test.ts -t "capabilit"`
Expected: FAIL — `capabilities` is not a property of `OrgPolicy`.

- [ ] **Step 3: Write minimal implementation**

In `policy/types.ts`, add to `OrgPolicy` (after `chatops`):

```ts
  /**
   * Capabilities the org has turned OFF. Modelled as a disabled SET rather than booleans so
   * resolution is a union -- monotonic-stricter by construction (I22). A boolean field would make
   * `code_execution = true` read as a grant, letting a peer-distributed policy RE-ENABLE what the
   * anchor disabled; a set makes that unrepresentable.
   */
  readonly capabilities: { readonly disabled: readonly string[] };
```

Add the recognised names:

```ts
/** The Phase 14 / S2 capability names an org policy may disable. */
export const AI_V2_CAPABILITIES = [
  "code_execution",
  "computer_use",
  "tool_generation",
  "multimodal_input",
  "local_finetuning",
] as const;
```

In `policy/policy-toml.ts`:
- add `capabilitiesDisabled: new Set<string>()` to the `PolicyAccum` initialiser;
- add a case to `dispatchKey`'s switch (alongside `"[policy.audit]"` at `:87`):

```ts
    case "[policy.capabilities.ai_v2]":
      applyCapabilitiesKey(acc, key, valRaw);
      break;
```

- add the handler:

```ts
function applyCapabilitiesKey(acc: PolicyAccum, key: string, valRaw: string): void {
  const name = parseString(key).trim().toLowerCase();
  if (!(AI_V2_CAPABILITIES as readonly string[]).includes(name)) return;
  // ONLY `false` carries meaning. `true` is a no-op: a policy may tighten, never loosen (I22).
  if (parseBool(valRaw) === false) acc.capabilitiesDisabled.add(name);
}
```

- include it in the returned `OrgPolicy` at `:200`:

```ts
    capabilities: { disabled: [...acc.capabilitiesDisabled] },
```

- and emit it in the serializer near `:228`:

```ts
  if (p.capabilities.disabled.length > 0) {
    lines.push("", "[policy.capabilities.ai_v2]");
    for (const c of p.capabilities.disabled) lines.push(`${c} = false`);
  }
```

In `policy/policy-gate.ts`, add to `LocalBaseline` and `EnforcedPolicy`:

```ts
  readonly capabilitiesDisabled: ReadonlySet<string>;
```

and inside `computeEnforced`, before the return:

```ts
  // Union, not override: disabling is the tightening direction, so a capability disabled by
  // EITHER side stays disabled. This is the whole reason the field is a set (I22).
  const capabilitiesDisabled = new Set<string>(base.capabilitiesDisabled);
  for (const c of policy.capabilities.disabled) capabilitiesDisabled.add(c);
```

and add `capabilitiesDisabled,` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/policy/`
Expected: PASS. Fix any existing `OrgPolicy` / `LocalBaseline` literals in other tests that now need the new field — `bun run typecheck` names them.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/policy/
git commit -m "feat(policy): add tighten-only ai_v2 capability lockoff as a disabled set"
```

---

## Task 7: `exec-gate.ts` + the I33 invariant triple

> **This task is deliberately large.** `CLAUDE.md`'s triple rule requires the wiring, the `docs/SECURITY-INVARIANTS.md` entry and the enforcement test to land in **one commit**. Do not split it.

**Files:**
- Create: `packages/gateway/src/exec/exec-gate.ts`
- Test: `packages/gateway/src/exec/exec-gate.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`
- Modify: `packages/gateway/src/security-invariants.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Modify: `packages/gateway/src/platform/sandbox/sandbox-policy.ts:14-20` (the stale `limits` comment)

**Interfaces:**
- Consumes: Tasks 1-6 in full.
- Produces:
  - `interface RunExecutionRequest { code?: string; filePath?: string; runtimeId?: string; fsRead: readonly string[]; fsWrite: readonly string[]; network?: readonly string[]; timeoutMs?: number; cwd: string }`
  - `interface ExecGateDeps { runner: SandboxRunner; config: NimbusCodeExecutionToml; enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">; requestApproval: (input: ExecApprovalInput) => Promise<boolean>; db: Database; readFile: (p: string) => string; now: () => number; newId: () => string }`
  - `runExecution(req: RunExecutionRequest, deps: ExecGateDeps): Promise<ExecGateOutcome>`
  - `type ExecGateOutcome = { status: "ran"; result: ExecResult } | { status: "denied" | "timeout" } | { status: "refused"; code: string }`
  - `class ExecGateError extends Error { readonly code: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { runExecution } from "./exec-gate.ts";

// A runner that records whether it was EVER asked to spawn. The refusal tests assert on this
// spy, never on an absent side effect -- a test that passes because nothing happened is the
// recurring failure shape in this repo.
function spyRunner(active = true) {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      platform: process.platform as "linux" | "darwin" | "win32",
      spawn: (cmd: string) => {
        calls.push(cmd);
        throw new Error("spawn should not have been reached");
      },
      isFullyActive: () => active,
      degradedReason: () => (active ? "windows caveat text" : "helper missing"),
    },
  };
}

function deps(over: Partial<Record<string, unknown>> = {}) {
  const spy = spyRunner();
  return {
    spy,
    d: {
      runner: spy.runner,
      config: {
        enabled: true,
        maxWallClockMs: 1000,
        maxOutputBytes: 1024,
        allowedRuntimes: ["bun"],
      },
      enforced: { capabilitiesDisabled: new Set<string>() },
      requestApproval: async () => true,
      db: makeTestDb(),        // in-memory DB with the audit_log schema
      readFile: () => "console.log(1)",
      now: () => 1_700_000_000_000,
      newId: () => "e1",
      ...over,
    },
  };
}

const REQ = {
  code: "console.log(1)",
  fsRead: [],
  fsWrite: [],
  cwd: process.platform === "win32" ? "C:\\tmp" : "/tmp",
};

describe("runExecution (I33)", () => {
  test("refuses when the capability is DISABLED BY CONFIG, before consent", async () => {
    let asked = false;
    const { spy, d } = deps({
      config: { enabled: false, maxWallClockMs: 1000, maxOutputBytes: 1024, allowedRuntimes: ["bun"] },
      requestApproval: async () => {
        asked = true;
        return true;
      },
    });
    const out = await runExecution(REQ, d as never);
    expect(out.status).toBe("refused");
    expect(asked).toBe(false);
    expect(spy.calls).toEqual([]);
  });

  test("refuses when ORG POLICY disables code_execution", async () => {
    const { spy, d } = deps({
      enforced: { capabilitiesDisabled: new Set(["code_execution"]) },
    });
    const out = await runExecution(REQ, d as never);
    expect(out.status).toBe("refused");
    expect(spy.calls).toEqual([]);
  });

  test("a DENIED approval spawns NOTHING", async () => {
    const { spy, d } = deps({ requestApproval: async () => false });
    const out = await runExecution(REQ, d as never);
    expect(out.status).toBe("denied");
    expect(spy.calls).toEqual([]);
  });

  test("refuses when the runner is NOT fully active", async () => {
    const spy = spyRunner(false);
    const { d } = deps({ runner: spy.runner });
    const out = await runExecution(REQ, d as never);
    expect(out.status).toBe("refused");
    expect(spy.calls).toEqual([]);
  });

  test("does NOT refuse merely because degradedReason() is non-null (the Windows trap)", async () => {
    // isFullyActive() is true while degradedReason() returns the accepted per-host caveat.
    // A gate keyed on degradedReason() would refuse every Windows execution forever.
    const { d } = deps({ requestApproval: async () => false });
    const out = await runExecution(REQ, d as never);
    expect(out.status).toBe("denied"); // reached consent -- i.e. was NOT refused on posture
  });

  test("a requested NETWORK grant is refused", async () => {
    const { spy, d } = deps();
    const out = await runExecution({ ...REQ, network: ["example.com"] }, d as never);
    expect(out.status).toBe("refused");
    expect(spy.calls).toEqual([]);
  });

  test("a RELATIVE fs grant is refused, not resolved", async () => {
    const { spy, d } = deps();
    const out = await runExecution({ ...REQ, fsRead: ["./src"] }, d as never);
    expect(out.status).toBe("refused");
    expect(spy.calls).toEqual([]);
  });

  test("--file is read ONCE: bytes mutated after approval do not execute", async () => {
    let reads = 0;
    const bodies = ["APPROVED", "SWAPPED"];
    let approvedBody = "";
    const { d } = deps({
      readFile: () => bodies[Math.min(reads++, 1)] as string,
      requestApproval: async (input: { codeBody: string }) => {
        approvedBody = input.codeBody;
        return false; // stop before spawn; we only assert on what was read + shown
      },
    });
    await runExecution({ ...REQ, code: undefined, filePath: "/tmp/s.ts" } as never, d as never);
    expect(approvedBody).toBe("APPROVED");
    expect(reads).toBe(1);
  });

  test("appends exactly one code.execute audit row per outcome", async () => {
    const { d } = deps({ requestApproval: async () => false });
    await runExecution(REQ, d as never);
    const rows = d.db
      .query(`SELECT action_type, hitl_status FROM audit_log WHERE action_type = 'code.execute'`)
      .all() as Array<{ action_type: string; hitl_status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.hitl_status).toBe("rejected");
  });
});
```

Write `makeTestDb()` as a local helper opening `new Database(":memory:")` and running the project's migrations, following the pattern already used in `packages/gateway/src/db/*.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/exec/exec-gate.test.ts`
Expected: FAIL — cannot resolve `./exec-gate.ts`.

- [ ] **Step 3: Write the gate**

```ts
import type { Database } from "bun:sqlite";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { NimbusCodeExecutionToml } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { ExecApprovalInput } from "./exec-consent-broker.ts";
import { buildExecPolicy, ExecPolicyError } from "./exec-policy.ts";
import type { ExecResult } from "./exec-result.ts";
import {
  ExecRuntimeError,
  requireInstalled,
  resolveRuntimeById,
  resolveRuntimeForFile,
} from "./exec-runtimes.ts";
import { runConfined } from "./exec-run.ts";

export class ExecGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecGateError";
  }
}

export interface RunExecutionRequest {
  readonly code?: string;
  readonly filePath?: string;
  readonly runtimeId?: string;
  readonly fsRead: readonly string[];
  readonly fsWrite: readonly string[];
  readonly network?: readonly string[];
  readonly timeoutMs?: number;
  readonly cwd: string;
}

export interface ExecGateDeps {
  readonly runner: SandboxRunner;
  readonly config: NimbusCodeExecutionToml;
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
  readonly requestApproval: (input: ExecApprovalInput) => Promise<boolean>;
  readonly db: Database;
  readonly readFile: (path: string) => string;
  readonly now: () => number;
  readonly newId: () => string;
}

export type ExecGateOutcome =
  | { readonly status: "ran"; readonly result: ExecResult }
  | { readonly status: "denied" }
  | { readonly status: "timeout" }
  | { readonly status: "refused"; readonly code: string };

const CAPABILITY = "code_execution";

function digest(s: string): string {
  return bytesToHex(blake3(new TextEncoder().encode(s)));
}

function audit(
  deps: ExecGateDeps,
  hitlStatus: string,
  payload: Record<string, unknown>,
): void {
  appendAuditEntry(deps.db, {
    actionType: "code.execute",
    hitlStatus,
    actionJson: JSON.stringify(payload),
    timestamp: deps.now(),
  });
}

/**
 * The ONE path from user-supplied code to a running process (I33 / D23).
 *
 * Order is load-bearing. Every refusal that can be decided WITHOUT the owner happens before the
 * consent prompt, so a disabled capability never advertises itself by prompting; and the sandbox
 * posture is asserted before consent too, so the owner is never asked to approve something that
 * could not have been confined anyway.
 */
export async function runExecution(
  req: RunExecutionRequest,
  deps: ExecGateDeps,
): Promise<ExecGateOutcome> {
  const executionId = deps.newId();

  try {
    // 1. Local kill-switch, then org policy. Both BEFORE consent.
    if (!deps.config.enabled) {
      throw new ExecGateError("ERR_EXEC_DISABLED", "code execution is disabled");
    }
    if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
      throw new ExecGateError("ERR_EXEC_POLICY_DISABLED", "disabled by org policy");
    }

    // 2. Confinement posture. isFullyActive(), NEVER degradedReason() === null: on Windows
    // degradedReason() is non-null even when fully active (it reports the accepted per-host
    // filtering caveat), so keying on it would refuse every Windows execution forever.
    if (!deps.runner.isFullyActive()) {
      throw new ExecGateError(
        "ERR_EXEC_SANDBOX_DEGRADED",
        `refusing to execute unconfined: ${deps.runner.degradedReason() ?? "unknown"}`,
      );
    }

    // 3. Resolve the runtime from the REGISTRY -- never a caller-supplied argv.
    const runtime =
      req.runtimeId !== undefined
        ? resolveRuntimeById(req.runtimeId)
        : req.filePath !== undefined
          ? resolveRuntimeForFile(req.filePath)
          : resolveRuntimeById("bun");
    if (!deps.config.allowedRuntimes.includes(runtime.id)) {
      throw new ExecGateError("ERR_EXEC_RUNTIME_NOT_ALLOWED", `runtime not allowed: ${runtime.id}`);
    }
    // Presence check only -- fails BEFORE consent so the owner is never asked to approve a run
    // that could not start. The command itself comes from argvFor() at step 7.
    requireInstalled(runtime);

    // 4. Read the script ONCE. The bytes shown to the owner are the bytes that execute; the file
    // is never re-read after approval, so a swap in the consent window cannot change what runs.
    const codeBody =
      req.code ??
      (req.filePath !== undefined
        ? deps.readFile(req.filePath)
        : (() => {
            throw new ExecGateError("ERR_EXEC_NO_CODE", "neither code nor filePath supplied");
          })());

    // 5. Policy: network empty by construction; relative paths refused.
    const policy = buildExecPolicy(executionId, {
      fsRead: req.fsRead,
      fsWrite: req.fsWrite,
      ...(req.network === undefined ? {} : { network: req.network }),
    });

    const wallClockMs = Math.min(
      req.timeoutMs ?? deps.config.maxWallClockMs,
      deps.config.maxWallClockMs,
    );
    const grants = {
      fsRead: policy.permissions.filesystem.read,
      fsWrite: policy.permissions.filesystem.write,
      network: policy.permissions.network,
    };

    // 6. Owner consent on the exact body + the RESOLVED capability set.
    const approved = await deps.requestApproval({
      executionId,
      runtime: runtime.id,
      codeBody,
      grants,
      wallClockMs,
      cwd: req.cwd,
    });
    if (!approved) {
      audit(deps, "rejected", { executionId, runtime: runtime.id, codeBody, grants });
      return { status: "denied" };
    }

    // 7. Spawn. Both cmd and args come from the REGISTRY (never a caller-supplied argv, I33);
    // `bin` above was the installed-check, not a second source of truth for the command.
    const { cmd, args } = runtime.argvFor(scriptPath);
    const result = await runConfined(deps.runner, cmd, args, {
      policy,
      cwd: req.cwd,
      maxOutputBytes: deps.config.maxOutputBytes,
      maxWallClockMs: wallClockMs,
      now: deps.now,
    });

    audit(deps, "approved", {
      executionId,
      runtime: runtime.id,
      codeBody,
      grants,
      exitCode: result.exitCode,
      stdoutDigest: digest(result.stdout),
      stderrDigest: digest(result.stderr),
      durationMs: result.durationMs,
      terminationReason: result.terminationReason,
      truncated: result.truncated,
    });
    return { status: "ran", result };
  } catch (e) {
    const code =
      e instanceof ExecGateError || e instanceof ExecPolicyError || e instanceof ExecRuntimeError
        ? e.code
        : "ERR_EXEC_FAILED";
    audit(deps, "refused", { executionId, code });
    return { status: "refused", code };
  }
}
```

`--code` has no file on disk, so the gate materialises one. Add to the same file:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Per-runtime file extension for a scratch script. Keyed on the SAME ids as the registry. */
const SCRATCH_EXT: ReadonlyMap<string, string> = new Map([["bun", ".ts"]]);

/**
 * Materialise an inline `--code` body so the runtime has a file to run.
 *
 * Mode 0o600 and a fresh per-execution directory: the scratch file holds code the owner just
 * approved, and a predictable world-readable path would let another local user read it -- or,
 * worse, replace it between write and spawn. Returns BOTH paths so the caller can grant read
 * access to the directory it just created and nothing wider.
 */
function writeScratchScript(codeBody: string, runtimeId: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-exec-"));
  const file = join(dir, `script${SCRATCH_EXT.get(runtimeId) ?? ".txt"}`);
  writeFileSync(file, codeBody, { mode: 0o600 });
  return { dir, file };
}
```

Because the scratch directory must be readable by the sandboxed child, it has to exist **before** the policy is built. Restructure steps 4-7 of `runExecution` so the order is: read/obtain `codeBody` → materialise the scratch script when `req.code` was used → build the policy with the scratch dir appended to `fsRead` → prompt → spawn. Concretely, replace the step-5 policy construction with:

```ts
    const scratch = req.code === undefined ? undefined : writeScratchScript(codeBody, runtime.id);
    const scriptPath = scratch?.file ?? (req.filePath as string);

    const policy = buildExecPolicy(executionId, {
      // The scratch dir is granted READ only -- the child must load the script, never rewrite it.
      fsRead: scratch === undefined ? req.fsRead : [...req.fsRead, scratch.dir],
      fsWrite: req.fsWrite,
      ...(req.network === undefined ? {} : { network: req.network }),
    });
```

and drop the `writeScratchScript` call from step 7, which now only needs `runtime.argvFor(scriptPath)`.

Note the ordering consequence worth keeping: the scratch file is written **before** consent, so a denied execution leaves a temp file behind. Delete it in a `finally` block — a rejected body sitting in `tmpdir()` is code the owner explicitly refused to run.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/exec/exec-gate.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Red-prove the denied-approval guard**

Temporarily change step 6's `if (!approved)` to `if (false)`. Run the suite. The "a DENIED approval spawns NOTHING" test **must fail**. Revert. A guard whose test still passes when the guard is removed is not testing the guard.

- [ ] **Step 6: Add the `docs/SECURITY-INVARIANTS.md` entry**

Add an `I33` section after `I32`, following the structure of the `I27` section: rationale, the wiring site, anti-patterns (keying on `degradedReason()`; resolving relative paths gateway-side; re-reading the file after approval; adding a second spawn path), and the enforcement-test pointer.

- [ ] **Step 7: Add the enforcement test**

Append to `packages/gateway/src/security-invariants.test.ts`, mirroring the `describe("I27 — ...")` block at `:1624`:

```ts
describe("I33 — user code executes only behind the exec gate", () => {
  test("exec-gate.ts is the only file that calls runConfined", async () => {
    const hits = await grepRepo(/\brunConfined\s*\(/);
    const callers = hits.filter((h) => !h.relPath.endsWith(".test.ts"));
    expect(callers.map((h) => h.relPath).sort()).toEqual([
      "packages/gateway/src/exec/exec-gate.ts",
      "packages/gateway/src/exec/exec-run.ts",
    ]);
  });

  test("the gate never keys confinement on degradedReason()", async () => {
    const src = await readFile("packages/gateway/src/exec/exec-gate.ts", "utf8");
    expect(src).toContain("isFullyActive()");
    expect(src).not.toMatch(/degradedReason\(\)\s*===\s*null/);
  });
});
```

Reuse whatever repo-grep helper that file already uses; do not introduce a second one.

- [ ] **Step 8: Add static rule D23**

In `scripts/structure-audit/check-nimbus-invariants.ts`, following the `D21` block at `:569-612`:

```ts
// D23 (I33): `runConfined` -- the confined-spawn primitive -- may be CALLED only from the exec
// gate. A second caller would be a second path from user code to a process, which is exactly what
// I33 forbids.
const D23_RUNCONFINED_ALLOWED = [
  "packages/gateway/src/exec/exec-gate.ts",
  "packages/gateway/src/exec/exec-run.ts",
];
const D23_RUNCONFINED_RE = /\brunConfined\s*\(/;
```

Wire it into the same per-line scan loop the D21 rules use, emitting `rule: "D23-run-confined"`.

- [ ] **Step 9: Update the stale `sandbox-policy.ts` comment**

`packages/gateway/src/platform/sandbox/sandbox-policy.ts:14-20` currently says `limits.wallClockMs` is "DECLARED BUT NOT ENFORCED by any runner in this release — the execution surface adds enforcement." That future has arrived. Replace with:

```ts
  /**
   * One-shot executions only. Enforced by `exec/exec-run.ts` (`runConfined`), which kills the child
   * on expiry -- NOT by any runner, and NOT by an OS job limit. A connector spawn ignores it.
   */
```

- [ ] **Step 10: Run the full gate set**

Run: `bun run preflight:fast && bun test packages/gateway/src/exec packages/gateway/src/security-invariants.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit (wiring + docs + test together)**

```bash
git add packages/gateway/src/exec/ docs/SECURITY-INVARIANTS.md packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.ts packages/gateway/src/platform/sandbox/sandbox-policy.ts
git commit -m "feat(exec): add the I33 code-execution gate with its D23 static rule"
```

---

## Task 8: IPC surface

**Files:**
- Create: `packages/gateway/src/ipc/exec-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (broadcast wiring)
- Test: `packages/gateway/src/ipc/exec-rpc.test.ts`

**Interfaces:**
- Consumes: `runExecution`, `ExecGateDeps` (Task 7); `execConsent` (Task 4).
- Produces: `dispatchExecRpc(method, params, ctx): Promise<RpcMissOrHit>`; `interface ExecRpcCtx`; `class ExecRpcError extends Error { rpcCode: number }`. Methods: `exec.run`, `exec.approvalRespond`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { dispatchExecRpc } from "./exec-rpc.ts";

describe("exec RPC", () => {
  test("exec.run returns the gate outcome", async () => {
    const out = await dispatchExecRpc("exec.run", { code: "1", cwd: "/tmp" }, ctx());
    expect(out.handled).toBe(true);
  });

  test("exec.approvalRespond resolves a pending approval", async () => {
    const c = ctx();
    const p = c.consent.request(
      { executionId: "e", runtime: "bun", codeBody: "x", grants: { fsRead: [], fsWrite: [], network: [] }, wallClockMs: 10, cwd: "/tmp" },
      5000,
    );
    const id = c.broadcasts[0]?.requestId as string;
    await dispatchExecRpc("exec.approvalRespond", { requestId: id, approved: true }, c);
    expect(await p).toBe(true);
    c.consent.clear();
  });

  test("an unknown exec.* method MISSES rather than throwing", async () => {
    const out = await dispatchExecRpc("exec.nope", {}, ctx());
    expect(out.handled).toBe(false);
  });
});
```

Write `ctx()` as a local helper building an `ExecRpcCtx` over a fresh `ExecConsentBroker` (with `setBroadcast` capturing into `broadcasts`) and a stubbed `runExecution` dependency set.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/exec-rpc.test.ts`
Expected: FAIL — cannot resolve `./exec-rpc.ts`.

- [ ] **Step 3: Write the RPC module**

Follow `packages/gateway/src/ipc/share-rpc.ts` exactly — same `RpcMethodHandlerMap` / `dispatchByMethod` / `RpcMissOrHit` imports from `./_lib/dispatch-by-method.ts`, same error-class shape:

```ts
const HANDLERS: RpcMethodHandlerMap<ExecRpcCtx> = {
  "exec.run": async (params, ctx) => {
    const rec = asRecord(params) ?? {};
    return runExecution(
      {
        ...(typeof rec["code"] === "string" ? { code: rec["code"] } : {}),
        ...(typeof rec["filePath"] === "string" ? { filePath: rec["filePath"] } : {}),
        ...(typeof rec["runtimeId"] === "string" ? { runtimeId: rec["runtimeId"] } : {}),
        fsRead: stringArray(rec["fsRead"]),
        fsWrite: stringArray(rec["fsWrite"]),
        ...(rec["network"] === undefined ? {} : { network: stringArray(rec["network"]) }),
        ...(typeof rec["timeoutMs"] === "number" ? { timeoutMs: rec["timeoutMs"] } : {}),
        cwd: requireString(params, "cwd"),
      },
      ctx.gateDeps,
    );
  },
  "exec.approvalRespond": async (params, ctx) => {
    const requestId = requireString(params, "requestId");
    const approved = asRecord(params)?.["approved"] === true;
    return { matched: ctx.consent.respond(requestId, approved) };
  },
};
```

Every field crossing the IPC boundary is `unknown` until validated — no `as` casts on `params`.

- [ ] **Step 4: Register the dispatcher**

In `packages/gateway/src/ipc/server/dispatchers.ts`, add a `tryDispatchExecRpc` mirroring `tryDispatchShareRpc` at `:963`, and insert it into the same dispatch chain that `:1189` uses for HITL.

- [ ] **Step 5: Wire the broadcast**

In `packages/gateway/src/platform/assemble.ts`, call `execConsent.setBroadcast((method, params) => ipc.broadcast(method, params))` alongside the existing share/federation consent-broker wiring, and `execConsent.clear()` on shutdown.

- [ ] **Step 6: Run tests**

Run: `bun test packages/gateway/src/ipc/exec-rpc.test.ts packages/gateway/src/ipc/server/`
Expected: PASS.

- [ ] **Step 7: Confirm the method is NOT renderer-exposed**

`exec.run` is RCE-class. Verify it is absent from `packages/ui/src-tauri/src/gateway_bridge.rs`'s `ALLOWED_METHODS` (I7). It must not be added.

Run: `grep -c "exec.run" packages/ui/src-tauri/src/gateway_bridge.rs`
Expected: `0`.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ipc/ packages/gateway/src/platform/assemble.ts
git commit -m "feat(exec): expose exec.run and exec.approvalRespond over local IPC"
```

---

## Task 9: `nimbus exec` CLI

**Files:**
- Create: `packages/cli/src/commands/exec.ts`
- Modify: `packages/cli/src/commands/index.ts`
- Modify: `packages/cli/src/index.ts:120-149`
- Test: `packages/cli/src/commands/exec.test.ts`

**Interfaces:**
- Consumes: `exec.run` / `exec.approvalRespond` over IPC (Task 8).
- Produces: `runExec(args: string[]): Promise<void>`; `parseExecArgs(args: string[]): ParsedExecArgs` (exported for test); `EXEC_EXIT_CODES`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { EXEC_EXIT_CODES, parseExecArgs } from "./exec.ts";

describe("nimbus exec arg parsing", () => {
  test("resolves relative fs grants to ABSOLUTE against the CLI cwd", () => {
    const p = parseExecArgs(["--code", "x", "--allow-fs-read", "./src"]);
    expect(p.fsRead[0]).toBe(resolve(process.cwd(), "./src"));
  });

  test("leaves an already-absolute path alone", () => {
    const abs = process.platform === "win32" ? "C:\\x" : "/x";
    expect(parseExecArgs(["--code", "y", "--allow-fs-read", abs]).fsRead[0]).toBe(abs);
  });

  test("collects repeated grants", () => {
    const p = parseExecArgs([
      "--code", "x",
      "--allow-fs-read", "./a",
      "--allow-fs-read", "./b",
      "--allow-fs-write", "./c",
    ]);
    expect(p.fsRead.length).toBe(2);
    expect(p.fsWrite.length).toBe(1);
  });

  test("resolves --file to absolute too", () => {
    expect(parseExecArgs(["--file", "./s.ts"]).filePath).toBe(
      resolve(process.cwd(), "./s.ts"),
    );
  });

  test("rejects supplying neither --code nor --file", () => {
    expect(() => parseExecArgs([])).toThrow();
  });

  test("exit codes are distinct and stable", () => {
    expect(EXEC_EXIT_CODES).toEqual({
      denied: 10,
      timeout: 11,
      refused: 12,
      wallClock: 13,
      outputCap: 14,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/exec.test.ts`
Expected: FAIL — cannot resolve `./exec.ts`.

- [ ] **Step 3: Write the command**

```ts
import { resolve } from "node:path";

export const EXEC_EXIT_CODES = {
  denied: 10,
  timeout: 11,
  refused: 12,
  wallClock: 13,
  outputCap: 14,
} as const;

export interface ParsedExecArgs {
  readonly code?: string;
  readonly filePath?: string;
  readonly runtimeId?: string;
  readonly fsRead: string[];
  readonly fsWrite: string[];
  readonly timeoutMs?: number;
}

/**
 * The CLI resolves every path to absolute against ITS OWN cwd, because the gateway is a separate
 * process whose cwd is unrelated. The gate refuses anything still relative -- so an omission here
 * is a loud error there, never a grant of the wrong directory.
 */
export function parseExecArgs(args: string[]): ParsedExecArgs {
  const fsRead: string[] = [];
  const fsWrite: string[] = [];
  let code: string | undefined;
  let filePath: string | undefined;
  let runtimeId: string | undefined;
  let timeoutMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === "--code") code = next();
    else if (a === "--file") filePath = resolve(process.cwd(), next());
    else if (a === "--runtime") runtimeId = next();
    else if (a === "--allow-fs-read") fsRead.push(resolve(process.cwd(), next()));
    else if (a === "--allow-fs-write") fsWrite.push(resolve(process.cwd(), next()));
    else if (a === "--timeout") timeoutMs = Number.parseInt(next(), 10);
  }

  if (code === undefined && filePath === undefined) {
    throw new Error("nimbus exec requires either --code or --file");
  }
  return {
    ...(code === undefined ? {} : { code }),
    ...(filePath === undefined ? {} : { filePath }),
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    fsRead,
    fsWrite,
  };
}
```

Then the command itself. Use whichever gateway-client helper the neighbouring commands use (read `packages/cli/src/commands/prove.ts` and copy its connection setup — do not invent a second one):

```ts
/** Map a gate outcome to a process exit code. Kept pure so it is testable without a gateway. */
export function exitCodeFor(outcome: {
  status: string;
  code?: string;
  result?: { exitCode: number | null; terminationReason: string };
}): number {
  if (outcome.status === "denied") return EXEC_EXIT_CODES.denied;
  if (outcome.status === "timeout") return EXEC_EXIT_CODES.timeout;
  if (outcome.status === "refused") return EXEC_EXIT_CODES.refused;
  const r = outcome.result;
  if (r === undefined) return EXEC_EXIT_CODES.refused;
  if (r.terminationReason === "wall_clock") return EXEC_EXIT_CODES.wallClock;
  if (r.terminationReason === "output_cap") return EXEC_EXIT_CODES.outputCap;
  return r.exitCode ?? 1;
}

export async function runExec(args: string[]): Promise<void> {
  let parsed: ParsedExecArgs;
  try {
    parsed = parseExecArgs(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = EXEC_EXIT_CODES.refused;
    return;
  }

  const client = await connectGateway();
  try {
    const outcome = await client.request("exec.run", { ...parsed, cwd: process.cwd() });
    const o = outcome as Parameters<typeof exitCodeFor>[0];
    if (o.result !== undefined) {
      const r = o.result as unknown as { stdout: string; stderr: string; truncated: boolean };
      if (r.stdout !== "") process.stdout.write(r.stdout);
      if (r.stderr !== "") process.stderr.write(r.stderr);
      // Disclose truncation rather than silently handing back a short buffer.
      if (r.truncated) console.error("nimbus: output truncated at the configured cap");
    }
    if (o.status === "refused") console.error(`nimbus: refused (${o.code ?? "unknown"})`);
    if (o.status === "denied") console.error("nimbus: execution denied");
    process.exitCode = exitCodeFor(o);
  } finally {
    await client.close();
  }
}
```

Add a test for `exitCodeFor` covering each branch — it is the piece a wrapper script depends on:

```ts
test("maps every outcome to its documented exit code", () => {
  expect(exitCodeFor({ status: "denied" })).toBe(10);
  expect(exitCodeFor({ status: "timeout" })).toBe(11);
  expect(exitCodeFor({ status: "refused", code: "ERR_EXEC_DISABLED" })).toBe(12);
  expect(
    exitCodeFor({ status: "ran", result: { exitCode: null, terminationReason: "wall_clock" } }),
  ).toBe(13);
  expect(
    exitCodeFor({ status: "ran", result: { exitCode: null, terminationReason: "output_cap" } }),
  ).toBe(14);
  // A script's OWN non-zero code must pass through unchanged, not be remapped.
  expect(exitCodeFor({ status: "ran", result: { exitCode: 3, terminationReason: "exited" } })).toBe(3);
});
```

- [ ] **Step 4: Register the command**

- `packages/cli/src/commands/index.ts`: `export { runExec } from "./exec.ts";`
- `packages/cli/src/index.ts`: add `exec: runExec,` to `COMMAND_HANDLERS` (the map at `:120-149`), and a help line.

- [ ] **Step 5: Run tests**

Run: `bun test packages/cli/src/commands/exec.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Add the e2e CLI test**

The spec's testing table requires this, and the unit tests above do not cover it: they exercise parsing and mapping, never the wire. Both sides of an IPC seam being separately tested has produced a dead feature in this repo before — a test per side proves the ends, never the wire.

Create `packages/cli/test/e2e/exec.e2e.test.ts`, following the harness the neighbouring e2e specs use (real Gateway subprocess, fresh temp config dir):

```ts
test("approved: nimbus exec runs and returns the script's own exit code", async () => {
  const env = await startGateway({ toml: `[code_execution]\nenabled = true\n` });
  const approve = env.onNotification("exec.approvalRequest", (p) =>
    env.request("exec.approvalRespond", { requestId: p.requestId, approved: true }),
  );
  const r = await env.runCli(["exec", "--code", "process.exit(3)"]);
  expect(r.exitCode).toBe(3);
  approve.stop();
  await env.stop();
});

test("denied: nothing runs and the CLI exits 10", async () => {
  const env = await startGateway({ toml: `[code_execution]\nenabled = true\n` });
  const deny = env.onNotification("exec.approvalRequest", (p) =>
    env.request("exec.approvalRespond", { requestId: p.requestId, approved: false }),
  );
  const r = await env.runCli(["exec", "--code", "require('node:fs').writeFileSync('proof','x')"]);
  expect(r.exitCode).toBe(10);
  expect(existsSync("proof")).toBe(false);
  deny.stop();
  await env.stop();
});

test("default-off: with no [code_execution] block the CLI exits 12", async () => {
  const env = await startGateway({ toml: "" });
  const r = await env.runCli(["exec", "--code", "1"]);
  expect(r.exitCode).toBe(12);
  await env.stop();
});
```

Run: `bun test packages/cli/test/e2e/exec.e2e.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/exec.ts packages/cli/src/commands/exec.test.ts packages/cli/src/commands/index.ts packages/cli/src/index.ts packages/cli/test/e2e/exec.e2e.test.ts
git commit -m "feat(cli): add nimbus exec with absolute-path resolution and distinct exit codes"
```

---

## Task 10: Loopback + real-sandbox integration tests

**Files:**
- Create: `packages/gateway/test/integration/exec-sandbox.integration.test.ts`

**Interfaces:**
- Consumes: everything above. No new production code — this task adds only tests.

> This is the task that converts §3's "loopback happens to be blocked by three unrelated mechanisms" into a guarantee. Without it, a future change to any one runner could open loopback without failing anything.

- [ ] **Step 1: Write the tests**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

describe("exec sandbox (real spawn)", () => {
  let port = 0;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeAll(() => {
    // Stand in for the Gateway's own loopback surface.
    server = Bun.serve({ port: 0, fetch: () => new Response("REACHED") });
    port = server.port;
  });
  afterAll(() => server?.stop(true));

  test("a script CANNOT reach a loopback service (I33 network:none includes loopback)", async () => {
    const out = await execViaGate({
      code: `const r = await fetch("http://127.0.0.1:${port}/"); console.log(await r.text());`,
      fsRead: [],
      fsWrite: [],
    });
    expect(out.status).toBe("ran");
    expect(out.result.stdout).not.toContain("REACHED");
    expect(out.result.exitCode).not.toBe(0);
  });

  test("a script cannot write outside its granted paths", async () => {
    const out = await execViaGate({
      code: `require("node:fs").writeFileSync("/etc/nimbus-probe", "x");`,
      fsRead: [],
      fsWrite: [],
    });
    expect(out.result.exitCode).not.toBe(0);
  });

  test("a script CAN write inside a granted path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-exec-"));
    const out = await execViaGate({
      code: `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "ok.txt"))}, "x");`,
      fsRead: [dir],
      fsWrite: [dir],
    });
    expect(out.result.exitCode).toBe(0);
    expect(existsSync(join(dir, "ok.txt"))).toBe(true);
  });

  test("wall clock kills a runaway script", async () => {
    const out = await execViaGate({
      code: `while (true) {}`,
      fsRead: [],
      fsWrite: [],
      timeoutMs: 500,
    });
    expect(out.result.terminationReason).toBe("wall_clock");
  });
});
```

Write `execViaGate()` as a local helper calling `runExecution` with a real `createSandboxRunner()`, an auto-approving `requestApproval`, an in-memory DB, and `enabled: true`.

- [ ] **Step 2: Run on this machine**

Run: `bun test packages/gateway/test/integration/exec-sandbox.integration.test.ts`
Expected: PASS on Windows.

- [ ] **Step 3: Run on Linux — mandatory**

Run: `bun run verify:docker --changed`

Linux is the leg most likely to differ (`bwrap`, the seccomp filter, the helper probe), and a Windows-only pass says nothing about it. If the Linux sandbox helper is unavailable in the container, the gate refuses and these tests will report `refused` — that is a correct outcome, not a pass; skip them with an explicit `skipIf` that names the reason, and note it in the PR body. Do not weaken the assertions to make them green.

- [ ] **Step 4: Register the suite with the cross-platform legs**

Confirm the file is picked up by whatever glob `pr-quality-cross-platform` uses for the sandbox integration suite (see `.github/workflows/`); if it is not, add it. A test that never runs on macOS/Windows proves nothing about them.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/test/integration/exec-sandbox.integration.test.ts
git commit -m "test(exec): prove loopback and filesystem confinement against a real sandbox"
```

---

## Task 11: Documentation and roadmap

**Files:**
- Modify: `CLAUDE.md`, `GEMINI.md` (the invariant list + status line)
- Modify: `docs/architecture.md` (IPC method catalogue)
- Modify: `docs/cli-reference.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/roadmap.md` (§ Active — tick the sandboxed-code-execution row)

- [ ] **Step 1: Add I33 to the invariant lists**

Add the I33 bullet (text from the spec §7) to `CLAUDE.md`'s Security Invariants list after I32, and update the "Invariants through I32 (I28 reserved)" phrase to **I33**. Mirror the identical change into `GEMINI.md` — the two files must not drift.

Also add `D23` to the "Static complement" sentence listing the statically-enforced rules.

- [ ] **Step 2: Update the status line**

`CLAUDE.md`'s status paragraph currently says S2 has shipped nothing. Replace that clause with the first delivered row, dated, and note the slice's bounds honestly (CLI-only, no network, no agent-callable path).

- [ ] **Step 3: Document the CLI**

Add a `nimbus exec` section to `docs/cli-reference.md`: every flag, the exit-code table, and an explicit statement that the LLM cannot invoke it in this release.

- [ ] **Step 4: Document the IPC methods**

Add `exec.run` and `exec.approvalRespond` to `docs/architecture.md`'s IPC method catalogue, flagged **not renderer-exposed** (I7).

- [ ] **Step 5: CHANGELOG + roadmap**

Add a dated `docs/CHANGELOG.md` entry. In `docs/roadmap.md` § Active, tick the sandboxed-code-execution checkbox and append a short delivered-summary naming what did **not** ship (agent-callable, network, `--interactive`, Deno/Python, remote adapters) so the row is not read as complete.

- [ ] **Step 6: Run the doc gates**

Run: `bun run preflight:fast`
Expected: PASS — including `audit:doc-refs` and the readme/CLI drift checks, which fail if a documented command is not registered.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md GEMINI.md docs/
git commit -m "docs: record I33, nimbus exec, and the S2 slice-1 delivery"
```

---

## Final verification

- [ ] **Run the full pre-flight**

Run: `bun run preflight`
Expected: all gates green.

- [ ] **Run the Linux-authoritative pass**

Run: `bun run verify:docker --changed`
Expected: green. Linux-only failures do not reproduce on Windows at all, and this is the largest real PR-failure category.

- [ ] **Check for platform-skipped tests**

Run: `bun run audit:platform-test-gaps`
Expected: it names any test in the diff that cannot execute on this OS. Anything it names has never run locally — say so in the PR body rather than implying it passed.

- [ ] **Open the PR**

Title must carry the conventional-commit type — it is what release-please parses, and squash-merge discards local commit messages entirely. Suggested: `feat(exec): sandboxed code execution behind the I33 owner gate (S2 slice 1)`.

The description becomes the permanent commit body; include the §9 known bounds from the spec verbatim, so the slice's limits are recorded where they cannot be lost.

Then: **wait for `PR quality — required gates` to report green before merging**, or use `gh pr merge --squash --auto`. Merging before green is this repo's most common cause of a red `main`.
