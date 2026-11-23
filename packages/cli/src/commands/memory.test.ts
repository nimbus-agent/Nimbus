import { describe, expect, test } from "bun:test";

import { type MemoryIpc, parseMemoryArgs, runMemoryWith } from "./memory.ts";

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
}

const reply = {
  enabled: true,
  retentionDays: 90,
  pendingTurns: 2,
  memories: [
    {
      id: "mem_0123456789abcdef",
      sessionId: "s",
      summary: "line one\u001b[31m red\nline two",
      turnCount: 3,
      endedAt: 1,
      createdAt: Date.UTC(2026, 10, 20, 9, 30),
      embedded: false,
    },
  ],
};

describe("parseMemoryArgs", () => {
  test("accepts list, list --json, forget <id> and forget --all only", () => {
    expect(parseMemoryArgs(["list"])).toEqual({ mode: "list", json: false });
    expect(parseMemoryArgs(["list", "--json"])).toEqual({ mode: "list", json: true });
    expect(parseMemoryArgs(["forget", "mem_0123456789abcdef"])).toEqual({
      mode: "forget",
      id: "mem_0123456789abcdef",
    });
    expect(parseMemoryArgs(["forget", "--all"])).toEqual({ mode: "forgetAll" });
    for (const bad of [
      [],
      ["forget"],
      ["forget", "x"],
      ["list", "--all"],
      ["wipe"],
      ["list", "--json", "x"],
    ]) {
      expect(parseMemoryArgs(bad)).toBeUndefined();
    }
  });
});

describe("runMemoryWith", () => {
  test("list prints the state and each memory with control characters stripped", async () => {
    const o = sink();
    const c: MemoryIpc = { call: async () => reply };
    expect(await runMemoryWith(c, { mode: "list", json: false }, o.s)).toBe(0);
    const text = o.out.join("");
    expect(text).toContain("Episodic memory is ON");
    expect(text).toContain("mem_0123456789abcdef  2026-11-20 09:30Z  3 turn(s)  (not embedded)");
    expect(text).toContain("  line two");
    expect(text).not.toContain("\u001b");
  });

  test("list --json prints the reply as one JSON line; an empty list says so", async () => {
    const o = sink();
    await runMemoryWith({ call: async () => reply }, { mode: "list", json: true }, o.s);
    expect(JSON.parse(o.out.join(""))).toEqual(reply);
    const e = sink();
    await runMemoryWith(
      { call: async () => ({ ...reply, memories: [], enabled: false }) },
      { mode: "list", json: false },
      e.s,
    );
    expect(e.out.join("")).toContain("OFF");
    expect(e.out.join("")).toContain("No memories stored.");
  });

  test("forget by id reports a hit and a miss (exit 1); forget --all reports the count", async () => {
    const calls: unknown[] = [];
    const mk = (n: number): MemoryIpc => ({
      call: async (m, p) => {
        calls.push([m, p]);
        return { forgotten: n };
      },
    });
    const a = sink();
    expect(await runMemoryWith(mk(1), { mode: "forget", id: "mem_0123456789abcdef" }, a.s)).toBe(0);
    expect(a.out.join("")).toContain("Forgot mem_0123456789abcdef.");
    const b = sink();
    expect(await runMemoryWith(mk(0), { mode: "forget", id: "mem_0123456789abcdef" }, b.s)).toBe(1);
    expect(b.err.join("")).toContain("No memory with id");
    const c = sink();
    expect(await runMemoryWith(mk(2), { mode: "forgetAll" }, c.s)).toBe(0);
    expect(c.out.join("")).toContain("Forgot 2 memories");
    const d = sink();
    await runMemoryWith(mk(1), { mode: "forgetAll" }, d.s);
    expect(d.out.join("")).toContain("Forgot 1 memory ");
    expect(calls[0]).toEqual(["memory.forget", { id: "mem_0123456789abcdef" }]);
    expect(calls.at(-1)).toEqual(["memory.forget", { all: true }]);
  });

  test("a gateway error is printed (control characters stripped) and exits 1", async () => {
    const o = sink();
    const c: MemoryIpc = {
      call: async () => {
        throw new Error("ERR_MEMORY_UNAVAILABLE\u001b[2J");
      },
    };
    expect(await runMemoryWith(c, { mode: "list", json: false }, o.s)).toBe(1);
    expect(o.err.join("")).toContain("ERR_MEMORY_UNAVAILABLE");
    expect(o.err.join("")).not.toContain("\u001b");
  });
});
