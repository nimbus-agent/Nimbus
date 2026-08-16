// packages/gateway/src/agents/_lib/synthesis-llm.test.ts
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { buildSynthesisRunner, type SynthesisRouter } from "./synthesis-llm.ts";

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

  test("a hung provider resolves null at the timeout instead of hanging", async () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20 },
      router: fakeRouter(localProvider, () => new Promise<string>(() => {})),
      db: fakeDb(),
      briefKind: "why",
      now: () => 1,
    });
    expect((await runner?.run("p"))?.ok).toBe(false);
  });
});
