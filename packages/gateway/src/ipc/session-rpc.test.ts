import { describe, expect, test } from "bun:test";
import type {
  SessionChunk,
  SessionMemoryRecallHit,
  SessionMemoryStore,
} from "../memory/session-memory-store.ts";
import { dispatchSessionRpc, SessionRpcError } from "./session-rpc.ts";

type AppendCall = SessionChunk;
type RecallCall = { sessionId: string; query: string; topK: number };

type StubStore = {
  store: SessionMemoryStore;
  appendCalls: AppendCall[];
  recallCalls: RecallCall[];
  deleted: string[];
  listed: number;
  setSessions: (
    rows: Array<{ sessionId: string; lastWriteAt: number; chunkCount: number }>,
  ) => void;
  setRecallResult: (hits: SessionMemoryRecallHit[]) => void;
};

function makeStubStore(): StubStore {
  const appendCalls: AppendCall[] = [];
  const recallCalls: RecallCall[] = [];
  const deleted: string[] = [];
  let listed = 0;
  let sessions: Array<{ sessionId: string; lastWriteAt: number; chunkCount: number }> = [];
  let recallHits: SessionMemoryRecallHit[] = [];
  const stub = {
    async append(chunk: SessionChunk): Promise<void> {
      appendCalls.push(chunk);
    },
    async recall(sessionId: string, query: string, topK = 8): Promise<SessionMemoryRecallHit[]> {
      recallCalls.push({ sessionId, query, topK });
      return recallHits;
    },
    deleteSession(sessionId: string): void {
      deleted.push(sessionId);
    },
    listSessions(): Array<{ sessionId: string; lastWriteAt: number; chunkCount: number }> {
      listed += 1;
      return sessions;
    },
  };
  return {
    store: stub,
    appendCalls,
    recallCalls,
    deleted,
    get listed() {
      return listed;
    },
    setSessions(rows): void {
      sessions = rows;
    },
    setRecallResult(hits): void {
      recallHits = hits;
    },
  } as StubStore;
}

describe("SessionRpcError", () => {
  test("carries rpcCode + name + message", () => {
    const err = new SessionRpcError(-32602, "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionRpcError");
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("boom");
  });
});

describe("dispatchSessionRpc — unknown method", () => {
  test("returns kind:miss for any method outside session.*", async () => {
    const stub = makeStubStore();
    const result = await dispatchSessionRpc({
      method: "engine.ask",
      params: {},
      store: stub.store,
    });
    expect(result).toEqual({ kind: "miss" });
  });

  test("returns kind:miss for unknown session.* method", async () => {
    const stub = makeStubStore();
    const result = await dispatchSessionRpc({
      method: "session.unknown",
      params: {},
      store: stub.store,
    });
    expect(result).toEqual({ kind: "miss" });
  });
});

describe("session.append", () => {
  test("happy path: records chunk with createdAt~now", async () => {
    const stub = makeStubStore();
    const before = Date.now();
    const result = await dispatchSessionRpc({
      method: "session.append",
      params: { sessionId: "sess-1", chunkText: "hello", role: "user" },
      store: stub.store,
    });
    const after = Date.now();
    expect(result).toEqual({ kind: "hit", value: { ok: true } });
    expect(stub.appendCalls).toHaveLength(1);
    expect(stub.appendCalls[0]?.sessionId).toBe("sess-1");
    expect(stub.appendCalls[0]?.text).toBe("hello");
    expect(stub.appendCalls[0]?.role).toBe("user");
    expect(stub.appendCalls[0]?.createdAt).toBeGreaterThanOrEqual(before);
    expect(stub.appendCalls[0]?.createdAt).toBeLessThanOrEqual(after);
  });

  test("trims whitespace from sessionId, chunkText, and role", async () => {
    const stub = makeStubStore();
    await dispatchSessionRpc({
      method: "session.append",
      params: { sessionId: "  sess-1  ", chunkText: "  text  ", role: "  user  " },
      store: stub.store,
    });
    expect(stub.appendCalls[0]?.sessionId).toBe("sess-1");
    expect(stub.appendCalls[0]?.text).toBe("text");
    expect(stub.appendCalls[0]?.role).toBe("user");
  });

  test("accepts roles user / assistant / tool", async () => {
    const stub = makeStubStore();
    for (const role of ["user", "assistant", "tool"] as const) {
      await dispatchSessionRpc({
        method: "session.append",
        params: { sessionId: "s", chunkText: "t", role },
        store: stub.store,
      });
    }
    expect(stub.appendCalls.map((c) => c.role)).toEqual(["user", "assistant", "tool"]);
  });

  test("missing sessionId throws -32602", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.append",
        params: { chunkText: "x", role: "user" },
        store: stub.store,
      }),
    ).rejects.toThrow(SessionRpcError);
  });

  test("missing chunkText throws -32602", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.append",
        params: { sessionId: "s", role: "user" },
        store: stub.store,
      }),
    ).rejects.toThrow(/Missing or invalid chunkText/);
  });

  test("whitespace-only sessionId throws -32602", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.append",
        params: { sessionId: "   ", chunkText: "x", role: "user" },
        store: stub.store,
      }),
    ).rejects.toThrow(/Missing or invalid sessionId/);
  });

  test("non-string sessionId throws -32602", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.append",
        params: { sessionId: 123, chunkText: "x", role: "user" },
        store: stub.store,
      }),
    ).rejects.toThrow(/Missing or invalid sessionId/);
  });

  test("invalid role surfaces specific error message", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.append",
        params: { sessionId: "s", chunkText: "x", role: "system" },
        store: stub.store,
      }),
    ).rejects.toThrow("role must be user, assistant, or tool");
  });

  test("undefined params object throws -32602 on first required field", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.append",
        params: undefined,
        store: stub.store,
      }),
    ).rejects.toThrow(/Missing or invalid sessionId/);
  });

  test("non-object params (e.g. array) throws -32602", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.append",
        params: ["sess-1", "hello", "user"],
        store: stub.store,
      }),
    ).rejects.toThrow(SessionRpcError);
  });

  test("rpc code on validation error is -32602", async () => {
    const stub = makeStubStore();
    try {
      await dispatchSessionRpc({
        method: "session.append",
        params: { sessionId: "", chunkText: "x", role: "user" },
        store: stub.store,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionRpcError);
      expect((err as SessionRpcError).rpcCode).toBe(-32602);
    }
  });
});

describe("session.recall", () => {
  test("returns the chunks the store yields", async () => {
    const stub = makeStubStore();
    const hit: SessionMemoryRecallHit = {
      chunkText: "h",
      role: "user",
      createdAt: 1,
      distance: 0.1,
    };
    stub.setRecallResult([hit]);
    const result = await dispatchSessionRpc({
      method: "session.recall",
      params: { sessionId: "s", query: "q" },
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { chunks: [hit] } });
  });

  test("defaults topK to 8 when not provided", async () => {
    const stub = makeStubStore();
    await dispatchSessionRpc({
      method: "session.recall",
      params: { sessionId: "s", query: "q" },
      store: stub.store,
    });
    expect(stub.recallCalls[0]?.topK).toBe(8);
  });

  test.each([
    ["clamps topK to upper bound 32", 999, 32],
    ["clamps topK to lower bound 1", 0, 1],
    ["floors fractional topK", 5.9, 5],
  ])("%s", async (_label, topK, expected) => {
    const stub = makeStubStore();
    await dispatchSessionRpc({
      method: "session.recall",
      params: { sessionId: "s", query: "q", topK },
      store: stub.store,
    });
    expect(stub.recallCalls[0]?.topK).toBe(expected);
  });

  test("non-finite topK (NaN, Infinity) falls back to default 8", async () => {
    const stub = makeStubStore();
    await dispatchSessionRpc({
      method: "session.recall",
      params: { sessionId: "s", query: "q", topK: Number.NaN },
      store: stub.store,
    });
    expect(stub.recallCalls[0]?.topK).toBe(8);

    await dispatchSessionRpc({
      method: "session.recall",
      params: { sessionId: "s", query: "q", topK: Number.POSITIVE_INFINITY },
      store: stub.store,
    });
    expect(stub.recallCalls[1]?.topK).toBe(8);
  });

  test("non-number topK (string) falls back to default 8", async () => {
    const stub = makeStubStore();
    await dispatchSessionRpc({
      method: "session.recall",
      params: { sessionId: "s", query: "q", topK: "16" },
      store: stub.store,
    });
    expect(stub.recallCalls[0]?.topK).toBe(8);
  });

  test("missing query throws -32602", async () => {
    const stub = makeStubStore();
    await expect(
      dispatchSessionRpc({
        method: "session.recall",
        params: { sessionId: "s" },
        store: stub.store,
      }),
    ).rejects.toThrow(/Missing or invalid query/);
  });
});

describe("session.list", () => {
  test("returns the store's sessions list verbatim", async () => {
    const stub = makeStubStore();
    const rows = [
      { sessionId: "a", lastWriteAt: 100, chunkCount: 2 },
      { sessionId: "b", lastWriteAt: 200, chunkCount: 5 },
    ];
    stub.setSessions(rows);
    const result = await dispatchSessionRpc({
      method: "session.list",
      params: {},
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { sessions: rows } });
    expect(stub.listed).toBe(1);
  });

  test("returns empty list when the store is empty", async () => {
    const stub = makeStubStore();
    const result = await dispatchSessionRpc({
      method: "session.list",
      params: {},
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { sessions: [] } });
  });
});

describe("session.clear", () => {
  test("deletes a specific session when sessionId is provided", async () => {
    const stub = makeStubStore();
    stub.setSessions([
      { sessionId: "keep", lastWriteAt: 1, chunkCount: 1 },
      { sessionId: "drop", lastWriteAt: 2, chunkCount: 1 },
    ]);
    const result = await dispatchSessionRpc({
      method: "session.clear",
      params: { sessionId: "drop" },
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { ok: true, cleared: "drop" } });
    expect(stub.deleted).toEqual(["drop"]);
  });

  test("trims whitespace before deleting a specific session", async () => {
    const stub = makeStubStore();
    await dispatchSessionRpc({
      method: "session.clear",
      params: { sessionId: "  abc  " },
      store: stub.store,
    });
    expect(stub.deleted).toEqual(["abc"]);
  });

  test("clears all sessions when sessionId is missing", async () => {
    const stub = makeStubStore();
    stub.setSessions([
      { sessionId: "a", lastWriteAt: 1, chunkCount: 1 },
      { sessionId: "b", lastWriteAt: 2, chunkCount: 1 },
    ]);
    const result = await dispatchSessionRpc({
      method: "session.clear",
      params: {},
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { ok: true, cleared: "all" } });
    expect(stub.deleted).toEqual(["a", "b"]);
  });

  test("clears all sessions when sessionId is whitespace-only", async () => {
    const stub = makeStubStore();
    stub.setSessions([{ sessionId: "x", lastWriteAt: 1, chunkCount: 1 }]);
    const result = await dispatchSessionRpc({
      method: "session.clear",
      params: { sessionId: "   " },
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { ok: true, cleared: "all" } });
    expect(stub.deleted).toEqual(["x"]);
  });

  test("clears all sessions when params is undefined", async () => {
    const stub = makeStubStore();
    stub.setSessions([{ sessionId: "only", lastWriteAt: 1, chunkCount: 1 }]);
    const result = await dispatchSessionRpc({
      method: "session.clear",
      params: undefined,
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { ok: true, cleared: "all" } });
    expect(stub.deleted).toEqual(["only"]);
  });

  test("clear-all on empty store returns ok with cleared:all and deletes nothing", async () => {
    const stub = makeStubStore();
    const result = await dispatchSessionRpc({
      method: "session.clear",
      params: {},
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { ok: true, cleared: "all" } });
    expect(stub.deleted).toEqual([]);
  });

  test("non-string sessionId param falls through to clear-all", async () => {
    const stub = makeStubStore();
    stub.setSessions([{ sessionId: "only", lastWriteAt: 1, chunkCount: 1 }]);
    const result = await dispatchSessionRpc({
      method: "session.clear",
      params: { sessionId: 42 },
      store: stub.store,
    });
    expect(result).toEqual({ kind: "hit", value: { ok: true, cleared: "all" } });
    expect(stub.deleted).toEqual(["only"]);
  });
});
