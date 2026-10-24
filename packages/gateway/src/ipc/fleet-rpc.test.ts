import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml, NimbusFleetToml } from "../config/fleet-toml.ts";
import { DEFAULT_FLEET_CONFIG } from "../config/fleet-toml.ts";
import {
  FleetDisabledError,
  FleetJobNotFoundError,
  FleetReloadingError,
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
  subjectsInScope: 1,
  subjectsAttempted: 1,
  subjectsCompleted: 1,
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
    {
      name: "a",
      agent: "catchup",
      intervalSeconds: 60,
      params: {},
      digestMinDelta: 1,
      sweep: null,
    },
    {
      name: "b",
      agent: "ownership",
      intervalSeconds: 120,
      params: {},
      digestMinDelta: 1,
      sweep: null,
    },
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
    jobsDisabled: 0,
    droppedJobs: [],
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
      sweep: null,
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
      jobs: [
        {
          name: "morning_catchup",
          agent: "catchup",
          intervalSeconds: 3600,
          state: null,
          sweep: null,
          layer: null,
        },
      ],
      disabled: [],
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

  function seedBrief(jobId: string, subjectKey: string, createdAt: number): void {
    const runId = store.openRun({
      startedAt: createdAt,
      hostPower: "ac",
      hostIdleMs: 0,
      hostSource: "measured",
      remoteCallBudget: 0,
    });
    store.recordBrief({
      runId,
      jobId,
      subjectKey,
      agentMethod: "agents.oncall",
      briefMarkdown: "x",
      findingsJson: "{}",
      synthesisJson: null,
      createdAt,
      expiresAt: createdAt + 86_400_000,
    });
  }

  const sweepJob: NimbusFleetJobToml = {
    name: "bus",
    agent: "ownership",
    intervalSeconds: 86_400,
    params: {},
    digestMinDelta: 1,
    sweep: { kind: "paths", maxSubjects: 20, pathPrefix: "src/" },
  };

  test("fleet.briefs filters by subjectKey", async () => {
    seedBrief("nightly", "services:checkout", 1000);
    seedBrief("nightly", "services:billing", 1001);
    const r = await dispatchFleetRpc(
      "fleet.briefs",
      { subjectKey: "services:checkout" },
      ctx(2000),
    );
    expect(r.kind).toBe("hit");
    const briefs = (r as { value: { briefs: Array<{ subjectKey: string }> } }).value.briefs;
    expect(briefs.map((b) => b.subjectKey)).toEqual(["services:checkout"]);
  });

  test("fleet.briefs refuses an empty subjectKey", async () => {
    await expect(dispatchFleetRpc("fleet.briefs", { subjectKey: "" }, ctx(2000))).rejects.toThrow(
      /subjectKey must be a non-empty string/,
    );
  });

  test("fleet.list reports sweep config and state; config-named jobs report sweep: null", async () => {
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 60, emptyReason: null });
    const r = await dispatchFleetRpc("fleet.list", {}, ctx(2000, { jobs: [...jobs, sweepJob] }));
    const listed = (r as { value: { jobs: Array<{ name: string; sweep: unknown }> } }).value.jobs;
    expect(listed.find((j) => j.name === "bus")?.sweep).toEqual({
      kind: "paths",
      maxSubjects: 20,
      pathPrefix: "src/",
      subjectsTotal: 60,
      cursor: null,
      emptyReason: null,
      // ceil(60 / 20) = 3 runs × 1 day = 3 days, inside the default 14-day retention
      rotationExceedsRetention: false,
    });
    expect(listed.find((j) => j.name === "morning_catchup")?.sweep).toBeNull();
  });

  test("fleet.list flags a rotation longer than retention, and null before any enumeration", async () => {
    type Listed = { value: { jobs: Array<{ sweep: { rotationExceedsRetention: unknown } }> } };
    const r1 = (await dispatchFleetRpc(
      "fleet.list",
      {},
      ctx(2000, { jobs: [sweepJob] }),
    )) as Listed;
    expect(r1.value.jobs[0]?.sweep.rotationExceedsRetention).toBeNull();
    store.recordSweepEnumeration("bus", { kind: "paths", subjectsTotal: 400, emptyReason: null });
    const r2 = (await dispatchFleetRpc(
      "fleet.list",
      {},
      ctx(2000, { jobs: [sweepJob] }),
    )) as Listed;
    expect(r2.value.jobs[0]?.sweep.rotationExceedsRetention).toBe(true); // 20 runs = 20 days > 14
  });

  test("fleet.list reports NOTHING from a previous sweep kind's persisted state", async () => {
    // `recordSweepEnumeration` resets the cursor on a kind change, but `subjects_total` and
    // `empty_reason` survive until the NEW kind enumerates successfully — and a failed enumeration
    // never replaces them. Reporting those under the new kind would state a total the new corpus
    // never had, and derive a rotation warning from it.
    store.recordSweepEnumeration("bus", {
      kind: "paths",
      subjectsTotal: 400,
      emptyReason: "stale reason from the paths sweep",
    });
    store.advanceSweepCursor("bus", "paths", "paths:file:/r:a.ts");

    const switched: NimbusFleetJobToml = {
      ...sweepJob,
      sweep: { kind: "services", maxSubjects: 20, pathPrefix: null },
    };
    const r = (await dispatchFleetRpc("fleet.list", {}, ctx(2000, { jobs: [switched] }))) as {
      value: {
        jobs: Array<{
          sweep: {
            kind: string;
            subjectsTotal: unknown;
            cursor: unknown;
            emptyReason: unknown;
            rotationExceedsRetention: unknown;
          };
        }>;
      };
    };
    const sweep = r.value.jobs[0]?.sweep;
    expect(sweep?.kind).toBe("services");
    expect(sweep?.subjectsTotal).toBeNull();
    expect(sweep?.cursor).toBeNull();
    expect(sweep?.emptyReason).toBeNull();
    expect(sweep?.rotationExceedsRetention).toBeNull();
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
      sweep: null,
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

describe("handlers read the ctx at call time", () => {
  const mkJob = (name: string): NimbusFleetJobToml => ({
    name,
    agent: "catchup",
    intervalSeconds: 3600,
    params: {},
    digestMinDelta: 1,
    sweep: null,
  });

  function liveCtx(live: { config: NimbusFleetToml; jobs: readonly NimbusFleetJobToml[] }) {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(FLEET_V60_SQL);
    for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
    return {
      scheduler: undefined,
      store: new FleetStore(db),
      hostActivity: { probe: async () => ({ power: "ac", idleMs: 0, source: "measured" }) },
      get config() {
        return live.config;
      },
      get jobs() {
        return live.jobs;
      },
      now: () => 1_000_000,
    } as unknown as FleetRpcCtx;
  }

  test("fleet.list, fleet.status and fleet.digest see a swapped config and job list", async () => {
    const live = {
      config: { ...DEFAULT_FLEET_CONFIG, enabled: false } as NimbusFleetToml,
      jobs: [mkJob("old_job")] as readonly NimbusFleetJobToml[],
    };
    const c = liveCtx(live);
    const names = async () => {
      const out = await dispatchFleetRpc("fleet.list", {}, c);
      if (out.kind !== "hit") throw new Error("expected a hit");
      return (out.value as { jobs: { name: string }[] }).jobs.map((j) => j.name);
    };
    const status = async () => {
      const out = await dispatchFleetRpc("fleet.status", {}, c);
      if (out.kind !== "hit") throw new Error("expected a hit");
      return out.value as { enabled: boolean; jobsConfigured: number };
    };
    const digest = async () => {
      const out = await dispatchFleetRpc("fleet.digest", {}, c);
      if (out.kind !== "hit") throw new Error("expected a hit");
      return (out.value as { markdown: string }).markdown;
    };
    expect(await names()).toEqual(["old_job"]);
    expect(await status()).toMatchObject({ enabled: false, jobsConfigured: 1 });
    expect(await digest()).toContain("old_job");

    live.config = { ...DEFAULT_FLEET_CONFIG, enabled: true };
    live.jobs = [mkJob("new_a"), mkJob("new_b")];
    expect(await names()).toEqual(["new_a", "new_b"]);
    expect(await status()).toMatchObject({ enabled: true, jobsConfigured: 2 });
    const md = await digest();
    expect(md).toContain("new_a");
    expect(md).not.toContain("old_job");
  });

  test("runNow waits for a pending reload and runs on the scheduler that replaced the old one", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    const a: FakeScheduler = {
      runOnce: async () => {
        calls.push("A");
        return COMPLETED;
      },
    };
    const b: FakeScheduler = {
      runOnce: async () => {
        calls.push("B");
        return COMPLETED;
      },
    };
    let current: FakeScheduler = a;
    const c = {
      get scheduler() {
        return current;
      },
      settled: () => pending,
      config: DEFAULT_FLEET_CONFIG,
      hostActivity: undefined,
      now: () => 0,
    } as unknown as FleetRpcCtx;
    const run = dispatchFleetRpc("fleet.runNow", {}, c);
    await Promise.resolve();
    expect(calls).toEqual([]);
    current = b;
    release();
    await run;
    expect(calls).toEqual(["B"]);
  });

  test("runNow refuses with the retryable reloading error when a reload outlasts the wait", async () => {
    const calls: string[] = [];
    const scheduler: FakeScheduler = {
      runOnce: async () => {
        calls.push("ran");
        return COMPLETED;
      },
    };
    const c = {
      scheduler,
      settled: () => new Promise<void>(() => undefined),
      reloadWaitMs: 10,
      config: DEFAULT_FLEET_CONFIG,
      hostActivity: undefined,
      now: () => 0,
    } as unknown as FleetRpcCtx;
    try {
      await dispatchFleetRpc("fleet.runNow", {}, c);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetRpcError);
      expect((e as FleetRpcError).rpcCode).toBe(-32000);
      expect((e as FleetRpcError).message).toBe("fleet is reloading its config; try again");
    }
    expect(calls).toEqual([]);
  });

  test("runNow on a retired scheduler is a clear -32000 error", async () => {
    const scheduler: FakeScheduler = {
      runOnce: async () => {
        throw new FleetReloadingError();
      },
    };
    try {
      await dispatchFleetRpc("fleet.runNow", {}, {
        scheduler,
        config: DEFAULT_FLEET_CONFIG,
        hostActivity: undefined,
        now: () => 0,
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetRpcError);
      expect((e as FleetRpcError).rpcCode).toBe(-32000);
      expect((e as FleetRpcError).message).toBe("fleet is reloading its config; try again");
    }
  });
});

describe("fleet layers, disabled and dropped jobs", () => {
  const base = { kind: "base", id: "base", path: "/cfg/nimbus.toml" } as const;
  const pack = { kind: "pack", id: "oncall", path: "/cfg/packs/oncall.toml" } as const;
  const job: NimbusFleetJobToml = {
    name: "morning",
    agent: "catchup",
    intervalSeconds: 60,
    params: {},
    digestMinDelta: 1,
    sweep: null,
  };
  const hostActivity = { probe: async () => ({ power: "ac", idleMs: 0, source: "measured" }) };

  test("status reports disabled and dropped", async () => {
    const out = await dispatchFleetRpc("fleet.status", {}, {
      hostActivity,
      config: DEFAULT_FLEET_CONFIG,
      jobs: [job],
      disabled: [{ name: "old", agent: null, origin: { layer: base, replaces: [] } }],
      dropped: [{ name: "bad", layer: pack, reason: "agent required" }],
      now: () => 0,
    } as never);
    if (out.kind !== "hit") throw new Error("expected a hit");
    expect(out.value).toMatchObject({
      jobsConfigured: 1,
      jobsDisabled: 1,
      droppedJobs: [{ name: "bad", layer: pack, reason: "agent required" }],
    });
  });

  test("list carries each job's layer and the disabled jobs with what they disable", async () => {
    const out = await dispatchFleetRpc("fleet.list", {}, {
      hostActivity,
      config: DEFAULT_FLEET_CONFIG,
      jobs: [job],
      origins: new Map([["morning", { layer: base, replaces: [pack] }]]),
      disabled: [{ name: "noisy", agent: "janitor", origin: { layer: base, replaces: [pack] } }],
      now: () => 0,
    } as never);
    if (out.kind !== "hit") throw new Error("expected a hit");
    const v = out.value as { jobs: Array<{ layer: unknown }>; disabled: unknown };
    expect(v.jobs[0]?.layer).toEqual(base);
    expect(v.disabled).toEqual([
      { name: "noisy", agent: "janitor", layer: base, disables: [pack] },
    ]);
  });

  test("an orphan stub lists disables: []", async () => {
    const out = await dispatchFleetRpc("fleet.list", {}, {
      hostActivity,
      config: DEFAULT_FLEET_CONFIG,
      jobs: [],
      disabled: [{ name: "ghost", agent: null, origin: { layer: base, replaces: [] } }],
      now: () => 0,
    } as never);
    if (out.kind !== "hit") throw new Error("expected a hit");
    expect((out.value as { disabled: unknown }).disabled).toEqual([
      { name: "ghost", agent: null, layer: base, disables: [] },
    ]);
  });

  test("runNow on a disabled job names it", async () => {
    try {
      await dispatchFleetRpc("fleet.runNow", { job: "noisy" }, {
        hostActivity,
        config: DEFAULT_FLEET_CONFIG,
        disabled: [{ name: "noisy", agent: null, origin: { layer: base, replaces: [] } }],
        now: () => 0,
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetRpcError);
      expect((e as FleetRpcError).rpcCode).toBe(-32602);
      expect((e as FleetRpcError).message).toBe(
        'fleet: job "noisy" is disabled by enabled = false in /cfg/nimbus.toml',
      );
    }
  });

  test("runNow on a dropped job names the layer and reason, even with no scheduler", async () => {
    try {
      await dispatchFleetRpc("fleet.runNow", { job: "bad" }, {
        hostActivity,
        config: DEFAULT_FLEET_CONFIG,
        dropped: [{ name: "bad", layer: pack, reason: "agent required" }],
        now: () => 0,
      } as never);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(FleetRpcError);
      expect((e as FleetRpcError).rpcCode).toBe(-32602);
      expect((e as FleetRpcError).message).toBe(
        'fleet: job "bad" was dropped (pack:oncall): agent required',
      );
    }
  });
});
