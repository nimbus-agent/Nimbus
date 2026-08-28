// packages/gateway/src/agents/_lib/synthesis-llm.test.ts
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EgressAppendFailedError } from "../../egress/model-egress.ts";
import type { LlmRouter } from "../../llm/router.ts";
import { buildSynthesisRunner, type SynthesisRouter } from "./synthesis-llm.ts";

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
 * A tiny counter object standing in for `SynthesisLlmDeps.db`. Since the `model` append moved
 * into `wrapLedgeredProvider` (`egress/model-egress.ts`), `buildSynthesisRunner` no longer
 * touches the db at all — so `count()` here is now a REGRESSION GUARD rather than an assertion
 * about the appender: it must stay 0 on every path, and a non-zero reading means someone
 * re-introduced a call-site append that would double-count against the wrapper. Cast through
 * `unknown` deliberately: `Database` (bun:sqlite) declares only public members, so TypeScript
 * would otherwise require every method on the real class.
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

  test("allow-remote generates, and appends NOTHING from this call site", async () => {
    // The append moved into the provider wrapper. This site must not also append -- a
    // re-introduced call-site append would double-count every remote synthesis against the
    // wrapper's row. Append-before-generate ordering is proven where it now lives:
    // `egress/model-egress.test.ts`.
    const rows = fakeDb();
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => "out"),
      db: rows,
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt).toMatchObject({ ok: true, markdown: "out", remote: true });
    expect(rows.count()).toBe(0);
  });

  test("a LOCAL provider under allow-remote succeeds and reports remote: false", async () => {
    // The local/remote SPLIT is no longer decided here -- `wrapLedgeredProvider` derives it
    // from `provider.isLocal`, and a local provider is returned unwrapped, so no row exists to
    // count (`egress/model-egress.test.ts` proves that half). What this site still owns is the
    // `remote` flag it reports back on the attempt, and that it does not refuse a local
    // provider under `allow-remote` -- a regression that early-returned `ok: false` on this
    // exact path would otherwise pass silently.
    const rows = fakeDb();
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider),
      db: rows,
      briefKind: "why",
      now: () => 1,
    });
    const attempt = await runner?.run("p");
    expect(attempt).toMatchObject({ ok: true, remote: false });
    expect(rows.count()).toBe(0);
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

describe("buildSynthesisRunner — the append now lives in the provider wrapper", () => {
  test("a failed ledger append surfaces as egress_append_failed, not provider_error", async () => {
    // These two are kept apart because `detail` reaches the user on `briefReady`. Sending
    // someone to their model config for a database problem is a false diagnosis. The append
    // moved into `egress/model-egress.ts`, so its failure now arrives here as a REJECTION
    // from `generateMarkdown` rather than a local throw -- preserved by TYPE, not by branch.
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => {
        throw new EgressAppendFailedError(new Error("table missing"));
      }),
      db: fakeDb(),
      briefKind: "catchup",
      now: () => 0,
    });

    expect(await runner?.run("p")).toMatchObject({
      ok: false,
      reason: "egress_append_failed",
    });
  });

  test("an ordinary provider rejection is still provider_error", async () => {
    // The guard above must key on the ERROR TYPE, not swallow every rejection.
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => {
        throw new Error("401 unauthorized");
      }),
      db: fakeDb(),
      briefKind: "catchup",
      now: () => 0,
    });

    expect(await runner?.run("p")).toMatchObject({ ok: false, reason: "provider_error" });
  });

  test("the synthesis call names its own brief kind as the ledger method", async () => {
    // Without this, every model row would read `llm.generate.reasoning` and `nimbus prove`
    // could no longer say which brief sent what.
    const seen: Array<string | undefined> = [];
    const runner = buildSynthesisRunner({
      config: { synthesis: "allow-remote", synthesisTimeoutMs: 20000 },
      router: {
        resolveForSynthesis: async () => remoteProvider,
        generateMarkdown: async (_p, _r, egressMethod) => {
          seen.push(egressMethod);
          return "# brief";
        },
      },
      db: fakeDb(),
      briefKind: "catchup",
      now: () => 0,
    });

    await runner?.run("p");
    expect(seen).toEqual(["agents.catchup.synthesis"]);
  });
});
