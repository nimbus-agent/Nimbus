import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import {
  forgetLayeredConfigForTests,
  initLayeredConfig,
} from "../../../src/config/layered-config.ts";
import { FleetStore } from "../../../src/fleet/fleet-store.ts";
import type { LocalIndex } from "../../../src/index/local-index.ts";
import { openMigratedMemoryDb } from "../../../src/index/migrated-db-template.ts";
import type { LlmRegistry } from "../../../src/llm/registry.ts";
import { createPackLayerStore, type PackLayerStore } from "../../../src/packs/pack-layer-store.ts";
import { assembleFleetRuntime, type FleetRuntime } from "../../../src/platform/assemble.ts";
import { UNKNOWN_HOST_ACTIVITY } from "../../../src/platform/host-activity.ts";
import type { PlatformPaths } from "../../../src/platform/paths.ts";
import type { EnforcedPolicy, PolicyGate } from "../../../src/policy/policy-gate.ts";

// This tree is NOT loaded by `bun test packages/gateway/src` — run the CI command
// (`bun test packages/gateway packages/cli scripts`) to exercise it.

/**
 * Role-packs spec § 7: a pack that turns the fleet on and adds a job takes effect in a RUNNING
 * gateway, through the real layered reader, the real pack store and the real supervisor — no
 * restart, and nothing written to the owner's own files.
 */

const packWith = (intervalSeconds: number): string =>
  `[fleet]\nenabled = true\n\n[[fleet.job]]\nname = "pack-nightly"\nagent = "catchup"\ninterval_seconds = ${intervalSeconds}\n`;

const ENFORCED: EnforcedPolicy = {
  retentionDays: 90,
  retentionMinDays: 0,
  hitlRequired: new Set<string>(),
  quorum: new Map(),
  chatops: { channels: new Map(), ownership: new Map() },
  capabilitiesDisabled: new Set<string>(),
};

let dir: string;
let db: Database;
let packs: PackLayerStore;
let stops: Array<() => void>;
let runtime: FleetRuntime;

function boot(): FleetRuntime {
  return assembleFleetRuntime({
    db,
    paths: {
      configDir: dir,
      dataDir: dir,
      logDir: join(dir, "logs"),
      socketPath: join(dir, "gw.sock"),
      extensionsDir: join(dir, "ext"),
      tempDir: dir,
      sandboxDir: `${dir}-sandbox`,
    } satisfies PlatformPaths,
    localIndex: {} as unknown as LocalIndex,
    llmRegistry: { llmRouter: undefined } as unknown as LlmRegistry,
    hostActivity: UNKNOWN_HOST_ACTIVITY,
    policyGate: { enforced: () => ENFORCED } as unknown as PolicyGate,
    logger: pino({ level: "silent" }),
    sidecarStops: stops,
  });
}

async function setPack(text: string): Promise<void> {
  packs.setPackLayer("default", "ops", text);
  expect(await runtime.supervisor.check()).toBe("reloaded");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-fleet-live-reload-"));
  db = openMigratedMemoryDb();
  stops = [];
  packs = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, { packs });
  runtime = boot();
});

afterEach(() => {
  for (const s of stops) s();
  forgetLayeredConfigForTests(dir);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("fleet live reload through a pack layer", () => {
  test("a pack that enables the fleet and adds a job runs it without a restart", async () => {
    expect(runtime.scheduler).toBeUndefined();

    await setPack(packWith(3600));
    const scheduler = runtime.scheduler;
    expect(scheduler).toBeDefined();
    const summary = await scheduler?.runOnce({ force: true });
    expect(summary?.jobsAttempted).toBe(1);
    // The attempt, not success: the stubbed index may make the agent fail, and that is still a run.
    expect(new FleetStore(db).loadJobState("pack-nightly")?.lastAttemptAt).not.toBeNull();
    expect(new FleetStore(db).loadJobState("pack-nightly")?.lastAttemptAt).toBeDefined();
  });

  test("removing the pack stops the fleet again", async () => {
    await setPack(packWith(3600));
    expect(runtime.scheduler).toBeDefined();

    packs.removePackLayer("default", "ops");
    expect(await runtime.supervisor.check()).toBe("reloaded");
    expect(runtime.scheduler).toBeUndefined();
  });

  test("job state survives a reload", async () => {
    await setPack(packWith(3600));
    await runtime.scheduler?.runOnce({ force: true });
    const before = new FleetStore(db).loadJobState("pack-nightly")?.lastAttemptAt;
    expect(before).toBeDefined();
    expect(before).not.toBeNull();

    packs.removePackLayer("default", "ops");
    await setPack(packWith(7200));
    expect(runtime.jobs.map((j) => j.intervalSeconds)).toEqual([7200]);
    expect(new FleetStore(db).loadJobState("pack-nightly")?.lastAttemptAt).toBe(before);
  });

  test("the user's files are untouched", async () => {
    const userFile = join(dir, "nimbus.toml");
    expect(existsSync(userFile)).toBe(false);
    await setPack(packWith(3600));
    await runtime.scheduler?.runOnce({ force: true });
    packs.removePackLayer("default", "ops");
    await runtime.supervisor.check();
    expect(existsSync(userFile)).toBe(false);
  });

  test("the user's own nimbus.toml is byte-identical after a pack reload", async () => {
    // A user file that sets nothing under [fleet], so the pack's settings apply on top of it.
    const userFile = join(dir, "nimbus.toml");
    await Bun.write(userFile, "[decisions]\nmin_confidence = 0.5\n");
    expect(await runtime.supervisor.check()).toBe("unchanged");
    const hash = (): string => createHash("sha256").update(readFileSync(userFile)).digest("hex");
    const before = hash();
    await setPack(packWith(3600));
    await runtime.scheduler?.runOnce({ force: true });
    expect(hash()).toBe(before);
  });
});
