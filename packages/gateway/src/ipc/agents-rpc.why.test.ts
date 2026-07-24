import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "./agents-rpc.ts";

function makeCtx(db: Database) {
  return {
    db,
    notify: mock(() => {}),
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/**
 * Polls a ctx.notify mock until `eventName` is observed or the deadline passes.
 * Mirrors the harness in agents-rpc.test.ts's waitForNotify.
 */
async function waitForNotify(
  notify: unknown,
  eventNames: readonly string[],
  timeoutMs = 5_000,
): Promise<boolean> {
  // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
  const calls = (notify as ReturnType<typeof mock>).mock.calls;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calls.some((c) => eventNames.includes(c[0] as string))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("dispatchAgentsRpc — agents.why", () => {
  test("agents.why returns a sessionId synchronously", async () => {
    const out = await dispatchAgentsRpc("agents.why", { ref: "src/a.ts:1" }, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(typeof v.sessionId).toBe("string");
      expect(v.sessionId.length).toBeGreaterThan(0);
    }
  });

  test("agents.why rejects an empty object payload", async () => {
    await expect(dispatchAgentsRpc("agents.why", {}, makeCtx(freshDb()))).rejects.toBeInstanceOf(
      AgentsRpcError,
    );
    await expect(dispatchAgentsRpc("agents.why", {}, makeCtx(freshDb()))).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("agents.why rejects a non-string ref ({ ref: 42 })", async () => {
    await expect(
      dispatchAgentsRpc("agents.why", { ref: 42 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("agents.why rejects null params", async () => {
    await expect(dispatchAgentsRpc("agents.why", null, makeCtx(freshDb()))).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("agents.why rejects an oversized ref (>1024 chars)", async () => {
    await expect(
      dispatchAgentsRpc("agents.why", { ref: "a".repeat(1025) }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("agents.why rejects a non-positive-integer line", async () => {
    await expect(
      dispatchAgentsRpc("agents.why", { ref: "src/a.ts", line: 0 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
    await expect(
      dispatchAgentsRpc("agents.why", { ref: "src/a.ts", line: 1.5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
    await expect(
      dispatchAgentsRpc("agents.why", { ref: "src/a.ts", line: -1 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("agents.why eventually emits why.briefReady or why.briefError", async () => {
    const ctx = makeCtx(freshDb());
    await dispatchAgentsRpc("agents.why", { ref: "src/a.ts:1" }, ctx);
    expect(await waitForNotify(ctx.notify, ["why.briefReady", "why.briefError"])).toBe(true);
  });

  test("agents.why rejects a whitespace-only ref", async () => {
    await expect(
      dispatchAgentsRpc("agents.why", { ref: "   " }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });
});

describe("dispatchAgentsRpc — agents.whyPeek", () => {
  test("agents.whyPeek with a valid ref returns a WhyPeek payload synchronously, not a sessionId", async () => {
    const out = await dispatchAgentsRpc(
      "agents.whyPeek",
      { ref: "src/a.ts:1" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as Record<string, unknown>;
      expect(v).not.toHaveProperty("sessionId");
      expect(v).toHaveProperty("subject");
      expect(v).toHaveProperty("author");
      expect(v).toHaveProperty("commitSha");
      expect(v).toHaveProperty("pr");
      expect(v).toHaveProperty("ticket");
      expect(v).toHaveProperty("hasMore");
    }
  });

  test("agents.whyPeek on an unresolvable ref returns nulls (valid, no roots configured)", async () => {
    const out = await dispatchAgentsRpc(
      "agents.whyPeek",
      { ref: "src/unresolvable.ts:1" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { subject: unknown; hasMore: boolean };
      expect(v.subject).toBeNull();
      expect(v.hasMore).toBe(false);
    }
  });

  test("agents.whyPeek malformed params ({}) → -32602", async () => {
    await expect(dispatchAgentsRpc("agents.whyPeek", {}, makeCtx(freshDb()))).rejects.toMatchObject(
      {
        rpcCode: -32602,
      },
    );
  });

  test("agents.whyPeek malformed params (array) → -32602", async () => {
    await expect(
      dispatchAgentsRpc("agents.whyPeek", ["not", "an", "object"], makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("agents.whyPeek malformed params (null) → -32602", async () => {
    await expect(
      dispatchAgentsRpc("agents.whyPeek", null, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
    });
  });

  test("agents.whyPeek never emits any notification (synchronous, no briefReady)", async () => {
    const ctx = makeCtx(freshDb());
    await dispatchAgentsRpc("agents.whyPeek", { ref: "src/a.ts:1" }, ctx);
    // Give any accidental async notify a chance to fire before asserting silence.
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.notify.mock.calls).toHaveLength(0);
  });

  test("agents.whyPeek trims a whitespace-padded ref and resolves like the trimmed value", async () => {
    const out = await dispatchAgentsRpc(
      "agents.whyPeek",
      { ref: "  src/a.ts:1  " },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as Record<string, unknown>;
      expect(v).not.toHaveProperty("sessionId");
      expect(v).toHaveProperty("subject");
      expect(v).toHaveProperty("author");
      expect(v).toHaveProperty("commitSha");
      expect(v).toHaveProperty("pr");
      expect(v).toHaveProperty("ticket");
      expect(v).toHaveProperty("hasMore");
    }
  });
});
