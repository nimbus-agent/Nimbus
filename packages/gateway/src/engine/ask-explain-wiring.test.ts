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

  test("a fallback turn that ALSO built local context surfaces the pool, not just the fallback", async () => {
    // The controller's ruling: `promptWithContext` is built ONCE, above the router-vs-agent fork
    // (`run-conversational-agent.ts`), so the pre-ranked local pool built here genuinely reached
    // the agent's prompt on fallback. Reporting `agent_tools` with no pool would under-report on
    // exactly the turn a user is most likely to be debugging.
    const r = new AskExplainRecorder();
    await runAsk(
      makeRunAskParams({
        input: "widget",
        explainRecorder: r,
        localRouterThrows: "connect ECONNREFUSED",
        seedMatchingTitle: "widget status page",
      }),
    );
    const last = r.last();
    expect(last?.route).toBe("agent_tools");
    expect(last?.fallbackFromLocalRouter?.error).toContain("ECONNREFUSED");
    const localContextAlsoGiven =
      last?.route === "agent_tools" ? last.localContextAlsoGiven : undefined;
    expect(localContextAlsoGiven).toBeDefined();
    expect(localContextAlsoGiven?.pool.length ?? 0).toBeGreaterThan(0);
    expect(localContextAlsoGiven?.searchTerms).toBe("widget");
  });

  test("a non-fallback agent_tools turn (no local context built) carries no localContextAlsoGiven", async () => {
    // The absence contract: `shouldBuildLocalContext` is false on the pure agent route (no
    // `llmRouter` at all here), so this turn never even attempts retrieval — absence must mean
    // "none was built", not "we lost it".
    const r = new AskExplainRecorder();
    await runAsk(
      makeRunAskParams({
        input: "list my PRs",
        explainRecorder: r,
        omitConversationalAgent: false,
      }),
    );
    const last = r.last();
    expect(last?.route).toBe("agent_tools");
    expect(last?.route === "agent_tools" ? last.localContextAlsoGiven : "present").toBeUndefined();
  });

  test("persona is pinned to '<tone>/<voice>' for the default (unconfigured) profile", async () => {
    const r = new AskExplainRecorder();
    await runAsk(makeRunAskParams({ input: "q", explainRecorder: r }));
    // stubPaths.configDir has no nimbus.toml, so `resolvePersona` returns
    // `DEFAULT_NIMBUS_PERSONA_TOML` (`{ tone: "neutral", voice: "neutral" }`).
    expect(r.last()?.persona).toBe("neutral/neutral");
  });

  test("plan_dispatch's plan field is pinned to 'reply: <text>' for a resolved reply plan", async () => {
    const r = new AskExplainRecorder();
    // No conversational agent and no local router: `canUseConversation` is false, so `runAsk`
    // dispatches the classifier's resolved plan instead of answering conversationally — the only
    // way to reach `plan_dispatch` with this test helper.
    await runAsk(
      makeRunAskParams({
        input: "move a file",
        explainRecorder: r,
        omitConversationalAgent: true,
        classifyAs: { intent: "file_organize", entities: {}, requiresHITL: true, confidence: 1 },
      }),
    );
    const last = r.last();
    expect(last?.route).toBe("plan_dispatch");
    expect(last?.route === "plan_dispatch" ? last.plan : undefined).toBe(
      "reply: Please specify both source and destination paths for the move.",
    );
  });
});
