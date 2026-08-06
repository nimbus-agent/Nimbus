// packages/gateway/src/agent-runs/agent-run-store.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import {
  AgentRunController,
  MAX_CONCURRENT_AGENT_RUNS,
  MAX_RETAINED_TERMINAL_AGENT_RUNS,
} from "./agent-run-store.ts";

let now = 1_000;

function makeController(ttlMs?: number): AgentRunController {
  return new AgentRunController({ nowMs: () => now, ...(ttlMs === undefined ? {} : { ttlMs }) });
}

beforeEach(() => {
  now = 1_000;
});

describe("AgentRunController", () => {
  test("an opened run is readable and running", () => {
    const c = makeController();
    expect(c.admit()).toEqual({ ok: true });
    c.open("expert_1_aaaa");
    expect(c.get("expert_1_aaaa")?.status).toBe("running");
  });

  test("a briefReady notification finishes the run with markdown and findings", () => {
    const c = makeController();
    c.admit();
    c.open("expert_1_aaaa");
    c.observe("expert.briefReady", {
      sessionId: "expert_1_aaaa",
      brief: "# Expert\n",
      findings: { gaps: [] },
    });
    const run = c.get("expert_1_aaaa");
    expect(run?.status).toBe("done");
    expect(run?.brief).toBe("# Expert\n");
    expect(run?.findings).toEqual({ gaps: [] });
    expect(run?.error).toBeNull();
  });

  test("a briefError notification fails the run and carries no brief", () => {
    const c = makeController();
    c.admit();
    c.open("why_1_bbbb");
    c.observe("why.briefError", { sessionId: "why_1_bbbb", error: "index unavailable" });
    const run = c.get("why_1_bbbb");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("index unavailable");
    expect(run?.brief).toBeNull();
  });

  test("a brief that completes BEFORE open is adopted, not lost", () => {
    // emitBriefWithSynthesis starts its async IIFE BEFORE returning {sessionId}, so notify can fire
    // against an id the controller has never seen. If observe dropped it — or if open reset the
    // adopted run back to `running` — a fast agent's brief would be a permanent 404, then a 410.
    const c = makeController();
    c.admit();
    c.observe("catchup.briefReady", { sessionId: "catchup_1_cccc", brief: "md", findings: null });
    c.open("catchup_1_cccc");
    const run = c.get("catchup_1_cccc");
    expect(run?.status).toBe("done");
    expect(run?.brief).toBe("md");
  });

  test("observe ignores a notification with no usable sessionId", () => {
    const c = makeController();
    c.observe("expert.briefReady", { brief: "md" });
    c.observe("expert.briefReady", { sessionId: 42 });
    c.observe("expert.briefReady", { sessionId: "" });
    c.observe("expert.briefReady", null);
    c.observe("expert.briefReady", "not-an-object");
    expect(c.activeCount()).toBe(0);
  });

  test("observe ignores a method that is neither briefReady nor briefError", () => {
    // The sink is shared with whatever else an AgentsRpcContext.notify may carry; anything it does
    // not recognise must be ignored rather than guessed at.
    const c = makeController();
    c.observe("index.syncProgress", { sessionId: "expert_1_dddd" });
    expect(c.get("expert_1_dddd")).toBeNull();
  });

  test("the concurrency cap counts RESERVATIONS, not just opened runs", () => {
    // The cap must hold across the await between admit() and open(): two in-flight dispatches that
    // both passed a plain activeCount() check would over-admit by exactly the number in flight.
    const c = makeController();
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) {
      expect(c.admit()).toEqual({ ok: true });
    }
    expect(c.admit()).toEqual({
      ok: false,
      activeRuns: MAX_CONCURRENT_AGENT_RUNS,
      // Every slot here is a reservation, not an opened run — so no run's expiry bounds the wait
      // and there is no honest number to report. null, never a fabricated 0 or an Infinity that
      // JSON.stringify would silently turn into null meaning something else.
      oldestExpiresInSeconds: null,
    });
  });

  test("a busy refusal over OPEN runs reports when the soonest one expires", () => {
    const c = makeController(5_000);
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) {
      c.admit();
      c.open(`expert_1_h${String(i)}`);
    }
    now += 2_000;
    expect(c.admit()).toEqual({
      ok: false,
      activeRuns: MAX_CONCURRENT_AGENT_RUNS,
      // 5s TTL, 2s elapsed. The UPPER bound on the wait, not the expected one: a run normally
      // finishes and frees its slot long before it expires. The route sends the small
      // AGENT_BUSY_RETRY_AFTER_SECONDS as Retry-After and this only as context in the body.
      oldestExpiresInSeconds: 3,
    });
  });

  test("abandon releases a reservation", () => {
    const c = makeController();
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) c.admit();
    expect(c.admit().ok).toBe(false);
    c.abandon();
    expect(c.admit()).toEqual({ ok: true });
  });

  test("abandon never drives the reservation count negative", () => {
    // A stray abandon (a double-release on an error path) must not manufacture capacity.
    const c = makeController();
    c.abandon();
    c.abandon();
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(c.admit().ok).toBe(true);
    expect(c.admit().ok).toBe(false);
  });

  test("a terminal run does not hold a concurrency slot", () => {
    const c = makeController();
    c.admit();
    c.open("expert_1_eeee");
    c.observe("expert.briefReady", { sessionId: "expert_1_eeee", brief: "md", findings: null });
    expect(c.activeCount()).toBe(0);
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) expect(c.admit().ok).toBe(true);
  });

  test("a run past its TTL expires and becomes a 410 signal", () => {
    const c = makeController(5_000);
    c.admit();
    c.open("expert_1_ffff");
    now += 5_001;
    expect(c.get("expert_1_ffff")).toBeNull();
    expect(c.wasKnown("expert_1_ffff")).toBe(true);
  });

  test("an id that never existed is a 404 signal, not a 410", () => {
    const c = makeController();
    expect(c.get("expert_1_nope")).toBeNull();
    expect(c.wasKnown("expert_1_nope")).toBe(false);
  });

  test("expiry happens without anyone polling", () => {
    // Access-triggered expiry alone would let three never-polled runs pin the cap until restart.
    const c = makeController(5_000);
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) {
      c.admit();
      c.open(`expert_1_${String(i)}`);
    }
    expect(c.admit().ok).toBe(false);
    now += 5_001;
    expect(c.admit()).toEqual({ ok: true });
  });

  test("the TTL is NOT refreshed by polling — a polling client cannot pin memory", () => {
    const c = makeController(5_000);
    c.admit();
    c.open("expert_1_gggg");
    now += 4_000;
    expect(c.get("expert_1_gggg")).not.toBeNull(); // a poll
    now += 1_001;
    expect(c.get("expert_1_gggg")).toBeNull();
  });

  test("retained terminal runs are bounded, oldest evicted first", () => {
    const c = makeController();
    for (let i = 0; i < MAX_RETAINED_TERMINAL_AGENT_RUNS + 2; i++) {
      now += 1;
      c.admit();
      const id = `expert_${String(i)}_g`;
      c.open(id);
      c.observe("expert.briefReady", { sessionId: id, brief: "md", findings: null });
    }
    expect(c.get("expert_0_g")).toBeNull();
    expect(c.wasKnown("expert_0_g")).toBe(true);
    expect(c.get(`expert_${String(MAX_RETAINED_TERMINAL_AGENT_RUNS + 1)}_g`)).not.toBeNull();
  });
});
