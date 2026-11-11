import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { BriefingBrief, BriefingCounts } from "../agents/_lib/briefing-types.ts";
import type { BriefingReadyPayload } from "../ipc/gateway-events.ts";
import type { ToastOutcome } from "../platform/notifications/notifications-runtime.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { runBriefing } from "./briefing-runner.ts";
import { type BriefingStore, createBriefingStore } from "./briefing-store.ts";

const NOW = Date.UTC(2026, 10, 12, 8, 30);
const DAY = 86_400_000;

const COUNTS: BriefingCounts = {
  meetings: 3,
  onCallShifts: 0,
  incidents: 0,
  reviews: 2,
  ticketsDue: 0,
  unreadMail: 0,
  unreadChat: 0,
};

function fakeBrief(counts = COUNTS): BriefingBrief {
  return {
    kind: "briefing",
    agentVersion: 1,
    generatedAt: new Date(NOW).toISOString(),
    latencyMs: 0,
    gaps: [],
    tz: "UTC",
    day: { startMs: 0, endMs: 1, dateKey: "2026-11-12", label: "Thursday 2026-11-12" },
    sections: [],
    counts,
    freshness: [],
  };
}

let db: Database;
let store: BriefingStore;
let log: string[];
let events: BriefingReadyPayload[];
let toasts: Array<{ title: string; body: string }>;

beforeEach(() => {
  db = openMemoryIndexDatabase();
  store = createBriefingStore(db);
  log = [];
  events = [];
  toasts = [];
});
afterEach(() => db.close());

function deps(over: Partial<Parameters<typeof runBriefing>[0]> = {}) {
  return {
    store,
    now: () => NOW,
    build: () => fakeBrief(),
    retentionDays: () => 30,
    emit: (p: BriefingReadyPayload) => {
      log.push("emit");
      events.push(p);
    },
    toast: async (title: string, body: string): Promise<ToastOutcome> => {
      log.push("toast");
      toasts.push({ title, body });
      return "delivered";
    },
    ...over,
  };
}

describe("runBriefing", () => {
  test("a schedule run stores one ok row, emits once, then toasts the headline, then stores the outcome", async () => {
    const r = await runBriefing(deps(), { firedBy: "schedule", slotAt: NOW - 1000, toast: true });
    expect(r?.status).toBe("ok");
    expect(r?.headline).toBe("3 meetings · 2 reviews waiting");
    const row = store.get(r?.id ?? "");
    expect(row?.firedBy).toBe("schedule");
    expect(row?.slotAt).toBe(NOW - 1000);
    expect(row?.markdown).toContain("# Morning briefing - Thursday 2026-11-12");
    expect(row?.counts).toEqual(COUNTS);
    expect(row?.headline).toBe(toasts[0]?.body ?? "");
    expect(row?.toastOutcome).toBe("delivered");
    expect(log).toEqual(["emit", "toast"]);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(["counts", "firedBy", "headline", "runId"]);
    expect(events[0]?.runId).toBe(r?.id ?? "");
    expect(toasts[0]?.title).toBe("Nimbus briefing");
  });

  test("a slot already taken inserts nothing, emits nothing and shows nothing", async () => {
    store.insertRun({
      firedAt: 1,
      firedBy: "schedule",
      status: "skipped",
      headline: "x",
      slotAt: 5,
    });
    const r = await runBriefing(deps(), { firedBy: "schedule", slotAt: 5, toast: true });
    expect(r).toBeNull();
    expect(log).toEqual([]);
    expect(store.list(10)).toHaveLength(1);
  });

  test("a throwing builder stores a failed row with a bounded message and notifies nobody", async () => {
    const errors: unknown[] = [];
    const r = await runBriefing(
      deps({
        build: () => {
          throw new Error("x".repeat(500));
        },
        onError: (e) => errors.push(e),
      }),
      { firedBy: "manual", toast: true },
    );
    expect(r?.status).toBe("failed");
    const row = store.get(r?.id ?? "");
    expect(row?.status).toBe("failed");
    expect(row?.errorMsg?.length).toBeLessThanOrEqual(220);
    expect(row?.errorMsg?.startsWith("Error: xxx")).toBe(true);
    expect(log).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("a non-Error throw is described too; a failed slot that is already taken returns null", async () => {
    store.insertRun({ firedAt: 1, firedBy: "schedule", status: "ok", headline: "x", slotAt: 9 });
    const thrower = () => {
      throw "plain string";
    };
    expect(
      await runBriefing(deps({ build: thrower }), { firedBy: "schedule", slotAt: 9, toast: true }),
    ).toBeNull();
    const r = await runBriefing(deps({ build: thrower }), { firedBy: "manual", toast: true });
    expect(store.get(r?.id ?? "")?.errorMsg).toBe("Error: plain string");
  });

  test("toast: false records the demo outcome and never calls the toast", async () => {
    const r = await runBriefing(deps(), { firedBy: "manual", toast: false });
    expect(store.get(r?.id ?? "")?.toastOutcome).toBe("demo");
    expect(log).toEqual(["emit"]);
  });

  test("an emit that throws does not stop the toast", async () => {
    const r = await runBriefing(
      deps({
        emit: () => {
          throw new Error("observer");
        },
      }),
      { firedBy: "manual", toast: true },
    );
    expect(r?.status).toBe("ok");
    expect(log).toEqual(["toast"]);
  });

  test("the toast outcome is whatever the sink reports", async () => {
    const r = await runBriefing(deps({ toast: async () => "rate_limited" }), {
      firedBy: "manual",
      toast: true,
    });
    expect(store.get(r?.id ?? "")?.toastOutcome).toBe("rate_limited");
  });

  test("retention: a run older than retention_days is pruned by the next fire; a prune error is reported", async () => {
    store.insertRun({ firedAt: NOW - 31 * DAY, firedBy: "manual", status: "ok", headline: "old" });
    store.insertRun({ firedAt: NOW - 29 * DAY, firedBy: "manual", status: "ok", headline: "new" });
    await runBriefing(deps(), { firedBy: "manual", toast: false });
    expect(store.list(10).map((r) => r.headline)).not.toContain("old");
    expect(store.list(10).map((r) => r.headline)).toContain("new");

    const errors: unknown[] = [];
    const broken: BriefingStore = {
      ...store,
      pruneRuns: () => {
        throw new Error("disk");
      },
    };
    await runBriefing(deps({ store: broken, onError: (e) => errors.push(e) }), {
      firedBy: "manual",
      toast: false,
    });
    expect(errors).toHaveLength(1);
    // without an error sink the failure is swallowed, never thrown
    await runBriefing(deps({ store: broken }), { firedBy: "manual", toast: false });
  });

  test("retention: a failed run also prunes expired rows", async () => {
    store.insertRun({ firedAt: NOW - 31 * DAY, firedBy: "manual", status: "ok", headline: "old" });
    const r = await runBriefing(
      deps({
        build: () => {
          throw new Error("compose");
        },
      }),
      { firedBy: "manual", toast: false },
    );
    expect(r?.status).toBe("failed");
    expect(store.list(10).map((x) => x.headline)).not.toContain("old");
  });

  test("a store failure other than a taken slot propagates", async () => {
    const broken: BriefingStore = {
      ...store,
      insertRun: () => {
        throw new Error("disk full");
      },
    };
    await expect(
      runBriefing(deps({ store: broken }), { firedBy: "manual", toast: true }),
    ).rejects.toThrow("disk full");
    const brokenFail: BriefingStore = { ...broken };
    await expect(
      runBriefing(
        deps({
          store: brokenFail,
          build: () => {
            throw new Error("x");
          },
        }),
        { firedBy: "manual", toast: true },
      ),
    ).rejects.toThrow("disk full");
  });
});
