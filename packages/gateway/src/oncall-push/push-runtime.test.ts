import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";

let db: Database;
let configDir: string;
const logs: string[] = [];
const boot = (now = 1000) =>
  assembleOncallPushRuntime({
    db,
    configDir,
    notify: () => {},
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

test("trigger never throws, even if the run rejects", async () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  const rt = boot();
  expect(() => rt.trigger("pagerduty")).not.toThrow();
  await new Promise((r) => setTimeout(r, 20));
});

test("identityResolved reads [user] me_person_id like agents.oncall does", async () => {
  writeFileSync(join(configDir, "nimbus.toml"), '[user]\nme_person_id = "person-1"\n');
  expect(await boot().identityResolved()).toBe(true);
});
