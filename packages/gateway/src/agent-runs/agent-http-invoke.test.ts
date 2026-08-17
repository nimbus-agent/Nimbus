// packages/gateway/src/agent-runs/agent-http-invoke.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentSynthesisRunner } from "../agents/_lib/agent-synthesis-runner.ts";
import type { SynthesisRouter } from "../agents/_lib/synthesis-llm.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAgentsRpc } from "../ipc/agents-rpc.ts";
import { buildAgentHttpInvoker, requireRunId } from "./agent-http-invoke.ts";
import { AgentRunController, MAX_CONCURRENT_AGENT_RUNS } from "./agent-run-store.ts";

/** Mirrors `freshDb()` in ipc/agents-rpc.test.ts — the real migration set, not a fixture copy. */
function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function makeRuns(): AgentRunController {
  return new AgentRunController({ nowMs: () => 1 });
}

function countLedger(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number }).n;
}

/** A tmpdir `nimbus.toml` pinning `[agents].synthesis` to `mode`. */
function makeAgentsConfigDir(mode: "off" | "local" | "allow-remote"): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-agent-http-cfg-"));
  writeFileSync(join(dir, "nimbus.toml"), `[agents]\nsynthesis = "${mode}"\n`, "utf8");
  return dir;
}

/** A LOCAL-provider SynthesisRouter — resolves and generates deterministically, no real LLM call. */
function fakeLocalRouter(markdown: string): SynthesisRouter {
  return {
    resolveForSynthesis: async () => ({
      providerId: "ollama",
      modelName: "fake-model",
      isLocal: true,
    }),
    generateMarkdown: async () => markdown,
  };
}

/** A REMOTE-only SynthesisRouter — used to prove `[agents].synthesis = "local"` refuses it. */
function fakeRemoteRouter(): SynthesisRouter {
  return {
    resolveForSynthesis: async () => ({
      providerId: "remote",
      modelName: "remote-model",
      isLocal: false,
    }),
    generateMarkdown: async () => "SHOULD-NEVER-BE-USED",
  };
}

/**
 * Strips `render.ts`'s `renderLatency` footer line (`_generated in N.N s_`) before a markdown
 * equality check — the ONE piece of a deterministic `why` render that is not reproducible between
 * two separate dispatches (wall-clock latency), so leaving it in would make an otherwise-real
 * equivalence assertion flake under load.
 */
function stripLatencyFooter(markdown: string | null | undefined): string | null {
  if (markdown == null) return null;
  return markdown.replace(/_generated in [\d.]+ s_\n?/g, "");
}

/** Dispatches `agents.why` the way `ipc/server/dispatchers.ts`'s `tryDispatchAgentsRpc` does. */
async function briefViaSocket(
  configDir: string,
  router: SynthesisRouter,
  db: Database,
  params: unknown,
): Promise<{ brief: unknown; synthesis: unknown } | undefined> {
  const runner = buildAgentSynthesisRunner({ configDir, db, router, method: "agents.why" });
  let captured: { brief: unknown; synthesis: unknown } | undefined;
  await dispatchAgentsRpc("agents.why", params, {
    db,
    notify: (m, p) => {
      if (m === "why.briefReady") {
        captured = p as { brief: unknown; synthesis: unknown };
      }
    },
    configDir,
    ...(runner === undefined ? {} : { runner }),
  });
  const deadline = Date.now() + 5_000;
  while (captured === undefined && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  return captured;
}

/** Dispatches `agents.why` over the HTTP invoker, polling the run to a terminal state. */
async function briefViaHttp(
  configDir: string,
  router: SynthesisRouter,
  db: Database,
  params: unknown,
): Promise<{ brief: unknown; synthesis: unknown }> {
  const runs = makeRuns();
  const out = await buildAgentHttpInvoker({ db, runs, configDir, router })("why", params, "chrome");
  if (!out.ok) throw new Error("unreachable");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && runs.get(out.runId)?.status === "running") {
    await Bun.sleep(10);
  }
  const run = runs.get(out.runId);
  return { brief: run?.brief ?? null, synthesis: run?.synthesis ?? null };
}

describe("requireRunId — the defensive paths, exercised directly", () => {
  // Both paths are unreachable through the public API (the resolver and the dispatcher consult the
  // same handler map; all ten exposed agents return {sessionId}). They are tested here rather than
  // left unverified: defensive code no test can reach is indistinguishable from defensive code that
  // does not work.
  test("returns the sessionId from a hit", () => {
    expect(requireRunId("expert", { kind: "hit", value: { sessionId: "expert_1_aaaa" } })).toBe(
      "expert_1_aaaa",
    );
  });

  test("throws on a miss rather than opening a run under undefined", () => {
    expect(() => requireRunId("expert", { kind: "miss" })).toThrow(TypeError);
  });

  test("throws when the hit carries no usable sessionId", () => {
    // Every shape a handler could return that the run store cannot key on. Opening a run under any
    // of them would strand the caller polling an id that names nothing.
    for (const value of [{}, { sessionId: "" }, { sessionId: 42 }, null, "str"]) {
      expect(() => requireRunId("expert", { kind: "hit", value })).toThrow(TypeError);
    }
  });

  test("names the agent in the message, so the failure is diagnosable", () => {
    expect(() => requireRunId("catchup", { kind: "miss" })).toThrow(/catchup/);
  });
});

describe("buildAgentHttpInvoker", () => {
  test("threads index, configDir and selfIdentity into the dispatch context", async () => {
    // The optional-deps arms. Production always supplies all three (assemble.ts), so leaving them
    // unexercised would mean the only tested path is the one production never takes.
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({
      db,
      runs,
      index: new LocalIndex(db),
      configDir: mkdtempSync(join(tmpdir(), "nimbus-agent-cfg-")),
      selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      router: undefined,
    })("expert", { topicOrFile: "auth.ts" }, "chrome");
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(runs.get(out.runId)).not.toBeNull();
    // Still exactly one row: the extra context changes what the agent can see, not what is recorded.
    expect(countLedger(db)).toBe(1);
  });

  test("an unknown agent is refused before any admission is spent", async () => {
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({ db, runs, router: undefined })("nope", {}, "chrome");
    expect(out).toEqual({ ok: false, reason: "unknown_agent" });
    // No reservation leaked: the cap is still fully available.
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);
  });

  test("preflight is refused as unknown, and appends nothing", async () => {
    // I24. Refused at the resolver, so it never reaches the dispatcher and never ledgers.
    const db = freshDb();
    const out = await buildAgentHttpInvoker({ db, runs: makeRuns(), router: undefined })(
      "preflight",
      { ref: "HEAD", namespace: "n" },
      "chrome",
    );
    expect(out).toEqual({ ok: false, reason: "unknown_agent" });
    expect(countLedger(db)).toBe(0);
  });

  test("whyPeek is refused as unknown too", async () => {
    const db = freshDb();
    const out = await buildAgentHttpInvoker({ db, runs: makeRuns(), router: undefined })(
      "whyPeek",
      { ref: "src/a.ts:1" },
      "chrome",
    );
    expect(out).toEqual({ ok: false, reason: "unknown_agent" });
    expect(countLedger(db)).toBe(0);
  });

  test("a successful invocation returns the gateway sessionId as the runId", async () => {
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({ db, runs, router: undefined })(
      "expert",
      { topicOrFile: "auth.ts" },
      "chrome",
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    // The gateway's own <agent>_<ts>_<uuid8> id, REUSED rather than a second identifier minted —
    // so a ledger row, a brief and an HTTP poll all name the same thing.
    expect(out.runId).toMatch(/^expert_\d+_[0-9a-f]{8}$/);
    expect(runs.get(out.runId)).not.toBeNull();
  });

  test("the invocation appends exactly one source_type='http' row, attributed to the label", async () => {
    const db = freshDb();
    await buildAgentHttpInvoker({ db, runs: makeRuns(), router: undefined })(
      "expert",
      { topicOrFile: "auth.ts" },
      "chrome-work",
    );
    const rows = db
      .query(`SELECT source_type, source_id, method FROM egress_ledger`)
      .all() as Array<{ source_type: string; source_id: string; method: string }>;
    expect(rows).toEqual([
      { source_type: "http", source_id: "chrome-work", method: "agents.expert" },
    ]);
  });

  test("invalid params are a typed refusal, not a thrown error", async () => {
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({ db, runs, router: undefined })(
      "expert",
      { topicOrFile: "" },
      "chrome",
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toBe("invalid_params");
    // The reservation is released, or a client could exhaust the cap with malformed requests.
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);
  });

  test("validation failure still leaves the egress row — the append precedes validation", async () => {
    // Stated rather than discovered: dispatchAgentsRpc appends BEFORE dispatchByMethod, and the
    // per-agent validator runs inside the handler. So a rejected call IS ledgered. That matches the
    // MCP path exactly and is the honest reading of "append before any agent work".
    const db = freshDb();
    await buildAgentHttpInvoker({ db, runs: makeRuns(), router: undefined })(
      "expert",
      { topicOrFile: "" },
      "chrome",
    );
    expect(countLedger(db)).toBe(1);
  });

  test("the concurrency cap refuses with busy and appends no egress row", async () => {
    // The cap is pre-filled through the CONTROLLER, not by issuing three real invocations. Driving
    // it with real invocations would be flaky: an agent is fire-and-forget, so its brief can reach
    // a terminal state before the next invoke runs — and a terminal run holds no slot, so the
    // fourth call would sometimes be admitted.
    const db = freshDb();
    const runs = makeRuns();
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);

    expect(
      await buildAgentHttpInvoker({ db, runs, router: undefined })(
        "expert",
        { topicOrFile: "x" },
        "chrome",
      ),
    ).toEqual({
      ok: false,
      reason: "busy",
      activeRuns: MAX_CONCURRENT_AGENT_RUNS,
      // Every slot is a reservation, so nothing on the clock bounds the wait.
      oldestExpiresInSeconds: null,
    });
    // Refused before dispatch, so before the append: a rejected request is not egress.
    expect(countLedger(db)).toBe(0);
  });

  test("a failing egress append creates NO run and propagates — fail closed", async () => {
    // The whole I29 claim in one test: no row, no run, no brief. Dropping the table is the idiom
    // the sibling suites use to provoke a real append failure.
    const db = freshDb();
    db.exec(`DROP TABLE egress_ledger`);
    const runs = makeRuns();
    await expect(
      buildAgentHttpInvoker({ db, runs, router: undefined })(
        "expert",
        { topicOrFile: "x" },
        "chrome",
      ),
    ).rejects.toThrow();
    expect(runs.activeCount()).toBe(0);
    // ...and the reservation was released, so a transient failure cannot leak capacity.
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);
  });

  test("the notify sink writes into the run store, never anywhere else", async () => {
    // Delivery is dependency injection: the invoker builds an AgentsRpcContext whose notify writes
    // into the controller. Broadcasting an HTTP caller's brief onto the socket would hand a private
    // brief to every other local client.
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({ db, runs, router: undefined })(
      "expert",
      { topicOrFile: "auth.ts" },
      "chrome",
    );
    if (!out.ok) throw new Error("unreachable");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && runs.get(out.runId)?.status === "running") {
      await Bun.sleep(20);
    }
    expect(runs.get(out.runId)?.status).not.toBe("running");
  });
});

describe("buildAgentHttpInvoker — the synthesis runner (Task 6: production wiring)", () => {
  // "Socket" here means "constructed the same way ipc/server/dispatchers.ts's tryDispatchAgentsRpc
  // does" (briefViaSocket calls dispatchAgentsRpc in-process) — this proves buildAgentSynthesisRunner
  // factory-level identity between the two production call sites, not equivalence over a real
  // socket transport; neither path opens an actual IPC socket.
  test("HTTP invocation and the socket-path construction remain identical under every synthesis mode (factory-level identity, not a real socket transport)", async () => {
    for (const mode of ["off", "local", "allow-remote"] as const) {
      const configDir = makeAgentsConfigDir(mode);
      const db = freshDb();
      const router = fakeLocalRouter("SAME-MARKDOWN-MARKER");

      const viaSocket = await briefViaSocket(configDir, router, db, { ref: "x" });
      const viaHttp = await briefViaHttp(configDir, router, db, { ref: "x" });

      // `briefViaSocket` returns undefined when its 5 s deadline expires, and
      // `stripLatencyFooter(undefined)` returns null. Without this assertion a socket-path
      // TIMEOUT makes both sides of the comparison below null and the parity check passes
      // vacuously — this test exists to prove factory-level identity, so an absent socket
      // brief must fail it rather than match an absent HTTP one.
      expect(viaSocket).toBeDefined();
      expect(stripLatencyFooter(viaHttp.brief as string | null)).toEqual(
        stripLatencyFooter(viaSocket?.brief as string | null),
      );
      expect(viaHttp.synthesis).toEqual(viaSocket?.synthesis);
    }
  });

  test("a synthesis-eligible context is actually supplied to the HTTP invoker — not omitted as before", async () => {
    const configDir = makeAgentsConfigDir("local");
    const db = freshDb();
    const runs = makeRuns();
    const router = fakeLocalRouter("HTTP-SUPPLIED-MARKER");

    const out = await buildAgentHttpInvoker({ db, runs, configDir, router })(
      "why",
      { ref: "x" },
      "chrome",
    );
    if (!out.ok) throw new Error("unreachable");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && runs.get(out.runId)?.status === "running") {
      await Bun.sleep(10);
    }
    const run = runs.get(out.runId);
    expect(run?.synthesis).toMatchObject({ attempted: true, used: true, model: "fake-model" });
    expect(run?.brief).toContain("HTTP-SUPPLIED-MARKER");
  });

  test("with no router supplied, the runner is skipped — same deterministic brief as before Task 6", async () => {
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({ db, runs, router: undefined })(
      "why",
      { ref: "x" },
      "chrome",
    );
    if (!out.ok) throw new Error("unreachable");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && runs.get(out.runId)?.status === "running") {
      await Bun.sleep(10);
    }
    const run = runs.get(out.runId);
    expect(run?.synthesis).toMatchObject({ attempted: false, reason: "disabled" });
  });

  test("wiring the HTTP runner causes NO remote egress on a default install (no configDir → synthesis=local, a REMOTE-only router)", async () => {
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({ db, runs, router: fakeRemoteRouter() })(
      "why",
      { ref: "x" },
      "chrome",
    );
    if (!out.ok) throw new Error("unreachable");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && runs.get(out.runId)?.status === "running") {
      await Bun.sleep(10);
    }
    const run = runs.get(out.runId);
    // "local" (the default) refuses a resolved REMOTE provider — no_eligible_provider, not "used".
    expect(run?.synthesis).toMatchObject({ attempted: false, reason: "no_eligible_provider" });
    const synthesisRows = db
      .query(`SELECT method FROM egress_ledger WHERE method LIKE '%.synthesis'`)
      .all();
    expect(synthesisRows).toEqual([]);
  });
});
