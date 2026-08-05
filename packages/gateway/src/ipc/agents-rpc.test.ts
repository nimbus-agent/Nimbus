import { Database } from "bun:sqlite";
import { describe, expect, it, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynthesizerLlm } from "../agents/_lib/synthesize.ts";
import { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "./agents-rpc.ts";

function makeCtx(db: Database, extras?: { llm?: SynthesizerLlm; configDir?: string }) {
  return {
    db,
    notify: mock(() => {}),
    ...extras,
  };
}

/** Returns a fake SynthesizerLlm that immediately resolves to null (no synthesis). */
function fakeLlm(): SynthesizerLlm {
  return {
    generateMarkdown: (_prompt: string) => Promise.resolve(null),
  };
}

/** Creates a tmpdir with a nimbus.toml containing a [user] me_person_id entry. */
function makeTmpConfigDir(mePersonId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-agents-"));
  writeFileSync(join(dir, "nimbus.toml"), `[user]\nme_person_id = "${mePersonId}"\n`, "utf8");
  return dir;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/**
 * Polls a ctx.notify mock until `eventName` is observed or the deadline passes.
 * Deterministic replacement for fixed sleeps (the briefReady notify may fire
 * after the dispatch promise resolves; a fixed wait flakes under load).
 */
async function waitForNotify(
  notify: unknown,
  eventName: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
  const calls = (notify as ReturnType<typeof mock>).mock.calls;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (calls.some((c) => c[0] === eventName)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
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
    expect(await waitForNotify(ctx.notify, "expert.briefReady")).toBe(true);
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
    expect(await waitForNotify(ctx.notify, "impact.briefReady")).toBe(true);
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
      if (calls.some((c) => c[0] === "catchup.briefReady")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
    const briefReady = calls.find((c) => c[0] === "catchup.briefReady");
    expect(briefReady).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Branch-coverage additions — True Coverage Program B3b
// ---------------------------------------------------------------------------

describe("dispatchAgentsRpc — agents.expert limit validation", () => {
  test("valid integer limit is accepted and forwarded (limit defined arm)", async () => {
    const out = await dispatchAgentsRpc(
      "agents.expert",
      { topicOrFile: "src/x.ts", limit: 5 },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("limit: 0 (below 1) rejects with limit message", async () => {
    await expect(
      dispatchAgentsRpc("agents.expert", { topicOrFile: "src/x.ts", limit: 0 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("limit must be an integer"),
    });
  });

  test("limit: 1.5 (non-integer) rejects with limit message", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.expert",
        { topicOrFile: "src/x.ts", limit: 1.5 },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("limit must be an integer"),
    });
  });

  test("limit: 99 (above MAX_LIMIT=25) rejects with limit message", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.expert",
        { topicOrFile: "src/x.ts", limit: 99 },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("limit must be an integer"),
    });
  });

  test("limit: non-number (typed as unknown) rejects with limit message", async () => {
    const params: unknown = { topicOrFile: "src/x.ts", limit: "x" };
    await expect(
      dispatchAgentsRpc("agents.expert", params, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("limit must be an integer"),
    });
  });
});

describe("dispatchAgentsRpc — agents.impact depth+service validation", () => {
  test("valid depth (3) is accepted", async () => {
    const out = await dispatchAgentsRpc(
      "agents.impact",
      { fileOrPrUrl: "src/x.ts", depth: 3 },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("valid service is accepted", async () => {
    const out = await dispatchAgentsRpc(
      "agents.impact",
      { fileOrPrUrl: "src/x.ts", service: "github" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("depth: 0 (below MIN_DEPTH=1) rejects with depth message", async () => {
    await expect(
      dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "src/x.ts", depth: 0 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("depth must be an integer"),
    });
  });

  test("depth: 6 (above MAX_IMPACT_DEPTH=5) rejects with depth message", async () => {
    await expect(
      dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "src/x.ts", depth: 6 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("depth must be an integer"),
    });
  });

  test("depth: 1.5 (non-integer) rejects with depth message", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.impact",
        { fileOrPrUrl: "src/x.ts", depth: 1.5 },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("depth must be an integer"),
    });
  });

  test("service: empty string rejects with service message", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.impact",
        { fileOrPrUrl: "src/x.ts", service: "" },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("service must be a non-empty string"),
    });
  });

  test("service: >64 chars rejects with service message", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.impact",
        { fileOrPrUrl: "src/x.ts", service: "a".repeat(65) },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("service must be a non-empty string"),
    });
  });

  test("service: non-string (typed as unknown) rejects with service message", async () => {
    const params: unknown = { fileOrPrUrl: "src/x.ts", service: 42 };
    await expect(
      dispatchAgentsRpc("agents.impact", params, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("service must be a non-empty string"),
    });
  });
});

describe("dispatchAgentsRpc — agents.catchup sinceMs+service validation", () => {
  test("valid sinceMs (1000) is accepted", async () => {
    const out = await dispatchAgentsRpc("agents.catchup", { sinceMs: 1000 }, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("valid service is accepted", async () => {
    const out = await dispatchAgentsRpc(
      "agents.catchup",
      { service: "github" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("sinceMs: negative rejects with sinceMs message", async () => {
    await expect(
      dispatchAgentsRpc("agents.catchup", { sinceMs: -1 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("sinceMs must be"),
    });
  });

  test("sinceMs: above 90 days rejects with sinceMs message", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.catchup",
        { sinceMs: 91 * 24 * 60 * 60 * 1000 },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("sinceMs must be"),
    });
  });

  test("sinceMs: non-integer rejects with sinceMs message", async () => {
    await expect(
      dispatchAgentsRpc("agents.catchup", { sinceMs: 1.5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("sinceMs must be"),
    });
  });

  test("service: empty string rejects with service message", async () => {
    await expect(
      dispatchAgentsRpc("agents.catchup", { service: "" }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("service must be"),
    });
  });

  test("service: non-string (typed as unknown) rejects with service message", async () => {
    const params: unknown = { service: 123 };
    await expect(
      dispatchAgentsRpc("agents.catchup", params, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("service must be"),
    });
  });
});

describe("dispatchAgentsRpc — llm-present branches", () => {
  test("agents.expert with llm set takes the llm-present context arm", async () => {
    const ctx = makeCtx(freshDb(), { llm: fakeLlm() });
    const out = await dispatchAgentsRpc("agents.expert", { topicOrFile: "src/x.ts" }, ctx);
    expect(out.kind).toBe("hit");
    // briefReady is emitted; the llm-present arm was taken (no error = correct branch)
    expect(await waitForNotify(ctx.notify, "expert.briefReady")).toBe(true);
  });

  test("agents.impact with llm set takes the llm-present context arm", async () => {
    const ctx = makeCtx(freshDb(), { llm: fakeLlm() });
    const out = await dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "src/x.ts" }, ctx);
    expect(out.kind).toBe("hit");
    expect(await waitForNotify(ctx.notify, "impact.briefReady")).toBe(true);
  });

  test("agents.catchup with llm set takes the llm-present context arm", async () => {
    const ctx = makeCtx(freshDb(), { llm: fakeLlm() });
    const out = await dispatchAgentsRpc("agents.catchup", {}, ctx);
    expect(out.kind).toBe("hit");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
      if (calls.some((c) => c[0] === "catchup.briefReady")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
    expect(calls.some((c) => c[0] === "catchup.briefReady")).toBe(true);
  });
});

describe("dispatchAgentsRpc — agents.catchup configDir + mePersonId arms", () => {
  test("configDir defined + me_person_id set → mePersonIdOverride arm taken", async () => {
    const configDir = makeTmpConfigDir("person-abc-123");
    const ctx = makeCtx(freshDb(), { configDir });
    const out = await dispatchAgentsRpc("agents.catchup", {}, ctx);
    expect(out.kind).toBe("hit");
    // Confirm the brief was emitted (agent ran with mePersonIdOverride)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
      if (calls.some((c) => c[0] === "catchup.briefReady")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const calls = (ctx.notify as ReturnType<typeof mock>).mock.calls; // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
    expect(calls.some((c) => c[0] === "catchup.briefReady")).toBe(true);
  });

  test("configDir undefined → userToml = {} arm taken (mePersonId stays undefined)", async () => {
    // ctx has no configDir — tests the ctx.configDir === undefined arm
    const ctx = makeCtx(freshDb());
    const out = await dispatchAgentsRpc("agents.catchup", {}, ctx);
    expect(out.kind).toBe("hit");
  });

  test("configDir defined but no me_person_id → mePersonId undefined arm taken", async () => {
    // toml with [user] section but no me_person_id key → mePersonId stays undefined
    const dir = mkdtempSync(join(tmpdir(), "nimbus-agents-"));
    writeFileSync(join(dir, "nimbus.toml"), "[user]\n# no me_person_id here\n", "utf8");
    const ctx = makeCtx(freshDb(), { configDir: dir });
    const out = await dispatchAgentsRpc("agents.catchup", {}, ctx);
    expect(out.kind).toBe("hit");
  });
});

describe("agents.ghost / conflicts / huddle dispatch", () => {
  function ctxWithFederation() {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const index = new LocalIndex(db);
    return {
      db,
      notify: mock(() => {}),
      index,
      selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      sendOverWire: async () => ({ kind: "ok" as const, response: { items: [] } }),
    };
  }

  it("agents.ghost returns a sessionId (hit)", async () => {
    const out = await dispatchAgentsRpc("agents.ghost", { file: "auth.ts" }, ctxWithFederation());
    expect(out.kind).toBe("hit");
  });

  it("agents.conflicts validates the file param", async () => {
    await expect(dispatchAgentsRpc("agents.conflicts", {}, ctxWithFederation())).rejects.toThrow();
  });

  it("agents.huddle works with no file param", async () => {
    const out = await dispatchAgentsRpc("agents.huddle", { sinceMs: 1000 }, ctxWithFederation());
    expect(out.kind).toBe("hit");
  });

  it("agents.ghost accepts namespaces array", async () => {
    const out = await dispatchAgentsRpc(
      "agents.ghost",
      { file: "auth.ts", namespaces: ["a", "b"] },
      ctxWithFederation(),
    );
    expect(out.kind).toBe("hit");
  });

  it("agents.ghost without federation deps still returns a brief (degraded)", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const out = await dispatchAgentsRpc(
      "agents.ghost",
      { file: "auth.ts" },
      { db, notify: mock(() => {}) },
    );
    expect(out.kind).toBe("hit");
  });

  it("agents.conflicts returns a hit for a valid file", async () => {
    const out = await dispatchAgentsRpc(
      "agents.conflicts",
      { file: "src/x.ts" },
      ctxWithFederation(),
    );
    expect(out.kind).toBe("hit");
  });

  it("agents.ghost rejects an empty file", async () => {
    await expect(
      dispatchAgentsRpc("agents.ghost", { file: "   " }, ctxWithFederation()),
    ).rejects.toThrow();
  });

  it("agents.ghost rejects a file over the length limit", async () => {
    await expect(
      dispatchAgentsRpc("agents.ghost", { file: "a".repeat(3000) }, ctxWithFederation()),
    ).rejects.toThrow();
  });

  it("agents.ghost rejects an empty-string namespace", async () => {
    await expect(
      dispatchAgentsRpc("agents.ghost", { file: "x.ts", namespaces: [""] }, ctxWithFederation()),
    ).rejects.toThrow();
  });

  it("agents.ghost accepts a singular namespace string", async () => {
    const out = await dispatchAgentsRpc(
      "agents.ghost",
      { file: "x.ts", namespace: "single" },
      ctxWithFederation(),
    );
    expect(out.kind).toBe("hit");
  });

  it("agents.huddle rejects a negative sinceMs", async () => {
    await expect(
      dispatchAgentsRpc("agents.huddle", { sinceMs: -5 }, ctxWithFederation()),
    ).rejects.toThrow();
  });

  it("agents.huddle rejects a too-large sinceMs", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.huddle",
        { sinceMs: 999 * 24 * 60 * 60 * 1000 },
        ctxWithFederation(),
      ),
    ).rejects.toThrow();
  });
});

describe("dispatchAgentsRpc — agents.decisions", () => {
  test("agents.decisions rejects a non-integer sinceMs", async () => {
    await expect(
      dispatchAgentsRpc("agents.decisions", { sinceMs: 1.5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("sinceMs"),
    });
  });

  test("agents.decisions rejects minConfidence outside 0..1", async () => {
    await expect(
      dispatchAgentsRpc("agents.decisions", { minConfidence: 2 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("minConfidence"),
    });
  });

  test("agents.decisions returns a sessionId for valid params", async () => {
    const out = await dispatchAgentsRpc("agents.decisions", { sinceMs: 0 }, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(v.sessionId).toMatch(/^decisions/);
    }
  });
});

test("dispatchAgentsRpc accepts and retains a caller descriptor", async () => {
  const db = freshDb();
  const seen: unknown[] = [];
  const ctx = {
    ...makeCtx(db),
    caller: { clientId: "c1", kind: "mcp" as const },
    notify: (m: string, p: unknown) => {
      seen.push({ m, p });
    },
  };
  const out = await dispatchAgentsRpc("agents.expert", { topicOrFile: "x" }, ctx);
  expect(out.kind).toBe("hit");
  expect(ctx.caller.kind).toBe("mcp");
});
