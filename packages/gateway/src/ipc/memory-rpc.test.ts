import { describe, expect, test } from "bun:test";
import { captureLlm, makeMemory, migratedDb } from "../memory/episodic.test-helpers.ts";
import { IDLE_MS } from "../memory/episodic-memory.ts";
import { checkLanMethodAllowed } from "./lan-rpc.ts";
import {
  dispatchMemoryRpc,
  MEMORY_BAD_PARAMS,
  MEMORY_FORBIDDEN_CLIENT,
  MEMORY_UNAVAILABLE,
  MemoryRpcError,
} from "./memory-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

async function seeded() {
  const c = { t: 1_000_000 };
  const { memory } = makeMemory({
    db: migratedDb(),
    llm: captureLlm("a note about the release"),
    now: () => c.t,
  });
  memory.recordOwnerTurn("s", "the release", "ok");
  c.t += IDLE_MS + 1;
  await memory.sweep();
  return memory;
}

async function codeOf(p: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof MemoryRpcError) return { code: e.rpcCode, message: e.message };
    throw e;
  }
  throw new Error("expected an error");
}

const call = (
  memory: Awaited<ReturnType<typeof seeded>> | undefined,
  kind: ClientKind,
  method: string,
  params: unknown,
) => dispatchMemoryRpc(method, params, { memory: () => memory }, { kind });

describe("memory.* (owner kinds only, OR-S4-MEM)", () => {
  test("list answers a cli and a ui connection, with the config and the stored memories", async () => {
    const memory = await seeded();
    for (const kind of ["cli", "ui"] as const) {
      const out = await call(memory, kind, "memory.list", {});
      expect(out.kind).toBe("hit");
      const v = (out as { value: { enabled: boolean; memories: Array<{ summary: string }> } })
        .value;
      expect(v.enabled).toBe(true);
      expect(v.memories[0]?.summary).toBe("a note about the release");
    }
  });

  test("every other kind is refused before anything is read", async () => {
    const memory = await seeded();
    for (const kind of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
      for (const method of ["memory.list", "memory.forget"]) {
        const e = await codeOf(call(memory, kind, method, { all: true }));
        expect(e).toEqual({ code: -32000, message: MEMORY_FORBIDDEN_CLIENT });
      }
    }
    expect(memory.list(5)).toHaveLength(1);
  });

  test("a gateway with no memory (a demo root) refuses", async () => {
    const e = await codeOf(call(undefined, "cli", "memory.list", {}));
    expect(e).toEqual({ code: -32000, message: MEMORY_UNAVAILABLE });
  });

  test("forget removes one memory by its id, or every memory with { all: true }", async () => {
    const memory = await seeded();
    const id = memory.list(1)[0]?.id as string;
    expect(await call(memory, "cli", "memory.forget", { id: "mem_0000000000000000" })).toEqual({
      kind: "hit",
      value: { forgotten: 0 },
    });
    expect(await call(memory, "cli", "memory.forget", { id })).toEqual({
      kind: "hit",
      value: { forgotten: 1 },
    });
    const again = await seeded();
    expect(await call(again, "ui", "memory.forget", { all: true })).toEqual({
      kind: "hit",
      value: { forgotten: 1 },
    });
  });

  test("bad parameters are -32602", async () => {
    const memory = await seeded();
    for (const bad of [
      undefined,
      null,
      {},
      { id: "x" },
      { all: false },
      { all: true, id: "mem_0000000000000000" },
      { id: 5 },
    ]) {
      const e = await codeOf(call(memory, "cli", "memory.forget", bad));
      expect(e).toEqual({ code: -32602, message: MEMORY_BAD_PARAMS });
    }
    for (const limit of [0, 501, 1.5, "5"]) {
      expect((await codeOf(call(memory, "cli", "memory.list", { limit }))).code).toBe(-32602);
    }
    expect((await call(memory, "cli", "memory.list", { limit: 5 })).kind).toBe("hit");
  });

  test("an unknown method in the namespace is a miss", async () => {
    expect(await call(await seeded(), "cli", "memory.nope", {})).toEqual({ kind: "miss" });
  });

  test("the whole namespace is forbidden over the LAN (I5)", () => {
    for (const m of ["memory.list", "memory.forget", "memory.anything"]) {
      expect(() => checkLanMethodAllowed(m, { peerId: "p", writeAllowed: true })).toThrow(
        /not callable over LAN/,
      );
    }
  });
});
