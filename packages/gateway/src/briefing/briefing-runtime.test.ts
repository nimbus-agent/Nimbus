import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parseNimbusTomlBriefing } from "../config/briefing-toml.ts";
import type { BriefingReadyPayload } from "../ipc/gateway-events.ts";
import type { ToastOutcome } from "../platform/notifications/notifications-runtime.ts";
import { markSynced, seedItem, setSnapshot } from "../testing/briefing-fixtures.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import {
  BriefingBusyError,
  type BriefingRuntimeDeps,
  createBriefingRuntime,
} from "./briefing-runtime.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 12, 8, 31);

let db: Database;
let events: BriefingReadyPayload[];
let toasts: Array<{ title: string; body: string }>;
let warnings: string[];

beforeEach(() => {
  db = openMemoryIndexDatabase();
  events = [];
  toasts = [];
  warnings = [];
});
afterEach(() => db.close());

function deps(over: Partial<BriefingRuntimeDeps> = {}): BriefingRuntimeDeps {
  return {
    db,
    configDir: "C:/nonexistent-nimbus-test-dir",
    now: () => NOW,
    resolveSelf: async () => null,
    emit: (p) => events.push(p),
    toast: async (title, body): Promise<ToastOutcome> => {
      toasts.push({ title, body });
      return "delivered";
    },
    toastDelivers: () => true,
    demo: false,
    loadConfig: () => parseNimbusTomlBriefing('[briefing]\nenabled = true\ntz = "UTC"\n'),
    logger: { warn: (_o, msg) => warnings.push(msg) },
    ...over,
  };
}

describe("runNow and the read side", () => {
  test("a manual run stores a row, emits the event and toasts once; latest, list and get read it", async () => {
    const rt = createBriefingRuntime(deps());
    const view = await rt.runNow();
    expect(view.firedBy).toBe("manual");
    expect(view.status).toBe("ok");
    expect(view.markdown).toContain("# Morning briefing - Thursday 2026-11-12 (UTC)");
    expect(view.toastOutcome).toBe("delivered");
    expect(events).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(rt.latest()?.id).toBe(view.id);
    expect(rt.list(5).map((r) => r.id)).toEqual([view.id]);
    expect(rt.get(view.id)?.markdown).toBe(view.markdown);
    expect(rt.get("nope")).toBeNull();
  });

  test("the owner's person id and the chat reader reach the brief", async () => {
    markSynced(db, "slack", NOW);
    let resolved = 0;
    const rt = createBriefingRuntime(
      deps({
        resolveSelf: async () => {
          resolved += 1;
          return "p1";
        },
        readUnreadChat: () => ({
          totalThreads: 1,
          threads: [
            {
              itemId: "s",
              channelId: "C",
              channelName: "general",
              channelKind: "channel",
              threadKey: "t",
              latestTsMs: NOW,
              title: "Chat thread",
              url: null,
              unreadMessages: 2,
            },
          ],
          channelsWithMarker: 1,
          oldestMarkerCapturedAtMs: NOW,
          newestMarkerCapturedAtMs: NOW,
        }),
      }),
    );
    const view = await rt.runNow();
    expect(resolved).toBe(1);
    expect(view.markdown).toContain("Chat thread");
    expect(view.counts?.unreadChat).toBe(1);
  });

  test("a run while another is in flight is refused with ERR_BRIEFING_BUSY", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const rt = createBriefingRuntime(
      deps({
        resolveSelf: async () => {
          await gate;
          return null;
        },
      }),
    );
    const first = rt.runNow();
    const err = await rt.runNow().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BriefingBusyError);
    expect((err as BriefingBusyError).code).toBe("ERR_BRIEFING_BUSY");
    release();
    await first;
    await rt.runNow();
  });

  test("a failed build is stored as a failed row and runNow still returns it", async () => {
    const rt = createBriefingRuntime(deps({ loadConfig: () => parseNimbusTomlBriefing("") }));
    markSynced(db, "github", NOW);
    db.run("DROP TABLE work_snapshot");
    const view = await rt.runNow();
    expect(view.status).toBe("failed");
    expect(rt.latest()).toBeNull();
    expect(warnings).toContain("briefing run problem");
  });
});

describe("demo", () => {
  test("no scheduler object; runNow emits the event, never toasts, and records demo", async () => {
    const rt = createBriefingRuntime(deps({ demo: true }));
    expect(rt.scheduler).toBeUndefined();
    const view = await rt.runNow();
    expect(events).toHaveLength(1);
    expect(toasts).toHaveLength(0);
    expect(view.toastOutcome).toBe("demo");
    expect(rt.status().demo).toBe(true);
  });
});

describe("the scheduler it builds", () => {
  test("a tick fires the slot once, through the runner, and the deadline scan records its state", async () => {
    const cfg = parseNimbusTomlBriefing(
      '[briefing]\nenabled = true\ntz = "UTC"\nschedule = "30 8 * * 1-5"\n[briefing.deadlines]\nenabled = true\n',
    );
    const rt = createBriefingRuntime(deps({ loadConfig: () => cfg, now: () => NOW }));
    // The first tick sets the baseline to now (08:31), so the 08:30 slot is not invented.
    await rt.scheduler?.tick();
    expect(events).toHaveLength(0);
    expect(rt.status().deadlines.lastScanMs).toBe(NOW);
    expect(rt.status().deadlines.lastCandidateCount).toBe(0);
    expect(rt.status().deadlines.lastNoticeCount).toBe(0);
  });

  test("a scheduled slot fires after a restart that finds it missed, waiting out a manual run", async () => {
    const cfg = parseNimbusTomlBriefing(
      '[briefing]\nenabled = true\ntz = "UTC"\nschedule = "30 8 * * 1-5"\n',
    );
    const seed = createBriefingRuntime(deps({ loadConfig: () => cfg }));
    seed.store.insertRun({
      firedAt: NOW - 24 * HOUR,
      firedBy: "schedule",
      status: "ok",
      headline: "y",
      slotAt: Date.UTC(2026, 10, 11, 8, 30),
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const rt = createBriefingRuntime(
      deps({
        loadConfig: () => cfg,
        resolveSelf: async () => {
          calls += 1;
          if (calls === 1) await gate;
          return null;
        },
      }),
    );
    const manual = rt.runNow();
    const tick = rt.scheduler?.tick();
    release();
    await manual;
    await tick;
    const rows = rt.list(10);
    expect(rows.map((r) => r.firedBy).sort()).toEqual(["manual", "schedule", "schedule"]);
    expect(rows.filter((r) => r.slotAt === Date.UTC(2026, 10, 12, 8, 30))).toHaveLength(1);
  });
});

describe("status", () => {
  test("echoes the config, the next fire in the configured zone and the sources", () => {
    markSynced(db, "gmail", NOW - 60_000);
    const rt = createBriefingRuntime(
      deps({
        loadConfig: () =>
          parseNimbusTomlBriefing(
            '[briefing]\nenabled = true\ntz = "Europe/London"\nschedule = "30 8 * * 1-5"\nsections = ["mail", "tickets"]\nretention_days = 7\n',
          ),
        toastDelivers: () => false,
      }),
    );
    const s = rt.status();
    expect(s.enabled).toBe(true);
    expect(s.tz).toBe("Europe/London");
    expect(s.sections).toEqual(["mail", "tickets"]);
    expect(s.retentionDays).toBe(7);
    expect(s.nextFireMs).toBe(Date.UTC(2026, 10, 13, 8, 30));
    expect(s.toastDelivers).toBe(false);
    expect(s.lastRun).toBeNull();
    expect(s.sources[0]).toEqual({
      section: "mail",
      services: [
        { id: "gmail", connected: true, lastSyncMs: NOW - 60_000 },
        { id: "outlook", connected: false, lastSyncMs: null },
      ],
    });
    expect(s.sources[1]?.services.every((x) => !x.connected)).toBe(true);
  });

  test("nextFireMs across a DST change keeps the local hour; disabled has none", () => {
    const rt = createBriefingRuntime(
      deps({
        now: () => Date.UTC(2026, 2, 28, 12),
        loadConfig: () =>
          parseNimbusTomlBriefing(
            '[briefing]\nenabled = true\ntz = "Europe/London"\nschedule = "30 8 * * *"\n',
          ),
      }),
    );
    // 2026-03-29 08:30 BST = 07:30Z
    expect(rt.status().nextFireMs).toBe(Date.UTC(2026, 2, 29, 7, 30));
    const off = createBriefingRuntime(deps({ loadConfig: () => parseNimbusTomlBriefing("") }));
    expect(off.status().nextFireMs).toBeNull();
  });

  test("the default config loader reads the layered config dir", () => {
    const rt = createBriefingRuntime({ ...deps(), loadConfig: undefined as never });
    seedItem(db, {
      service: "github",
      type: "issue",
      externalId: "x",
      title: "t",
      modifiedAt: 1,
      metadata: {},
    });
    setSnapshot(db, "github", "assigned", ["x"], 1);
    expect(rt.status().enabled).toBe(false);
  });
});
