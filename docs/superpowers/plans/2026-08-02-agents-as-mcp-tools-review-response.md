# Agents as MCP tools — plan review response

> **Status:** response of record, 2026-08-02. Answers
> [the plan review](./2026-08-02-agents-as-mcp-tools-review.md) of
> [the plan](./2026-08-02-agents-as-mcp-tools.md). All three points accepted; one in
> part. The plan has been revised.

## Summary

| # | Review point | Verdict |
| --- | --- | --- |
| 1 | Object identity in connection invalidation | **Accepted — a real bug**, and my own inline hedge described the relationship backwards |
| 2 | Stranded buffered notifications | **Accepted** — cheap fix, correctly classified by the reviewer as bounded |
| 3 | Configurable tool timeout | **Half accepted** — environment override yes, tool argument no |

## 1. Object identity — a real bug

Verified against `packages/cli/src/mcp/adapter.ts`. `openConnection` ends with:

```typescript
    const client = makeReconnectingClient(raw, invalidate);
    cached = client;
    return client;
```

so `getClient()` returns the **wrapper**, `runAgent` receives the wrapper, and `routerFor` keys the
`WeakMap` on the wrapper. The plan's Step 7 passed `raw`. That is an object which was never a key:
the lookup misses silently, `failAll` never runs, and every waiter grinds out its full timeout —
precisely the behaviour the step was added to prevent.

The reviewer is right, and worth recording plainly: the plan carried an inline note claiming "the
router is keyed on the **raw** client", which is backwards. A hedge that misstates the thing it is
hedging is worse than no hedge, because it invites the reader to skip the check.

**Fix.** `makeReconnectingClient` now binds its return value to a named `wrapper` const and passes
that:

```typescript
  const wrapper: IpcCallable = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      try {
        return await raw.call<T>(method, params);
      } catch (e) {
        if (isDisconnectError(e)) {
          failBriefsForClient(wrapper, e as Error);
```

**A second defect, not raised.** The plan's existing test for this step calls
`failBriefsForClient(client, …)` directly with the same object `getClient` returned — so it passes
whether or not the adapter wires the right identity. It could never have caught this. A test that
goes through `createDeps` and the real reconnect path has been added, and its assertion is the
5-second test timeout: keyed on `raw`, it does not fail an assertion, it hangs for sixty seconds.
The plan instructs confirming that failure before applying the fix.

**Known limitation, now stated in the plan rather than implied.** The hook only fires when a `call`
fails, and while awaiting a brief there is no call in flight. So a solitary in-flight brief on a
dying connection is still bounded by its timeout; what this buys is that a *concurrent* failing call
fails every waiter at once. The complete fix is to drive `failAll` from a transport close event,
which could not be designed here because `@nimbus-dev/client` is not installed in this checkout and
its event surface is unverified. Recorded as the follow-up.

## 2. Stranded buffered notifications — accepted

Confirmed by reading the router: `drainBuffered` runs only from `bindSession`, and `finish` never
touched `this.buffered`. So a waiter whose `agents.*` call failed before returning a `sessionId`
strands its envelope until thirty-two more push it out.

The reviewer's own severity assessment is right, and worth making explicit because it changes how
much machinery this deserves: matching is by exact `sessionId`, and session ids are unique, so a
stale envelope can never be delivered to the wrong waiter. It occupies space; it cannot cause a
wrong answer. Hygiene, not correctness.

**Fix**, in `finish`: once no waiter remains for that agent name, drop the agent's buffer. This also
covers a case the review did not name — a brief arriving for a waiter that already timed out, which
strands an envelope on the success path too.

A test was added that orphans an envelope, then asserts a later waiter binding the *same* session id
does not inherit it.

## 3. Configurable timeout — half accepted

**Accepted: the environment override.** MCP clients impose their own transport timeouts and those
vary by editor. An operator whose client gives up before 60 s wants the tool to return a clean error
rather than have the call severed underneath it. `NIMBUS_MCP_TIMEOUT_MS` now overrides the default,
via an injectable `agentTimeoutMs(env)` so the test needs no environment mutation.

The 60 s default is also now justified in the code rather than left as a magic number: it is double
the CLI's 30 s because the federation-touching agents wait on paired peers, not just the local
index.

**Rejected: mapping it from tool execution arguments.** This contradicts a rule already established
in the design — tool schemas mirror IPC params only, never presentation or transport knobs. That
rule exists because the design review's point 4 proposed a filter for exactly this class of
parameter, and the answer was that no such parameter should reach the schema in the first place.
Adding a timeout argument would reintroduce it deliberately, and would invite the calling model to
invent values for a number it cannot reason about.

A test now asserts that no agent tool exposes `timeout` or `timeoutMs` in its schema, so the rule is
enforced rather than merely written down.

## What changed in the plan

- Task 1: buffer cleanup in `finish`, plus an orphaned-envelope test (6 → 8 tests).
- Task 6: `agentTimeoutMs(env)` replacing the hardcoded constant, with the default justified; two
  tests covering the override and the no-timeout-parameter rule (4 → 6 tests at that step).
- Task 6 Step 7: `makeReconnectingClient` rewritten to pass the wrapper; the limitation stated; a
  real wiring test added in `adapter.test.ts` whose failure mode is a hang, with instructions to
  observe it first.
- Task 7: `NIMBUS_MCP_TIMEOUT_MS` added to the launcher README contents.
