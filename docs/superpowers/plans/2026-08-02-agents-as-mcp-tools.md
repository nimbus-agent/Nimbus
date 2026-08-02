# Agents as MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Nimbus's built-in read-only agents as MCP tools on the existing `nimbus mcp-server`, recorded in the egress ledger, plus an MIT launcher package that makes the server installable as an artifact.

**Architecture:** Ten async agents plus the synchronous `whyPeek` are registered as tools in the existing `TOOL_SPECS` array in the CLI's MCP adapter. Correctness prerequisites land first: a brief router that correlates `briefReady` notifications by `sessionId` (today they are broadcast and matched by agent name alone), and a per-connection client-kind declaration so the gateway can tell an MCP-originated agent call from a CLI one. Every MCP-originated agent invocation appends one `egress_ledger` row before the brief is returned, fail-closed, through a new chokepoint confined by an extended `D22` static rule.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:test`, Biome, `@modelcontextprotocol/sdk`, zod, `bun:sqlite`, BLAKE3 via `@noble/hashes`.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Platform equality.** Windows/macOS/Linux equally supported. Build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Licence split.** `packages/cli` and `packages/gateway` are AGPL-3.0. The launcher package (Task 7) is MIT and **must not import from either.**
- **Invariant triple rule.** Any change to a structural defence lands wiring + `docs/SECURITY-INVARIANTS.md` entry + enforcement test **in the same commit**. Never leave drift.
- **Read-only surface.** No tool added here may reach a HITL-gated action. `agents.preflight` is excluded by design.
- **Dependency injection over `mock.module`.** `mock.module` contaminates the combined `bun test packages/cli/src` run on CI Linux. Every seam in this plan is a parameter or an interface.
- **Before pushing:** `bun run preflight:fast`. Never `git add -A` — `settings.local.json` is tracked.
- **Commits:** conventional-commit prefixes. Commit messages are discarded on squash-merge; the PR title and body become the commit.

## Known unknown, resolve in Task 1

`@nimbus-dev/client` is **not installed** in this checkout (`node_modules/@nimbus-dev/` contains only `sdk`). Whether `IPCClient` exposes handler removal (`offNotification` or similar) is therefore unverified. **The design in Task 1 deliberately does not require it:** the router binds at most one listener per agent-notification name for the client's lifetime, so handler count is bounded by the agent count (24 total), not by invocation count. If an unsubscribe API does turn out to exist, it is an optimisation, not a correction. Run `bun install` before starting.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/cli/src/lib/agent-brief-router.ts` | **Create.** Correlates `briefReady`/`briefError` notifications to waiters by `sessionId`; one listener pair per agent name. |
| `packages/cli/src/lib/agent-brief-render.ts` | **Modify.** `awaitAgentBrief` becomes a thin wrapper over the router; `renderAgentBrief` unchanged. |
| `packages/cli/src/lib/agent-cli-dispatcher.ts` | **Modify.** Bind the session id returned by the `agents.*` call. |
| `packages/gateway/src/ipc/server/client-kind.ts` | **Create.** Per-connection client-kind store; `session.declareKind` handling. |
| `packages/gateway/src/ipc/server/context.ts` | **Modify.** Expose `getClientKind` on `ServerCtx`. |
| `packages/gateway/src/ipc/server/dispatchers.ts` | **Modify.** Thread `clientId` + kind into the agents dispatch. |
| `packages/gateway/src/ipc/agents-rpc.ts` | **Modify.** `AgentsRpcContext` gains caller fields; the single egress chokepoint call. |
| `packages/gateway/src/egress/mcp-brief-egress.ts` | **Create.** Builds and appends the MCP egress row. Lives in `egress/` so `D22(b)` is satisfied structurally. |
| `scripts/structure-audit/check-nimbus-invariants.ts` | **Modify.** New `D22(c)` rule confining the new chokepoint's caller. |
| `docs/SECURITY-INVARIANTS.md` | **Modify.** `I29` section records the second append path. |
| `packages/cli/src/mcp/errors.ts` | **Create.** `GATEWAY_DOWN_MESSAGE`, `GatewayUnavailableError`, `isDisconnectError`, moved out of `adapter.ts` so the agent tools can use them without a cycle. |
| `packages/cli/src/mcp/agent-tools.ts` | **Create.** The ten async agent tool specs and the brief-awaiting glue. |
| `packages/cli/src/mcp/adapter.ts` | **Modify.** Registers `peekWhy`, spreads in the agent specs, declares the client kind, wires transport-death rejection. |
| `packages/mcp-launcher/` | **Create.** MIT launcher package. |

---

### Task 1: Brief router — correlate briefs by session

**Files:**

- Create: `packages/cli/src/lib/agent-brief-router.ts`
- Create: `packages/cli/src/lib/agent-brief-router.test.ts`
- Modify: `packages/cli/src/lib/agent-brief-render.ts`
- Modify: `packages/cli/src/lib/agent-cli-dispatcher.ts:39-43`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `AgentBriefRouter` class with `expect(agentName, guard, timeoutMs): PendingBrief<T>`; `PendingBrief<T>` with `result: Promise<{brief: string; findings: T}>`, `bindSession(sessionId: string): void`, `fail(err: Error): void`, `cancel(): void`. Task 6 consumes all of these.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/lib/agent-brief-router.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { AgentBriefRouter, type BriefNotificationSource } from "./agent-brief-router.ts";

type Handler = (params: unknown) => void;

/** Fake notification source: records handlers and lets a test emit to them. */
function fakeSource(): BriefNotificationSource & {
  emit(method: string, params: unknown): void;
  handlerCount(): number;
} {
  const handlers = new Map<string, Handler[]>();
  return {
    onNotification(method: string, handler: Handler): void {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
    },
    emit(method: string, params: unknown): void {
      for (const h of handlers.get(method) ?? []) h(params);
    },
    handlerCount(): number {
      let n = 0;
      for (const list of handlers.values()) n += list.length;
      return n;
    },
  };
}

const anyFindings = (x: unknown): x is { gaps: [] } => typeof x === "object" && x !== null;

test("concurrent callers each receive their own brief", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);

  const a = router.expect("why", anyFindings, 1000);
  const b = router.expect("why", anyFindings, 1000);
  a.bindSession("session-a");
  b.bindSession("session-b");

  src.emit("why.briefReady", { sessionId: "session-b", brief: "B", findings: { gaps: [] } });
  src.emit("why.briefReady", { sessionId: "session-a", brief: "A", findings: { gaps: [] } });

  expect((await a.result).brief).toBe("A");
  expect((await b.result).brief).toBe("B");
});

test("a notification arriving before bindSession is buffered, not lost", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("impact", anyFindings, 1000);

  src.emit("impact.briefReady", { sessionId: "s1", brief: "early", findings: { gaps: [] } });
  p.bindSession("s1");

  expect((await p.result).brief).toBe("early");
});

test("listener count is bounded by agent name, not by invocation count", () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  for (let i = 0; i < 50; i++) router.expect("why", anyFindings, 1000).cancel();
  // one briefReady + one briefError listener for the single agent name
  expect(src.handlerCount()).toBe(2);
});

test("briefError rejects the matching waiter only", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const a = router.expect("why", anyFindings, 1000);
  const b = router.expect("why", anyFindings, 1000);
  a.bindSession("s-a");
  b.bindSession("s-b");

  src.emit("why.briefError", { sessionId: "s-a", error: "boom" });
  src.emit("why.briefReady", { sessionId: "s-b", brief: "ok", findings: { gaps: [] } });

  await expect(a.result).rejects.toThrow("boom");
  expect((await b.result).brief).toBe("ok");
});

test("fail() rejects a pending waiter with the given error", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("why", anyFindings, 1000);
  p.bindSession("s1");
  p.fail(new Error("IPC connection closed"));
  await expect(p.result).rejects.toThrow("IPC connection closed");
});

test("timeout rejects and clears the waiter", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("why", anyFindings, 5);
  p.bindSession("s1");
  await expect(p.result).rejects.toThrow("timed out");
});

test("a buffered notification is dropped once nothing is waiting for that agent", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const p = router.expect("why", anyFindings, 5);
  // The agents.* call failed, so bindSession is never reached — but the gateway already emitted.
  src.emit("why.briefReady", { sessionId: "orphan", brief: "x", findings: { gaps: [] } });
  await expect(p.result).rejects.toThrow("timed out");

  // A later waiter for the same agent must not inherit the orphan's envelope.
  const q = router.expect("why", anyFindings, 1000);
  q.bindSession("orphan");
  await expect(Promise.race([q.result, new Promise((r) => setTimeout(() => r("pending"), 20))])).resolves.toBe(
    "pending",
  );
  q.cancel();
});

test("failAll rejects every in-flight waiter — the transport-death path", async () => {
  const src = fakeSource();
  const router = new AgentBriefRouter(src);
  const a = router.expect("why", anyFindings, 30_000);
  const b = router.expect("impact", anyFindings, 30_000);
  a.bindSession("s-a");
  b.bindSession("s-b");

  router.failAll(new Error("IPC connection closed"));

  await expect(a.result).rejects.toThrow("IPC connection closed");
  await expect(b.result).rejects.toThrow("IPC connection closed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/lib/agent-brief-router.test.ts`
Expected: FAIL — `Cannot find module './agent-brief-router.ts'`

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/lib/agent-brief-router.ts`:

```typescript
/** Minimal surface the router needs — structurally satisfied by IPCClient. */
export interface BriefNotificationSource {
  onNotification(method: string, handler: (params: unknown) => void): void;
}

export interface PendingBrief<T> {
  readonly result: Promise<{ brief: string; findings: T }>;
  /** Bind the sessionId returned by the `agents.*` call. Replays any buffered notification. */
  bindSession(sessionId: string): void;
  /** Reject this waiter (e.g. transport death observed by the owner). Idempotent. */
  fail(err: Error): void;
  /** Drop this waiter without settling its promise's consumers further. Idempotent. */
  cancel(): void;
}

interface Waiter {
  readonly agentName: string;
  readonly guard: ((x: unknown) => boolean) | undefined;
  readonly settle: (outcome: { brief: string; findings: unknown } | Error) => void;
  sessionId: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  done: boolean;
}

interface BriefEnvelope {
  sessionId?: unknown;
  brief?: unknown;
  findings?: unknown;
  error?: unknown;
}

/** Cap on notifications held for a not-yet-bound waiter, so a misbehaving gateway cannot grow memory. */
const MAX_BUFFERED_PER_AGENT = 32;

/**
 * Routes `<agent>.briefReady` / `<agent>.briefError` notifications to the waiter that started
 * them, keyed by sessionId.
 *
 * Two properties the previous implementation lacked:
 *  - notifications are matched by sessionId, not merely by agent name, so concurrent callers
 *    cannot receive each other's briefs;
 *  - at most one listener pair is registered per agent name for the source's lifetime, so a
 *    long-lived server does not accumulate a handler per invocation.
 */
export class AgentBriefRouter {
  private readonly bound = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  private readonly buffered = new Map<string, BriefEnvelope[]>();

  constructor(private readonly source: BriefNotificationSource) {}

  expect<T>(
    agentName: string,
    guard: ((x: unknown) => x is T) | undefined,
    timeoutMs: number,
  ): PendingBrief<T> {
    this.bindListeners(agentName);

    let settleFn: (outcome: { brief: string; findings: unknown } | Error) => void = () => {};
    const result = new Promise<{ brief: string; findings: T }>((resolve, reject) => {
      settleFn = (outcome): void => {
        if (outcome instanceof Error) reject(outcome);
        else resolve({ brief: outcome.brief, findings: outcome.findings as T });
      };
    });

    const waiter: Waiter = {
      agentName,
      guard,
      settle: settleFn,
      sessionId: undefined,
      timer: undefined,
      done: false,
    };
    waiter.timer = setTimeout(() => {
      this.finish(waiter, new Error(`Agent timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    this.waiters.add(waiter);

    return {
      result,
      bindSession: (sessionId: string): void => {
        if (waiter.done) return;
        waiter.sessionId = sessionId;
        this.drainBuffered(waiter);
      },
      fail: (err: Error): void => {
        this.finish(waiter, err);
      },
      cancel: (): void => {
        this.finish(waiter, undefined);
      },
    };
  }

  /**
   * Reject every in-flight waiter. Called when the owner observes transport death: the awaited
   * notification can never arrive, so waiting out the timeout only delays a knowable answer and
   * reports it under the wrong error.
   */
  failAll(err: Error): void {
    for (const w of [...this.waiters]) this.finish(w, err);
    this.buffered.clear();
  }

  private bindListeners(agentName: string): void {
    if (this.bound.has(agentName)) return;
    this.bound.add(agentName);
    this.source.onNotification(`${agentName}.briefReady`, (params: unknown) => {
      this.route(agentName, params as BriefEnvelope);
    });
    this.source.onNotification(`${agentName}.briefError`, (params: unknown) => {
      this.route(agentName, params as BriefEnvelope);
    });
  }

  private route(agentName: string, env: BriefEnvelope): void {
    const sessionId = typeof env.sessionId === "string" ? env.sessionId : undefined;
    for (const w of this.waiters) {
      if (w.agentName === agentName && w.sessionId !== undefined && w.sessionId === sessionId) {
        this.apply(w, env);
        return;
      }
    }
    // No bound waiter yet — buffer for a waiter that has not learned its sessionId.
    const list = this.buffered.get(agentName) ?? [];
    if (list.length >= MAX_BUFFERED_PER_AGENT) list.shift();
    list.push(env);
    this.buffered.set(agentName, list);
  }

  private drainBuffered(waiter: Waiter): void {
    const list = this.buffered.get(waiter.agentName);
    if (list === undefined) return;
    const idx = list.findIndex((e) => e.sessionId === waiter.sessionId);
    if (idx === -1) return;
    const [env] = list.splice(idx, 1);
    if (env !== undefined) this.apply(waiter, env);
  }

  private apply(waiter: Waiter, env: BriefEnvelope): void {
    if (typeof env.error === "string") {
      this.finish(waiter, new Error(env.error));
      return;
    }
    if (typeof env.brief !== "string" || (waiter.guard !== undefined && !waiter.guard(env.findings))) {
      this.finish(waiter, new Error(`Malformed ${waiter.agentName}.briefReady payload`));
      return;
    }
    this.finish(waiter, { brief: env.brief, findings: env.findings });
  }

  private finish(
    waiter: Waiter,
    outcome: { brief: string; findings: unknown } | Error | undefined,
  ): void {
    if (waiter.done) return;
    waiter.done = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    this.waiters.delete(waiter);

    // Drop this agent's buffer once nothing is waiting on it. A waiter whose `agents.*` call failed
    // before returning a sessionId never binds, so its envelope would otherwise sit until 32 more
    // pushed it out. Hygiene rather than correctness: matching is by exact sessionId, so a stale
    // envelope can never be delivered to the wrong waiter — it can only occupy space.
    let stillWaiting = false;
    for (const w of this.waiters) {
      if (w.agentName === waiter.agentName) {
        stillWaiting = true;
        break;
      }
    }
    if (!stillWaiting) this.buffered.delete(waiter.agentName);

    if (outcome !== undefined) waiter.settle(outcome);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/lib/agent-brief-router.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Rewrite `awaitAgentBrief` over the router**

Replace the `awaitAgentBrief` function in `packages/cli/src/lib/agent-brief-render.ts` (keep `renderAgentBrief` exactly as it is):

```typescript
import { AgentBriefRouter, type BriefNotificationSource, type PendingBrief } from "./agent-brief-router.ts";

const TIMEOUT_MS = 30_000;

/** One router per client, so listeners are registered once per agent name per connection. */
const routers = new WeakMap<object, AgentBriefRouter>();

function routerFor(client: BriefNotificationSource): AgentBriefRouter {
  const existing = routers.get(client as object);
  if (existing !== undefined) return existing;
  const created = new AgentBriefRouter(client);
  routers.set(client as object, created);
  return created;
}

/**
 * Start awaiting an agent brief. The caller MUST call `bindSession` with the sessionId returned
 * by the `agents.*` call — notifications are broadcast to every session, so without it a
 * concurrent caller's brief can be mistaken for this one.
 */
export function awaitAgentBrief<T>(
  client: BriefNotificationSource,
  agentName: string,
  guard: (x: unknown) => x is T,
  timeoutMs: number = TIMEOUT_MS,
): PendingBrief<T> {
  return routerFor(client).expect(agentName, guard, timeoutMs);
}
```

- [ ] **Step 6: Update the CLI dispatcher to bind the session**

In `packages/cli/src/lib/agent-cli-dispatcher.ts`, replace the body between `registerInteractiveCliIpcHandlers(client);` and `renderAgentBrief(...)`, and drop the now-unused `timeout` variable and its `finally` clause:

```typescript
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    pending = awaitAgentBrief(client, opts.agentName, opts.guard);
    const { sessionId } = await client.call<{ sessionId: string }>(
      opts.ipcMethod,
      opts.callParams,
    );
    pending.bindSession(sessionId);
    const { brief, findings } = await pending.result;
    renderAgentBrief(brief, findings, opts.json);
```

Declare `let pending: PendingBrief<B> | undefined;` beside the `client` declaration, and replace the `finally` body with:

```typescript
  } finally {
    pending?.cancel();
    await client.disconnect();
  }
```

Add `PendingBrief` to the import from `./agent-brief-render.ts`.

- [ ] **Step 7: Run the CLI agent tests**

Run: `bun test packages/cli/src/lib/`
Expected: PASS. If `agent-brief-render.test.ts` asserts the old four-argument signature, update those assertions to the new shape — the behaviour they cover (resolve, reject, malformed payload) is preserved.

- [ ] **Step 8: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/lib/agent-brief-router.ts packages/cli/src/lib/agent-brief-router.test.ts packages/cli/src/lib/agent-brief-render.ts packages/cli/src/lib/agent-cli-dispatcher.ts
git commit -m "fix(cli): correlate agent briefs by sessionId"
```

---

### Task 2: Per-connection client kind

**Files:**

- Create: `packages/gateway/src/ipc/server/client-kind.ts`
- Create: `packages/gateway/src/ipc/server/client-kind.test.ts`
- Modify: `packages/gateway/src/ipc/server/context.ts:7-15`

**Interfaces:**

- Consumes: nothing.
- Produces: `ClientKindStore` with `declare(clientId: string, kind: unknown): ClientKind`, `get(clientId: string): ClientKind`, `forget(clientId: string): void`; type `ClientKind = "cli" | "mcp" | "ui" | "unknown"`. Task 3 consumes `get`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ipc/server/client-kind.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { ClientKindStore } from "./client-kind.ts";

test("an undeclared connection is unknown", () => {
  const s = new ClientKindStore();
  expect(s.get("c1")).toBe("unknown");
});

test("declare records a recognised kind", () => {
  const s = new ClientKindStore();
  expect(s.declare("c1", "mcp")).toBe("mcp");
  expect(s.get("c1")).toBe("mcp");
});

test("an unrecognised kind is stored as unknown, never trusted verbatim", () => {
  const s = new ClientKindStore();
  expect(s.declare("c1", "totally-made-up")).toBe("unknown");
  expect(s.get("c1")).toBe("unknown");
});

test("a non-string kind is rejected without throwing", () => {
  const s = new ClientKindStore();
  expect(s.declare("c1", { kind: "mcp" })).toBe("unknown");
});

test("kind is immutable for the connection's lifetime", () => {
  const s = new ClientKindStore();
  s.declare("c1", "cli");
  expect(s.declare("c1", "mcp")).toBe("cli");
  expect(s.get("c1")).toBe("cli");
});

test("forget clears the connection", () => {
  const s = new ClientKindStore();
  s.declare("c1", "mcp");
  s.forget("c1");
  expect(s.get("c1")).toBe("unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/server/client-kind.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/ipc/server/client-kind.ts`:

```typescript
/**
 * What kind of client owns a connection. Declared once at connect time and immutable for the
 * connection's lifetime — a per-call field would be caller-supplied on every invocation, whereas
 * this is server-held after the handshake (the property I23 relies on for reply targets).
 *
 * This is an honesty-of-record mechanism, not an authorization one: every client on this socket is
 * a local process the owner started, and anyone who can open the socket can already call anything.
 */
export type ClientKind = "cli" | "mcp" | "ui" | "unknown";

const RECOGNISED: ReadonlySet<string> = new Set(["cli", "mcp", "ui"]);

export class ClientKindStore {
  private readonly kinds = new Map<string, ClientKind>();

  /** Record the kind for a connection. First declaration wins; returns the effective kind. */
  declare(clientId: string, kind: unknown): ClientKind {
    const existing = this.kinds.get(clientId);
    if (existing !== undefined) return existing;
    const resolved: ClientKind =
      typeof kind === "string" && RECOGNISED.has(kind) ? (kind as ClientKind) : "unknown";
    this.kinds.set(clientId, resolved);
    return resolved;
  }

  get(clientId: string): ClientKind {
    return this.kinds.get(clientId) ?? "unknown";
  }

  forget(clientId: string): void {
    this.kinds.delete(clientId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/server/client-kind.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Expose it on `ServerCtx`**

In `packages/gateway/src/ipc/server/context.ts`, add to the `ServerCtx` interface (after `getWorkflowRunHandler`):

```typescript
  getClientKind(clientId: string): ClientKind;
```

Add the import at the top of the file:

```typescript
import type { ClientKind } from "./client-kind.ts";
```

- [ ] **Step 6: Wire the store into the server**

In `packages/gateway/src/ipc/server/server.ts`:

1. Import the store: `import { ClientKindStore } from "./client-kind.ts";`
2. Construct one instance beside the `sessions` map: `const clientKinds = new ClientKindStore();`
3. Add `getClientKind: (clientId: string) => clientKinds.get(clientId),` to the object that satisfies `ServerCtx` (the same literal that already carries `broadcastNotification`).
4. In the disconnect path that already calls `sessions.delete(...)`, add `clientKinds.forget(cid);`
5. In `dispatchMethod`, before the existing dispatch chain, handle the declaration method:

```typescript
    if (method === "session.declareKind") {
      const p = params as { kind?: unknown } | undefined;
      return { kind: clientKinds.declare(clientId, p?.kind) };
    }
```

- [ ] **Step 7: Run the server test suite**

Run: `bun test packages/gateway/src/ipc/server/`
Expected: PASS. Any test constructing a `ServerCtx` literal will fail to typecheck until it gains `getClientKind`; add `getClientKind: () => "unknown"` to those fixtures.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/ipc/server/client-kind.ts packages/gateway/src/ipc/server/client-kind.test.ts packages/gateway/src/ipc/server/context.ts packages/gateway/src/ipc/server/server.ts
git commit -m "feat(gateway): record a per-connection client kind"
```

---

### Task 3: Thread the caller into the agents dispatch

**Files:**

- Modify: `packages/gateway/src/ipc/server/dispatchers.ts:119-142` (`tryDispatchAgentsRpc`), `:1027-1040` (`dispatchPhase4CoreGroup`), `:1112-1125` (`tryDispatchPhase4Rpc`)
- Modify: `packages/gateway/src/ipc/agents-rpc.ts:37-45` (`AgentsRpcContext`)
- Modify: `packages/gateway/src/ipc/agents-rpc.test.ts`

**Interfaces:**

- Consumes: `ClientKind`, `ServerCtx.getClientKind` from Task 2.
- Produces: `AgentsRpcContext` gains `caller?: { clientId: string; kind: ClientKind }`. Task 4 consumes `ctx.caller`.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/ipc/agents-rpc.test.ts`:

```typescript
test("dispatchAgentsRpc accepts and retains a caller descriptor", async () => {
  const db = freshDb();
  const seen: unknown[] = [];
  const ctx = {
    ...makeCtx(db),
    caller: { clientId: "c1", kind: "mcp" as const },
    notify: (m: string, p: unknown) => {
      seen.push({ m, p });
    },
  };
  const out = await dispatchAgentsRpc("agents.expert", { topicOrFile: "x" }, ctx);
  expect(out.kind).toBe("hit");
  expect(ctx.caller.kind).toBe("mcp");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts -t "caller descriptor"`
Expected: FAIL — `Object literal may only specify known properties, and 'caller' does not exist in type 'AgentsRpcContext'`.

- [ ] **Step 3: Extend `AgentsRpcContext`**

In `packages/gateway/src/ipc/agents-rpc.ts`, add the import and the field:

```typescript
import type { ClientKind } from "./server/client-kind.ts";
```

```typescript
export type AgentsRpcContext = {
  db: Database;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  configDir?: string;
  index?: LocalIndex;
  selfIdentity?: BoxKeypair;
  sendOverWire?: typeof sendFederatedOverWire;
  /** Who is calling. Server-derived; absent in unit tests and non-socket callers. */
  caller?: { clientId: string; kind: ClientKind };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts -t "caller descriptor"`
Expected: PASS.

- [ ] **Step 5: Thread `clientId` down the dispatch chain**

In `packages/gateway/src/ipc/server/dispatchers.ts`:

**(a)** `tryDispatchAgentsRpc` gains a fourth parameter and passes the caller through:

```typescript
export async function tryDispatchAgentsRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("agents.") || ctx.options.localIndex === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchAgentsRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
      index: ctx.options.localIndex,
      ...(ctx.options.federationIdentity === undefined
        ? {}
        : { selfIdentity: ctx.options.federationIdentity }),
      caller: { clientId, kind: ctx.getClientKind(clientId) },
    });
    if (out.kind === "hit") return out.value;
```

(The remainder of the function is unchanged.)

**(b)** `dispatchPhase4CoreGroup` gains `clientId: string` as a fourth parameter and forwards it:

```typescript
  const agentsOutcome = await tryDispatchAgentsRpc(ctx, method, params, clientId);
```

**(c)** `tryDispatchPhase4Rpc` passes it in — it already receives `clientId`:

```typescript
  const coreOutcome = await dispatchPhase4CoreGroup(ctx, method, params, clientId);
```

- [ ] **Step 6: Run the dispatcher tests**

Run: `bun test packages/gateway/src/ipc/`
Expected: PASS. Fix any `tryDispatchAgentsRpc` / `dispatchPhase4CoreGroup` call in a test that now misses its fourth argument by passing `"test-client"`.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.test.ts packages/gateway/src/ipc/server/dispatchers.ts
git commit -m "feat(gateway): thread the calling client into the agents dispatch"
```

---

### Task 4: MCP egress chokepoint (the invariant triple)

**Files:**

- Create: `packages/gateway/src/egress/mcp-brief-egress.ts`
- Create: `packages/gateway/src/egress/mcp-brief-egress.test.ts`
- Modify: `packages/gateway/src/ipc/agents-rpc.ts:542-560` (`dispatchAgentsRpc`)
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts:590-625`
- Modify: `docs/SECURITY-INVARIANTS.md` (the `I29` section)
- Modify: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Consumes: `AgentsRpcContext.caller` (Task 3); `appendEgressEntry`, `EgressEntry`, `redactEgressSummary` (existing, `egress/`).
- Produces: `recordMcpBriefEgress(db: Database, args: { method: string; params: unknown; clientId: string; now: number }): void`. Called from exactly one site, enforced by `D22(c)`.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/egress/mcp-brief-egress.test.ts`:

```typescript
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { recordMcpBriefEgress } from "./mcp-brief-egress.ts";

function ledgerDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE egress_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    destination TEXT NOT NULL,
    method TEXT NOT NULL,
    payload_summary TEXT NOT NULL,
    hitl_status TEXT NOT NULL,
    result_status TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL
  )`);
  return db;
}

test("appends exactly one row with source_type 'mcp'", () => {
  const db = ledgerDb();
  recordMcpBriefEgress(db, {
    method: "agents.why",
    params: { fileOrPrUrl: "src/a.ts" },
    clientId: "c1",
    now: 1000,
  });
  const rows = db.query(`SELECT source_type, method, destination, source_id FROM egress_ledger`).all() as Array<{
    source_type: string;
    method: string;
    destination: string;
    source_id: string | null;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.source_type).toBe("mcp");
  expect(rows[0]?.method).toBe("agents.why");
  expect(rows[0]?.destination).toBe("mcp");
  expect(rows[0]?.source_id).toBe("c1");
  db.close();
});

test("federation-touching agents record a distinguishable destination", () => {
  const db = ledgerDb();
  recordMcpBriefEgress(db, { method: "agents.ghost", params: {}, clientId: "c1", now: 1 });
  recordMcpBriefEgress(db, { method: "agents.huddle", params: {}, clientId: "c1", now: 2 });
  recordMcpBriefEgress(db, { method: "agents.why", params: {}, clientId: "c1", now: 3 });
  const dests = (db.query(`SELECT destination FROM egress_ledger ORDER BY id`).all() as Array<{
    destination: string;
  }>).map((r) => r.destination);
  expect(dests).toEqual(["mcp+federation", "mcp+federation", "mcp"]);
  db.close();
});

test("the payload summary is redacted and capped", () => {
  const db = ledgerDb();
  recordMcpBriefEgress(db, {
    method: "agents.expert",
    params: { topicOrFile: "x", token: "ghp_averysecretvaluethatmustnotsurvive" },
    clientId: "c1",
    now: 1,
  });
  const row = db.query(`SELECT payload_summary FROM egress_ledger`).get() as { payload_summary: string };
  expect(row.payload_summary).not.toContain("ghp_averysecretvaluethatmustnotsurvive");
  expect(row.payload_summary.length).toBeLessThanOrEqual(300);
  db.close();
});

test("hitl status is not_required and result is authorized", () => {
  const db = ledgerDb();
  recordMcpBriefEgress(db, { method: "agents.why", params: {}, clientId: "c1", now: 1 });
  const row = db.query(`SELECT hitl_status, result_status FROM egress_ledger`).get() as {
    hitl_status: string;
    result_status: string;
  };
  expect(row.hitl_status).toBe("not_required");
  expect(row.result_status).toBe("authorized");
  db.close();
});

test("an append failure propagates so the caller can fail closed", () => {
  const db = new Database(":memory:"); // no egress_ledger table
  expect(() =>
    recordMcpBriefEgress(db, { method: "agents.why", params: {}, clientId: "c1", now: 1 }),
  ).toThrow();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/mcp-brief-egress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/egress/mcp-brief-egress.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * Agents that answer by querying paired peers rather than purely from the local index. Their rows
 * must stay distinguishable from purely local briefs — collapsing them into one undifferentiated
 * "mcp" destination would hide outbound peer traffic inside a local-looking record.
 */
const FEDERATION_TOUCHING: ReadonlySet<string> = new Set(["agents.ghost", "agents.huddle"]);

/**
 * The sole append site for MCP-originated agent briefs (I29, D22(c)).
 *
 * Called BEFORE the brief is returned to the caller. It throws on failure by design: the caller
 * must fail closed and emit no brief, mirroring the executor's append-before-dispatch discipline.
 * A ledger that can be outrun by the thing it records is decorative.
 */
export function recordMcpBriefEgress(
  db: Database,
  args: {
    readonly method: string;
    readonly params: unknown;
    readonly clientId: string;
    readonly now: number;
  },
): void {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "mcp",
    sourceId: args.clientId,
    destination: FEDERATION_TOUCHING.has(args.method) ? "mcp+federation" : "mcp",
    method: args.method,
    payloadSummary: redactEgressSummary(args.params),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/egress/mcp-brief-egress.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Wire the single chokepoint call**

In `packages/gateway/src/ipc/agents-rpc.ts`, add the import:

```typescript
import { recordMcpBriefEgress } from "../egress/mcp-brief-egress.ts";
```

and replace `dispatchAgentsRpc` with:

```typescript
export async function dispatchAgentsRpc(
  method: string,
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<RpcMissOrHit> {
  // I29/D22(c): an MCP-originated brief is egress — the gateway synthesises from the private index
  // and hands the result to whatever model the calling client uses. Append BEFORE any work, and let
  // a failure propagate: no row, no brief.
  if (ctx.caller?.kind === "mcp" && method.startsWith("agents.")) {
    recordMcpBriefEgress(ctx.db, {
      method,
      params,
      clientId: ctx.caller.clientId,
      now: Date.now(),
    });
  }
  return dispatchByMethod<AgentsRpcContext>(method, params, ctx, {
    "agents.expert": handleExpert,
    "agents.impact": handleImpact,
    "agents.catchup": handleCatchup,
    "agents.ghost": handleGhost,
    "agents.conflicts": handleConflicts,
    "agents.huddle": handleHuddle,
    "agents.janitor": handleJanitor,
    "agents.preflight": handlePreflight,
    "agents.why": handleWhy,
    "agents.whyPeek": handleWhyPeek,
    "agents.glossary": handleGlossary,
    "agents.decisions": handleDecisions,
  });
}
```

- [ ] **Step 6: Write the attribution test**

Append to `packages/gateway/src/ipc/agents-rpc.test.ts`:

```typescript
test("a CLI-originated agents call appends NO egress row", async () => {
  const db = freshDb();
  await dispatchAgentsRpc(
    "agents.expert",
    { topicOrFile: "x" },
    { ...makeCtx(db), caller: { clientId: "c1", kind: "cli" as const } },
  );
  const n = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
  expect(n.n).toBe(0);
});

test("an MCP-originated agents call appends exactly one egress row", async () => {
  const db = freshDb();
  await dispatchAgentsRpc(
    "agents.expert",
    { topicOrFile: "x" },
    { ...makeCtx(db), caller: { clientId: "c1", kind: "mcp" as const } },
  );
  const rows = db.query(`SELECT source_type FROM egress_ledger`).all() as Array<{ source_type: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.source_type).toBe("mcp");
});
```

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts`
Expected: PASS. If `freshDb()` does not create `egress_ledger`, extend that helper to run the same `CREATE TABLE` used in the Step 1 test.

- [ ] **Step 7: Extend the static audit with `D22(c)`**

In `scripts/structure-audit/check-nimbus-invariants.ts`, beside the existing `D22` constants (around line 599), add:

```typescript
// (c) the MCP brief egress chokepoint must be TOTAL: `recordMcpBriefEgress` is CALLED from exactly
// one file. This mirrors (a) — it pins the caller, it does not merely permit an appender. Adding a
// file to an allowlist here would satisfy the checker while dissolving the property it protects.
const D22_MCP_RECORD_RE = /\brecordMcpBriefEgress\b/;
const D22_MCP_RECORD_CALLER = "packages/gateway/src/ipc/agents-rpc.ts";
const D22_MCP_RECORD_DEFINITION = "packages/gateway/src/egress/mcp-brief-egress.ts";
```

and inside the same per-line loop that already tests `D22_DISPATCH_RE` and `D22_APPEND_RE`, add:

```typescript
      if (
        D22_MCP_RECORD_RE.test(line) &&
        f.relPath !== D22_MCP_RECORD_CALLER &&
        f.relPath !== D22_MCP_RECORD_DEFINITION
      ) {
        violations.push({
          rule: "D22-mcp-brief-egress",
          file: f.relPath,
          line: lineNo,
          snippet: line.trim(),
        });
      }
```

Extend the `D22` error message near line 810 to name the third rule:

```typescript
        `::error file=${e.file},line=${e.line}::D22 egress chokepoint breach (connectors.dispatch outside executor.ts, appendEgressEntry outside egress/, or recordMcpBriefEgress outside agents-rpc.ts) — bypasses I29: ${e.snippet}`,
```

- [ ] **Step 8: Red-prove the static rule**

Temporarily add a line `recordMcpBriefEgress;` to `packages/gateway/src/ipc/clip-rpc.ts`, then run:

Run: `bun run audit:invariants`
Expected: FAIL with `D22-mcp-brief-egress`. **Remove the temporary line** and re-run — expected: PASS. A guard that has never been observed failing is not a guard.

- [ ] **Step 9: Update the invariant docs and enforcement test**

In `docs/SECURITY-INVARIANTS.md`, in the `I29` section, add to the description of the append paths:

```markdown
A second append path exists for MCP-originated agent briefs. An agent brief served to a client that
declared itself `mcp` at connect time is egress — the gateway synthesises from the private index and
hands the result to whatever model the calling client uses — so one `egress_ledger` row with
`source_type='mcp'` is appended before any agent work begins, and a failed append aborts the call.
`D22` is extended, not exempted: rule (c) pins the *caller* of `recordMcpBriefEgress` to
`ipc/agents-rpc.ts`, in the same shape as rule (a) pinning `connectors.dispatch` to `executor.ts`.
A CLI-originated call appends nothing, because a brief rendered locally never leaves the machine.
```

In `packages/gateway/src/security-invariants.test.ts`, add:

```typescript
test("I29: recordMcpBriefEgress is called from exactly one file", async () => {
  const { $ } = await import("bun");
  const out = await $`rg -l "recordMcpBriefEgress" packages/gateway/src`.text();
  const files = out.split("\n").filter((l) => l.length > 0 && !l.includes(".test."));
  expect(files.sort()).toEqual([
    "packages/gateway/src/egress/mcp-brief-egress.ts",
    "packages/gateway/src/ipc/agents-rpc.ts",
  ]);
});
```

- [ ] **Step 10: Run the invariant suite**

Run: `bun test packages/gateway/src/security-invariants.test.ts && bun run audit:invariants`
Expected: PASS.

- [ ] **Step 11: Commit (the full triple in one commit)**

```bash
git add packages/gateway/src/egress/mcp-brief-egress.ts packages/gateway/src/egress/mcp-brief-egress.test.ts packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.test.ts scripts/structure-audit/check-nimbus-invariants.ts docs/SECURITY-INVARIANTS.md packages/gateway/src/security-invariants.test.ts
git commit -m "feat(gateway): record MCP-originated agent briefs in the egress ledger"
```

---

### Task 5: First MCP tool — `peekWhy`

**Files:**

- Modify: `packages/cli/src/mcp/adapter.ts:332-404` (`TOOL_SPECS`), `:406-417` (`buildMcpServer`)
- Modify: `packages/cli/src/mcp/adapter.test.ts`

**Interfaces:**

- Consumes: `ToolSpec`, `AdapterDeps`, `runTool`, `jsonResult`, `optString` (all existing in `adapter.ts`).
- Produces: the `peekWhy` entry in `TOOL_SPECS`. Task 6 appends beside it.

`agents.whyPeek` is synchronous — it returns a payload directly with no `briefReady` notification — so this tool needs none of Task 6's router machinery. It proves registration, dispatch, error handling and the ledger append end to end first.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/src/mcp/adapter.test.ts`:

```typescript
test("peekWhy is registered and calls agents.whyPeek", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const deps = {
    getClient: async () => ({
      call: async <T,>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return { summary: "because of PR #412" } as T;
      },
      disconnect: async (): Promise<void> => {},
    }),
  };
  const spec = TOOL_SPECS.find((s) => s.name === "peekWhy");
  expect(spec).toBeDefined();
  const out = await spec?.run(deps, { fileOrPrUrl: "src/a.ts" });
  expect(calls[0]?.method).toBe("agents.whyPeek");
  expect(calls[0]?.params).toEqual({ fileOrPrUrl: "src/a.ts" });
  expect(out?.isError).toBeUndefined();
  expect(out?.content[0]?.text).toContain("because of PR #412");
});

test("peekWhy reports a stopped gateway without throwing", async () => {
  const deps = {
    getClient: (): Promise<never> => Promise.reject(new GatewayUnavailableError()),
  };
  const spec = TOOL_SPECS.find((s) => s.name === "peekWhy");
  const out = await spec?.run(deps, { fileOrPrUrl: "src/a.ts" });
  expect(out?.isError).toBe(true);
  expect(out?.content[0]?.text).toBe(GATEWAY_DOWN_MESSAGE);
});
```

Ensure the test file imports `TOOL_SPECS`, `GatewayUnavailableError` and `GATEWAY_DOWN_MESSAGE` from `./adapter.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/mcp/adapter.test.ts -t "peekWhy"`
Expected: FAIL — `expect(spec).toBeDefined()` fails; `peekWhy` is not registered.

- [ ] **Step 3: Register the tool**

In `packages/cli/src/mcp/adapter.ts`, append to `TOOL_SPECS`:

```typescript
  {
    name: "peekWhy",
    description:
      "Fast why-lens probe for a file or PR URL: returns a compact explanation of why the code is the way it is, drawn from the local relationship graph (authorship, PRs, incidents, decisions). Synchronous — use explainWhy for the full brief.",
    schema: { fileOrPrUrl: z.string() },
    run: (deps, args) =>
      runTool(deps, async (c) =>
        jsonResult(
          await c.call("agents.whyPeek", { fileOrPrUrl: optString(args, "fileOrPrUrl") ?? "" }),
        ),
      ),
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/cli/src/mcp/adapter.test.ts -t "peekWhy"`
Expected: PASS — 2 tests.

- [ ] **Step 5: Declare the client kind on connect**

In `packages/cli/src/mcp/adapter.ts`, inside `createDeps`'s `openConnection`, after the client is connected and wrapped, declare the kind so the gateway can attribute the calls:

```typescript
    const client = makeReconnectingClient(raw, invalidate);
    // I29: identify this connection as MCP so the gateway records briefs served over it as egress.
    // Best-effort — an older gateway without `session.declareKind` must not break the adapter.
    try {
      await client.call("session.declareKind", { kind: "mcp" });
    } catch {
      // Older gateway: it will still serve briefs, but it cannot attribute them, so nothing is
      // recorded in the egress ledger. Say so on stderr — silently serving unrecorded briefs would
      // make `nimbus prove` quietly wrong, which is the exact failure this feature exists to close.
      // stderr is safe here: the MCP protocol channel is stdout.
      process.stderr.write(
        "nimbus-mcp: gateway does not support session.declareKind; agent briefs served over MCP will NOT appear in the egress ledger. Upgrade the gateway.\n",
      );
    }
    cached = client;
    return client;
```

- [ ] **Step 6: Run the full adapter suite**

Run: `bun test packages/cli/src/mcp/`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/mcp/adapter.ts packages/cli/src/mcp/adapter.test.ts
git commit -m "feat(cli): expose the why-peek agent as an MCP tool"
```

---

### Task 6: The ten async agent tools

**Files:**

- Create: `packages/cli/src/mcp/errors.ts`
- Create: `packages/cli/src/mcp/agent-tools.ts`
- Create: `packages/cli/src/mcp/agent-tools.test.ts`
- Modify: `packages/cli/src/mcp/adapter.ts` (`TOOL_SPECS`, error re-exports, `invalidate`)

**Interfaces:**

- Consumes: `AgentBriefRouter`, `PendingBrief` (Task 1); `ToolSpec`, `AdapterDeps`, `IpcCallable`, `runTool`, `ToolResult` (existing).
- Produces: `AGENT_TOOL_SPECS: ToolSpec[]`, spread into `TOOL_SPECS`.

`agents.preflight` is **deliberately excluded** — it is the `I24` federated action path and triggers sandboxed execution on peers behind the owner's HITL gate. Do not add it.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/mcp/agent-tools.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { AGENT_TOOL_SPECS } from "./agent-tools.ts";

/** A fake client that answers the agents.* call and then emits the matching briefReady. */
function briefClient(sessionId: string, brief: string) {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  return {
    onNotification(method: string, h: (p: unknown) => void): void {
      const l = handlers.get(method) ?? [];
      l.push(h);
      handlers.set(method, l);
    },
    async call<T>(method: string, _params?: unknown): Promise<T> {
      const agent = method.slice("agents.".length);
      queueMicrotask(() => {
        for (const h of handlers.get(`${agent}.briefReady`) ?? []) {
          h({ sessionId, brief, findings: { gaps: [] } });
        }
      });
      return { sessionId } as T;
    },
    async disconnect(): Promise<void> {},
  };
}

test("the brief timeout defaults to 60s and honours NIMBUS_MCP_TIMEOUT_MS", () => {
  expect(agentTimeoutMs({})).toBe(60_000);
  expect(agentTimeoutMs({ NIMBUS_MCP_TIMEOUT_MS: "15000" })).toBe(15_000);
  expect(agentTimeoutMs({ NIMBUS_MCP_TIMEOUT_MS: "not-a-number" })).toBe(60_000);
  expect(agentTimeoutMs({ NIMBUS_MCP_TIMEOUT_MS: "-5" })).toBe(60_000);
});

test("no agent tool exposes a timeout parameter to the calling model", () => {
  for (const spec of AGENT_TOOL_SPECS) {
    expect(Object.keys(spec.schema)).not.toContain("timeout");
    expect(Object.keys(spec.schema)).not.toContain("timeoutMs");
  }
});

test("all ten async agents are registered, and preflight is not", () => {
  const names = AGENT_TOOL_SPECS.map((s) => s.name).sort();
  expect(names).toEqual(
    [
      "assessImpact",
      "checkResourceUsage",
      "explainWhy",
      "findConflicts",
      "findDecisions",
      "findExpert",
      "getCatchup",
      "getGlossary",
      "getPeerContext",
      "getTeamHuddle",
    ].sort(),
  );
  expect(names).not.toContain("runPreflight");
});

test("explainWhy returns the brief markdown as the first content block", async () => {
  const client = briefClient("s1", "## Why\n\nBecause of PR #412.");
  const deps = { getClient: async () => client };
  const spec = AGENT_TOOL_SPECS.find((s) => s.name === "explainWhy");
  const out = await spec?.run(deps, { fileOrPrUrl: "src/a.ts" });
  expect(out?.isError).toBeUndefined();
  expect(out?.content[0]?.text).toContain("Because of PR #412.");
});

test("the typed findings ride along as a second content block", async () => {
  const client = briefClient("s1", "brief");
  const deps = { getClient: async () => client };
  const spec = AGENT_TOOL_SPECS.find((s) => s.name === "getCatchup");
  const out = await spec?.run(deps, {});
  expect(out?.content).toHaveLength(2);
  expect(out?.content[1]?.text).toContain("gaps");
});

test("a brief error becomes an MCP error result, never a throw", async () => {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const client = {
    onNotification(m: string, h: (p: unknown) => void): void {
      const l = handlers.get(m) ?? [];
      l.push(h);
      handlers.set(m, l);
    },
    async call<T>(_m: string, _p?: unknown): Promise<T> {
      queueMicrotask(() => {
        for (const h of handlers.get("why.briefError") ?? []) h({ sessionId: "s1", error: "no index" });
      });
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const spec = AGENT_TOOL_SPECS.find((s) => s.name === "explainWhy");
  const out = await spec?.run({ getClient: async () => client }, { fileOrPrUrl: "x" });
  expect(out?.isError).toBe(true);
  expect(out?.content[0]?.text).toContain("no index");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/mcp/agent-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract the shared error surface**

`agent-tools.ts` needs three runtime values that live in `adapter.ts`, and `adapter.ts` will import
`AGENT_TOOL_SPECS` from `agent-tools.ts` — a cycle. Break it by moving the three into their own
module rather than reaching for a dynamic import.

Create `packages/cli/src/mcp/errors.ts` by **moving** these declarations verbatim out of
`adapter.ts`:

```typescript
export const GATEWAY_DOWN_MESSAGE = "Nimbus Gateway is not running. Start it with: nimbus start";

/** Thrown when the adapter cannot reach the Gateway (no state file, or connect failed). */
export class GatewayUnavailableError extends Error {
  constructor() {
    super(GATEWAY_DOWN_MESSAGE);
    this.name = "GatewayUnavailableError";
  }
}

const DISCONNECT_MESSAGES: ReadonlySet<string> = new Set([
  "IPC client is not connected",
  "IPC connection closed",
  "IPC connection error",
]);

/** True when an error is one of IPCClient's transport-dead messages and a reconnect is warranted. */
export function isDisconnectError(e: unknown): boolean {
  return e instanceof Error && DISCONNECT_MESSAGES.has(e.message);
}
```

In `adapter.ts`, delete those declarations and re-export them so existing importers keep working:

```typescript
export { GATEWAY_DOWN_MESSAGE, GatewayUnavailableError, isDisconnectError } from "./errors.ts";
import { GATEWAY_DOWN_MESSAGE, GatewayUnavailableError, isDisconnectError } from "./errors.ts";
```

Run: `bun test packages/cli/src/mcp/ && bun run typecheck`
Expected: PASS, clean — this step is a pure move and must change no behaviour.

- [ ] **Step 4: Write the implementation**

Create `packages/cli/src/mcp/agent-tools.ts`:

```typescript
import { z } from "zod";
import { AgentBriefRouter, type BriefNotificationSource } from "../lib/agent-brief-router.ts";
import type { AdapterDeps, IpcCallable, ToolResult, ToolSpec } from "./adapter.ts";
import { GATEWAY_DOWN_MESSAGE, GatewayUnavailableError, isDisconnectError } from "./errors.ts";

const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/**
 * How long to wait for a brief. The default is 60 s rather than the CLI's 30 s because the
 * federation-touching agents (`getPeerContext`, `getTeamHuddle`) wait on paired peers, not just the
 * local index.
 *
 * Configurable by environment because MCP clients impose their own transport timeouts and those
 * differ per editor: an operator whose client gives up sooner wants this lower, so the tool returns
 * a clean error rather than having the call severed underneath it.
 *
 * Deliberately NOT a tool argument. A timeout is a transport concern, and the schema rule this
 * design already established is IPC params only — never presentation or transport knobs. Exposing
 * one would invite the calling model to invent values for it.
 */
export function agentTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env["NIMBUS_MCP_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AGENT_TIMEOUT_MS;
}

/** One router per client object, so listeners bind once per agent name per connection. */
const routers = new WeakMap<object, AgentBriefRouter>();

function routerFor(client: object): AgentBriefRouter {
  const existing = routers.get(client);
  if (existing !== undefined) return existing;
  const created = new AgentBriefRouter(client as BriefNotificationSource);
  routers.set(client, created);
  return created;
}

/**
 * Reject every brief in flight on this client. Wired into the adapter's reconnect `invalidate`
 * hook so a mid-flight transport death fails fast instead of waiting out the timeout.
 */
export function failBriefsForClient(client: object, err: Error): void {
  routers.get(client)?.failAll(err);
}

function briefResult(brief: string, findings: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: brief },
      { type: "text", text: JSON.stringify(findings, null, 2) },
    ],
  };
}

/**
 * Invoke an async agent and await its brief.
 *
 * The waiter is registered BEFORE the call so a fast agent cannot emit before anyone is listening,
 * and bound to the returned sessionId immediately after, so a concurrent caller's brief is never
 * mistaken for this one.
 */
async function runAgent(
  client: IpcCallable,
  agentName: string,
  ipcMethod: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  // No guard: findings are returned verbatim as JSON, so there is nothing to validate against.
  const pending = routerFor(client as unknown as object).expect<unknown>(
    agentName,
    undefined,
    agentTimeoutMs(),
  );
  try {
    const { sessionId } = await client.call<{ sessionId: string }>(ipcMethod, params);
    pending.bindSession(sessionId);
    const { brief, findings } = await pending.result;
    return briefResult(brief, findings);
  } catch (e) {
    pending.cancel();
    throw e;
  }
}

interface AgentToolDef {
  readonly tool: string;
  readonly agent: string;
  readonly description: string;
  readonly schema: Record<string, z.ZodTypeAny>;
  readonly build: (args: Record<string, unknown>) => Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : "";
}

function optNum(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" ? v : undefined;
}

function withOptional(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const DEFS: readonly AgentToolDef[] = [
  {
    tool: "explainWhy",
    agent: "why",
    description:
      "Explain why a file or PR is the way it is — six parallel lanes over the local relationship graph (authorship, PRs, incidents, decisions, discussions, adjacent code). Returns a markdown brief.",
    schema: { fileOrPrUrl: z.string() },
    build: (a) => ({ fileOrPrUrl: str(a, "fileOrPrUrl") }),
  },
  {
    tool: "getCatchup",
    agent: "catchup",
    description:
      "Retrospective digest of what happened across connected services while the user was away, personalized to their work.",
    schema: { since: z.string().optional() },
    build: (a) => withOptional({}, { since: a["since"] }),
  },
  {
    tool: "findExpert",
    agent: "expert",
    description:
      "Answer 'who has the most context on this?' — a ranked list of people drawn from indexed PRs, reviews, incidents and discussions.",
    schema: { topicOrFile: z.string(), limit: z.number().int().positive().optional() },
    build: (a) => withOptional({ topicOrFile: str(a, "topicOrFile") }, { limit: optNum(a, "limit") }),
  },
  {
    tool: "assessImpact",
    agent: "impact",
    description:
      "Answer 'if I change this, what breaks?' — reverse-dependency blast radius across services, dashboards, tests, docs and owners.",
    schema: { fileOrPrUrl: z.string(), depth: z.number().int().min(1).max(5).optional() },
    build: (a) => withOptional({ fileOrPrUrl: str(a, "fileOrPrUrl") }, { depth: optNum(a, "depth") }),
  },
  {
    tool: "findConflicts",
    agent: "conflicts",
    description:
      "Warn of work-in-progress collisions before editing a file — teammates with an open PR or assigned ticket touching the same code.",
    schema: { file: z.string() },
    build: (a) => ({ file: str(a, "file") }),
  },
  {
    tool: "findDecisions",
    agent: "decisions",
    description:
      "Recover decision records that were made but never written down, reconstructed from discussions, PRs and issues.",
    schema: { topic: z.string().optional(), limit: z.number().int().positive().optional() },
    build: (a) => withOptional({}, { topic: a["topic"], limit: optNum(a, "limit") }),
  },
  {
    tool: "getGlossary",
    agent: "glossary",
    description:
      "Team terminology as a queryable glossary, extracted from how the team actually writes. Returns one term's definition when `term` is given, otherwise lists the glossary.",
    schema: { term: z.string().optional(), limit: z.number().int().positive().optional() },
    build: (a) => withOptional({}, { term: a["term"], limit: optNum(a, "limit") }),
  },
  {
    tool: "checkResourceUsage",
    agent: "janitor",
    description:
      "Answer 'is this cloud resource still in use, and what breaks if I delete it?' — cross-references a resource against indexed code, config and deploys.",
    schema: { resourceRef: z.string() },
    build: (a) => ({ resourceRef: str(a, "resourceRef") }),
  },
  {
    tool: "getPeerContext",
    agent: "ghost",
    description:
      "Ambient teammate context for a file, gathered from paired peers across the federation mesh. Reaches the network beyond this machine.",
    schema: { file: z.string() },
    build: (a) => ({ file: str(a, "file") }),
  },
  {
    tool: "getTeamHuddle",
    agent: "huddle",
    description:
      "Team-scoped briefing aggregating each teammate's recent PRs, tickets and incidents from paired peers. Reaches the network beyond this machine.",
    schema: { namespace: z.string().optional() },
    build: (a) => withOptional({}, { namespace: a["namespace"] }),
  },
];

export const AGENT_TOOL_SPECS: ToolSpec[] = DEFS.map((d) => ({
  name: d.tool,
  description: d.description,
  schema: d.schema,
  run: (deps: AdapterDeps, args: Record<string, unknown>): Promise<ToolResult> =>
    runAgentTool(deps, d, args),
}));

/** Mirrors the adapter's `runTool` contract: never throws, always returns a ToolResult. */
async function runAgentTool(
  deps: AdapterDeps,
  def: AgentToolDef,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let client: IpcCallable;
  try {
    client = await deps.getClient();
  } catch (e) {
    if (e instanceof GatewayUnavailableError) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: `Nimbus: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
  try {
    return await runAgent(client, def.agent, `agents.${def.agent}`, def.build(args));
  } catch (e) {
    if (isDisconnectError(e)) {
      return { content: [{ type: "text", text: GATEWAY_DOWN_MESSAGE }], isError: true };
    }
    return {
      content: [{ type: "text", text: `Nimbus: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/cli/src/mcp/agent-tools.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Register the specs in the adapter**

In `packages/cli/src/mcp/adapter.ts`, import and spread:

```typescript
import { AGENT_TOOL_SPECS } from "./agent-tools.ts";
```

Change the `TOOL_SPECS` declaration's closing to append them:

```typescript
export const TOOL_SPECS: ToolSpec[] = [
  // ... the existing six specs and peekWhy ...
  ...AGENT_TOOL_SPECS,
];
```

Update the `buildMcpServer` doc comment: it says "all six read-only tools" — make it "all read-only tools".

- [ ] **Step 7: Wire transport-death rejection**

Without this, a connection that dies mid-brief leaves the caller waiting the full 60-second timeout
and then reporting a timeout rather than a disconnect. `createDeps` already detects transport death
in order to invalidate its cached client; that is the hook.

In `packages/cli/src/mcp/adapter.ts`, add the import:

```typescript
import { failBriefsForClient } from "./agent-tools.ts";
```

then rewrite `makeReconnectingClient` so the wrapper can refer to itself. **The identity here is
load-bearing:** `openConnection` returns the wrapper, so `getClient()` hands `runAgent` the wrapper,
so `routerFor` keys the `WeakMap` on the **wrapper**. Failing on `raw` would look up an object that
was never a key, miss silently, and leave every waiter to time out — the exact failure this step
exists to prevent. Bind the wrapper to a named const and pass that:

```typescript
function makeReconnectingClient(raw: IpcCallable, invalidate: () => void): IpcCallable {
  const wrapper: IpcCallable = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      try {
        return await raw.call<T>(method, params);
      } catch (e) {
        if (isDisconnectError(e)) {
          // `wrapper`, never `raw` — the router is keyed on what getClient() returned.
          failBriefsForClient(wrapper, e as Error);
          invalidate();
          void raw.disconnect().catch(() => {});
        }
        throw e;
      }
    },
    disconnect(): Promise<void> {
      return raw.disconnect();
    },
  };
  return wrapper;
}
```

Referencing `wrapper` inside `call` is safe: the closure runs long after the `const` is
initialised.

**Known limitation, deliberately accepted.** This hook only fires when a `call` fails, and during
the await for a brief there is no call in flight. So a solitary in-flight brief on a dying
connection is still bounded by its timeout rather than failing immediately; what this buys is that
a *concurrent* failing call now fails every waiter at once instead of letting each grind out its
own timeout. The complete fix is to drive `failAll` from a transport close event — which could not
be designed here, because `@nimbus-dev/client` is not installed in this checkout and its event
surface is unverified. If `IPCClient` turns out to expose a close or error event, wire `failAll` to
it and this limitation disappears.

Append to `packages/cli/src/mcp/agent-tools.test.ts`:

```typescript
test("failBriefsForClient rejects a brief in flight on that client", async () => {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const client = {
    onNotification(m: string, h: (p: unknown) => void): void {
      const l = handlers.get(m) ?? [];
      l.push(h);
      handlers.set(m, l);
    },
    async call<T>(_m: string, _p?: unknown): Promise<T> {
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const spec = AGENT_TOOL_SPECS.find((s) => s.name === "explainWhy");
  const running = spec?.run({ getClient: async () => client }, { fileOrPrUrl: "x" });
  await Promise.resolve();
  failBriefsForClient(client, new Error("IPC connection closed"));
  const out = await running;
  expect(out?.isError).toBe(true);
});
```

That test calls `failBriefsForClient` directly with the same object `getClient` returned, so it
passes whether or not the adapter wires the right identity — it cannot catch the bug this step
exists to prevent. Add one that exercises the real wiring, in
`packages/cli/src/mcp/adapter.test.ts`:

```typescript
test("a disconnect on one call fails briefs in flight on the same connection", async () => {
  let failNext = false;
  const raw = {
    onNotification(_m: string, _h: (p: unknown) => void): void {},
    async call<T>(method: string): Promise<T> {
      if (failNext && method === "connector.listStatus") {
        throw new Error("IPC connection closed");
      }
      return { sessionId: "s1" } as T;
    },
    async disconnect(): Promise<void> {},
  };
  const deps = createDeps({
    readState: async () => ({ socketPath: "/tmp/sock" }),
    connect: async () => raw,
  });

  const explain = TOOL_SPECS.find((s) => s.name === "explainWhy");
  const inFlight = explain?.run(deps, { fileOrPrUrl: "x" });
  await Promise.resolve();

  // A second, failing call on the same connection trips the disconnect branch.
  failNext = true;
  const status = TOOL_SPECS.find((s) => s.name === "getConnectorStatus");
  await status?.run(deps, {});

  // Resolves well inside the 60 s timeout, because failAll found the wrapper in the WeakMap.
  const out = await inFlight;
  expect(out?.isError).toBe(true);
}, 5000);
```

The 5-second test timeout is the assertion that matters: keyed on `raw` instead of `wrapper`, this
test does not fail an assertion — it hangs for 60 seconds and then times out. Confirm it fails that
way before applying the fix.

Run: `bun test packages/cli/src/mcp/`
Expected: PASS — 7 tests in `agent-tools.test.ts`, plus the new adapter test.

- [ ] **Step 8: Assert the registered tool count**

Append to `packages/cli/src/mcp/adapter.test.ts`:

```typescript
test("the registered tool set is the six index tools plus peekWhy plus ten agents", () => {
  expect(TOOL_SPECS).toHaveLength(17);
  const names = new Set(TOOL_SPECS.map((s) => s.name));
  expect(names.has("searchIndex")).toBe(true);
  expect(names.has("peekWhy")).toBe(true);
  expect(names.has("explainWhy")).toBe(true);
  expect(names.has("runPreflight")).toBe(false);
});
```

- [ ] **Step 9: Run the full CLI MCP suite**

Run: `bun test packages/cli/src/mcp/ && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/mcp/errors.ts packages/cli/src/mcp/agent-tools.ts packages/cli/src/mcp/agent-tools.test.ts packages/cli/src/mcp/adapter.ts packages/cli/src/mcp/adapter.test.ts
git commit -m "feat(cli): expose ten read-only agents as MCP tools"
```

---

### Task 7: MIT launcher package

**Files:**

- Create: `packages/mcp-launcher/package.json`
- Create: `packages/mcp-launcher/LICENSE`
- Create: `packages/mcp-launcher/README.md`
- Create: `packages/mcp-launcher/src/resolve-binary.ts`
- Create: `packages/mcp-launcher/src/resolve-binary.test.ts`
- Create: `packages/mcp-launcher/src/index.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks. **Must not import from `packages/cli` or `packages/gateway`** — those are AGPL and this package is MIT.
- Produces: a `bin` entry `nimbus-mcp` that execs the resolved gateway CLI with `mcp-server --stdio`.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-launcher/src/resolve-binary.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { CANDIDATE_DIRS, resolveNimbusBinary } from "./resolve-binary.ts";

test("an explicit NIMBUS_BIN wins over everything", () => {
  const got = resolveNimbusBinary({
    env: { NIMBUS_BIN: "/custom/nimbus" },
    platform: "linux",
    home: "/home/u",
    exists: (p) => p === "/custom/nimbus",
  });
  expect(got).toEqual({ kind: "found", path: "/custom/nimbus", via: "NIMBUS_BIN" });
});

test("a NIMBUS_BIN pointing at nothing is an explicit error, not a silent fallback", () => {
  const got = resolveNimbusBinary({
    env: { NIMBUS_BIN: "/missing/nimbus" },
    platform: "linux",
    home: "/home/u",
    exists: () => false,
  });
  expect(got.kind).toBe("bad-override");
});

test("PATH is used when NIMBUS_BIN is unset", () => {
  const got = resolveNimbusBinary({
    env: { PATH: "/usr/bin:/usr/local/bin" },
    platform: "linux",
    home: "/home/u",
    exists: (p) => p === "/usr/local/bin/nimbus",
  });
  expect(got).toEqual({ kind: "found", path: "/usr/local/bin/nimbus", via: "PATH" });
});

test("falls back to a known install directory", () => {
  const got = resolveNimbusBinary({
    env: {},
    platform: "linux",
    home: "/home/u",
    exists: (p) => p === "/home/u/.nimbus/bin/nimbus",
  });
  expect(got).toEqual({ kind: "found", path: "/home/u/.nimbus/bin/nimbus", via: "install-dir" });
});

test("windows looks for nimbus.exe", () => {
  const got = resolveNimbusBinary({
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32",
    home: "C:\\Users\\u",
    exists: (p) => p.endsWith("nimbus.exe"),
  });
  expect(got.kind).toBe("found");
  if (got.kind === "found") expect(got.path.endsWith("nimbus.exe")).toBe(true);
});

test("not found is reported, never thrown", () => {
  const got = resolveNimbusBinary({
    env: {},
    platform: "darwin",
    home: "/Users/u",
    exists: () => false,
  });
  expect(got.kind).toBe("not-found");
});

test("every platform has at least one candidate directory", () => {
  for (const p of ["win32", "darwin", "linux"] as const) {
    expect(CANDIDATE_DIRS(p, "/home/u", {}).length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-launcher/src/resolve-binary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the resolver**

Create `packages/mcp-launcher/src/resolve-binary.ts`:

```typescript
import { join } from "node:path";

export type Platform = "win32" | "darwin" | "linux";

export type Resolution =
  | { kind: "found"; path: string; via: "NIMBUS_BIN" | "PATH" | "install-dir" }
  | { kind: "bad-override"; path: string }
  | { kind: "not-found" };

export interface ResolveInput {
  readonly env: Record<string, string | undefined>;
  readonly platform: Platform;
  readonly home: string;
  readonly exists: (path: string) => boolean;
}

function binName(platform: Platform): string {
  return platform === "win32" ? "nimbus.exe" : "nimbus";
}

/**
 * Known install locations, by platform. This duplicates a small amount of path knowledge that the
 * AGPL CLI also holds — deliberately, because this package is MIT and cannot import from it. The
 * drift risk is covered by a test asserting this list against the installers' output directories.
 */
export function CANDIDATE_DIRS(
  platform: Platform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    return [join(localAppData, "Nimbus", "bin"), join(localAppData, "Programs", "Nimbus")];
  }
  if (platform === "darwin") {
    return [join(home, ".nimbus", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
  }
  return [join(home, ".nimbus", "bin"), join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin"];
}

export function resolveNimbusBinary(input: ResolveInput): Resolution {
  const name = binName(input.platform);

  const override = input.env["NIMBUS_BIN"];
  if (override !== undefined && override.length > 0) {
    return input.exists(override)
      ? { kind: "found", path: override, via: "NIMBUS_BIN" }
      : { kind: "bad-override", path: override };
  }

  const sep = input.platform === "win32" ? ";" : ":";
  for (const dir of (input.env["PATH"] ?? "").split(sep)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, name);
    if (input.exists(candidate)) return { kind: "found", path: candidate, via: "PATH" };
  }

  for (const dir of CANDIDATE_DIRS(input.platform, input.home, input.env)) {
    const candidate = join(dir, name);
    if (input.exists(candidate)) return { kind: "found", path: candidate, via: "install-dir" };
  }

  return { kind: "not-found" };
}

const DOCS = "https://nimbus-agent.dev/docs/install";

/** The message shown for each unresolvable state. Each names the fix, never a bare exit code. */
export function explain(resolution: Resolution): string {
  if (resolution.kind === "bad-override") {
    return `NIMBUS_BIN is set to "${resolution.path}" but no file is there. Correct it or unset it. See ${DOCS}`;
  }
  return `Could not find the Nimbus CLI. Install it (see ${DOCS}), or set NIMBUS_BIN to its full path.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-launcher/src/resolve-binary.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the entry point**

Create `packages/mcp-launcher/src/index.ts`:

```typescript
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { explain, type Platform, resolveNimbusBinary } from "./resolve-binary.ts";

const resolution = resolveNimbusBinary({
  env: process.env,
  platform: process.platform as Platform,
  home: homedir(),
  exists: existsSync,
});

if (resolution.kind !== "found") {
  process.stderr.write(`${explain(resolution)}\n`);
  process.exit(1);
}

const child = spawn(resolution.path, ["mcp-server", "--stdio"], { stdio: "inherit" });
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
child.on("error", (err) => {
  process.stderr.write(`Failed to start the Nimbus MCP server: ${err.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Write the package manifest**

Create `packages/mcp-launcher/package.json`:

```json
{
  "name": "@nimbus-dev/mcp",
  "version": "0.1.0",
  "description": "Launcher for the Nimbus MCP server — exposes your local Nimbus index and agents to any MCP client.",
  "license": "MIT",
  "type": "module",
  "bin": { "nimbus-mcp": "./dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "bun build src/index.ts --target node --outdir dist",
    "test": "bun test"
  }
}
```

Create `packages/mcp-launcher/LICENSE` containing the standard MIT licence text, copyright the Nimbus authors.

Create `packages/mcp-launcher/README.md` documenting: what it does, that it requires the Nimbus gateway to be installed and running, the `NIMBUS_BIN` override, the `NIMBUS_MCP_TIMEOUT_MS` override (lower it when the editor's own MCP transport timeout is shorter than 60 s), and an example MCP client configuration block.

- [ ] **Step 7: Verify the licence boundary**

Run: `grep -rn "packages/cli\|packages/gateway\|@nimbus-dev/client" packages/mcp-launcher/src/`
Expected: no output. Any hit is an AGPL import into an MIT package and must be removed.

- [ ] **Step 8: Run everything**

Run: `bun test packages/mcp-launcher/ && bun run typecheck && bun run lint`
Expected: PASS, clean.

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-launcher/
git commit -m "feat(mcp-launcher): add the MIT launcher package"
```

---

## Final verification

- [ ] **Run the full fast gate set**

Run: `bun run preflight:fast`
Expected: all gates pass. Note `bun run lint` silently reports zero files inside `.claude/worktrees/` — if this branch is being developed in a worktree, run Biome with an explicit path to get a real result.

- [ ] **Run the affected suites**

Run: `bun test packages/cli/src packages/gateway/src/ipc packages/gateway/src/egress`
Expected: PASS.

- [ ] **Confirm the invariant guard still red-proves**

Re-do Task 4 Step 8 once more against the final tree. A guard that has never been observed failing is not a guard.

## Deferred, and why

- **Gateway-hosted HTTP/SSE transport.** The recorded successor. Once an HTTP agent-invocation route exists, the stdio adapter becomes a thin client of it rather than a parallel implementation.
- **`agents.preflight` as a tool.** The `I24` federated action path. Exposing any HITL-gated action through MCP is a separate design, and it should start from whether an external model should be able to originate a consent prompt at all.
- **Registry submission.** Publishing `@nimbus-dev/mcp` and listing it in MCP directories is a release activity, not an implementation task.
