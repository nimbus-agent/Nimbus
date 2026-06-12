import { describe, expect, mock, test } from "bun:test";
import { emitBriefWithSynthesis } from "./emit-brief.ts";
import type { ExpertBrief } from "./findings.ts";

function fakeBrief(): ExpertBrief {
  return {
    kind: "expert",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 1,
    gaps: [],
    query: { topicOrFile: "x" },
    ranked: [],
  };
}

async function waitMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("emitBriefWithSynthesis", () => {
  test("calls buildBrief and notifies briefReadyMethod with sessionId + markdown + findings", async () => {
    const notified: Array<{ method: string; params: unknown }> = [];
    const brief = fakeBrief();
    const { sessionId } = await emitBriefWithSynthesis({
      sessionId: "sess-1",
      briefReadyMethod: "expert.briefReady",
      briefErrorMethod: "expert.briefError",
      notify: (method, params) => notified.push({ method, params }),
      buildBrief: async () => brief,
    });
    expect(sessionId).toBe("sess-1");
    await waitMacrotask();
    const ready = notified.find((n) => n.method === "expert.briefReady");
    expect(ready).toBeDefined();
    const p = ready?.params as { sessionId: string; brief: string; findings: ExpertBrief };
    expect(p.sessionId).toBe("sess-1");
    expect(p.findings).toBe(brief);
    expect(typeof p.brief).toBe("string");
    expect(p.brief.length).toBeGreaterThan(0);
  });

  test("emits briefErrorMethod when buildBrief throws", async () => {
    const notified: Array<{ method: string; params: unknown }> = [];
    await emitBriefWithSynthesis({
      sessionId: "sess-err",
      briefReadyMethod: "expert.briefReady",
      briefErrorMethod: "expert.briefError",
      notify: (method, params) => notified.push({ method, params }),
      buildBrief: async () => {
        throw new Error("build exploded");
      },
    });
    await waitMacrotask();
    const err = notified.find((n) => n.method === "expert.briefError");
    expect(err).toBeDefined();
    const p = err?.params as { sessionId: string; error: string };
    expect(p.sessionId).toBe("sess-err");
    expect(p.error).toBe("build exploded");
    expect(notified.some((n) => n.method === "expert.briefReady")).toBe(false);
  });

  test("passes llm option through to synthesize", async () => {
    const generateMarkdown = mock(async (_prompt: string) => "## llm-rendered");
    const notified: Array<{ method: string; params: unknown }> = [];
    await emitBriefWithSynthesis({
      sessionId: "sess-llm",
      briefReadyMethod: "impact.briefReady",
      briefErrorMethod: "impact.briefError",
      notify: (method, params) => notified.push({ method, params }),
      llm: { generateMarkdown },
      buildBrief: async () => fakeBrief(),
    });
    await waitMacrotask();
    expect(generateMarkdown).toHaveBeenCalledTimes(1);
    const ready = notified.find((n) => n.method === "impact.briefReady");
    const p = ready?.params as { brief: string };
    expect(p.brief).toBe("## llm-rendered");
  });

  test("emits briefErrorMethod with String(err) when buildBrief throws a non-Error value", async () => {
    const notified: Array<{ method: string; params: unknown }> = [];
    await emitBriefWithSynthesis({
      sessionId: "sess-non-error",
      briefReadyMethod: "expert.briefReady",
      briefErrorMethod: "expert.briefError",
      notify: (method, params) => notified.push({ method, params }),
      buildBrief: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "plain string error";
      },
    });
    await waitMacrotask();
    const err = notified.find((n) => n.method === "expert.briefError");
    expect(err).toBeDefined();
    const p = err?.params as { sessionId: string; error: string };
    expect(p.sessionId).toBe("sess-non-error");
    expect(p.error).toBe("plain string error");
    expect(notified.some((n) => n.method === "expert.briefReady")).toBe(false);
  });

  test("emits briefErrorMethod with String(err) when buildBrief throws a numeric value", async () => {
    const notified: Array<{ method: string; params: unknown }> = [];
    await emitBriefWithSynthesis({
      sessionId: "sess-num-error",
      briefReadyMethod: "expert.briefReady",
      briefErrorMethod: "expert.briefError",
      notify: (method, params) => notified.push({ method, params }),
      buildBrief: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 42;
      },
    });
    await waitMacrotask();
    const err = notified.find((n) => n.method === "expert.briefError");
    expect(err).toBeDefined();
    const p = err?.params as { sessionId: string; error: string };
    expect(p.sessionId).toBe("sess-num-error");
    expect(p.error).toBe("42");
    expect(notified.some((n) => n.method === "expert.briefReady")).toBe(false);
  });

  test("returns { sessionId } immediately without awaiting the async work", async () => {
    let buildCalledAt: number | null = null;
    const buildBrief = async (): Promise<ExpertBrief> => {
      buildCalledAt = Date.now();
      await new Promise((r) => setTimeout(r, 25));
      return fakeBrief();
    };
    const tStart = Date.now();
    const handle = await emitBriefWithSynthesis({
      sessionId: "sess-sync",
      briefReadyMethod: "expert.briefReady",
      briefErrorMethod: "expert.briefError",
      notify: () => undefined,
      buildBrief,
    });
    const tAfterReturn = Date.now();
    expect(handle.sessionId).toBe("sess-sync");
    expect(tAfterReturn - tStart).toBeLessThan(20);
    expect(buildCalledAt).not.toBeNull();
  });
});
