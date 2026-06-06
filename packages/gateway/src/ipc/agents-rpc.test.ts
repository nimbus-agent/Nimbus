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

describe("dispatchAgentsRpc", () => {
  test("returns kind:miss for unknown methods", async () => {
    const out = await dispatchAgentsRpc("agents.unknown", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("miss");
  });

  test("agents.expert returns a sessionId synchronously", async () => {
    const out = await dispatchAgentsRpc(
      "agents.expert",
      { topicOrFile: "src/x.ts" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(typeof v.sessionId).toBe("string");
      expect(v.sessionId.length).toBeGreaterThan(0);
    }
  });

  test("agents.expert validates topicOrFile is a non-empty string", async () => {
    await expect(
      dispatchAgentsRpc("agents.expert", { topicOrFile: "" }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
    await expect(dispatchAgentsRpc("agents.expert", {}, makeCtx(freshDb()))).rejects.toBeInstanceOf(
      AgentsRpcError,
    );
  });

  test("agents.expert rejects array payloads with the requires-object message", async () => {
    await expect(
      dispatchAgentsRpc("agents.expert", ["not", "an", "object"], makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("requires { topicOrFile: string }"),
    });
  });

  test("agents.expert eventually emits expert.briefReady", async () => {
    const ctx = makeCtx(freshDb());
    await dispatchAgentsRpc("agents.expert", { topicOrFile: "x" }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
    const briefReady = calls.find((c) => c[0] === "expert.briefReady");
    expect(briefReady).toBeDefined();
  });
});

describe("dispatchAgentsRpc — agents.impact", () => {
  test("agents.impact returns a sessionId synchronously", async () => {
    const out = await dispatchAgentsRpc(
      "agents.impact",
      { fileOrPrUrl: "src/x.ts" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(typeof v.sessionId).toBe("string");
      expect(v.sessionId.length).toBeGreaterThan(0);
    }
  });

  test("agents.impact validates fileOrPrUrl is a non-empty string", async () => {
    await expect(
      dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "" }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
    await expect(dispatchAgentsRpc("agents.impact", {}, makeCtx(freshDb()))).rejects.toBeInstanceOf(
      AgentsRpcError,
    );
  });

  test("agents.impact rejects array payloads with a clear message", async () => {
    await expect(
      dispatchAgentsRpc("agents.impact", ["not", "an", "object"], makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("requires { fileOrPrUrl: string }"),
    });
  });

  test("agents.impact validates depth is an integer in 1..5", async () => {
    await expect(
      dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "x", depth: 0 }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
    await expect(
      dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "x", depth: 6 }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
  });

  test("agents.impact validates service if provided is a non-empty string", async () => {
    await expect(
      dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "x", service: "" }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
  });

  test("agents.impact eventually emits impact.briefReady", async () => {
    const ctx = makeCtx(freshDb());
    await dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "x" }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
    const briefReady = calls.find((c) => c[0] === "impact.briefReady");
    expect(briefReady).toBeDefined();
  });
});

describe("dispatchAgentsRpc — agents.catchup", () => {
  test("agents.catchup returns a sessionId synchronously", async () => {
    const out = await dispatchAgentsRpc("agents.catchup", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(typeof v.sessionId).toBe("string");
      expect(v.sessionId.length).toBeGreaterThan(0);
    }
  });

  test("agents.catchup accepts an empty object (defaults to sinceMs = 3 days)", async () => {
    const out = await dispatchAgentsRpc("agents.catchup", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("agents.catchup rejects array payloads with a clear message", async () => {
    await expect(
      dispatchAgentsRpc("agents.catchup", ["not", "an", "object"], makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("requires an object payload"),
    });
  });

  test("agents.catchup validates sinceMs is a non-negative integer ≤ 90 days", async () => {
    await expect(
      dispatchAgentsRpc("agents.catchup", { sinceMs: -1 }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
    await expect(
      dispatchAgentsRpc(
        "agents.catchup",
        { sinceMs: 91 * 24 * 60 * 60 * 1000 },
        makeCtx(freshDb()),
      ),
    ).rejects.toBeInstanceOf(AgentsRpcError);
    await expect(
      dispatchAgentsRpc("agents.catchup", { sinceMs: 1.5 }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
  });

  test("agents.catchup validates service if provided is a non-empty string ≤ 64 chars", async () => {
    await expect(
      dispatchAgentsRpc("agents.catchup", { service: "" }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
    await expect(
      dispatchAgentsRpc("agents.catchup", { service: "x".repeat(65) }, makeCtx(freshDb())),
    ).rejects.toBeInstanceOf(AgentsRpcError);
  });

  test("agents.catchup eventually emits catchup.briefReady", async () => {
    const ctx = makeCtx(freshDb());
    await dispatchAgentsRpc("agents.catchup", {}, ctx);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
      if (calls.find((c) => c[0] === "catchup.briefReady") !== undefined) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
    const briefReady = calls.find((c) => c[0] === "catchup.briefReady");
    expect(briefReady).toBeDefined();
  });
});
