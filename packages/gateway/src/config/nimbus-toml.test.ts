/**
 * nimbus-toml.test.ts — coverage-gap filler for nimbus-toml.ts (tc-B11).
 *
 * Covers:
 *  - loadTomlSection catch-arm (parse throws)
 *  - ALL embedding section helpers + parseNimbusTomlEmbeddingSection
 *  - resolveNimbusTomlForProfile (all branches)
 *  - loadNimbusEmbeddingFromPath / loadNimbusEmbeddingFromConfigDir
 *  - NIMBUS_UPDATER_URL env branch in parseNimbusUpdaterToml
 *  - NaN guard in parseNimbusLanToml NIMBUS_LAN_PORT
 *  - Every *FromConfigDir / *FromPath wrapper
 *  - loadNimbusServiceConfigsFromConfigDir duplicate-id stderr warning
 *  - security allowlist empty-fingerprint skip
 *  - identity numeric keys, scopes empty-filter
 *  - quorum edge-cases: missing keys, duplicate id already in map
 *  - preflight edge-cases: empty command string, timeout negative
 *  - federation consent_timeout > 3600 rejected
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NIMBUS_AUTOMATION_TOML,
  DEFAULT_NIMBUS_BRIEFS_TOML,
  DEFAULT_NIMBUS_EMBEDDING_TOML,
  DEFAULT_NIMBUS_LAN_TOML,
  DEFAULT_NIMBUS_LLM_TOML,
  DEFAULT_NIMBUS_PREMORTEM_TOML,
  DEFAULT_NIMBUS_UPDATER_TOML,
  loadNimbusAuditFromConfigDir,
  loadNimbusAuditFromPath,
  loadNimbusAutomationFromConfigDir,
  loadNimbusAutomationFromPath,
  loadNimbusBriefsFromPath,
  loadNimbusChatopsFromConfigDir,
  loadNimbusCodeExecutionFromConfigDir,
  loadNimbusEmbeddingFromConfigDir,
  loadNimbusEmbeddingFromPath,
  loadNimbusExtensionsFromConfigDir,
  loadNimbusExtensionsFromPath,
  loadNimbusFederationFromConfigDir,
  loadNimbusFederationFromPath,
  loadNimbusIdentityFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusLanFromPath,
  loadNimbusLlmFromConfigDir,
  loadNimbusNegotiateFromConfigDir,
  loadNimbusPreflightFromConfigDir,
  loadNimbusPremortemFromConfigDir,
  loadNimbusQuorumFromConfigDir,
  loadNimbusQuorumFromPath,
  loadNimbusScimFromConfigDir,
  loadNimbusSecurityFromConfigDir,
  loadNimbusSecurityFromPath,
  loadNimbusServiceConfigsFromConfigDir,
  loadNimbusShareHttpSink,
  loadNimbusUpdaterFromConfigDir,
  loadNimbusUpdaterFromPath,
  loadNimbusUserFromConfigDir,
  loadNimbusVoiceFromConfigDir,
  parseNimbusAuditToml,
  parseNimbusAutomationToml,
  parseNimbusCodeExecutionToml,
  parseNimbusFederationToml,
  parseNimbusIdentityToml,
  parseNimbusLanToml,
  parseNimbusNegotiateToml,
  parseNimbusPagerdutyToml,
  parseNimbusPremortemToml,
  parseNimbusScimToml,
  parseNimbusSecurityToml,
  parseNimbusShareHttpSink,
  parseNimbusTomlEmbeddingSection,
  parseNimbusTomlLlmSection,
  parseNimbusTomlVoiceSection,
  parseNimbusUpdaterToml,
  parseNimbusUserToml,
  parsePreflightConfig,
  parseQuorumConfig,
  resolveNimbusTomlForProfile,
} from "./nimbus-toml.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-toml-test-"));
}

function writeToml(dir: string, content: string, name = "nimbus.toml"): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

// ---------------------------------------------------------------------------
// loadTomlSection — catch arm (parse function throws)
// ---------------------------------------------------------------------------

describe("loadNimbusExtensionsFromPath — catch arm when parse throws", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when toml parse raises (e.g. out-of-range extension interval)", () => {
    // parseNimbusExtensionsToml throws for out-of-range values; loadTomlSection catches → defaults
    const p = writeToml(dir, "[extensions]\nupdate_check_interval_hours = 999\n");
    const result = loadNimbusExtensionsFromPath(p);
    // catch arm returns structuredClone(fallback) = DEFAULT_NIMBUS_EXTENSIONS_TOML
    expect(result.updateCheckIntervalHours).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// Embedding section — all helpers
// ---------------------------------------------------------------------------

describe("parseNimbusTomlEmbeddingSection", () => {
  test("returns empty object for empty string", () => {
    expect(parseNimbusTomlEmbeddingSection("")).toEqual({});
  });

  test("ignores unrelated sections", () => {
    expect(parseNimbusTomlEmbeddingSection("[llm]\nenabled = false\n")).toEqual({});
  });

  test("parses enabled = true", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nenabled = true\n")).toEqual({
      enabled: true,
    });
  });

  test("parses enabled = false", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nenabled = false\n")).toEqual({
      enabled: false,
    });
  });

  test("ignores malformed enabled (parseBool returns undefined)", () => {
    // 'maybe' is neither true nor false → parseBool returns undefined → field skipped
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nenabled = maybe\n")).toEqual({});
  });

  test("parses provider = local", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nprovider = local\n")).toEqual({
      provider: "local",
    });
  });

  test("parses provider = openai", () => {
    expect(parseNimbusTomlEmbeddingSection('[embedding]\nprovider = "openai"\n')).toEqual({
      provider: "openai",
    });
  });

  test("parses provider = hybrid", () => {
    expect(parseNimbusTomlEmbeddingSection('[embedding]\nprovider = "hybrid"\n')).toEqual({
      provider: "hybrid",
    });
  });

  test("ignores unrecognized provider value", () => {
    expect(parseNimbusTomlEmbeddingSection('[embedding]\nprovider = "unknown"\n')).toEqual({});
  });

  test("parses model string", () => {
    expect(parseNimbusTomlEmbeddingSection('[embedding]\nmodel = "all-MiniLM-L6-v2"\n')).toEqual({
      model: "all-MiniLM-L6-v2",
    });
  });

  test("parses chunk_tokens positive int", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nchunk_tokens = 512\n")).toEqual({
      chunkTokens: 512,
    });
  });

  test("ignores chunk_tokens = 0 (must be > 0)", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nchunk_tokens = 0\n")).toEqual({});
  });

  test("ignores chunk_tokens = -1 (must be > 0)", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nchunk_tokens = -1\n")).toEqual({});
  });

  test("parses chunk_overlap_tokens = 0 (must be >= 0)", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nchunk_overlap_tokens = 0\n")).toEqual({
      chunkOverlapTokens: 0,
    });
  });

  test("ignores chunk_overlap_tokens = -1 (must be >= 0)", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nchunk_overlap_tokens = -1\n")).toEqual({});
  });

  test("parses chunk_overlap_tokens positive int", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nchunk_overlap_tokens = 64\n")).toEqual({
      chunkOverlapTokens: 64,
    });
  });

  test("parses backfill_batch_size positive int", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nbackfill_batch_size = 100\n")).toEqual({
      backfillBatchSize: 100,
    });
  });

  test("ignores backfill_batch_size = 0 (must be > 0)", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nbackfill_batch_size = 0\n")).toEqual({});
  });

  test("parses pause_on_battery = false", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\npause_on_battery = false\n")).toEqual({
      pauseOnBattery: false,
    });
  });

  test("parses pause_on_battery = true", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\npause_on_battery = true\n")).toEqual({
      pauseOnBattery: true,
    });
  });

  test("ignores malformed pause_on_battery", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\npause_on_battery = nope\n")).toEqual({});
  });

  test("ignores unknown keys", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\nunknown_key = 123\n")).toEqual({});
  });

  test("stops reading at next section header", () => {
    const src = "[embedding]\nenabled = true\n[llm]\nenabled = false\n";
    expect(parseNimbusTomlEmbeddingSection(src)).toEqual({ enabled: true });
  });

  test("strips # inline comments", () => {
    expect(
      parseNimbusTomlEmbeddingSection("[embedding]\nenabled = true # use embedding\n"),
    ).toEqual({ enabled: true });
  });

  test("handles CRLF line endings", () => {
    expect(parseNimbusTomlEmbeddingSection("[embedding]\r\nenabled = true\r\n")).toEqual({
      enabled: true,
    });
  });

  test("parses all keys together", () => {
    const src = [
      "[embedding]",
      "enabled = true",
      'provider = "openai"',
      'model = "text-embedding-3-small"',
      "chunk_tokens = 256",
      "chunk_overlap_tokens = 32",
      "backfill_batch_size = 50",
      "pause_on_battery = false",
    ].join("\n");
    expect(parseNimbusTomlEmbeddingSection(src)).toEqual({
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
      chunkTokens: 256,
      chunkOverlapTokens: 32,
      backfillBatchSize: 50,
      pauseOnBattery: false,
    });
  });
});

// ---------------------------------------------------------------------------
// loadNimbusEmbeddingFromPath / loadNimbusEmbeddingFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusEmbeddingFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when file does not exist", () => {
    const result = loadNimbusEmbeddingFromPath(join(dir, "no-such-file.toml"));
    expect(result).toEqual(DEFAULT_NIMBUS_EMBEDDING_TOML);
  });

  test("merges file values over defaults", () => {
    const p = writeToml(dir, "[embedding]\nenabled = false\nchunk_tokens = 512\n");
    const result = loadNimbusEmbeddingFromPath(p);
    expect(result.enabled).toBe(false);
    expect(result.chunkTokens).toBe(512);
    // defaults preserved
    expect(result.provider).toBe("local");
    expect(result.model).toBe("all-MiniLM-L6-v2");
  });

  test("DEFAULT_NIMBUS_EMBEDDING_TOML has expected values", () => {
    expect(DEFAULT_NIMBUS_EMBEDDING_TOML.enabled).toBe(true);
    expect(DEFAULT_NIMBUS_EMBEDDING_TOML.provider).toBe("local");
    expect(DEFAULT_NIMBUS_EMBEDDING_TOML.chunkTokens).toBe(256);
    expect(DEFAULT_NIMBUS_EMBEDDING_TOML.chunkOverlapTokens).toBe(32);
    expect(DEFAULT_NIMBUS_EMBEDDING_TOML.backfillBatchSize).toBe(50);
    expect(DEFAULT_NIMBUS_EMBEDDING_TOML.pauseOnBattery).toBe(true);
  });
});

describe("loadNimbusEmbeddingFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[embedding]\nenabled = false\n");
    const result = loadNimbusEmbeddingFromConfigDir(dir);
    expect(result.enabled).toBe(false);
  });

  test("returns defaults when nimbus.toml missing", () => {
    const result = loadNimbusEmbeddingFromConfigDir(dir);
    expect(result).toEqual(DEFAULT_NIMBUS_EMBEDDING_TOML);
  });
});

// ---------------------------------------------------------------------------
// resolveNimbusTomlForProfile
// ---------------------------------------------------------------------------

describe("resolveNimbusTomlForProfile", () => {
  let dir: string;
  let savedProfile: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    savedProfile = process.env["NIMBUS_PROFILE"];
  });

  afterEach(() => {
    if (savedProfile === undefined) {
      delete process.env["NIMBUS_PROFILE"];
    } else {
      process.env["NIMBUS_PROFILE"] = savedProfile;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns nimbus.toml when NIMBUS_PROFILE is unset", () => {
    delete process.env["NIMBUS_PROFILE"];
    expect(resolveNimbusTomlForProfile(dir)).toBe(join(dir, "nimbus.toml"));
  });

  // Anything that isn't a non-default profile name resolves to the plain nimbus.toml — including
  // "staging", whose alt file is deliberately never created (fall-back path).
  test.each([
    ["an empty string", ""],
    ["'default'", "default"],
    ["'default' padded with whitespace", "  default  "],
    ["a profile whose alt file does not exist", "staging"],
  ])("returns nimbus.toml when NIMBUS_PROFILE is %s", (_label, profile) => {
    process.env["NIMBUS_PROFILE"] = profile;
    expect(resolveNimbusTomlForProfile(dir)).toBe(join(dir, "nimbus.toml"));
  });

  test("returns nimbus.<profile>.toml when the alt file exists", () => {
    process.env["NIMBUS_PROFILE"] = "work";
    // create the alt file
    writeToml(dir, "", "nimbus.work.toml");
    expect(resolveNimbusTomlForProfile(dir)).toBe(join(dir, "nimbus.work.toml"));
  });
});

// ---------------------------------------------------------------------------
// parseNimbusUpdaterToml — NIMBUS_UPDATER_URL env branch
// ---------------------------------------------------------------------------

describe("parseNimbusUpdaterToml — NIMBUS_UPDATER_URL env override", () => {
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env["NIMBUS_UPDATER_URL"];
  });

  afterEach(() => {
    if (savedUrl === undefined) {
      delete process.env["NIMBUS_UPDATER_URL"];
    } else {
      process.env["NIMBUS_UPDATER_URL"] = savedUrl;
    }
  });

  test("NIMBUS_UPDATER_URL overrides the url field", () => {
    process.env["NIMBUS_UPDATER_URL"] = "https://example.com/latest.json";
    const out = parseNimbusUpdaterToml("");
    expect(out.url).toBe("https://example.com/latest.json");
  });

  test("NIMBUS_UPDATER_URL absent — url from defaults", () => {
    delete process.env["NIMBUS_UPDATER_URL"];
    delete process.env["NIMBUS_UPDATER_DISABLE"];
    const out = parseNimbusUpdaterToml("");
    expect(out.url).toBe(DEFAULT_NIMBUS_UPDATER_TOML.url);
  });

  test("NIMBUS_UPDATER_URL overrides even when toml also sets url", () => {
    process.env["NIMBUS_UPDATER_URL"] = "https://override.example/v.json";
    const out = parseNimbusUpdaterToml('[updater]\nurl = "https://toml.example/v.json"\n');
    expect(out.url).toBe("https://override.example/v.json");
  });
});

// ---------------------------------------------------------------------------
// loadNimbusUpdaterFromPath / loadNimbusUpdaterFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusUpdaterFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when file does not exist", () => {
    const result = loadNimbusUpdaterFromPath(join(dir, "nope.toml"));
    expect(result.enabled).toBe(DEFAULT_NIMBUS_UPDATER_TOML.enabled);
  });

  test("reads from disk", () => {
    const p = writeToml(dir, "[updater]\nenabled = false\ncheck_on_startup = false\n");
    const result = loadNimbusUpdaterFromPath(p);
    expect(result.enabled).toBe(false);
    expect(result.checkOnStartup).toBe(false);
  });
});

describe("loadNimbusUpdaterFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[updater]\nauto_apply = true\n");
    const result = loadNimbusUpdaterFromConfigDir(dir);
    expect(result.autoApply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseNimbusLanToml — NaN guard for NIMBUS_LAN_PORT
// ---------------------------------------------------------------------------

describe("parseNimbusLanToml — NIMBUS_LAN_PORT NaN guard", () => {
  let savedPort: string | undefined;

  beforeEach(() => {
    savedPort = process.env["NIMBUS_LAN_PORT"];
  });

  afterEach(() => {
    if (savedPort === undefined) {
      delete process.env["NIMBUS_LAN_PORT"];
    } else {
      process.env["NIMBUS_LAN_PORT"] = savedPort;
    }
  });

  test("ignores NIMBUS_LAN_PORT when it is not a valid integer", () => {
    process.env["NIMBUS_LAN_PORT"] = "abc";
    const out = parseNimbusLanToml("");
    // NaN guard: port stays at default
    expect(out.port).toBe(DEFAULT_NIMBUS_LAN_TOML.port);
  });

  test("ignores NIMBUS_LAN_PORT = 'NaN'", () => {
    process.env["NIMBUS_LAN_PORT"] = "NaN";
    const out = parseNimbusLanToml("");
    expect(out.port).toBe(DEFAULT_NIMBUS_LAN_TOML.port);
  });
});

// ---------------------------------------------------------------------------
// LAN section — port = 0 rejected (must be > 0)
// ---------------------------------------------------------------------------

describe("parseNimbusLanToml — port <= 0 rejected", () => {
  test("ignores port = 0", () => {
    const out = parseNimbusLanToml("[lan]\nport = 0\n");
    expect(out.port).toBe(DEFAULT_NIMBUS_LAN_TOML.port);
  });

  test("ignores lockout_seconds = -1 (must be >= 0)", () => {
    const out = parseNimbusLanToml("[lan]\nlockout_seconds = -1\n");
    expect(out.lockoutSeconds).toBe(DEFAULT_NIMBUS_LAN_TOML.lockoutSeconds);
  });

  test("accepts lockout_seconds = 0", () => {
    const out = parseNimbusLanToml("[lan]\nlockout_seconds = 0\n");
    expect(out.lockoutSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusLanFromPath / loadNimbusLanFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusLanFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when file does not exist", () => {
    const result = loadNimbusLanFromPath(join(dir, "nope.toml"));
    expect(result).toEqual(DEFAULT_NIMBUS_LAN_TOML);
  });

  test("reads from disk", () => {
    const p = writeToml(dir, "[lan]\nenabled = true\nport = 9000\n");
    const result = loadNimbusLanFromPath(p);
    expect(result.enabled).toBe(true);
    expect(result.port).toBe(9000);
  });
});

describe("loadNimbusLanFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[lan]\nenabled = true\n");
    const result = loadNimbusLanFromConfigDir(dir);
    expect(result.enabled).toBe(true);
  });

  test("returns defaults when nimbus.toml is missing", () => {
    const result = loadNimbusLanFromConfigDir(dir);
    expect(result).toEqual(DEFAULT_NIMBUS_LAN_TOML);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusLlmFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusLlmFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[llm]\nmax_agent_depth = 7\n");
    const result = loadNimbusLlmFromConfigDir(dir);
    expect(result.maxAgentDepth).toBe(7);
  });

  test("defaults-merged load exposes an empty route map, not undefined", () => {
    writeToml(dir, `[llm]\nlocal_model = "llama3.2"\n`);
    const cfg = loadNimbusLlmFromConfigDir(dir);
    expect(cfg.localRoutes.size).toBe(0);
    expect(cfg.routePriority).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseNimbusTomlLlmSection — [llm.local.<name>] sub-tables + route_priority
// ---------------------------------------------------------------------------

describe("parseNimbusTomlLlmSection — [llm.local.<name>] and route_priority", () => {
  test("parses [llm.local.<name>] sub-tables", () => {
    const toml = `
[llm]
prefer_local = true

[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"

[llm.local.gemma]
runtime = "ollama"
model = "gemma3:12b"
`;
    const cfg = parseNimbusTomlLlmSection(toml);
    expect([...(cfg.localRoutes ?? new Map()).keys()].sort()).toEqual(["gemma", "qwen3"]);
    expect(cfg.localRoutes?.get("qwen3")?.model).toBe("qwen3:8b");
  });

  test("legacy local_model still parses and defines no sub-table route", () => {
    const cfg = parseNimbusTomlLlmSection(`[llm]\nlocal_model = "llama3.2"\n`);
    expect(cfg.localModel).toBe("llama3.2");
    // Partial<>: absent, not an empty map. assemble.ts synthesises the route (Task 9).
    expect(cfg.localRoutes).toBeUndefined();
  });

  test("route_priority with a model name containing slashes round-trips", () => {
    const cfg = parseNimbusTomlLlmSection(`[llm]\nroute_priority = ["ollama/hf.co/user/model"]\n`);
    expect(cfg.routePriority).toEqual(["ollama/hf.co/user/model"]);
  });

  test("both llamacpp sub-tables are parsed; collision is Task 9's to catch", () => {
    // The collision check moved to assemble.ts with the rest of validation. Compare
    // RESOLVED base URLs there: two routes that both OMIT base_url resolve to the
    // same default and collide, which a raw-string comparison would miss entirely.
    const toml = `
[llm.local.a]
runtime = "llamacpp"
model = "a.gguf"

[llm.local.b]
runtime = "llamacpp"
model = "b.gguf"
`;
    const cfg = parseNimbusTomlLlmSection(toml);
    expect([...(cfg.localRoutes ?? new Map()).keys()].sort()).toEqual(["a", "b"]);
    expect(cfg.localRoutes?.get("a")?.baseUrl).toBeUndefined();
  });

  // Superseded (per the task-8 brief banner): a malformed route_priority entry and a
  // base_url collision do NOT throw here. `loadTomlSection`'s bare catch (nimbus-toml.ts
  // ~line 23) swallows any throw from this parser and reverts the WHOLE [llm] section to
  // DEFAULT_NIMBUS_LLM_TOML — including enforce_air_gap, whose default is false. A typo
  // in one route_priority entry would then silently disable air-gap. Validation (resolving
  // route refs, catching base_url collisions) moves to assemble.ts (Task 9), which can log
  // the offending entry and drop only that entry.
  test("route_priority entries are collected verbatim, without validation", () => {
    const cfg = parseNimbusTomlLlmSection(`[llm]\nroute_priority = ["ollama", "ollama/qwen3"]\n`);
    expect(cfg.routePriority).toEqual(["ollama", "ollama/qwen3"]);
  });

  test("a non-array route_priority is swallowed without discarding the section", () => {
    // Same hazard as the malformed-sub-table test below, one key over: `parseStringArray`
    // THROWS on a non-bracket-delimited value. Unguarded, that throw would escape
    // `parseNimbusTomlLlmSection` into `loadTomlSection`'s bare catch and revert the
    // WHOLE [llm] section to DEFAULT_NIMBUS_LLM_TOML — including enforce_air_gap, whose
    // default is false. Assert the SECURITY-relevant key specifically survives, not
    // merely that "some key" survived.
    const cfg = parseNimbusTomlLlmSection(
      `[llm]\nenforce_air_gap = true\nroute_priority = "ollama"\n`,
    );
    expect(cfg.enforceAirGap).toBe(true); // the security-relevant key SURVIVES
    expect(cfg.routePriority).toBeUndefined();
  });

  test("a malformed sub-table is skipped without discarding the section", () => {
    // Mirrors the [ownership]/[hitl.quorum] precedent: one bad block must not
    // zero the section. Assert the SECURITY-relevant key specifically survives,
    // not merely that "some key" survived.
    const cfg = parseNimbusTomlLlmSection(
      `[llm]\nenforce_air_gap = true\n\n[llm.local.]\nmodel = "x"\n`,
    );
    expect(cfg.enforceAirGap).toBe(true); // the security-relevant key SURVIVES
    // The malformed block never yields a route, so localRoutes stays unset here
    // (Partial<>: no non-empty map to attach) — fall back to empty before checking
    // membership, same as the other tests in this block.
    expect((cfg.localRoutes ?? new Map()).has("")).toBe(false);
  });

  test("an unterminated sub-table header ends the previous route, never mutates it", () => {
    // `isTableHeader` requires BOTH brackets, so `[llm.local.bad` was not recognised as a
    // header at all and `currentId` stayed on `good` — every key under the malformed header
    // was written into `good`'s bucket. The result was not a dropped route but a SILENTLY
    // WRONG one: `good` came back carrying `bad`'s runtime and model, so the user got a
    // route they never configured under a name they did configure.
    const cfg = parseNimbusTomlLlmSection(
      `[llm]
enforce_air_gap = true

[llm.local.good]
runtime = "ollama"
model = "qwen3:8b"

[llm.local.bad
runtime = "llamacpp"
model = "evil.gguf"
`,
    );
    expect(cfg.enforceAirGap).toBe(true);
    // `good` keeps EXACTLY what its own block declared.
    expect(cfg.localRoutes?.get("good")).toEqual({ runtime: "ollama", model: "qwen3:8b" });
    // and the malformed block yields no route of its own.
    expect([...(cfg.localRoutes ?? new Map()).keys()]).toEqual(["good"]);
  });

  test("a header-like line with no id resets the block rather than extending the previous one", () => {
    const cfg = parseNimbusTomlLlmSection(
      `[llm.local.good]
runtime = "ollama"
model = "qwen3:8b"

[llm.local.]
model = "hijacked"
`,
    );
    expect(cfg.localRoutes?.get("good")).toEqual({ runtime: "ollama", model: "qwen3:8b" });
  });
});

// ---------------------------------------------------------------------------
// loadNimbusVoiceFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusVoiceFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[voice]\nenabled = true\n");
    const result = loadNimbusVoiceFromConfigDir(dir);
    expect(result.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusFederationFromPath / loadNimbusFederationFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusFederationFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when file does not exist", () => {
    const result = loadNimbusFederationFromPath(join(dir, "nope.toml"));
    expect(result.enabled).toBe(false);
  });

  test("reads from disk", () => {
    const p = writeToml(dir, "[federation]\nenabled = true\nconsent_timeout_seconds = 60\n");
    const result = loadNimbusFederationFromPath(p);
    expect(result.enabled).toBe(true);
    expect(result.consentTimeoutSeconds).toBe(60);
  });
});

describe("loadNimbusFederationFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[federation]\nenabled = true\n");
    const result = loadNimbusFederationFromConfigDir(dir);
    expect(result.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// federation consent_timeout_seconds > 3600 rejected
// ---------------------------------------------------------------------------

describe("parseNimbusFederationToml — consent_timeout > 3600 rejected", () => {
  test("ignores consent_timeout_seconds > 3600 (keeps default)", () => {
    const result = parseNimbusFederationToml("[federation]\nconsent_timeout_seconds = 9999\n");
    expect(result.consentTimeoutSeconds).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusAutomationFromPath / loadNimbusAutomationFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusAutomationFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when file does not exist", () => {
    const result = loadNimbusAutomationFromPath(join(dir, "nope.toml"));
    expect(result.graphConditions).toBe(true);
  });

  test("reads from disk", () => {
    const p = writeToml(dir, "[automation]\ngraph_conditions = false\n");
    const result = loadNimbusAutomationFromPath(p);
    expect(result.graphConditions).toBe(false);
  });
});

describe("loadNimbusAutomationFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[automation]\ngraph_conditions = false\n");
    const result = loadNimbusAutomationFromConfigDir(dir);
    expect(result.graphConditions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusExtensionsFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusExtensionsFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[extensions]\nupdate_check_interval_hours = 48\n");
    const result = loadNimbusExtensionsFromConfigDir(dir);
    expect(result.updateCheckIntervalHours).toBe(48);
  });

  test("returns defaults when nimbus.toml is missing", () => {
    const result = loadNimbusExtensionsFromConfigDir(dir);
    expect(result.updateCheckIntervalHours).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusAuditFromPath / loadNimbusAuditFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusAuditFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when file does not exist", () => {
    const result = loadNimbusAuditFromPath(join(dir, "nope.toml"));
    expect(result.toolCallLogRetentionDays).toBe(90);
  });

  test("reads from disk", () => {
    const p = writeToml(dir, "[audit]\ntool_call_log_retention_days = 30\n");
    const result = loadNimbusAuditFromPath(p);
    expect(result.toolCallLogRetentionDays).toBe(30);
  });

  test("catch arm: returns defaults when parse throws (out-of-range value)", () => {
    const p = writeToml(dir, "[audit]\ntool_call_log_retention_days = -1\n");
    const result = loadNimbusAuditFromPath(p);
    expect(result.toolCallLogRetentionDays).toBe(90);
  });
});

describe("loadNimbusAuditFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[audit]\ntool_call_log_retention_days = 60\n");
    const result = loadNimbusAuditFromConfigDir(dir);
    expect(result.toolCallLogRetentionDays).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusSecurityFromPath / loadNimbusSecurityFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusSecurityFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when file does not exist", () => {
    const result = loadNimbusSecurityFromPath(join(dir, "nope.toml"));
    expect(result.extendedPatterns).toBe(false);
    expect(result.allowlistFingerprints).toEqual([]);
  });

  test("reads from disk", () => {
    const p = writeToml(
      dir,
      '[security]\nextended_patterns = true\n\n[[security.allowlist]]\nfingerprint = "abc123"\n',
    );
    const result = loadNimbusSecurityFromPath(p);
    expect(result.extendedPatterns).toBe(true);
    expect(result.allowlistFingerprints).toEqual(["abc123"]);
  });
});

describe("loadNimbusSecurityFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[security]\nextended_patterns = true\n");
    const result = loadNimbusSecurityFromConfigDir(dir);
    expect(result.extendedPatterns).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// security allowlist — empty fingerprint skip
// ---------------------------------------------------------------------------

describe("parseNimbusSecurityToml — empty fingerprint skipped", () => {
  test("skips empty fingerprint strings", () => {
    const raw = [
      "[[security.allowlist]]",
      'fingerprint = ""',
      "[[security.allowlist]]",
      'fingerprint = "abc"',
    ].join("\n");
    const result = parseNimbusSecurityToml(raw);
    expect(result.allowlistFingerprints).toEqual(["abc"]);
  });
});

// ---------------------------------------------------------------------------
// identity — numeric keys, scopes empty filter
// ---------------------------------------------------------------------------

describe("parseNimbusIdentityToml — extended coverage", () => {
  test("parses revalidate_interval_seconds (min=1)", () => {
    const out = parseNimbusIdentityToml("[identity]\nrevalidate_interval_seconds = 7200\n");
    expect(out.revalidateIntervalSeconds).toBe(7200);
  });

  test("ignores revalidate_interval_seconds = 0 (min=1)", () => {
    const out = parseNimbusIdentityToml("[identity]\nrevalidate_interval_seconds = 0\n");
    expect(out.revalidateIntervalSeconds).toBe(3600); // default
  });

  test("parses token_refresh_skew_seconds (min=0)", () => {
    const out = parseNimbusIdentityToml("[identity]\ntoken_refresh_skew_seconds = 0\n");
    expect(out.tokenRefreshSkewSeconds).toBe(0);
  });

  test("parses session_grace_seconds = 0 (min=0)", () => {
    const out = parseNimbusIdentityToml("[identity]\nsession_grace_seconds = 0\n");
    expect(out.sessionGraceSeconds).toBe(0);
  });

  test("parses jwks_max_age_seconds (min=1)", () => {
    const out = parseNimbusIdentityToml("[identity]\njwks_max_age_seconds = 1\n");
    expect(out.jwksMaxAgeSeconds).toBe(1);
  });

  test("ignores jwks_max_age_seconds = 0 (min=1)", () => {
    const out = parseNimbusIdentityToml("[identity]\njwks_max_age_seconds = 0\n");
    expect(out.jwksMaxAgeSeconds).toBe(86400); // default
  });

  test("scopes with empty entries filtered out", () => {
    // parseStringArray filters empty from array; then arr.filter(s => s.length > 0)
    const out = parseNimbusIdentityToml('[identity]\nscopes = ["openid", "", "email"]\n');
    expect(out.scopes).toEqual(["openid", "email"]);
  });

  test("scopes empty array (all filtered) → default scopes kept", () => {
    // If arr.length === 0 after filtering, out.scopes is not set; defaults prevail
    const out = parseNimbusIdentityToml('[identity]\nscopes = ["", ""]\n');
    expect(out.scopes).toEqual(["openid", "email", "profile"]); // default
  });

  test("ignores unknown keys in [identity]", () => {
    const out = parseNimbusIdentityToml("[identity]\nunknown_key = 123\n");
    // applyNimbusIdentityNumericKey returns false → no effect
    expect(out).toMatchObject({ enabled: false });
  });
});

describe("loadNimbusIdentityFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[identity]\nenabled = true\n");
    const result = loadNimbusIdentityFromConfigDir(dir);
    expect(result.enabled).toBe(true);
  });

  test("returns defaults when nimbus.toml is missing", () => {
    const result = loadNimbusIdentityFromConfigDir(dir);
    expect(result.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// quorum — missing window_seconds, already-in-map id
// ---------------------------------------------------------------------------

describe("parseQuorumConfig — additional edge cases", () => {
  test("ignores sub-table with missing window_seconds", () => {
    const raw = ['[hitl.quorum."x.y"]', "approvers = 2"].join("\n");
    expect(parseQuorumConfig(raw).has("x.y")).toBe(false);
  });

  test("ignores sub-table with missing approvers", () => {
    const raw = ['[hitl.quorum."x.y"]', "window_seconds = 300"].join("\n");
    expect(parseQuorumConfig(raw).has("x.y")).toBe(false);
  });

  test("second sub-table with same id overwrites first (map semantics)", () => {
    const raw = [
      '[hitl.quorum."x.y"]',
      "approvers = 1",
      "window_seconds = 100",
      '[hitl.quorum."x.y"]',
      "approvers = 3",
      "window_seconds = 200",
    ].join("\n");
    const cfg = parseQuorumConfig(raw);
    // Map is built by iterating accum; second entry for same id overwrites it in accum
    const rule = cfg.get("x.y");
    expect(rule).toBeDefined();
  });

  test("empty table id is not added to map", () => {
    // beginQuorumTable: id.length === 0 → return undefined
    const raw = ['[hitl.quorum.""]', "approvers = 2", "window_seconds = 300"].join("\n");
    expect(parseQuorumConfig(raw).size).toBe(0);
  });

  test("non-numeric window_seconds is ignored", () => {
    const raw = ['[hitl.quorum."x.y"]', "approvers = 2", "window_seconds = bad"].join("\n");
    expect(parseQuorumConfig(raw).has("x.y")).toBe(false);
  });
});

describe("loadNimbusQuorumFromPath / loadNimbusQuorumFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadNimbusQuorumFromPath returns empty map when file does not exist", () => {
    const result = loadNimbusQuorumFromPath(join(dir, "nope.toml"));
    expect(result.size).toBe(0);
  });

  test("loadNimbusQuorumFromPath reads from disk", () => {
    const p = writeToml(dir, '[hitl.quorum."iac.destroy"]\napprovers = 2\nwindow_seconds = 300\n');
    const result = loadNimbusQuorumFromPath(p);
    expect(result.get("iac.destroy")).toEqual({ approvers: 2, windowSeconds: 300 });
  });

  test("loadNimbusQuorumFromConfigDir resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, '[hitl.quorum."db.drop"]\napprovers = 1\nwindow_seconds = 60\n');
    const result = loadNimbusQuorumFromConfigDir(dir);
    expect(result.get("db.drop")).toEqual({ approvers: 1, windowSeconds: 60 });
  });
});

// ---------------------------------------------------------------------------
// SCIM — loadNimbusScimFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusScimFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[scim]\nenabled = true\n");
    const result = loadNimbusScimFromConfigDir(dir);
    expect(result.enabled).toBe(true);
  });

  test("returns defaults when nimbus.toml is missing", () => {
    const result = loadNimbusScimFromConfigDir(dir);
    expect(result.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChatOps — loadNimbusChatopsFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusChatopsFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, "[chatops]\nenabled = true\nslack_enabled = true\n");
    const result = loadNimbusChatopsFromConfigDir(dir);
    expect(result.enabled).toBe(true);
    expect(result.slackEnabled).toBe(true);
  });

  test("returns defaults when nimbus.toml is missing", () => {
    const result = loadNimbusChatopsFromConfigDir(dir);
    expect(result.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Briefs — loadNimbusBriefsFromPath
// ---------------------------------------------------------------------------

describe("loadNimbusBriefsFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns defaults when the [briefs] section is absent", () => {
    const p = writeToml(dir, "[llm]\nprefer_local = true\n");
    const result = loadNimbusBriefsFromPath(p);
    expect(result).toEqual(DEFAULT_NIMBUS_BRIEFS_TOML);
  });

  test("returns defaults when nimbus.toml is missing", () => {
    const result = loadNimbusBriefsFromPath(join(dir, "nimbus.toml"));
    expect(result).toEqual(DEFAULT_NIMBUS_BRIEFS_TOML);
  });

  test("enabled = true parses", () => {
    const p = writeToml(dir, "[briefs]\nenabled = true\n");
    const result = loadNimbusBriefsFromPath(p);
    expect(result.enabled).toBe(true);
  });

  test("prefer_local = false parses", () => {
    const p = writeToml(dir, "[briefs]\nprefer_local = false\n");
    const result = loadNimbusBriefsFromPath(p);
    expect(result.preferLocal).toBe(false);
  });

  test("an unknown key is ignored", () => {
    const p = writeToml(dir, "[briefs]\nbogus_key = 1\n");
    const result = loadNimbusBriefsFromPath(p);
    expect(result).toEqual(DEFAULT_NIMBUS_BRIEFS_TOML);
  });

  test("ttl_minutes = 0 is rejected in favour of the default", () => {
    const p = writeToml(dir, "[briefs]\nttl_minutes = 0\n");
    const result = loadNimbusBriefsFromPath(p);
    expect(result.ttlMinutes).toBe(DEFAULT_NIMBUS_BRIEFS_TOML.ttlMinutes);
  });
});

// ---------------------------------------------------------------------------
// Preflight — additional edge cases
// ---------------------------------------------------------------------------

describe("parsePreflightConfig — edge cases", () => {
  test("empty-string command is ignored (treated as no-command)", () => {
    // parseString on an empty quoted string returns "" → command.length === 0 → undefined
    const cfg = parsePreflightConfig('[federation.preflight."ns"]\ncommand = ""\n');
    expect(cfg.has("ns")).toBe(false);
  });

  test("negative timeout_seconds uses default 300", () => {
    const cfg = parsePreflightConfig(
      '[federation.preflight."ns"]\ncommand = "make"\ntimeout_seconds = -5\n',
    );
    expect(cfg.get("ns")?.timeoutSeconds).toBe(300);
  });

  test("empty namespace id is not added", () => {
    // beginPreflightTable: id.length === 0 → return undefined
    const cfg = parsePreflightConfig('[federation.preflight.""]\ncommand = "make"\n');
    expect(cfg.size).toBe(0);
  });

  test("timeout_seconds capped at 1800", () => {
    const cfg = parsePreflightConfig(
      '[federation.preflight."ns"]\ncommand = "run"\ntimeout_seconds = 99999\n',
    );
    expect(cfg.get("ns")?.timeoutSeconds).toBe(1800);
  });

  test("args and cwd defaults when absent", () => {
    const cfg = parsePreflightConfig('[federation.preflight."ns"]\ncommand = "make check"\n');
    expect(cfg.get("ns")?.args).toEqual([]);
    expect(cfg.get("ns")?.cwd).toBe(".");
  });
});

describe("loadNimbusPreflightFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, '[federation.preflight."pr"]\ncommand = "bun test"\ntimeout_seconds = 120\n');
    const result = loadNimbusPreflightFromConfigDir(dir);
    expect(result.get("pr")?.command).toBe("bun test");
    expect(result.get("pr")?.timeoutSeconds).toBe(120);
  });

  test("returns empty map when nimbus.toml is missing", () => {
    const result = loadNimbusPreflightFromConfigDir(dir);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusServiceConfigsFromConfigDir — duplicate-id stderr warning
// ---------------------------------------------------------------------------

describe("loadNimbusServiceConfigsFromConfigDir — duplicate id warning", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("logs a warning and uses [ci.service] when id appears in both dora and ci", () => {
    writeToml(
      dir,
      `[metrics.dora.payments]
repos = ["github:acme/payments"]

[ci.service.payments]
repos = ["github:acme/payments-ci"]
`,
    );
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    let result: Map<string, unknown>;
    try {
      result = loadNimbusServiceConfigsFromConfigDir(dir);
    } finally {
      process.stderr.write = orig;
    }
    // Duplicate warning emitted
    expect(captured.join("")).toContain("payments");
    expect(result!.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// loadNimbusUserFromConfigDir
// ---------------------------------------------------------------------------

describe("loadNimbusUserFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, '[user]\nme_person_id = "person-xyz"\n');
    const result = loadNimbusUserFromConfigDir(dir);
    expect(result.mePersonId).toBe("person-xyz");
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: forEachSectionEntry — kv === undefined arm (line 82)
// splitKeyValue returns undefined when there is no '=' sign on a line
// ---------------------------------------------------------------------------

describe("forEachSectionEntry — line with no '=' sign inside section", () => {
  test("embedding section skips a line with no equals sign", () => {
    // A line inside [embedding] with no '=' → splitKeyValue returns undefined → skipped
    const src = "[embedding]\nthis-line-has-no-equals-sign\nenabled = true\n";
    const result = parseNimbusTomlEmbeddingSection(src);
    // The malformed line is skipped; enabled still parsed
    expect(result.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: parseBool undefined arms in various section parsers
// (hitting the else-branch of "if (b !== undefined)")
// ---------------------------------------------------------------------------

describe("parseBool undefined arm — LLM section", () => {
  test("prefer_local with malformed value is ignored", () => {
    // parseBool("notabool") → undefined → if (b !== undefined) is false
    const result = parseNimbusTomlLlmSection("[llm]\nprefer_local = notabool\n");
    expect(result.preferLocal).toBeUndefined();
  });

  test("enforce_air_gap with malformed value is ignored", () => {
    const result = parseNimbusTomlLlmSection("[llm]\nenforce_air_gap = maybe\n");
    expect(result.enforceAirGap).toBeUndefined();
  });
});

describe("parseBool undefined arm — updater section", () => {
  test("enabled = invalid keeps default", () => {
    const result = parseNimbusUpdaterToml("[updater]\nenabled = notabool\n");
    // parseBool("notabool") → undefined → field skipped; default used
    expect(result.enabled).toBe(true);
  });

  test("check_on_startup = invalid keeps default", () => {
    const result = parseNimbusUpdaterToml("[updater]\ncheck_on_startup = notabool\n");
    expect(result.checkOnStartup).toBe(true);
  });

  test("auto_apply = invalid keeps default", () => {
    const result = parseNimbusUpdaterToml("[updater]\nauto_apply = notabool\n");
    expect(result.autoApply).toBe(false);
  });
});

describe("parseBool undefined arm — LAN section", () => {
  test("enabled = invalid keeps default", () => {
    const result = parseNimbusLanToml("[lan]\nenabled = notabool\n");
    expect(result.enabled).toBe(false);
  });
});

describe("parseBool undefined arm — federation section", () => {
  test("enabled = invalid keeps default", () => {
    const result = parseNimbusFederationToml("[federation]\nenabled = notabool\n");
    expect(result.enabled).toBe(false);
  });

  test("mdns_enabled = invalid keeps default", () => {
    const result = parseNimbusFederationToml("[federation]\nmdns_enabled = notabool\n");
    expect(result.mdnsEnabled).toBe(true);
  });
});

describe("parseBool undefined arm — SCIM section", () => {
  test("enabled = invalid keeps default", () => {
    const result = parseNimbusScimToml("[scim]\nenabled = notabool\n");
    expect(result.enabled).toBe(false);
  });
});

describe("parseBool undefined arm — automation section", () => {
  test("graph_conditions = invalid keeps default", () => {
    const result = parseNimbusAutomationToml("[automation]\ngraph_conditions = notabool\n");
    expect(result.graphConditions).toBe(DEFAULT_NIMBUS_AUTOMATION_TOML.graphConditions);
  });
});

describe("parseBool undefined arm — security section", () => {
  test("extended_patterns = invalid keeps default", () => {
    const result = parseNimbusSecurityToml("[security]\nextended_patterns = notabool\n");
    expect(result.extendedPatterns).toBe(false);
  });
});

describe("parseBool undefined arm — identity section", () => {
  test("enabled = invalid keeps default", () => {
    const result = parseNimbusIdentityToml("[identity]\nenabled = notabool\n");
    expect(result.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: LAN section — pairing_window_seconds and max_failed_attempts
// (n <= 0 rejected arms)
// ---------------------------------------------------------------------------

describe("parseNimbusLanToml — invalid positive-int values rejected", () => {
  test("pairing_window_seconds = 0 is rejected", () => {
    const result = parseNimbusLanToml("[lan]\npairing_window_seconds = 0\n");
    expect(result.pairingWindowSeconds).toBe(300); // default
  });

  test("max_failed_attempts = 0 is rejected", () => {
    const result = parseNimbusLanToml("[lan]\nmax_failed_attempts = 0\n");
    expect(result.maxFailedAttempts).toBe(3); // default
  });

  test("pairing_window_seconds non-numeric is rejected", () => {
    const result = parseNimbusLanToml("[lan]\npairing_window_seconds = abc\n");
    expect(result.pairingWindowSeconds).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: quorum — applyQuorumKvLine with undefined bucket
// and kv === undefined path
// ---------------------------------------------------------------------------

describe("parseQuorumConfig — kv-line edge cases", () => {
  test("line-with-no-equals inside a quorum table is skipped", () => {
    const raw = [
      '[hitl.quorum."x.y"]',
      "no-equals-here",
      "approvers = 2",
      "window_seconds = 100",
    ].join("\n");
    const cfg = parseQuorumConfig(raw);
    expect(cfg.get("x.y")).toEqual({ approvers: 2, windowSeconds: 100 });
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: preflight — applyPreflightKvLine with undefined bucket
// and kv === undefined path
// ---------------------------------------------------------------------------

describe("parsePreflightConfig — kv-line edge cases", () => {
  test("line-with-no-equals inside a preflight table is skipped", () => {
    const cfg = parsePreflightConfig(
      '[federation.preflight."ns"]\nno-equals-here\ncommand = "make"\n',
    );
    expect(cfg.get("ns")?.command).toBe("make");
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: pagerduty read-file catch branch
// The two branches inside the catch at lines 845-848 cover:
//   err instanceof Error → true: e.message used
//   err instanceof Error → false: String(err) used
// These are covered by the existing pagerduty test but the `err instanceof Error`
// false arm on the second catch (line 856) is also unreachable normally.
// ---------------------------------------------------------------------------
// Note: lines 847/856 `err instanceof Error` false-arm is genuinely unreachable
// in normal Bun operation since all thrown errors from readFileSync/parseNimbus*
// are Error instances. This is documented in uncoverableBranches.

// ---------------------------------------------------------------------------
// Branch coverage: extensions — loadNimbusExtensionsFromPath catch arm
// (covered by the test at top of file)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Branch coverage: preflight toPreflightCommandConfig — timeout_seconds key
// present but parseIntDec returns undefined
// ---------------------------------------------------------------------------

describe("parsePreflightConfig — timeout_seconds non-numeric uses default", () => {
  test("timeout_seconds = abc → fallback to 300", () => {
    const cfg = parsePreflightConfig(
      '[federation.preflight."ns"]\ncommand = "run"\ntimeout_seconds = abc\n',
    );
    // parseIntDec("abc") = undefined → timeoutParsed = undefined → default 300
    expect(cfg.get("ns")?.timeoutSeconds).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: preflight — accum.has(id) true path (duplicate namespace)
// ---------------------------------------------------------------------------

describe("parsePreflightConfig — duplicate namespace table (id already in map)", () => {
  test("second table with same namespace id overwrites the first", () => {
    const cfg = parsePreflightConfig(
      [
        '[federation.preflight."ns"]',
        'command = "first"',
        '[federation.preflight."ns"]',
        'command = "second"',
      ].join("\n"),
    );
    // The second entry replaces the first in accum
    expect(cfg.get("ns")?.command).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: quorum — accum.has(id) true path (duplicate quorum id)
// ---------------------------------------------------------------------------

describe("parseQuorumConfig — duplicate quorum id table (id already in map)", () => {
  test("second table with same action-type id overwrites the first", () => {
    const raw = [
      '[hitl.quorum."a.b"]',
      "approvers = 1",
      "window_seconds = 60",
      '[hitl.quorum."a.b"]',
      "approvers = 2",
      "window_seconds = 120",
    ].join("\n");
    const cfg = parseQuorumConfig(raw);
    const rule = cfg.get("a.b");
    expect(rule).toBeDefined();
    // Second entry values
    expect(rule?.approvers).toBe(2);
    expect(rule?.windowSeconds).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: LAN section — port non-numeric is ignored
// ---------------------------------------------------------------------------

describe("parseNimbusLanToml — port non-numeric is ignored", () => {
  test("port = abc is rejected (parseIntDec returns undefined)", () => {
    const result = parseNimbusLanToml("[lan]\nport = abc\n");
    expect(result.port).toBe(7475); // default
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: federation — consent_timeout_seconds n <= 0 rejected
// ---------------------------------------------------------------------------

describe("parseNimbusFederationToml — consent_timeout non-numeric is rejected", () => {
  test("consent_timeout_seconds = abc is rejected", () => {
    const result = parseNimbusFederationToml("[federation]\nconsent_timeout_seconds = abc\n");
    expect(result.consentTimeoutSeconds).toBe(30); // default
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: voice enabled = invalid (parseBool returns undefined)
// ---------------------------------------------------------------------------

describe("parseNimbusTomlVoiceSection — enabled with invalid value", () => {
  test("enabled = invalid is ignored", () => {
    const result = parseNimbusTomlVoiceSection("[voice]\nenabled = notabool\n");
    expect(result.enabled).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: switch default arms — various section parsers
// These are the "default: break" arms in switch statements triggered by
// unknown/unrecognized keys.
// ---------------------------------------------------------------------------

describe("switch default arms — unknown keys in sections", () => {
  test("LLM section: unknown key hits switch default", () => {
    const result = parseNimbusTomlLlmSection("[llm]\nunknown_key_for_default = 123\n");
    // default branch taken; result is empty
    expect(result).toEqual({});
  });

  test("updater section: unknown key hits switch default", () => {
    const result = parseNimbusUpdaterToml("[updater]\nunknown_key_for_default = 123\n");
    // default branch; defaults are used
    expect(result.enabled).toBe(DEFAULT_NIMBUS_UPDATER_TOML.enabled);
  });

  test("LAN section: unknown key hits switch default", () => {
    const result = parseNimbusLanToml("[lan]\nunknown_key_for_default = 123\n");
    expect(result.port).toBe(DEFAULT_NIMBUS_LAN_TOML.port);
  });

  test("federation section: unknown key hits switch default", () => {
    const result = parseNimbusFederationToml("[federation]\nunknown_key_for_default = 123\n");
    expect(result.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: if (key === "...") FALSE arms — single-key sections
// (audit, security, user, pagerduty, scim)
// ---------------------------------------------------------------------------

describe("if (key) check FALSE arms — unknown keys inside sections", () => {
  test("audit section: unknown key is ignored (key != tool_call_log_retention_days)", () => {
    const result = parseNimbusAuditToml("[audit]\nunknown_key = 99\n");
    expect(result.toolCallLogRetentionDays).toBe(90); // default
  });

  test("security section: unknown key is ignored (key != extended_patterns)", () => {
    const result = parseNimbusSecurityToml("[security]\nunknown_key = 99\n");
    expect(result.extendedPatterns).toBe(false); // default
  });

  test("security allowlist: non-fingerprint key inside [[security.allowlist]] is ignored", () => {
    const raw = [
      "[[security.allowlist]]",
      'other_key = "not a fingerprint"',
      'fingerprint = "abc123"',
    ].join("\n");
    const result = parseNimbusSecurityToml(raw);
    expect(result.allowlistFingerprints).toEqual(["abc123"]);
  });

  test("user section: unknown key is ignored (key != me_person_id)", () => {
    const result = parseNimbusUserToml("[user]\nunknown_key = 99\n");
    expect(result.mePersonId).toBeUndefined();
  });

  test("pagerduty section: unknown key falls through both if/else if", () => {
    const result = parseNimbusPagerdutyToml("[pagerduty]\nunknown_key = 99\n");
    expect(result.maxPagesPerSync).toBe(20); // default
  });

  test("scim section: unknown key is ignored (key != enabled)", () => {
    const result = parseNimbusScimToml("[scim]\nunknown_key = 99\n");
    expect(result.enabled).toBe(false); // default
  });
});

describe("[share.http_sink] (Slice 8)", () => {
  test("parses url + auth_header_name + auth_vault_key (token is the Vault key NAME only)", () => {
    const r = parseNimbusShareHttpSink(
      '[share.http_sink]\nurl = "https://hooks.example.com/share"\nauth_header_name = "authorization"\nauth_vault_key = "share.sink.token"\n',
    );
    expect(r.url).toBe("https://hooks.example.com/share");
    expect(r.authHeaderName).toBe("authorization");
    expect(r.authVaultKey).toBe("share.sink.token");
  });

  test("empty/absent section yields url='' (http sink unconfigured → fail-closed)", () => {
    expect(parseNimbusShareHttpSink("").url).toBe("");
    expect(parseNimbusShareHttpSink("[other]\nx = 1\n").url).toBe("");
    const r = parseNimbusShareHttpSink('[share.http_sink]\nurl = ""\n');
    expect(r.url).toBe("");
    expect(r.authHeaderName).toBeUndefined();
    expect(r.authVaultKey).toBeUndefined();
  });

  test("unknown key is ignored; partial auth (header only) omits the vault key", () => {
    const r = parseNimbusShareHttpSink(
      '[share.http_sink]\nurl = "https://x"\nunknown = 1\nauth_header_name = "x-token"\n',
    );
    expect(r.url).toBe("https://x");
    expect(r.authHeaderName).toBe("x-token");
    expect(r.authVaultKey).toBeUndefined();
  });

  test("loadNimbusShareHttpSink reads <configDir>/nimbus.toml; missing file → default", () => {
    const dir = makeTmpDir();
    try {
      expect(loadNimbusShareHttpSink(dir).url).toBe("");
      writeToml(dir, '[share.http_sink]\nurl = "https://y/share"\n');
      expect(loadNimbusShareHttpSink(dir).url).toBe("https://y/share");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[premortem] (Spine S1)", () => {
  test("[premortem] defaults are the documented ones", () => {
    expect(parseNimbusPremortemToml("")).toEqual({
      enabled: true,
      debounceMs: 60_000,
      useLlm: true,
      maxLlmCallsPerPass: 25,
      maxCohortSize: 10,
      maxCandidateScan: 200,
    });
  });

  test("[premortem] parses overrides and ignores unknown keys", () => {
    const parsed = parseNimbusPremortemToml(
      "[premortem]\nenabled = false\nmax_cohort_size = 4\nmax_candidate_scan = 50\nnonsense = 99\n",
    );
    expect(parsed.enabled).toBe(false);
    expect(parsed.maxCohortSize).toBe(4);
    expect(parsed.maxCandidateScan).toBe(50);
    // Untouched keys keep their defaults.
    expect(parsed.useLlm).toBe(true);
  });

  test("[premortem] rejects a non-positive bound rather than silently clamping", () => {
    // These bound real work: max_candidate_scan = 0 would silently produce an
    // empty cohort that reads as "no comparable epics" — a wrong answer, not an
    // empty one.
    expect(
      parseNimbusPremortemToml("[premortem]\nmax_candidate_scan = 0\nmax_cohort_size = -3\n")
        .maxCandidateScan,
    ).toBe(200);
    expect(
      parseNimbusPremortemToml("[premortem]\nmax_candidate_scan = 0\nmax_cohort_size = -3\n")
        .maxCohortSize,
    ).toBe(10);
  });

  test("[premortem] loads from configDir with overridden values", () => {
    const dir = makeTmpDir();
    try {
      // Missing file → all defaults
      expect(loadNimbusPremortemFromConfigDir(dir)).toEqual(DEFAULT_NIMBUS_PREMORTEM_TOML);

      // Write a real TOML section and reload
      writeToml(
        dir,
        "[premortem]\nenabled = false\nmax_cohort_size = 4\nmax_candidate_scan = 50\n",
      );
      const loaded = loadNimbusPremortemFromConfigDir(dir);
      expect(loaded.enabled).toBe(false);
      expect(loaded.maxCohortSize).toBe(4);
      expect(loaded.maxCandidateScan).toBe(50);
      // Untouched keys keep their defaults.
      expect(loaded.useLlm).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// [negotiate] — personal-docs opt-in (Task 6)
// ---------------------------------------------------------------------------

describe("parseNimbusNegotiateToml", () => {
  test("[negotiate] personal_sources parses a service list", () => {
    const parsed = parseNimbusNegotiateToml(
      '[negotiate]\npersonal_sources = ["obsidian", "notion"]\n',
    );
    expect(parsed.personalSources).toEqual(["obsidian", "notion"]);
  });

  test("[negotiate] absent yields an empty list, not undefined", () => {
    expect(parseNimbusNegotiateToml("").personalSources).toEqual([]);
  });

  test("blank and non-string entries are dropped at parse time", () => {
    const parsed = parseNimbusNegotiateToml(
      '[negotiate]\npersonal_sources = ["obsidian", "", 42]\n',
    );
    expect(parsed.personalSources).toEqual(["obsidian"]);
  });

  // `item.service` is always a lower-case connector id, and the consumer matches on it
  // exactly. `["Obsidian"]` is a natural thing to write in TOML and matched NOTHING before
  // this fold — an undercount that `nimbus negotiate` reported as configured coverage.
  test("entries are case-folded so a capitalised service name still matches", () => {
    const parsed = parseNimbusNegotiateToml(
      '[negotiate]\npersonal_sources = ["Obsidian", "NOTION"]\n',
    );
    expect(parsed.personalSources).toEqual(["obsidian", "notion"]);
  });

  test("whitespace-only entries are dropped, not folded into a blank service name", () => {
    expect(
      parseNimbusNegotiateToml('[negotiate]\npersonal_sources = ["  ", "obsidian"]\n')
        .personalSources,
    ).toEqual(["obsidian"]);
  });

  test("a malformed (non-array) value falls back to an empty list, never throws", () => {
    expect(() =>
      parseNimbusNegotiateToml("[negotiate]\npersonal_sources = not-an-array\n"),
    ).not.toThrow();
    expect(
      parseNimbusNegotiateToml("[negotiate]\npersonal_sources = not-an-array\n").personalSources,
    ).toEqual([]);
  });
});

describe("loadNimbusNegotiateFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves <configDir>/nimbus.toml", () => {
    writeToml(dir, '[negotiate]\npersonal_sources = ["obsidian"]\n');
    expect(loadNimbusNegotiateFromConfigDir(dir).personalSources).toEqual(["obsidian"]);
  });

  test("a missing file yields the default (empty list)", () => {
    expect(loadNimbusNegotiateFromConfigDir(dir).personalSources).toEqual([]);
  });
});

describe("[code_execution] config", () => {
  test("defaults are off with the documented caps", () => {
    const c = parseNimbusCodeExecutionToml("");
    expect(c.enabled).toBe(false);
    expect(c.maxWallClockMs).toBe(30_000);
    expect(c.maxOutputBytes).toBe(1_048_576);
    expect(c.allowedRuntimes).toEqual(["bun"]);
  });

  test("parses an explicit block", () => {
    const c = parseNimbusCodeExecutionToml(
      '[code_execution]\nenabled = true\nmax_wall_clock_ms = 5000\nmax_output_bytes = 2048\nallowed_runtimes = ["bun"]\n',
    );
    expect(c.enabled).toBe(true);
    expect(c.maxWallClockMs).toBe(5000);
    expect(c.maxOutputBytes).toBe(2048);
  });

  test("rejects non-positive limits rather than accepting them", () => {
    const c = parseNimbusCodeExecutionToml(
      "[code_execution]\nmax_wall_clock_ms = 0\nmax_output_bytes = -1\n",
    );
    expect(c.maxWallClockMs).toBe(30_000);
    expect(c.maxOutputBytes).toBe(1_048_576);
  });

  test("an unknown runtime name in allowed_runtimes is dropped, not carried", () => {
    const c = parseNimbusCodeExecutionToml(
      '[code_execution]\nallowed_runtimes = ["bun", "cobol"]\n',
    );
    expect(c.allowedRuntimes).toEqual(["bun"]);
  });

  test("allowed_runtimes is normalised to lowercase", () => {
    // The gate compares this array against the registry's own lowercase id. If either side stopped
    // normalising, `allowed_runtimes = ["Bun"]` would silently refuse every execution.
    const c = parseNimbusCodeExecutionToml('[code_execution]\nallowed_runtimes = ["BUN"]\n');
    expect(c.allowedRuntimes).toEqual(["bun"]);
  });

  test("a missing file yields the defaults", () => {
    const d = mkdtempSync(join(tmpdir(), "nimbus-cfg-"));
    try {
      expect(loadNimbusCodeExecutionFromConfigDir(d).enabled).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("parseNimbusTomlLlmSection — [llm.remote.<vendor>]", () => {
  test("parses a vendor table, defaulting enabled to false", () => {
    // DEFAULT-OFF is the property the whole slice rests on: an entry that merely EXISTS, with a
    // model and (elsewhere) a key present, must still not be enabled.
    const cfg = parseNimbusTomlLlmSection(`
[llm]
prefer_local = true

[llm.remote.anthropic]
model = "claude-sonnet-4-6"
`);
    expect(cfg.remoteVendors?.get("anthropic")).toEqual({
      enabled: false,
      model: "claude-sonnet-4-6",
    });
  });

  test("enabled = true is honoured, and base_url is optional", () => {
    const cfg = parseNimbusTomlLlmSection(`
[llm]

[llm.remote.openai]
enabled = true
model = "gpt-5"
base_url = "https://proxy.internal"
`);
    expect(cfg.remoteVendors?.get("openai")).toEqual({
      enabled: true,
      model: "gpt-5",
      baseUrl: "https://proxy.internal",
    });
  });

  test("several vendors coexist and do not bleed into each other", () => {
    const cfg = parseNimbusTomlLlmSection(`
[llm]

[llm.remote.anthropic]
enabled = true
model = "claude-sonnet-4-6"

[llm.remote.gemini]
model = "gemini-2.5-pro"
`);
    expect(cfg.remoteVendors?.get("anthropic")?.enabled).toBe(true);
    expect(cfg.remoteVendors?.get("gemini")?.enabled).toBe(false);
    expect(cfg.remoteVendors?.get("gemini")?.model).toBe("gemini-2.5-pro");
  });

  test("a malformed header ends the previous vendor rather than leaking into it", () => {
    // The bug the shared collector's header-reset exists to prevent, asserted on the REMOTE side
    // too: without it `anthropic` would silently acquire xai's model.
    const cfg = parseNimbusTomlLlmSection(`
[llm]

[llm.remote.anthropic]
model = "claude-sonnet-4-6"

[llm.remote.xai
model = "grok-4"
`);
    expect(cfg.remoteVendors?.get("anthropic")?.model).toBe("claude-sonnet-4-6");
    expect(cfg.remoteVendors?.has("xai")).toBe(false);
  });

  test("a vendor with no model is dropped, and enforce_air_gap SURVIVES", () => {
    // The parser NEVER throws: a structurally unusable entry is dropped here and warned about by
    // name in assemble.ts. If this threw, `loadTomlSection`'s bare catch would revert the whole
    // section and take `enforce_air_gap` back to its `false` default with it.
    const cfg = parseNimbusTomlLlmSection(`
[llm]
enforce_air_gap = true

[llm.remote.anthropic]
enabled = true
`);
    // It was the only vendor table, so dropping it leaves the key entirely unset — the
    // `Partial<>` contract, not an empty map. `?.has()` would yield `undefined` here, so assert
    // the absence directly rather than comparing it to `false`.
    expect(cfg.remoteVendors).toBeUndefined();
    expect(cfg.enforceAirGap).toBe(true);
  });

  test("no [llm.remote.*] tables leaves the key ABSENT, matching localRoutes", () => {
    // Partial<>: absent, not an empty map -- the same contract `localRoutes` follows, so
    // `assemble.ts` can tell "no tables" from "tables that all dropped". The empty Map lives on
    // DEFAULT_NIMBUS_LLM_TOML, not here.
    expect(parseNimbusTomlLlmSection(`[llm]\nprefer_local = true\n`).remoteVendors).toBeUndefined();
    expect(DEFAULT_NIMBUS_LLM_TOML.remoteVendors.size).toBe(0);
  });
});
