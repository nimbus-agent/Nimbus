# Review & Suggestions: Agents as MCP Tools Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-08-02-agents-as-mcp-tools.md](./2026-08-02-agents-as-mcp-tools.md).

---

## 1. Object Identity Mismatch in Connection Invalidation (Task 6 & Task 1)

### The Issue

In Task 6, `runAgent` retrieves the brief router using the `client` wrapper returned by `deps.getClient()`:

```typescript
routerFor(client as unknown as object).expect<unknown>(...)
```

In the adapter reconnect logic (Task 6 Step 7), the transport-death detection tries to fail all pending briefs:

```typescript
if (isDisconnectError(e)) {
  failBriefsForClient(raw as unknown as object, e as Error);
  invalidate();
  void raw.disconnect().catch(() => {});
}
```

Because `raw` is the underlying socket client and `client` in `runAgent` is the reconnecting wrapper returned by `deps.getClient()`, they have different object references. As a result, calling `failBriefsForClient(raw, ...)` looks up a non-existent entry in the `WeakMap`, and the active waiters registered under the wrapper are never canceled early. They will hang until the full 60-second timeout expires.

### Recommendation

Key the `routers` `WeakMap` on the reconnecting wrapper client, or expose a failure-propagation method on the reconnecting wrapper itself that forwards the error to `failBriefsForClient` using the wrapper's identity.

Alternatively, register the router on the raw client, but ensure `runAgent` resolves the raw client or the wrapper provides a reference to it. The simplest fix is to store the wrapper client reference and call `failBriefsForClient(wrapper, e)` when the wrapper detects disconnects.

---

## 2. Inactive Session Buffer Cleanups (Task 1)

### The Issue

If `expect` registers a waiter but `bindSession` is never called (for example, if the initial `agents.*` call rejects before returning a `sessionId`), the waiter will time out and be cleaned up. However, if the gateway *had* already processed the command and emitted a `briefReady` notification, that notification remains in `this.buffered` forever (unless pushed out by 32 subsequent notifications).

### Recommendation

To prevent stale notifications from lingering in the buffer, when a waiter times out or fails without ever having its session bound, clear any buffered notifications matching the expected agent if no other active waiters are waiting for it. Alternatively, since `MAX_BUFFERED_PER_AGENT` is capped at 32, this is a minor memory bound, but explicit cleanup on waiter cancellation prevents any drift.

---

## 3. Injectable/Configurable Tool Timeouts (Task 6)

### The Issue

While Task 1 correctly updates `awaitAgentBrief` to accept an injectable `timeoutMs`, the MCP tool dispatcher in Task 6 hardcodes `AGENT_TIMEOUT_MS = 60_000`.

For heavy queries, the calling editor client might have its own strict transport timeout (e.g. VS Code or Cursor MCP client timeouts are often 10-30 seconds). If the editor times out and disconnects before the 60-second limit is reached, it triggers the disconnect error handling, but it would be cleaner if the tool itself could respect an optional configuration or dynamic timeout parameters passed by the editor if available.

### Recommendation

Keep `AGENT_TIMEOUT_MS` as the default, but allow it to be configured globally (e.g., via environment variable or client config payload) or mapped from specific tool execution arguments if requested.
