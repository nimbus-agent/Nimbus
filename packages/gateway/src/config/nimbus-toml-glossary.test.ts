import { expect, test } from "bun:test";

import { DEFAULT_NIMBUS_GLOSSARY_TOML, parseNimbusGlossaryToml } from "./nimbus-toml.ts";

test("defaults are enabled with the documented caps", () => {
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.enabled).toBe(true);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.maxNewTermsPerPass).toBe(25);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.statsRecheckPerPass).toBe(50);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.statsRecheckCooldownMs).toBe(43_200_000);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.retryBaseCooldownMs).toBe(900_000);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.minDocFreq).toBe(3);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.debounceMs).toBe(60000);
  expect(DEFAULT_NIMBUS_GLOSSARY_TOML.consolidateTimeoutMs).toBe(30000);
});

test("an absent section yields the defaults", () => {
  expect(parseNimbusGlossaryToml("")).toEqual(DEFAULT_NIMBUS_GLOSSARY_TOML);
});

test("parses every key", () => {
  const raw = [
    "[glossary]",
    "enabled = false",
    "max_new_terms_per_pass = 5",
    "stats_recheck_per_pass = 10",
    "stats_recheck_cooldown_ms = 3600000",
    "retry_base_cooldown_ms = 60000",
    "min_doc_freq = 7",
    "debounce_ms = 1000",
    "consolidate_timeout_ms = 2000",
  ].join("\n");
  const cfg = parseNimbusGlossaryToml(raw);
  expect(cfg.enabled).toBe(false);
  expect(cfg.maxNewTermsPerPass).toBe(5);
  expect(cfg.statsRecheckPerPass).toBe(10);
  expect(cfg.statsRecheckCooldownMs).toBe(3_600_000);
  expect(cfg.retryBaseCooldownMs).toBe(60_000);
  expect(cfg.minDocFreq).toBe(7);
  expect(cfg.debounceMs).toBe(1000);
  expect(cfg.consolidateTimeoutMs).toBe(2000);
});

test("non-positive numbers are rejected in favour of the default", () => {
  const cfg = parseNimbusGlossaryToml("[glossary]\nmin_doc_freq = 0\n");
  expect(cfg.minDocFreq).toBe(3);
});

test("an unknown key is ignored", () => {
  expect(() => parseNimbusGlossaryToml("[glossary]\nbogus = 1\n")).not.toThrow();
});
