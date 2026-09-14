import { describe, expect, test } from "bun:test";
import { agentRequestContext } from "./agent-request-context.ts";
import { AskExplainRecorder } from "./ask-explain-recorder.ts";
import { makeRunAskParams } from "./run-ask.test-helpers.ts";
import { runAsk } from "./run-ask.ts";

describe("recorder wiring (spec §4.2)", () => {
  test("a failed ask is recorded, so explain last cannot show the previous success", async () => {
    const r = new AskExplainRecorder();
    await runAsk(makeRunAskParams({ input: "ok question", explainRecorder: r }));
    await runAsk(makeRunAskParams({ input: "boom", explainRecorder: r, throwAt: "model" })).catch(
      () => undefined,
    );
    const last = r.last();
    expect(last?.route).toBe("failed");
    expect(last?.question).toBe("boom");
    // The defect this guards: recording only on success leaves `explain last` showing the
    // PREVIOUS successful ask at the moment the user most needs the truth.
    expect(last?.question).not.toBe("ok question");
  });

  test("source is chatops when the gateway bound that clientId, local otherwise", async () => {
    const r = new AskExplainRecorder();
    await runAsk(makeRunAskParams({ input: "q", explainRecorder: r, clientId: "chatops" }));
    expect(r.last()?.source).toBe("chatops");
    await runAsk(makeRunAskParams({ input: "q", explainRecorder: r, clientId: "sock-17" }));
    expect(r.last()?.source).toBe("local");
  });

  test("a local-router failure that fell back to the agent is recorded as such", async () => {
    const r = new AskExplainRecorder();
    await runAsk(
      makeRunAskParams({
        input: "q",
        explainRecorder: r,
        localRouterThrows: "connect ECONNREFUSED",
      }),
    );
    expect(r.last()?.fallbackFromLocalRouter?.error).toContain("ECONNREFUSED");
    expect(r.last()?.route).toBe("agent_tools");
  });

  test("an agent-route ask carries the tool calls Task 5 collected", async () => {
    const r = new AskExplainRecorder();
    // Tool-call collection is per-request-store (`agent-request-context.ts`), so this wraps the
    // call the way all four production `runAsk` call sites already do (three in
    // `ipc/server/inline-handlers.ts`, one explicitly in `gateway-main.ts` for ChatOps).
    await agentRequestContext.run({}, () =>
      runAsk(
        makeRunAskParams({
          input: "list my PRs",
          explainRecorder: r,
          agentToolCalls: ["searchLocalIndex"],
        }),
      ),
    );
    const last = r.last();
    expect(last?.route).toBe("agent_tools");
    // Guards the drain: an implementation that fills `toolCalls: []` passes every other test here.
    expect(last?.route === "agent_tools" ? last.toolCalls : []).toHaveLength(1);
    expect(last?.route === "agent_tools" ? last.toolCalls[0]?.toolId : undefined).toBe(
      "searchLocalIndex",
    );
  });
});
