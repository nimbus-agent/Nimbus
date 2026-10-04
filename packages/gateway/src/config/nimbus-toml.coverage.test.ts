/**
 * nimbus-toml.coverage.test.ts — the branches of nimbus-toml.ts the per-section test files leave
 * open: the `[llm]` context-window key, the drop paths of `[llm.local.*]` / `[llm.remote.*]` /
 * `[llm.tasks]`, `[computer_use]`'s numeric keys, the `[pagerduty]` unreadable-file fallback, and
 * the malformed-value arms of `[tribal]`, `[share.http_sink]`, `[briefs]`, `[decisions]`,
 * `[ownership]`, `[premortem]`, `[negotiate]`, `[agents]` and `[persona]`.
 *
 * The contract every one of these arms implements is the file's own: a malformed or out-of-range
 * value leaves the field UNSET so the default survives — never coerced, never clamped, never a
 * throw that would revert the whole section.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LOCAL_CONTEXT_TOKENS } from "../llm/ollama-provider.ts";
import {
  DEFAULT_NIMBUS_AGENTS_TOML,
  DEFAULT_NIMBUS_BRIEFS_TOML,
  DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
  DEFAULT_NIMBUS_COMPUTER_USE_TOML,
  DEFAULT_NIMBUS_DECISIONS_TOML,
  DEFAULT_NIMBUS_GLOSSARY_TOML,
  DEFAULT_NIMBUS_NEGOTIATE_TOML,
  DEFAULT_NIMBUS_OWNERSHIP_TOML,
  DEFAULT_NIMBUS_PAGERDUTY_TOML,
  DEFAULT_NIMBUS_PERSONA_TOML,
  DEFAULT_NIMBUS_PREMORTEM_TOML,
  DEFAULT_NIMBUS_TOOL_GENERATION_TOML,
  DEFAULT_NIMBUS_TRIBAL_TOML,
  loadNimbusAgentsFromPath,
  loadNimbusComputerUseFromConfigDir,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusGlossaryFromConfigDir,
  loadNimbusLlmFromPath,
  loadNimbusOwnershipFromConfigDir,
  loadNimbusPagerdutyFromPath,
  loadNimbusToolGenerationFromConfigDir,
  loadNimbusTribalFromConfigDir,
  type PersonaIssue,
  parseNimbusAgentsToml,
  parseNimbusBriefsToml,
  parseNimbusCodeExecutionToml,
  parseNimbusComputerUseToml,
  parseNimbusDecisionsToml,
  parseNimbusNegotiateToml,
  parseNimbusOwnershipToml,
  parseNimbusPersonaToml,
  parseNimbusPremortemToml,
  parseNimbusShareHttpSink,
  parseNimbusTomlLlmSection,
  parseNimbusTribalToml,
} from "./nimbus-toml.ts";

const tempDirs: string[] = [];

/** A fresh config dir, optionally holding a `nimbus.toml` with `body`. Removed after each test. */
function configDir(body?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-toml-cov-"));
  tempDirs.push(dir);
  if (body !== undefined) writeFileSync(join(dir, "nimbus.toml"), body, "utf8");
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const captured: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr: captured.join("") };
  } finally {
    process.stderr.write = orig;
  }
}

describe("[llm] local_context_tokens", () => {
  test("is taken at the 2048 floor and above", () => {
    expect(
      parseNimbusTomlLlmSection("[llm]\nlocal_context_tokens = 2048\n").localContextTokens,
    ).toBe(2048);
    expect(
      parseNimbusTomlLlmSection("[llm]\nlocal_context_tokens = 32768\n").localContextTokens,
    ).toBe(32768);
  });

  test("below the floor, signed, suffixed or quoted is rejected rather than clamped", () => {
    for (const v of ["2047", "0", "-4096", "8k", '"16384"']) {
      const out = parseNimbusTomlLlmSection(`[llm]\nlocal_context_tokens = ${v}\n`);
      expect(Object.hasOwn(out, "localContextTokens")).toBe(false);
    }
  });

  test("a rejected value leaves the loaded config on the default window, other keys intact", () => {
    const dir = configDir('[llm]\nlocal_context_tokens = 1024\nlocal_model = "qwen3"\n');
    const cfg = loadNimbusLlmFromPath(join(dir, "nimbus.toml"));
    expect(cfg.localContextTokens).toBe(DEFAULT_LOCAL_CONTEXT_TOKENS);
    expect(cfg.localModel).toBe("qwen3");
  });
});

describe("[llm.local.*] route validation", () => {
  test("keeps a non-empty base_url and omits an empty one", () => {
    const out = parseNimbusTomlLlmSection(
      '[llm.local.a]\nruntime = "ollama"\nmodel = "m1"\nbase_url = "http://127.0.0.1:11500"\n' +
        '[llm.local.b]\nruntime = "llamacpp"\nmodel = "m2"\nbase_url = ""\n',
    );
    expect(out.localRoutes?.get("a")).toEqual({
      runtime: "ollama",
      model: "m1",
      baseUrl: "http://127.0.0.1:11500",
    });
    const b = out.localRoutes?.get("b");
    expect(b).toEqual({ runtime: "llamacpp", model: "m2" });
    expect(b !== undefined && Object.hasOwn(b, "baseUrl")).toBe(false);
  });

  test("drops a route missing runtime or model, or with either one empty", () => {
    const out = parseNimbusTomlLlmSection(
      '[llm.local.noruntime]\nmodel = "m"\n' +
        '[llm.local.nomodel]\nruntime = "ollama"\n' +
        '[llm.local.emptyruntime]\nruntime = ""\nmodel = "m"\n' +
        '[llm.local.emptymodel]\nruntime = "ollama"\nmodel = ""\n' +
        '[llm.local.ok]\nruntime = "ollama"\nmodel = "m"\n',
    );
    expect([...(out.localRoutes?.keys() ?? [])]).toEqual(["ok"]);
  });
});

describe("[llm.remote.*] vendor validation", () => {
  test("enabled is false when absent or non-boolean; base_url kept only when non-empty", () => {
    const out = parseNimbusTomlLlmSection(
      '[llm.remote.anthropic]\nmodel = "claude-x"\n' +
        '[llm.remote.openai]\nmodel = "gpt-x"\nenabled = "yes"\nbase_url = ""\n' +
        '[llm.remote.gemini]\nmodel = "gem-x"\nenabled = true\nbase_url = "https://proxy.example"\n',
    );
    expect(out.remoteVendors?.get("anthropic")).toEqual({ enabled: false, model: "claude-x" });
    expect(out.remoteVendors?.get("openai")).toEqual({ enabled: false, model: "gpt-x" });
    expect(out.remoteVendors?.get("gemini")).toEqual({
      enabled: true,
      model: "gem-x",
      baseUrl: "https://proxy.example",
    });
  });

  test("drops a vendor with no model or an empty model, even when enabled", () => {
    const out = parseNimbusTomlLlmSection(
      "[llm.remote.anthropic]\nenabled = true\n" +
        '[llm.remote.openai]\nenabled = true\nmodel = ""\n' +
        '[llm.remote.xai]\nmodel = "grok-x"\n',
    );
    expect([...(out.remoteVendors?.keys() ?? [])]).toEqual(["xai"]);
  });
});

describe("[llm.tasks]", () => {
  test("drops an empty route id and an unknown task key, keeping the rest", () => {
    const out = parseNimbusTomlLlmSection(
      '[llm.tasks]\nclassification = ""\nreasoning = "local:big"\ntranslation = "local:x"\n',
    );
    expect(out.taskPins).toEqual(new Map([["reasoning", "local:big"]]));
  });

  test("a table whose entries all drop leaves taskPins unset", () => {
    const out = parseNimbusTomlLlmSection('[llm.tasks]\nsummarisation = ""\n');
    expect(Object.hasOwn(out, "taskPins")).toBe(false);
  });
});

describe("[code_execution]", () => {
  test("ignores a non-boolean enabled and an unknown key", () => {
    const out = parseNimbusCodeExecutionToml(
      '[code_execution]\nenabled = "yes"\nsandbox = "none"\nmax_output_bytes = 4096\n',
    );
    expect(out).toEqual({ ...DEFAULT_NIMBUS_CODE_EXECUTION_TOML, maxOutputBytes: 4096 });
  });
});

describe("[computer_use]", () => {
  test("reads every numeric key and the browser profile dir", () => {
    const out = parseNimbusComputerUseToml(
      "[computer_use]\nenabled = true\n" +
        'allowed_lanes = ["Browser", "terminal", "browser", "bogus"]\n' +
        "max_actions = 7\nmax_wall_clock_ms = 9000\n" +
        'browser_profile_dir = "/profiles/cu"\n' +
        "snapshot_max_bytes = 1024\nsnapshot_retention_days = 2\nunknown_key = 5\n",
    );
    expect(out).toEqual({
      enabled: true,
      allowedLanes: ["browser", "terminal"],
      maxActions: 7,
      maxWallClockMs: 9000,
      browserProfileDir: "/profiles/cu",
      snapshotMaxBytes: 1024,
      snapshotRetentionDays: 2,
    });
  });

  test("a zero, negative or non-integer bound keeps each default", () => {
    const out = parseNimbusComputerUseToml(
      "[computer_use]\nmax_actions = 0\nmax_wall_clock_ms = -5\n" +
        "snapshot_max_bytes = 1kb\nsnapshot_retention_days = 0\n",
    );
    expect(out).toEqual(DEFAULT_NIMBUS_COMPUTER_USE_TOML);
  });

  test("enabled is true only for a bare true — anything else fails closed", () => {
    expect(parseNimbusComputerUseToml("[computer_use]\nenabled = TRUE\n").enabled).toBe(true);
    expect(parseNimbusComputerUseToml("[computer_use]\nenabled = yes\n").enabled).toBe(false);
    expect(parseNimbusComputerUseToml('[computer_use]\nenabled = "true"\n').enabled).toBe(false);
  });

  test("loadNimbusComputerUseFromConfigDir reads <configDir>/nimbus.toml, defaults when absent", () => {
    const withFile = configDir("[computer_use]\nmax_actions = 3\n");
    expect(loadNimbusComputerUseFromConfigDir(withFile).maxActions).toBe(3);
    const empty = configDir();
    expect(loadNimbusComputerUseFromConfigDir(empty)).toEqual(DEFAULT_NIMBUS_COMPUTER_USE_TOML);
  });
});

describe("loadNimbusToolGenerationFromConfigDir", () => {
  test("reads <configDir>/nimbus.toml, defaults when absent", () => {
    const withFile = configDir('[tool_generation]\nenabled = true\ndrafting = "off"\n');
    const cfg = loadNimbusToolGenerationFromConfigDir(withFile);
    expect(cfg.enabled).toBe(true);
    expect(cfg.drafting).toBe("off");
    expect(loadNimbusToolGenerationFromConfigDir(configDir())).toEqual(
      DEFAULT_NIMBUS_TOOL_GENERATION_TOML,
    );
  });
});

describe("loadNimbusPagerdutyFromPath — unreadable file", () => {
  test("a path that exists but cannot be read falls back to defaults and says why", () => {
    const dir = configDir();
    const tomlPath = join(dir, "nimbus.toml");
    // A DIRECTORY named nimbus.toml: `existsSync` is true, `readFileSync` throws (EISDIR) — the
    // read-failure arm, on every platform, without a permission trick.
    mkdirSync(tomlPath);
    const { result, stderr } = captureStderr(() => loadNimbusPagerdutyFromPath(tomlPath));
    expect(result).toEqual(DEFAULT_NIMBUS_PAGERDUTY_TOML);
    expect(result).not.toBe(DEFAULT_NIMBUS_PAGERDUTY_TOML);
    expect(stderr).toContain("could not read [pagerduty] config at");
    expect(stderr).toContain(tomlPath);
    expect(stderr).toContain("using defaults");
    // The read arm, not the validation arm.
    expect(stderr).not.toContain("rejected");
  });
});

describe("[tribal]", () => {
  test("malformed values leave every default in place and an unknown key is ignored", () => {
    const out = parseNimbusTribalToml(
      '[tribal]\nenabled = "on"\nmatch = "llm"\nmin_occurrences = 0\nwindow_days = 0\n' +
        "cooldown_days = -1\nwatch_channels = general\nmystery = 1\n",
    );
    expect(out).toEqual(DEFAULT_NIMBUS_TRIBAL_TOML);
  });

  test("cooldown_days accepts 0 where min_occurrences and window_days need at least 1", () => {
    const out = parseNimbusTribalToml(
      '[tribal]\ncooldown_days = 0\nmin_occurrences = 1\nwindow_days = 1\nmatch = "embedding+llm"\n',
    );
    expect(out.cooldownDays).toBe(0);
    expect(out.minOccurrences).toBe(1);
    expect(out.windowDays).toBe(1);
    expect(out.match).toBe("embedding+llm");
  });

  test("[tribal.notion] needs a non-empty database_id; other keys are ignored", () => {
    expect(
      parseNimbusTribalToml('[tribal.notion]\ndatabase_id = ""\nworkspace = "w"\n').notion,
    ).toBeUndefined();
    expect(
      parseNimbusTribalToml('[tribal.notion]\nworkspace = "w"\ndatabase_id = "db1"\n').notion,
    ).toEqual({ databaseId: "db1" });
  });

  test("[tribal.confluence] needs BOTH a non-empty space_key and parent_page_id", () => {
    expect(
      parseNimbusTribalToml('[tribal.confluence]\nspace_key = ""\nparent_page_id = "p1"\n')
        .confluence,
    ).toBeUndefined();
    expect(
      parseNimbusTribalToml('[tribal.confluence]\nspace_key = "ENG"\nparent_page_id = ""\n')
        .confluence,
    ).toBeUndefined();
    expect(
      parseNimbusTribalToml(
        '[tribal.confluence]\nspace_key = "ENG"\nparent_page_id = "123"\ntitle = "x"\n',
      ).confluence,
    ).toEqual({ spaceKey: "ENG", parentPageId: "123" });
  });

  test("loadNimbusTribalFromConfigDir reads <configDir>/nimbus.toml, defaults when absent", () => {
    const dir = configDir('[tribal]\nenabled = true\n[tribal.notion]\ndatabase_id = "kb"\n');
    const cfg = loadNimbusTribalFromConfigDir(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.notion).toEqual({ databaseId: "kb" });
    expect(loadNimbusTribalFromConfigDir(configDir())).toEqual(DEFAULT_NIMBUS_TRIBAL_TOML);
  });
});

describe("[share.http_sink]", () => {
  test("omits an empty auth_header_name / auth_vault_key rather than storing ''", () => {
    const out = parseNimbusShareHttpSink(
      '[share.http_sink]\nurl = "https://sink.example/in"\nauth_header_name = ""\nauth_vault_key = ""\n',
    );
    expect(out).toEqual({ url: "https://sink.example/in" });
    expect(Object.hasOwn(out, "authHeaderName")).toBe(false);
    expect(Object.hasOwn(out, "authVaultKey")).toBe(false);
  });
});

describe("[briefs]", () => {
  test("ignores non-boolean toggles, a non-positive ttl and an unknown key", () => {
    const out = parseNimbusBriefsToml(
      '[briefs]\nenabled = 1\nprefer_local = "no"\nttl_minutes = 0\nextra = true\n',
    );
    expect(out).toEqual(DEFAULT_NIMBUS_BRIEFS_TOML);
    expect(parseNimbusBriefsToml("[briefs]\nttl_minutes = -5\n").ttlMinutes).toBe(
      DEFAULT_NIMBUS_BRIEFS_TOML.ttlMinutes,
    );
  });

  test("a positive ttl_minutes is taken", () => {
    expect(parseNimbusBriefsToml("[briefs]\nttl_minutes = 45\n").ttlMinutes).toBe(45);
  });
});

describe("loadNimbusGlossaryFromConfigDir", () => {
  test("reads <configDir>/nimbus.toml, defaults when absent", () => {
    const dir = configDir("[glossary]\nmin_doc_freq = 7\nuse_llm = false\n");
    const cfg = loadNimbusGlossaryFromConfigDir(dir);
    expect(cfg.minDocFreq).toBe(7);
    expect(cfg.useLlm).toBe(false);
    expect(loadNimbusGlossaryFromConfigDir(configDir())).toEqual(DEFAULT_NIMBUS_GLOSSARY_TOML);
  });
});

describe("[decisions]", () => {
  test("reads debounce_ms and retry_cooldown_ms", () => {
    const out = parseNimbusDecisionsToml(
      "[decisions]\ndebounce_ms = 1500\nretry_cooldown_ms = 90000\n",
    );
    expect(out.debounceMs).toBe(1500);
    expect(out.retryCooldownMs).toBe(90000);
    expect(out.maxLlmCallsPerPass).toBe(DEFAULT_NIMBUS_DECISIONS_TOML.maxLlmCallsPerPass);
  });

  test("a non-positive or non-integer value, and an unknown integer key, change nothing", () => {
    const out = parseNimbusDecisionsToml(
      "[decisions]\ndebounce_ms = 0\nretry_cooldown_ms = -1\nmax_llm_calls_per_pass = abc\nbatch_size = 10\n",
    );
    expect(out).toEqual(DEFAULT_NIMBUS_DECISIONS_TOML);
  });

  test("an EMPTY min_confidence keeps the default instead of reading as 0", () => {
    // `Number("")` is 0 and finite, so without the empty-string guard this would silently lower
    // the read-path floor to 0 and show every stored decision.
    expect(parseNimbusDecisionsToml("[decisions]\nmin_confidence =\n").minConfidence).toBe(
      DEFAULT_NIMBUS_DECISIONS_TOML.minConfidence,
    );
  });

  test("loadNimbusDecisionsFromConfigDir reads <configDir>/nimbus.toml, defaults when absent", () => {
    const dir = configDir("[decisions]\nmax_llm_calls_per_pass = 4\n");
    expect(loadNimbusDecisionsFromConfigDir(dir).maxLlmCallsPerPass).toBe(4);
    expect(loadNimbusDecisionsFromConfigDir(configDir())).toEqual(DEFAULT_NIMBUS_DECISIONS_TOML);
  });
});

describe("[ownership]", () => {
  test("an unknown positive-integer key changes nothing", () => {
    // 7 equals none of the integer defaults (30000 / 365 / 10): a value that matched one would
    // hide the key being misrouted into that field.
    expect(parseNimbusOwnershipToml("[ownership]\nmax_files = 7\n")).toEqual(
      DEFAULT_NIMBUS_OWNERSHIP_TOML,
    );
  });

  test("loadNimbusOwnershipFromConfigDir reads <configDir>/nimbus.toml, defaults when absent", () => {
    const dir = configDir("[ownership]\nhalf_life_days = 90\nignore_globs = []\n");
    const cfg = loadNimbusOwnershipFromConfigDir(dir);
    expect(cfg.halfLifeDays).toBe(90);
    expect(cfg.ignoreGlobs).toEqual([]);
    expect(loadNimbusOwnershipFromConfigDir(configDir())).toEqual(DEFAULT_NIMBUS_OWNERSHIP_TOML);
  });
});

describe("[premortem]", () => {
  test("reads debounce_ms and max_llm_calls_per_pass", () => {
    const out = parseNimbusPremortemToml(
      "[premortem]\ndebounce_ms = 5000\nmax_llm_calls_per_pass = 3\n",
    );
    expect(out.debounceMs).toBe(5000);
    expect(out.maxLlmCallsPerPass).toBe(3);
    expect(out.maxCohortSize).toBe(DEFAULT_NIMBUS_PREMORTEM_TOML.maxCohortSize);
  });

  test("a value below 1, a non-integer and an unknown key keep the defaults", () => {
    const out = parseNimbusPremortemToml(
      "[premortem]\ndebounce_ms = 0\nmax_llm_calls_per_pass = many\nmax_epics = 9\n",
    );
    expect(out).toEqual(DEFAULT_NIMBUS_PREMORTEM_TOML);
  });
});

describe("[negotiate]", () => {
  test("a key other than personal_sources is ignored", () => {
    expect(parseNimbusNegotiateToml('[negotiate]\nwork_sources = ["github"]\n')).toEqual(
      DEFAULT_NIMBUS_NEGOTIATE_TOML,
    );
  });
});

describe("[agents]", () => {
  test("an unknown key is ignored and synthesis_timeout_ms must be a positive integer", () => {
    // "off" is a valid synthesis mode but NOT the default, so a key misrouted into `synthesis`
    // would show; "local" (the default) would not.
    expect(parseNimbusAgentsToml('[agents]\nmode = "off"\n')).toEqual(DEFAULT_NIMBUS_AGENTS_TOML);
    expect(parseNimbusAgentsToml("[agents]\nsynthesis_timeout_ms = 0\n").synthesisTimeoutMs).toBe(
      DEFAULT_NIMBUS_AGENTS_TOML.synthesisTimeoutMs,
    );
    expect(
      parseNimbusAgentsToml("[agents]\nsynthesis_timeout_ms = 45000\n").synthesisTimeoutMs,
    ).toBe(45000);
  });

  test("loadNimbusAgentsFromPath reads the given path, defaults when absent", () => {
    const dir = configDir('[agents]\nsynthesis = "off"\n');
    expect(loadNimbusAgentsFromPath(join(dir, "nimbus.toml")).synthesis).toBe("off");
    expect(loadNimbusAgentsFromPath(join(configDir(), "nimbus.toml"))).toEqual(
      DEFAULT_NIMBUS_AGENTS_TOML,
    );
  });
});

describe("[persona]", () => {
  test("an unknown key is ignored and NOT reported as an issue", () => {
    const issues: PersonaIssue[] = [];
    const out = parseNimbusPersonaToml(
      '[persona]\nmood = "grumpy"\n',
      DEFAULT_NIMBUS_PERSONA_TOML,
      issues,
    );
    expect(out).toEqual(DEFAULT_NIMBUS_PERSONA_TOML);
    expect(issues).toEqual([]);
  });
});
