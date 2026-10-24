import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
 * Role-packs spec § 7: a user `enabled = false` stub silences a pack's fleet job in a RUNNING
 * gateway, through the real layered reader, the real pack store and the real supervisor, and a
 * broken user job never stops a pack job.
 */

const PACK =
  '[fleet]\nenabled = true\n\n[[fleet.job]]\nname = "pack-nightly"\nagent = "catchup"\ninterval_seconds = 3600\n';
const STUB = '[[fleet.job]]\nname = "pack-nightly"\nenabled = false\n';

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

const userFile = (): string => join(dir, "nimbus.toml");

async function setPack(text: string): Promise<void> {
  packs.setPackLayer("default", "ops", text);
  expect(await runtime.supervisor.check()).toBe("reloaded");
}

async function setUser(text: string): Promise<void> {
  await Bun.write(userFile(), text);
  expect(await runtime.supervisor.check()).toBe("reloaded");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-fleet-job-merging-"));
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

describe("fleet job merging across layers", () => {
  test("a user stub silences a pack job without a restart", async () => {
    await setPack(PACK);
    expect(runtime.scheduler).toBeDefined();
    expect(runtime.jobs.map((j) => j.name)).toEqual(["pack-nightly"]);

    await setUser(STUB);
    expect(runtime.scheduler).toBeUndefined();
    expect(runtime.disabled[0]?.name).toBe("pack-nightly");
    expect(runtime.disabled[0]?.origin.replaces[0]?.kind).toBe("pack");
  });

  test("removing the pack leaves the stub inert", async () => {
    await setPack(PACK);
    await setUser(STUB);

    packs.removePackLayer("default", "ops");
    expect(await runtime.supervisor.check()).toBe("reloaded");
    expect(runtime.disabled[0]?.origin.replaces).toEqual([]);
    expect(runtime.dropped).toEqual([]);
    expect(runtime.scheduler).toBeUndefined();
    expect(runtime.jobs).toEqual([]);
  });

  test("a broken user job does not stop a pack job", async () => {
    await setPack(PACK);
    await setUser('[[fleet.job]]\nname = "mine"\n');

    const summary = await runtime.scheduler?.runOnce({ force: true });
    expect(summary?.jobsAttempted).toBe(1);
    expect(runtime.dropped[0]?.layer.kind).toBe("base");
  });

  test("job state survives stubbing and unstubbing", async () => {
    await setPack(PACK);
    await runtime.scheduler?.runOnce({ force: true });
    const before = new FleetStore(db).loadJobState("pack-nightly")?.lastAttemptAt;
    expect(before).toBeDefined();
    expect(before).not.toBeNull();

    await setUser(STUB);
    await setUser("[decisions]\nmin_confidence = 0.5\n");
    expect(runtime.jobs.map((j) => j.name)).toEqual(["pack-nightly"]);
    expect(new FleetStore(db).loadJobState("pack-nightly")?.lastAttemptAt).toBe(before);
  });
});
