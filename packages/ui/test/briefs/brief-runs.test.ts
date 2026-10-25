import { describe, expect, it } from "vitest";
import {
  applyOutcome,
  BRIEF_WAIT_DEADLINE_MS,
  EARLY_BUFFER_MAX,
  EARLY_BUFFER_TTL_MS,
  emptyBriefRuns,
  isPastDeadline,
  latestRun,
  parseBriefNotification,
  RUNS_PER_AGENT,
  registerRun,
} from "../../src/briefs/brief-runs";

const ready = { kind: "ready", markdown: "# hi" } as const;

describe("brief-runs", () => {
  it("an outcome for a registered pending run completes it", () => {
    let s = registerRun(emptyBriefRuns(), "decisions", "s1", 100);
    s = applyOutcome(s, "s1", ready, 200);
    expect(latestRun(s, "decisions")).toMatchObject({
      status: "ready",
      markdown: "# hi",
      finishedAt: 200,
    });
  });

  it("an outcome arriving BEFORE registerRun is applied when the run registers", () => {
    let s = applyOutcome(emptyBriefRuns(), "s1", ready, 100);
    expect(s.runs.size).toBe(0);
    s = registerRun(s, "decisions", "s1", 150);
    expect(latestRun(s, "decisions")?.status).toBe("ready");
    expect(s.early).toHaveLength(0);
  });

  it("an early outcome older than 60_000 ms is dropped, and the buffer keeps at most 20", () => {
    let s = applyOutcome(emptyBriefRuns(), "old", ready, 0);
    s = registerRun(s, "decisions", "old", EARLY_BUFFER_TTL_MS + 1);
    expect(latestRun(s, "decisions")?.status).toBe("pending");

    let b = emptyBriefRuns();
    for (let i = 0; i < EARLY_BUFFER_MAX + 5; i++) b = applyOutcome(b, `e${i}`, ready, 10);
    expect(b.early).toHaveLength(EARLY_BUFFER_MAX);
    expect(b.early[0]?.sessionId).toBe("e5");
  });

  it("an outcome for an unknown session never creates a run", () => {
    const s = applyOutcome(emptyBriefRuns(), "ghost", ready, 1);
    expect(s.runs.size).toBe(0);
    expect(latestRun(s, "decisions")).toBeUndefined();
  });

  it("a second outcome for a finished run is ignored", () => {
    let s = registerRun(emptyBriefRuns(), "a", "s1", 1);
    s = applyOutcome(s, "s1", ready, 2);
    s = applyOutcome(s, "s1", { kind: "error", message: "boom" }, 3);
    expect(latestRun(s, "a")).toMatchObject({ status: "ready", finishedAt: 2 });
  });

  it("keeps 5 runs per agent, dropping the oldest requested", () => {
    let s = emptyBriefRuns();
    for (let i = 0; i < RUNS_PER_AGENT + 1; i++) s = registerRun(s, "a", `s${i}`, i);
    expect(s.byAgent["a"]).toEqual(["s5", "s4", "s3", "s2", "s1"]);
    expect(s.runs.has("s0")).toBe(false);
    expect(s.runs.size).toBe(RUNS_PER_AGENT);
  });

  it("latestRun is the most recently REQUESTED run even if an older one finished later", () => {
    let s = registerRun(emptyBriefRuns(), "a", "old", 1);
    s = registerRun(s, "a", "new", 2);
    s = applyOutcome(s, "old", ready, 3);
    expect(latestRun(s, "a")?.sessionId).toBe("new");
  });

  it("isPastDeadline is true at requestedAt + 600_000 for a pending run, false once finished", () => {
    let s = registerRun(emptyBriefRuns(), "a", "s1", 1000);
    const pending = latestRun(s, "a");
    if (!pending) throw new Error("no run");
    expect(isPastDeadline(pending, 1000 + BRIEF_WAIT_DEADLINE_MS - 1)).toBe(false);
    expect(isPastDeadline(pending, 1000 + BRIEF_WAIT_DEADLINE_MS)).toBe(true);
    s = applyOutcome(s, "s1", ready, 2000);
    const done = latestRun(s, "a");
    if (!done) throw new Error("no run");
    expect(isPastDeadline(done, 1000 + BRIEF_WAIT_DEADLINE_MS)).toBe(false);
  });

  it("parseBriefNotification ignores gateway.event and malformed params", () => {
    expect(
      parseBriefNotification({ method: "gateway.event", params: { sessionId: "s", brief: "x" } }),
    ).toBeNull();
    expect(
      parseBriefNotification({ method: "decisions.briefReady", params: { sessionId: "s" } }),
    ).toBeNull();
    expect(
      parseBriefNotification({ method: "decisions.briefReady", params: { brief: "x" } }),
    ).toBeNull();
    expect(
      parseBriefNotification({
        method: "decisions.briefReady",
        params: { sessionId: "s", brief: "x" },
      }),
    ).toEqual({ sessionId: "s", outcome: { kind: "ready", markdown: "x" } });
    expect(
      parseBriefNotification({ method: "why.briefError", params: { sessionId: "s", error: "e" } }),
    ).toEqual({ sessionId: "s", outcome: { kind: "error", message: "e" } });
  });
});
