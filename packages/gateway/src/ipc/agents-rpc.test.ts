import { Database } from "bun:sqlite";
import { describe, expect, it, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  AgentsRpcError,
  dispatchAgentsRpc,
  EXTERNAL_AGENT_NAMES,
  resolveExternalAgentMethod,
} from "./agents-rpc.ts";

function makeCtx(db: Database, extras?: { runner?: SynthesisRunner; configDir?: string }) {
  return {
    db,
    notify: mock(() => {}),
    ...extras,
  };
}

/**
 * A SynthesisRunner whose effect is OBSERVABLE in the rendered brief. A runner that always reports
 * `no_eligible_provider` (the previous fixture here) makes a weaker proof: every brief kind but
 * `negotiate` and `glossary` has an empty `requiredPhrases` set, so `contractViolations` never
 * rejects this markdown (see `brief-contract.ts`; a glossary brief requires a phrase only in
 * `term` mode with a non-LLM definition), and — since `synthesize.ts` gives `no_eligible_provider` its
 * own footer, distinct from the plain "does not use an LLM" one a dropped `ctx.runner` renders —
 * asserting "was `ctx.runner` threaded through" would reduce to a footer-WORDING diff rather than
 * a brief-CONTENT diff. A threaded runner using this fake makes the brief carry `markdown`
 * verbatim plus a "Synthesized by <model>" footer — an unambiguous signal that `ctx.runner`
 * genuinely reached `synthesize()`. That difference is the proof.
 */
function okRunner(markdown = "OBSERVABLE-SYNTHESIS-MARKER"): SynthesisRunner {
  return {
    run: (_prompt: string) =>
      Promise.resolve({ ok: true, markdown, model: "fake-model", remote: false }),
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

/**
 * Same polling contract as `waitForNotify`, but returns the notification's `params` (the second
 * call argument) instead of a boolean — so a test can inspect `brief`/`synthesis` and prove a
 * threaded runner's effect actually reached the caller, not merely that SOME notification fired.
 */
async function waitForNotifyParams(
  notify: unknown,
  eventName: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown> | undefined> {
  // NOSONAR S4325: cast exposes the bun mock's .mock.calls (ctx.notify is typed as a plain fn)
  const calls = (notify as ReturnType<typeof mock>).mock.calls;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = calls.find((c) => c[0] === eventName);
    if (found !== undefined) return found[1] as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
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
      // The message now names both arms — `expert` grew an `itemUrl` arm, and a message
      // that mentioned only `topicOrFile` would send a caller to the wrong one.
      message: expect.stringContaining("exactly one of { topicOrFile } or { itemUrl }"),
    });
  });

  test("agents.expert requires exactly one arm", async () => {
    const ctx = makeCtx(freshDb());
    for (const params of [
      {},
      { topicOrFile: "x", itemUrl: "https://acme.atlassian.net/browse/A-1" },
    ]) {
      await expect(dispatchAgentsRpc("agents.expert", params, ctx)).rejects.toThrow(/exactly one/);
    }
    for (const params of [
      { topicOrFile: "x" },
      { itemUrl: "https://acme.atlassian.net/browse/A-1" },
    ]) {
      expect((await dispatchAgentsRpc("agents.expert", params, ctx)).kind).toBe("hit");
    }
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

describe("dispatchAgentsRpc — runner-present branches", () => {
  // Each test below uses okRunner() — not a runner that always reports `no_eligible_provider` —
  // because that outcome makes a weaker proof: every brief kind but `negotiate` and `glossary`
  // has an empty `requiredPhrases` set, so `contractViolations` never rejects the markdown, and — since
  // `synthesize.ts` gives `no_eligible_provider` its own footer, distinct from the plain
  // "does not use an LLM" one a dropped `ctx.runner` renders — asserting "was `ctx.runner`
  // threaded through" would reduce to a footer-WORDING diff rather than a brief-CONTENT diff.
  // okRunner() returns `{ok: true, markdown}`, which only reaches the emitted brief when
  // ctx.runner genuinely made it into `synthesize()` — that is the observable difference these
  // tests assert on.
  test("agents.expert with runner set actually synthesizes (marker + provenance observable)", async () => {
    const ctx = makeCtx(freshDb(), { runner: okRunner() });
    const out = await dispatchAgentsRpc("agents.expert", { topicOrFile: "src/x.ts" }, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "expert.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  test("agents.impact with runner set actually synthesizes (marker + provenance observable)", async () => {
    const ctx = makeCtx(freshDb(), { runner: okRunner() });
    const out = await dispatchAgentsRpc("agents.impact", { fileOrPrUrl: "src/x.ts" }, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "impact.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  test("agents.catchup with runner set actually synthesizes (marker + provenance observable)", async () => {
    const ctx = makeCtx(freshDb(), { runner: okRunner() });
    const out = await dispatchAgentsRpc("agents.catchup", {}, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "catchup.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });
});

describe("dispatchAgentsRpc — ctx.runner threading proof for the remaining agents", () => {
  // These eight agents (Task 6 review) had NO test proving `ctx.runner` survives the handler's
  // optional-spread forwarding (`...(ctx.runner === undefined ? {} : { runner: ctx.runner })`) —
  // deleting that line still typechecks, so only an OBSERVABLE runner effect (see okRunner() above)
  // catches the regression. `catchup` is covered above; the other seven are covered here.
  function ctxWithFederationAndRunner() {
    const db = freshDb();
    const index = new LocalIndex(db);
    return {
      db,
      notify: mock(() => {}),
      index,
      selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      sendOverWire: async () => ({ kind: "ok" as const, response: { items: [] } }),
      runner: okRunner(),
    };
  }

  test("agents.conflicts with runner set actually synthesizes", async () => {
    const ctx = ctxWithFederationAndRunner();
    const out = await dispatchAgentsRpc("agents.conflicts", { file: "src/x.ts" }, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "conflicts.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  test("agents.huddle with runner set actually synthesizes", async () => {
    const ctx = ctxWithFederationAndRunner();
    const out = await dispatchAgentsRpc("agents.huddle", {}, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "huddle.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  test("agents.janitor with runner set actually synthesizes", async () => {
    const ctx = ctxWithFederationAndRunner();
    const out = await dispatchAgentsRpc("agents.janitor", { resourceRef: "res-1" }, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "janitor.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  test("agents.preflight with runner set actually synthesizes", async () => {
    const ctx = ctxWithFederationAndRunner();
    const out = await dispatchAgentsRpc("agents.preflight", { ref: "HEAD", namespace: "svc" }, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "preflight.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  // The `hasRef === hasPrUrl` equality this replaced read "exactly one" only while there
  // were exactly two arms — at three it silently means "an odd number", so all three
  // supplied together would have been ACCEPTED. Tested as a count, at every arity.
  test("agents.why requires exactly one of three arms", async () => {
    const ctx = makeCtx(freshDb());
    const rejects = [
      {},
      { ref: "x", prUrl: "https://github.com/a/b/pull/1" },
      { ref: "x", itemUrl: "https://acme.atlassian.net/browse/A-1" },
      { prUrl: "https://github.com/a/b/pull/1", itemUrl: "https://acme.atlassian.net/browse/A-1" },
      // The three-arm case the old equality would have let through.
      {
        ref: "x",
        prUrl: "https://github.com/a/b/pull/1",
        itemUrl: "https://acme.atlassian.net/browse/A-1",
      },
    ];
    for (const params of rejects) {
      await expect(dispatchAgentsRpc("agents.why", params, ctx)).rejects.toThrow(/exactly one/);
    }
  });

  test("agents.why accepts each single arm", async () => {
    const ctx = makeCtx(freshDb());
    for (const params of [
      { ref: "x" },
      { prUrl: "https://github.com/a/b/pull/1" },
      { itemUrl: "https://acme.atlassian.net/browse/A-1" },
    ]) {
      const out = await dispatchAgentsRpc("agents.why", params, ctx);
      expect(out.kind).toBe("hit");
    }
  });

  test("itemUrl inherits the prUrl arm's guards", async () => {
    const ctx = makeCtx(freshDb());
    await expect(
      dispatchAgentsRpc(
        "agents.why",
        { itemUrl: "https://u:p@acme.atlassian.net/browse/A-1" },
        ctx,
      ),
    ).rejects.toThrow(/userinfo/);
    await expect(dispatchAgentsRpc("agents.why", { itemUrl: "   " }, ctx)).rejects.toThrow(
      /chars after trim/,
    );
    await expect(dispatchAgentsRpc("agents.why", { itemUrl: 7 }, ctx)).rejects.toThrow(
      /itemUrl must be a string/,
    );
  });

  test("agents.why with runner set actually synthesizes", async () => {
    const ctx = makeCtx(freshDb(), { runner: okRunner() });
    const out = await dispatchAgentsRpc("agents.why", { ref: "x" }, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "why.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  // Every handler whose runner-forwarding is provable with no params and no fixture, one row
  // each. Fix round 2 found three more forwarding sites with the SAME optional-spread shape and
  // the SAME no-test gap: handleDecisions joins the table here, while handleNegotiate and
  // handlePremortem need their own setup and get their own tests below.
  const forwardsRunner: readonly (readonly [method: string, notification: string])[] = [
    ["agents.glossary", "glossary.briefReady"],
    ["agents.ownership", "ownership.briefReady"],
    ["agents.decisions", "decisions.briefReady"],
  ];
  test.each(forwardsRunner)(
    "%s with runner set actually synthesizes",
    async (method, notification) => {
      const ctx = makeCtx(freshDb(), { runner: okRunner() });
      const out = await dispatchAgentsRpc(method, {}, ctx);
      expect(out.kind).toBe("hit");
      const params = await waitForNotifyParams(ctx.notify, notification);
      expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
      expect(params?.["synthesis"]).toMatchObject({
        attempted: true,
        used: true,
        model: "fake-model",
      });
    },
  );

  test("agents.premortem with runner set actually synthesizes", async () => {
    const db = freshDb();
    // Premortem throws "not found in the local Jira index" for an unresolvable epicRef before
    // ever reaching synthesize() — a real target epic must be indexed for this test to exercise
    // the runner-forwarding line at all, not just the earlier resolution failure.
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "jira",
      type: "issue",
      externalId: "PROJ-1",
      title: "PROJ-1 title",
      metadata: { issue_type: "Epic", status_category: "in_progress", created_at_ms: now },
      modifiedAt: now,
      syncedAt: now,
    });
    const ctx = makeCtx(db, { runner: okRunner() });
    const out = await dispatchAgentsRpc("agents.premortem", { epicRef: "PROJ-1" }, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "premortem.briefReady");
    expect(params?.["brief"]).toContain("OBSERVABLE-SYNTHESIS-MARKER");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: true,
      model: "fake-model",
    });
  });

  test("agents.negotiate with runner set actually attempts synthesis (discarded by the contract guard, not dropped)", async () => {
    // negotiate always has NON-EMPTY requiredPhrases (brief-contract.ts): the preamble window
    // clause is required unconditionally, every null lane requires its own "could not be
    // computed" disclaimer under its own heading, and a populated ownership/incidents/decisions
    // lane requires its interleaved sentence. okRunner()'s bare marker string satisfies none of that, so
    // contractViolations correctly discards it as a contract_violation — the guard working
    // exactly as designed, not a reason to weaken it for this test. The point here is only to
    // prove ctx.runner was threaded through, and `{attempted: true, used: false}` already does
    // that on its own: a DROPPED runner (ctx.runner undefined) produces
    // `{attempted: false, reason: "disabled"}` at synthesize()'s very first branch — a
    // different, unambiguous value a discarded-but-attempted outcome can never be confused with.
    const ctx = makeCtx(freshDb(), { runner: okRunner() });
    const out = await dispatchAgentsRpc("agents.negotiate", {}, ctx);
    expect(out.kind).toBe("hit");
    const params = await waitForNotifyParams(ctx.notify, "negotiate.briefReady");
    expect(params?.["synthesis"]).toMatchObject({
      attempted: true,
      used: false,
      reason: "contract_violation",
    });
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

  it(
    "agents.huddle still rejects sinceMs above the shared 90-day bound (200 days) — proves " +
      "agents.negotiate's own 365-day bound did not leak into the shared MAX_SINCE_MS",
    async () => {
      await expect(
        dispatchAgentsRpc(
          "agents.huddle",
          { sinceMs: 200 * 24 * 60 * 60 * 1000 },
          ctxWithFederation(),
        ),
      ).rejects.toMatchObject({
        rpcCode: -32602,
        message: expect.stringContaining("90 days"),
      });
    },
  );
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

describe("dispatchAgentsRpc — agents.negotiate", () => {
  test("rejects a non-integer sinceMs", async () => {
    await expect(
      dispatchAgentsRpc("agents.negotiate", { sinceMs: 1.5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("sinceMs"),
    });
  });

  // Negotiate's own 365-day bound (review-cycle evidence), NOT the shared 90-day MAX_SINCE_MS
  // every sibling validator uses — see MAX_NEGOTIATE_SINCE_MS's comment in agents-rpc.ts. The
  // sibling test above ("agents.huddle still rejects sinceMs above the shared 90-day bound")
  // is what proves this per-method raise did not leak into the shared constant.
  test("accepts sinceMs at exactly 365 days", async () => {
    const out = await dispatchAgentsRpc(
      "agents.negotiate",
      { sinceMs: 365 * 24 * 60 * 60 * 1000 },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
  });

  test("rejects sinceMs above 365 days, naming the negotiate bound", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.negotiate",
        { sinceMs: 366 * 24 * 60 * 60 * 1000 },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("365 days"),
    });
  });

  test("rejects an empty personId", async () => {
    await expect(
      dispatchAgentsRpc("agents.negotiate", { personId: "   " }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("personId"),
    });
  });

  test("rejects a personId longer than the bound", async () => {
    await expect(
      dispatchAgentsRpc("agents.negotiate", { personId: "x".repeat(257) }, makeCtx(freshDb())),
    ).rejects.toMatchObject({
      rpcCode: -32602,
      message: expect.stringContaining("personId"),
    });
  });

  test("rejects a non-object payload", async () => {
    await expect(
      dispatchAgentsRpc("agents.negotiate", "nope", makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("returns a sessionId for valid (empty) params", async () => {
    const out = await dispatchAgentsRpc("agents.negotiate", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(v.sessionId).toMatch(/^negotiate/);
    }
  });

  test("returns a sessionId for a valid explicit personId", async () => {
    const out = await dispatchAgentsRpc(
      "agents.negotiate",
      { personId: "person-abc" },
      makeCtx(freshDb()),
    );
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(v.sessionId).toMatch(/^negotiate/);
    }
  });

  test("with no configDir, personalSources defaults to empty (no crash, docs/notes stay gated off)", async () => {
    // Exercises the ctx.configDir === undefined arm of negotiatePersonalSources — the
    // test/embedded shape must not throw, and must not silently widen the consent gate.
    const out = await dispatchAgentsRpc("agents.negotiate", {}, makeCtx(freshDb()));
    expect(out.kind).toBe("hit");
  });

  test("with a configDir, [negotiate] personal_sources is read from nimbus.toml", async () => {
    // Exercises the ctx.configDir !== undefined arm: a real [negotiate] section must be loaded,
    // not defaulted away, per Task 6/7's "personalSources is not optional" rule.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-agents-"));
    try {
      writeFileSync(
        join(dir, "nimbus.toml"),
        '[negotiate]\npersonal_sources = ["obsidian"]\n',
        "utf8",
      );
      const out = await dispatchAgentsRpc(
        "agents.negotiate",
        {},
        makeCtx(freshDb(), { configDir: dir }),
      );
      expect(out.kind).toBe("hit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the externally-invokable agent set", () => {
  test("the external agent set is exactly eleven and excludes the four", () => {
    expect(EXTERNAL_AGENT_NAMES.length).toBe(11);
    for (const excluded of ["preflight", "premortem", "whyPeek", "negotiate"]) {
      expect(EXTERNAL_AGENT_NAMES).not.toContain(excluded);
      expect(resolveExternalAgentMethod(excluded)).toBeNull();
    }
  });

  test("resolveExternalAgentMethod does not resolve prototype keys", () => {
    expect(resolveExternalAgentMethod("constructor")).toBeNull();
    expect(resolveExternalAgentMethod("toString")).toBeNull();
  });

  test("is exactly the eleven asynchronous, non-preflight, non-premortem agents", () => {
    expect([...EXTERNAL_AGENT_NAMES]).toEqual([
      "catchup",
      "conflicts",
      "decisions",
      "expert",
      "ghost",
      "glossary",
      "huddle",
      "impact",
      "janitor",
      "ownership",
      "why",
    ]);
  });

  test("premortem is not reachable over any external surface", () => {
    // `runPremortem` writes paused watcher rows (and can delete tombstones via `repropose`)
    // with no HITL gate — an external caller must not be able to trigger that unprompted,
    // the same reasoning `agents.preflight` is excluded for. Also carried over from the MCP tool
    // surface, which defines no premortem tool.
    expect(resolveExternalAgentMethod("premortem")).toBeNull();
    expect(EXTERNAL_AGENT_NAMES).not.toContain("premortem");
  });

  test("preflight is not reachable over any external surface", () => {
    // I24: agents.preflight is the federated-action path. A caller that can invoke it can queue
    // consent prompts on the owner's machine — an external caller must never originate one.
    expect(resolveExternalAgentMethod("preflight")).toBeNull();
    expect(EXTERNAL_AGENT_NAMES).not.toContain("preflight");
  });

  test("whyPeek is not reachable over any external surface", () => {
    // Synchronous by design (the why-lens hover): it returns its payload inline and calls notify
    // NEVER, so on the {runId}+poll contract it would create a run that can never complete and
    // would poll until the TTL turned a success into a 410. Exposing it needs its own
    // inline-result route, which is a later decision — not a second response shape bolted on here.
    expect(resolveExternalAgentMethod("whyPeek")).toBeNull();
    expect(EXTERNAL_AGENT_NAMES).not.toContain("whyPeek");
  });

  test("agents.negotiate is NOT on the external agent surface", () => {
    // Unlike the three exclusions above, negotiate is a pure read with no side effects — it is
    // excluded for a different reason: combined with `--person`, external exposure would let any
    // holder of the `agents` token/scope assemble a contribution dossier on any indexed person
    // without the owner initiating it. CLI and Tauri are same-machine, owner-initiated; the local
    // HTTP API and ChatOps are not.
    expect(resolveExternalAgentMethod("negotiate")).toBeNull();
    expect(EXTERNAL_AGENT_NAMES).not.toContain("negotiate");
  });

  test("ghost and huddle stay in, as they did for MCP", () => {
    expect(resolveExternalAgentMethod("ghost")).toBe("agents.ghost");
    expect(resolveExternalAgentMethod("huddle")).toBe("agents.huddle");
  });

  test("the resolver is prototype-safe and rejects anything unserved", () => {
    // A caller-supplied path segment reaches this. `Object.hasOwn` (not `in`) is what stops
    // "constructor" / "__proto__" / "toString" resolving against the object prototype.
    for (const junk of ["__proto__", "constructor", "toString", "", "expert.extra", "Expert"]) {
      expect(resolveExternalAgentMethod(junk)).toBeNull();
    }
  });

  test("every published name resolves back to a served method", () => {
    // The list and the resolver are two derivations of the same map; this pins them together so a
    // name cannot be advertised by GET /v1/agents and then 404 on invocation.
    for (const name of EXTERNAL_AGENT_NAMES) {
      expect(resolveExternalAgentMethod(name)).toBe(`agents.${name}`);
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

// I29/D22(c) — the agent brief egress chokepoint. `freshDb()` runs the real migration set
// (LocalIndex.ensureSchema → V44), so `egress_ledger` is the shipped table, not a fixture copy.
describe("I29 — externally-originated agent briefs are ledgered", () => {
  test("a CLI-originated agents call appends NO egress row", async () => {
    const db = freshDb();
    await dispatchAgentsRpc(
      "agents.expert",
      { topicOrFile: "x" },
      { ...makeCtx(db), caller: { clientId: "c1", kind: "cli" as const } },
    );
    const n = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("a callerless (in-process/test) agents call appends NO egress row", async () => {
    const db = freshDb();
    await dispatchAgentsRpc("agents.expert", { topicOrFile: "x" }, makeCtx(db));
    const n = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("an MCP-originated agents call appends exactly one egress row", async () => {
    const db = freshDb();
    await dispatchAgentsRpc(
      "agents.expert",
      { topicOrFile: "x" },
      { ...makeCtx(db), caller: { clientId: "c1", kind: "mcp" as const } },
    );
    const rows = db
      .query(`SELECT source_type, source_id, method FROM egress_ledger`)
      .all() as Array<{ source_type: string; source_id: string | null; method: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_type).toBe("mcp");
    expect(rows[0]?.source_id).toBe("c1");
    expect(rows[0]?.method).toBe("agents.expert");
  });

  test("the append happens BEFORE the brief work — a failed append emits no brief (fail-closed)", async () => {
    // Drop the ledger table so the append throws. The dispatch must propagate the error rather
    // than serve an unrecorded brief; a ledger the brief can outrun is decorative.
    const db = freshDb();
    db.exec(`DROP TABLE egress_ledger`);
    const ctx = { ...makeCtx(db), caller: { clientId: "c1", kind: "mcp" as const } };
    await expect(
      dispatchAgentsRpc("agents.expert", { topicOrFile: "x" }, ctx),
    ).rejects.toBeInstanceOf(Error);
    // Nothing was emitted: no briefReady (or any) notification fired.
    expect((ctx.notify as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test("an MCP-originated call to an UNRECOGNISED agents.* method appends NO row and still misses", async () => {
    // The append is gated on membership of the handler map, not on the `agents.` prefix. Gating on
    // the prefix wrote a `result_status='authorized'` row for work that never ran (the call then
    // fails -32601) — `nimbus prove` over-counting is the same defect this feature exists to close,
    // pointed the other way. It also let an arbitrary, caller-controlled, UNBOUNDED `method` string
    // reach a hashed append-only column: `payload_summary` is capped at 256 bytes, `method` is not,
    // and the local socket has no frame-size cap.
    const db = freshDb();
    const long = `agents.${"z".repeat(4096)}`;
    for (const method of ["agents.bogus", "agents.", "agents.expertX", long]) {
      const outcome = await dispatchAgentsRpc(
        method,
        { topicOrFile: "x" },
        { ...makeCtx(db), caller: { clientId: "c1", kind: "mcp" as const } },
      );
      expect({ method, kind: outcome.kind }).toEqual({ method, kind: "miss" });
    }
    const n = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("an HTTP-originated agents call appends exactly one source_type='http' row", async () => {
    // The second transport. Attribution is stronger here than over stdio: there is no connection to
    // hand-shake, so `kind` is a literal the gateway sets after verifying a bearer token, and
    // `clientId` is that token's verified label — both server-derived, neither caller-supplied.
    const db = freshDb();
    await dispatchAgentsRpc(
      "agents.expert",
      { topicOrFile: "x" },
      { ...makeCtx(db), caller: { clientId: "chrome-work", kind: "http" as const } },
    );
    const rows = db
      .query(`SELECT source_type, source_id, method, destination FROM egress_ledger`)
      .all() as Array<{
      source_type: string;
      source_id: string | null;
      method: string;
      destination: string;
    }>;
    expect(rows).toEqual([
      {
        source_type: "http",
        source_id: "chrome-work",
        method: "agents.expert",
        destination: "http",
      },
    ]);
  });

  test("a federation-touching agent over HTTP keeps its distinguishable destination", async () => {
    const db = freshDb();
    await dispatchAgentsRpc(
      "agents.ghost",
      { file: "auth.ts" },
      { ...makeCtx(db), caller: { clientId: "chrome", kind: "http" as const } },
    ).catch(() => undefined);
    const rows = db.query(`SELECT destination FROM egress_ledger`).all() as Array<{
      destination: string;
    }>;
    expect(rows.map((r) => r.destination)).toEqual(["http+federation"]);
  });

  test("an HTTP-originated call to an UNRECOGNISED method appends NO row and still misses", async () => {
    // The generalisation from an equality to a lookup must not widen WHAT is appended for, only
    // WHO. Membership of the served handler map still gates the append on every transport.
    const db = freshDb();
    const outcome = await dispatchAgentsRpc(
      "agents.bogus",
      {},
      { ...makeCtx(db), caller: { clientId: "chrome", kind: "http" as const } },
    );
    expect(outcome.kind).toBe("miss");
    const n = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("a failed HTTP append emits no brief either — fail-closed on both transports", async () => {
    const db = freshDb();
    db.exec(`DROP TABLE egress_ledger`);
    const ctx = { ...makeCtx(db), caller: { clientId: "chrome", kind: "http" as const } };
    await expect(
      dispatchAgentsRpc("agents.expert", { topicOrFile: "x" }, ctx),
    ).rejects.toBeInstanceOf(Error);
    expect((ctx.notify as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test("membership-gating did not narrow the append below the served set", async () => {
    // The complement of the test above. `agents.whyPeek` is the one worth pinning: it is
    // synchronous and returns its answer inline rather than via a briefReady notification, so a
    // narrowing that keyed on "async agents" would drop it — and it is still gateway-synthesised
    // content handed to the caller's model. The append runs before the handler, so the row must
    // exist whether or not the handler itself succeeds on this bare context.
    const db = freshDb();
    await dispatchAgentsRpc(
      "agents.whyPeek",
      { ref: "src/a.ts:1" },
      { ...makeCtx(db), caller: { clientId: "c1", kind: "mcp" as const } },
    ).catch(() => undefined);
    const rows = db.query(`SELECT method FROM egress_ledger`).all() as Array<{ method: string }>;
    expect(rows.map((r) => r.method)).toEqual(["agents.whyPeek"]);
  });
});
