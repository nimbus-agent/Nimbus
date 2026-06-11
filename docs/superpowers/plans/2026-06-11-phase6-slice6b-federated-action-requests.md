# Phase 6 Slice 6b — Federated Action Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the cross-team **cloud janitor** (read-only content-free recency probe + cleanup-proposal brief) and the cross-team **blast-radius preflight** (downstream-owner-configured test command run in the per-OS sandbox behind the downstream owner's local HITL gate), gated by new structural invariant **I24** (static complement **D18**).

**Architecture:** Two new built-in read-only agents (`agents/janitor.ts`, `agents/preflight.ts`) over the shipped `federation/peer-fanout.ts` fan-out. Two new inbound federation methods: `federation.probe` (content-free, mirrors `federation.expertise`) and `federation.preflight` (the I24 gate). The preflight gate (`federation/preflight-gate.ts`) is the SOLE path from an inbound request to a sandbox spawn: it validates the request, checks the peer's namespace grant, resolves a LOCAL config command, awaits the local owner's HITL approval via `PreflightConsentBroker`, then runs the configured command via `preflight-runner.ts` (`createSandboxRunner`). No migration (schema stays V38).

**Tech Stack:** Bun v1.2+ / TypeScript 6.x strict (no `any`), Biome, `bun test` (scoped, `timeout 60`), Istanbul branch-coverage floor (Docker `oven/bun:latest`).

**Spec:** `docs/superpowers/specs/2026-06-11-phase6-slice6b-federated-action-requests-design.md` (+ `-review.md` §12 dispositions).

**Conventions for every task:**

- Work in the worktree `.claude/worktrees/phase6-slice6b` on branch `dev/asafgolombek/phase6-slice6b-federated-action-requests`.
- Scoped test runs are wrapped: `timeout 60 bun test <path>` (the Bash tool; `timeout` guards the [[bun-test-unref-timer-hang]] spinner).
- 0 `any`; `unknown` for wire-inbound data. **DI over `mock.module`** (the combined-cli-run contamination trap) — every seam is an injected function/dep.
- The orchestrator (not the subagent) serializes git commits.

---

## Architecture refinement (read before Task 1)

The spec §4.2 named `LongRunningJobRegistry` for the preflight upstream. This plan instead uses the **standard agent shape** (`emitBriefWithSynthesis` → `<kind>.briefReady`) for BOTH agents — it is already fire-and-forget and is what the `runAgentBriefCli` helper waits on, so it needs no extra machinery. The only adjustment: the CLI helper's fixed 30 s timeout is made configurable (Task 13) because a preflight blocks on human downstream approvals. Progress/cancellation (the `LongRunningJobRegistry` extras) are deferred — behavior (a brief returned upstream) is identical.

The **janitor needs no namespace** — a cloud resource ref is global, and the probe is content-free like `federation.expertise` (no per-namespace grant). The janitor fans the probe out to all paired peers. (`--namespace` is therefore NOT a janitor flag.)

`federation.probe` mirrors `federation.expertise`: content-free, no grant gate, scored locally. `federation.preflight` is grant-gated (the peer must hold an active namespace grant) because it triggers local code execution.

---

## File Structure

**New files (gateway):**

- `packages/gateway/src/federation/resource-probe.ts` — `probeResourceRecency` + `isValidResourceRef`.
- `packages/gateway/src/federation/preflight-consent-broker.ts` — `PreflightConsentBroker` + `preflightConsent` singleton.
- `packages/gateway/src/federation/preflight-runner.ts` — `runPreflightCommand` (sandbox wrapper, DI seam).
- `packages/gateway/src/federation/preflight-gate.ts` — `answerFederatedPreflight` (I24 wiring) + request validation.
- `packages/gateway/src/agents/janitor.ts` — `runJanitor` + `emitJanitorBrief`.
- `packages/gateway/src/agents/preflight.ts` — `runPreflight` + `emitPreflightBrief`.
- Test siblings for each.

**New files (cli):**

- `packages/cli/src/commands/janitor.ts`, `packages/cli/src/commands/preflight.ts` (+ test siblings).

**Modified files:**

- `packages/gateway/src/federation/peer-fanout.ts` — add `fanOutProbe`, `fanOutPreflight` + result types.
- `packages/gateway/src/federation/federation-rpc.ts` — add `federation.probe`, `federation.preflight`, `federation.preflightRespond`; extend `FederationRpcContext`.
- `packages/gateway/src/federation/federation-server.ts` — thread new ctx deps.
- `packages/gateway/src/agents/_lib/findings.ts` — `JanitorBrief`/`PreflightBrief` types + guards + union.
- `packages/gateway/src/agents/_lib/emit-brief.ts` — extend `AnyBrief`.
- `packages/gateway/src/agents/_lib/synthesize.ts` — extend `SynthInput`, `deterministicRender`, `toolNameFor`.
- `packages/gateway/src/agents/_lib/render.ts` — `renderJanitor`, `renderPreflight`.
- `packages/gateway/src/ipc/agents-rpc.ts` — `agents.janitor`, `agents.preflight` handlers.
- `packages/gateway/src/ipc/server/dispatchers.ts` — thread preflight deps into the federation ctx.
- `packages/gateway/src/config/nimbus-toml.ts` — `[federation.preflight."<ns>"]` parser.
- `packages/gateway/src/platform/assemble.ts` — `preflightConsent.setBroadcast` wiring.
- `packages/cli/src/types/agents.ts` — CLI-mirror brief types + guards.
- `packages/cli/src/commands/_agent-brief-cli.ts` — optional `timeoutMs`.
- `packages/cli/src/index.ts` — `COMMAND_HANDLERS` entries.
- `packages/cli/src/commands/registry.ts` — `COMMAND_NAMES` entries.
- `packages/ui/src-tauri/src/gateway_bridge.rs` — allowlist + count (86 → 88).
- `packages/gateway/src/security-invariants.test.ts` — I24 assertions + count mirror.
- `scripts/structure-audit/check-nimbus-invariants.ts` — D18.
- `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/CHANGELOG.md`.

---

## Task 1: `[federation.preflight."<ns>"]` config schema + parse

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml.preflight.test.ts` (new)

Mirrors the `[hitl.quorum."<action-type>"]` dynamic-key pattern already in this file (`collectQuorumKvSections` / `beginQuorumTable` / `toQuorumRule`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/config/nimbus-toml.preflight.test.ts
import { expect, test } from "bun:test";
import { parsePreflightConfig } from "./nimbus-toml.ts";

test("parses a per-namespace preflight command table", () => {
  const cfg = parsePreflightConfig(`
[federation.preflight."project:zurich"]
command = "bun"
args = ["test", "packages/api"]
cwd = "/srv/zurich"
timeout_seconds = 120
`);
  const z = cfg.get("project:zurich");
  expect(z).toEqual({ command: "bun", args: ["test", "packages/api"], cwd: "/srv/zurich", timeoutSeconds: 120 });
});

test("defaults args=[] cwd='.' timeout=300, caps timeout at 1800, ignores command-less tables", () => {
  const cfg = parsePreflightConfig(`
[federation.preflight."a"]
command = "make check"
timeout_seconds = 99999

[federation.preflight."b"]
args = ["x"]
`);
  expect(cfg.get("a")).toEqual({ command: "make check", args: [], cwd: ".", timeoutSeconds: 1800 });
  expect(cfg.has("b")).toBe(false); // no command → ignored
});

test("absent section → empty map", () => {
  expect(parsePreflightConfig("[federation]\nenabled = true\n").size).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test packages/gateway/src/config/nimbus-toml.preflight.test.ts`
Expected: FAIL — `parsePreflightConfig` is not exported.

- [ ] **Step 3: Add the parser to `nimbus-toml.ts`**

Append near the `parseQuorumConfig` block (reuse the file's existing `stripComment`, `isTableHeader`, `splitKeyValue`, `parseIntDec`, `parseString` helpers; mirror `collectQuorumKvSections`). Note `args` is a TOML array — parse it with a small inline array splitter.

```typescript
// ---------------------------------------------------------------------------
// [federation.preflight."<namespace>"] — per-namespace downstream preflight command (I24)
// ---------------------------------------------------------------------------

export interface PreflightCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
}

export type PreflightConfig = ReadonlyMap<string, PreflightCommandConfig>;

const PREFLIGHT_TABLE_PREFIX = '[federation.preflight."';
const PREFLIGHT_TIMEOUT_DEFAULT = 300;
const PREFLIGHT_TIMEOUT_CAP = 1800;

/** Parse a TOML inline string array (`["a", "b"]`) into string[]; tolerant of whitespace. */
function parseStringArray(valRaw: string): string[] {
  const inner = valRaw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return inner
    .split(",")
    .map((s) => parseString(s.trim()))
    .filter((s) => s.length > 0);
}

export function parsePreflightConfig(source: string): PreflightConfig {
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      currentId =
        trimmed.startsWith(PREFLIGHT_TABLE_PREFIX) && trimmed.endsWith('"]')
          ? trimmed.slice(PREFLIGHT_TABLE_PREFIX.length, -2)
          : undefined;
      if (currentId !== undefined && currentId.length > 0 && !accum.has(currentId)) {
        accum.set(currentId, {});
      } else if (currentId !== undefined && currentId.length === 0) {
        currentId = undefined;
      }
      continue;
    }
    if (currentId === undefined) continue;
    const kv = splitKeyValue(trimmed);
    const bucket = accum.get(currentId);
    if (kv !== undefined && bucket !== undefined) bucket[kv.key] = kv.valRaw;
  }

  const out = new Map<string, PreflightCommandConfig>();
  for (const [ns, kv] of accum.entries()) {
    const commandRaw = kv["command"];
    if (commandRaw === undefined) continue; // command-less table → ignored
    const command = parseString(commandRaw);
    if (command.length === 0) continue;
    const timeoutParsed = kv["timeout_seconds"] === undefined ? undefined : parseIntDec(kv["timeout_seconds"]);
    const timeoutSeconds =
      timeoutParsed === undefined || timeoutParsed <= 0
        ? PREFLIGHT_TIMEOUT_DEFAULT
        : Math.min(timeoutParsed, PREFLIGHT_TIMEOUT_CAP);
    out.set(ns, {
      command,
      args: kv["args"] === undefined ? [] : parseStringArray(kv["args"]),
      cwd: kv["cwd"] === undefined ? "." : parseString(kv["cwd"]),
      timeoutSeconds,
    });
  }
  return out;
}

export function loadNimbusPreflightFromConfigDir(configDir: string): PreflightConfig {
  return loadTomlSection<PreflightConfig>(join(configDir, "nimbus.toml"), new Map(), parsePreflightConfig);
}
```

> If `loadTomlSection`'s generic default arg shape differs, mirror `loadNimbusQuorumFromPath` exactly (it passes `new Map()` as the default). Verify `stripComment`, `isTableHeader`, `splitKeyValue`, `parseIntDec`, `parseString` names against the current file before saving.

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 60 bun test packages/gateway/src/config/nimbus-toml.preflight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/gateway && bunx tsc --noEmit
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.preflight.test.ts
git commit -m "feat(phase6-slice6b): [federation.preflight.<ns>] config schema + parse"
```

---

## Task 2: `resource-probe.ts` + ref validation

**Files:**

- Create: `packages/gateway/src/federation/resource-probe.ts`
- Test: `packages/gateway/src/federation/resource-probe.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/federation/resource-probe.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isValidResourceRef, probeResourceRecency } from "./resource-probe.ts";

function seed(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

test("isValidResourceRef rejects short/empty/wildcard, accepts real refs", () => {
  expect(isValidResourceRef("i-1234567")).toBe(true);
  expect(isValidResourceRef("arn:aws:ec2:us-east-1:1:instance/i-1")).toBe(true);
  expect(isValidResourceRef("123")).toBe(false); // < 4
  expect(isValidResourceRef("a b")).toBe(false); // space
  expect(isValidResourceRef("a%b")).toBe(false); // wildcard
});

test("untouched resource → { touched:false }", () => {
  const db = seed();
  expect(probeResourceRecency(db, { resourceRef: "i-deadbeef" }, () => 1_000_000)).toEqual({ touched: false });
});

test("touched resource → recency from MAX(modified_at), content-free", () => {
  const db = seed();
  const dayMs = 86_400_000;
  db.run(
    `INSERT INTO item (id, service, type, title, body_preview, modified_at, indexed_at)
     VALUES ('x', 'aws', 'note', 'restart i-deadbeef', 'ssh into i-deadbeef', ?, ?)`,
    [10 * dayMs, 10 * dayMs],
  );
  const now = 13 * dayMs; // 3 days later
  const r = probeResourceRecency(db, { resourceRef: "i-deadbeef" }, () => now);
  expect(r.touched).toBe(true);
  expect(r.lastSeenDaysAgo).toBe(3);
  expect(JSON.stringify(r)).not.toContain("ssh"); // no body leaks
});

test("invalid ref never reports touched (fail-safe)", () => {
  const db = seed();
  expect(probeResourceRecency(db, { resourceRef: "ab" }, () => 1).touched).toBe(false);
});
```

> Verify the `item` insert columns against `unified-item-v3-sql.ts` (`id, service, type, title, body_preview, modified_at, indexed_at`); adjust if a NOT NULL column is missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test packages/gateway/src/federation/resource-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resource-probe.ts`**

```typescript
// packages/gateway/src/federation/resource-probe.ts
import type { Database } from "bun:sqlite";

export interface ResourceProbeRequest {
  readonly resourceRef: string;
}
export interface ResourceProbeResponse {
  readonly touched: boolean;
  readonly lastSeenDaysAgo?: number;
}

export const MIN_RESOURCE_REF_LEN = 4;
const RESOURCE_REF_RE = /^[A-Za-z0-9_:.\-/]+$/;
const DAY_MS = 86_400_000;

/** Reject short/noisy/wildcard refs so the probe cannot produce false idle/touched hits (Q1, S1). */
export function isValidResourceRef(ref: string): boolean {
  return ref.length >= MIN_RESOURCE_REF_LEN && RESOURCE_REF_RE.test(ref);
}

/** Escape SQL LIKE metacharacters so the ref matches literally (no wildcard probing). */
function escapeLikeWildcards(s: string): string {
  return s.replaceAll("\\", String.raw`\\`).replaceAll("%", String.raw`\%`).replaceAll("_", String.raw`\_`);
}

/**
 * Content-free recency probe (I17-class, mirrors scoreExpertise): does any indexed item mention
 * `resourceRef`, and how recently? Returns ONLY a boolean + whole-days recency — never item bodies.
 */
export function probeResourceRecency(
  db: Database,
  req: ResourceProbeRequest,
  now: () => number = Date.now,
): ResourceProbeResponse {
  if (!isValidResourceRef(req.resourceRef)) return { touched: false };
  const like = `%${escapeLikeWildcards(req.resourceRef)}%`;
  const row = db
    .query<{ last: number | null }, [string, string]>(
      `SELECT MAX(modified_at) AS last FROM item
       WHERE title LIKE ? ESCAPE '\\' OR body_preview LIKE ? ESCAPE '\\'`,
    )
    .get(like, like);
  if (row?.last == null) return { touched: false };
  const daysAgo = Math.max(0, Math.floor((now() - row.last) / DAY_MS));
  return { touched: true, lastSeenDaysAgo: daysAgo };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 60 bun test packages/gateway/src/federation/resource-probe.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/resource-probe.ts packages/gateway/src/federation/resource-probe.test.ts
git commit -m "feat(phase6-slice6b): content-free resource-recency probe + ref validation"
```

---

## Task 3: `fanOutProbe` in `peer-fanout.ts`

**Files:**

- Modify: `packages/gateway/src/federation/peer-fanout.ts`
- Test: `packages/gateway/src/federation/peer-fanout.probe.test.ts` (new — keep separate from the existing `peer-fanout.test.ts` to avoid merge churn)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/federation/peer-fanout.probe.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { LocalIndex } from "../index/local-index.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { fanOutProbe, type PeerFanoutDeps } from "./peer-fanout.ts";

function deps(send: PeerFanoutDeps["sendOverWire"]): PeerFanoutDeps {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const index = new LocalIndex(db);
  index.addLanPeer({ peerId: "peer:a", peerPubkey: new Uint8Array(32), direction: "outbound", hostIp: "10.0.0.2" });
  // give the peer a reachable port:
  db.run(`UPDATE lan_peers SET host_port = 7070 WHERE peer_id = 'peer:a'`);
  return {
    index,
    selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    store: new KnownNamespaceStore(db),
    sendOverWire: send,
  };
}

test("fanOutProbe maps a peer's answer into a PeerProbeResult", async () => {
  const out = await fanOutProbe(deps(async () => ({ touched: true, lastSeenDaysAgo: 2 })), {
    resourceRef: "i-12345",
    purpose: "janitor",
  });
  expect(out.perPeer).toEqual([{ peerId: "peer:a", displayName: null, touched: true, lastSeenDaysAgo: 2 }]);
  expect(out.gaps).toEqual([]);
});

test("a transport error becomes a gap (never counted as idle)", async () => {
  const out = await fanOutProbe(
    deps(async () => {
      throw new Error("timeout");
    }),
    { resourceRef: "i-12345", purpose: "janitor" },
  );
  expect(out.perPeer).toEqual([]);
  expect(out.gaps.length).toBe(1);
  expect(out.gaps[0]?.detail).toContain("timeout");
});
```

> Verify `addLanPeer`/`lan_peers` column names against `local-index.ts`; the existing `peer-fanout.test.ts` already constructs peers — copy its exact setup if these differ.

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test packages/gateway/src/federation/peer-fanout.probe.test.ts`
Expected: FAIL — `fanOutProbe` not exported.

- [ ] **Step 3: Add `fanOutProbe` + `PeerProbeResult` to `peer-fanout.ts`**

Add the type next to `PeerExpertiseResult`:

```typescript
export interface PeerProbeResult {
  readonly peerId: string;
  readonly displayName: string | null;
  readonly touched: boolean;
  readonly lastSeenDaysAgo: number | null;
}
```

Add the function (mirror `fanOutExpertise`, but a non-answer is a GAP, not a default value — the janitor must never read silence as "idle"):

```typescript
export async function fanOutProbe(
  deps: PeerFanoutDeps,
  req: { resourceRef: string; purpose: string },
): Promise<PeerFanoutOutcome<PeerProbeResult>> {
  const send = deps.sendOverWire ?? sendFederatedOverWire;
  const { perPeer, gaps } = await runPool<PeerProbeResult>(reachablePeers(deps.index), async (row) => {
    try {
      const result = (await send(
        row.host_ip as string,
        row.host_port as number,
        deps.selfIdentity,
        row.peer_pubkey,
        "federation.probe",
        { resourceRef: req.resourceRef, purpose: req.purpose },
      )) as { touched?: boolean; lastSeenDaysAgo?: number };
      return {
        ok: {
          peerId: row.peer_id,
          displayName: row.display_name,
          touched: result.touched === true,
          lastSeenDaysAgo: typeof result.lastSeenDaysAgo === "number" ? result.lastSeenDaysAgo : null,
        },
      };
    } catch (err) {
      return { gap: gapForPeer(row, err) };
    }
  });
  perPeer.sort((a, b) => a.peerId.localeCompare(b.peerId));
  return { perPeer, gaps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 60 bun test packages/gateway/src/federation/peer-fanout.probe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/peer-fanout.ts packages/gateway/src/federation/peer-fanout.probe.test.ts
git commit -m "feat(phase6-slice6b): fanOutProbe (resource-recency fan-out)"
```

---

## Task 4: `federation.probe` inbound RPC

**Files:**

- Modify: `packages/gateway/src/ipc/federation-rpc.ts`
- Test: `packages/gateway/src/ipc/federation-rpc.probe.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/ipc/federation-rpc.probe.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";

function ctx(db: Database): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as unknown as FederationRpcContext["discovery"],
    pairing: { listPeers: () => [] } as unknown as FederationRpcContext["pairing"],
  };
}

test("federation.probe returns the content-free recency answer", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const out = await dispatchFederationRpc("federation.probe", { resourceRef: "i-12345", purpose: "j", peerId: "peer:a" }, ctx(db));
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") expect(out.value).toEqual({ touched: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test packages/gateway/src/ipc/federation-rpc.probe.test.ts`
Expected: FAIL — method not in the dispatch table (`kind:"miss"`).

- [ ] **Step 3: Add the handler**

Add the import at the top of `federation-rpc.ts`:

```typescript
import { probeResourceRecency } from "../federation/resource-probe.ts";
```

Add to the `dispatchByMethod` table in `dispatchFederationRpc` (next to `"federation.expertise"`):

```typescript
    "federation.probe": (p) => {
      const rec = asRecord(p);
      return probeResourceRecency(ctx.db, { resourceRef: requireString(rec, "resourceRef") });
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 60 bun test packages/gateway/src/ipc/federation-rpc.probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/federation-rpc.probe.test.ts
git commit -m "feat(phase6-slice6b): federation.probe inbound RPC"
```

---

## Task 5: `agents/janitor.ts` + brief unions + render

**Files:**

- Create: `packages/gateway/src/agents/janitor.ts`
- Modify: `packages/gateway/src/agents/_lib/findings.ts`, `emit-brief.ts`, `synthesize.ts`, `render.ts`
- Test: `packages/gateway/src/agents/janitor.test.ts`

- [ ] **Step 1: Extend the brief types in `findings.ts`**

Add the types + guard (after `HuddleBrief`):

```typescript
export type JanitorBrief = AgentBriefBase & {
  kind: "janitor";
  query: { resourceRef: string; idleDays: number };
  idle: boolean;
  proposalSuppressed: boolean; // true when coverage was incomplete and --allow-gaps was not set
  cleanupAction: string | null; // from --cleanup; null when not supplied
  peersClear: number;
  peersTouched: { peerId: string; who: string | null; lastSeenDaysAgo: number | null }[];
};

export function isJanitorBrief(x: unknown): x is JanitorBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "janitor" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    typeof b["idle"] === "boolean" &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}
```

Add `JanitorBrief` to the `AgentBrief` union (line ~160).

- [ ] **Step 2: Extend `emit-brief.ts` `AnyBrief`** — add `| JanitorBrief` to the union (line 11) and to the import list (lines 1-8).

- [ ] **Step 3: Extend `synthesize.ts`** — add `JanitorBrief` to the `SynthInput` union + the import; add to `deterministicRender`: `if (brief.kind === "janitor") return renderJanitor(brief);`; add to `toolNameFor`: `if (brief.kind === "janitor") return "agents.janitor";`; import `renderJanitor` from `./render.ts`.

- [ ] **Step 4: Add `renderJanitor` to `render.ts`** (import `JanitorBrief`):

```typescript
export function renderJanitor(brief: JanitorBrief): string {
  const header = `# Janitor: ${brief.query.resourceRef}`;
  let verdict: string;
  if (brief.proposalSuppressed) {
    verdict = `_coverage incomplete — proposal withheld (pass --allow-gaps to override)_`;
  } else if (brief.idle) {
    verdict =
      brief.cleanupAction === null
        ? `Idle ≥ ${brief.query.idleDays}d across ${brief.peersClear} peer(s). Consider cleanup.`
        : `Idle ≥ ${brief.query.idleDays}d across ${brief.peersClear} peer(s). Cleanup: \`nimbus run ${brief.cleanupAction} ${brief.query.resourceRef}\``;
  } else {
    const lines = brief.peersTouched.map(
      (p) => `   - ${p.who ?? p.peerId}: last seen ${p.lastSeenDaysAgo ?? "?"}d ago`,
    );
    verdict = [`Still in use:`, ...lines].join("\n");
  }
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", verdict, gaps, footer].filter((s) => s !== "").join("\n");
}
```

- [ ] **Step 5: Write the failing janitor test**

```typescript
// packages/gateway/src/agents/janitor.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { LocalIndex } from "../index/local-index.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { runJanitor, type JanitorContext } from "./janitor.ts";

function baseCtx(db: Database, send: JanitorContext["sendOverWire"]): JanitorContext {
  const index = new LocalIndex(db);
  index.addLanPeer({ peerId: "peer:a", peerPubkey: new Uint8Array(32), direction: "outbound", hostIp: "10.0.0.2" });
  db.run(`UPDATE lan_peers SET host_port = 7070 WHERE peer_id = 'peer:a'`);
  return {
    db,
    index,
    selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
    store: new KnownNamespaceStore(db),
    sendOverWire: send,
    notify: () => {},
    sessionId: "s1",
  };
}

test("all peers clear (≥ idleDays) → idle proposal with named cleanup", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const brief = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: "cloud.instance.terminate", allowGaps: false },
    baseCtx(db, async () => ({ touched: false })),
  );
  expect(brief.idle).toBe(true);
  expect(brief.proposalSuppressed).toBe(false);
  expect(brief.cleanupAction).toBe("cloud.instance.terminate");
});

test("a peer touched within idleDays → not idle", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const brief = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: false },
    baseCtx(db, async () => ({ touched: true, lastSeenDaysAgo: 2 })),
  );
  expect(brief.idle).toBe(false);
  expect(brief.peersTouched.length).toBe(1);
});

test("a gap suppresses the proposal unless allowGaps", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const failing = async () => {
    throw new Error("offline");
  };
  const strict = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: false },
    baseCtx(db, failing),
  );
  expect(strict.proposalSuppressed).toBe(true);
  const lenient = await runJanitor(
    { resourceRef: "i-12345", idleDays: 7, cleanupAction: null, allowGaps: true },
    baseCtx(db, failing),
  );
  expect(lenient.proposalSuppressed).toBe(false);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `timeout 60 bun test packages/gateway/src/agents/janitor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `agents/janitor.ts`**

```typescript
// packages/gateway/src/agents/janitor.ts
import type { Database } from "bun:sqlite";
import { fanOutProbe } from "../federation/peer-fanout.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { buildFanoutDeps } from "./_lib/fanout-deps.ts";
import type { GapNote, JanitorBrief } from "./_lib/findings.ts";
import { isValidResourceRef } from "../federation/resource-probe.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type JanitorInput = {
  resourceRef: string;
  idleDays: number;
  cleanupAction: string | null;
  allowGaps: boolean;
};

export type JanitorContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

export async function runJanitor(input: JanitorInput, ctx: JanitorContext): Promise<JanitorBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  if (!isValidResourceRef(input.resourceRef)) {
    gaps.push({ category: "missing_connector", detail: "resourceRef too short or malformed (min 4 chars)" });
  }
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" });
  }

  const probe =
    isValidResourceRef(input.resourceRef)
      ? await fanOutProbe(buildFanoutDeps(ctx), { resourceRef: input.resourceRef, purpose: "janitor" })
      : { perPeer: [], gaps: [] as GapNote[] };
  gaps.push(...probe.gaps);

  const touched = probe.perPeer.filter(
    (p) => p.touched && (p.lastSeenDaysAgo === null || p.lastSeenDaysAgo < input.idleDays),
  );
  const peersClear = probe.perPeer.length - touched.length;
  const coverageComplete = gaps.length === 0;
  const idle = touched.length === 0 && probe.perPeer.length > 0;
  const proposalSuppressed = idle && !coverageComplete && !input.allowGaps;

  return {
    kind: "janitor",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { resourceRef: input.resourceRef, idleDays: input.idleDays },
    idle: idle && (!proposalSuppressed || input.allowGaps),
    proposalSuppressed,
    cleanupAction: input.cleanupAction,
    peersClear,
    peersTouched: touched.map((p) => ({ peerId: p.peerId, who: p.displayName, lastSeenDaysAgo: p.lastSeenDaysAgo })),
  };
}

export function emitJanitorBrief(input: JanitorInput, ctx: JanitorContext): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "janitor.briefReady",
    briefErrorMethod: "janitor.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runJanitor(input, ctx),
  });
}
```

- [ ] **Step 8: Run tests + typecheck**

Run: `timeout 60 bun test packages/gateway/src/agents/janitor.test.ts && cd packages/gateway && bunx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/agents/janitor.ts packages/gateway/src/agents/janitor.test.ts packages/gateway/src/agents/_lib/
git commit -m "feat(phase6-slice6b): janitor agent (read-only cleanup-proposal brief)"
```

---

## Task 6: `agents.janitor` IPC + `nimbus janitor` CLI

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts`
- Create: `packages/cli/src/commands/janitor.ts` (+ test)
- Modify: `packages/cli/src/types/agents.ts`, `packages/cli/src/index.ts`, `packages/cli/src/commands/registry.ts`
- Test: `packages/gateway/src/ipc/agents-rpc.janitor.test.ts`, `packages/cli/src/commands/janitor.test.ts`

- [ ] **Step 1: Add the gateway handler test**

```typescript
// packages/gateway/src/ipc/agents-rpc.janitor.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

test("agents.janitor returns a sessionId and emits janitor.briefReady", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const seen: string[] = [];
  const out = await dispatchAgentsRpc(
    "agents.janitor",
    { resourceRef: "i-12345", idleDays: 7 },
    { db, notify: (m) => seen.push(m) },
  );
  expect(out.kind).toBe("hit");
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toContain("janitor.briefReady");
});

test("agents.janitor rejects a missing resourceRef", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  await expect(dispatchAgentsRpc("agents.janitor", {}, { db, notify: () => {} })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test packages/gateway/src/ipc/agents-rpc.janitor.test.ts`
Expected: FAIL — `agents.janitor` not in the table.

- [ ] **Step 3: Add the handler to `agents-rpc.ts`**

Import `emitJanitorBrief`. Add a param parser + handler (mirror `requireFileParam`/`handleGhost`; `federatedAgentBase` already supplies db/index/selfIdentity/store/notify/sessionId):

```typescript
function requireJanitorParams(params: unknown): { resourceRef: string; idleDays: number; cleanupAction: string | null; allowGaps: boolean } {
  if (params === null || typeof params !== "object") throw new Error("agents.janitor: object params required");
  const p = params as Record<string, unknown>;
  if (typeof p["resourceRef"] !== "string" || p["resourceRef"].length === 0) {
    throw new Error("agents.janitor: resourceRef (non-empty string) required");
  }
  return {
    resourceRef: p["resourceRef"],
    idleDays: typeof p["idleDays"] === "number" && p["idleDays"] > 0 ? p["idleDays"] : 14,
    cleanupAction: typeof p["cleanupAction"] === "string" && p["cleanupAction"].length > 0 ? p["cleanupAction"] : null,
    allowGaps: p["allowGaps"] === true,
  };
}

async function handleJanitor(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireJanitorParams(params);
  return await emitJanitorBrief(input, federatedAgentBase(ctx, newSessionId("janitor")));
}
```

Add `"agents.janitor": handleJanitor,` to the `dispatchByMethod` table.

- [ ] **Step 4: Run gateway test**

Run: `timeout 60 bun test packages/gateway/src/ipc/agents-rpc.janitor.test.ts`
Expected: PASS.

- [ ] **Step 5: Add CLI types** — in `packages/cli/src/types/agents.ts`, add the CLI-mirror `JanitorBrief` type + `isJanitorBrief` guard (copy the gateway shape from Task 5 Step 1; the guard checks `kind === "janitor"`, `agentVersion === 1`, `Array.isArray(gaps)`, `typeof idle === "boolean"`, the two numbers, and `query` object).

- [ ] **Step 6: Write the CLI parse test**

```typescript
// packages/cli/src/commands/janitor.test.ts
import { expect, test } from "bun:test";
import { parseJanitorArgs } from "./janitor.ts";

test("parses ref + flags", () => {
  expect(parseJanitorArgs(["i-12345", "--idle-days", "30", "--cleanup", "cloud.instance.terminate", "--allow-gaps", "--json"])).toEqual({
    resourceRef: "i-12345",
    idleDays: 30,
    cleanupAction: "cloud.instance.terminate",
    allowGaps: true,
    json: true,
  });
});

test("defaults idle-days 14, no cleanup, strict", () => {
  expect(parseJanitorArgs(["i-12345"])).toEqual({ resourceRef: "i-12345", idleDays: 14, cleanupAction: null, allowGaps: false, json: false });
});

test("rejects a flag-shaped value and a missing ref", () => {
  expect(() => parseJanitorArgs(["i-12345", "--cleanup", "--json"])).toThrow();
  expect(() => parseJanitorArgs(["--json"])).toThrow();
});
```

- [ ] **Step 7: Run test to verify it fails, then implement `janitor.ts`**

```typescript
// packages/cli/src/commands/janitor.ts
import { type JanitorBrief, isJanitorBrief } from "../types/agents.ts";
import { runAgentBriefCli } from "./_agent-brief-cli.ts";

export type JanitorCliArgs = {
  resourceRef: string;
  idleDays: number;
  cleanupAction: string | null;
  allowGaps: boolean;
  json: boolean;
};

function flagValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (typeof v !== "string" || v.trim().length === 0 || v.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return v.trim();
}

export function parseJanitorArgs(args: string[]): JanitorCliArgs {
  const positional: string[] = [];
  let idleDays = 14;
  let cleanupAction: string | null = null;
  let allowGaps = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--allow-gaps") allowGaps = true;
    else if (a === "--idle-days") {
      const n = Number(flagValue(args, i, "--idle-days"));
      if (!Number.isInteger(n) || n <= 0) throw new Error("--idle-days must be a positive integer");
      idleDays = n;
      i += 1;
    } else if (a === "--cleanup") {
      cleanupAction = flagValue(args, i, "--cleanup");
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) positional.push(a);
  }
  const resourceRef = positional.join(" ").trim();
  if (resourceRef.length === 0) throw new Error("Usage: nimbus janitor <resource-ref> [--idle-days N] [--cleanup <action.type>] [--allow-gaps] [--json]");
  return { resourceRef, idleDays, cleanupAction, allowGaps, json };
}

export async function runJanitorCli(args: string[]): Promise<void> {
  const parsed = parseJanitorArgs(args);
  await runAgentBriefCli<JanitorBrief>({
    kind: "janitor",
    guard: isJanitorBrief,
    json: parsed.json,
    params: {
      resourceRef: parsed.resourceRef,
      idleDays: parsed.idleDays,
      allowGaps: parsed.allowGaps,
      ...(parsed.cleanupAction === null ? {} : { cleanupAction: parsed.cleanupAction }),
    },
  });
}
```

Run: `timeout 60 bun test packages/cli/src/commands/janitor.test.ts`
Expected: PASS.

- [ ] **Step 8: Register the command** — `packages/cli/src/index.ts`: import `runJanitorCli` and add `janitor: runJanitorCli,` to `COMMAND_HANDLERS`. `packages/cli/src/commands/registry.ts`: add `"janitor",` to `COMMAND_NAMES` (alphabetical, between `"index"` and `"lan"`).

- [ ] **Step 9: Typecheck both packages + commit**

```bash
cd packages/gateway && bunx tsc --noEmit && cd ../cli && bunx tsc --noEmit && cd ../..
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.janitor.test.ts packages/cli/src/commands/janitor.ts packages/cli/src/commands/janitor.test.ts packages/cli/src/types/agents.ts packages/cli/src/index.ts packages/cli/src/commands/registry.ts
git commit -m "feat(phase6-slice6b): agents.janitor IPC + nimbus janitor CLI"
```

---

## Task 7: `PreflightConsentBroker`

**Files:**

- Create: `packages/gateway/src/federation/preflight-consent-broker.ts`
- Test: `packages/gateway/src/federation/preflight-consent-broker.test.ts`

Mirrors `FederationConsentBroker` exactly (broadcast + resolve + TTL), but broadcasts `federation.preflightRequest` and resolves a boolean.

- [ ] **Step 1: Write the failing test** (copy `consent-broker.test.ts`, adapt to boolean resolution):

```typescript
// packages/gateway/src/federation/preflight-consent-broker.test.ts
import { expect, test } from "bun:test";
import { PreflightConsentBroker } from "./preflight-consent-broker.ts";

test("request broadcasts federation.preflightRequest and resolves true on approve", async () => {
  const b = new PreflightConsentBroker();
  const sent: Array<{ method: string; params: unknown }> = [];
  b.setBroadcast((m, p) => sent.push({ method: m, params: p }));
  const p = b.request({ peerId: "peer:a", namespace: "n", ref: "HEAD", purpose: "x" }, 1000);
  expect(sent[0]?.method).toBe("federation.preflightRequest");
  const rid = (sent[0]?.params as { requestId: string }).requestId;
  expect(b.respond(rid, true)).toBe(true);
  expect(await p).toBe(true);
});

test("respond(false) resolves false; unknown id is a no-op", async () => {
  const b = new PreflightConsentBroker();
  b.setBroadcast(() => {});
  const p = b.request({ peerId: "p", namespace: "n", ref: "HEAD", purpose: "x" }, 1000);
  const rid = b.pendingIds()[0] as string;
  expect(b.respond("nope", true)).toBe(false);
  expect(b.respond(rid, false)).toBe(true);
  expect(await p).toBe(false);
});

test("TTL safety-net resolves false and purges", async () => {
  const b = new PreflightConsentBroker();
  b.setBroadcast(() => {});
  const p = b.request({ peerId: "p", namespace: "n", ref: "HEAD", purpose: "x" }, 20);
  expect(await p).toBe(false);
  expect(b.pendingIds().length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-consent-broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `preflight-consent-broker.ts`**

```typescript
// packages/gateway/src/federation/preflight-consent-broker.ts
import { randomUUID } from "node:crypto";

export interface PreflightApprovalInput {
  readonly peerId: string;
  readonly namespace: string;
  readonly ref: string;
  readonly purpose: string;
}

type Broadcast = (method: string, params: unknown) => void;

interface Pending {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owner-approval round-trip for an inbound preflight request (I24). The request is broadcast to all
 * connected local clients; the owner answers via `federation.preflightRespond` → `respond`. A TTL
 * safety-net resolves `false` (deny) if the owner never answers — fail-closed.
 */
export class PreflightConsentBroker {
  private readonly pending = new Map<string, Pending>();
  private broadcast: Broadcast = () => {};

  setBroadcast(fn: Broadcast): void {
    this.broadcast = fn;
  }

  request(input: PreflightApprovalInput, ttlMs: number): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, ttlMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      this.broadcast("federation.preflightRequest", { requestId, ...input });
    });
  }

  respond(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    return true;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

/** Process singleton shared by the local dispatcher and the LAN onMessage path. */
export const preflightConsent = new PreflightConsentBroker();
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-consent-broker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/federation/preflight-consent-broker.ts packages/gateway/src/federation/preflight-consent-broker.test.ts
git commit -m "feat(phase6-slice6b): PreflightConsentBroker (owner-approval round-trip)"
```

---

## Task 8: `preflight-runner.ts` (sandboxed command runner)

**Files:**

- Create: `packages/gateway/src/federation/preflight-runner.ts`
- Test: `packages/gateway/src/federation/preflight-runner.test.ts`

The runner wraps `createSandboxRunner()`. The sandbox `SandboxRunner.spawn(cmd, args, { manifest, env, cwd, stdio })` returns a `ChildProcess`. The DI seam `createRunner` lets tests inject a fake runner that returns a stub child.

- [ ] **Step 1: Write the failing test** (inject a fake runner + fake child via a tiny EventEmitter):

```typescript
// packages/gateway/src/federation/preflight-runner.test.ts
import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { runPreflightCommand } from "./preflight-runner.ts";

function fakeChild(exitCode: number, delayMs = 0): EventEmitter & { kill: () => void } {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void };
  let killed = false;
  ee.kill = () => {
    killed = true;
  };
  if (delayMs === 0) queueMicrotask(() => ee.emit("exit", exitCode));
  else setTimeout(() => { if (!killed) ee.emit("exit", exitCode); }, delayMs).unref?.();
  return ee;
}

const cfg = { command: "bun", args: ["test"], cwd: "/srv/x", timeoutSeconds: 1 };

test("exit 0 → passed, env carries ref + surface", async () => {
  let seenEnv: Record<string, string> = {};
  const r = await runPreflightCommand(cfg, { ref: "HEAD", changedSurface: ["a.ts", "b.ts"] }, {
    createRunner: async () => ({
      platform: "linux",
      isFullyActive: () => true,
      degradedReason: () => null,
      spawn: (_cmd, _args, opts) => {
        seenEnv = opts.env;
        return fakeChild(0) as never;
      },
    }),
    now: () => 0,
  });
  expect(r.passed).toBe(true);
  expect(seenEnv["NIMBUS_PREFLIGHT_REF"]).toBe("HEAD");
  expect(seenEnv["NIMBUS_PREFLIGHT_SURFACE"]).toBe("a.ts,b.ts");
});

test("non-zero exit → not passed", async () => {
  const r = await runPreflightCommand(cfg, { ref: "HEAD", changedSurface: [] }, {
    createRunner: async () => ({ platform: "linux", isFullyActive: () => true, degradedReason: () => null, spawn: () => fakeChild(1) as never }),
    now: () => 0,
  });
  expect(r.passed).toBe(false);
});

test("timeout kills the process and reports timed out", async () => {
  let killed = false;
  const r = await runPreflightCommand({ ...cfg, timeoutSeconds: 0.05 }, { ref: "HEAD", changedSurface: [] }, {
    createRunner: async () => ({
      platform: "linux",
      isFullyActive: () => true,
      degradedReason: () => null,
      spawn: () => {
        const c = fakeChild(0, 10_000);
        const origKill = c.kill;
        c.kill = () => { killed = true; origKill(); };
        return c as never;
      },
    }),
    now: () => 0,
  });
  expect(r.passed).toBe(false);
  expect(r.summary).toContain("timed out");
  expect(killed).toBe(true);
});

test("spawn throwing → could not run", async () => {
  const r = await runPreflightCommand(cfg, { ref: "HEAD", changedSurface: [] }, {
    createRunner: async () => ({ platform: "linux", isFullyActive: () => true, degradedReason: () => null, spawn: () => { throw new Error("boom"); } }),
    now: () => 0,
  });
  expect(r.passed).toBe(false);
  expect(r.summary).toContain("could not run");
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `preflight-runner.ts`**

First read `packages/gateway/src/extensions/manifest.ts` to confirm the `ExtensionManifest` field names, then build a minimal manifest granting only `cfg.cwd`. The body below assumes a manifest with `id`, `name`, `version`, and a filesystem-roots field — **match the real type** (the DI seam means the integration/unit tests never touch the real manifest, but `tsc` must pass).

```typescript
// packages/gateway/src/federation/preflight-runner.ts
import type { ChildProcess } from "node:child_process";
import { createSandboxRunner, type SandboxRunner } from "../platform/sandbox/index.ts";
import type { ExtensionManifest } from "../extensions/manifest.ts";
import type { PreflightCommandConfig } from "../config/nimbus-toml.ts";

export interface PreflightRunParams {
  readonly ref: string;
  readonly changedSurface: readonly string[];
}
export interface PreflightRunResult {
  readonly passed: boolean;
  readonly summary: string;
  readonly durationMs: number;
}
export interface PreflightRunnerDeps {
  /** DI seam — defaults to the real per-OS sandbox runner. */
  readonly createRunner?: () => Promise<SandboxRunner>;
  readonly now?: () => number;
}

/** Minimal manifest that grants the sandbox ONLY the configured cwd (no network, no other roots). */
function preflightManifest(cwd: string): ExtensionManifest {
  // NOTE: match ExtensionManifest's exact field names from extensions/manifest.ts.
  return {
    id: "nimbus.preflight",
    name: "preflight",
    version: "1.0.0",
    permissions: { filesystem: { read: [cwd], write: [cwd] }, network: [] },
  } as unknown as ExtensionManifest;
}

function awaitExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, timedOut: false });
    });
  });
}

/**
 * I24 data plane: run the LOCALLY-configured command in the per-OS sandbox with the validated
 * params as env vars (never shell-interpolated, never as paths). Hard timeout kills the process.
 */
export async function runPreflightCommand(
  cfg: PreflightCommandConfig,
  params: PreflightRunParams,
  deps: PreflightRunnerDeps = {},
): Promise<PreflightRunResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const elapsed = () => now() - start;
  try {
    const runner = await (deps.createRunner ?? createSandboxRunner)();
    const env: Record<string, string> = {
      NIMBUS_PREFLIGHT_REF: params.ref,
      NIMBUS_PREFLIGHT_SURFACE: params.changedSurface.join(","),
    };
    const child = runner.spawn(cfg.command, [...cfg.args], {
      manifest: preflightManifest(cfg.cwd),
      env,
      cwd: cfg.cwd,
      stdio: "ignore",
    });
    const { code, timedOut } = await awaitExit(child, cfg.timeoutSeconds * 1000);
    if (timedOut) return { passed: false, summary: `timed out after ${cfg.timeoutSeconds}s`, durationMs: elapsed() };
    return { passed: code === 0, summary: code === 0 ? "passed" : `failed (exit ${code})`, durationMs: elapsed() };
  } catch {
    return { passed: false, summary: "preflight could not run", durationMs: elapsed() };
  }
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-runner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/gateway && bunx tsc --noEmit && cd ../..
git add packages/gateway/src/federation/preflight-runner.ts packages/gateway/src/federation/preflight-runner.test.ts
git commit -m "feat(phase6-slice6b): sandboxed preflight-runner (hard timeout + duration)"
```

---

## Task 9: `preflight-gate.ts` + I24 triple (wiring + docs + test + D18) — ONE commit

**Files:**

- Create: `packages/gateway/src/federation/preflight-gate.ts`
- Test: `packages/gateway/src/federation/preflight-gate.test.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts` (I24 runtime assertions)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (D18)
- Modify: `docs/SECURITY-INVARIANTS.md` (I24 row)

This is the invariant. The gate validates → grant-check → resolve LOCAL command → request local HITL approval → run in sandbox. It NEVER reads a command from the request. All deps are injected (testable; production wires them in Task 10).

- [ ] **Step 1: Write the failing gate test** (mirror `invoke-gate.test.ts`)

```typescript
// packages/gateway/src/federation/preflight-gate.test.ts
import { describe, expect, it } from "bun:test";
import { answerFederatedPreflight, type PreflightGateCtx, type InboundPreflight } from "./preflight-gate.ts";

function ctx(over: Partial<PreflightGateCtx> = {}): { audits: string[]; ctx: PreflightGateCtx } {
  const audits: string[] = [];
  const base: PreflightGateCtx = {
    isPeerGranted: () => true,
    resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/srv/x", timeoutSeconds: 60 }),
    requestApproval: async () => true,
    runCommand: async () => ({ passed: true, summary: "42 passed", durationMs: 12 }),
    audit: (e) => audits.push(e.decision),
    ...over,
  };
  return { audits, ctx: base };
}

const req: InboundPreflight = { peerId: "peer:a", namespace: "project:zurich", ref: "HEAD~1..HEAD", changedSurface: ["api.ts"], purpose: "merge" };

describe("answerFederatedPreflight (I24)", () => {
  it("runs the configured command after approval and returns leak-proof ok", async () => {
    const { ctx: c, audits } = ctx();
    const r = await answerFederatedPreflight(c, req);
    expect(r).toEqual({ kind: "ok", passed: true, summary: "42 passed" });
    expect(audits).toContain("answered");
  });

  it("never spawns before approval; a denied approval → denied, zero run", async () => {
    let ran = false;
    const { ctx: c } = ctx({ requestApproval: async () => false, runCommand: async () => { ran = true; return { passed: true, summary: "", durationMs: 0 }; } });
    const r = await answerFederatedPreflight(c, req);
    expect(r).toEqual({ kind: "error", error: "denied" });
    expect(ran).toBe(false);
  });

  it("IGNORES a caller-supplied command field — only the configured command runs", async () => {
    const seen: string[] = [];
    const { ctx: c } = ctx({ runCommand: async (cfg) => { seen.push(cfg.command); return { passed: true, summary: "", durationMs: 0 }; } });
    // attacker injects command/cmd/args on the wire body:
    await answerFederatedPreflight(c, { ...req, ...( { command: "rm -rf /", cmd: "evil", args: ["x"] } as object ) } as InboundPreflight);
    expect(seen).toEqual(["bun"]);
  });

  it("no configured command → not_configured, zero approval, zero run", async () => {
    let asked = false;
    const { ctx: c } = ctx({ resolveCommand: () => undefined, requestApproval: async () => { asked = true; return true; } });
    const r = await answerFederatedPreflight(c, req);
    expect(r).toEqual({ kind: "error", error: "not_configured" });
    expect(asked).toBe(false);
  });

  it("ungranted peer → opaque no_grant, zero approval", async () => {
    let asked = false;
    const { ctx: c } = ctx({ isPeerGranted: () => false, requestApproval: async () => { asked = true; return true; } });
    expect(await answerFederatedPreflight(c, req)).toEqual({ kind: "error", error: "no_grant" });
    expect(asked).toBe(false);
  });

  it("invalid ref / oversized surface → no_grant BEFORE approval", async () => {
    let asked = false;
    const { ctx: c } = ctx({ requestApproval: async () => { asked = true; return true; } });
    expect((await answerFederatedPreflight(c, { ...req, ref: "bad ref;rm" })).kind).toBe("error");
    expect((await answerFederatedPreflight(c, { ...req, changedSurface: Array(201).fill("a") })).kind).toBe("error");
    expect(asked).toBe(false);
  });

  it("identity-invalid → opaque no_grant", async () => {
    const { ctx: c } = ctx({ identity: { enabled: true, isOperatorValid: () => false } });
    expect(await answerFederatedPreflight(c, req)).toEqual({ kind: "error", error: "no_grant" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `preflight-gate.ts`**

```typescript
// packages/gateway/src/federation/preflight-gate.ts
import type { PreflightCommandConfig } from "../config/nimbus-toml.ts";
import type { PreflightApprovalInput } from "./preflight-consent-broker.ts";
import type { PreflightRunParams, PreflightRunResult } from "./preflight-runner.ts";

const REF_RE = /^[A-Za-z0-9_./~^-]+$/;
const SURFACE_SYMBOL_RE = /^[A-Za-z0-9_.:#/-]+$/;
const MAX_SURFACE = 200;

export type PreflightDecision = "answered" | "no_grant" | "not_configured" | "denied" | "invalid";

export interface PreflightGateCtx {
  /** True iff the peer holds an active grant on the namespace (NamespaceStore.getActiveGrant). */
  readonly isPeerGranted: (namespace: string, peerId: string) => boolean;
  /** Resolve the LOCAL config command for the namespace; undefined → not configured (fail-closed). */
  readonly resolveCommand: (namespace: string) => PreflightCommandConfig | undefined;
  /** Local owner HITL approval (PreflightConsentBroker.request). */
  readonly requestApproval: (input: PreflightApprovalInput) => Promise<boolean>;
  /** Run the configured command in the sandbox (preflight-runner.runPreflightCommand). */
  readonly runCommand: (cfg: PreflightCommandConfig, params: PreflightRunParams) => Promise<PreflightRunResult>;
  /** Audit each outcome (durationMs present on a real run). */
  readonly audit: (entry: { decision: PreflightDecision; peerId: string; namespace: string; durationMs?: number }) => void;
  /** I18: when identity is enabled, the operator must be valid to serve. */
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

/** The inbound request. A caller-supplied `command`/`cmd`/`args` is intentionally NOT modeled — ignored. */
export interface InboundPreflight {
  readonly peerId: string;
  readonly namespace: string;
  readonly ref: string;
  readonly changedSurface: readonly string[];
  readonly purpose: string;
}

export type PreflightResult =
  | { readonly kind: "ok"; readonly passed: boolean; readonly summary: string }
  | { readonly kind: "error"; readonly error: "no_grant" | "not_configured" | "denied" };

function validRequest(q: InboundPreflight): boolean {
  if (!REF_RE.test(q.ref)) return false;
  if (q.changedSurface.length > MAX_SURFACE) return false;
  return q.changedSurface.every((s) => SURFACE_SYMBOL_RE.test(s));
}

/**
 * I24 — the SOLE path from an inbound federation.preflight to a sandbox spawn.
 * identity → validate → grant → resolve-LOCAL-command → LOCAL HITL approval → sandbox-run.
 * The caller never selects or supplies the command; missing config fails closed; no path/body leaks.
 */
export async function answerFederatedPreflight(
  ctx: PreflightGateCtx,
  q: InboundPreflight,
): Promise<PreflightResult> {
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    ctx.audit({ decision: "no_grant", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "no_grant" };
  }
  if (!validRequest(q)) {
    ctx.audit({ decision: "invalid", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "no_grant" }; // opaque
  }
  if (!ctx.isPeerGranted(q.namespace, q.peerId)) {
    ctx.audit({ decision: "no_grant", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "no_grant" };
  }
  const cfg = ctx.resolveCommand(q.namespace);
  if (cfg === undefined) {
    ctx.audit({ decision: "not_configured", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "not_configured" };
  }
  const approved = await ctx.requestApproval({ peerId: q.peerId, namespace: q.namespace, ref: q.ref, purpose: q.purpose });
  if (!approved) {
    ctx.audit({ decision: "denied", peerId: q.peerId, namespace: q.namespace });
    return { kind: "error", error: "denied" };
  }
  const result = await ctx.runCommand(cfg, { ref: q.ref, changedSurface: q.changedSurface });
  ctx.audit({ decision: "answered", peerId: q.peerId, namespace: q.namespace, durationMs: result.durationMs });
  return { kind: "ok", passed: result.passed, summary: result.summary };
}
```

- [ ] **Step 4: Run gate test — verify PASS.**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-gate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the static D18 rule to `check-nimbus-invariants.ts`**

Mirror `checkChatopsReplySurfaceInvariant` (D17). Add the checker:

```typescript
// D18 (I24) — the preflight sandbox runner (`runPreflightCommand`) may be referenced ONLY from
// preflight-gate.ts (the gate) + preflight-runner.ts (its home). Any other module spawning the
// preflight command would bypass the local HITL gate / the downstream-config-only command (I24).
const PREFLIGHT_RUNNER_ALLOWED = [
  "packages/gateway/src/federation/preflight-gate.ts",
  "packages/gateway/src/federation/preflight-runner.ts",
];
const PREFLIGHT_RUNNER_RE = /\brunPreflightCommand\b/;

export function checkPreflightRunnerInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (PREFLIGHT_RUNNER_ALLOWED.some((p) => f.relPath === p)) continue;
    const lines = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (PREFLIGHT_RUNNER_RE.test(lines[i] ?? "")) {
        out.push({ rule: "D18-preflight-runner", file: f.relPath, line: i + 1, snippet: (original[i] ?? "").trim() });
      }
    }
  }
  return out;
}
```

Register it in `run()` (in the `binary-only`/`all` block, mirroring the D17 registration):

```typescript
  if (mode === "binary-only" || mode === "all") {
    const v = checkPreflightRunnerInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D18 runPreflightCommand referenced outside preflight-gate/preflight-runner — bypasses I24: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
```

- [ ] **Step 6: Run the static audit — verify it passes** (the gate imports the runner type only; the real `runCommand` is wired in Task 10 via a thunk that calls `runPreflightCommand` from inside `preflight-gate.ts`'s allowed list OR from federation-rpc — see note).

> **D18 wiring note:** the production `runCommand` thunk calls `runPreflightCommand`. To keep D18 satisfied, that thunk lives in `preflight-gate.ts` as an exported helper `defaultRunCommand` (so the call site is in an allowed file), and Task 10 passes `ctx.runCommand = defaultRunCommand`. Add to `preflight-gate.ts`:
>
> ```typescript
> import { runPreflightCommand } from "./preflight-runner.ts";
> export const defaultRunCommand: PreflightGateCtx["runCommand"] = (cfg, params) => runPreflightCommand(cfg, params);
> ```

Run: `bun scripts/structure-audit/check-nimbus-invariants.ts all`
Expected: exit 0 (no D18 violations).

- [ ] **Step 7: Add the I24 runtime assertions to `security-invariants.test.ts`**

```typescript
describe("I24 — a federated preflight executes only behind the LOCAL owner's HITL gate", () => {
  test("federation.preflight routes through answerFederatedPreflight (sole path)", async () => {
    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).toContain("answerFederatedPreflight");
  });

  test("the gate never spawns before approval, ignores a caller-supplied command, fails closed", async () => {
    const { answerFederatedPreflight } = await import("./federation/preflight-gate.ts");
    let ran = 0;
    let cmdSeen = "";
    const base = {
      isPeerGranted: () => true,
      resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/x", timeoutSeconds: 60 }),
      runCommand: async (cfg: { command: string }) => {
        ran += 1;
        cmdSeen = cfg.command;
        return { passed: true, summary: "", durationMs: 0 };
      },
      audit: () => {},
    };
    const req = { peerId: "p", namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" };
    // denied → zero run
    await answerFederatedPreflight({ ...base, requestApproval: async () => false }, req);
    expect(ran).toBe(0);
    // approved + caller-supplied command → only configured command runs
    await answerFederatedPreflight(
      { ...base, requestApproval: async () => true },
      { ...req, ...({ command: "rm -rf /" } as object) } as never,
    );
    expect(cmdSeen).toBe("bun");
    // no config → not_configured, still zero extra run
    const r = await answerFederatedPreflight(
      { ...base, resolveCommand: () => undefined, requestApproval: async () => true },
      req,
    );
    expect(r).toEqual({ kind: "error", error: "not_configured" });
  });

  test("D18 confines runPreflightCommand to preflight-gate/preflight-runner", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D18-preflight-runner");
  });
});
```

- [ ] **Step 8: Add the I24 row to `docs/SECURITY-INVARIANTS.md`** — copy an existing row's structure (e.g. I19/I23). Text:

```markdown
- **I24** — a federated preflight (action) request executes only behind the LOCAL owner's HITL gate, never on the caller's say-so, runs only a downstream-owner-configured command in the sandbox, fails closed on missing config (static D18) · `federation/preflight-gate.ts`
```

Also add the I24 line + D18 to the static-complement paragraph.

- [ ] **Step 9: Run the invariant test + static audit, then commit ALL of it together (the triple lands in one commit).**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-gate.test.ts packages/gateway/src/security-invariants.test.ts && bun scripts/structure-audit/check-nimbus-invariants.ts all && cd packages/gateway && bunx tsc --noEmit && cd ../..`
Expected: PASS; audit exit 0; tsc clean.

```bash
git add packages/gateway/src/federation/preflight-gate.ts packages/gateway/src/federation/preflight-gate.test.ts packages/gateway/src/security-invariants.test.ts scripts/structure-audit/check-nimbus-invariants.ts docs/SECURITY-INVARIANTS.md
git commit -m "feat(phase6-slice6b): I24 preflight gate + D18 static check + invariant test (triple)"
```

---

## Task 10: `federation.preflight` + `federation.preflightRespond` inbound RPC + ctx threading

**Files:**

- Modify: `packages/gateway/src/ipc/federation-rpc.ts` (handlers + `FederationRpcContext`)
- Modify: `packages/gateway/src/federation/federation-server.ts` (thread deps)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (construct deps)
- Modify: `packages/gateway/src/platform/assemble.ts` (`preflightConsent.setBroadcast`)
- Test: `packages/gateway/src/ipc/federation-rpc.preflight.test.ts`

- [ ] **Step 1: Write the failing RPC test**

```typescript
// packages/gateway/src/ipc/federation-rpc.preflight.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";

function ctx(db: Database, over: Partial<FederationRpcContext> = {}): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as unknown as FederationRpcContext["discovery"],
    pairing: { listPeers: () => [] } as unknown as FederationRpcContext["pairing"],
    preflight: {
      isPeerGranted: () => true,
      resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/x", timeoutSeconds: 60 }),
      requestApproval: async () => true,
      runCommand: async () => ({ passed: true, summary: "ok", durationMs: 1 }),
      audit: () => {},
    },
    ...over,
  };
}

test("federation.preflight routes to the gate and returns ok", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const out = await dispatchFederationRpc(
    "federation.preflight",
    { namespace: "n", ref: "HEAD", changedSurface: ["a.ts"], purpose: "x", peerId: "peer:a" },
    ctx(db),
  );
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") expect(out.value).toEqual({ kind: "ok", passed: true, summary: "ok" });
});

test("federation.preflight fails closed when preflight ctx is absent", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const c = ctx(db);
  delete (c as { preflight?: unknown }).preflight;
  await expect(
    dispatchFederationRpc("federation.preflight", { namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x", peerId: "peer:a" }, c),
  ).rejects.toThrow();
});

test("federation.preflightRespond resolves a pending approval", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const out = await dispatchFederationRpc("federation.preflightRespond", { requestId: "nope", approved: true }, ctx(db));
  expect(out.kind).toBe("hit");
  if (out.kind === "hit") expect(out.value).toEqual({ matched: false }); // unknown id
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `timeout 60 bun test packages/gateway/src/ipc/federation-rpc.preflight.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `FederationRpcContext`** — add the `preflight` field (the gate deps, optional — present on dispatch + LAN paths):

```typescript
  // I24 (Slice 6b). Present on the answering path: the downstream preflight gate's deps.
  readonly preflight?: {
    readonly isPeerGranted: (namespace: string, peerId: string) => boolean;
    readonly resolveCommand: (namespace: string) => import("../config/nimbus-toml.ts").PreflightCommandConfig | undefined;
    readonly requestApproval: (input: { peerId: string; namespace: string; ref: string; purpose: string }) => Promise<boolean>;
    readonly runCommand: import("../federation/preflight-gate.ts").PreflightGateCtx["runCommand"];
    readonly audit: import("../federation/preflight-gate.ts").PreflightGateCtx["audit"];
  };
```

- [ ] **Step 4: Add the handlers** to the dispatch table (imports: `answerFederatedPreflight` from `../federation/preflight-gate.ts`, `preflightConsent` from `../federation/preflight-consent-broker.ts`):

```typescript
    "federation.preflight": async (p) => {
      const rec = asRecord(p);
      if (ctx.preflight === undefined) {
        throw new FederationRpcError(-32603, "ERR_PREFLIGHT_UNAVAILABLE: not configured to serve preflights");
      }
      const surfaceRaw = rec["changedSurface"];
      const changedSurface = Array.isArray(surfaceRaw)
        ? surfaceRaw.filter((s): s is string => typeof s === "string")
        : [];
      return answerFederatedPreflight(
        { ...ctx.preflight, ...(ctx.identityGuard === undefined ? {} : { identity: ctx.identityGuard }) },
        {
          peerId: requireString(rec, "peerId"),
          namespace: requireString(rec, "namespace"),
          ref: requireString(rec, "ref"),
          changedSurface,
          purpose: requireString(rec, "purpose"),
        },
      );
    },
    "federation.preflightRespond": (p) => {
      const rec = asRecord(p);
      const matched = preflightConsent.respond(requireString(rec, "requestId"), rec["approved"] === true);
      return { matched };
    },
```

> `federation.preflightRespond` is a LOCAL owner action; it must be reachable from the local dispatcher only. It is NOT a federated-over-wire method an external peer should call. The LAN server's `onMessage` dispatch reaches the same table — guard by NOT threading `preflight` deps in a way that allows a remote `preflightRespond` to matter (the broker is local-only state; a remote `requestId` is unknown → `matched:false`, harmless). No extra gating needed, but document this.

- [ ] **Step 5: Thread the deps in `dispatchers.ts`** — in the `FederationRpcContext` construction (lines ~226-245), add the `preflight` block. Build it from the local config + NamespaceStore + the `preflightConsent` broker + `defaultRunCommand` + a small audit fn:

```typescript
  // I24: downstream preflight serving (Slice 6b). Configured commands come from local nimbus.toml only.
  ...(ctx.options.configDir === undefined
    ? {}
    : {
        preflight: {
          isPeerGranted: (ns: string, peerId: string) => new NamespaceStore(index.getDatabase()).getActiveGrant(ns, peerId) !== undefined,
          resolveCommand: (ns: string) => loadNimbusPreflightFromConfigDir(ctx.options.configDir as string).get(ns),
          requestApproval: (input) => preflightConsent.request(input, ((ctx.options.federationConsentTimeoutSeconds ?? 30) * 1000) + 5000),
          runCommand: defaultRunCommand,
          audit: (e) => appendPreflightAudit(index.getDatabase(), e),
        },
      }),
```

> Imports needed in `dispatchers.ts`: `NamespaceStore` from `../../federation/namespace-store.ts`, `loadNimbusPreflightFromConfigDir` from `../../config/nimbus-toml.ts`, `preflightConsent` + `defaultRunCommand` + `appendPreflightAudit`. Define `appendPreflightAudit(db, {decision, peerId, namespace, durationMs?})` in `preflight-gate.ts` using the canonical `appendAuditEntry` from `federation-audit.ts` with `actionType: "federation.preflight." + decision` (read `federation-audit.ts` for the exact `appendAuditEntry` signature; mirror invoke-gate's `appendTeamVaultAudit`). Re-run D18 after — `appendPreflightAudit` lives in `preflight-gate.ts` (allowed).

- [ ] **Step 6: Thread through `federation-server.ts`** — add `preflight?` to `BuildFederationLanServerDeps` and spread it into the per-call `ctx` in `onMessage` (mirror the `teamVault`/`identityGuard` optional-spread). Then in `assemble.ts` where `buildFederationLanServer` is called, pass the same `preflight` object you built for the dispatcher (or omit on the LAN path if preflight-over-wire is the only intended trigger — it IS: the upstream peer calls `federation.preflight` over the wire, so the LAN path MUST carry the `preflight` deps). Wire it.

- [ ] **Step 7: Wire `preflightConsent.setBroadcast` in `assemble.ts`** — next to the existing `federationConsent.setBroadcast(...)` block (around line 1161):

```typescript
import { preflightConsent } from "../federation/preflight-consent-broker.ts";
// ... inside the `if (federationBooted) {` block:
preflightConsent.setBroadcast((method, params) => ipc.broadcast(method, asBroadcastParams(params)));
```

- [ ] **Step 8: Run tests + typecheck + audit.**

Run: `timeout 60 bun test packages/gateway/src/ipc/federation-rpc.preflight.test.ts && cd packages/gateway && bunx tsc --noEmit && cd ../.. && bun scripts/structure-audit/check-nimbus-invariants.ts all`
Expected: PASS; tsc clean; audit exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/federation-rpc.preflight.test.ts packages/gateway/src/federation/federation-server.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/federation/preflight-gate.ts
git commit -m "feat(phase6-slice6b): federation.preflight + preflightRespond RPC + boot wiring"
```

---

## Task 11: `fanOutPreflight` in `peer-fanout.ts`

**Files:**

- Modify: `packages/gateway/src/federation/peer-fanout.ts`
- Test: `packages/gateway/src/federation/peer-fanout.preflight.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/federation/peer-fanout.preflight.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { LocalIndex } from "../index/local-index.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { fanOutPreflight, type PeerFanoutDeps } from "./peer-fanout.ts";

function deps(send: PeerFanoutDeps["sendOverWire"]): PeerFanoutDeps {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const index = new LocalIndex(db);
  index.addLanPeer({ peerId: "peer:a", peerPubkey: new Uint8Array(32), direction: "outbound", hostIp: "10.0.0.2" });
  db.run(`UPDATE lan_peers SET host_port = 7070 WHERE peer_id = 'peer:a'`);
  return { index, selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }, store: new KnownNamespaceStore(db), sendOverWire: send };
}

test("maps ok → pass/fail; error envelopes → declined/not_configured", async () => {
  const pass = await fanOutPreflight(deps(async () => ({ kind: "ok", passed: true, summary: "42 passed" })), { namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" });
  expect(pass.perPeer[0]).toEqual({ peerId: "peer:a", displayName: null, status: "pass", summary: "42 passed" });

  const declined = await fanOutPreflight(deps(async () => ({ kind: "error", error: "denied" })), { namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" });
  expect(declined.perPeer[0]?.status).toBe("declined");

  const notcfg = await fanOutPreflight(deps(async () => ({ kind: "error", error: "not_configured" })), { namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" });
  expect(notcfg.perPeer[0]?.status).toBe("not_configured");
});

test("transport error → gap (never 'pass')", async () => {
  const out = await fanOutPreflight(deps(async () => { throw new Error("down"); }), { namespace: "n", ref: "HEAD", changedSurface: [], purpose: "x" });
  expect(out.perPeer).toEqual([]);
  expect(out.gaps.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `timeout 60 bun test packages/gateway/src/federation/peer-fanout.preflight.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `PeerPreflightResult` + `fanOutPreflight`**

```typescript
export interface PeerPreflightResult {
  readonly peerId: string;
  readonly displayName: string | null;
  readonly status: "pass" | "fail" | "declined" | "not_configured";
  readonly summary: string;
}

export async function fanOutPreflight(
  deps: PeerFanoutDeps,
  req: { namespace: string; ref: string; changedSurface: readonly string[]; purpose: string },
): Promise<PeerFanoutOutcome<PeerPreflightResult>> {
  const send = deps.sendOverWire ?? sendFederatedOverWire;
  const { perPeer, gaps } = await runPool<PeerPreflightResult>(reachablePeers(deps.index), async (row) => {
    try {
      const r = (await send(
        row.host_ip as string,
        row.host_port as number,
        deps.selfIdentity,
        row.peer_pubkey,
        "federation.preflight",
        { namespace: req.namespace, ref: req.ref, changedSurface: [...req.changedSurface], purpose: req.purpose },
      )) as { kind?: string; passed?: boolean; summary?: string; error?: string };
      if (r.kind === "ok") {
        return { ok: { peerId: row.peer_id, displayName: row.display_name, status: r.passed === true ? "pass" : "fail", summary: r.summary ?? "" } };
      }
      const status = r.error === "not_configured" ? "not_configured" : "declined";
      return { ok: { peerId: row.peer_id, displayName: row.display_name, status, summary: r.error ?? "error" } };
    } catch (err) {
      return { gap: gapForPeer(row, err) };
    }
  });
  perPeer.sort((a, b) => a.peerId.localeCompare(b.peerId));
  return { perPeer, gaps };
}
```

- [ ] **Step 4: Run test — PASS; Step 5: Commit**

```bash
git add packages/gateway/src/federation/peer-fanout.ts packages/gateway/src/federation/peer-fanout.preflight.test.ts
git commit -m "feat(phase6-slice6b): fanOutPreflight (upstream blast-radius fan-out)"
```

---

## Task 12: `agents/preflight.ts` (upstream) + unions + render

**Files:**

- Create: `packages/gateway/src/agents/preflight.ts`
- Modify: `findings.ts`, `emit-brief.ts`, `synthesize.ts`, `render.ts`
- Test: `packages/gateway/src/agents/preflight.test.ts`

- [ ] **Step 1: Extend the brief types** (`findings.ts`):

```typescript
export type PreflightDownstream = {
  peerId: string;
  who: string | null;
  status: "pass" | "fail" | "declined" | "not_configured";
  summary: string;
};

export type PreflightBrief = AgentBriefBase & {
  kind: "preflight";
  query: { ref: string; namespace: string };
  downstreams: PreflightDownstream[];
  anyFailed: boolean;
  anyIncomplete: boolean; // declined / not_configured / gap present
};

export function isPreflightBrief(x: unknown): x is PreflightBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "preflight" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["downstreams"]) &&
    typeof b["anyFailed"] === "boolean" &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}
```

Add `PreflightBrief` to `AgentBrief` (findings.ts), `AnyBrief` (emit-brief.ts), `SynthInput` + `deterministicRender` + `toolNameFor` (synthesize.ts → `"agents.preflight"`).

- [ ] **Step 2: Add `renderPreflight`** (render.ts):

```typescript
export function renderPreflight(brief: PreflightBrief): string {
  const header = `# Preflight: ${brief.query.ref}`;
  const icon = (s: PreflightDownstream["status"]) =>
    s === "pass" ? "✅ pass" : s === "fail" ? "❌ fail" : s === "declined" ? "⏸ declined" : "⚠ not configured";
  const body =
    brief.downstreams.length === 0
      ? "_no downstream owners reachable_"
      : brief.downstreams.map((d) => `- **${d.who ?? d.peerId}**: ${icon(d.status)} — ${d.summary}`).join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
}
```

(import `PreflightBrief` + `PreflightDownstream` in render.ts)

- [ ] **Step 3: Write the failing agent test**

```typescript
// packages/gateway/src/agents/preflight.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { LocalIndex } from "../index/local-index.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { runPreflight, type PreflightContext } from "./preflight.ts";

function ctx(db: Database, send: PreflightContext["sendOverWire"]): PreflightContext {
  const index = new LocalIndex(db);
  index.addLanPeer({ peerId: "peer:a", peerPubkey: new Uint8Array(32), direction: "outbound", hostIp: "10.0.0.2" });
  db.run(`UPDATE lan_peers SET host_port = 7070 WHERE peer_id = 'peer:a'`);
  return { db, index, selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }, store: new KnownNamespaceStore(db), sendOverWire: send, notify: () => {}, sessionId: "s1" };
}

test("aggregates a failing downstream → anyFailed true", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const brief = await runPreflight(
    { ref: "HEAD~1..HEAD", namespace: "project:zurich", changedSurface: ["api.ts"] },
    ctx(db, async () => ({ kind: "ok", passed: false, summary: "3 failed" })),
  );
  expect(brief.anyFailed).toBe(true);
  expect(brief.downstreams[0]?.status).toBe("fail");
});

test("a declined downstream → anyIncomplete true, anyFailed false", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const brief = await runPreflight(
    { ref: "HEAD", namespace: "n", changedSurface: [] },
    ctx(db, async () => ({ kind: "error", error: "denied" })),
  );
  expect(brief.anyFailed).toBe(false);
  expect(brief.anyIncomplete).toBe(true);
});
```

- [ ] **Step 4: Run test to verify it fails, then implement `agents/preflight.ts`**

```typescript
// packages/gateway/src/agents/preflight.ts
import type { Database } from "bun:sqlite";
import { fanOutPreflight } from "../federation/peer-fanout.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { buildFanoutDeps } from "./_lib/fanout-deps.ts";
import type { GapNote, PreflightBrief } from "./_lib/findings.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type PreflightInput = { ref: string; namespace: string; changedSurface: string[] };

export type PreflightContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

export async function runPreflight(input: PreflightInput, ctx: PreflightContext): Promise<PreflightBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" });
  }
  const out = await fanOutPreflight(buildFanoutDeps(ctx), {
    namespace: input.namespace,
    ref: input.ref,
    changedSurface: input.changedSurface,
    purpose: "preflight",
  });
  gaps.push(...out.gaps);
  const downstreams = out.perPeer.map((p) => ({ peerId: p.peerId, who: p.displayName, status: p.status, summary: p.summary }));
  const anyFailed = downstreams.some((d) => d.status === "fail");
  const anyIncomplete = gaps.length > 0 || downstreams.some((d) => d.status === "declined" || d.status === "not_configured");

  return {
    kind: "preflight",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { ref: input.ref, namespace: input.namespace },
    downstreams,
    anyFailed,
    anyIncomplete,
  };
}

export function emitPreflightBrief(input: PreflightInput, ctx: PreflightContext): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "preflight.briefReady",
    briefErrorMethod: "preflight.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runPreflight(input, ctx),
  });
}
```

- [ ] **Step 5: Run test + tsc — PASS; Step 6: Commit**

```bash
cd packages/gateway && bunx tsc --noEmit && cd ../..
git add packages/gateway/src/agents/preflight.ts packages/gateway/src/agents/preflight.test.ts packages/gateway/src/agents/_lib/
git commit -m "feat(phase6-slice6b): preflight agent (upstream blast-radius aggregation)"
```

---

## Task 13: `agents.preflight` IPC + `nimbus preflight` / `nimbus preflight approve` CLI

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts`, `packages/cli/src/commands/_agent-brief-cli.ts`
- Create: `packages/cli/src/commands/preflight.ts` (+ test)
- Modify: `packages/cli/src/types/agents.ts`, `packages/cli/src/index.ts`, `packages/cli/src/commands/registry.ts`
- Test: `packages/gateway/src/ipc/agents-rpc.preflight.test.ts`, `packages/cli/src/commands/preflight.test.ts`

- [ ] **Step 1: Add `timeoutMs` to the CLI helper** — in `_agent-brief-cli.ts`, add `timeoutMs?: number` to `AgentBriefCliSpec`, and in `awaitBrief` replace the fixed `TIMEOUT_MS` with `spec.timeoutMs ?? TIMEOUT_MS`, and the error message with `Agent timed out after ${(spec.timeoutMs ?? TIMEOUT_MS) / 1000} s`.

- [ ] **Step 2: Add the gateway handler test**

```typescript
// packages/gateway/src/ipc/agents-rpc.preflight.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

test("agents.preflight returns sessionId + emits preflight.briefReady", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  const seen: string[] = [];
  const out = await dispatchAgentsRpc("agents.preflight", { ref: "HEAD", namespace: "n", changedSurface: ["a.ts"] }, { db, notify: (m) => seen.push(m) });
  expect(out.kind).toBe("hit");
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toContain("preflight.briefReady");
});

test("agents.preflight rejects missing ref/namespace", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  await expect(dispatchAgentsRpc("agents.preflight", { ref: "HEAD" }, { db, notify: () => {} })).rejects.toThrow();
});
```

- [ ] **Step 3: Add the handler** to `agents-rpc.ts` (import `emitPreflightBrief`):

```typescript
function requirePreflightParams(params: unknown): { ref: string; namespace: string; changedSurface: string[] } {
  if (params === null || typeof params !== "object") throw new Error("agents.preflight: object params required");
  const p = params as Record<string, unknown>;
  if (typeof p["ref"] !== "string" || p["ref"].length === 0) throw new Error("agents.preflight: ref required");
  if (typeof p["namespace"] !== "string" || p["namespace"].length === 0) throw new Error("agents.preflight: namespace required");
  const surface = Array.isArray(p["changedSurface"]) ? p["changedSurface"].filter((s): s is string => typeof s === "string") : [];
  return { ref: p["ref"], namespace: p["namespace"], changedSurface: surface };
}

async function handlePreflight(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requirePreflightParams(params);
  return await emitPreflightBrief(input, federatedAgentBase(ctx, newSessionId("preflight")));
}
```

Add `"agents.preflight": handlePreflight,` to the table.

- [ ] **Step 4: Run gateway test — PASS.**

Run: `timeout 60 bun test packages/gateway/src/ipc/agents-rpc.preflight.test.ts`

- [ ] **Step 5: Add CLI types** — `cli/src/types/agents.ts`: add `PreflightBrief` mirror type + `isPreflightBrief` guard (mirror Task 12 Step 1: checks `kind === "preflight"`, `agentVersion`, `Array.isArray(gaps)`, `Array.isArray(downstreams)`, `typeof anyFailed === "boolean"`, numbers, query object).

- [ ] **Step 6: Write the CLI test**

```typescript
// packages/cli/src/commands/preflight.test.ts
import { expect, test } from "bun:test";
import { parsePreflightArgs } from "./preflight.ts";

test("preflight run: ref + --namespace + --strict", () => {
  expect(parsePreflightArgs(["HEAD~1..HEAD", "--namespace", "project:zurich", "--strict", "--json"])).toEqual({
    mode: "run",
    ref: "HEAD~1..HEAD",
    namespace: "project:zurich",
    strict: true,
    json: true,
  });
});

test("preflight requires --namespace in run mode", () => {
  expect(() => parsePreflightArgs(["HEAD"])).toThrow();
});

test("preflight approve <id>", () => {
  expect(parsePreflightArgs(["approve", "abc-123"])).toEqual({ mode: "approve", requestId: "abc-123" });
});
```

- [ ] **Step 7: Implement `preflight.ts`** (note: `approve` calls `federation.preflightRespond` directly via IPC, not `runAgentBriefCli`; the `run` path uses a longer `timeoutMs`):

```typescript
// packages/cli/src/commands/preflight.ts
import { IPCClient } from "@nimbus-dev/client";
import { getCliPlatformPaths, readGatewayState } from "../platform/paths.ts";
import { type PreflightBrief, isPreflightBrief } from "../types/agents.ts";
import { runAgentBriefCli } from "./_agent-brief-cli.ts";

const PREFLIGHT_TIMEOUT_MS = 600_000; // 10 min — downstream owners approve interactively

export type PreflightCliArgs =
  | { mode: "run"; ref: string; namespace: string; strict: boolean; json: boolean }
  | { mode: "approve"; requestId: string };

export function parsePreflightArgs(args: string[]): PreflightCliArgs {
  if (args[0] === "approve") {
    const requestId = args[1];
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.startsWith("--")) {
      throw new Error("Usage: nimbus preflight approve <request-id>");
    }
    return { mode: "approve", requestId };
  }
  const positional: string[] = [];
  let namespace = "";
  let strict = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--strict") strict = true;
    else if (a === "--namespace") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0 || v.startsWith("--")) throw new Error("--namespace requires a value");
      namespace = v.trim();
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) positional.push(a);
  }
  const ref = positional.join(" ").trim();
  if (ref.length === 0) throw new Error('Usage: nimbus preflight <ref> --namespace <ns> [--strict] [--json]');
  if (namespace.length === 0) throw new Error("nimbus preflight requires --namespace <ns>");
  return { mode: "run", ref, namespace, strict, json };
}

async function approve(requestId: string): Promise<void> {
  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  try {
    await client.connect();
    const out = await client.call<{ matched: boolean }>("federation.preflightRespond", { requestId, approved: true });
    process.stdout.write(out.matched ? "approved\n" : "no pending request with that id\n");
  } finally {
    await client.disconnect();
  }
}

export async function runPreflightCli(args: string[]): Promise<void> {
  const parsed = parsePreflightArgs(args);
  if (parsed.mode === "approve") {
    await approve(parsed.requestId);
    return;
  }
  await runAgentBriefCli<PreflightBrief>({
    kind: "preflight",
    guard: isPreflightBrief,
    json: parsed.json,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    params: { ref: parsed.ref, namespace: parsed.namespace },
  });
  // Note: --strict exit-code handling is applied by reading the brief; see Step 8.
}
```

> **Exit-code contract (§4.5):** `runAgentBriefCli` currently always `process.exit(2)` on error and returns void on success. To honor the contract, extend `runAgentBriefCli` to optionally return the `findings`, and in `runPreflightCli` inspect them: `anyFailed` → `process.exit(1)`; `strict && anyIncomplete` → `process.exit(1)`. Implement by giving `runAgentBriefCli` an optional `onResult?: (findings) => void` callback invoked before the success return; in `preflight.ts` pass `onResult: (f) => { if (f.anyFailed || (parsed.strict && f.anyIncomplete)) process.exitCode = 1; }`. (Use `process.exitCode`, not `process.exit`, so output flushes — and reset to 0 in tests per [[bun-test-exit-code-leak]].)

- [ ] **Step 8: Run CLI test — PASS; register the command** — `index.ts`: `preflight: runPreflightCli,`; `registry.ts`: add `"preflight",` (alphabetical, between `"people"`/`"profile"` → actually between `"people"` and `"profile"`; place per strict alphabetical order).

- [ ] **Step 9: Typecheck both + commit**

```bash
cd packages/gateway && bunx tsc --noEmit && cd ../cli && bunx tsc --noEmit && cd ../..
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.preflight.test.ts packages/cli/src/commands/preflight.ts packages/cli/src/commands/preflight.test.ts packages/cli/src/commands/_agent-brief-cli.ts packages/cli/src/types/agents.ts packages/cli/src/index.ts packages/cli/src/commands/registry.ts
git commit -m "feat(phase6-slice6b): agents.preflight IPC + nimbus preflight/approve CLI"
```

---

## Task 14: Tauri allowlist + docs + schema-version prose + CHANGELOG

**Files:**

- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs`
- Modify: `packages/gateway/src/security-invariants.test.ts` (count mirror)
- Modify: `CLAUDE.md`, `GEMINI.md`, `docs/CHANGELOG.md`

- [ ] **Step 1: Add to `ALLOWED_METHODS`** (alphabetical) the two read-only agent methods: `"agents.janitor"` and `"agents.preflight"`. **Do NOT** add `federation.preflightRespond` (it is an approval/RCE-adjacent action — CLI-only, like `federation.pair`). Update `assert_eq!(ALLOWED_METHODS.len(), 86)` → `88`.

- [ ] **Step 2: Update the JS mirror** in `security-invariants.test.ts`: change the `allowlist_exact_size assertion is 86` test to `88` (both the test title and the regex `/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*88\s*\)/`).

- [ ] **Step 3: Run the Rust + invariant checks**

Run: `cd packages/ui/src-tauri && cargo test allowlist_exact_size 2>/dev/null; cd ../../.. && timeout 60 bun test packages/gateway/src/security-invariants.test.ts`
Expected: cargo test PASS (88); invariant test PASS.

> If Rust toolchain is unavailable in the worktree, the JS mirror assertion is the authoritative local gate; CI runs cargo.

- [ ] **Step 4: Update CLAUDE.md + GEMINI.md** — add the I24 row to the Security Invariants list (mirror the SECURITY-INVARIANTS.md text), add I24 + D18 to the static-complement sentence, and bump the status line schema/invariant note (`invariants through I24`). Do NOT touch the connector status line (merge-conflict convention).

- [ ] **Step 5: Add the CHANGELOG entry** (`docs/CHANGELOG.md`, dated 2026-06-11) summarizing the janitor + preflight + I24/D18; note `agents.{janitor,preflight}.briefReady` payload `{sessionId, brief, findings}` and the Tauri allowlist 86 → 88.

- [ ] **Step 6: Lint markdown + commit**

```bash
bunx markdownlint-cli2 --fix docs/CHANGELOG.md docs/SECURITY-INVARIANTS.md
git add packages/ui/src-tauri/src/gateway_bridge.rs packages/gateway/src/security-invariants.test.ts CLAUDE.md GEMINI.md docs/CHANGELOG.md docs/SECURITY-INVARIANTS.md
git commit -m "feat(phase6-slice6b): Tauri allowlist (86→88) + I24 docs + CHANGELOG"
```

---

## Task 15: Two-gateway preflight integration + janitor integration acceptance

**Files:**

- Test: `packages/gateway/src/federation/preflight-integration.test.ts` (new), `packages/gateway/src/federation/janitor-integration.test.ts` (new)

Mirror the Slice-2 two-gateway invoke integration test (real `LanServer` + real over-the-wire client between two in-process gateways; sandbox runner faked via the `preflight` ctx's `runCommand`).

- [ ] **Step 1: Write the preflight two-gateway test** — boot two `buildFederationLanServer` instances (peer up + peer down), pair them (reuse the Slice-1/2 pairing helper), grant the upstream peer on the downstream namespace, configure the downstream `preflight` ctx with `requestApproval: async () => true` + a fake `runCommand` returning `{passed:true,...}`, then call `fanOutPreflight` from the upstream and assert the aggregated `pass`. Add a second case: `requestApproval: async () => false` → upstream sees `declined`. **Reuse the exact two-gateway harness from `packages/gateway/test/` Slice-2 invoke integration** (find it via grep `answerFederatedInvoke` in `*integration*.test.ts`); copy its setup verbatim and swap the method.

- [ ] **Step 2: Write the janitor integration test** — two gateways; downstream indexes an `item` mentioning `i-12345` at a known `modified_at`; upstream calls `fanOutProbe`; assert `touched`/`lastSeenDaysAgo`. Second case: downstream offline → gap.

- [ ] **Step 3: Run both**

Run: `timeout 60 bun test packages/gateway/src/federation/preflight-integration.test.ts packages/gateway/src/federation/janitor-integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/federation/preflight-integration.test.ts packages/gateway/src/federation/janitor-integration.test.ts
git commit -m "test(phase6-slice6b): two-gateway preflight + janitor integration acceptances"
```

---

## Task 16: Preflight (full) + Docker coverage-floor + reseed

**Files:** none new (verification + baseline).

- [ ] **Step 1: Run the static audit + full gateway + cli suites + typecheck**

Run:

```bash
bun scripts/structure-audit/check-nimbus-invariants.ts all
cd packages/gateway && bunx tsc --noEmit && cd ../cli && bunx tsc --noEmit && cd ../..
timeout 600 bun test packages/gateway/src
timeout 120 bun test packages/cli/src
```

Expected: audit exit 0; tsc clean; suites green.

- [ ] **Step 2: `bun run preflight:fast`** — fix any biome/structure drift. (Validate biome via `bunx biome check packages scripts` — the worktree biome.json excludes `.claude/worktrees`, see [[biome-claude-worktree-lint-false-fail]].)

- [ ] **Step 3: lint:markdown** the spec/plan/review docs: `bunx markdownlint-cli2 --fix "docs/superpowers/specs/2026-06-11-phase6-slice6b-*.md" "docs/superpowers/plans/2026-06-11-phase6-slice6b-*.md"`.

- [ ] **Step 4: Docker Linux coverage-floor** — invoke the `nimbus-coverage-floor` agent (oven/bun:latest). Bring every new file to ≥ 80% branch + line. Expect the new files (preflight-gate, preflight-runner, resource-probe, peer-fanout arms, both agents, config) to need a few extra branch arms (error envelopes, gap paths, timeout, malformed input). NO `*-v*-sql.ts` this slice (no migration).

- [ ] **Step 5: Push + open PR.** Do NOT reseed the committed baseline from local Docker. Open the PR, let the merge-commit CI run, then reseed `coverage/lcov.info` from the PR's OWN `coverage-lcov-merged` artifact + `audit:coverage-floor:update-baseline` (the [[true-coverage-program-workstream]] reseed-from-PR-merge-lcov rule). Expect 1 red CI round (incidental sibling coverage + SonarCloud new-code duplication — fix-not-exclude; lean on the existing `_agent-brief-cli.ts` / `fanout-deps.ts` extraction helpers; extract a shared janitor/preflight CLI flag parser if Sonar flags duplication).

- [ ] **Step 6: Final commit (baseline reseed)** after CI artifact:

```bash
git add coverage/lcov.info
git commit -m "test(phase6-slice6b): reseed coverage baseline from PR merge lcov"
```

---

## Self-review checklist (run before execution)

- **Spec coverage:** janitor (T2-T6) · preflight gate/I24 (T7-T10) · preflight agent/CLI (T11-T13) · config (T1) · surfaces/docs (T14) · acceptance (T15) · coverage (T16). Q1 ref-validation (T2) · Q2 --allow-gaps (T5/T6) · Q3 exit-codes (T13) · Q4 paths-from-config (T1/T8) · S1 regexes (T2/T9) · S3 timeout+duration (T8). ✅ All spec sections mapped.
- **Type consistency:** `PreflightCommandConfig` (T1) used in T8/T9/T10 · `PreflightRunResult.durationMs` (T8) consumed in T9 audit · `PeerProbeResult`/`PeerPreflightResult` (T3/T11) consumed in T5/T12 · brief `kind` strings `"janitor"`/`"preflight"` consistent across findings/synthesize/render/CLI-types · `federation.preflight`/`federation.preflightRespond`/`federation.probe` method names consistent T4/T10/T11. ✅
- **Deferred (do NOT implement):** `nimbus preflight run-local` dry-run (S2); per-process CPU/mem accounting (S3); scheduled janitor sweeps; org-policy command allowlisting; janitor enqueuing executable pending actions; diff application. The flagship reserves `executor.ts`/`tool-output-envelope.ts` — untouched.
