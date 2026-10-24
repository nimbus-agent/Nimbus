import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNimbusFilesystemRootsFromConfigDir } from "../../../src/config/filesystem-toml.ts";
import {
  FleetConfigError,
  loadNimbusFleetFromConfigDir,
  loadNimbusFleetFromPath,
} from "../../../src/config/fleet-toml.ts";
import {
  getLayeredConfig,
  initLayeredConfig,
  resetLayeredConfigsForTests,
} from "../../../src/config/layered-config.ts";
import {
  loadNimbusMcpSinkFromConfigDir,
  loadNimbusMcpSinkFromPath,
} from "../../../src/config/mcp-sink-toml.ts";
import {
  DEFAULT_NIMBUS_AUDIT_TOML,
  DEFAULT_NIMBUS_DECISIONS_TOML,
  loadNimbusAuditFromConfigDir,
  loadNimbusChatopsFromConfigDir,
  loadNimbusConnectorsFromConfigDir,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusDoraFromConfigDir,
  loadNimbusFederationFromConfigDir,
  loadNimbusGlossaryFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusUserFromConfigDir,
  loadTomlSectionFromConfig,
} from "../../../src/config/nimbus-toml.ts";
import { loadGlossaryManualFromConfigDir } from "../../../src/config/nimbus-toml-glossary-terms.ts";
import { loadNimbusWorkdayFromConfigDir } from "../../../src/config/nimbus-toml-workday.ts";
import {
  loadNimbusNotificationsFromConfigDir,
  loadNimbusNotificationsFromPath,
} from "../../../src/config/notifications-toml.ts";
import {
  loadNimbusTelemetryFromConfigDir,
  loadNimbusTelemetryFromPath,
} from "../../../src/config/telemetry-toml.ts";
import {
  DEFAULT_OPENAPI_CONFIG,
  parseOpenapiToml,
} from "../../../src/connectors/openapi-indexer-config.ts";
import { loadMultimodalConfig } from "../../../src/multimodal/multimodal-config.ts";

let dir: string;

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-profile-inherit-"));
});

afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

const basePath = (): string => join(dir, "nimbus.toml");

function writeBase(text: string): void {
  writeFileSync(basePath(), text);
}

/** Runs `fn` with `name` set in the process env, restoring the previous value afterwards. */
function withEnv<T>(name: string, value: string, fn: () => T): T {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

/** The thrown value's constructor + message, or the returned value. */
function outcome(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (e) {
    return { threw: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e) };
  }
}

describe("profile inheritance through every config-dir loader", () => {
  test("a profile overlay inherits every base section it does not override", () => {
    const fsRoot = join(dir, "proj").replaceAll("\\", "/");
    writeBase(
      [
        "[decisions]",
        "min_confidence = 0.4",
        "max_llm_calls_per_pass = 7",
        "[glossary]",
        "max_new_terms_per_pass = 9",
        "[glossary.terms]",
        'CDR = "Our append-only audit row."',
        "[user]",
        'me_person_id = "person-base"',
        "[chatops]",
        "enabled = true",
        "[federation]",
        "consent_timeout_seconds = 45",
        "[lan]",
        "port = 9999",
        "[connectors.snowflake]",
        'credential = "team"',
        'team_entry = "warehouse"',
        "[[filesystem.roots]]",
        `path = "${fsRoot}"`,
        "[connectors.workday]",
        "time_off_history_days = 90",
        "[[connectors.workday.reports]]",
        'label = "headcount"',
        'url = "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Headcount?format=json"',
        "[metrics.dora.svc]",
        'repos = ["github:acme/svc"]',
        "[multimodal]",
        "enabled = true",
        "[openapi]",
        "max_walk_depth = 12",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "nimbus.work.toml"),
      [
        "[decisions]",
        "min_confidence = 0.8",
        "[glossary.terms]",
        'SLO = "Service level objective."',
        "",
      ].join("\n"),
    );
    initLayeredConfig(dir, { explicitProfile: "work" });

    const decisions = loadNimbusDecisionsFromConfigDir(dir);
    expect(decisions.minConfidence).toBe(0.8);
    expect(decisions.maxLlmCallsPerPass).toBe(7);
    expect(loadNimbusGlossaryFromConfigDir(dir).maxNewTermsPerPass).toBe(9);

    const manual = loadGlossaryManualFromConfigDir(dir);
    if (!manual.loaded) throw new Error("glossary manual terms did not load");
    expect(manual.terms.map((t) => t.displayTerm).sort()).toEqual(["CDR", "SLO"]);

    expect(loadNimbusUserFromConfigDir(dir).mePersonId).toBe("person-base");
    expect(loadNimbusChatopsFromConfigDir(dir).enabled).toBe(true);
    expect(loadNimbusFederationFromConfigDir(dir).consentTimeoutSeconds).toBe(45);
    expect(loadNimbusLanFromConfigDir(dir).port).toBe(9999);
    expect(loadNimbusConnectorsFromConfigDir(dir).get("snowflake")).toEqual({
      credential: "team",
      teamEntry: "warehouse",
    });
    expect(loadNimbusFilesystemRootsFromConfigDir(dir)).toHaveLength(1);
    const workday = loadNimbusWorkdayFromConfigDir(dir);
    expect(workday.timeOffHistoryDays).toBe(90);
    expect(workday.reports.map((r) => r.label)).toEqual(["headcount"]);
    expect([...loadNimbusDoraFromConfigDir(dir).keys()]).toEqual(["svc"]);
    expect(loadMultimodalConfig(dir).enabled).toBe(true);
    // `loadOpenapiConfig` in platform/assemble.ts is this exact call.
    expect(
      loadTomlSectionFromConfig(dir, "openapi", DEFAULT_OPENAPI_CONFIG, parseOpenapiToml)
        .maxWalkDepth,
    ).toBe(12);
  });

  test("no files yields defaults and glossary loaded:false", () => {
    initLayeredConfig(dir, { explicitProfile: "work" });
    expect(loadNimbusDecisionsFromConfigDir(dir)).toEqual(DEFAULT_NIMBUS_DECISIONS_TOML);
    expect(loadGlossaryManualFromConfigDir(dir)).toEqual({ loaded: false });
  });

  test("swallowed parse error is recorded", () => {
    writeBase("[audit]\ntool_call_log_retention_days = 99999\n");
    const audit = loadNimbusAuditFromConfigDir(dir);
    expect(audit).toEqual(DEFAULT_NIMBUS_AUDIT_TOML);
    expect(getLayeredConfig(dir).sectionFallback("audit")).toBeDefined();
  });
});

describe("door parity: …FromConfigDir equals …FromPath for the same text", () => {
  test("fleet: a duplicate job name drops the later copy through both doors", () => {
    writeBase(
      [
        "[fleet]",
        "enabled = true",
        "[[fleet.job]]",
        'name = "nightly"',
        'agent = "changelog"',
        "interval_seconds = 60",
        "[[fleet.job]]",
        'name = "nightly"',
        'agent = "changelog"',
        "interval_seconds = 60",
        "",
      ].join("\n"),
    );
    // A job-level error drops only that job; it no longer throws or records a section fallback.
    const viaPath = loadNimbusFleetFromPath(basePath());
    expect(viaPath.jobs.map((j) => j.name)).toEqual(["nightly"]);
    expect(viaPath.dropped.map((d) => d.reason)).toEqual(["[[fleet.job]] duplicate name: nightly"]);
    expect(outcome(() => loadNimbusFleetFromConfigDir(dir))).toEqual(
      outcome(() => loadNimbusFleetFromPath(basePath())),
    );
    expect(getLayeredConfig(dir).sectionFallback("fleet")).toBeUndefined();
  });

  test("fleet: a bad [fleet] table still throws FleetConfigError through both doors", () => {
    writeBase("[fleet]\nallow_remote = true\n");
    expect(() => loadNimbusFleetFromPath(basePath())).toThrow(FleetConfigError);
    expect(() => loadNimbusFleetFromConfigDir(dir)).toThrow(FleetConfigError);
    expect(outcome(() => loadNimbusFleetFromConfigDir(dir))).toEqual(
      outcome(() => loadNimbusFleetFromPath(basePath())),
    );
    expect(getLayeredConfig(dir).sectionFallback("fleet")).toBeDefined();
  });

  test("notifications: a bogus content value throws through both doors", () => {
    writeBase('[notifications]\ncontent = "bogus"\n');
    const viaPath = outcome(() => loadNimbusNotificationsFromPath(basePath()));
    expect(viaPath).toHaveProperty("threw");
    expect(outcome(() => loadNimbusNotificationsFromConfigDir(dir))).toEqual(viaPath);
  });

  test("notifications: no file plus env off disables through both doors", () => {
    const envGet = (k: string): string | undefined =>
      k === "NIMBUS_NOTIFICATIONS" ? "off" : undefined;
    const viaPath = loadNimbusNotificationsFromPath(basePath(), envGet);
    expect(viaPath.enabled).toBe(false);
    expect(loadNimbusNotificationsFromConfigDir(dir, envGet)).toEqual(viaPath);
  });

  test("mcp_sink: a bad value is ok:false through both doors", () => {
    writeBase("[mcp_sink]\nenabled = maybe\n");
    const viaPath = loadNimbusMcpSinkFromPath(basePath());
    expect(viaPath.ok).toBe(false);
    expect(loadNimbusMcpSinkFromConfigDir(dir)).toEqual(viaPath);
    expect(getLayeredConfig(dir).sectionFallback("mcp_sink")).toBeDefined();
  });

  test("telemetry: no file plus NIMBUS_TELEMETRY_ENABLED=1 is enabled through both doors", () => {
    withEnv("NIMBUS_TELEMETRY_ENABLED", "1", () => {
      const viaPath = loadNimbusTelemetryFromPath(basePath());
      expect(viaPath.enabled).toBe(true);
      expect(loadNimbusTelemetryFromConfigDir(dir)).toEqual(viaPath);
    });
  });
});
