// packages/gateway/src/agent-runs/agent-http-invoke.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { buildAgentHttpInvoker } from "./agent-http-invoke.ts";
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

describe("buildAgentHttpInvoker", () => {
  test("an unknown agent is refused before any admission is spent", async () => {
    const db = freshDb();
    const runs = makeRuns();
    const out = await buildAgentHttpInvoker({ db, runs })("nope", {}, "chrome");
    expect(out).toEqual({ ok: false, reason: "unknown_agent" });
    // No reservation leaked: the cap is still fully available.
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(runs.admit().ok).toBe(true);
  });

  test("preflight is refused as unknown, and appends nothing", async () => {
    // I24. Refused at the resolver, so it never reaches the dispatcher and never ledgers.
    const db = freshDb();
    const out = await buildAgentHttpInvoker({ db, runs: makeRuns() })(
      "preflight",
      { ref: "HEAD", namespace: "n" },
      "chrome",
    );
    expect(out).toEqual({ ok: false, reason: "unknown_agent" });
    expect(countLedger(db)).toBe(0);
  });

  test("whyPeek is refused as unknown too", async () => {
    const db = freshDb();
    const out = await buildAgentHttpInvoker({ db, runs: makeRuns() })(
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
    const out = await buildAgentHttpInvoker({ db, runs })(
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
    await buildAgentHttpInvoker({ db, runs: makeRuns() })(
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
    const out = await buildAgentHttpInvoker({ db, runs })("expert", { topicOrFile: "" }, "chrome");
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
    await buildAgentHttpInvoker({ db, runs: makeRuns() })("expert", { topicOrFile: "" }, "chrome");
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
      await buildAgentHttpInvoker({ db, runs })("expert", { topicOrFile: "x" }, "chrome"),
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
      buildAgentHttpInvoker({ db, runs })("expert", { topicOrFile: "x" }, "chrome"),
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
    const out = await buildAgentHttpInvoker({ db, runs })(
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
