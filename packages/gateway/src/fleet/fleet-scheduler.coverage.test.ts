import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { DEFAULT_FLEET_CONFIG } from "../config/fleet-toml.ts";
import { FLEET_SUBJECTS_V63_SQL } from "../index/fleet-subjects-v63-sql.ts";
import { FLEET_V60_SQL } from "../index/fleet-v60-sql.ts";
import type { HostActivityProbe } from "../platform/host-activity.ts";
import type { FleetInvoker, FleetJobOutcome } from "./fleet-invoker.ts";
import { FleetScheduler } from "./fleet-scheduler.ts";
import { FleetStore } from "./fleet-store.ts";
import type { FleetSweepEnumerate } from "./fleet-sweep-enumerators.ts";
import { createFleetRemoteBudget } from "./fleet-synthesis-router.ts";

/**
 * The two sweep-enumeration failures `fleet-scheduler.test.ts` does not reach: a sweep job whose
 * agent cannot sweep the configured kind (a config that bypassed `validateFleetSweepJobs`), and an
 * enumerator that throws something other than an `Error`. Both must fail ONLY that job — recorded
 * with its reason, backed off — while the rest of the run proceeds.
 */

const AC_IDLE: HostActivityProbe = { power: "ac", idleMs: 3_600_000, source: "measured" };
const NOW = 2_000_000;

const PLAIN: NimbusFleetJobToml = {
  name: "plain",
  agent: "catchup",
  intervalSeconds: 1,
  params: {},
  digestMinDelta: 1,
  sweep: null,
};

let db: Database;
let store: FleetStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.exec(FLEET_V60_SQL);
  for (const stmt of FLEET_SUBJECTS_V63_SQL) db.exec(stmt);
  store = new FleetStore(db);
});

afterEach(() => {
  db.close();
});

function done(name: string): FleetJobOutcome {
  return {
    status: "done",
    briefMarkdown: `# ${name}`,
    findingsJson: JSON.stringify({ job: name }),
    synthesisJson: null,
  };
}

function build(jobs: readonly NimbusFleetJobToml[], enumerate: FleetSweepEnumerate) {
  const invoked: string[] = [];
  const invoke: FleetInvoker = async (job) => {
    invoked.push(job.name);
    return done(job.name);
  };
  const config = { ...DEFAULT_FLEET_CONFIG, enabled: true };
  const scheduler = new FleetScheduler({
    store,
    jobs,
    config,
    capabilityDisabled: false,
    hostActivity: { probe: async () => AC_IDLE },
    invoke,
    now: () => NOW,
    remoteBudget: createFleetRemoteBudget(config.allowRemote, config.remoteCallBudget),
    enumerate,
  });
  return { scheduler, invoked };
}

describe("FleetScheduler — sweep enumeration failures fail one job, not the run", () => {
  test("an agent that cannot sweep its kind is recorded as that job's failure and never enumerated", async () => {
    const unsweepable: NimbusFleetJobToml = {
      name: "tidy",
      agent: "janitor",
      intervalSeconds: 1,
      params: {},
      digestMinDelta: 1,
      sweep: { kind: "paths", maxSubjects: 2, pathPrefix: null },
    };
    let enumerations = 0;
    const { scheduler, invoked } = build([unsweepable, PLAIN], () => {
      enumerations += 1;
      return { subjects: [], emptyReason: null };
    });

    const summary = await scheduler.runOnce();

    expect(enumerations).toBe(0);
    expect(invoked).toEqual(["plain"]);
    expect(summary).toMatchObject({
      outcome: "completed",
      jobsAttempted: 2,
      jobsCompleted: 1,
      subjectsInScope: 1,
      subjectsCompleted: 1,
    });
    const state = store.loadJobState("tidy");
    expect(state?.lastError).toBe("agent janitor cannot sweep paths");
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.backoffUntil ?? 0).toBeGreaterThan(NOW);
    expect(state?.lastSuccessAt ?? null).toBeNull();
    // A refused sweep never reached enumeration, so no enumeration was recorded for it.
    const sweepState = store.loadSweepState("tidy");
    expect(sweepState?.kind ?? null).toBeNull();
    expect(sweepState?.subjectsTotal ?? null).toBeNull();
  });

  test("an enumerator that throws a non-Error records its String() form", async () => {
    const sweep: NimbusFleetJobToml = {
      name: "owners",
      agent: "ownership",
      intervalSeconds: 1,
      params: {},
      digestMinDelta: 1,
      sweep: { kind: "paths", maxSubjects: 2, pathPrefix: null },
    };
    const { scheduler, invoked } = build([sweep, PLAIN], () => {
      throw "index locked";
    });

    const summary = await scheduler.runOnce();

    expect(invoked).toEqual(["plain"]);
    expect(summary.outcome).toBe("completed");
    expect(store.loadJobState("owners")?.lastError).toBe("sweep enumeration failed: index locked");
    expect(store.loadJobState("owners")?.consecutiveFailures).toBe(1);
    expect(store.loadJobState("owners")?.backoffUntil ?? 0).toBeGreaterThan(NOW);
  });
});
