import { describe, expect, test } from "bun:test";

import { LlmProviderError } from "../llm/provider-error.ts";
import type { LlmGenerateOptions, LlmGenerateResult } from "../llm/types.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { type ClassifierEgressPolicy, classifyIntent } from "./router.ts";

/**
 * The classifier reaches a vendor ONLY through `LlmRouter.generate`, so every test here injects
 * that one function. There is deliberately no `fetch` stub and no `ANTHROPIC_API_KEY` in this
 * file: before 2026-08-28 the classifier held its own HTTP client and read those keys from the
 * environment, egressing with no `egress_ledger` row and no `[llm.remote.*]` opt-in. A test that
 * still stubbed `fetch` would be testing a path that must not come back.
 */
const BUN_NATIVE_FETCH = globalThis.fetch;

type Recorded = { calls: LlmGenerateOptions[] };

const UNKNOWN_REPLY = JSON.stringify({ intent: "unknown", entities: {}, confidence: 1 });
const SEARCH_REPLY = JSON.stringify({ intent: "file_search", entities: {}, confidence: 1 });
const ARRAY_REPLY = JSON.stringify(["a"]);

/** A router whose single route answers with `text`. */
function replying(text: string, rec?: Recorded): ClassifierEgressPolicy {
  return {
    enforceAirGap: false,
    generate: async (opts) => {
      rec?.calls.push(opts);
      return {
        text,
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: "stub-model",
        isLocal: true,
        provider: "stub",
      } satisfies LlmGenerateResult;
    },
  };
}

/** A router whose walk fails with `err`. */
function failing(err: unknown, enforceAirGap = false): ClassifierEgressPolicy {
  return {
    enforceAirGap,
    generate: async () => {
      throw err;
    },
  };
}

async function reasonOf(policy: ClassifierEgressPolicy, input = "find my notes"): Promise<string> {
  try {
    await classifyIntent(input, policy);
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError) return e.reason;
    throw e;
  }
  throw new Error("expected classifyIntent to throw");
}

describe("classifyIntent — empty input", () => {
  test("empty string returns unknown,confidence 1 without reaching the router", async () => {
    const rec: Recorded = { calls: [] };
    const result = await classifyIntent("", replying("{}", rec));
    expect(result).toEqual({
      intent: "unknown",
      entities: {},
      requiresHITL: false,
      confidence: 1,
    });
    expect(rec.calls).toHaveLength(0);
  });

  test("whitespace-only string also short-circuits", async () => {
    const rec: Recorded = { calls: [] };
    const result = await classifyIntent("   \n\t  ", replying("{}", rec));
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBe(1);
    expect(rec.calls).toHaveLength(0);
  });

  test("empty input answers locally under air-gap rather than refusing", async () => {
    const result = await classifyIntent("", { ...replying("{}"), enforceAirGap: true });
    expect(result.intent).toBe("unknown");
  });
});

describe("classifyIntent — response parsing", () => {
  test("parses a plain JSON body, returning file_search", async () => {
    const result = await classifyIntent(
      "find my notes",
      replying(
        JSON.stringify({
          intent: "file_search",
          entities: { pattern: "*.md" },
          requiresHITL: false,
          confidence: 0.9,
        }),
      ),
    );
    expect(result).toEqual({
      intent: "file_search",
      entities: { pattern: "*.md" },
      requiresHITL: false,
      confidence: 0.9,
    });
  });

  test("parses a markdown-fenced JSON body (```json...```)", async () => {
    const result = await classifyIntent(
      "find my notes",
      replying('```json\n{"intent":"file_search","entities":{},"confidence":0.7}\n```'),
    );
    expect(result.intent).toBe("file_search");
    expect(result.confidence).toBe(0.7);
  });

  test("parses a bare-fenced JSON body (```...```)", async () => {
    const result = await classifyIntent(
      "find my notes",
      replying('```\n{"intent":"file_organize","entities":{},"confidence":0.5}\n```'),
    );
    expect(result.intent).toBe("file_organize");
  });

  test("extracts a JSON object embedded in surrounding prose", async () => {
    const result = await classifyIntent(
      "find my notes",
      replying('Sure! {"intent":"file_search","entities":{},"confidence":1} Hope that helps.'),
    );
    expect(result.intent).toBe("file_search");
  });

  test("file_organize defaults requiresHITL=true when the field is absent", async () => {
    const result = await classifyIntent(
      "move a file",
      replying('{"intent":"file_organize","entities":{},"confidence":0.8}'),
    );
    expect(result.requiresHITL).toBe(true);
  });

  test("file_search defaults requiresHITL=false when the field is absent", async () => {
    const result = await classifyIntent(
      "find my notes",
      replying('{"intent":"file_search","entities":{},"confidence":0.8}'),
    );
    expect(result.requiresHITL).toBe(false);
  });

  test("unknown intent values are normalised to 'unknown'", async () => {
    const result = await classifyIntent(
      "hello",
      replying('{"intent":"launch_missiles","entities":{},"confidence":1}'),
    );
    expect(result.intent).toBe("unknown");
  });
});

describe("classifyIntent — field normalisation", () => {
  const CONFIDENCE_CASES: ReadonlyArray<readonly [string, string, number]> = [
    ["clamps below 0 to 0", "-3", 0],
    ["clamps above 1 to 1", "42", 1],
    ["coerces non-finite (NaN) to 0", "null", 0],
  ];

  for (const [name, raw, expected] of CONFIDENCE_CASES) {
    test(`confidence: ${name}`, async () => {
      const result = await classifyIntent(
        "find my notes",
        replying(`{"intent":"file_search","entities":{},"confidence":${raw}}`),
      );
      expect(result.confidence).toBe(expected);
    });
  }

  test("non-string entity values are dropped", async () => {
    const result = await classifyIntent(
      "find my notes",
      replying('{"intent":"file_search","entities":{"pattern":"*.md","depth":3},"confidence":1}'),
    );
    expect(result.entities).toEqual({ pattern: "*.md" });
  });

  const NON_OBJECT_ENTITIES: ReadonlyArray<readonly [string, string]> = [
    ["a string payload", '"nope"'],
    ["an array payload (Array.isArray guard)", '["a","b"]'],
    ["a null payload", "null"],
  ];

  for (const [name, raw] of NON_OBJECT_ENTITIES) {
    test(`entities: ${name} yields empty entities`, async () => {
      const result = await classifyIntent(
        "find my notes",
        replying(`{"intent":"file_search","entities":${raw},"confidence":1}`),
      );
      expect(result.entities).toEqual({});
    });
  }
});

describe("classifyIntent — what it asks the router for", () => {
  test("asks for the classification task, so route selection can pin a cheap model", async () => {
    const rec: Recorded = { calls: [] };
    await classifyIntent("find my notes", replying(UNKNOWN_REPLY, rec));
    expect(rec.calls[0]?.task).toBe("classification");
  });

  test("names the call engine.ask.classify in the ledger, not the generic task method", async () => {
    // `nimbus prove` has to be able to say an `ask` round-trip sent the question text for
    // CLASSIFICATION as distinct from sending it for an answer.
    const rec: Recorded = { calls: [] };
    await classifyIntent("find my notes", replying(UNKNOWN_REPLY, rec));
    expect(rec.calls[0]?.egressMethod).toBe("engine.ask.classify");
  });

  test("trims very long input to 8000 chars before sending", async () => {
    const rec: Recorded = { calls: [] };
    await classifyIntent("x".repeat(20_000), replying(UNKNOWN_REPLY, rec));
    expect(rec.calls[0]?.prompt.length).toBe(8000);
  });

  test("sends the classifier system prompt, not the raw question alone", async () => {
    const rec: Recorded = { calls: [] };
    await classifyIntent("find my notes", replying(UNKNOWN_REPLY, rec));
    expect(rec.calls[0]?.systemPrompt).toContain("file_search");
    expect(rec.calls[0]?.systemPrompt).toContain("file_organize");
  });
});

describe("classifyIntent — failure mapping", () => {
  test("a prose reply degrades to unknown rather than aborting the ask", async () => {
    // Small LOCAL models are on this path now and answer in prose regularly. Throwing would end
    // the `ask` on a routine event; "unknown" is what the prompt asks for when the model cannot
    // place the request, and the caller answers conversationally from there.
    const result = await classifyIntent("find my notes", replying("I am not sure."));
    expect(result).toEqual({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0 });
  });

  test("a JSON array reply degrades the same way — it is not an object", async () => {
    const result = await classifyIntent("find my notes", replying(ARRAY_REPLY));
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  test("auth failure maps to invalid_api_key", async () => {
    expect(await reasonOf(failing(new LlmProviderError("401", "auth", 401)))).toBe(
      "invalid_api_key",
    );
  });

  test("transport failure maps to network_error", async () => {
    expect(await reasonOf(failing(new LlmProviderError("ECONNREFUSED", "transport")))).toBe(
      "network_error",
    );
  });

  test("request failure maps to provider_error, carrying the vendor message", async () => {
    const policy = failing(new LlmProviderError("model xyz does not exist", "request", 400));
    const err = await classifyIntent("find my notes", policy).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((err as GatewayAgentUnavailableError).reason).toBe("provider_error");
    expect((err as Error).message).toContain("does not exist");
  });

  test("a GatewayAgentUnavailableError from below passes through unchanged", async () => {
    const inner = new GatewayAgentUnavailableError({ reason: "insufficient_quota" });
    expect(await reasonOf(failing(inner))).toBe("insufficient_quota");
  });
});

describe("classifyIntent — no reachable route", () => {
  const EXHAUSTED = "No LLM provider available for task: classification";

  test("an exhausted priority walk reports no_api_key when air-gap is off", async () => {
    expect(await reasonOf(failing(new Error(EXHAUSTED)))).toBe("no_api_key");
  });

  test("the SAME exhausted walk reports air_gap when air-gap is on", async () => {
    // Only the caller knows which of the two very different causes applied, which is why the
    // flag survives on the policy even though the router does the refusing.
    expect(await reasonOf(failing(new Error(EXHAUSTED), true))).toBe("air_gap");
  });

  test("no router at all reports no_api_key, and no fallback client is attempted", async () => {
    globalThis.fetch = (() => {
      throw new Error("classifyIntent must never call fetch directly");
    }) as unknown as typeof globalThis.fetch;
    try {
      expect(await reasonOf({ enforceAirGap: false, generate: undefined })).toBe("no_api_key");
    } finally {
      globalThis.fetch = BUN_NATIVE_FETCH;
    }
  });

  test("no router under air-gap reports air_gap, which names the actionable cause", async () => {
    expect(await reasonOf({ enforceAirGap: true, generate: undefined })).toBe("air_gap");
  });

  test("air-gap ON still classifies when the router hands back a LOCAL route", async () => {
    // The behaviour the hand-rolled client could never have: enforce_air_gap refuses REMOTE
    // routes, and the air_gap message tells the owner to configure a local model precisely so
    // this works. The router applies that rule; the classifier does not second-guess it.
    const result = await classifyIntent("find my notes", {
      ...replying(SEARCH_REPLY),
      enforceAirGap: true,
    });
    expect(result.intent).toBe("file_search");
  });
});
