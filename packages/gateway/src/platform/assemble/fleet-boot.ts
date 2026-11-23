import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import {
  DEFAULT_FLEET_CONFIG,
  type FleetDisabledJob,
  type FleetDroppedJob,
  type FleetJobOrigin,
  loadNimbusFleetFromConfigDir,
  type NimbusFleetJobToml,
  type NimbusFleetLoad,
  type NimbusFleetToml,
} from "../../config/fleet-toml.ts";
import { getLayeredConfig } from "../../config/layered-config.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../../config/nimbus-toml.ts";
import { effectiveRetentionDays } from "../../db/tool-call-log-retention.ts";
import { buildFleetInvoker } from "../../fleet/fleet-invoker.ts";
import { checkFleetJob } from "../../fleet/fleet-job-check.ts";
import { FLEET_CAPABILITY, FleetScheduler } from "../../fleet/fleet-scheduler.ts";
import { FleetStore } from "../../fleet/fleet-store.ts";
import { type FleetLoad, FleetSupervisor } from "../../fleet/fleet-supervisor.ts";
import { buildFleetSweepEnumerate } from "../../fleet/fleet-sweep-enumerators.ts";
import { createFleetRemoteBudget } from "../../fleet/fleet-synthesis-router.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { FleetRpcCtx } from "../../ipc/fleet-rpc.ts";
import type { LlmRegistry } from "../../llm/registry.ts";
import { ownershipRoots } from "../../ownership/ownership-target.ts";
import type { PolicyGate } from "../../policy/policy-gate.ts";
import { sourceMappingFor } from "../../sources/source-mapping.ts";
import type { HostActivity } from "../host-activity.ts";
import type { PlatformPaths } from "../paths.ts";

export interface FleetBootDeps {
  readonly db: Database;
  readonly paths: PlatformPaths;
  readonly localIndex: LocalIndex;
  readonly llmRegistry: LlmRegistry;
  readonly hostActivity: HostActivity;
  readonly policyGate: PolicyGate;
  readonly logger: Logger;
  readonly sidecarStops: Array<() => void>;
  /** Test seam only: the supervisor's reload-check interval (production: `FLEET_RELOAD_CHECK_MS`). */
  readonly checkMs?: number;
}

/**
 * Reads `[fleet]` off the layered config (base file plus the active profile's, plus pack layers),
 * prunes expired runs and briefs, and hands the result to a `FleetSupervisor`, which starts the
 * scheduler when — and only when — the owner both enabled the fleet and configured a job, and
 * rebuilds it when the effective `[fleet]` section changes. Returns the full result of assembling
 * the fleet subsystem, not just the (optionally-undefined) scheduler — the `fleet.*` IPC surface
 * needs the store, the effective config and the job list even when the scheduler itself is
 * `undefined` (disabled by config/policy or unconfigured), so `fleet.status`/`fleet.list` can report
 * the truth without a live scheduler to ask. `scheduler`/`config`/`jobs` are GETTERS over the
 * supervisor's current view, so they follow a reload; `store` is fixed for the process.
 *
 * Four things here are load-bearing enough to say out loud:
 *
 * 1. `loadNimbusFleetFromConfigDir(paths.configDir)`, the layered reader, never a hardcoded
 *    `nimbus.toml`: a `[fleet]` set in the active profile file (or a pack) must be honoured, the
 *    way `[agents] synthesis` set in a profile file is.
 * 2. A malformed `[fleet]` TABLE must NOT take the gateway down. The parser throws by design (an
 *    `allow_remote` with no budget is a permission the owner clearly meant to bound), and
 *    `loadFleet` is the caller that catches it: log loudly, name the file, construct no scheduler.
 *    A bad JOB (an ineligible agent, a sweep the agent cannot do, a missing key) drops only that
 *    job: the loader returns it in `dropped`, `checkFleetJob` supplies the semantic half of the
 *    check, and the supervisor logs each drop at error with its layer and file.
 *    The fleet is an optional default-off feature; the index is not. Note that the boot PRUNE still
 *    runs on that path — old rows exist whether or not today's config parses, and retention must not
 *    hinge on a typo. `buildFleetScheduler` likewise catches a throw from construction, because the
 *    supervisor's constructor calls it unguarded at boot.
 * 3. Retention is a policy FLOOR, applied to `config.retentionDays` BEFORE the scheduler sees it —
 *    not only to the boot prune below, and on every reload too. The scheduler stamps each brief's
 *    `expires_at` from that same field, so flooring only the prune would leave an org-mandated
 *    30-day brief marked to expire in 7 and deleted by the next `pruneBriefs`. `retentionMinDays`
 *    is the ORG floor alone, deliberately not `retentionDays` (which is that floor already merged
 *    with the audit log's own local window, 90 days by default).
 * 4. Called exactly ONCE per boot, from `assemblePlatformServices` below, which derives
 *    `ipcOpts.fleetRpcCtx` from that single call. The SUPERVISOR holds the live scheduler from then
 *    on; nothing may keep a boot-time copy of it, since that copy goes stale at the first reload. A
 *    second call with the same deps would double-prune and, worse, construct a SECOND supervisor and
 *    a second live scheduler ticking against the same store. `assemble-fleet.test.ts` calls this
 *    directly and reads `.scheduler` off the result, which is what production actually runs, not a
 *    parallel path.
 */
export interface FleetRuntime {
  readonly supervisor: FleetSupervisor;
  readonly store: FleetStore;
  /** The supervisor's current scheduler; changes on a reload. */
  readonly scheduler: FleetScheduler | undefined;
  readonly config: NimbusFleetToml;
  readonly jobs: readonly NimbusFleetJobToml[];
  readonly origins: ReadonlyMap<string, FleetJobOrigin>;
  readonly disabled: readonly FleetDisabledJob[];
  readonly dropped: readonly FleetDroppedJob[];
}

/** The effective `[fleet]` section, retention floored by policy. Never throws: an error is logged. */
function loadFleet(deps: FleetBootDeps): FleetLoad {
  const fleetConfigDir = deps.paths.configDir;
  let fleet: NimbusFleetLoad = {
    config: DEFAULT_FLEET_CONFIG,
    jobs: [],
    origins: new Map(),
    disabled: [],
    dropped: [],
  };
  let configError = false;
  try {
    fleet = loadNimbusFleetFromConfigDir(fleetConfigDir, checkFleetJob);
  } catch (err) {
    configError = true;
    const layered = getLayeredConfig(fleetConfigDir);
    const files = layered
      .snapshot()
      .layers.filter((l) => l.exists)
      .map((l) => l.layer.path);
    deps.logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        configDir: fleetConfigDir,
        profile: layered.profile.name,
        files,
      },
      `[fleet] config error (profile "${layered.profile.name}"; files: ${files.join(", ") || "none"}) — fleet disabled until the config is fixed`,
    );
  }

  const config: NimbusFleetToml = {
    ...fleet.config,
    retentionDays: effectiveRetentionDays(
      fleet.config.retentionDays,
      deps.policyGate.enforced().retentionMinDays,
    ),
  };
  return {
    config,
    jobs: fleet.jobs,
    origins: fleet.origins,
    disabled: fleet.disabled,
    dropped: fleet.dropped,
    configError,
  };
}

/**
 * One scheduler generation, NOT started (the supervisor starts and stops it). Undefined when the
 * fleet should not run. Never throws: the supervisor's constructor calls this unguarded at boot,
 * and boot must not fail because of the fleet.
 */
function buildFleetScheduler(
  deps: FleetBootDeps,
  store: FleetStore,
  load: FleetLoad,
): FleetScheduler | undefined {
  const { config, jobs, configError } = load;
  if (configError || !config.enabled || jobs.length === 0) return undefined;
  try {
    // ONE budget per scheduler GENERATION, named so the scheduler's counter and the invoker's cap
    // are the SAME object (I38). Constructing it inline in `invoke:` (as this once did) left
    // `remoteCallsMade` with nothing to read, so `fleet_run.remote_calls_made` recorded 0 on every
    // run — a column that purports to count remote model calls and always said none were made. Two
    // instances would be the same bug wearing a getter: the scheduler would report a budget nothing
    // ever spends against. A reload builds a new generation, and with it a new budget.
    const remoteBudget = createFleetRemoteBudget(config.allowRemote, config.remoteCallBudget);

    return new FleetScheduler({
      store,
      jobs,
      config,
      // A GETTER, not a snapshot: `runOnce` reads this on every 60-second tick, and the gateway can
      // receive a signed policy AFTER boot (`policyGate.applyVerified`). A boolean captured here
      // would leave a fleet running all night under a lockoff the org had already installed — the
      // same reason the exec and computer-use deps below read `policyGate.enforced()` lazily.
      get capabilityDisabled(): boolean {
        return deps.policyGate.enforced().capabilitiesDisabled.has(FLEET_CAPABILITY);
      },
      hostActivity: deps.hostActivity,
      // The SAME instance, narrowed to `FleetRunBudget` by the dep's type: the scheduler resets it
      // at each run boundary (which is what makes `remote_call_budget` the PER-RUN key it is
      // documented to be) and reads what the run had and spent, while `consume` stays the invoker's.
      remoteBudget,
      invoke: buildFleetInvoker({
        db: deps.db,
        router: deps.llmRegistry.llmRouter,
        budget: remoteBudget,
        index: deps.localIndex,
        configDir: deps.paths.configDir,
      }),
      now: () => Date.now(),
      // Roots and services are read FRESH per enumeration. Services use the loader agents resolve
      // `service` against — deliberately NOT `loadServiceConfigsOrDegrade`: degrading to an empty
      // map would report "no services are configured" for a config that is merely malformed, where
      // a throw records the real cause on the job and backs it off.
      enumerate: buildFleetSweepEnumerate({
        db: deps.db,
        roots: () => ownershipRoots(deps.paths.configDir),
        serviceIds: () => [...loadNimbusServiceConfigsFromConfigDir(deps.paths.configDir).keys()],
        mapping: () => sourceMappingFor(deps.paths.configDir),
      }),
    });
  } catch (err) {
    deps.logger.error({ err }, "[fleet] building the scheduler failed; the fleet is off");
    return undefined;
  }
}

export function assembleFleetRuntime(deps: FleetBootDeps): FleetRuntime {
  const snapshotVersion = (): number => getLayeredConfig(deps.paths.configDir).snapshot().version;
  // Version FIRST, then the load: an edit landing between the two bumps the version past the one
  // recorded here, so the supervisor's first check reloads rather than missing it.
  const bootVersion = snapshotVersion();
  const bootLoad = loadFleet(deps);

  // Prune UNCONDITIONALLY — when the fleet is disabled, and when its config did not even parse.
  // Rows written while it WAS enabled exist either way, and retention must not depend on whether
  // the owner currently has a typo in their TOML: the alternative is a machine that silently keeps
  // every fleet brief forever because of one bad line. On the unparsed path the window is
  // `DEFAULT_FLEET_CONFIG.retentionDays` floored by policy, which is the only defensible answer
  // when the configured one is unreadable. Boot only: a reload does not prune.
  //
  // `pruneRuns` FIRST: the FK cascade takes each run's briefs with it, which is what stops
  // `fleet_run` growing a row per 60-second tick forever. `pruneBriefs` then catches any brief
  // whose own `expires_at` is earlier than its run's age.
  const store = new FleetStore(deps.db);
  store.pruneRuns(Date.now() - bootLoad.config.retentionDays * 86_400_000);
  store.pruneBriefs(Date.now());

  const supervisor = new FleetSupervisor(
    {
      version: snapshotVersion,
      load: () => loadFleet(deps),
      build: (load) => buildFleetScheduler(deps, store, load),
      logger: deps.logger,
      ...(deps.checkMs !== undefined ? { checkMs: deps.checkMs } : {}),
    },
    { version: bootVersion, load: bootLoad },
  );
  supervisor.start();
  // Without this the reload interval and the current scheduler's 60 s tick outlive
  // `disposeSidecars()`. `.unref()` keeps them from holding the process open but does not stop
  // them firing during a shutdown that is still draining.
  deps.sidecarStops.push(() => supervisor.stop());
  return {
    supervisor,
    store,
    get scheduler(): FleetScheduler | undefined {
      return supervisor.current().scheduler;
    },
    get config(): NimbusFleetToml {
      return supervisor.current().config;
    },
    get jobs(): readonly NimbusFleetJobToml[] {
      return supervisor.current().jobs;
    },
    get origins(): ReadonlyMap<string, FleetJobOrigin> {
      return supervisor.current().origins;
    },
    get disabled(): readonly FleetDisabledJob[] {
      return supervisor.current().disabled;
    },
    get dropped(): readonly FleetDroppedJob[] {
      return supervisor.current().dropped;
    },
  };
}

/**
 * The `fleet.*` IPC context over a live fleet runtime. `scheduler`/`config`/`jobs` are GETTERS over
 * the supervisor's current view, so a handler reads the fleet as it is now, not as it was at boot.
 * `settled` runs a reload check rather than only awaiting one in progress: `check()` joins a
 * pending reload, picks up an edit the timer has not polled yet, and never rejects, so
 * `fleet.runNow` straight after a config edit runs against that edit.
 */
export function fleetRpcCtxFor(runtime: FleetRuntime, hostActivity: HostActivity): FleetRpcCtx {
  return {
    get scheduler(): FleetScheduler | undefined {
      return runtime.scheduler;
    },
    store: runtime.store,
    hostActivity,
    get config(): NimbusFleetToml {
      return runtime.config;
    },
    get jobs(): readonly NimbusFleetJobToml[] {
      return runtime.jobs;
    },
    get origins(): ReadonlyMap<string, FleetJobOrigin> {
      return runtime.origins;
    },
    get disabled(): readonly FleetDisabledJob[] {
      return runtime.disabled;
    },
    get dropped(): readonly FleetDroppedJob[] {
      return runtime.dropped;
    },
    now: () => Date.now(),
    settled: () => runtime.supervisor.check().then(() => undefined),
  };
}
