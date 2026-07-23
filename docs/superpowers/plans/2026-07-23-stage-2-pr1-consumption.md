# Stage 2 PR 1 — Consume the Stage 1 client surface in nimbus-vscode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bump `@nimbus-dev/client` to `^0.11.0` and consume it: sessions via `sessionList()` (deleting the `querySql` hack), connector health in the status bar via `connectorListStatus()`, and a live `gatewayPing()` in the Troubleshoot report.

**Architecture:** All changes live in `nimbus-vscode` (repo `C:\gitrep\nimbus-vscode`). The extension's `activateWithDeps(ctx, deps)` is fully dependency-injected and tested through fake deps in `test/unit/extension.test.ts` (`makeFakeClient`). Pure logic goes in small modules (`src/status-bar/`, `src/connection/`) with their own unit tests; `extension.ts` only wires.

**Tech Stack:** TypeScript strict, esbuild bundle, vitest (run via `bunx vitest run`), Biome. Client: `@nimbus-dev/client` 0.11.0 (`sessionList(): Promise<{sessions: {sessionId; lastWriteAt; chunkCount}[]}>`, `connectorListStatus(): Promise<ConnectorSyncStatus[]>`, `gatewayPing(): Promise<{version; uptime; ...}>`).

## Global Constraints

- Repo: `C:\gitrep\nimbus-vscode`; branch `dev/asafgolombek/stage2-pr1-consume-011` in a worktree under `.claude/worktrees/`. Never commit on `main`.
- Fresh worktree ⇒ `bun install` FIRST (phantom type errors otherwise).
- `bun run lint` misreports in `.claude/worktrees` in the Nimbus repo; in nimbus-vscode `bunx biome check .` is the safe form.
- Full local gate set before the first push: `bun run typecheck && bunx biome check . && bun run test && bun run build && bun run check-bundle && bun run check-settings-docs`.
- No `any`; `exactOptionalPropertyTypes` is on (use conditional spreads, see `src/sidebar/agents.ts:56`).
- The user merges the PR; the agent opens it.

---

### Task 0: Worktree + dependency bump

**Files:**

- Modify: `package.json` (devDependencies)
- Modify: `bun.lock` (via `bun install`)

**Interfaces:**

- Produces: a workspace where `client.sessionList`, `client.connectorListStatus`, `client.gatewayPing` typecheck.

- [ ] **Step 1: Create the worktree and install**

```bash
cd /c/gitrep/nimbus-vscode
git worktree add .claude/worktrees/stage2-pr1 -b dev/asafgolombek/stage2-pr1-consume-011
cd .claude/worktrees/stage2-pr1
bun install
```

- [ ] **Step 2: Bump the client**

In `package.json` devDependencies change `"@nimbus-dev/client": "^0.6.0"` → `"^0.11.0"`, then:

```bash
bun install
bun run typecheck
```

Expected: typecheck PASS (0.11.0 is additive over 0.6.0).

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "build: bump @nimbus-dev/client to ^0.11.0 (Stage 1 surface)"
```

---

### Task 1: Sessions via `sessionList()` + querySql guard

**Files:**

- Modify: `src/extension.ts` (delete `SESSIONS_SQL` at :70-74, rewrite `loadSessions` at :436-453, drop the `parseSessionRow` import at :52)
- Modify: `src/sidebar/sessions.ts` (delete `parseSessionRow`; keep `SessionSummary`, `sessionToItem`)
- Modify: `test/unit/sessions.test.ts` (drop `parseSessionRow` describe-block)
- Modify: `test/unit/extension.test.ts:671-700` (fake `sessionList` instead of `querySql`)
- Create: `test/unit/no-raw-sql-guard.test.ts`

**Interfaces:**

- Consumes: `client.sessionList(): Promise<{ sessions: SessionListEntry[] }>` where `SessionListEntry` is structurally identical to the local `SessionSummary`.
- Produces: `loadSessions(): Promise<SessionSummary[]>` unchanged in signature — `createSessionsView` needs no change.

- [ ] **Step 1: Write the failing guard test**

`test/unit/no-raw-sql-guard.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Stage 1 exposed typed methods for what the extension used to reach via raw
// SQL. Guard the call shape (`querySql(`), not the bare identifier, so a
// leftover import alone cannot satisfy the test in reverse.
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("no raw-SQL client calls in src/", () => {
  test("querySql( appears nowhere in src/", () => {
    const offenders = listTsFiles(join(__dirname, "..", "..", "src")).filter((f) =>
      readFileSync(f, "utf8").includes("querySql("),
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bunx vitest run test/unit/no-raw-sql-guard.test.ts
```

Expected: FAIL — offenders contains `src/extension.ts` (the `client.querySql(SESSIONS_SQL)` call).

- [ ] **Step 3: Rewrite the two extension tests to the new surface**

In `test/unit/extension.test.ts` replace the `querySql` fakes (lines ~671-700):

```ts
test("the registered sessions provider lists sessions via sessionList", async () => {
  const sessionList = vi.fn(async () => ({
    sessions: [{ sessionId: "abc-123", lastWriteAt: 1_700_000_000_000, chunkCount: 3 }],
  }));
  const h = await activateConnected({
    openClient: makeFakeClient({ sessionList } as unknown as Partial<ClientLike>),
  });
  // ...same provider-lookup + getChildren assertions as the current test body,
  // asserting one row labelled "Session abc-123".slice-style short id...
  expect(sessionList).toHaveBeenCalled();
});

test("the sessions provider shows an error row when sessionList fails", async () => {
  const sessionList = vi.fn(async () => {
    throw new Error("boom");
  });
  // ...same error-row assertion as the current querySql-failure test...
  expect(sessionList).toHaveBeenCalled();
});
```

(Keep the existing surrounding harness code — only the faked method changes. Mirror the current test bodies exactly; they already assert the provider rows.)

- [ ] **Step 4: Implement**

`src/extension.ts` — delete the `SESSIONS_SQL` const (lines 70-74) and rewrite `loadSessions`:

```ts
const loadSessions = async (): Promise<SessionSummary[]> => {
  const client = nimbus();
  if (client === undefined) return [];
  try {
    const { sessions } = await client.sessionList();
    return sessions;
  } catch (e) {
    // e.g. an older Gateway without session.list. Log a trail, then rethrow
    // so the view renders its "Failed to load sessions" row.
    log.warn(`loadSessions sessionList failed: ${errMsg(e)}`);
    throw e;
  }
};
```

Update the import at :52 to `import type { SessionSummary } from "./sidebar/sessions.js";` and drop the now-stale comment block above `createSessionsView` (the "swap for a typed client.listSessions()" note — it happened).

`src/sidebar/sessions.ts` — delete `parseSessionRow` and its `asFiniteNumber, asRecord` import (keep `formatRelativeTime`); `test/unit/sessions.test.ts` — delete the `parseSessionRow` describe-block.

- [ ] **Step 5: Run the tests**

```bash
bunx vitest run test/unit/no-raw-sql-guard.test.ts test/unit/sessions.test.ts test/unit/extension.test.ts
bun run typecheck
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -u test/unit/no-raw-sql-guard.test.ts
git commit -m "feat(sessions): consume session.list; delete the querySql hack + guard"
```

---

### Task 2: Connector health in the status bar

**Files:**

- Create: `src/status-bar/connector-health.ts`
- Create: `test/unit/connector-health.test.ts`
- Modify: `src/extension.ts` (poll + feed `renderStatusBar`)
- Modify: `test/unit/extension.test.ts` (one new integration test)

**Interfaces:**

- Consumes: `client.connectorListStatus(): Promise<ConnectorSyncStatus[]>` (`status: "ok" | "syncing" | "paused" | "backoff" | "error"`, `enabled: boolean`, `serviceId: string`).
- Produces: `summarizeConnectorHealth(statuses: ConnectorSyncStatus[]): { count: number; names: string[] }` — degraded = `enabled && (status === "error" || status === "backoff")`, names sorted for deterministic rendering. Feeds the existing `StatusBarInputs.degradedConnectorCount/-Names` (`src/status-bar/status-bar-item.ts:7-8`), currently hardwired to `0`/`[]` at `src/extension.ts:211-212`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/connector-health.test.ts`:

```ts
import type { ConnectorSyncStatus } from "@nimbus-dev/client";
import { describe, expect, test } from "vitest";
import { summarizeConnectorHealth } from "../../src/status-bar/connector-health.js";

function status(over: Partial<ConnectorSyncStatus>): ConnectorSyncStatus {
  return {
    serviceId: "github",
    status: "ok",
    lastSyncAt: null,
    nextSyncAt: null,
    intervalMs: 60000,
    itemCount: 0,
    lastError: null,
    consecutiveFailures: 0,
    depth: "summary",
    enabled: true,
    ...over,
  };
}

describe("summarizeConnectorHealth", () => {
  test("error and backoff count as degraded, sorted by serviceId", () => {
    const r = summarizeConnectorHealth([
      status({ serviceId: "slack", status: "error" }),
      status({ serviceId: "github", status: "backoff" }),
      status({ serviceId: "jira", status: "ok" }),
    ]);
    expect(r).toEqual({ count: 2, names: ["github", "slack"] });
  });

  test("disabled connectors never count", () => {
    const r = summarizeConnectorHealth([status({ status: "error", enabled: false })]);
    expect(r).toEqual({ count: 0, names: [] });
  });

  test("paused and syncing are not degraded", () => {
    const r = summarizeConnectorHealth([
      status({ status: "paused" }),
      status({ serviceId: "gitlab", status: "syncing" }),
    ]);
    expect(r).toEqual({ count: 0, names: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bunx vitest run test/unit/connector-health.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper**

`src/status-bar/connector-health.ts`:

```ts
import type { ConnectorSyncStatus } from "@nimbus-dev/client";

// A connector is degraded when it is enabled but its scheduler has given up or
// is backing off. paused/syncing are user-intended or transient, not degraded.
export function summarizeConnectorHealth(statuses: readonly ConnectorSyncStatus[]): {
  count: number;
  names: string[];
} {
  const names = statuses
    .filter((s) => s.enabled && (s.status === "error" || s.status === "backoff"))
    .map((s) => s.serviceId)
    .sort();
  return { count: names.length, names };
}
```

- [ ] **Step 4: Run unit test to verify it passes**

```bash
bunx vitest run test/unit/connector-health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire the poll in `extension.ts` (test-first)**

Add to `test/unit/extension.test.ts`, next to the existing status-bar tests:

```ts
test("degraded connectors reach the status bar text", async () => {
  const connectorListStatus = vi.fn(async () => [
    // one enabled error connector — same literal shape as ConnectorSyncStatus
    {
      serviceId: "slack", status: "error", lastSyncAt: null, nextSyncAt: null,
      intervalMs: 60000, itemCount: 0, lastError: "401", consecutiveFailures: 3,
      depth: "summary", enabled: true,
    },
  ]);
  const h = await activateConnected({
    openClient: makeFakeClient({ connectorListStatus } as unknown as Partial<ClientLike>),
  });
  await flushAsync(); // however the file settles promises (see egress badge tests)
  expect(connectorListStatus).toHaveBeenCalled();
  expect(statusItemOf(h).text).toContain("1 degraded");
});
```

(Reuse the file's existing helpers for activation, promise settling, and reading the status item — mirror the egress-badge test immediately above it.)

Then in `src/extension.ts`, next to the egress poll (after line ~204):

```ts
let connectorHealth = { count: 0, names: [] as string[] };
let connectorPollSeq = 0;
const pollConnectorHealth = async (): Promise<void> => {
  const mine = ++connectorPollSeq;
  const client = nimbus();
  if (connection.current().kind !== "connected" || client === undefined) {
    connectorHealth = { count: 0, names: [] };
    return;
  }
  try {
    const statuses = await client.connectorListStatus();
    if (mine !== connectorPollSeq) return;
    connectorHealth = summarizeConnectorHealth(statuses);
  } catch (e) {
    if (mine !== connectorPollSeq) return;
    log.warn(`connectorListStatus poll failed: ${errMsg(e)}`);
    connectorHealth = { count: 0, names: [] };
  }
  statusBar.update(currentStatusInputs());
};
```

Refactor `renderStatusBar` so both paths share one input builder:

```ts
const currentStatusInputs = (): StatusBarInputs => ({
  connection: connection.current(),
  profile: "",
  degradedConnectorCount: connectorHealth.count,
  degradedConnectorNames: connectorHealth.names,
  pendingHitlCount,
  autoStartGateway: settings.autoStartGateway(),
});
const renderStatusBar = (_s: ConnectionState): void => {
  statusBar.update(currentStatusInputs());
  void pollEgressBadge();
  void pollConnectorHealth();
};
```

(`StatusBarInputs` is exported from `src/status-bar/status-bar-item.ts`; import it as a type. `renderStatusBar` keeps its `(s)` parameter shape at call sites — use `connection.current()` internally.) Add `void pollConnectorHealth()` inside the existing `setInterval` callback alongside `pollEgressBadge` (both intervals: initial call at :204 and the `statusBarPollMs` re-create at :416).

- [ ] **Step 6: Run tests**

```bash
bunx vitest run test/unit/connector-health.test.ts test/unit/extension.test.ts test/unit/status-bar.test.ts
bun run typecheck
```

Expected: PASS (also run `test/unit/status-bar-item.test.ts` if that is the actual filename — check `ls test/unit | grep status`).

- [ ] **Step 7: Commit**

```bash
git add -u src/status-bar/connector-health.ts test/unit/connector-health.test.ts
git commit -m "feat(status-bar): live degraded-connector count via connector.listStatus"
```

---

### Task 3: `gatewayPing` in the Troubleshoot report

**Files:**

- Modify: `src/connection/troubleshooter.ts` (optional `ping` input, connected-state message)
- Modify: `test/unit/troubleshooter.test.ts` (confirm exact name with `ls test/unit | grep trouble`)
- Modify: `src/extension.ts:828-846` (`nimbus.troubleshootConnection` handler)

**Interfaces:**

- Consumes: `client.gatewayPing(): Promise<{ version: string; uptime: number }>` (extra fields ignored).
- Produces: `buildTroubleshooter(state, opts)` where `opts` gains `ping?: { ok: true; version: string; uptime: number } | { ok: false; error: string }`. Absent `ping` keeps today's exact output (all existing tests must pass unmodified).

- [ ] **Step 1: Write the failing tests**

Add to the troubleshooter test file:

```ts
const CONNECTED = { kind: "connected", socketPath: "/tmp/nimbus.sock" } as const;
const BASE = { autoStartGateway: false, platform: "linux" as NodeJS.Platform };

test("connected + ping ok reports gateway version and uptime", () => {
  const r = buildTroubleshooter(CONNECTED, {
    ...BASE,
    ping: { ok: true, version: "0.24.0", uptime: 5 * 60_000 },
  });
  expect(r.level).toBe("info");
  expect(r.message).toContain("v0.24.0");
  expect(r.message).toContain("5 min");
});

test("connected + ping failure warns: socket up, gateway unresponsive", () => {
  const r = buildTroubleshooter(CONNECTED, {
    ...BASE,
    ping: { ok: false, error: "timeout" },
  });
  expect(r.level).toBe("warn");
  expect(r.message).toContain("not responding");
  expect(r.message).toContain("timeout");
  expect(r.actions.map((a) => a.label)).toContain("Reconnect Now");
});

test("connected without ping input keeps the legacy message", () => {
  const r = buildTroubleshooter(CONNECTED, BASE);
  expect(r.message).toBe("Connected to the Gateway at /tmp/nimbus.sock.");
});
```

- [ ] **Step 2: Run to verify the two new tests fail**

```bash
bunx vitest run test/unit/troubleshooter.test.ts
```

Expected: 2 FAIL (unknown `ping` option / unchanged message), legacy test PASS.

- [ ] **Step 3: Implement**

In `src/connection/troubleshooter.ts`:

```ts
export type PingOutcome =
  | { ok: true; version: string; uptime: number }
  | { ok: false; error: string };

export function buildTroubleshooter(
  state: ConnectionState,
  opts: { autoStartGateway: boolean; platform: NodeJS.Platform; ping?: PingOutcome },
): TroubleshootReport {
  switch (state.kind) {
    case "connected": {
      const ping = opts.ping;
      if (ping !== undefined && !ping.ok) {
        return {
          level: "warn",
          message: `Socket ${state.socketPath} is connected, but the Gateway is not responding to ping: ${ping.error}.`,
          actions: [RECONNECT, OPEN_LOGS],
        };
      }
      if (ping !== undefined) {
        const min = Math.round(ping.uptime / 60_000);
        return {
          level: "info",
          message: `Connected to the Gateway at ${state.socketPath} — v${ping.version}, up ${min} min.`,
          actions: [OPEN_LOGS],
        };
      }
      return {
        level: "info",
        message: `Connected to the Gateway at ${state.socketPath}.`,
        actions: [OPEN_LOGS],
      };
    }
    // ...remaining cases unchanged...
  }
}
```

In `src/extension.ts` `nimbus.troubleshootConnection` (:828), before `buildTroubleshooter`:

```ts
const state = connection.current();
let ping: PingOutcome | undefined;
const client = nimbus();
if (state.kind === "connected" && client !== undefined) {
  try {
    const p = await client.gatewayPing();
    ping = { ok: true, version: p.version, uptime: p.uptime };
  } catch (e) {
    ping = { ok: false, error: errMsg(e) };
  }
}
const report = buildTroubleshooter(state, {
  autoStartGateway: settings.autoStartGateway(),
  platform: process.platform,
  ...(ping !== undefined ? { ping } : {}),
});
```

(Import `PingOutcome` as a type. The conditional spread keeps `exactOptionalPropertyTypes` happy.)

- [ ] **Step 4: Run tests**

```bash
bunx vitest run test/unit/troubleshooter.test.ts test/unit/extension.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(troubleshoot): live gateway.ping health in the connection report"
```

---

### Task 4: Full gates, push, PR

**Files:** none (verification only)

- [ ] **Step 1: Full local gate set**

```bash
bun run typecheck && bunx biome check . && bun run test && bun run build && bun run check-bundle && bun run check-settings-docs
```

Expected: every gate PASS. Fix locally before any push — never push-and-see.

- [ ] **Step 2: Whole-branch review**

```bash
git log --oneline main..HEAD
git diff main...HEAD --stat
```

Confirm: 4-5 commits, no stray files (never `git add -A`), no `settings.local.json`.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin dev/asafgolombek/stage2-pr1-consume-011
gh pr create --repo nimbus-agent/nimbus-vscode --title "feat: consume the Stage 1 client surface (client ^0.11.0)" --body "..."
```

PR body covers: the ^0.6.0 caret pin meant zero Stage 1 methods were visible; sessions now use \`session.list\` (querySql hack deleted + guard test); status bar shows live degraded-connector state via \`connector.listStatus\` (making the \`statusBarPollMs\` description true); Troubleshoot includes a live \`gateway.ping\`. Reference the ecosystem roadmap Stage 2 and the spec. End with the 🤖 Generated-with-Claude-Code footer. The user merges.
