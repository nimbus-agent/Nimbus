import { describe, expect, test } from "bun:test";
import { agentRequestContext } from "./agent-request-context.ts";
import { AskExplainRecorder } from "./ask-explain-recorder.ts";
import { makeRunAskParams } from "./run-ask.test-helpers.ts";
import { runAsk } from "./run-ask.ts";

/** Only overrides `record` — every other `AskExplainRecorder` behavior stays real. */
class ThrowingRecorder extends AskExplainRecorder {
  override record(): void {
    throw new Error("recorder boom");
  }
}

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

    // Baseline: the SAME input/seed, but the local router SUCCEEDS — the plain `local_context`
    // route, whose own `truncation` the fallback arm's copy is compared against below. `atLeast`
    // is the field that forces `truncation` into the payload at all: it says the probe itself hit
    // its ceiling, so `total` is a FLOOR rather than an exact count — not derivable from the pool.
    await runAsk(
      makeRunAskParams({
        input: "widget",
        explainRecorder: r,
        localRouterSucceeds: true,
        seedMatchingTitle: "widget status page",
      }),
    );
    const baseline = r.last();
    expect(baseline?.route).toBe("local_context");
    const baselineTruncation =
      baseline?.route === "local_context" ? baseline.truncation : undefined;
    expect(baselineTruncation).toBeDefined();

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
    // The field this fix adds: the fallback arm's truncation is not merely PRESENT, it carries
    // the exact same values the local_context route recorded for the identical turn.
    expect(localContextAlsoGiven?.truncation).toBeDefined();
    expect(localContextAlsoGiven?.truncation).toEqual(baselineTruncation);
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

  test("a connector-dispatch failure is recorded at stage 'dispatch', not 'model', and keeps the plan", async () => {
    // Fix-wave finding IMPORTANT 3: everything up to and including plan construction is the
    // "model" stage, but the actual connector dispatch is a DIFFERENT stage — a connector or
    // executor failure here must never be reported as a model failure.
    const r = new AskExplainRecorder();
    await runAsk(
      makeRunAskParams({
        input: "find files named report",
        explainRecorder: r,
        omitConversationalAgent: true,
        classifyAs: {
          intent: "file_search",
          entities: { pattern: "report*.md" },
          requiresHITL: false,
          confidence: 1,
        },
        dispatcherThrows: "ECONNRESET talking to the connector",
      }),
    ).catch(() => undefined);

    const last = r.last();
    expect(last?.route).toBe("failed");
    expect(last?.route === "failed" ? last.stage : undefined).toBe("dispatch");
    expect(last?.route === "failed" ? last.error : undefined).toContain(
      "ECONNRESET talking to the connector",
    );
    // The plan being dispatched must survive onto the failure record — otherwise a
    // dispatch-stage failure discards the one piece of context ("what was being attempted") a
    // reader needs most.
    expect(last?.route === "failed" ? last.plan : undefined).toBe(
      "actions: filesystem_search_files",
    );
  });

  test("classifier destination is captured from a real router.generate round-trip", async () => {
    // `makeRunAskParams` normally injects `classify` unconditionally, which
    // `classifyIntentForAskWithLocalFallback` prefers over the real classifier
    // (`p.classify ?? (...)`) — so the wrapped `policy.generate` closure that captures
    // `classifierDestination` never runs under that default. `realClassifierRouter` omits the
    // injected `classify` and routes the REAL `classifyIntentForAsk` -> `classifyIntent` through a
    // router double, the only way to exercise that capture.
    const r = new AskExplainRecorder();
    await runAsk(
      makeRunAskParams({
        input: "what files do I have",
        explainRecorder: r,
        realClassifierRouter: {
          responseText: JSON.stringify({
            intent: "unknown",
            entities: {},
            requiresHITL: false,
            confidence: 0,
          }),
          provider: "test-vendor",
        },
      }),
    );
    const last = r.last();
    expect(last?.classifier.called).toBe(true);
    expect(last?.classifier.called === true ? last.classifier.destination : undefined).toBe(
      "test-vendor",
    );
  });

  test("a recorder that throws never changes runAsk's own success or failure", async () => {
    // Task 5 learned this the hard way over `recordExplainToolCall`: a diagnostic evaluated
    // unguarded can destroy the result it is describing. The controller's ruling: the same shape
    // existed here (`buildExplainRecord(...)` evaluated INSIDE the try), currently latent only
    // because `resolvePersona` happens to swallow its own errors — luck, not design.
    const throwing = new ThrowingRecorder();

    // Success path: the answer must survive a throwing recorder.
    const ok = await runAsk(makeRunAskParams({ input: "ok question", explainRecorder: throwing }));
    expect(ok.reply.length).toBeGreaterThan(0);

    // Throw path: the ORIGINAL error must survive, not a recorder-building error.
    let caught: unknown;
    try {
      await runAsk(
        makeRunAskParams({ input: "boom", explainRecorder: throwing, throwAt: "model" }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String(caught)).not.toContain("recorder boom");
  });
});
