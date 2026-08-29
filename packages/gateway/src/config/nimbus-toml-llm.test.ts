import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NIMBUS_LLM_TOML,
  loadNimbusLlmFromPath,
  loadNimbusLlmPartialFromPath,
  parseNimbusTomlLlmSection,
} from "./nimbus-toml.ts";

describe("parseNimbusTomlLlmSection", () => {
  test("returns empty object for empty string", () => {
    expect(parseNimbusTomlLlmSection("")).toEqual({});
  });

  test("ignores unrelated sections", () => {
    const src = `[embedding]\nenabled = true\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({});
  });

  test("parses prefer_local bool", () => {
    const src = `[llm]\nprefer_local = false\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ preferLocal: false });
  });

  // Both keys were REMOVED on 2026-08-28. A stale one in an existing nimbus.toml must be
  // IGNORED like any unrecognised [llm] key — never parsed into a field nothing reads, and
  // never an error, which would revert the whole section and take the live keys with it.
  test("remote_model and classifier_model are ignored, not parsed", () => {
    const src = `[llm]\nremote_model = "claude-sonnet-4-6"\nclassifier_model = "haiku"\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({});
  });

  test("a stale key does not stop the rest of the section parsing", () => {
    const src = `[llm]\nremote_model = "claude-sonnet-4-6"\nprefer_local = true\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ preferLocal: true });
  });

  test("parses local_model string", () => {
    const src = `[llm]\nlocal_model = "llama3.2"\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ localModel: "llama3.2" });
  });

  test("parses llamacpp_server_path endpoint string", () => {
    const src = `[llm]\nllamacpp_server_path = "http://127.0.0.1:8080"\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({
      llamacppServerPath: "http://127.0.0.1:8080",
    });
  });

  test("parses min_reasoning_params int", () => {
    const src = `[llm]\nmin_reasoning_params = 7\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ minReasoningParams: 7 });
  });

  test("ignores min_reasoning_params = 0 (must be > 0)", () => {
    const src = `[llm]\nmin_reasoning_params = 0\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({});
  });

  test("parses enforce_air_gap bool", () => {
    const src = `[llm]\nenforce_air_gap = true\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ enforceAirGap: true });
  });

  test("parses max_agent_depth int (clamped 1-10)", () => {
    const src = `[llm]\nmax_agent_depth = 5\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ maxAgentDepth: 5 });
  });

  test("ignores max_agent_depth outside 1-10", () => {
    expect(parseNimbusTomlLlmSection(`[llm]\nmax_agent_depth = 0\n`)).toEqual({});
    expect(parseNimbusTomlLlmSection(`[llm]\nmax_agent_depth = 11\n`)).toEqual({});
  });

  test("parses max_tool_calls_per_session int (clamped 1-200)", () => {
    const src = `[llm]\nmax_tool_calls_per_session = 50\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ maxToolCallsPerSession: 50 });
  });

  test("ignores max_tool_calls_per_session = 201", () => {
    const src = `[llm]\nmax_tool_calls_per_session = 201\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({});
  });

  test("strips # comments", () => {
    const src = `[llm]\nprefer_local = true # use local\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ preferLocal: true });
  });

  test("stops reading at next section header", () => {
    const src = `[llm]\nprefer_local = true\n[embedding]\nenabled = false\n`;
    expect(parseNimbusTomlLlmSection(src)).toEqual({ preferLocal: true });
  });

  test("parses [llm.tasks] into a task -> routeId map", () => {
    const src = `[llm.tasks]\nclassification = "ollama/llama3.2:latest"\nreasoning = "ollama/qwen3:14b"\n`;
    const cfg = parseNimbusTomlLlmSection(src);
    expect(cfg.taskPins?.get("classification")).toBe("ollama/llama3.2:latest");
    expect(cfg.taskPins?.get("reasoning")).toBe("ollama/qwen3:14b");
  });

  test("an UNKNOWN task type is dropped, and the rest of the table survives", () => {
    // Same posture as route_priority: a bad entry must never revert the whole section, because
    // `loadTomlSection`'s bare catch would take `enforce_air_gap` down with it.
    const src = `[llm.tasks]\nteleportation = "ollama/x"\nreasoning = "ollama/qwen3:14b"\n`;
    const cfg = parseNimbusTomlLlmSection(src);
    expect(cfg.taskPins?.has("teleportation" as never)).toBe(false);
    expect(cfg.taskPins?.get("reasoning")).toBe("ollama/qwen3:14b");
  });

  test("absent [llm.tasks] leaves taskPins undefined, not an empty map", () => {
    expect(parseNimbusTomlLlmSection(`[llm]\nprefer_local = true\n`).taskPins).toBeUndefined();
  });

  test("a malformed [llm.tasks] entry does not revert the rest of the [llm] section", () => {
    // The hazard is specific and severe: a throw inside the [llm] parser is swallowed by
    // `loadTomlSection`'s bare catch, which reverts the WHOLE section — so a typo in a task pin
    // would silently switch `enforce_air_gap` back off while the owner believed it was on.
    // Red-proved during implementation: forcing a throw here reverted enforce_air_gap true->false.
    const src = `[llm]\nenforce_air_gap = true\nprefer_local = true\n[llm.tasks]\nteleportation = "ollama/x"\nreasoning = "ollama/qwen3:14b"\n`;
    const cfg = parseNimbusTomlLlmSection(src);
    expect(cfg.enforceAirGap).toBe(true); // the security control survives
    expect(cfg.preferLocal).toBe(true); // and so does the rest of the section
    expect(cfg.taskPins?.get("reasoning")).toBe("ollama/qwen3:14b"); // valid sibling kept
    expect(cfg.taskPins?.has("teleportation" as never)).toBe(false); // bad key dropped
  });
});

describe("DEFAULT_NIMBUS_LLM_TOML", () => {
  test("has expected default values", () => {
    expect(DEFAULT_NIMBUS_LLM_TOML.preferLocal).toBe(true);
    expect(DEFAULT_NIMBUS_LLM_TOML.enforceAirGap).toBe(false);
    expect(DEFAULT_NIMBUS_LLM_TOML.maxAgentDepth).toBe(3);
    expect(DEFAULT_NIMBUS_LLM_TOML.maxToolCallsPerSession).toBe(20);
  });
});

describe("loadNimbusLlmFromPath", () => {
  test("returns defaults when file does not exist", () => {
    const result = loadNimbusLlmFromPath("/nonexistent/path/nimbus.toml");
    expect(result).toEqual(DEFAULT_NIMBUS_LLM_TOML);
  });

  test("merges file values over defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-llm-test-"));
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(tomlPath, `[llm]\nprefer_local = false\nmax_agent_depth = 2\n`);
    const result = loadNimbusLlmFromPath(tomlPath);
    expect(result.preferLocal).toBe(false);
    expect(result.maxAgentDepth).toBe(2);
    expect(result.enforceAirGap).toBe(false);
  });
});

describe("loadNimbusLlmPartialFromPath", () => {
  test("returns empty object when file does not exist", () => {
    expect(loadNimbusLlmPartialFromPath("/nonexistent/nimbus.toml")).toEqual({});
  });

  test("returns only explicitly-set keys (no defaults)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-llm-partial-"));
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(tomlPath, `[llm]\nlocal_model = "qwen3:8b"\n`);
    expect(loadNimbusLlmPartialFromPath(tomlPath)).toEqual({ localModel: "qwen3:8b" });
  });

  test("returns empty object when [llm] section is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-llm-partial-"));
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(tomlPath, `[embedding]\nenabled = true\n`);
    expect(loadNimbusLlmPartialFromPath(tomlPath)).toEqual({});
  });
});
