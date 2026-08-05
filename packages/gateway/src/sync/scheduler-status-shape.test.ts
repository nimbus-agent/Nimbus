import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import os from "node:os";
import pino from "pino";

import { LocalIndex } from "../index/local-index.ts";
import { createMemoryVault } from "../testing/bun-test-support.ts";
import { ProviderRateLimiter } from "./rate-limiter.ts";
import { SyncScheduler } from "./scheduler.ts";
import type { Syncable, SyncContext, SyncResult } from "./types.ts";

function setup(): { idx: LocalIndex; sched: SyncScheduler; db: Database } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const idx = new LocalIndex(db);
  const ctx: SyncContext = {
    db,
    vault: createMemoryVault(),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    sandboxCwd: os.tmpdir(),
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: async () => [],
    depth: "full",
  };
  const sched = new SyncScheduler(ctx, {}, { initialOnline: false });
  return { idx, sched, db };
}

const noop: Syncable = {
  serviceId: "github",
  defaultIntervalMs: 60_000,
  initialSyncDepthDays: 30,
  async sync(): Promise<SyncResult> {
    return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
  },
};

describe("SyncScheduler.getStatus — depth + enabled shape (V21)", () => {
  test("returns depth='full' and enabled=true for a fresh connector", () => {
    const { sched } = setup();
    sched.register(noop);
    const statuses = sched.getStatus("github");
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s).toBeDefined();
    expect(s!.depth).toBe("full");
    expect(s!.enabled).toBe(true);
  });

  test("reflects persisted depth after setConnectorDepth", () => {
    const { idx, sched } = setup();
    sched.register(noop);
    idx.setConnectorDepth("github", "full");
    const statuses = sched.getStatus("github");
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s).toBeDefined();
    expect(s!.depth).toBe("full");
    expect(s!.enabled).toBe(true);
  });

  test("enabled=false after pause", () => {
    const { sched } = setup();
    sched.register(noop);
    sched.pause("github");
    const statuses = sched.getStatus("github");
    expect(statuses).toHaveLength(1);
    const s = statuses[0];
    expect(s).toBeDefined();
    expect(s!.enabled).toBe(false);
  });
});
