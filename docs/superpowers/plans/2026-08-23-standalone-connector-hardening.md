# Standalone Connector Hardening — Implementation Plan (Part 1: mechanism + pilot)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the consent, scope, budget and audit mechanism that lets a Nimbus MCP connector run safely outside the gateway, and prove it end to end on one pilot connector (`github`).

**Architecture:** A connector's tool surface adapts to *which entrypoint started the process*. The gateway sets `"gateway"` mode at its existing single chokepoint and gets today's full surface, gated by `executor.ts` exactly as now. Everything else defaults to `"standalone"`, where write tools register only if the MCP client advertises `elicitation`, each mutation requires an accepted elicitation plus a server-enforced scope match and budget, and every outcome lands in a SHA-256 hash-chained JSONL audit log.

**Tech Stack:** Bun 1.2+, TypeScript 7 strict, `@modelcontextprotocol/sdk` 1.30.0, `@nimbus-dev/sdk/connector-kit`, `node:crypto`, `bun:test`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-23-standalone-connector-hardening-design.md`](../specs/2026-08-23-standalone-connector-hardening-design.md)

## Scope of this plan

This is **Part 1 of 2**. It builds the whole mechanism and migrates **only `github`** (6 write tools).

**Part 2** — a separate plan, written after this lands — covers the bulk rollout: the remaining ~33
write-capable connectors and ~67 call sites, the 18 in-process connector test files that must set
gateway mode once their connector migrates, and wiring the declared write set into I26's
`isConnectorWriteToolId`.

Part 1 is deliberately inert for every connector except `github`: Tasks 1–7 add new modules nobody
calls yet, so `main` stays green at every commit.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **No new dependencies.** `ALLOWED_CONNECTOR_DEPS` is `@modelcontextprotocol/sdk`, `@nimbus-dev/sdk`, `zod`, `hyparquet`, `imapflow`, `nodemailer`, `tsdav`. Adding one fails `audit:connector-deps`. `@noble/hashes` is **not** available — hashing is `node:crypto`.
- **New `shared/` code must run on Node as well as Bun.** No `Bun.*` globals outside `nimbus-spawn.ts` (Task 9).
- **Licence fields unchanged** — `AGPL-3.0-only` on every connector package.
- **Tests are colocated** as `<name>.test.ts` beside the source, using `bun:test`.
- **Coverage floor: ≥85% line AND ≥80% branch per file**, CI-Linux-authoritative.
- **Branch:** `dev/asafgolombek/connector-extraction`. Never commit on `main`.
- **Every test must be red-proved** — run it and see it fail before writing the implementation. A test that has never failed proves nothing.
- Run `bun run preflight:fast` before the final commit of each task.

---

### Task 1: Connector mode

The process-wide switch every later task reads. Standalone is the default so that a missing gateway
wire degrades to read-only rather than silently ungating.

**Files:**

- Create: `packages/mcp-connectors/shared/connector-mode.ts`
- Test: `packages/mcp-connectors/shared/connector-mode.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type ConnectorMode = "gateway" | "standalone"`, `setConnectorMode(mode: ConnectorMode): void`, `getConnectorMode(): ConnectorMode`, `resetConnectorModeForTests(): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-connectors/shared/connector-mode.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getConnectorMode,
  resetConnectorModeForTests,
  setConnectorMode,
} from "./connector-mode.ts";

describe("connector mode", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
  });
  // bun test shares ONE process across test files, so an unreset lock would change the
  // behaviour of every file that runs after this one.
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("defaults to standalone — a missing gateway wire must degrade to read-only", () => {
    expect(getConnectorMode()).toBe("standalone");
  });

  test("the gateway can opt out explicitly", () => {
    setConnectorMode("gateway");
    expect(getConnectorMode()).toBe("gateway");
  });

  test("re-asserting the same mode is a no-op, so a defensive double-call is safe", () => {
    setConnectorMode("gateway");
    expect(() => {
      setConnectorMode("gateway");
    }).not.toThrow();
    expect(getConnectorMode()).toBe("gateway");
  });

  test("a conflicting change throws rather than silently re-gating mid-process", () => {
    setConnectorMode("gateway");
    expect(() => {
      setConnectorMode("standalone");
    }).toThrow(/already locked to "gateway"/);
  });

  test("reading locks the default, so a LATE gateway wire fails loudly", () => {
    expect(getConnectorMode()).toBe("standalone");
    expect(() => {
      setConnectorMode("gateway");
    }).toThrow(/already locked to "standalone"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/connector-mode.test.ts`
Expected: FAIL — `Cannot find module './connector-mode.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/mcp-connectors/shared/connector-mode.ts`:

```ts
/**
 * Which entrypoint started this connector process, and therefore whether the connector's own
 * consent gate is in force.
 *
 * `"gateway"` — started by `run-bundled-connector.ts` as the gateway's `__nimbus-connector` role.
 * The gateway's executor provides HITL (I2), so the connector registers its full tool surface.
 *
 * `"standalone"` — anything else. The connector hardens itself: write tools register only behind a
 * client that can prompt a human, and every mutation is scope-checked, budgeted and audited.
 *
 * Standalone is the DEFAULT deliberately. If the gateway's one wiring line is ever lost, the
 * gateway degrades to read-only — loud and safe — rather than the standalone build silently
 * ungating. The failure mode must point that way.
 *
 * The mode is derived from which entrypoint ran, never from an env var: Non-Negotiable #2 forbids a
 * consent gate that can be "configured away", and an env var in a client's JSON config is exactly
 * that.
 */
export type ConnectorMode = "gateway" | "standalone";

let current: ConnectorMode | undefined;

/**
 * Lock the mode for this process.
 *
 * Set-once: re-asserting the same value is a no-op, but a CONFLICTING change throws. Reading via
 * `getConnectorMode` also locks, so a gateway wire that runs too late — after a connector module
 * has already registered tools against the default — fails loudly instead of leaving a surface that
 * half-registered under one mode and half under another.
 */
export function setConnectorMode(mode: ConnectorMode): void {
  if (current !== undefined && current !== mode) {
    throw new Error(
      `connector mode already locked to "${current}"; refusing to change it to "${mode}"`,
    );
  }
  current = mode;
}

/** The active mode, locking in the standalone default on first read. */
export function getConnectorMode(): ConnectorMode {
  current ??= "standalone";
  return current;
}

/**
 * TEST-ONLY: clear the lock between cases. Never called from production code — the
 * `audit:connector-consent` gate (Task 11) permits `setConnectorMode` only in the two sanctioned
 * entrypoints, and this function exists so tests never need to reach for it.
 *
 * This matters more than it looks. `bun test` runs MANY TEST FILES IN ONE PROCESS — verified:
 * two files sharing a module observed the same pid, and state set by the first was visible to the
 * second. So a file that locks the mode and does not clear it changes the behaviour of every file
 * that runs after it. Any test file that touches the mode must reset in BOTH `beforeEach` and
 * `afterEach`: `beforeEach` protects this file from its predecessors, `afterEach` protects the
 * suite from this one.
 */
export function resetConnectorModeForTests(): void {
  current = undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/shared/connector-mode.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/shared/connector-mode.ts packages/mcp-connectors/shared/connector-mode.test.ts
git commit -m "feat(connectors): process-wide connector mode, standalone by default"
```

---

### Task 2: Gateway chokepoint

Wire the one line that opts the gateway out. Inert until Task 8 gives a connector something that
reads the mode, but landed early so the wire is reviewed on its own.

**Note for the reviewer:** this adds a static import from `packages/gateway` into
`packages/mcp-connectors/shared`. `apple-caldav-fetch.ts` carries an architecture note saying the
gateway must not import from `packages/mcp-connectors`. That note is about not re-implementing
connector *network/sync logic* gateway-side; `run-bundled-connector.ts` is the file whose entire job
is importing connector modules (it already dynamically imports all 94 `src/server.ts`). No static
audit enforces a blanket ban. Flagged deliberately rather than passed over.

**Files:**

- Modify: `packages/gateway/src/connectors/run-bundled-connector.ts`
- Test: `packages/gateway/src/connectors/run-bundled-connector.test.ts` (create if absent; otherwise append a `describe`)

**Interfaces:**

- Consumes: `setConnectorMode` from Task 1.
- Produces: nothing new. `runBundledConnector(id, registry?)` keeps its existing signature.

- [ ] **Step 1: Write the failing test**

If `run-bundled-connector.test.ts` already exists, APPEND this `describe` and copy any existing
cleanup hooks in that file into it — a `describe` appended to an existing test file that omits its
sibling hooks is a recurring defect in this repo.

```ts
import { afterEach, describe, expect, test } from "bun:test";

import {
  getConnectorMode,
  resetConnectorModeForTests,
} from "../../../mcp-connectors/shared/connector-mode.ts";
import { runBundledConnector } from "./run-bundled-connector.ts";

describe("runBundledConnector sets gateway mode", () => {
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("opts the gateway out of standalone hardening BEFORE loading the connector", async () => {
    let modeAtLoad: string | undefined;
    const registry = {
      probe: () => {
        // Observed at load time, which is when a real connector registers its tools.
        modeAtLoad = getConnectorMode();
        return Promise.resolve({});
      },
    };

    await runBundledConnector("probe", registry);

    expect(modeAtLoad).toBe("gateway");
  });

  test("an unknown id still throws, and does so without leaving the mode unset", async () => {
    await expect(runBundledConnector("nope", {})).rejects.toThrow(/unknown connector id/);
    expect(getConnectorMode()).toBe("gateway");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/run-bundled-connector.test.ts`
Expected: FAIL — `expected "gateway", received "standalone"`.

- [ ] **Step 3: Write minimal implementation**

In `packages/gateway/src/connectors/run-bundled-connector.ts`, add the import and set the mode as
the first statement of `runBundledConnector`, before the registry lookup:

```ts
import { setConnectorMode } from "../../../mcp-connectors/shared/connector-mode.ts";
import { BUNDLED_CONNECTORS } from "./bundled-connector-registry.ts";
```

```ts
export async function runBundledConnector(
  id: string | undefined,
  registry: ConnectorRegistry = BUNDLED_CONNECTORS,
): Promise<void> {
  // I2 lives in the gateway's executor, so a gateway-spawned connector keeps its full tool surface.
  // Set BEFORE the dynamic import below: connectors register tools at module scope, so a mode set
  // afterwards would be read too late. This is the ONLY production caller that passes "gateway".
  setConnectorMode("gateway");

  const load = id === undefined ? undefined : registry[id];
  // ...rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/run-bundled-connector.test.ts`
Expected: PASS.

- [ ] **Step 5: Red-prove the wire by reverting**

Comment out the `setConnectorMode("gateway");` line, re-run the test, confirm it FAILS, then restore
it. A green suite with the line removed would mean the test proves nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/connectors/run-bundled-connector.ts packages/gateway/src/connectors/run-bundled-connector.test.ts
git commit -m "feat(gateway): set gateway connector mode at the bundled-connector chokepoint"
```

---

### Task 3: Write-scope parser

`owner/repo` generalises to nothing, so scope terms are typed `kind:value`. One parser, one matcher,
and an unknown kind is a startup error rather than a rule that silently never matches.

**Files:**

- Create: `packages/mcp-connectors/shared/write-scope.ts`
- Test: `packages/mcp-connectors/shared/write-scope.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type ScopeTerm = { readonly kind: string; readonly value: string }`, `parseWriteScope(raw: string | undefined, allowedKinds: readonly string[]): readonly ScopeTerm[]`, `scopeAllows(scope: readonly ScopeTerm[], kind: string, value: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";

import { parseWriteScope, scopeAllows } from "./write-scope.ts";

const KINDS = ["repo", "dataset"] as const;

describe("parseWriteScope", () => {
  test("an unset scope parses to empty", () => {
    expect(parseWriteScope(undefined, KINDS)).toEqual([]);
    expect(parseWriteScope("", KINDS)).toEqual([]);
  });

  test("parses comma-separated kind:value terms and trims whitespace", () => {
    expect(parseWriteScope(" repo:acme/api , repo:acme/web ", KINDS)).toEqual([
      { kind: "repo", value: "acme/api" },
      { kind: "repo", value: "acme/web" },
    ]);
  });

  test("keeps colons inside the value — a value may itself be qualified", () => {
    expect(parseWriteScope("dataset:proj:analytics", KINDS)).toEqual([
      { kind: "dataset", value: "proj:analytics" },
    ]);
  });

  test("an UNKNOWN kind throws — a silently unmatched rule would fail open", () => {
    expect(() => parseWriteScope("page:abc", KINDS)).toThrow(/unknown scope kind "page"/);
  });

  test("a term with no kind separator throws rather than being guessed at", () => {
    expect(() => parseWriteScope("acme/api", KINDS)).toThrow(/expected "kind:value"/);
  });

  test("an empty value throws", () => {
    expect(() => parseWriteScope("repo:", KINDS)).toThrow(/empty value/);
  });
});

describe("scopeAllows", () => {
  const scope = parseWriteScope("repo:acme/api", KINDS);

  test("an EMPTY scope denies everything — unset must not mean unrestricted", () => {
    expect(scopeAllows([], "repo", "acme/api")).toBe(false);
  });

  test("matches an exact kind+value pair", () => {
    expect(scopeAllows(scope, "repo", "acme/api")).toBe(true);
  });

  test("does not match a different value or a different kind", () => {
    expect(scopeAllows(scope, "repo", "acme/other")).toBe(false);
    expect(scopeAllows(scope, "dataset", "acme/api")).toBe(false);
  });

  test("matching is exact, never a prefix — acme/api must not authorise acme/api-secrets", () => {
    expect(scopeAllows(scope, "repo", "acme/api-secrets")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/write-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * A single allow-list term, e.g. `repo:acme/api` or `dataset:proj.analytics`.
 *
 * `owner/repo` reads naturally for GitHub and generalises to nothing else, so scope terms are typed.
 * Left per-connector this would drift into ~34 private syntaxes.
 */
export type ScopeTerm = { readonly kind: string; readonly value: string };

/**
 * Parse `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` into terms, rejecting any kind the connector did not
 * declare.
 *
 * An unknown kind THROWS at startup rather than parsing into a term that can never match. A rule
 * that silently never matches is indistinguishable from no rule at all, which fails open — the one
 * outcome an allow-list must never have.
 */
export function parseWriteScope(
  raw: string | undefined,
  allowedKinds: readonly string[],
): readonly ScopeTerm[] {
  if (raw === undefined || raw.trim() === "") return [];
  const allowed = new Set(allowedKinds);
  const out: ScopeTerm[] = [];
  for (const piece of raw.split(",")) {
    const term = piece.trim();
    if (term === "") continue;
    const sep = term.indexOf(":");
    if (sep === -1) {
      throw new Error(`write scope term ${JSON.stringify(term)}: expected "kind:value"`);
    }
    const kind = term.slice(0, sep);
    // Not split(":") — a value may itself contain colons and must survive intact.
    const value = term.slice(sep + 1).trim();
    if (!allowed.has(kind)) {
      throw new Error(
        `write scope term ${JSON.stringify(term)}: unknown scope kind ${JSON.stringify(kind)}; ` +
          `this connector accepts: ${allowedKinds.join(", ")}`,
      );
    }
    if (value === "") {
      throw new Error(`write scope term ${JSON.stringify(term)}: empty value`);
    }
    out.push({ kind, value });
  }
  return out;
}

/**
 * Whether the scope authorises one target. Exact match on both fields.
 *
 * An EMPTY scope denies everything: "unset" must mean "no mutations authorised", never
 * "unrestricted". Prefix matching is deliberately absent — `acme/api` must not authorise
 * `acme/api-secrets`.
 */
export function scopeAllows(
  scope: readonly ScopeTerm[],
  kind: string,
  value: string,
): boolean {
  return scope.some((t) => t.kind === kind && t.value === value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/shared/write-scope.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/shared/write-scope.ts packages/mcp-connectors/shared/write-scope.test.ts
git commit -m "feat(connectors): typed kind:value write-scope parser and matcher"
```

---

### Task 4: Audit chain

Append-only JSONL, SHA-256 hash-chained, with timing-safe verification. Same construction as the
gateway's `db/audit-chain.ts`; different primitive because `@noble/hashes` is not reachable from a
connector and the artifact must run on Node.

**Files:**

- Create: `packages/mcp-connectors/shared/audit-chain.ts`
- Test: `packages/mcp-connectors/shared/audit-chain.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type AuditOutcome = "requested" | "accepted" | "declined" | "refused" | "executed" | "failed"`, `type AuditEntry`, `appendAuditEntry(path: string, entry: AuditEntry): Promise<void>`, `verifyAuditChain(path: string): Promise<{ ok: true; count: number } | { ok: false; brokenAtLine: number }>`, `GENESIS_HASH`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendAuditEntry, type AuditEntry, verifyAuditChain } from "./audit-chain.ts";

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-audit-"));
  return join(dir, "audit.jsonl");
}

function entry(tool: string, outcome: AuditEntry["outcome"]): AuditEntry {
  return { ts: "2026-08-23T00:00:00.000Z", tool, outcome, connector: "github", detail: {} };
}

describe("audit chain", () => {
  test("an empty/absent log verifies as an empty chain", async () => {
    const p = await tempLog();
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 0 });
  });

  test("appends verify, and the chain survives multiple entries", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("github_pr_merge", "requested"));
    await appendAuditEntry(p, entry("github_pr_merge", "accepted"));
    await appendAuditEntry(p, entry("github_pr_merge", "executed"));
    expect(await verifyAuditChain(p)).toEqual({ ok: true, count: 3 });
  });

  test("a TAMPERED entry breaks verification at its line", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("github_pr_merge", "declined"));
    await appendAuditEntry(p, entry("github_branch_delete", "executed"));

    const lines = (await readFile(p, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0] as string) as { entry: AuditEntry };
    first.entry.outcome = "accepted";
    lines[0] = JSON.stringify(first);
    await writeFile(p, `${lines.join("\n")}\n`);

    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 1 });
  });

  test("a DELETED middle entry breaks the chain — append-only is enforced by the links", async () => {
    const p = await tempLog();
    await appendAuditEntry(p, entry("a", "executed"));
    await appendAuditEntry(p, entry("b", "executed"));
    await appendAuditEntry(p, entry("c", "executed"));

    const lines = (await readFile(p, "utf8")).trimEnd().split("\n");
    await writeFile(p, `${[lines[0], lines[2]].join("\n")}\n`);

    expect(await verifyAuditChain(p)).toEqual({ ok: false, brokenAtLine: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/audit-chain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";

/**
 * What happened to one gated action. `refused` is a server-side denial (scope, budget, or no
 * elicitation-capable client); `declined` is a human saying no. They are distinct because only one
 * of them means a person was asked.
 */
export type AuditOutcome =
  | "requested"
  | "accepted"
  | "declined"
  | "refused"
  | "executed"
  | "failed";

export type AuditEntry = {
  readonly ts: string;
  readonly connector: string;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  /** Free-form per-outcome detail: resolved params, refusal reason, captured pre-state. */
  readonly detail: Record<string, unknown>;
};

type ChainedLine = { readonly seq: number; readonly prev: string; readonly hash: string; readonly entry: AuditEntry };

/** First link's predecessor. A fixed, all-zero digest, mirroring the gateway's audit chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Hash over the predecessor plus the entry's canonical JSON.
 *
 * Keys are sorted so two structurally identical entries hash identically regardless of insertion
 * order — otherwise a re-serialisation during verification could break a chain that was never
 * tampered with.
 */
function linkHash(prev: string, entry: AuditEntry): string {
  return createHash("sha256").update(prev).update(canonicalJson(entry)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const body = Object.keys(rec)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
    .join(",");
  return `{${body}}`;
}

/** Constant-time digest comparison (I10). Length mismatch is a mismatch, checked first. */
function hashEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readLines(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const trimmed = text.trimEnd();
  return trimmed === "" ? [] : trimmed.split("\n");
}

/** Append one entry, linked to the current tail. */
export async function appendAuditEntry(path: string, entry: AuditEntry): Promise<void> {
  const lines = await readLines(path);
  const last = lines.at(-1);
  const prev =
    last === undefined ? GENESIS_HASH : (JSON.parse(last) as ChainedLine).hash;
  const seq = lines.length + 1;
  const line: ChainedLine = { seq, prev, hash: linkHash(prev, entry), entry };
  await appendFile(path, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Walk the chain. Returns the 1-based line where the links first stop agreeing, which covers both
 * a tampered entry and a deleted one — a deletion breaks the successor's `prev` link.
 */
export async function verifyAuditChain(
  path: string,
): Promise<{ ok: true; count: number } | { ok: false; brokenAtLine: number }> {
  const lines = await readLines(path);
  let prev = GENESIS_HASH;
  for (const [i, raw] of lines.entries()) {
    let line: ChainedLine;
    try {
      line = JSON.parse(raw) as ChainedLine;
    } catch {
      return { ok: false, brokenAtLine: i + 1 };
    }
    if (!hashEquals(line.prev, prev) || !hashEquals(line.hash, linkHash(prev, line.entry))) {
      return { ok: false, brokenAtLine: i + 1 };
    }
    prev = line.hash;
  }
  return { ok: true, count: lines.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/shared/audit-chain.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/shared/audit-chain.ts packages/mcp-connectors/shared/audit-chain.test.ts
git commit -m "feat(connectors): SHA-256 hash-chained JSONL audit log for standalone connectors"
```

---

### Task 5: Consent kit — capability-gated registration

The load-bearing half of the gate: in standalone mode a write tool is not registered at all unless
the client can prompt a human. The model cannot call a tool it never saw.

**Files:**

- Create: `packages/mcp-connectors/shared/consent-kit.ts`
- Test: `packages/mcp-connectors/shared/consent-kit.test.ts`

**Interfaces:**

- Consumes: `getConnectorMode` (Task 1).
- Produces: `type WriteToolConfig`, `type ConsentServer`, `createWriteToolRegistrar(server: ConsentServer, cfg: { connector: string; scopeEnv: string }): WriteToolRegistrar`, `type WriteToolRegistrar`.

`ConsentServer` is a structural subset of `McpServer` so tests can supply a fake without a transport:

```ts
export type ConsentServer = {
  readonly server: {
    getClientCapabilities(): { elicitation?: unknown } | undefined;
    /** Fired after the client's `initialize` — the FIRST moment capabilities are knowable. */
    oninitialized?: (() => void) | undefined;
    elicitInput(
      params: { mode: "form"; message: string; requestedSchema: Record<string, unknown> },
      options?: { timeout?: number },
    ): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
  };
  sendToolListChanged(): void;
  sendLoggingMessage(params: { level: "info" | "warning"; data: unknown }): Promise<void>;
};
```

**Capabilities are NOT knowable at registration time.** Connectors call `registerWriteTool` at
module scope, which runs before `server.connect(transport)` and long before the client's
`initialize` arrives. Verified against the real SDK on 2026-08-23:

```text
getClientCapabilities() at module scope = undefined
would register write tools? false
```

Reading capabilities during registration would therefore register **zero** write tools on *every*
client, including one that fully supports elicitation. Registration is deferred to `oninitialized`
instead — which is what the spec (§6) always said. The tests below drive `oninitialized` explicitly,
because a fake server that answers `getClientCapabilities()` synchronously would hide exactly this
bug.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { resetConnectorModeForTests, setConnectorMode } from "./connector-mode.ts";
import { type ConsentServer, createWriteToolRegistrar } from "./consent-kit.ts";

type Registered = { name: string };

/**
 * `capsReadable` models the real SDK: capabilities are `undefined` until `initialize` lands.
 * A fake that answers synchronously from the start would hide the whole bug this guards.
 */
function fakeServer(opts: {
  elicitation: boolean;
}): ConsentServer & { registered: Registered[]; handshake: () => void } {
  const registered: Registered[] = [];
  let capsReadable = false;
  const srv = {
    registered,
    server: {
      getClientCapabilities: () =>
        capsReadable ? (opts.elicitation ? { elicitation: {} } : {}) : undefined,
      oninitialized: undefined as (() => void) | undefined,
      elicitInput: () => Promise.resolve({ action: "accept" as const, content: { confirm: true } }),
    },
    registerTool: (name: string) => {
      registered.push({ name });
      return { disable: () => undefined };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
    /** Simulate the client's `initialize` completing. */
    handshake: () => {
      capsReadable = true;
      srv.server.oninitialized?.();
    },
  } as unknown as ConsentServer & { registered: Registered[]; handshake: () => void };
  return srv;
}

const schema = z.object({ branch: z.string() });

describe("write tool registration", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
  });

  test("gateway mode registers the write tool — executor.ts is the gate there", () => {
    setConnectorMode("gateway");
    const srv = fakeServer({ elicitation: false });
    const reg = createWriteToolRegistrar(srv, { connector: "github", scopeEnv: "X", scopeKinds: ["repo"] });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    // No handshake needed: the gateway does not consult client capabilities at all.
    expect(srv.registered.map((r) => r.name)).toEqual(["github_branch_delete"]);
  });

  test("standalone WITHOUT elicitation does not register the tool at all", () => {
    setConnectorMode("standalone");
    const srv = fakeServer({ elicitation: false });
    const reg = createWriteToolRegistrar(srv, { connector: "github", scopeEnv: "X", scopeKinds: ["repo"] });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    srv.handshake();
    expect(srv.registered).toEqual([]);
  });

  test("standalone WITH elicitation registers it AFTER the handshake", () => {
    setConnectorMode("standalone");
    const srv = fakeServer({ elicitation: true });
    const reg = createWriteToolRegistrar(srv, { connector: "github", scopeEnv: "X", scopeKinds: ["repo"] });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());

    // THE REGRESSION GUARD. Capabilities are unknowable at module scope — verified against the
    // real SDK, where getClientCapabilities() returns undefined before initialize. A registrar
    // that decided here would register nothing, for every client, forever.
    expect(srv.registered).toEqual([]);

    srv.handshake();
    expect(srv.registered.map((r) => r.name)).toEqual(["github_branch_delete"]);
  });

  test("a second initialize does not double-register", () => {
    setConnectorMode("standalone");
    const srv = fakeServer({ elicitation: true });
    const reg = createWriteToolRegistrar(srv, { connector: "github", scopeEnv: "X", scopeKinds: ["repo"] });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    srv.handshake();
    srv.handshake();
    expect(srv.registered).toHaveLength(1);
  });

  test("a config with recoverable:false and NO capturePreState is rejected at registration", () => {
    setConnectorMode("gateway");
    const srv = fakeServer({ elicitation: true });
    const reg = createWriteToolRegistrar(srv, { connector: "github", scopeEnv: "X", scopeKinds: ["repo"] });
    expect(() =>
      reg(
        "github_branch_delete",
        {
          mutates: "repo.branch.delete",
          recoverable: false,
          // capturePreState deliberately absent — that is what this case asserts.
          scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
        },
        "desc",
        schema,
        async () => ok(),
      ),
    ).toThrow(/capturePreState is required when recoverable is false/);
  });
});

function ok() {
  return { content: [{ type: "text" as const, text: "{}" }] };
}

function cfgFor() {
  return {
    mutates: "repo.branch.delete",
    recoverable: false,
    capturePreState: () => Promise.resolve({ sha: "abc" }),
    scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/consent-kit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `consent-kit.ts` with the types from the Interfaces block plus:

```ts
import type { McpListResult, ZodObjectSchema } from "@nimbus-dev/sdk/connector-kit";

import { getConnectorMode } from "./connector-mode.ts";

export type WriteToolConfig<T> = {
  /** Action type this tool performs, e.g. "repo.branch.delete". Machine-readable, not prose. */
  readonly mutates: string;
  /** False when the mutation cannot be undone — which is when pre-state capture is mandatory. */
  readonly recoverable: boolean;
  /** Required when `recoverable` is false. Runs BEFORE the mutation; result is audited verbatim. */
  readonly capturePreState?: (args: T) => Promise<Record<string, unknown>>;
  /** The scope target this invocation would touch, checked against the allow-list. */
  readonly scopeTargetOf: (args: T) => { kind: string; value: string };
};

export type WriteToolRegistrar = <T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
) => void;

export function createWriteToolRegistrar(
  server: ConsentServer,
  cfg: {
    readonly connector: string;
    readonly scopeEnv: string;
    /**
     * Scope kinds this connector accepts. Declared once per connector rather than per tool: the
     * allow-list is parsed at registrar construction, before any tool has registered, so a
     * per-tool declaration would arrive too late to validate the env value. An env term of any
     * other kind is a startup error (see `parseWriteScope`).
     */
    readonly scopeKinds: readonly string[];
  },
): WriteToolRegistrar {
  const handles: ToolHandle[] = [];
  const pending: Array<() => void> = [];
  let flushed = false;

  /**
   * Decide the write surface, once, at the first moment client capabilities are knowable.
   *
   * Default-DENY: if the client cannot prompt a human, the queued tools are dropped and never
   * appear in `tools/list` at all. Refusing at call time instead would still advertise a tool the
   * model must not use.
   */
  function flushWriteTools(): void {
    if (flushed) return;
    flushed = true;
    const caps = server.server.getClientCapabilities();
    if (caps?.elicitation === undefined) {
      pending.length = 0;
      return;
    }
    for (const register of pending) register();
    pending.length = 0;
    // The tool list changed after `initialize`, so the client must be told to re-read it.
    if (handles.length > 0) server.sendToolListChanged();
  }

  if (getConnectorMode() === "standalone") {
    // An empty scope denies every mutation, which is the correct default but looks identical to a
    // broken connector from the outside. Say so on stderr — safe for a stdio server, whose PROTOCOL
    // channel is stdout; writing this to stdout would corrupt the JSON-RPC stream.
    if (parseWriteScope(process.env[cfg.scopeEnv], cfg.scopeKinds).length === 0) {
      process.stderr.write(
        `nimbus-mcp ${cfg.connector}: ${cfg.scopeEnv} is unset or empty, so every write tool ` +
          `will refuse. Set it to a comma-separated list of ${cfg.scopeKinds.join("|")}:value ` +
          "terms to enable writes.\n",
      );
    }
    // Chain rather than overwrite: another module may already own this hook, and clobbering it
    // would silently disable whatever it did.
    const prev = server.server.oninitialized;
    server.server.oninitialized = (): void => {
      prev?.();
      flushWriteTools();
    };
  }

  return <T>(
    name: string,
    toolCfg: WriteToolConfig<T>,
    description: string,
    schema: ZodObjectSchema<T>,
    handler: (args: T) => Promise<McpListResult>,
  ): void => {
    // Checked at REGISTRATION, not on first call: a missing capture on a destructive tool is a
    // programming error, and it must surface at boot rather than on the one call that needed it.
    if (!toolCfg.recoverable && toolCfg.capturePreState === undefined) {
      throw new Error(
        `${name}: capturePreState is required when recoverable is false — an unrecoverable ` +
          "mutation must record enough pre-state to be undone",
      );
    }

    // Gateway mode registers the RAW handler immediately: executor.ts (I2) is the gate there, and
    // client capabilities are irrelevant. Scope, budget and connector-side audit do not apply —
    // the gateway has its own.
    if (getConnectorMode() === "gateway") {
      registerOn(server, name, description, schema, handler, handles);
      return;
    }

    // Standalone: QUEUE it. Capabilities are unknowable until `initialize` has been received, and
    // registration happens at module scope, so deciding here would deny every client.
    pending.push(() => registerOn(server, name, description, schema, guarded, handles));
  };
}
```

And the private registration helper, kept separate so Task 6 can insert a consent wrapper around
`handler` without touching registration:

**Do not route this through `registerZodTool`.** Verified in
`@nimbus-dev/sdk/dist/connector-kit/mcp-tool-kit.js`: it calls `registerSimpleTool(...)` and
**discards the return value**, and `createRegisterSimpleTool` binds the SDK's **deprecated**
`server.tool`. Neither yields the `RegisteredTool` that Task 7's budget needs in order to
unregister. Call `server.registerTool` directly — it returns `RegisteredTool`, which has
`enable()` / `disable()` / `remove()`:

```ts
/** The subset of the SDK's RegisteredTool this kit needs. */
export type ToolHandle = { disable(): void };

function registerOn<T>(
  server: ConsentServer,
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
  handles: ToolHandle[],
): void {
  const handle = server.registerTool(
    name,
    { description, inputSchema: schema.shape },
    async (args: unknown): Promise<McpListResult> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      return handler(parsed.data);
    },
  );
  // Collected so budget exhaustion (Task 7) can disable every write tool at once.
  handles.push(handle);
}
```

Add `registerTool` to the `ConsentServer` structural type:

```ts
readonly registerTool: (
  name: string,
  config: { description?: string; inputSchema?: Record<string, unknown> },
  cb: (args: unknown) => Promise<McpListResult>,
) => ToolHandle;
```

`handles` is created per registrar inside `createWriteToolRegistrar`, not module-global, so two
connectors in one process cannot disable each other's tools.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/shared/consent-kit.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/shared/consent-kit.ts packages/mcp-connectors/shared/consent-kit.test.ts
git commit -m "feat(connectors): capability-gated write-tool registration for standalone mode"
```

---

### Task 6: Consent kit — elicitation consent

Wrap the handler so a mutation happens only after a human accepts. Decline, cancel, timeout, and
transport error all mutate nothing.

**Files:**

- Modify: `packages/mcp-connectors/shared/consent-kit.ts`
- Modify: `packages/mcp-connectors/shared/consent-kit.test.ts`

**Interfaces:**

- Consumes: Task 5's registrar.
- Produces: no new exports; `createWriteToolRegistrar`'s returned tools now consent before running.

- [ ] **Step 1: Write the failing test**

Append to `consent-kit.test.ts`:

```ts
describe("elicitation consent", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });

  test("accept with confirm:true runs the handler exactly once", async () => {
    let calls = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    await call({ branch: "acme/api" });
    expect(calls).toBe(1);
  });

  for (const action of ["decline", "cancel"] as const) {
    test(`${action} mutates NOTHING`, async () => {
      let calls = 0;
      const srv = serverWith(() => Promise.resolve({ action }));
      const call = registerAndGet(srv, async () => {
        calls += 1;
        return ok();
      });
      const res = await call({ branch: "acme/api" });
      expect(calls).toBe(0);
      expect(JSON.stringify(res)).toMatch(/not approved/i);
    });
  }

  test("accept with confirm:false is a REFUSAL — the action field alone is not consent", async () => {
    let calls = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: false } }));
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    await call({ branch: "acme/api" });
    expect(calls).toBe(0);
  });

  test("an elicitation that THROWS (timeout, transport) mutates nothing — fail-closed", async () => {
    let calls = 0;
    const srv = serverWith(() => Promise.reject(new Error("timed out")));
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    const res = await call({ branch: "acme/api" });
    expect(calls).toBe(0);
    expect(JSON.stringify(res)).toMatch(/not approved/i);
  });

  test("the prompt carries the VERBATIM params, never a digest", async () => {
    let seen = "";
    const srv = serverWith((p) => {
      seen = p.message;
      return Promise.resolve({ action: "decline" });
    });
    const call = registerAndGet(srv, async () => ok());
    await call({ branch: "acme/api" });
    expect(seen).toContain("repo.branch.delete");
    expect(seen).toContain("acme/api");
  });
});
```

Add these helpers to the test file:

```ts
type Elicit = (p: { message: string }) => Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}>;

type FakeServer = ConsentServer & {
  captured: ((args: unknown) => Promise<McpListResult>) | undefined;
  onUnregister?: () => void;
  /** Simulate the client's `initialize` completing, which is what flushes the write tools. */
  handshake: () => void;
};

function serverWith(elicit: Elicit): FakeServer {
  let capsReadable = false;
  const srv: FakeServer = {
    captured: undefined,
    server: {
      // Mirrors the real SDK: undefined until initialize.
      getClientCapabilities: () => (capsReadable ? { elicitation: {} } : undefined),
      oninitialized: undefined,
      elicitInput: (p) => elicit(p),
    },
    registerTool: (_name, _config, cb) => {
      srv.captured = cb;
      return {
        disable: () => {
          srv.onUnregister?.();
        },
      };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
    handshake: () => {
      capsReadable = true;
      srv.server.oninitialized?.();
    },
  } as unknown as FakeServer;
  return srv;
}

/** Register one write tool and hand back the WRAPPED handler the client would call. */
function registerAndGet(
  srv: FakeServer,
  handler: () => Promise<McpListResult>,
  opts: { scope?: string; budget?: number; auditLog?: string } = {},
): (args: { branch: string }) => Promise<McpListResult> {
  process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = opts.scope ?? "";
  process.env["NIMBUS_MCP_WRITE_BUDGET"] = String(opts.budget ?? 10);
  if (opts.auditLog !== undefined) process.env["NIMBUS_MCP_AUDIT_LOG"] = opts.auditLog;

  const reg = createWriteToolRegistrar(srv, {
    connector: "github",
    scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
    scopeKinds: ["repo"],
  });
  reg(
    "github_branch_delete",
    {
      mutates: "repo.branch.delete",
      recoverable: false,
      capturePreState: () => Promise.resolve({ sha: "abc" }),
      scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
    },
    "Delete a branch.",
    z.object({ branch: z.string() }),
    handler,
  );
  // Standalone write tools are queued at registration and flushed on initialize. Without this the
  // tool is never registered and `captured` stays undefined — which is the bug, not the test.
  srv.handshake();
  const cb = srv.captured;
  if (cb === undefined) throw new Error("tool was not registered");
  return (args) => cb(args);
}

async function tempAuditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-consent-"));
  return join(dir, "audit.jsonl");
}
```

Add the imports these need at the top of the test file: `mkdtemp`/`readFile` from
`node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`, `verifyAuditChain` from
`./audit-chain.ts`, and `McpListResult` from `@nimbus-dev/sdk/connector-kit`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/consent-kit.test.ts`
Expected: FAIL — the handler runs without consent (`calls` is 1 where 0 is expected).

- [ ] **Step 3: Write minimal implementation**

In `consent-kit.ts`, wrap `handler` before registering (standalone mode only):

```ts
const REFUSED = (why: string): McpListResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, error: `not approved: ${why}` }) }],
});

async function consented(
  server: ConsentServer,
  mutates: string,
  params: unknown,
): Promise<boolean> {
  let res: { action: string; content?: Record<string, unknown> };
  try {
    res = await server.server.elicitInput({
      mode: "form",
      // The VERBATIM operation and parameters, never a digest: a digest is a rubber stamp with
      // extra steps, and the human is the entire boundary here.
      message:
        `Nimbus is about to perform ${mutates} with:\n` +
        `${JSON.stringify(params, null, 2)}\n\nApprove?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Approve this action", description: mutates },
        },
        required: ["confirm"],
      },
    });
  } catch {
    // Timeout, transport failure, or a client that rejects the request: fail CLOSED.
    return false;
  }
  // `action: "accept"` alone is not consent — the form's own answer must also be true.
  return res.action === "accept" && res.content?.["confirm"] === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/shared/consent-kit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/shared/consent-kit.ts packages/mcp-connectors/shared/consent-kit.test.ts
git commit -m "feat(connectors): elicitation consent gate, fail-closed on decline/cancel/timeout"
```

---

### Task 7: Consent kit — scope, budget, pre-state, audit

The controls that hold even against a hostile or auto-accepting client.

**Files:**

- Modify: `packages/mcp-connectors/shared/consent-kit.ts`
- Modify: `packages/mcp-connectors/shared/consent-kit.test.ts`

**Interfaces:**

- Consumes: `parseWriteScope`/`scopeAllows` (Task 3), `appendAuditEntry` (Task 4).
- Produces: reads env `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE`, `NIMBUS_MCP_WRITE_BUDGET` (default `10`), `NIMBUS_MCP_AUDIT_LOG`.

- [ ] **Step 1: Write the failing test**

Append to `consent-kit.test.ts`:

```ts
describe("client-independent controls", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });

  test("an out-of-scope target refuses BEFORE prompting — no human is asked to allow it", async () => {
    let prompted = 0;
    const srv = serverWith(() => {
      prompted += 1;
      return Promise.resolve({ action: "accept", content: { confirm: true } });
    });
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api" });
    const res = await call({ branch: "acme/other" });
    expect(prompted).toBe(0);
    expect(JSON.stringify(res)).toMatch(/out of scope/i);
  });

  test("an EMPTY scope refuses every mutation — unset is not unrestricted", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const call = registerAndGet(srv, async () => ok(), { scope: undefined });
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toMatch(/out of scope/i);
  });

  test("budget exhaustion unregisters the tool AND still refuses a call that arrives", async () => {
    let unregistered = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.onUnregister = () => {
      unregistered += 1;
    };
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api", budget: 1 });
    await call({ branch: "acme/api" });
    expect(unregistered).toBe(1);
    // A call already in flight, or a client ignoring list_changed, still reaches the handler.
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toMatch(/budget/i);
  });

  test("capturePreState runs before the mutation and reaches the audit log", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const log = await tempAuditPath();
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api", auditLog: log });
    await call({ branch: "acme/api" });
    const text = await readFile(log, "utf8");
    expect(text).toContain('"preState"');
    expect(text).toContain("abc");
    expect(await verifyAuditChain(log)).toMatchObject({ ok: true });
  });

  test("a refusal is audited too — the log records what was NOT allowed", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "decline" }));
    const log = await tempAuditPath();
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api", auditLog: log });
    await call({ branch: "acme/api" });
    expect(await readFile(log, "utf8")).toContain('"declined"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/consent-kit.test.ts`
Expected: FAIL — scope/budget/audit not implemented.

- [ ] **Step 3: Write minimal implementation**

The order inside the wrapped handler is load-bearing. Replace the Task 6 wrapper with this:

```ts
const DEFAULT_BUDGET = 10;

function refused(why: string): McpListResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: why }) }] };
}

// Inside createWriteToolRegistrar, before returning the registrar:
const scope = parseWriteScope(process.env[cfg.scopeEnv], cfg.scopeKinds);
const auditLog = process.env["NIMBUS_MCP_AUDIT_LOG"];
const handles: ToolHandle[] = [];
let remaining = Number(process.env["NIMBUS_MCP_WRITE_BUDGET"] ?? DEFAULT_BUDGET);

async function record(
  tool: string,
  outcome: AuditOutcome,
  detail: Record<string, unknown>,
): Promise<void> {
  // Client-visible channel: any MCP client can display or persist this.
  await server.sendLoggingMessage({
    level: outcome === "executed" ? "info" : "warning",
    data: { connector: cfg.connector, tool, outcome },
  });
  // Durable channel: only when the operator configured a path.
  if (auditLog !== undefined && auditLog !== "") {
    await appendAuditEntry(auditLog, {
      ts: new Date().toISOString(),
      connector: cfg.connector,
      tool,
      outcome,
      detail,
    });
  }
}

// The wrapped handler:
async function guarded(args: T): Promise<McpListResult> {
  const target = toolCfg.scopeTargetOf(args);

  // 1. SCOPE FIRST — before prompting. Asking a human to approve something the operator already
  //    forbade cannot change the outcome, and training people to click through prompts that do
  //    not matter is how you make the prompts that do matter ineffective.
  if (!scopeAllows(scope, target.kind, target.value)) {
    await record(name, "refused", { reason: "out of scope", target });
    return refused(`out of scope: ${target.kind}:${target.value} is not in ${cfg.scopeEnv}`);
  }

  // 2. BUDGET — same reasoning: a refusal that consent cannot lift comes before consent.
  if (remaining <= 0) {
    await record(name, "refused", { reason: "budget exhausted", target });
    return refused("write budget exhausted for this session");
  }

  // 3. CONSENT.
  await record(name, "requested", { target, params: args });
  if (!(await consented(server, toolCfg.mutates, args))) {
    await record(name, "declined", { target });
    return refused("not approved: the operation was declined, cancelled, or timed out");
  }
  await record(name, "accepted", { target });

  // 4. PRE-STATE — after approval, before the mutation, so an unrecoverable action leaves a
  //    record of what it destroyed. Capture failure is NOT fatal: refusing here would turn a
  //    transient read error into a blocked approved action. It is recorded instead.
  let preState: Record<string, unknown> = {};
  if (toolCfg.capturePreState !== undefined) {
    try {
      preState = await toolCfg.capturePreState(args);
    } catch (e) {
      preState = { captureFailed: e instanceof Error ? e.message : String(e) };
    }
  }

  // 5. MUTATE. Decrement BEFORE the call so a throwing mutation still consumes budget — otherwise
  //    a failing destructive tool could be retried without limit.
  remaining -= 1;
  if (remaining <= 0) {
    for (const h of handles) h.disable();
    server.sendToolListChanged();
  }
  try {
    const result = await handler(args);
    await record(name, "executed", { target, preState });
    return result;
  } catch (e) {
    await record(name, "failed", {
      target,
      preState,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
```

Unregistering on exhaustion is ergonomics; the `remaining <= 0` check at step 2 is the boundary. A
call already in flight, or a client that ignores `tools/list_changed`, still reaches the handler.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-connectors/shared/consent-kit.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify coverage meets the floor**

Run: `bun test packages/mcp-connectors/shared/ --coverage`
Expected: `consent-kit.ts`, `write-scope.ts`, `audit-chain.ts`, `connector-mode.ts` each ≥85% line, ≥80% branch.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-connectors/shared/consent-kit.ts packages/mcp-connectors/shared/consent-kit.test.ts
git commit -m "feat(connectors): scope allow-list, mutation budget, pre-state capture and audit"
```

---

### Task 8: Pilot — migrate `github`'s write tools

Six tools move from prose-documented to declared. This is the first task where behaviour changes.

**Files:**

- Modify: `packages/mcp-connectors/github/src/server.ts`
- Test: `packages/mcp-connectors/github/test/write-tools.test.ts` (create)

**Interfaces:**

- Consumes: `createWriteToolRegistrar` (Tasks 5–7).
- Produces: nothing consumed by later tasks.

The six: `github_pr_merge` (`repo.pr.merge`), `github_pr_close` (`repo.pr.close`),
`github_issue_create` (`repo.issue.create`), `github_branch_delete` (`repo.branch.delete`),
`github_tag_create` (`repo.tag.create`), and `github_commit_push` — which returns `NOT_IMPLEMENTED`
and performs no mutation, so it stays on the plain registrar. **Five** tools migrate.

`scopeKinds: ["repo"]` is declared once on the registrar. Each tool's `scopeTargetOf` returns a term of kind `repo` whose value is the owner/repo slug.
`recoverable` is `false` for `github_branch_delete` only, whose `capturePreState` fetches
`/git/ref/heads/<branch>` and records the SHA; the other four are `true`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  resolve(fileURLToPath(import.meta.url), "../../src/server.ts"),
  "utf8",
);

describe("github write tools are declared, not prose", () => {
  for (const tool of [
    "github_pr_merge",
    "github_pr_close",
    "github_issue_create",
    "github_branch_delete",
    "github_tag_create",
  ]) {
    test(`${tool} registers through the write registrar`, () => {
      const idx = src.indexOf(`"${tool}"`);
      expect(idx).toBeGreaterThan(-1);
      expect(src.slice(Math.max(0, idx - 200), idx)).toContain("registerWriteTool");
    });
  }

  test("github_branch_delete declares itself unrecoverable and captures pre-state", () => {
    const idx = src.indexOf('"github_branch_delete"');
    const block = src.slice(idx, idx + 800);
    expect(block).toContain("recoverable: false");
    expect(block).toContain("capturePreState");
  });

  test("github_commit_push stays on the plain registrar — it mutates nothing", () => {
    const idx = src.indexOf('"github_commit_push"');
    expect(src.slice(Math.max(0, idx - 200), idx)).not.toContain("registerWriteTool");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/github/test/write-tools.test.ts`
Expected: FAIL — no `registerWriteTool` in `server.ts`.

- [ ] **Step 3: Write minimal implementation**

Add to `github/src/server.ts`:

```ts
import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "github",
  scopeEnv: "NIMBUS_MCP_GITHUB_WRITE_SCOPE",
  scopeKinds: ["repo"],
});
```

Convert each of the five, e.g.:

```ts
registerWriteTool(
  "github_branch_delete",
  {
    mutates: "repo.branch.delete",
    recoverable: false,
    scopeTargetOf: (p) => ({ kind: "repo", value: `${p.owner}/${p.repo}` }),
    capturePreState: async (p) => {
      const res = await ghFetch(
        requireProcessEnv("GITHUB_PAT"),
        `${slug(p.owner, p.repo)}/git/ref/${encodeURIComponent(`heads/${p.branch}`)}`,
      );
      return { ref: `heads/${p.branch}`, sha: res.json, restorable: res.ok };
    },
  },
  "Delete a branch by ref name.",
  githubBranchDeleteSchema,
  async (parsed) => { /* existing body unchanged */ },
);
```

Remove `(requires HITL …)` from each migrated description — the requirement is now declared in
`mutates`, and leaving both invites them to drift.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/mcp-connectors/github`
Expected: PASS.

- [ ] **Step 5: Verify the gateway path is unchanged**

Run: `bun test packages/gateway/src/connectors`
Expected: PASS — gateway mode still registers all five.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-connectors/github/src/server.ts packages/mcp-connectors/github/test/write-tools.test.ts
git commit -m "feat(github): declare the five mutating tools through the write registrar"
```

---

### Task 9: `nimbusSpawn` shim

Standalone runs on Node; `Bun.spawn` does not exist there.

**Files:**

- Create: `packages/mcp-connectors/shared/nimbus-spawn.ts`
- Test: `packages/mcp-connectors/shared/nimbus-spawn.test.ts`
- Modify: `packages/mcp-connectors/shared/run-cli-json.ts`

**Interfaces:**

- Produces: `nimbusSpawn(command: readonly string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }>`.

**Two Node APIs are forbidden here.** `spawnSync` blocks the event loop, deadlocking a stdio server
against its own in-flight elicitation. `execFile` caps output at a 1 MB `maxBuffer` by default —
`runCliJson` reads uncapped today via `new Response(proc.stdout).text()`, and `aws logs` /
`gcloud logging` JSON exceeds 1 MB routinely, so `execFile` would be a silent-truncation regression
disguised as a portability fix. Use `child_process.spawn` with stream accumulation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";

import { nimbusSpawn } from "./nimbus-spawn.ts";

describe("nimbusSpawn", () => {
  test("captures stdout and a zero exit", async () => {
    const r = await nimbusSpawn([process.execPath, "-e", "console.log('hi')"], {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });

  test("captures stderr and a non-zero exit", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "console.error('boom'); process.exit(3)"],
      {},
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  test("passes env through", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "console.log(process.env.NIMBUS_TEST_VAL)"],
      { NIMBUS_TEST_VAL: "set" },
    );
    expect(r.stdout.trim()).toBe("set");
  });

  test("output above 1MB is NOT truncated — the execFile maxBuffer trap", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(2_000_000))"],
      {},
    );
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(2_000_000);
  });

  test("multi-byte UTF-8 spanning chunk boundaries is not corrupted", async () => {
    // The previous case is pure ASCII and cannot catch per-chunk decoding. This one can: a large
    // run of 3-byte characters guarantees some character straddles a pipe chunk boundary.
    const r = await nimbusSpawn(
      [process.execPath, "-e", "process.stdout.write('豆'.repeat(400_000))"],
      {},
    );
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(400_000);
    // U+FFFD REPLACEMENT CHARACTER is what per-chunk decoding produces at a split boundary.
    expect(r.stdout).not.toContain("�");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/shared/nimbus-spawn.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { spawn } from "node:child_process";

/**
 * Spawn a CLI and collect its output, on Bun or Node.
 *
 * Deliberately NOT `spawnSync` (blocks the event loop — fatal in a stdio MCP server that must keep
 * answering JSON-RPC, including an in-flight elicitation round-trip) and NOT `execFile` (1 MB
 * `maxBuffer` default; `aws logs` and `gcloud logging` JSON exceed it, and the Bun implementation
 * this replaces was uncapped).
 */
export function nimbusSpawn(
  command: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const [bin, ...args] = command;
  if (bin === undefined) return Promise.resolve({ code: 1, stdout: "", stderr: "empty command" });
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env } });
    // Accumulate RAW BUFFERS and decode once at the end. Decoding each chunk with
    // `chunk.toString("utf8")` corrupts any multi-byte character that straddles a chunk boundary,
    // and chunk boundaries are a function of pipe timing — so it fails intermittently, on
    // non-ASCII data, in production. `aws`/`gcloud` JSON routinely contains non-ASCII.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => {
      outChunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      errChunks.push(c);
    });
    const decode = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(outChunks).toString("utf8"),
      stderr: Buffer.concat(errChunks).toString("utf8"),
    });
    child.on("error", (e) => {
      const d = decode();
      resolveP({ code: 1, stdout: d.stdout, stderr: `${d.stderr}${e.message}` });
    });
    child.on("close", (code) => {
      resolveP({ code: code ?? 1, ...decode() });
    });
  });
}
```

Then replace both `Bun.spawn` blocks in `run-cli-json.ts` with `nimbusSpawn`, preserving the
existing return shapes and error strings exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/mcp-connectors/shared/nimbus-spawn.test.ts packages/mcp-connectors/shared/run-cli-json.test.ts`
Expected: PASS, including the pre-existing `run-cli-json` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/shared/nimbus-spawn.ts packages/mcp-connectors/shared/nimbus-spawn.test.ts packages/mcp-connectors/shared/run-cli-json.ts
git commit -m "feat(connectors): cross-runtime nimbusSpawn, replacing Bun.spawn in run-cli-json"
```

---

### Task 10: Standalone launcher

One `nimbus-mcp <id>` bin for all 94, rather than repairing 94 dead `bin` entries.

**Files:**

- Create: `packages/mcp-connectors/standalone/package.json`
- Create: `packages/mcp-connectors/standalone/src/launcher.ts`
- Test: `packages/mcp-connectors/standalone/src/launcher.test.ts`
- Modify: root `package.json` (add `packages/mcp-connectors/standalone` to `workspaces`)

`standalone/` has no `src/server.ts`, so `bundledConnectorIds` skips it and the registry stays at 94.

**Interfaces:**

- Consumes: `setConnectorMode` (Task 1).
- Produces: `resolveConnectorEntry(id: string): string`, `runStandalone(argv: readonly string[]): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";

import { resolveConnectorEntry, runStandalone } from "./launcher.ts";

describe("standalone launcher", () => {
  test("resolves a known connector id to its server entry", () => {
    expect(resolveConnectorEntry("github")).toMatch(/mcp-connectors[\\/]github[\\/]src[\\/]server\.ts$/);
  });

  test("rejects an id containing a path separator — no traversal via the id", () => {
    expect(() => resolveConnectorEntry("../gateway/src/index")).toThrow(/invalid connector id/);
    expect(() => resolveConnectorEntry("a/b")).toThrow(/invalid connector id/);
  });

  test("exits non-zero with usage when no id is given", async () => {
    expect(await runStandalone([])).toBe(2);
  });

  test("exits non-zero for an unknown connector", async () => {
    expect(await runStandalone(["definitely-not-a-connector"])).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/standalone/src/launcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Connector ids are directory names: lowercase, digits and hyphens only. */
const ID_RE = /^[a-z0-9-]+$/;

/**
 * Resolve a connector id to its server entrypoint.
 *
 * The id is validated against a strict allow-list BEFORE being joined into a path. A separator or
 * `..` would otherwise let the id escape the connectors directory and import an arbitrary module.
 */
export function resolveConnectorEntry(id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error(
      `invalid connector id ${JSON.stringify(id)}: expected only lowercase letters, digits and hyphens`,
    );
  }
  const connectorsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(connectorsDir, id, "src", "server.ts");
}

/**
 * Start one connector standalone.
 *
 * Deliberately does NOT call `setConnectorMode("standalone")`. Standalone is the DEFAULT, so
 * asserting it here would add a second production caller — which the `audit:connector-consent`
 * gate forbids — while changing nothing. Do not "fix" this omission.
 */
export async function runStandalone(argv: readonly string[]): Promise<number> {
  const id = argv[0];
  if (id === undefined) {
    process.stderr.write("usage: nimbus-mcp <connector-id>\n");
    return 2;
  }
  let entry: string;
  try {
    entry = resolveConnectorEntry(id);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (!existsSync(entry)) {
    process.stderr.write(`unknown connector ${JSON.stringify(id)}\n`);
    return 2;
  }
  const mod = (await import(entry)) as { startConnector?: () => Promise<void> };
  // Mirrors run-bundled-connector.ts: 84 connectors connect their transport at module scope, 10
  // guard on import.meta.main and export startConnector() instead.
  await mod.startConnector?.();
  return 0;
}

if (import.meta.main) {
  process.exit(await runStandalone(process.argv.slice(2)));
}
```

`standalone/package.json`:

```json
{
  "name": "nimbus-mcp",
  "version": "0.1.0",
  "private": false,
  "license": "AGPL-3.0-only",
  "type": "module",
  "bin": { "nimbus-mcp": "./dist/launcher.js" },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src/", "test": "bun test" },
  "dependencies": { "@modelcontextprotocol/sdk": "1.30.0", "@nimbus-dev/sdk": "^1.18.0" }
}
```

- [ ] **Step 4: Run tests and the connector audits**

Run: `bun test packages/mcp-connectors/standalone && bun run audit:connector-deps && bun run audit:connector-entrypoints && bun run audit:connector-registry-drift`
Expected: PASS; registry drift still reports 94.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/standalone package.json
git commit -m "feat(connectors): nimbus-mcp standalone launcher for all connectors"
```

---

### Task 11: Static audits

Make "the mode comes from the entrypoint" a mechanism rather than a convention.

**Files:**

- Create: `scripts/structure-audit/check-connector-consent.ts`
- Test: `scripts/structure-audit/check-connector-consent.test.ts`
- Modify: `package.json` (add `audit:connector-consent`)
- Modify: `scripts/lib/preflight-gates.ts` (register the gate, or the drift test fails)

**Interfaces:**

- Produces: `checkConnectorConsent(root?: string): ConsentViolation[]`.

Two rules:

1. `setConnectorMode(` appears only in `packages/gateway/src/connectors/run-bundled-connector.ts`, in
   `shared/connector-mode.ts` itself, and in `*.test.ts` files.
2. Any connector `src/**` file containing a mutating request literal (`"POST"`, `"PUT"`, `"PATCH"`,
   `"DELETE"`, or `jsonInit("POST"` etc.) must also contain `registerWriteTool`.

Rule 2 is **advisory in Part 1** — it reports violations and exits 0 while 33 connectors are still
unmigrated — and flips to blocking at the end of Part 2. Encode that as an explicit
`blocking: false` constant with a comment naming Part 2, not as a silent `exit(0)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorConsent } from "./check-connector-consent.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "consent-audit-"));
  await mkdir(join(root, "packages/mcp-connectors/evil/src"), { recursive: true });
  await mkdir(join(root, "packages/gateway/src/connectors"), { recursive: true });
  return root;
}

describe("check-connector-consent", () => {
  test("flags setConnectorMode outside its two sanctioned callers", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'import { setConnectorMode } from "../../shared/connector-mode.ts";\nsetConnectorMode("gateway");\n',
    );
    const v = checkConnectorConsent(root);
    expect(v.map((x) => x.rule)).toContain("mode-setter-confined");
  });

  test("does not flag a test file", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/thing.test.ts"),
      'setConnectorMode("gateway");\n',
    );
    expect(checkConnectorConsent(root)).toEqual([]);
  });

  test("flags a connector whose MANIFEST declares write, even with no HTTP verb in source", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/mcp-connectors/evil/nimbus.extension.json"),
      JSON.stringify({ hitlRequired: ["write"] }),
    );
    // Mutates via a CLI, so no verb literal appears anywhere. Ten real connectors look like this.
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'await nimbusSpawn(["kubectl", "delete", "pod", name], {});
',
    );
    const v = checkConnectorConsent(root);
    expect(v.map((x) => x.rule)).toContain("mutation-declared");
  });

  test("flags a mutating handler with no registerWriteTool", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/mcp-connectors/evil/src/server.ts"),
      'const init = { method: "DELETE" };\n',
    );
    const v = checkConnectorConsent(root);
    expect(v.map((x) => x.rule)).toContain("mutation-declared");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/structure-audit/check-connector-consent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type ConsentViolation = {
  readonly rule: "mode-setter-confined" | "mutation-declared";
  readonly file: string;
  readonly reason: string;
};

/** The only production files permitted to name the mode setter. Tests are exempt (see below). */
const MODE_SETTER_ALLOWED = [
  "packages/gateway/src/connectors/run-bundled-connector.ts",
  "packages/mcp-connectors/shared/connector-mode.ts",
];

/**
 * A mutating HTTP method as a quoted literal, in any of the three quote styles. Biome normalises
 * to double quotes, but a template literal is untouched by it, so all three are matched.
 *
 * BOUNDED BY DESIGN: this cannot see a method built from a variable (`method: verb`) or assembled
 * at runtime, and it cannot tell a GraphQL read POST from a GraphQL write POST. That is precisely
 * why write status is DECLARED via `registerWriteTool` rather than detected — this rule is a net
 * for the obvious cases, not the mechanism. Do not extend it into a substitute for the declaration.
 */
const MUTATING_RE = /(["'`])(POST|PUT|PATCH|DELETE)\1/;

/**
 * Rule 2 is ADVISORY in Part 1 and blocking at the end of Part 2.
 *
 * ~33 connectors still register mutations through the plain registrar, so blocking now would red
 * `main` for work that is deliberately scheduled later. This is a named constant rather than a
 * silent `exit(0)` so flipping it is a one-line, reviewable change.
 */
export const MUTATION_RULE_BLOCKING = false;

/**
 * Whether the connector owning `rel` declares `write` or `delete` in `hitlRequired`.
 *
 * This is the RELIABLE mutation signal. Measured across all 94 connectors: 34 carry an HTTP verb
 * literal, but a further 10 declare write/delete while mutating through the CLI, the filesystem or
 * a mail protocol — invisible to any regex over source text. 50 declare nothing and carry no verb.
 */
function connectorDeclaresWrite(root: string, rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[2];
  if (name === undefined) return false;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, "packages/mcp-connectors", name, "nimbus.extension.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null) return false;
    const hitl = (manifest as Record<string, unknown>)["hitlRequired"];
    return Array.isArray(hitl) && hitl.some((h) => h === "write" || h === "delete");
  } catch {
    // An unreadable manifest is an OBSERVATION failure, not a finding. Fail SAFE here by treating
    // it as declaring a write: the cost is a false positive on one connector, versus certifying a
    // mutating connector as needing no declaration.
    return true;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, out);
    } else if (e.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

export function checkConnectorConsent(root: string = resolve(import.meta.dir, "..", "..")): ConsentViolation[] {
  const out: ConsentViolation[] = [];
  for (const base of ["packages/gateway/src", "packages/mcp-connectors"]) {
    const dir = join(root, base);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of walk(dir)) {
      // Forward slashes so the allow-list comparison is identical on Windows.
      const rel = relative(root, file).replaceAll("\\", "/");
      // A test may set the mode freely: it is in-repo code, not a runtime switch, so it costs the
      // "not configurable away" property nothing.
      if (rel.endsWith(".test.ts")) continue;
      const src = readFileSync(file, "utf8");

      if (src.includes("setConnectorMode(") && !MODE_SETTER_ALLOWED.includes(rel)) {
        out.push({
          rule: "mode-setter-confined",
          file: rel,
          reason:
            "names setConnectorMode outside its sanctioned callers — the mode must come from the " +
            "entrypoint, not from arbitrary code",
        });
      }

      // PRIMARY signal: the connector's own manifest. `hitlRequired` naming "write" or "delete" is
      // authored per connector and is transport-independent, so it catches the ten connectors that
      // mutate through a channel no verb scan can see — CLI (aws, gcp, azure, kubernetes, iac),
      // the filesystem (obsidian), and mail protocols (imap, apple, protonmail, discord).
      // Keying only on HTTP verb literals would certify all ten as needing no declaration.
      const manifestDeclaresWrite = connectorDeclaresWrite(root, rel);

      if (
        rel.startsWith("packages/mcp-connectors/") &&
        rel.includes("/src/") &&
        (MUTATING_RE.test(src) || manifestDeclaresWrite) &&
        !src.includes("registerWriteTool")
      ) {
        out.push({
          rule: "mutation-declared",
          file: rel,
          reason:
            "issues a mutating request but registers no write tool — write status must be " +
            "DECLARED, since it cannot be inferred (a GraphQL connector POSTs its reads too)",
        });
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorConsent();
  const blocking = violations.filter(
    (v) => v.rule !== "mutation-declared" || MUTATION_RULE_BLOCKING,
  );
  for (const v of violations) {
    const level = blocking.includes(v) ? "error" : "warning";
    console.error(`::${level} file=${v.file}::${v.reason}`);
  }
  console.log(
    blocking.length === 0
      ? `connector consent: ok (${String(violations.length)} advisory)`
      : `connector consent: ${String(blocking.length)} violation(s)`,
  );
  process.exit(blocking.length > 0 ? 1 : 0);
}
```

Add to root `package.json` scripts:

```json
"audit:connector-consent": "bun scripts/structure-audit/check-connector-consent.ts",
```

Then register it in `scripts/lib/preflight-gates.ts` alongside the other `audit:connector-*` gates —
the manifest drift test fails if a CI gate is missing from it.

- [ ] **Step 4: Run tests and the gate**

Run: `bun test scripts/structure-audit/check-connector-consent.test.ts && bun run audit:connector-consent && bun run preflight:fast`
Expected: PASS; `preflight:fast` green including the gate-manifest drift test.

- [ ] **Step 5: Commit**

```bash
git add scripts/structure-audit/check-connector-consent.ts scripts/structure-audit/check-connector-consent.test.ts package.json scripts/lib/preflight-gates.ts
git commit -m "feat(audit): confine setConnectorMode and flag undeclared connector mutations"
```

---

### Task 12: NOTICE, README and machine-readable tiering

State the security tiering where it survives redistribution and where a client can read it.

**Files:**

- Create: `packages/mcp-connectors/NOTICE`
- Create: `packages/mcp-connectors/standalone/README.md`
- Modify: `packages/mcp-connectors/github/src/server.ts` (add `instructions` to the `McpServer` options)
- Test: `packages/mcp-connectors/standalone/src/notice.test.ts`

Licence stays `AGPL-3.0-only`, unchanged. AGPL §7 forbids adding restrictions, so "use Nimbus for
real HITL" cannot be a licence term; §7(b) permits requiring preservation of specified notices, which
is what `NOTICE` is for. Trademark policy, not copyright, is the lever for "a stripped fork may not
call itself Nimbus-grade".

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string) => resolve(fileURLToPath(import.meta.url), p);

describe("security tiering is stated where it survives", () => {
  const notice = readFileSync(here("../../NOTICE"), "utf8");

  test("NOTICE names what standalone does NOT provide", () => {
    for (const missing of ["sandbox", "Vault", "egress ledger"]) {
      expect(notice).toContain(missing);
    }
  });

  test("NOTICE does not claim gateway-equivalent protection", () => {
    expect(notice).not.toMatch(/equivalent to the gateway/i);
  });

  test("the pilot connector ships machine-readable instructions", () => {
    const src = readFileSync(here("../../github/src/server.ts"), "utf8");
    expect(src).toContain("instructions:");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-connectors/standalone/src/notice.test.ts`
Expected: FAIL — `NOTICE` not found.

- [ ] **Step 3: Write the content**

`packages/mcp-connectors/NOTICE`:

```text
Nimbus first-party MCP connectors
Copyright (C) Nimbus contributors
Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only).

SECURITY TIERING — please preserve this notice.

Run STANDALONE (outside the Nimbus gateway), these connectors provide:
  * consent for every mutating tool, via MCP elicitation, rendered by YOUR MCP client;
  * a server-enforced write scope allow-list and a per-session mutation budget,
    which hold regardless of client behaviour;
  * a local, hash-chained, append-only audit log.

Run standalone, they DO NOT provide:
  * the process sandbox (network allow-list and filesystem confinement) — this is a
    property of how the Nimbus gateway spawns a connector, and no package can supply it;
  * OS-keychain credential storage — standalone credentials come from environment
    variables supplied by whoever configures the MCP client;
  * the egress ledger — the tamper-evident record of every outbound action;
  * owner-controlled consent — standalone consent is mediated by your MCP client,
    which may be configured to answer automatically.

Those four require the Nimbus gateway: https://github.com/nimbus-agent/Nimbus

If a client does not advertise the MCP `elicitation` capability, mutating tools are
NOT REGISTERED AT ALL. That is deliberate, not a defect.

"Nimbus" is a trademark of the Nimbus project. This licence grants no trademark
rights; a modified version that removes these protections must not be described as
Nimbus-grade or imply endorsement by the Nimbus project.
```

In `github/src/server.ts`, pass the same summary to the server so clients can read it:

```ts
const server = new McpServer(
  { name: "nimbus-github", version: "0.1.0" },
  {
    instructions:
      "Nimbus GitHub connector. Standalone: mutating tools require MCP elicitation consent and " +
      "are limited by NIMBUS_MCP_GITHUB_WRITE_SCOPE; they are not registered at all if this " +
      "client does not support elicitation. No sandbox, no OS keychain, and no egress ledger " +
      "outside the Nimbus gateway. See NOTICE.",
  },
);
```

`packages/mcp-connectors/standalone/README.md` carries a copy-paste config:

````markdown
```json
{
  "mcpServers": {
    "nimbus-github": {
      "command": "npx",
      "args": ["-y", "nimbus-mcp", "github"],
      "env": {
        "GITHUB_PAT": "ghp_...",
        "NIMBUS_MCP_GITHUB_WRITE_SCOPE": "repo:acme/api",
        "NIMBUS_MCP_AUDIT_LOG": "/absolute/path/to/nimbus-mcp-audit.jsonl"
      }
    }
  }
}
```
````

plus a section stating that omitting `NIMBUS_MCP_GITHUB_WRITE_SCOPE` refuses every mutation (unset
is not unrestricted), and that on a client without elicitation the server is read-only by design.

- [ ] **Step 4: Run tests and the full preflight**

Run: `bun test packages/mcp-connectors && bun run preflight:fast`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/NOTICE packages/mcp-connectors/standalone/README.md packages/mcp-connectors/standalone/src/notice.test.ts packages/mcp-connectors/github/src/server.ts
git commit -m "docs(connectors): NOTICE and machine-readable standalone security tiering"
```

---

## Final verification

- [ ] `bun run preflight` — full CI parity, green.
- [ ] `bun run verify:docker --changed` — the Linux-only failures that do not reproduce on Windows.
- [ ] `bun run build:gateway && bun run test:connector-boot` — all 94 still boot from the compiled binary. This is the only gate that proves the registry works end to end, and Task 8 changed a connector's registration path.
- [ ] Manual: run `npx nimbus-mcp github` in a real Claude Desktop config with `GITHUB_PAT` set and no `NIMBUS_MCP_GITHUB_WRITE_SCOPE`; confirm read tools work and every write tool is either absent (no elicitation) or refuses as out-of-scope.

## Spec coverage

| Spec section | Task |
|---|---|
| §4 B1 mode, set-once, static audit | 1, 2, 11 |
| §4 in-process test imports | Part 2 (no Part 1 connector affected) |
| §5 B2 `registerWriteTool` declaration | 5, 8 |
| §5 I26 predicate wiring | Part 2 |
| §6 B3 consent gate, default-deny | 5, 6 |
| §6 no escape hatch | 5 (absence of any env override), 12 |
| §7 B4 scope, budget, pre-state | 3, 7 |
| §8 B5 audit, two channels | 4, 7 |
| §9 B6 launcher, Node target, spawn shim | 9, 10 |
| §10 B7 NOTICE, instructions, trademark | 12 |
| §11 testing and gates | every task, plus Final verification |

## Plan review disposition (2026-08-23)

Reviewed in `…-standalone-connector-hardening-review.md`. All five items accepted; two premises were
verified by execution rather than reasoning, and both held.

| Item | Verdict | What changed |
|---|---|---|
| 1 — capabilities are unreadable at registration time | **Accepted; it was fatal** | Proven against the real SDK: `getClientCapabilities()` is `undefined` at module scope, so Task 5 as drafted registered **zero** write tools on every client. Registration is now queued and flushed on `oninitialized` — which is what spec §6 always said, so this was plan-vs-spec drift. Tasks 5–7 fakes now model capabilities as unreadable until a `handshake()`, and Task 5 carries an explicit regression guard asserting nothing is registered before it. |
| Q1 — per-chunk UTF-8 decoding | **Accepted** | `nimbusSpawn` accumulates raw `Buffer`s and decodes once. The existing 2 MB case is pure ASCII and could never catch this, so a 400,000-character multi-byte case was added that asserts no U+FFFD appears. |
| Q2 — cross-test mode contamination | **Accepted; premise verified** | Two test files sharing a module reported the same pid, and state set by the first was visible to the second — `bun test` runs many files in one process. Every mode-touching `describe` now resets in **both** `beforeEach` and `afterEach`, and `resetConnectorModeForTests` documents why. |
| Q3 — silent deny on empty scope | **Accepted** | Standalone startup warns on **stderr** when the scope env is unset. Deliberately not stdout: that is the JSON-RPC channel for a stdio server and writing there would corrupt the protocol stream. |
| Q4 — mutation regex only matched double quotes | **Accepted, with the real limit stated** | Widened to `/(["'`])(POST\|PUT\|PATCH\|DELETE)\1/`. The deeper bound is unchanged and now documented: no regex can see a method held in a variable, or tell a GraphQL read POST from a write POST. That is why write status is declared, not detected, and why this rule is advisory in Part 1. |

The first item is the one worth remembering: the drafted tests would have passed, because the fake
server answered `getClientCapabilities()` synchronously from construction. The test encoded the bug
rather than catching it — which is why the fakes now model the handshake explicitly.

---

## Execution outcome (2026-08-23)

All 12 tasks landed, in 10 commits. Five things the plan did not predict, each caught by execution
rather than review — recorded because the pattern matters more than the individual bugs.

| What | How it surfaced | Where |
|---|---|---|
| The launcher **killed the server it had just started**. `process.exit(await runStandalone(...))` returns 0 while the connector is live, because most connectors connect their transport at module scope. | Only an out-of-process boot reaches `import.meta.main`; the unit tests call `runStandalone` directly and passed throughout. Found by driving the launcher with a real MCP client. | Task 10 |
| **Four structural mismatches** between `ConsentServer` and the real `McpServer` — the restricted JSON-Schema subset for `elicitInput`, two `exactOptionalPropertyTypes` gaps, and `registerTool`'s `inputSchema`. | Typecheck, the first time a real server was passed. A hand-written fake accepts anything. | Task 8 |
| Routing unconditionally through `child_process` **bypassed a global `Bun.spawn` stub** in `cloudwatch/test/tools.test.ts`, which then spawned a real `aws` and hung the connector suite past 600s. | The suite went from 1.75s to a timeout. Fixed by choosing the runtime at CALL time, restoring the dual-branch design the plan actually specified. | Task 9 |
| The port **dropped `gcloudEnv()`** from bigquery's token call, which carries `GOOGLE_APPLICATION_CREDENTIALS`. | Typecheck flagged the now-unused function. Silent auth breakage otherwise. | Task 9 |
| Adding a workspace package **changed `bun.lock`**, and CI installs `--frozen-lockfile`. | `verify:docker`, which installs the same way. No local command catches it. | Task 10 |

Two design changes were made during execution and are worth carrying into Part 2:

- **`stripComments` is not safe for this audit.** It has no regex-literal awareness: a regex
  containing a quote character opens a phantom string and every comment after it survives
  unstripped. Verified directly. The first version of the consent gate consequently flagged the
  launcher's comment *explaining that it deliberately does not call `setConnectorMode`*.
  `check-connector-entrypoints.ts` uses the same helper and may share the weakness — not
  investigated, not changed, worth a look.
- **Eligibility keys on the manifest ALONE — and an earlier version of this note said the
  opposite.** It claimed the HTTP-verb signal covered the manifest's blind spot. It does not: those
  same seven connectors — dagster, google-photos, prefect, ramp, snyk, superset, wiz — are
  READ-ONLY. They POST for GraphQL queries, filter endpoints, OAuth token exchange and login, and
  the verb check wrongly refused all seven from standalone. Their `hitlRequired: []` manifests were
  correct all along.

  This is F5 from the spec — *write status cannot be inferred from the HTTP method* — restated as a
  finding, then violated by the very guard written to enforce it. The verb rule survives in the
  audit as an advisory hint with its false positives documented; it decides nothing. Eligibility is
  58 of 94, not the 51 an earlier version of this table reported.

### Final verification

| Check | Result |
|---|---|
| Whole-repo suite (`bun test packages/gateway packages/cli packages/mcp-connectors scripts`) | 20,147 pass / 0 fail. A first run had one `runPKCEFlow` port-binding timeout that passed in isolation and did not recur — a load flake, though the ~24 new subprocess spawns raise the load |
| `preflight:fast` | 30/30 (was 29; `audit:connector-consent` added) |
| `verify:docker --changed` | exit 0, 108 tests |
| `test:connector-boot` (compiled binary) | 94 connectors — 89 answered, 5 refused without credentials, 0 failed |
| **Gateway regression**, compiled binary, client with NO elicitation | all 5 github write tools present — the standalone gate does not leak into the gateway |
| Standalone through the launcher | 14 tools / 5 writes with elicitation; 9 tools / 0 writes without; ineligible connector exits 3 |
| Standalone eligibility | 51 of 94 (50 no-writes + github); 43 refused until Part 2 |
