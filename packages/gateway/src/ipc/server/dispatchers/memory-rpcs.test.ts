import { describe, expect, test } from "bun:test";

import { captureLlm, makeMemory, migratedDb } from "../../../memory/episodic.test-helpers.ts";
import type { ClientKind } from "../client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";
import { tryDispatchMemoryRpc } from "./memory-rpcs.ts";

function ctxOf(kind: ClientKind, withMemory: boolean): ServerCtx {
  const { memory } = makeMemory({ db: migratedDb(), llm: captureLlm("x") });
  return {
    options: { sessionMemoryStore: withMemory ? { episodic: memory } : {} },
    getClientKind: () => kind,
  } as unknown as ServerCtx;
}

describe("tryDispatchMemoryRpc", () => {
  test("skips a method outside the namespace and an unknown one in it", async () => {
    expect(await tryDispatchMemoryRpc(ctxOf("cli", true), "session.list", {}, "c")).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchMemoryRpc(ctxOf("cli", true), "memory.nope", {}, "c")).toBe(
      phase4RpcSkipped,
    );
  });

  test("answers the owner's connection", async () => {
    const out = (await tryDispatchMemoryRpc(ctxOf("cli", true), "memory.list", {}, "c")) as {
      enabled: boolean;
    };
    expect(out.enabled).toBe(true);
  });

  test("remaps a domain error for a foreign kind and for a gateway with no memory", async () => {
    for (const [kind, withMemory, code] of [
      ["mcp", true, -32000],
      ["cli", false, -32000],
    ] as const) {
      const e = await tryDispatchMemoryRpc(ctxOf(kind, withMemory), "memory.list", {}, "c").then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(RpcMethodError);
      expect((e as RpcMethodError).rpcCode).toBe(code);
    }
  });
});
