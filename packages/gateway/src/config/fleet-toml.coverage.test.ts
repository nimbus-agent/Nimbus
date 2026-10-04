/**
 * fleet-toml.coverage.test.ts — the arms of fleet-toml.ts the main suite leaves open: ignored
 * `[fleet]` keys and malformed values, the job-block refusals (missing name, an unnamed
 * `digest_min_delta` refusal, a malformed interval), lines outside any job block, a sweep with no
 * `path_prefix`, and `loadNimbusFleetFromPath` itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_FLEET_CONFIG,
  FleetConfigError,
  loadNimbusFleetFromPath,
  parseNimbusTomlFleet,
  parseNimbusTomlFleetJobs,
} from "./fleet-toml.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function refusal(fn: () => unknown): FleetConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FleetConfigError) return e;
    throw e;
  }
  throw new Error("expected a FleetConfigError, got none");
}

describe("[fleet]", () => {
  test("unknown keys, non-boolean toggles, negative counts and key-less lines are ignored", () => {
    // Each malformed toggle is the OPPOSITE of its default if coerced (`yes` -> true against a
    // false default, `0` -> false against a true one), so a coercion cannot hide behind it.
    const cfg = parseNimbusTomlFleet(
      [
        "[fleet]",
        "enabled = yes",
        "require_ac_power = 0",
        "min_idle_seconds = -30",
        "remote_call_budget = lots",
        "overnight_window = 23",
        "just a stray line",
      ].join("\n"),
    );
    expect(cfg).toEqual(DEFAULT_FLEET_CONFIG);
  });

  test("a malformed retention_days falls back to the default rather than throwing", () => {
    expect(parseNimbusTomlFleet("[fleet]\nretention_days = two weeks\n").retentionDays).toBe(
      DEFAULT_FLEET_CONFIG.retentionDays,
    );
  });

  test("zero is expressible for min_idle_seconds and remote_call_budget", () => {
    const cfg = parseNimbusTomlFleet("[fleet]\nmin_idle_seconds = 0\nremote_call_budget = 0\n");
    expect(cfg.minIdleSeconds).toBe(0);
    expect(cfg.remoteCallBudget).toBe(0);
  });
});

describe("[[fleet.job]] refusals", () => {
  test("a block with an agent but no name is refused by that reason", () => {
    const e = refusal(() =>
      parseNimbusTomlFleetJobs('[[fleet.job]]\nagent = "standup"\ninterval_seconds = 3600\n'),
    );
    expect(e.message).toBe("[[fleet.job]] requires name");
  });

  test("a digest_min_delta refusal written before name says the block is unnamed", () => {
    const e = refusal(() =>
      parseNimbusTomlFleetJobs('[[fleet.job]]\ndigest_min_delta = 0\nname = "nightly"\n'),
    );
    expect(e.message).toContain("[[fleet.job]] (unnamed) digest_min_delta must be >= 1 (got 0)");
    expect(e.message).not.toContain("nightly");
  });

  test("a malformed interval is treated as missing and refused", () => {
    const e = refusal(() =>
      parseNimbusTomlFleetJobs(
        '[[fleet.job]]\nname = "nightly"\nagent = "standup"\ninterval_seconds = 1h\n',
      ),
    );
    expect(e.message).toBe("[[fleet.job]] nightly requires interval_seconds > 0");
  });
});

describe("[[fleet.job]] parsing", () => {
  test("lines outside a job block, other tables and key-less lines are skipped", () => {
    const jobs = parseNimbusTomlFleetJobs(
      [
        'name = "orphan"',
        "[fleet]",
        "enabled = true",
        "[[fleet.job]]",
        'name = "nightly"',
        'agent = "standup"',
        "a line with no equals sign",
        "interval_seconds = 3600",
        "since_ms = 86400000",
        "[other.table]",
        'name = "ignored"',
      ].join("\n"),
    );
    expect(jobs).toEqual([
      {
        name: "nightly",
        agent: "standup",
        intervalSeconds: 3600,
        params: { sinceMs: 86_400_000 },
        digestMinDelta: 1,
        sweep: null,
      },
    ]);
  });

  test("a sweep with no path_prefix carries a null prefix", () => {
    const [job] = parseNimbusTomlFleetJobs(
      '[[fleet.job]]\nname = "svc"\nagent = "oncall"\ninterval_seconds = 600\n' +
        'sweep = "services"\nmax_subjects = 25\n',
    );
    expect(job?.sweep).toEqual({ kind: "services", maxSubjects: 25, pathPrefix: null });
  });
});

describe("loadNimbusFleetFromPath", () => {
  test("a missing file yields the defaults and no jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-fleet-cov-"));
    tempDirs.push(dir);
    expect(loadNimbusFleetFromPath(join(dir, "nimbus.toml"))).toEqual({
      config: DEFAULT_FLEET_CONFIG,
      jobs: [],
    });
  });

  test("an existing file is parsed for both the section and its jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-fleet-cov-"));
    tempDirs.push(dir);
    const tomlPath = join(dir, "nimbus.toml");
    writeFileSync(
      tomlPath,
      '[fleet]\nenabled = true\n\n[[fleet.job]]\nname = "nightly"\nagent = "standup"\ninterval_seconds = 3600\n',
      "utf8",
    );
    const { config, jobs } = loadNimbusFleetFromPath(tomlPath);
    expect(config.enabled).toBe(true);
    expect(jobs.map((j) => j.name)).toEqual(["nightly"]);
  });
});
