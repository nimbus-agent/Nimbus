// packages/gateway/src/agents/_lib/synthesis-llm.test.ts
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
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

  test("any appends exactly one model row BEFORE generating", async () => {
    const order: string[] = [];
    const rows = fakeDb(() => order.push("append"));
    const runner = buildSynthesisRunner({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
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

  test("a LOCAL provider under any appends nothing", async () => {
    const rows = fakeDb();
    const runner = buildSynthesisRunner({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider),
      db: rows,
      briefKind: "why",
      now: () => 1,
    });
    await runner?.run("p");
    expect(rows.count()).toBe(0);
  });

  test("an append failure prevents the generate call entirely", async () => {
    let generated = false;
    const rows = fakeDb(() => {
      throw new Error("ledger down");
    });
    const runner = buildSynthesisRunner({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
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
});
