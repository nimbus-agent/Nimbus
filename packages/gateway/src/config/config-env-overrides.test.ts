import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  test("every NIMBUS_ variable a config loader names is declared", () => {
    const files = readdirSync(here)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => join(here, f));
    files.push(join(here, "..", "multimodal", "multimodal-config.ts"));
    const found = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/["'`](NIMBUS_[A-Z0-9_]+)["'`]/g)) {
        if (m[1] !== undefined) found.add(m[1]);
      }
    }
    found.delete("NIMBUS_PROFILE");
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
