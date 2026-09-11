import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { dbRun } from "../db/write.ts";
import type { FleetRunBudget } from "../fleet/fleet-scheduler.ts";
import { FLEET_CAPABILITY } from "../fleet/fleet-scheduler.ts";
import { FleetStore } from "../fleet/fleet-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import type { LlmRegistry } from "../llm/registry.ts";
import type { EnforcedPolicy, PolicyGate } from "../policy/policy-gate.ts";
import { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { assembleFleetRuntime, type FleetBootDeps } from "./assemble.ts";
import { processEnvDelete, processEnvSet } from "./env-access.ts";
import { UNKNOWN_HOST_ACTIVITY } from "./host-activity.ts";
import type { PlatformPaths } from "./paths.ts";

const silentLogger = pino({ level: "silent" });

const DAY_MS = 86_400_000;

function enforcedWith(over: Partial<EnforcedPolicy>): EnforcedPolicy {
  return {
    retentionDays: 90,
    retentionMinDays: 0,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    chatops: { channels: new Map(), ownership: new Map() },
    capabilitiesDisabled: new Set<string>(),
    ...over,
  };
}

/** A `PolicyGate`-shaped stub whose enforced policy the test can swap between calls. */
function stubGate(initial: EnforcedPolicy): { gate: PolicyGate; set: (e: EnforcedPolicy) => void } {
  let current = initial;
  return {
    gate: { enforced: () => current } as unknown as PolicyGate,
    set: (e) => {
      current = e;
    },
  };
}

describe("FLEET_CAPABILITY", () => {
  test("is a real AI_V2_CAPABILITIES member, not a string only this file believes in", () => {
    // A typo here would read as "never disabled" — the direction that fails OPEN, which is why the
    // constant is pinned against the frozen list rather than repeated at the enforcement site.
    expect([...AI_V2_CAPABILITIES]).toContain(FLEET_CAPABILITY);
  });
});

describe("assembleFleetRuntime", () => {
  let dir: string;
  let db: Database;
  let stops: Array<() => void>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-fleet-boot-"));
    mkdirSync(dir, { recursive: true });
    db = openMigratedMemoryDb();
    stops = [];
  });
  afterEach(() => {
    for (const s of stops) s();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(gate: PolicyGate): FleetBootDeps {
    return {
      db,
      paths: {
        configDir: dir,
        dataDir: dir,
        logDir: join(dir, "logs"),
        socketPath: join(dir, "gw.sock"),
        extensionsDir: join(dir, "ext"),
        tempDir: dir,
      } satisfies PlatformPaths,
      localIndex: {} as unknown as LocalIndex,
      llmRegistry: { llmRouter: undefined } as unknown as LlmRegistry,
      hostActivity: UNKNOWN_HOST_ACTIVITY,
      policyGate: gate,
      logger: silentLogger,
      sidecarStops: stops,
    };
  }

  function writeToml(body: string, file = "nimbus.toml"): void {
    writeFileSync(join(dir, file), body, "utf8");
  }

  test("no [fleet] block at all constructs nothing", () => {
    const { gate } = stubGate(enforcedWith({}));
    expect(assembleFleetRuntime(deps(gate)).scheduler).toBeUndefined();
  });

  test("enabled with a job starts a scheduler and registers its stop in sidecarStops", () => {
    writeToml(
      `[fleet]\nenabled = true\n\n[[fleet.job]]\nname = "nightly"\nagent = "catchup"\ninterval_seconds = 3600\n`,
    );
    const { gate } = stubGate(enforcedWith({}));
    const before = stops.length;
    const scheduler = assembleFleetRuntime(deps(gate)).scheduler;
    expect(scheduler).toBeDefined();
    expect(stops).toHaveLength(before + 1);
  });

  /**
   * I38's audit trail. `FleetSchedulerDeps`' budget dep is optional, and this call site simply did
   * not pass it — so `fleet_run.remote_calls_made` recorded `0` on every production run while the
   * column purported to count remote model calls, and `remote_call_budget` recorded a per-run cap
   * the run did not have. A persisted field that is always wrong is a false record, not a missing
   * feature, which is why this is asserted at the BOOT site rather than left to the scheduler's own
   * tests: the scheduler was already correct, and nothing reached it.
   *
   * White-box (`deps` is `private` to TypeScript only) because there is no black-box way to see an
   * optional dependency that was never supplied — a run row reading `0` is exactly what the bug
   * produced, so observing the row cannot distinguish "no calls" from "not wired".
   */
  test("the scheduler is given the live remote budget the invoker caps against", () => {
    writeToml(
      `[fleet]
enabled = true
allow_remote = true
remote_call_budget = 3

[[fleet.job]]
name = "nightly"
agent = "catchup"
interval_seconds = 3600
`,
    );
    const { gate } = stubGate(enforcedWith({}));
    const scheduler = assembleFleetRuntime(deps(gate)).scheduler;
    expect(scheduler).toBeDefined();
    const wired = (scheduler as unknown as { deps: { remoteBudget?: FleetRunBudget } }).deps
      .remoteBudget;
    expect(wired).toBeDefined();
    // A REAL budget carrying the configured cap, not a stub: `remaining()` is the effective cap and
    // `reset()` is the method that makes `remote_call_budget` a per-RUN key. Asserting the cap is
    // what distinguishes the wired budget from any object that merely has the right method names.
    expect(wired?.remaining()).toBe(3);
    expect(wired?.spent()).toBe(0);
    expect(typeof wired?.reset).toBe("function");
  });

  /**
   * The failure mode the fix could reintroduce: two budgets. The scheduler would then reset and
   * report an instance nothing ever spends against, and both columns would go back to being wrong —
   * the same false record wearing a getter. Exactly one construction in this module is what makes
   * the scheduler's run boundary and the invoker's cap the same object.
   */
  test("exactly ONE FleetRemoteBudget is constructed in assemble.ts — the run boundary and the cap are one object", async () => {
    const src = await readFile(join(import.meta.dir, "assemble.ts").replaceAll("\\", "/"), "utf8");
    const calls = src.match(/createFleetRemoteBudget\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  test("enabled but with NO job constructs nothing — an empty fleet is not a running one", () => {
    writeToml(`[fleet]\nenabled = true\n`);
    const { gate } = stubGate(enforcedWith({}));
    expect(assembleFleetRuntime(deps(gate)).scheduler).toBeUndefined();
  });

  /**
   * The parser THROWS on `allow_remote` without a budget, by design. This is the caller that has
   * to survive it: the fleet is optional and default-off, the index is not, and taking gateway
   * boot down over a malformed optional block would be wildly disproportionate.
   */
  test("a malformed [fleet] block disables the fleet WITHOUT throwing", () => {
    writeToml(`[fleet]\nenabled = true\nallow_remote = true\nremote_call_budget = 0\n`);
    const { gate } = stubGate(enforcedWith({}));
    let scheduler: unknown = "unset";
    expect(() => {
      scheduler = assembleFleetRuntime(deps(gate)).scheduler;
    }).not.toThrow();
    expect(scheduler).toBeUndefined();
  });

  /**
   * Retention must not hinge on whether today's config parses. Old rows exist either way, and a
   * machine that keeps every fleet brief forever because of one bad TOML line is a data-retention
   * failure caused by a typo.
   */
  test("a malformed [fleet] block still prunes, using the DEFAULT window", () => {
    writeToml(`[fleet]\nenabled = true\nallow_remote = true\nremote_call_budget = 0\n`);
    const store = new FleetStore(db);
    // DEFAULT_FLEET_CONFIG.retentionDays is 14: 20 days old goes, 3 days old stays.
    for (const ageDays of [20, 3]) {
      store.openRun({
        startedAt: Date.now() - ageDays * DAY_MS,
        hostPower: "unknown",
        hostIdleMs: null,
        hostSource: "power_only",
        remoteCallBudget: 0,
      });
    }
    const { gate } = stubGate(enforcedWith({}));
    expect(assembleFleetRuntime(deps(gate)).scheduler).toBeUndefined();
    expect((db.query("SELECT COUNT(*) AS c FROM fleet_run").get() as { c: number }).c).toBe(1);
  });

  test("the PROFILE toml is what is read, not a hardcoded nimbus.toml", () => {
    // The base file says disabled; the active profile's file enables it. A profile-blind loader
    // would return `undefined` here — the exact bug `loadNimbusAgentsFromPath` was born from.
    writeToml(`[fleet]\nenabled = false\n`);
    writeToml(
      `[fleet]\nenabled = true\n\n[[fleet.job]]\nname = "n"\nagent = "catchup"\ninterval_seconds = 60\n`,
      "nimbus.work.toml",
    );
    processEnvSet("NIMBUS_PROFILE", "work");
    try {
      const { gate } = stubGate(enforcedWith({}));
      expect(assembleFleetRuntime(deps(gate)).scheduler).toBeDefined();
    } finally {
      processEnvDelete("NIMBUS_PROFILE");
    }
  });

  describe("retention", () => {
    /** Opens a run that started `ageDays` ago and returns its id. */
    function seedRun(ageDays: number): string {
      const store = new FleetStore(db);
      const id = store.openRun({
        startedAt: Date.now() - ageDays * DAY_MS,
        hostPower: "unknown",
        hostIdleMs: null,
        hostSource: "power_only",
        remoteCallBudget: 0,
      });
      return id;
    }
    const runCount = (): number =>
      (db.query("SELECT COUNT(*) AS c FROM fleet_run").get() as { c: number }).c;

    test("prunes runs older than the LOCAL window when no org floor applies", () => {
      writeToml(`[fleet]\nretention_days = 7\n`);
      seedRun(10);
      seedRun(1);
      const { gate } = stubGate(enforcedWith({}));
      assembleFleetRuntime(deps(gate));
      expect(runCount()).toBe(1);
    });

    test("an org floor of 30 KEEPS a 10-day-old run that retention_days = 7 would have deleted", () => {
      writeToml(`[fleet]\nretention_days = 7\n`);
      seedRun(10);
      const { gate } = stubGate(enforcedWith({ retentionMinDays: 30 }));
      assembleFleetRuntime(deps(gate));
      expect(runCount()).toBe(1);
    });

    /**
     * The floor is applied to `config.retentionDays` BEFORE the scheduler sees it, so it governs
     * the `expires_at` each brief is stamped with as well as the boot prune. Flooring only the
     * prune would leave an org-mandated 30-day brief marked to expire in 7 and deleted by the very
     * next `pruneBriefs` — a floor that quietly does not hold.
     */
    test("the floor reaches the scheduler's config, not just the prune", () => {
      writeToml(
        `[fleet]\nenabled = true\nretention_days = 7\n\n[[fleet.job]]\nname = "n"\nagent = "catchup"\ninterval_seconds = 60\n`,
      );
      const { gate } = stubGate(enforcedWith({ retentionMinDays: 30 }));
      const scheduler = assembleFleetRuntime(deps(gate)).scheduler;
      expect(scheduler).toBeDefined();
      // Reads the config the scheduler actually holds, rather than re-deriving the number here.
      const held = (scheduler as unknown as { deps: { config: { retentionDays: number } } }).deps;
      expect(held.config.retentionDays).toBe(30);
    });

    test("the local window WINS when it is longer — the floor raises, it never caps", () => {
      writeToml(`[fleet]\nretention_days = 60\n`);
      seedRun(30);
      const { gate } = stubGate(enforcedWith({ retentionMinDays: 7 }));
      assembleFleetRuntime(deps(gate));
      expect(runCount()).toBe(1);
    });

    test("expired briefs are pruned by their own expires_at, and a live run's are kept", () => {
      const runId = seedRun(0);
      dbRun(
        db,
        `INSERT INTO fleet_brief (id, run_id, job_id, agent_method, brief_markdown, findings_json,
           synthesis_json, created_at, expires_at)
         VALUES ('b-old', ?, 'j', 'agents.catchup', NULL, '{}', NULL, ?, ?)`,
        [runId, Date.now() - 1000, Date.now() - 1],
      );
      dbRun(
        db,
        `INSERT INTO fleet_brief (id, run_id, job_id, agent_method, brief_markdown, findings_json,
           synthesis_json, created_at, expires_at)
         VALUES ('b-live', ?, 'j', 'agents.catchup', NULL, '{}', NULL, ?, ?)`,
        [runId, Date.now(), Date.now() + 10 * DAY_MS],
      );
      const { gate } = stubGate(enforcedWith({}));
      assembleFleetRuntime(deps(gate));
      const ids = db.query("SELECT id FROM fleet_brief ORDER BY id").all() as { id: string }[];
      expect(ids.map((r) => r.id)).toEqual(["b-live"]);
    });

    test("pruning happens even when the fleet is now DISABLED — old rows still age out", () => {
      writeToml(`[fleet]\nenabled = false\nretention_days = 7\n`);
      seedRun(10);
      const { gate } = stubGate(enforcedWith({}));
      expect(assembleFleetRuntime(deps(gate)).scheduler).toBeUndefined();
      expect(runCount()).toBe(0);
    });
  });

  /**
   * `capabilityDisabled` is read on EVERY tick, so it must reflect a policy installed AFTER boot.
   * A boolean snapshotted at construction would leave a fleet running all night under a lockoff
   * the org had already distributed.
   */
  test("the agent_fleet lockoff is read LIVE, not snapshotted at boot", () => {
    writeToml(
      `[fleet]\nenabled = true\n\n[[fleet.job]]\nname = "n"\nagent = "catchup"\ninterval_seconds = 60\n`,
    );
    const { gate, set } = stubGate(enforcedWith({}));
    const scheduler = assembleFleetRuntime(deps(gate)).scheduler;
    const held = (scheduler as unknown as { deps: { capabilityDisabled: boolean } }).deps;
    expect(held.capabilityDisabled).toBe(false);

    set(enforcedWith({ capabilitiesDisabled: new Set([FLEET_CAPABILITY]) }));
    expect(held.capabilityDisabled).toBe(true);
  });

  test("a DIFFERENT disabled capability does not disable the fleet", () => {
    writeToml(
      `[fleet]\nenabled = true\n\n[[fleet.job]]\nname = "n"\nagent = "catchup"\ninterval_seconds = 60\n`,
    );
    const { gate } = stubGate(
      enforcedWith({ capabilitiesDisabled: new Set(["code_execution", "computer_use"]) }),
    );
    const scheduler = assembleFleetRuntime(deps(gate)).scheduler;
    const held = (scheduler as unknown as { deps: { capabilityDisabled: boolean } }).deps;
    expect(held.capabilityDisabled).toBe(false);
  });
});
