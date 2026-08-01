import { expect, test } from "bun:test";

import { parseNimbusDecisionsToml } from "./nimbus-toml.ts";

test("defaults enabled and useLlm to true", () => {
  const cfg = parseNimbusDecisionsToml("");
  expect(cfg.enabled).toBe(true);
  expect(cfg.useLlm).toBe(true);
});

test("defaults match the spec", () => {
  const cfg = parseNimbusDecisionsToml("");
  expect(cfg.minConfidence).toBeCloseTo(0.3, 5);
  expect(cfg.maxLlmCallsPerPass).toBe(25);
});

test("parses use_llm as a bool, independently of enabled", () => {
  const cfg = parseNimbusDecisionsToml("[decisions]\nenabled = true\nuse_llm = false\n");
  expect(cfg.enabled).toBe(true);
  expect(cfg.useLlm).toBe(false);
});

test("parses min_confidence and max_llm_calls_per_pass", () => {
  const cfg = parseNimbusDecisionsToml(
    "[decisions]\nmin_confidence = 0.7\nmax_llm_calls_per_pass = 4\n",
  );
  expect(cfg.minConfidence).toBeCloseTo(0.7, 5);
  expect(cfg.maxLlmCallsPerPass).toBe(4);
});

test("clamps min_confidence into 0..1", () => {
  expect(parseNimbusDecisionsToml("[decisions]\nmin_confidence = 5\n").minConfidence).toBe(1);
  expect(parseNimbusDecisionsToml("[decisions]\nmin_confidence = -2\n").minConfidence).toBe(0);
});

test("ignores an unknown key rather than throwing", () => {
  expect(() => parseNimbusDecisionsToml("[decisions]\nnonsense = 1\n")).not.toThrow();
});
