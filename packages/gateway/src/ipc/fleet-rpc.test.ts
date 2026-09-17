import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml, NimbusFleetToml } from "../config/fleet-toml.ts";
import { DEFAULT_FLEET_CONFIG } from "../config/fleet-toml.ts";
import {
  FleetDisabledError,
  FleetJobNotFoundError,
  type FleetRunSummary,
} from "../fleet/fleet-scheduler.ts";
import { FleetStore } from "../fleet/fleet-store.ts";
import { FLEET_SUBJECTS_V63_SQL } from "../index/fleet-subjects-v63-sql.ts";
import { FLEET_V60_SQL } from "../index/fleet-v60-sql.ts";
import {
  dispatchFleetRpc,
  type FleetRpcCtx,
  FleetRpcError,
  MAX_BRIEFS_LIMIT,
} from "./fleet-rpc.ts";

// A minimal stand-in for `FleetScheduler` — only `runOnce` is ever called through this surface.
interface FakeScheduler {
  runOnce(opts?: { force?: boolean; jobName?: string }): Promise<FleetRunSummary>;
}

const COMPLETED: FleetRunSummary = {
  runId: "run-1",
  outcome: "completed",
  jobsAttempted: 1,
  jobsCompleted: 1,
  jobsUnattempted: 0,
  jobsSkippedNotDue: 0,
};

test("fleet.status reports the live probe and config without running anything", async () => {
  const out = await dispatchFleetRpc("fleet.status", {}, {
    scheduler: undefined,
    store: undefined,
    hostActivity: { probe: async () => ({ power: "ac", idleMs: 1000, source: "measured" }) },
    config: { enabled: false },
  } as never);
  expect(out).toMatchObject({ kind: "hit" });
  if (out.kind !== "hit") throw new Error("expected a hit");
  expect(out.value).toMatchObject({ enabled: false, running: false });
});

test("fleet.status reports running: true and the real config/jobsConfigured when a scheduler IS wired", async () => {
  // Red-prove: hardcoding `running: false` in `handleStatus` passed the WHOLE suite before this
  // test existed — the only prior assertion on `running` was the `false` case above, and neither
  // `jobsConfigured` nor a config field was pinned against a ctx that actually carried them (the
  // `as never` ctx used everywhere else supplies at most one field, and the CLI's own status test
  // stubs the rendered response rather than exercising this handler). This ctx carries a REAL
  // scheduler, a REAL jobs array and a REAL (non-default) config, so a hardcoded `false`/`0`/a
  // dropped config field all fail here.
  const scheduler: FakeScheduler = { runOnce: async () => COMPLETED };
  const jobs: readonly NimbusFleetJobToml[] = [
    { name: "a", agent: "catchup", intervalSeconds: 60, params: {}, digestMinDelta: 1 },
    { name: "b", agent: "ownership", intervalSeconds: 120, params: {}, digestMinDelta: 1 },
  ];
  const config: NimbusFleetToml = {
    ...DEFAULT_FLEET_CONFIG,
    enabled: true,
    allowRemote: true,
    remoteCallBudget: 7,
    minIdleSeconds: 42,
    requireAcPower: false,
    retentionDays: 3,
  };
  const out = await dispatchFleetRpc("fleet.status", {}, {
    scheduler,
    store: undefined,
    hostActivity: { probe: async () => ({ power: "battery", idleMs: 500, source: "measured" }) },
    config,
    jobs,
    now: () => 0,
  } as never);
  if (out.kind !== "hit") throw new Error("expected a hit");
  expect(out.value).toEqual({
    enabled: true,
    running: true,
    allowRemote: true,
    remoteCallBudget: 7,
    minIdleSeconds: 42,
    requireAcPower: false,
    retentionDays: 3,
    jobsConfigured: 2,
    probe: { power: "battery", idleMs: 500, source: "measured" },
  });
});

test("an unknown fleet method is a miss, not a throw", async () => {
  const out = await dispatchFleetRpc("fleet.nope", {}, {} as never);
  expect(out).toMatchObject({ kind: "miss" });
});

describe("fleet.runNow threads jobName through to the scheduler", () => {
  test('a { job: "b" } param reaches runOnce with jobName: "b"', async () => {
    let received: { force?: boolean; jobName?: string } | undefined;
    const scheduler: FakeScheduler = {
      runOnce: async (opts) => {
        received = opts;
        return COMPLETED;
      },
    };
    const out = await dispatchFleetRpc("fleet.runNow", { job: "b" }, {
      scheduler,
      config: DEFAULT_FLEET_CONFIG,
      hostActivity: undefined,
      now: () => 0,
    } as never);
    expect(out).toMatchObject({ kind: "hit" });
    expect(received).toEqual({ jobName: "b", force: false });
  });

  test("no job name means run every configured job (jobName undefined)", async () => {
    let received: { force?: boolean; jobName?: string } | undefined;
    const scheduler: FakeScheduler = {
      runOnce: async (opts) => {
        received = opts;
        return COMPLETED;
      },
    };
    await dispatchFleetRpc("fleet.runNow", {}, {
      scheduler,
      config: DEFAULT_FLEET_CONFIG,
      hostActivity: undefined,
      now: () => 0,
    } as never);
    expect(received?.jobName).toBeUndefined();
    expect(received?.force).toBe(false);
  });

  test("force: true reaches runOnce", async () => {
    let received: { force?: boolean; jobName?: string } | undefined;
    const scheduler: FakeScheduler = {
      runOnce: async (opts) => {
        received = opts;
        return COMPLETED;
      },
    };
    await dispatchFleetRpc("fleet.runNow", { job: "a", force: true }, {
      scheduler,
      config: DEFAULT_FLEET_CONFIG,
      hostActivity: undefined,
      now: () => 0,
    } as never);
    expect(received).toEqual({ jobName: "a", force: true });
  });

  test("no scheduler wired throws a FleetRpcError rather than a generic miss", async () => {
    await expect(
      dispatchFleetRpc("fleet.runNow", {}, {
        scheduler: undefined,
        config: DEFAULT_FLEET_CONFIG,
        hostActivity: undefined,
        now: () => 0,
      } as never),
    ).rejects.toThrow(FleetRpcError);
  });

  test("FleetDisabledError from the scheduler surfaces as a FleetRpcError", async () => {
    const scheduler: FakeScheduler = {
      runOnce: async () => {
        throw new FleetDisabledError("fleet is disabled ([fleet] enabled = false)");
      },
    };
    await expect(
      dispatchFleetRpc("fleet.runNow", {}, {
        scheduler,
        config: DEFAULT_FLEET_CONFIG,
        hostActivity: undefined,
        now: () => 0,
      } as never),
    ).rejects.toThrow(FleetRpcError);
  });

  test("FleetJobNotFoundError surfaces as a -32602 FleetRpcError, not a silent run-everything", async () => {
    const scheduler: FakeScheduler = {
      runOnce: async () => {
        throw new FleetJobNotFoundError("no such fleet job: typo_job");
      },
    };
    try {
      await dispatchFleetRpc("fleet.runNow", { job: "typo_job" }, {
        scheduler,
        config: DEFAULT_FLEET_CONFIG,
        hostActivity: undefined,
        now: () => 0,
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetRpcError);
      expect((e as FleetRpcError).rpcCode).toBe(-32602);
    }
  });
});

describe("fleet.list / fleet.briefs / fleet.show over a real store", () => {
  let db: Database;
  let store: FleetStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(FLEET_V60_SQL);
    for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
    store = new FleetStore(db);
  });

  const jobs: readonly NimbusFleetJobToml[] = [
    {
      name: "morning_catchup",
      agent: "catchup",
      intervalSeconds: 3600,
      params: {},
      digestMinDelta: 1,
    },
  ];
  const config: NimbusFleetToml = DEFAULT_FLEET_CONFIG;

  function ctx(now: number, over?: Partial<FleetRpcCtx>): FleetRpcCtx {
    return {
      scheduler: undefined,
      store,
      hostActivity: { probe: async () => ({ power: "ac", idleMs: 0, source: "measured" }) },
      config,
      jobs,
      now: () => now,
      ...over,
    };
  }

  test("fleet.list reports every configured job, with null state before it has ever run", async () => {
    const out = await dispatchFleetRpc("fleet.list", {}, ctx(0));
    expect(out).toMatchObject({ kind: "hit" });
    if (out.kind !== "hit") throw new Error("expected a hit");
    expect(out.value).toEqual({
      jobs: [{ name: "morning_catchup", agent: "catchup", intervalSeconds: 3600, state: null }],
    });
  });

  test("fleet.list surfaces the job's recorded state once it has run", async () => {
    store.recordJobSuccess("morning_catchup", 500);
    const out = await dispatchFleetRpc("fleet.list", {}, ctx(0));
    if (out.kind !== "hit") throw new Error("expected a hit");
    const entry = (out.value as { jobs: Array<{ state: unknown }> }).jobs[0];
    expect(entry?.state).toMatchObject({ jobId: "morning_catchup", lastSuccessAt: 500 });
  });

  test("fleet.briefs and fleet.show exclude an expired brief the row still holds", async () => {
    const runId = store.openRun({
      startedAt: 0,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    const id = store.recordBrief({
      runId,
      jobId: "morning_catchup",
      subjectKey: "morning_catchup",
      agentMethod: "agents.catchup",
      briefMarkdown: "# hi",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt: 0,
      expiresAt: 1000,
    });

    const before = await dispatchFleetRpc("fleet.briefs", {}, ctx(500));
    if (before.kind !== "hit") throw new Error("expected a hit");
    expect((before.value as { briefs: unknown[] }).briefs).toHaveLength(1);

    const showBefore = await dispatchFleetRpc("fleet.show", { id }, ctx(500));
    if (showBefore.kind !== "hit") throw new Error("expected a hit");
    expect((showBefore.value as { brief: { id: string } | null }).brief?.id).toBe(id);

    const after = await dispatchFleetRpc("fleet.briefs", {}, ctx(2000));
    if (after.kind !== "hit") throw new Error("expected a hit");
    expect((after.value as { briefs: unknown[] }).briefs).toHaveLength(0);

    const showAfter = await dispatchFleetRpc("fleet.show", { id }, ctx(2000));
    if (showAfter.kind !== "hit") throw new Error("expected a hit");
    expect((showAfter.value as { brief: unknown }).brief).toBeNull();
  });

  test("fleet.briefs without a store throws rather than returning an empty list", async () => {
    await expect(
      dispatchFleetRpc("fleet.briefs", {}, ctx(0, { store: undefined })),
    ).rejects.toThrow(FleetRpcError);
  });

  test("fleet.show requires a non-empty id", async () => {
    await expect(dispatchFleetRpc("fleet.show", {}, ctx(0))).rejects.toThrow(FleetRpcError);
  });

  test("fleet.briefs rejects limit: 0 rather than silently returning an empty page", async () => {
    // The IPC boundary is the trust boundary, not the CLI: a caller-supplied 0 must not be
    // indistinguishable from "no briefs exist" (SQLite's LIMIT 0 would otherwise do exactly that).
    await expect(dispatchFleetRpc("fleet.briefs", { limit: 0 }, ctx(0))).rejects.toThrow(
      FleetRpcError,
    );
  });

  test("fleet.briefs rejects a negative limit", async () => {
    await expect(dispatchFleetRpc("fleet.briefs", { limit: -1 }, ctx(0))).rejects.toThrow(
      FleetRpcError,
    );
  });

  test('fleet.briefs caps an oversized limit at MAX_BRIEFS_LIMIT, not just "does not throw"', async () => {
    // Seeding only 3 rows and asserting 3 come back (the previous version of this test) passes
    // identically whether or not the clamp exists — 3 rows is 3 rows either way, so that assertion
    // could not have detected a removed clamp. Seeding MORE rows than MAX_BRIEFS_LIMIT and
    // asserting the EXACT clamped count is what makes an absent clamp observable: without it, all
    // MAX_BRIEFS_LIMIT + 50 rows would come back instead of exactly MAX_BRIEFS_LIMIT.
    const runId = store.openRun({
      startedAt: 0,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    const seeded = MAX_BRIEFS_LIMIT + 50;
    for (let i = 0; i < seeded; i++) {
      store.recordBrief({
        runId,
        jobId: `j${i}`,
        subjectKey: `j${i}`,
        agentMethod: "agents.catchup",
        briefMarkdown: "x",
        findingsJson: "{}",
        synthesisJson: null,
        createdAt: i,
        expiresAt: 10_000,
      });
    }
    const out = await dispatchFleetRpc("fleet.briefs", { limit: 1_000_000 }, ctx(0));
    if (out.kind !== "hit") throw new Error("expected a hit");
    expect((out.value as { briefs: unknown[] }).briefs).toHaveLength(MAX_BRIEFS_LIMIT);
  });
});

describe("fleet.digest", () => {
  const NOW = 1_000_000;
  let db: Database;
  let store: FleetStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(FLEET_V60_SQL);
    for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
    store = new FleetStore(db);
  });

  const jobs: readonly NimbusFleetJobToml[] = [
    {
      name: "morning_catchup",
      agent: "catchup",
      intervalSeconds: 3600,
      params: {},
      digestMinDelta: 1,
    },
  ];
  const config: NimbusFleetToml = DEFAULT_FLEET_CONFIG;

  function ctx(now: number, over?: Partial<FleetRpcCtx>): FleetRpcCtx {
    return {
      scheduler: undefined,
      store,
      hostActivity: { probe: async () => ({ power: "ac", idleMs: 0, source: "measured" }) },
      config,
      jobs,
      now: () => now,
      ...over,
    };
  }

  test("returns a digest over the requested window", async () => {
    const out = await dispatchFleetRpc("fleet.digest", { windowMs: 86_400_000 }, ctx(NOW));
    expect(out).toMatchObject({ kind: "hit" });
    if (out.kind !== "hit") throw new Error("expected a hit");
    expect(out.value).toMatchObject({ windowMs: 86_400_000, generatedAt: NOW });
    expect(typeof (out.value as { markdown: string }).markdown).toBe("string");
  });

  test("defaults the window to 24h when omitted", async () => {
    const out = await dispatchFleetRpc("fleet.digest", {}, ctx(NOW));
    if (out.kind !== "hit") throw new Error("expected a hit");
    expect((out.value as { windowMs: number }).windowMs).toBe(86_400_000);
  });

  test.each([-1, 0, 1.5, "24h"])("rejects windowMs = %p", async (windowMs) => {
    await expect(dispatchFleetRpc("fleet.digest", { windowMs }, ctx(NOW))).rejects.toThrow(
      FleetRpcError,
    );
  });

  test("fails cleanly when the store is absent", async () => {
    await expect(
      dispatchFleetRpc("fleet.digest", {}, ctx(NOW, { store: undefined })),
    ).rejects.toThrow(FleetRpcError);
  });
});
