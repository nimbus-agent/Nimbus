// packages/gateway/src/agents/_lib/synthesis-llm.test.ts
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { recordSynthesisEgress } from "../../egress/synthesis-egress.ts";
import type { LlmRouter } from "../../llm/router.ts";
import {
  buildSynthesisRunner,
  type SynthesisEgressRecorder,
  type SynthesisRouter,
} from "./synthesis-llm.ts";

/**
 * Compile-time proof only — never invoked at runtime. `SynthesisRouter` exists so this file's
 * tests can inject a plain object instead of `mock.module` (see the interface's doc comment), but
 * that only stays safe if the REAL `LlmRouter` always satisfies it. If a future change to
 * `LlmRouter`'s public shape ever drops or narrows `resolveForSynthesis`/`generateMarkdown`, this
 * assignment fails to typecheck and `bun run typecheck` catches it HERE — instead of Task 6's
 * production wiring silently breaking with no failing test anywhere in this file.
 */
function _assertLlmRouterSatisfiesSynthesisRouter(router: LlmRouter): SynthesisRouter {
  return router;
}
void _assertLlmRouterSatisfiesSynthesisRouter;

// Stand-ins; shape only. `resolve` reports what the router would pick.
const localProvider = { providerId: "ollama", modelName: "llama3.2", isLocal: true } as const;
const remoteProvider = { providerId: "remote", modelName: "gpt-4o", isLocal: false } as const;

function fakeRouter(
  p: typeof localProvider | typeof remoteProvider | undefined,
  gen: () => Promise<string> = async () => "out",
): SynthesisRouter {
  return { resolveForSynthesis: async () => p, generateMarkdown: gen };
}

/**
 * A tiny counter object implementing only what `recordSynthesisEgress` touches: `query(...).get()`
 * (head-hash lookup, empty ledger → genesis) and `run(...)` (the INSERT). `onAppend`, when given,
 * runs before the row is counted — pass one that throws to simulate a `SQLITE_BUSY`-style append
 * failure. Cast through `unknown` deliberately: `Database` (bun:sqlite) declares only public
 * members, so TypeScript would otherwise require every method on the real class, not just the
 * two `recordSynthesisEgress` actually calls.
 */
function fakeDb(onAppend?: () => void): Database & { count: () => number } {
  let n = 0;
  const fake = {
    query: () => ({ get: () => null }),
    run: (..._args: unknown[]) => {
      onAppend?.();
      n += 1;
      return {} as unknown;
    },
    count: () => n,
  };
  return fake as unknown as Database & { count: () => number };
}

describe("buildSynthesisRunner", () => {
  test("off yields undefined regardless of provider", () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "off", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider),
      db: fakeDb(),
      briefKind: "why",
      now: () => 1,
    });
    expect(runner).toBeUndefined();
  });

  test("no provider resolved at all yields no_eligible_provider", async () => {
    const rows = fakeDb();
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(undefined),
      db: rows,
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt).toMatchObject({ ok: false, reason: "no_eligible_provider" });
    expect(rows.count()).toBe(0);
  });

  test("local REFUSES a remote provider — prefersLocal() is only a preference", async () => {
    const rows = fakeDb();
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider),
      db: rows,
      briefKind: "why",
      now: () => 1,
    });
    expect((await runner?.run("p"))?.ok).toBe(false);
    expect(rows.count()).toBe(0); // refused, and nothing ledgered
  });

  test("allow-remote appends exactly one model row BEFORE generating", async () => {
    const order: string[] = [];
    const rows = fakeDb(() => order.push("append"));
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => {
        order.push("generate");
        return "out";
      }),
      db: rows,
      briefKind: "why",
      now: () => 1,
    });
    await runner?.run("p");
    expect(order).toEqual(["append", "generate"]);
    expect(rows.count()).toBe(1);
  });

  test("a LOCAL provider under allow-remote appends nothing, and the runner still succeeds", async () => {
    const rows = fakeDb();
    // Observing `rows.count()` alone cannot catch a regression that moves the append call INTO a
    // non-local branch: `recordSynthesisEgress` already no-ops on a local provider, so a call that
    // never happens and a call that happens-and-no-ops are byte-identical by row count. This spy
    // observes the CALL itself (and the provider handed to it), which the row count cannot. See
    // the "an append failure" test above for the complementary case (mode "allow-remote", REMOTE
    // provider).
    const recordCalls: Array<{ readonly isLocal: boolean }> = [];
    const recordEgress: SynthesisEgressRecorder = (db, args) => {
      recordCalls.push({ isLocal: args.provider.isLocal });
      recordSynthesisEgress(db, args); // delegate to the real appender against the fake db
    };
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider),
      db: rows,
      briefKind: "why",
      now: () => 1,
      recordEgress,
    });
    const attempt = await runner?.run("p");
    // The brief text says "the runner still succeeds AND the ledger gains zero rows" — the first
    // half was missing from the original test, so a regression that early-returned `ok: false`
    // on this exact path would have passed silently.
    expect(attempt?.ok).toBe(true);
    expect(recordCalls).toEqual([{ isLocal: true }]);
    expect(rows.count()).toBe(0);
  });

  test("an append failure prevents the generate call entirely", async () => {
    let generated = false;
    const rows = fakeDb(() => {
      throw new Error("ledger down");
    });
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => {
        generated = true;
        return "out";
      }),
      db: rows,
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt?.ok).toBe(false);
    expect(generated).toBe(false);
  });

  // The next two tests pin that "timeout" and "provider_error" are genuinely distinguishable —
  // a hung (never-settling) provider must yield ONE of them, a rejecting provider the OTHER,
  // never the wrong label. The rejecting stub rejects SYNCHRONOUSLY (the returned promise is
  // already rejected the instant `generateMarkdown` returns, not after any delay), so there is
  // no timing dependence between the two outcomes: a promise rejection is always observed via a
  // microtask, which always drains before the next `setTimeout` macrotask fires, however small
  // `synthesisTimeoutMs` is. If a single stub could produce either verdict depending on
  // scheduling, THAT would be the racy test, not this one.

  test("a hung provider (never settles) resolves at the timeout — reason is timeout", async () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20 },
      router: fakeRouter(localProvider, () => new Promise<string>(() => {})),
      db: fakeDb(),
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt?.ok).toBe(false);
    expect(attempt).toMatchObject({ reason: "timeout" });
  });

  test("a provider that rejects synchronously yields provider_error, never timeout", async () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider, () => Promise.reject(new Error("network down"))),
      db: fakeDb(),
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt?.ok).toBe(false);
    expect(attempt).toMatchObject({ reason: "provider_error" });
    // `detail` passes through redactAuditPayload, which JSON-encodes a plain string — this
    // message carries no secret-shaped substring, so it survives unredacted except for that
    // quoting.
    expect((attempt as { detail?: string }).detail).toBe(JSON.stringify("network down"));
  });

  test("a provider_error detail is redacted — a leaked bearer token never reaches it raw", async () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider, () =>
        Promise.reject(
          new Error("upstream 401: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789"),
        ),
      ),
      db: fakeDb(),
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt).toMatchObject({ reason: "provider_error" });
    const detail = (attempt as { detail?: string }).detail ?? "";
    expect(detail).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(detail).toContain("[REDACTED]");
  });

  test("a non-Error rejection still yields a stringified provider_error detail", async () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20000 },
      // Exercises the non-`Error` `String(err)` arm of `redactedErrorDetail` — a real provider is
      // not guaranteed to reject with an `Error` instance.
      router: fakeRouter(localProvider, () => Promise.reject("plain string failure")),
      db: fakeDb(),
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt).toMatchObject({ reason: "provider_error" });
    expect((attempt as { detail?: string }).detail).toBe(JSON.stringify("plain string failure"));
  });

  test("calls resolveForSynthesis with preferLocal: true — independent of [llm].prefer_local", async () => {
    // Closes the gap a bare `router.resolveForSynthesis()` call would leave invisible: every other
    // test in this file uses `fakeRouter`, whose `resolveForSynthesis` ignores whatever argument it
    // receives (same shape as `router.test.ts`'s fakes), so NONE of them would fail if the
    // production call site silently dropped its `true` argument. This test observes the argument
    // itself, not just the router's return value.
    const receivedArgs: unknown[] = [];
    const router: SynthesisRouter = {
      resolveForSynthesis: async (preferLocal?: boolean) => {
        receivedArgs.push(preferLocal);
        return localProvider;
      },
      generateMarkdown: async () => "out",
    };
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20000 },
      router,
      db: fakeDb(),
      briefKind: "why",
      now: () => 1,
    });
    await runner?.run("p");
    expect(receivedArgs).toEqual([true]);
  });
});
