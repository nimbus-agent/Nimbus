// Role-packs spec § 5.9: a pack turns the on-call pushed brief on and off with no restart. Real
// path end to end: the real pack install/remove (behind an approving owner gate), the real pack
// layer store feeding the real layered config, and the real push runtime over a migrated DB.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENT_NAMES } from "../catalog/agent-catalog.ts";
import { builtinCatalogConnectorIds } from "../catalog/catalog-list.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "../config/layered-config.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { BUNDLED_PACKS } from "../packs/bundled-packs.ts";
import {
  installPack,
  type PackDeps,
  type PackOwnerGate,
  removePack,
} from "../packs/pack-install.ts";
import { createPackLayerStore, type PackLayerStore } from "../packs/pack-layer-store.ts";
import { assembleOncallPushRuntime, type OncallPushRuntime } from "./push-runtime.ts";

let dir: string;
let db: Database;
let packs: PackLayerStore;
let nowMs: number;
const runtimes: OncallPushRuntime[] = [];

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-push-live-pack-"));
  db = createMemoryIndexDb();
  packs = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, { packs });
  nowMs = 1_000;
});
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.stop();
  db.close();
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

function packDeps(): PackDeps {
  return {
    store: packs,
    configDir: dir,
    bundled: BUNDLED_PACKS,
    isProduction: () => false,
    isConfigured: async () => false,
    connectorIds: new Set(builtinCatalogConnectorIds()),
    agentNames: new Set(CATALOG_AGENT_NAMES),
    now: () => new Date(nowMs),
  };
}

const approve: PackOwnerGate = async () => true;

function boot(): OncallPushRuntime {
  const rt = assembleOncallPushRuntime({
    settleImmediately: true,
    checkMs: 60_000,
    db,
    configDir: dir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
  });
  runtimes.push(rt);
  return rt;
}

test("installing and removing the DevOps pack turns the push on and off with no restart", async () => {
  const rt = boot();
  // The premise: with no person and no `[user]` override, identity is unresolved, so an OPEN gate
  // reports `identity_unresolved`, distinct from both `disabled` and `not_reconciled`.
  expect(await rt.identityResolved()).toBe(false);

  expect((await rt.run("pagerduty")).skipped).toBe("disabled");
  expect(rt.isEnabled()).toBe(false);
  expect(rt.store.enabledAt()).toBeNull();

  nowMs = 5_000;
  expect((await installPack({ id: "devops" }, packDeps(), approve)).outcome).toBe("installed");
  expect((await rt.run("pagerduty")).skipped).toBe("identity_unresolved");
  expect(rt.isEnabled()).toBe(true);
  expect(rt.store.enabledAt()).toBe(5_000);

  nowMs = 6_000;
  expect(removePack("devops", packDeps()).removed).toBe(true);
  expect((await rt.run("pagerduty")).skipped).toBe("disabled");
  expect(rt.store.enabledAt()).toBeNull();

  // Re-enabling stamps the NEW time: enabling never backfills the gap it was off for.
  nowMs = 9_000;
  await installPack({ id: "devops" }, packDeps(), approve);
  expect((await rt.run("pagerduty")).skipped).toBe("identity_unresolved");
  expect(rt.store.enabledAt()).toBe(9_000);

  rt.stop();
  rt.stop();
});

test("the owner's own enabled = false wins over the pack", async () => {
  writeFileSync(join(dir, "nimbus.toml"), "[oncall.push]\nenabled = false\n");
  const rt = boot();
  expect(rt.isEnabled()).toBe(false);
  await installPack({ id: "devops" }, packDeps(), approve);
  expect((await rt.run("pagerduty")).skipped).toBe("disabled");
  expect(rt.isEnabled()).toBe(false);
  expect(rt.store.enabledAt()).toBeNull();
});

test("an unreadable owner nimbus.toml does not let the pack's enabled = true win", async () => {
  const tomlPath = join(dir, "nimbus.toml");
  writeFileSync(tomlPath, "[oncall.push]\nenabled = false\n");
  const rt = boot();
  await installPack({ id: "devops" }, packDeps(), approve);
  expect(rt.isEnabled()).toBe(false);

  // A directory of that name: readFileSync fails with EISDIR (not ENOENT) on every OS, so the
  // layered snapshot drops the owner layer as "absent" and only the pack's `enabled = true` is left.
  rmSync(tomlPath);
  mkdirSync(tomlPath);
  expect(rt.isEnabled()).toBe(false);
  expect((await rt.run("pagerduty")).skipped).toBe("disabled");
  expect(rt.store.enabledAt()).toBeNull();
});

test("an owner nimbus.toml unreadable at boot starts the push disabled", async () => {
  mkdirSync(join(dir, "nimbus.toml"));
  await installPack({ id: "devops" }, packDeps(), approve);
  const rt = boot();
  expect(rt.isEnabled()).toBe(false);
  expect(rt.store.enabledAt()).toBeNull();
});

/** A leftover window from an earlier enabled run, as the boot reconcile would have left it. */
function seedWindow(enabledAt: number): void {
  db.run("INSERT INTO oncall_push_state (id, enabled_at) VALUES (1, ?)", [enabledAt]);
}

test("a layer unreadable at boot leaves the push window intact; readable and enabled keeps it", () => {
  seedWindow(100);
  const tomlPath = join(dir, "nimbus.toml");
  mkdirSync(tomlPath);
  const rt = boot();
  expect(rt.isEnabled()).toBe(false);
  expect(rt.store.enabledAt()).toBe(100);

  rmSync(tomlPath, { recursive: true });
  writeFileSync(tomlPath, "[oncall.push]\nenabled = true\n");
  nowMs = 9_000;
  expect(rt.isEnabled()).toBe(true);
  expect(rt.store.enabledAt()).toBe(100);
});

test("a layer unreadable at boot, then readable with enabled = false, clears the stale window", () => {
  seedWindow(100);
  const tomlPath = join(dir, "nimbus.toml");
  mkdirSync(tomlPath);
  const rt = boot();
  expect(rt.store.enabledAt()).toBe(100);

  rmSync(tomlPath, { recursive: true });
  writeFileSync(tomlPath, "[oncall.push]\nenabled = false\n");
  expect(rt.isEnabled()).toBe(false);
  expect(rt.store.enabledAt()).toBeNull();
});
