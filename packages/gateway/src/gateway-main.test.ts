import { describe, expect, test } from "bun:test";

import { agentRequestContext } from "./engine/agent-request-context.ts";
import {
  drainNegationDisclosures,
  recordNegationDisclosure,
} from "./engine/negation-disclosure.ts";
import type { RunAskParams } from "./engine/run-ask.ts";
import { createChatOpsAskEngine } from "./gateway-main.ts";

// IMPORTANT 1: the ChatOps read path is the only `runAsk` caller not already inside
// `agentRequestContext.run` (the other three sites are `ipc/server/inline-handlers.ts` at
// :96, :215, :350). Without its own request store, a negation tool's refusal/exclusion
// disclosure recorded during the turn has nowhere to land and is silently dropped — see
// `engine/negation-disclosure.ts`'s `store === undefined` branch.
describe("createChatOpsAskEngine", () => {
  test("a disclosure recorded during the turn reaches the reply", async () => {
    // Stand-in for `runAsk`: records a disclosure exactly like a negation tool would, then
    // drains + appends it exactly like `runConversationalAgent`'s `appendNegationDisclosures`
    // does — both only work if this call is running inside an `agentRequestContext` store.
    const fakeRunAsk = async (_params: RunAskParams): Promise<{ reply: string }> => {
      recordNegationDisclosure(
        "findPrsNotTouching could not be verified: no data indexed. sync a connector.",
      );
      const lines = drainNegationDisclosures();
      const suffix = lines.length === 0 ? "" : `\n\n${lines.join("\n")}`;
      return { reply: `ok${suffix}` };
    };

    const engine = createChatOpsAskEngine(
      (query) => ({ input: query }) as RunAskParams,
      fakeRunAsk,
    );

    const reply = await engine("do any open PRs not touch src/?", "eng");
    expect(reply).toContain("ok");
    expect(reply).toContain("findPrsNotTouching could not be verified");
  });

  test("without the wrapper (bare fakeRunAsk call, no request store) the disclosure is dropped", async () => {
    // Sanity check that the harness itself proves something: calling the stand-in OUTSIDE any
    // agentRequestContext store — i.e. skipping the fix — reproduces the original bug.
    const fakeRunAsk = async (_params: RunAskParams): Promise<{ reply: string }> => {
      recordNegationDisclosure("dropped: no store on this turn");
      const lines = drainNegationDisclosures();
      const suffix = lines.length === 0 ? "" : `\n\n${lines.join("\n")}`;
      return { reply: `ok${suffix}` };
    };
    expect(agentRequestContext.getStore()).toBeUndefined();
    const reply = await fakeRunAsk({ input: "x" } as RunAskParams);
    expect(reply.reply).toBe("ok");
    expect(reply.reply).not.toContain("dropped");
  });

  test("each query gets its own params, built fresh per call", async () => {
    const seen: string[] = [];
    const fakeRunAsk = async (params: RunAskParams): Promise<{ reply: string }> => {
      seen.push(params.input);
      return { reply: `echo:${params.input}` };
    };
    const engine = createChatOpsAskEngine(
      (query) => ({ input: query }) as RunAskParams,
      fakeRunAsk,
    );

    expect(await engine("first", "ns")).toBe("echo:first");
    expect(await engine("second", "ns")).toBe("echo:second");
    expect(seen).toEqual(["first", "second"]);
  });
});
