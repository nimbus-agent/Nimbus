// A layer file that exists but cannot be read (simulated with a DIRECTORY at the file's path,
// which fails with EISDIR on every OS). The layered snapshot treats it as absent; each loader then
// keeps what its single-file reader did on a read error.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNimbusFilesystemRootsFromConfigDir } from "../../../src/config/filesystem-toml.ts";
import { loadNimbusFleetFromConfigDir } from "../../../src/config/fleet-toml.ts";
import {
  getLayeredConfig,
  initLayeredConfig,
  resetLayeredConfigsForTests,
} from "../../../src/config/layered-config.ts";
import {
  DEFAULT_NIMBUS_DECISIONS_TOML,
  DEFAULT_NIMBUS_PAGERDUTY_TOML,
  loadNimbusConnectorsFromConfigDir,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusDoraFromConfigDir,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusServiceConfigsFromConfigDir,
} from "../../../src/config/nimbus-toml.ts";
import { loadNimbusWorkdayFromConfigDir } from "../../../src/config/nimbus-toml-workday.ts";
import { loadMultimodalConfig } from "../../../src/multimodal/multimodal-config.ts";

let dir: string;
let profileFile: string;

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-layer-read-error-"));
  writeFileSync(
    join(dir, "nimbus.toml"),
    '[decisions]\nmin_confidence = 0.9\n[pagerduty]\nseverity_p1_aliases = ["sev1"]\n',
  );
  profileFile = join(dir, "nimbus.work.toml");
  mkdirSync(profileFile);
  initLayeredConfig(dir, { explicitProfile: "work" });
});

afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("a section loaded through loadTomlSectionFromConfig", () => {
  test("falls back to defaults and records a fallback naming the unreadable file", () => {
    expect(loadNimbusDecisionsFromConfigDir(dir)).toEqual(DEFAULT_NIMBUS_DECISIONS_TOML);
    const fallback = getLayeredConfig(dir).sectionFallback("decisions");
    expect(fallback).toContain(`could not read ${profileFile}`);
  });
});

describe("loaders whose single-file reader let a read error escape", () => {
  const throwing: readonly [string, (d: string) => unknown][] = [
    ["ci.service / metrics.dora", loadNimbusServiceConfigsFromConfigDir],
    ["metrics.dora", loadNimbusDoraFromConfigDir],
    ["fleet", loadNimbusFleetFromConfigDir],
    ["connectors.workday", loadNimbusWorkdayFromConfigDir],
    ["connectors", loadNimbusConnectorsFromConfigDir],
  ];
  for (const [name, load] of throwing) {
    test(`${name} throws, naming the file`, () => {
      expect(() => load(dir)).toThrow(`could not read ${profileFile}`);
    });
  }

  test("pagerduty warns on stderr naming the file and uses the defaults", () => {
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(loadNimbusPagerdutyFromConfigDir(dir)).toEqual(DEFAULT_NIMBUS_PAGERDUTY_TOML);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain(`could not read ${profileFile}`);
    expect(getLayeredConfig(dir).sectionFallback("pagerduty")).toContain(profileFile);
  });

  test("multimodal fails OFF rather than reading the base file alone", () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[multimodal]\nenabled = true\nremote_vlm = "gemini"\n',
    );
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.remoteVlm).toBeNull();
    expect(getLayeredConfig(dir).sectionFallback("multimodal")).toContain(profileFile);
  });

  test("filesystem roots index nothing rather than the base file's roots", () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[[filesystem.roots]]\npath = "${join(dir, "src").replaceAll("\\", "/")}"\n`,
    );
    expect(loadNimbusFilesystemRootsFromConfigDir(dir)).toEqual([]);
    expect(getLayeredConfig(dir).sectionFallback("filesystem.roots")).toContain(profileFile);
  });

  test("every loader reads normally once the layer is readable again", () => {
    rmSync(profileFile, { recursive: true });
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.9);
    expect(() => loadNimbusConnectorsFromConfigDir(dir)).not.toThrow();
    expect(loadNimbusPagerdutyFromConfigDir(dir).severityP1Aliases).toEqual(["sev1"]);
  });
});
