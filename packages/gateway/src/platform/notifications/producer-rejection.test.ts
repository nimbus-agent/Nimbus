/**
 * Crash hazard (pre-S3 item E, T2): `NotificationService.show()` now REJECTS (unavailable,
 * rate-limited, send failure), and every producer fires it as `void notify(...)` — the sync
 * scheduler (`void this.notify?.(...)`) and the watcher engine (`void notify(...)`). A `void`ed
 * rejection is an unhandled rejection, which `platform/exit-diagnostics.ts` turns into a gateway
 * exit. `platform/assemble.ts` therefore wraps every producer callback in `showIgnoringFailure`.
 *
 * This file proves, against the REAL producers and a REAL `createOsNotifications` service whose
 * backend is unavailable (so `show()` genuinely rejects — no real process is spawned):
 *   1. through `showIgnoringFailure`, the promise each producer callback RETURNS — the very promise
 *      the producer `void`s — FULFILS, so no unhandled rejection is possible;
 *   2. negative control: the bare `(t, b) => svc.show(t, b)` lambda returns one that REJECTS, so
 *      (1) is not passing because the rejection never happened;
 *
 * The outcome is observed by a tracker that attaches its handler synchronously (so the negative
 * control does not itself leak a rejection, which `bun test` reports as a file error).
 *   3. `assemble.ts` routes all three producer callbacks through `showIgnoringFailure` and has no
 *      other bare `notifications.show(` call than the consent-hop notifier, which
 *      `notifyApprovalPending` already swallows.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import os from "node:os";
import { join } from "node:path";
import pino from "pino";

import {
  evaluateWatchersAfterSync,
  evaluateWatchersStartupCatchUp,
} from "../../automation/watcher-engine.ts";
import { insertWatcher } from "../../automation/watcher-store.ts";
import { DEFAULT_NOTIFICATIONS_CONFIG } from "../../config/notifications-toml.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import { SyncScheduler } from "../../sync/scheduler.ts";
import { unboundSyncCapabilities } from "../../sync/sync-capabilities.ts";
import { type SyncRuntimeContext, UnauthenticatedError } from "../../sync/types.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../../testing/bun-test-support.ts";
import { showIgnoringFailure } from "./notifications-runtime.ts";
import { createOsNotifications } from "./os-notifications.ts";
import type { NotificationBackend } from "./types.ts";

type Notify = (title: string, body: string) => Promise<void>;
type Outcome = "fulfilled" | "rejected";

/**
 * Wrap a producer callback and record how the promise IT RETURNS settles. The handler is attached
 * synchronously, before the producer can `void` it.
 */
function tracked(notify: Notify): { notify: Notify; settled: () => Promise<Outcome[]> } {
  const outcomes: Array<Promise<Outcome>> = [];
  return {
    notify: (t, b) => {
      const p = notify(t, b);
      outcomes.push(
        p.then(
          () => "fulfilled" as const,
          () => "rejected" as const,
        ),
      );
      return p;
    },
    settled: () => Promise.all(outcomes),
  };
}

/** A real OS service whose backend reports unavailable: every `show()` rejects. */
function rejectingService(): {
  svc: Pick<ReturnType<typeof createOsNotifications>, "show">;
  calls: () => number;
} {
  const backend: NotificationBackend = {
    id: "windows-toast",
    probe: () => Promise.resolve({ available: false, reason: "test: no notifier" }),
    send: () => Promise.resolve(),
  };
  const real = createOsNotifications({
    backend,
    config: DEFAULT_NOTIFICATIONS_CONFIG,
    logger: { info: () => {}, warn: () => {} },
  });
  let shows = 0;
  return {
    svc: {
      show: (t: string, b: string) => {
        shows += 1;
        return real.show(t, b);
      },
    },
    calls: () => shows,
  };
}

function seedFiringWatcher(db: Database, t0: number): void {
  insertWatcher(db, {
    name: "spike",
    enabled: 1,
    condition_type: "alert_fired",
    condition_json: JSON.stringify({ filter: { service: "sentry" } }),
    action_type: "notify",
    action_json: "{}",
    created_at: t0,
  });
  upsertIndexedItem(db, {
    service: "sentry",
    type: "alert",
    externalId: "e1",
    title: "Error spike",
    modifiedAt: t0 + 1000,
    syncedAt: t0 + 1000,
  });
}

function testContext(db: Database): SyncRuntimeContext {
  return {
    ...unboundSyncCapabilities(),
    db,
    vault: createMemoryVault(),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    sandboxCwd: os.tmpdir(),
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: async () => [],
    depth: "full",
  };
}

describe("a rejecting notifier never becomes an unhandled rejection", () => {
  test("showIgnoringFailure: rejection and a synchronous throw both resolve", async () => {
    await expect(
      showIgnoringFailure({ show: () => Promise.reject(new Error("x")) }, "t", "b"),
    ).resolves.toBeUndefined();
    await expect(
      showIgnoringFailure(
        {
          show: () => {
            throw new Error("sync");
          },
        },
        "t",
        "b",
      ),
    ).resolves.toBeUndefined();
  });

  test("watcher engine (after-sync + startup catch-up) through showIgnoringFailure", async () => {
    const { svc, calls } = rejectingService();
    const tr = tracked((t, b) => showIgnoringFailure(svc, t, b));
    const t0 = 2_700_000_000_000;
    const db1 = openMemoryIndexDatabase();
    seedFiringWatcher(db1, t0);
    evaluateWatchersAfterSync(db1, "sentry", t0 + 2000, tr.notify);
    const db2 = openMemoryIndexDatabase();
    seedFiringWatcher(db2, t0);
    evaluateWatchersStartupCatchUp(db2, t0 + 2000, tr.notify);
    expect(calls()).toBe(2);
    expect(await tr.settled()).toEqual(["fulfilled", "fulfilled"]);
  });

  test("negative control: the bare `(t, b) => svc.show(t, b)` lambda returns a REJECTING promise", async () => {
    const { svc, calls } = rejectingService();
    const tr = tracked((t, b) => svc.show(t, b));
    const t0 = 2_700_000_000_000;
    const db = openMemoryIndexDatabase();
    seedFiringWatcher(db, t0);
    evaluateWatchersAfterSync(db, "sentry", t0 + 2000, tr.notify);
    expect(calls()).toBe(1);
    expect(await tr.settled()).toEqual(["rejected"]);
  });

  test("sync scheduler auth-loss notify through showIgnoringFailure", async () => {
    const { svc, calls } = rejectingService();
    const tr = tracked((t, b) => showIgnoringFailure(svc, t, b));
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(testContext(db), {}, { random: () => 0, notify: tr.notify });
    sched.register({
      serviceId: "auth",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      sync: () => Promise.reject(new UnauthenticatedError("token revoked")),
    });
    await expect(sched.forceSync("auth")).rejects.toThrow(/token revoked/);
    await sched.stop();
    expect(calls()).toBe(1);
    expect(await tr.settled()).toEqual(["fulfilled"]);
  });
});

describe("assemble.ts wiring", () => {
  test("every producer callback goes through showIgnoringFailure; the only bare show is the consent hop", async () => {
    const src = await Bun.file(join(import.meta.dir, "..", "assemble.ts")).text();
    expect(src).toMatch(
      /notify: \(title, body\) => showIgnoringFailure\(notifications, title, body\)/,
    );
    expect(src.match(/\(t, b\) => showIgnoringFailure\(notifications, t, b\)/g)?.length).toBe(2);
    const bare = src.match(/notifications\.show\(/g) ?? [];
    expect(bare).toHaveLength(1);
    expect(src).toContain(
      "setApprovalPendingNotifier((title, body) => notifications.show(title, body, { urgent: true }));",
    );
  });
});
