import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEmbeddingsEnabled } from "../config.ts";
import { type AgentLimits, readAgentLimitEnv, resolveAgentLimits } from "../engine/agent-limits.ts";
import { processEnvDelete, processEnvSet } from "../platform/env-access.ts";
import { CONFIG_ENV_OVERRIDES, isPolicyConstrainedPath } from "./config-env-overrides.ts";
import { parseNimbusLanToml, parseNimbusUpdaterToml } from "./nimbus-toml.ts";
import { parseNimbusTomlNotifications } from "./notifications-toml.ts";
import { loadNimbusTelemetryFromPath } from "./telemetry-toml.ts";

const here = dirname(fileURLToPath(import.meta.url));

function byVar(name: string) {
  const o = CONFIG_ENV_OVERRIDES.find((e) => e.envVar === name);
  if (o === undefined) throw new Error(`missing ${name}`);
  return o;
}

describe("CONFIG_ENV_OVERRIDES", () => {
  function namedEnvVars(files: readonly string[]): Set<string> {
    const found = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/["'`](NIMBUS_[A-Z0-9_]+)["'`]/g)) {
        if (m[1] !== undefined) found.add(m[1]);
      }
    }
    return found;
  }

  /**
   * Files outside `config/` whose env reads override a config KEY: the agent caps
   * (`[llm] max_agent_depth` / `max_tool_calls_per_session`, read by `engine/agent-limits.ts`)
   * and `NIMBUS_EMBEDDINGS` (`[embedding] enabled`, read through `config.ts`).
   */
  const OVERRIDING_FILES = [
    join(here, "..", "config.ts"),
    join(here, "..", "engine", "agent-limits.ts"),
    join(here, "..", "multimodal", "multimodal-config.ts"),
  ];

  /** Variables those files name that override no config key (OAuth app ids, unconfigurable knobs). */
  const NOT_CONFIG_KEYS = new Set([
    "NIMBUS_PROFILE",
    // Named only in `config.ts`'s comment recording its removal.
    "NIMBUS_AGENT_MODEL",
    "NIMBUS_SEARCH_PRIORITY_JSON",
    "NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS",
    "NIMBUS_ASK_MAX_STEPS",
    "NIMBUS_WORKDAY_TENANT",
    "NIMBUS_WORKDAY_TENANT_HOST",
  ]);

  test("every NIMBUS_ variable a config loader names is declared", () => {
    const files = readdirSync(here)
      .filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "config-env-overrides.ts",
      )
      .map((f) => join(here, f));
    const found = namedEnvVars([...files, ...OVERRIDING_FILES]);
    for (const v of found) {
      if (NOT_CONFIG_KEYS.has(v) || v.startsWith("NIMBUS_OAUTH_")) found.delete(v);
    }
    // Guard against a scan that silently reads nothing outside config/.
    expect(found.has("NIMBUS_MAX_AGENT_DEPTH")).toBe(true);
    expect(found.has("NIMBUS_EMBEDDINGS")).toBe(true);
    expect([...found].sort()).toEqual(CONFIG_ENV_OVERRIDES.map((e) => e.envVar).sort());
  });

  describe("effective mirrors the loaders", () => {
    afterEach(() => {
      for (const e of CONFIG_ENV_OVERRIDES) processEnvDelete(e.envVar);
    });

    function withEnv<T>(name: string, raw: string, fn: () => T): T {
      processEnvSet(name, raw);
      try {
        return fn();
      } finally {
        processEnvDelete(name);
      }
    }

    test("NIMBUS_UPDATER_URL and NIMBUS_UPDATER_DISABLE", () => {
      const base = parseNimbusUpdaterToml("");
      for (const raw of ["https://x.test/u", ""]) {
        const eff = byVar("NIMBUS_UPDATER_URL").effective(raw);
        const got = withEnv("NIMBUS_UPDATER_URL", raw, () => parseNimbusUpdaterToml("").url);
        expect(got).toBe(eff === undefined ? base.url : (JSON.parse(eff) as string));
      }
      for (const raw of ["1", "0", "true", ""]) {
        const eff = byVar("NIMBUS_UPDATER_DISABLE").effective(raw);
        const got = withEnv(
          "NIMBUS_UPDATER_DISABLE",
          raw,
          () => parseNimbusUpdaterToml("").enabled,
        );
        expect(got).toBe(eff === undefined ? base.enabled : eff === "true");
      }
      expect(byVar("NIMBUS_UPDATER_DISABLE").effective("0")).toBeUndefined();
    });

    test("NIMBUS_LAN_PORT", () => {
      const base = parseNimbusLanToml("").port;
      for (const raw of ["9999", "abc", "80x"]) {
        const eff = byVar("NIMBUS_LAN_PORT").effective(raw);
        const got = withEnv("NIMBUS_LAN_PORT", raw, () => parseNimbusLanToml("").port);
        expect(got).toBe(eff === undefined ? base : Number(eff));
      }
    });

    test("telemetry variables", () => {
      const missing = join(here, "does-not-exist.toml");
      const base = loadNimbusTelemetryFromPath(missing);
      type Pick = (t: typeof base) => unknown;
      const enabled: Pick = (t) => t.enabled;
      const endpoint: Pick = (t) => t.endpoint;
      const flush: Pick = (t) => t.flushIntervalSeconds;
      const cases: [string, string, Pick, (e: string) => unknown][] = [
        ["NIMBUS_TELEMETRY_ENABLED", "TRUE", enabled, (e) => e === "true"],
        ["NIMBUS_TELEMETRY_ENABLED", " 0 ", enabled, (e) => e === "true"],
        ["NIMBUS_TELEMETRY_ENABLED", "yes", enabled, (e) => e === "true"],
        ["NIMBUS_TELEMETRY_ENDPOINT", " https://t.test ", endpoint, (e) => JSON.parse(e)],
        ["NIMBUS_TELEMETRY_ENDPOINT", "  ", endpoint, (e) => JSON.parse(e)],
        ["NIMBUS_TELEMETRY_FLUSH_SECONDS", "10", flush, Number],
        ["NIMBUS_TELEMETRY_FLUSH_SECONDS", "999999", flush, Number],
        ["NIMBUS_TELEMETRY_FLUSH_SECONDS", "300", flush, Number],
        ["NIMBUS_TELEMETRY_FLUSH_SECONDS", "-5", flush, Number],
        ["NIMBUS_TELEMETRY_FLUSH_SECONDS", "abc", flush, Number],
      ];
      for (const [name, raw, pick, conv] of cases) {
        const eff = byVar(name).effective(raw);
        const got = withEnv(name, raw, () => pick(loadNimbusTelemetryFromPath(missing)));
        expect(got).toEqual(eff === undefined ? pick(base) : conv(eff));
      }
      expect(byVar("NIMBUS_TELEMETRY_FLUSH_SECONDS").effective("10")).toBe("60");
    });

    test("NIMBUS_MAX_AGENT_DEPTH and NIMBUS_MAX_TOOL_CALLS_PER_SESSION", () => {
      const cases: [string, keyof AgentLimits, string][] = [
        ["NIMBUS_MAX_AGENT_DEPTH", "maxAgentDepth", "7"],
        ["NIMBUS_MAX_AGENT_DEPTH", "maxAgentDepth", "11"],
        ["NIMBUS_MAX_AGENT_DEPTH", "maxAgentDepth", " "],
        ["NIMBUS_MAX_AGENT_DEPTH", "maxAgentDepth", "abc"],
        ["NIMBUS_MAX_TOOL_CALLS_PER_SESSION", "maxToolCallsPerSession", "150"],
        ["NIMBUS_MAX_TOOL_CALLS_PER_SESSION", "maxToolCallsPerSession", "0"],
        ["NIMBUS_MAX_TOOL_CALLS_PER_SESSION", "maxToolCallsPerSession", "12x"],
      ];
      const toml = { maxAgentDepth: 5, maxToolCallsPerSession: 50 };
      for (const [name, key, raw] of cases) {
        const eff = byVar(name).effective(raw);
        const env = readAgentLimitEnv((k) => (k === name ? raw : undefined));
        const got = resolveAgentLimits({ env, toml })[key];
        expect(got).toBe(eff === undefined ? toml[key] : Number(eff));
      }
      expect(byVar("NIMBUS_MAX_AGENT_DEPTH").path).toBe("llm.max_agent_depth");
      expect(byVar("NIMBUS_MAX_TOOL_CALLS_PER_SESSION").path).toBe(
        "llm.max_tool_calls_per_session",
      );
    });

    test("NIMBUS_EMBEDDINGS", () => {
      for (const raw of ["0", "false", "1", "true", "", "off"]) {
        const eff = byVar("NIMBUS_EMBEDDINGS").effective(raw);
        const envAllows = withEnv("NIMBUS_EMBEDDINGS", raw, () => parseEmbeddingsEnabled());
        expect(envAllows).toBe(eff === undefined);
      }
      expect(byVar("NIMBUS_EMBEDDINGS").effective("0")).toBe("false");
      expect(byVar("NIMBUS_EMBEDDINGS").path).toBe("embedding.enabled");
    });

    test("NIMBUS_NOTIFICATIONS", () => {
      for (const raw of ["off", "OFF", "0", "false", "on", "1", ""]) {
        const eff = byVar("NIMBUS_NOTIFICATIONS").effective(raw);
        const out = parseNimbusTomlNotifications("[notifications]\nenabled = true\n", (k) =>
          k === "NIMBUS_NOTIFICATIONS" ? raw : undefined,
        );
        expect(out.enabled).toBe(eff === undefined);
      }
      expect(byVar("NIMBUS_NOTIFICATIONS").effective("on")).toBeUndefined();
    });
  });
});

describe("isPolicyConstrainedPath", () => {
  test("flags the policy-bounded keys and prefixes", () => {
    for (const p of [
      "audit.tool_call_log_retention_days",
      "fleet.retention_days",
      "code_execution.enabled",
      "mcp_sink.enabled",
      'hitl.quorum."x".approvers',
      "connectors.github.depth",
    ]) {
      expect(isPolicyConstrainedPath(p)).toBe(true);
    }
    expect(isPolicyConstrainedPath("decisions.min_confidence")).toBe(false);
    expect(isPolicyConstrainedPath("audit.retention_days")).toBe(false);
  });
});
