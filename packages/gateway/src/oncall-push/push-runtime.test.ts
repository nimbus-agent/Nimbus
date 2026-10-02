import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSelfPerson } from "../agents/_lib/self-person.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { LocalIndex } from "../index/local-index.ts";
import { setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
import { findPersonByCanonicalEmail } from "../people/person-store.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";
import { PushStore } from "./push-store.ts";

const DAY = 86_400_000;

let db: Database;
let configDir: string;
const logs: string[] = [];
/** Resolves when the logger is next called; fails (never passes) if that takes over 5s. */
function nextLog(): { signal: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const signal = new Promise<void>((res, rej) => {
    resolve = res;
    setTimeout(() => rej(new Error("logger was never called within 5s")), 5000).unref();
  });
  return { signal, resolve };
}
let onLog: () => void = () => {};
const boot = (now = 1000) =>
  assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: {
      error: (_o, m) => {
        logs.push(m);
        onLog();
      },
    },
    now: () => now,
  });

beforeEach(() => {
  db = createMemoryIndexDb();
  configDir = mkdtempSync(join(tmpdir(), "oncall-push-rt-"));
  logs.length = 0;
  onLog = () => {};
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
  const logged = nextLog();
  onLog = logged.resolve;
  expect(() => rt.trigger("pagerduty")).not.toThrow();
  await logged.signal;
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

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const ME = "me@acme.example";

function seedP1(id: string): string {
  const ctx = syncTestContext(db, createStubVault({ "pagerduty.api_token": "tok" }), "pagerduty");
  syncPagerdutyIncidentItems(
    ctx,
    [
      {
        id,
        status: "triggered",
        title: `inc ${id}`,
        priority: { name: "P1" },
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
        service: { id: "PSVC" },
        assignments: [{ assignee: { id: "U1", type: "user", email: ME } }],
      },
    ],
    new Date(T0 - DAY).toISOString(),
    T0,
    new Map(),
  );
  const me = findPersonByCanonicalEmail(db, ME);
  if (me === null) throw new Error("fixture: no person");
  return me.id;
}

test("run() drives the real pipeline end to end: default dispatch, brief stored, toast + event delivered, retry refused on ok", async () => {
  const meId = seedP1("PRT");
  writeFileSync(
    join(configDir, "nimbus.toml"),
    `[user]\nme_person_id = "${meId}"\n\n[oncall.push]\nenabled = true\n`,
  );
  const toasts: [string, string][] = [];
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    localIndex: new LocalIndex(db),
    notifications: {
      show: (t, b) => {
        toasts.push([t, b]);
      },
    },
    logger: { error: () => {} },
    // Boot BEFORE the incident opened, so it is newer than enabled_at (spec § 4.1).
    now: () => T0 - 1000,
  });
  const events: Record<string, unknown>[] = [];
  setGatewayEventBroadcast((_m, p) => events.push(p));
  try {
    expect(await rt.run("pagerduty")).toEqual({ selected: 1, ok: 1, failed: 0 });
  } finally {
    setGatewayEventBroadcast(undefined);
  }
  expect(rt.store.get("pagerduty:PRT")?.status).toBe("ok");
  expect(rt.store.get("pagerduty:PRT")?.briefMarkdown).toContain("## Gaps");
  expect(toasts).toEqual([
    ["Nimbus on-call", "inc PRT — brief ready: nimbus oncall pushed pagerduty:PRT"],
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "oncall.briefPushed",
    payload: { incidentId: "pagerduty:PRT", status: "ok" },
  });
  await expect(rt.retry("pagerduty:PRT")).rejects.toMatchObject({
    code: "ERR_ONCALL_PUSH_NOT_FAILED",
  });
  expect(await rt.identityResolved()).toBe(true);
});

test("a notification service that does not deliver records the toast skipped; no throw", async () => {
  const meId = seedP1("PSK");
  writeFileSync(
    join(configDir, "nimbus.toml"),
    `[user]\nme_person_id = "${meId}"\n\n[oncall.push]\nenabled = true\n`,
  );
  let shown = 0;
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: {
      delivers: false,
      show: () => {
        shown += 1;
      },
    },
    logger: { error: () => {} },
    now: () => T0 - 1000,
  });
  await rt.run("pagerduty");
  expect(shown).toBe(0);
  expect(rt.store.get("pagerduty:PSK")?.delivery["toast"]?.outcome).toBe("skipped");
});

test("trigger logs a non-Error rejection as its string form", async () => {
  writeFileSync(join(configDir, "nimbus.toml"), "[oncall.push]\nenabled = true\n");
  const errs: Record<string, unknown>[] = [];
  const logged = nextLog();
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: {
      error: (o) => {
        errs.push(o);
        logged.resolve();
      },
    },
    now: () => 1000,
  });
  // Make the run reject with a NON-Error: the first store read throws a string.
  (rt.store as { enabledAt: () => number | null }).enabledAt = () => {
    throw "plain failure";
  };
  rt.trigger("pagerduty");
  await logged.signal;
  expect(errs).toEqual([{ err: "plain failure" }]);
});

test("with a [user] override, identity resolves", async () => {
  writeFileSync(
    join(configDir, "nimbus.toml"),
    `[user]
me_person_id = "person-1"
`,
  );
  const rt = boot();
  expect(await rt.identityResolved()).toBe(true);
});

test("without a [user] override and the default clock, identity agrees with resolveSelfPerson", async () => {
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
  });
  const expected = (await resolveSelfPerson(db, {})).personId !== null;
  expect(await rt.identityResolved()).toBe(expected);
  expect(await rt.run("github")).toMatchObject({ skipped: "not_pagerduty" });
});
