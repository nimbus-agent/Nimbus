import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  applyLlmTomlOverrides,
  Config,
  getEffectiveAgentModel,
  getEffectiveClassifierModel,
  parseConversationalAgentMaxSteps,
  parseEmbeddingsEnabled,
  parseEngineContextWindowItems,
  parseMaxAgentDepth,
  parseMaxToolCallsPerSession,
  parseSearchPriorityJson,
} from "./config.ts";

const SAVED_ENV = {
  agent: process.env["NIMBUS_AGENT_MODEL"],
  classifier: process.env["NIMBUS_CLASSIFIER_MODEL"],
};

beforeAll(() => {
  delete process.env["NIMBUS_AGENT_MODEL"];
  delete process.env["NIMBUS_CLASSIFIER_MODEL"];
});

afterAll(() => {
  if (SAVED_ENV.agent !== undefined) process.env["NIMBUS_AGENT_MODEL"] = SAVED_ENV.agent;
  if (SAVED_ENV.classifier !== undefined)
    process.env["NIMBUS_CLASSIFIER_MODEL"] = SAVED_ENV.classifier;
});

afterEach(() => {
  applyLlmTomlOverrides({});
});

describe("getEffectiveAgentModel / getEffectiveClassifierModel", () => {
  test("falls back to hardcoded defaults when no overrides applied", () => {
    expect(getEffectiveAgentModel()).toBe("claude-sonnet-4-6");
    expect(getEffectiveClassifierModel()).toBe("claude-haiku-4-5-20251001");
  });

  test("TOML overrides win over hardcoded defaults", () => {
    applyLlmTomlOverrides({
      agentModel: "claude-opus-4-8",
      classifierModel: "claude-haiku-4-5-20251001",
    });
    expect(getEffectiveAgentModel()).toBe("claude-opus-4-8");
    expect(getEffectiveClassifierModel()).toBe("claude-haiku-4-5-20251001");
  });

  test("calling applyLlmTomlOverrides({}) resets to hardcoded defaults", () => {
    applyLlmTomlOverrides({ agentModel: "claude-opus-4-8" });
    expect(getEffectiveAgentModel()).toBe("claude-opus-4-8");
    applyLlmTomlOverrides({});
    expect(getEffectiveAgentModel()).toBe("claude-sonnet-4-6");
  });

  test("empty-string TOML value is treated as unset", () => {
    applyLlmTomlOverrides({ agentModel: "", classifierModel: "" });
    expect(getEffectiveAgentModel()).toBe("claude-sonnet-4-6");
    expect(getEffectiveClassifierModel()).toBe("claude-haiku-4-5-20251001");
  });

  test("partial overrides leave other field on default", () => {
    applyLlmTomlOverrides({ agentModel: "claude-opus-4-8" });
    expect(getEffectiveAgentModel()).toBe("claude-opus-4-8");
    expect(getEffectiveClassifierModel()).toBe("claude-haiku-4-5-20251001");
  });

  test("env var wins over TOML override", () => {
    applyLlmTomlOverrides({
      agentModel: "claude-opus-4-8",
      classifierModel: "claude-haiku-4-5-20251001",
    });
    process.env["NIMBUS_AGENT_MODEL"] = "claude-sonnet-from-env";
    process.env["NIMBUS_CLASSIFIER_MODEL"] = "claude-haiku-from-env";
    try {
      expect(getEffectiveAgentModel()).toBe("claude-sonnet-from-env");
      expect(getEffectiveClassifierModel()).toBe("claude-haiku-from-env");
    } finally {
      delete process.env["NIMBUS_AGENT_MODEL"];
      delete process.env["NIMBUS_CLASSIFIER_MODEL"];
    }
  });
});

describe("env-var parsers", () => {
  const ENV_KEYS = [
    "NIMBUS_SEARCH_PRIORITY_JSON",
    "NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS",
    "NIMBUS_ASK_MAX_STEPS",
    "NIMBUS_MAX_AGENT_DEPTH",
    "NIMBUS_MAX_TOOL_CALLS_PER_SESSION",
    "NIMBUS_EMBEDDINGS",
  ] as const;
  const SAVED = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const k of ENV_KEYS) SAVED.set(k, process.env[k]);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      const v = SAVED.get(k);
      if (v !== undefined) process.env[k] = v;
    }
  });

  describe("parseSearchPriorityJson", () => {
    test("unset env returns empty map", () => {
      const m = parseSearchPriorityJson();
      expect(m.size).toBe(0);
    });

    test("whitespace-only env returns empty map", () => {
      process.env["NIMBUS_SEARCH_PRIORITY_JSON"] = "   ";
      expect(parseSearchPriorityJson().size).toBe(0);
    });

    test("invalid JSON returns empty map", () => {
      process.env["NIMBUS_SEARCH_PRIORITY_JSON"] = "{not json";
      expect(parseSearchPriorityJson().size).toBe(0);
    });

    test("non-object JSON (array) returns empty map", () => {
      process.env["NIMBUS_SEARCH_PRIORITY_JSON"] = "[1,2,3]";
      expect(parseSearchPriorityJson().size).toBe(0);
    });

    test("null JSON returns empty map", () => {
      process.env["NIMBUS_SEARCH_PRIORITY_JSON"] = "null";
      expect(parseSearchPriorityJson().size).toBe(0);
    });

    test("valid object clamps numeric values to 0..1 and drops non-numeric", () => {
      process.env["NIMBUS_SEARCH_PRIORITY_JSON"] = JSON.stringify({
        github: 0.8,
        slack: 1.5, // clamped to 1
        notion: -0.3, // clamped to 0
        confluence: "no", // dropped
        linear: Number.NaN, // dropped (not finite)
      });
      const m = parseSearchPriorityJson();
      expect(m.get("github")).toBe(0.8);
      expect(m.get("slack")).toBe(1);
      expect(m.get("notion")).toBe(0);
      expect(m.has("confluence")).toBe(false);
      expect(m.has("linear")).toBe(false);
    });
  });

  describe("parseEngineContextWindowItems", () => {
    test("unset returns default 20", () => {
      expect(parseEngineContextWindowItems()).toBe(20);
    });

    test("empty string returns default 20", () => {
      process.env["NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS"] = "";
      expect(parseEngineContextWindowItems()).toBe(20);
    });

    test("in-range value (1..200) is accepted", () => {
      process.env["NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS"] = "42";
      expect(parseEngineContextWindowItems()).toBe(42);
    });

    test("out-of-range value (<1) falls back to 20", () => {
      process.env["NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS"] = "0";
      expect(parseEngineContextWindowItems()).toBe(20);
    });

    test("out-of-range value (>200) falls back to 20", () => {
      process.env["NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS"] = "300";
      expect(parseEngineContextWindowItems()).toBe(20);
    });

    test("non-numeric value falls back to 20", () => {
      process.env["NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS"] = "abc";
      expect(parseEngineContextWindowItems()).toBe(20);
    });
  });

  describe("parseConversationalAgentMaxSteps", () => {
    test("unset returns default 20", () => {
      expect(parseConversationalAgentMaxSteps()).toBe(20);
    });

    test("empty string returns default 20", () => {
      process.env["NIMBUS_ASK_MAX_STEPS"] = "";
      expect(parseConversationalAgentMaxSteps()).toBe(20);
    });

    test("in-range (1..64) is accepted", () => {
      process.env["NIMBUS_ASK_MAX_STEPS"] = "8";
      expect(parseConversationalAgentMaxSteps()).toBe(8);
    });

    test("out-of-range (>64) falls back to 20", () => {
      process.env["NIMBUS_ASK_MAX_STEPS"] = "1000";
      expect(parseConversationalAgentMaxSteps()).toBe(20);
    });

    test("non-numeric falls back to 20", () => {
      process.env["NIMBUS_ASK_MAX_STEPS"] = "nope";
      expect(parseConversationalAgentMaxSteps()).toBe(20);
    });
  });

  describe("parseMaxAgentDepth", () => {
    test("unset returns default 3", () => {
      expect(parseMaxAgentDepth()).toBe(3);
    });

    test("empty string returns default 3", () => {
      process.env["NIMBUS_MAX_AGENT_DEPTH"] = "";
      expect(parseMaxAgentDepth()).toBe(3);
    });

    test("in-range (1..10) is accepted", () => {
      process.env["NIMBUS_MAX_AGENT_DEPTH"] = "5";
      expect(parseMaxAgentDepth()).toBe(5);
    });

    test("out-of-range (<1) falls back to 3", () => {
      process.env["NIMBUS_MAX_AGENT_DEPTH"] = "0";
      expect(parseMaxAgentDepth()).toBe(3);
    });

    test("out-of-range (>10) falls back to 3", () => {
      process.env["NIMBUS_MAX_AGENT_DEPTH"] = "99";
      expect(parseMaxAgentDepth()).toBe(3);
    });

    test("non-numeric falls back to 3", () => {
      process.env["NIMBUS_MAX_AGENT_DEPTH"] = "deep";
      expect(parseMaxAgentDepth()).toBe(3);
    });
  });

  describe("parseMaxToolCallsPerSession", () => {
    test("unset returns default 20", () => {
      expect(parseMaxToolCallsPerSession()).toBe(20);
    });

    test("empty string returns default 20", () => {
      process.env["NIMBUS_MAX_TOOL_CALLS_PER_SESSION"] = "";
      expect(parseMaxToolCallsPerSession()).toBe(20);
    });

    test("in-range (1..200) is accepted", () => {
      process.env["NIMBUS_MAX_TOOL_CALLS_PER_SESSION"] = "150";
      expect(parseMaxToolCallsPerSession()).toBe(150);
    });

    test("out-of-range (>200) falls back to 20", () => {
      process.env["NIMBUS_MAX_TOOL_CALLS_PER_SESSION"] = "500";
      expect(parseMaxToolCallsPerSession()).toBe(20);
    });

    test("non-numeric falls back to 20", () => {
      process.env["NIMBUS_MAX_TOOL_CALLS_PER_SESSION"] = "many";
      expect(parseMaxToolCallsPerSession()).toBe(20);
    });
  });

  describe("parseEmbeddingsEnabled", () => {
    test("unset enables embeddings", () => {
      expect(parseEmbeddingsEnabled()).toBe(true);
    });

    test("'0' disables embeddings", () => {
      process.env["NIMBUS_EMBEDDINGS"] = "0";
      expect(parseEmbeddingsEnabled()).toBe(false);
    });

    test("'false' disables embeddings", () => {
      process.env["NIMBUS_EMBEDDINGS"] = "false";
      expect(parseEmbeddingsEnabled()).toBe(false);
    });

    test("any other value enables embeddings", () => {
      process.env["NIMBUS_EMBEDDINGS"] = "yes";
      expect(parseEmbeddingsEnabled()).toBe(true);
    });
  });
});

describe("Config frozen snapshot — Workday fields", () => {
  // Config is built once at import time (frozen `as const`); env-var reads cannot
  // be tested by re-importing within the same process. The client id/secret are
  // never mutated by any other test, so we assert the exact "" default (env vars
  // absent in CI). workdayTenantHost/workdayTenant ARE mutated by sibling tests
  // (connector-spawns / workday-access-token via a mutableConfig cast) within the
  // shared process, so for those we assert the type only — a stricter toBe("")
  // would be order-dependent on a sibling file's afterEach reset.
  test("oauthWorkdayClientId defaults to empty string", () => {
    expect(Config.oauthWorkdayClientId).toBe("");
  });

  test("oauthWorkdayClientSecret defaults to empty string", () => {
    expect(Config.oauthWorkdayClientSecret).toBe("");
  });

  test("workdayTenantHost is a string", () => {
    expect(typeof Config.workdayTenantHost).toBe("string");
  });

  test("workdayTenant is a string", () => {
    expect(typeof Config.workdayTenant).toBe("string");
  });
});
