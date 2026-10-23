// The pack layer through the REAL loaders: a store wired into the layered reader the way the
// gateway wires it at boot, over a real temp config dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainConfig } from "../../../src/config/config-explain.ts";
import { loadNimbusFleetFromConfigDir } from "../../../src/config/fleet-toml.ts";
import {
  initLayeredConfig,
  peekLayeredConfig,
  resetLayeredConfigsForTests,
} from "../../../src/config/layered-config.ts";
import {
  DEFAULT_NIMBUS_DECISIONS_TOML,
  loadNimbusDecisionsFromConfigDir,
} from "../../../src/config/nimbus-toml.ts";
import { createPackLayerStore, type PackLayerStore } from "../../../src/packs/pack-layer-store.ts";

const job = (name: string, interval = 86400) =>
  `[[fleet.job]]\nname = "${name}"\nagent = "standup"\ninterval_seconds = ${interval}\n`;
const PACK = `${job("pack-daily")}\n[decisions]\nmin_confidence = 0.4\n`;

let dir: string;
let store: PackLayerStore;

function boot(base: string): void {
  writeFileSync(join(dir, "nimbus.toml"), base);
  store = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, { packs: store });
}

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-pack-layer-it-"));
});
afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("pack layer through the real loaders", () => {
  test("a pack adds a fleet job and a decisions threshold under the user's base", () => {
    boot(`[fleet]\nenabled = true\n\n${job("mine", 3600)}`);
    store.setPackLayer("default", "pm", PACK);
    expect(
      loadNimbusFleetFromConfigDir(dir)
        .jobs.map((j) => j.name)
        .sort(),
    ).toEqual(["mine", "pack-daily"]);
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.4);
  });

  test("the user's own value wins and explain shows the shadowed pack value", () => {
    boot("[decisions]\nmin_confidence = 0.9\n");
    store.setPackLayer("default", "pm", PACK);
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.9);

    const reader = peekLayeredConfig(dir);
    if (reader === undefined) throw new Error("reader not initialised");
    const result = explainConfig(reader, "decisions.min_confidence");
    const entry = result.entries[0];
    expect(entry?.value).toBe("0.9");
    expect(entry?.source.kind === "layer" && entry.source.layer.kind).toBe("base");
    expect(entry?.shadowed.map((s) => s.value)).toEqual(["0.4"]);
    const shadow = entry?.shadowed[0]?.source;
    expect(JSON.stringify(shadow)).toContain("pm");
  });

  test("a user job with a pack job's name replaces it: still one job of that name", () => {
    boot(`[fleet]\nenabled = true\n\n${job("pack-daily", 600)}`);
    store.setPackLayer("default", "pm", PACK);
    const jobs = loadNimbusFleetFromConfigDir(dir).jobs.filter((j) => j.name === "pack-daily");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.intervalSeconds).toBe(600);
    // Replacing the job does not drop the rest of the pack.
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.4);
  });

  test("removing the pack restores the user-only values", () => {
    boot(`[fleet]\nenabled = true\n\n${job("mine", 3600)}`);
    store.setPackLayer("default", "pm", PACK);
    store.removePackLayer("default", "pm");
    expect(loadNimbusFleetFromConfigDir(dir).jobs.map((j) => j.name)).toEqual(["mine"]);
    // The base sets no [decisions], so the code default applies again.
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(
      DEFAULT_NIMBUS_DECISIONS_TOML.minConfidence,
    );
    expect(DEFAULT_NIMBUS_DECISIONS_TOML.minConfidence).not.toBe(0.4);
  });
});
