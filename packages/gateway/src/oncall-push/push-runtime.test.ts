import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";
import { PushStore } from "./push-store.ts";

const DAY = 86_400_000;

let db: Database;
let configDir: string;
const logs: string[] = [];
const boot = (now = 1000) =>
  assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: {
      error: (_o, m) => {
        logs.push(m);
      },
    },
    now: () => now,
  });

beforeEach(() => {
  db = createMemoryIndexDb();
  configDir = mkdtempSync(join(tmpdir(), "oncall-push-rt-"));
  logs.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

test("no config → disabled, and the boot reconcile leaves no enabled_at", () => {
  const rt = boot();
  expect(rt.config.enabled).toBe(false);
  expect(rt.store.enabledAt()).toBeNull();
});

test("enabled → boot stamps enabled_at = boot time (spec § 4.1)", () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  expect(boot(4242).store.enabledAt()).toBe(4242);
});

test("a disabled boot clears a prior enabled_at", () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  boot(1);
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = false\n");
  expect(boot(2).store.enabledAt()).toBeNull();
});

test("trigger never throws, even if the run rejects — the rejection is logged", async () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  const rt = boot();
  // A real failure: the run's first store read (enabledAt) throws on a closed database.
  db.close();
  expect(() => rt.trigger("pagerduty")).not.toThrow();
  await new Promise((r) => setTimeout(r, 20));
  expect(logs).toContain("[oncall.push] run failed");
  db = createMemoryIndexDb(); // afterEach closes it
});

test("boot prunes rows past retention even when push is DISABLED; a recent row survives", () => {
  const now = 400 * DAY;
  const seed = new PushStore(db);
  const failed = { status: "failed", sessionId: null, failureCode: "timeout: x" } as const;
  seed.insert("pagerduty:OLD", failed, now - 91 * DAY);
  seed.insert("pagerduty:NEW", failed, now - 89 * DAY);
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = false\n");
  const rt = boot(now);
  expect(rt.config.enabled).toBe(false);
  expect(rt.store.get("pagerduty:OLD")).toBeNull();
  expect(rt.store.get("pagerduty:NEW")).not.toBeNull();
});

test("identityResolved reads [user] me_person_id like agents.oncall does", async () => {
  writeFileSync(join(configDir, "nimbus.toml"), '[user]\nme_person_id = "person-1"\n');
  expect(await boot().identityResolved()).toBe(true);
});
