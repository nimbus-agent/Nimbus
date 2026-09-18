import type { NimbusFleetJobToml, NimbusFleetToml, SweepKind } from "../config/fleet-toml.ts";
import { asRecord } from "../connectors/unknown-record.ts";
import { buildFleetDigest } from "../fleet/fleet-digest.ts";
import type { FleetDigestResult } from "../fleet/fleet-digest-types.ts";
import {
  FleetDisabledError,
  FleetJobNotFoundError,
  type FleetRunSummary,
  type FleetScheduler,
} from "../fleet/fleet-scheduler.ts";
import type { FleetBriefRow, FleetJobState, FleetStore } from "../fleet/fleet-store.ts";
import type { HostActivity, HostActivityProbe } from "../platform/host-activity.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

export class FleetRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "FleetRpcError";
    this.rpcCode = rpcCode;
  }
}

/**
 * The dependency seam behind the `fleet.*` IPC namespace.
 *
 * `scheduler`/`store`/`jobs` are each independently optional so `fleet.status` can report the
 * truth (config + a live host probe) even when the fleet was never constructed at all — disabled
 * by `[fleet] enabled`, by org policy, or simply unconfigured (no `[[fleet.job]]` blocks). In
 * production (`platform/assemble.ts`) `store` and `jobs` are always present — pruning and
 * reporting must not hinge on whether the scheduler happens to be running right now — only
 * `scheduler` is genuinely absent when the fleet is off. The optional typing here is what lets a
 * unit test exercise `fleet.status` with none of them wired, matching how `fleet.status` is
 * documented to behave: "reports the live probe and config without running anything".
 */
export interface FleetRpcCtx {
  readonly scheduler?: FleetScheduler | undefined;
  readonly store?: FleetStore | undefined;
  readonly hostActivity: HostActivity;
  readonly config: NimbusFleetToml;
  readonly jobs?: readonly NimbusFleetJobToml[] | undefined;
  readonly now: () => number;
}

function optInt(params: unknown, key: string): number | undefined {
  const rec = asRecord(params);
  if (rec === undefined || !(key in rec)) return undefined;
  const v = rec[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new FleetRpcError(-32602, `fleet: ${key} must be a non-negative integer`);
  }
  return v;
}

function optString(params: unknown, key: string): string | undefined {
  const rec = asRecord(params);
  if (rec === undefined || !(key in rec)) return undefined;
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new FleetRpcError(-32602, `fleet: ${key} must be a non-empty string`);
  }
  return v;
}

function reqString(params: unknown, key: string): string {
  const v = optString(params, key);
  if (v === undefined) {
    throw new FleetRpcError(-32602, `fleet: ${key} (non-empty string) required`);
  }
  return v;
}

function requireStore(ctx: FleetRpcCtx): FleetStore {
  if (ctx.store === undefined) {
    throw new FleetRpcError(-32000, "fleet: store not available");
  }
  return ctx.store;
}

const DEFAULT_BRIEFS_LIMIT = 20;
/**
 * Upper bound on `fleet.briefs`' `limit`, enforced HERE — the IPC boundary, not the CLI. The CLI
 * already rejects `--limit 0`, but the CLI is not the trust boundary: any other caller (a future
 * HTTP surface, a test, a hand-typed `nimbus query`-style raw RPC) reaches this handler directly,
 * and `brief_markdown` can be tens of KB per row, so an unbounded limit is an unbounded response
 * size from a single request.
 */
export const MAX_BRIEFS_LIMIT = 500;

/**
 * `limit` must be a positive integer, never `0` or negative (a caller-supplied `0` would otherwise
 * reach SQLite's `LIMIT 0` and silently return an empty result instead of erroring or defaulting —
 * indistinguishable from "no briefs exist"), and capped at `MAX_BRIEFS_LIMIT` regardless of what a
 * caller asks for, rather than trusting an arbitrarily large value through to the query.
 */
function optLimit(params: unknown, key: string): number | undefined {
  const v = optInt(params, key);
  if (v === undefined) return undefined;
  if (v === 0) {
    throw new FleetRpcError(-32602, `fleet: ${key} must be a positive integer`);
  }
  return Math.min(v, MAX_BRIEFS_LIMIT);
}

export interface FleetStatusResult {
  readonly enabled: boolean;
  /** Whether a live `FleetScheduler` is actually ticking — distinct from `enabled`: a config with
   * `[fleet] enabled = true` but no `[[fleet.job]]` blocks is enabled and not running. */
  readonly running: boolean;
  readonly allowRemote: boolean;
  readonly remoteCallBudget: number;
  readonly minIdleSeconds: number;
  readonly requireAcPower: boolean;
  readonly retentionDays: number;
  readonly jobsConfigured: number;
  readonly probe: HostActivityProbe;
}

/**
 * Reports config + a live host probe. Never touches the STORE, and reads the scheduler only for
 * its PRESENCE (`running`) — it never calls into it. That is what lets this answer truthfully when
 * no scheduler was constructed at all: disabled by config, disabled by org policy, or simply no
 * `[[fleet.job]]` blocks. `enabled` and `running` are separate fields for the same reason —
 * enabled-with-no-jobs is a real state and must not read as "off".
 */
async function handleStatus(_params: unknown, ctx: FleetRpcCtx): Promise<FleetStatusResult> {
  const probe = await ctx.hostActivity.probe();
  return {
    enabled: ctx.config.enabled,
    running: ctx.scheduler !== undefined,
    allowRemote: ctx.config.allowRemote,
    remoteCallBudget: ctx.config.remoteCallBudget,
    minIdleSeconds: ctx.config.minIdleSeconds,
    requireAcPower: ctx.config.requireAcPower,
    retentionDays: ctx.config.retentionDays,
    jobsConfigured: ctx.jobs?.length ?? 0,
    probe,
  };
}

export interface FleetJobSweepListEntry {
  readonly kind: SweepKind;
  readonly maxSubjects: number;
  readonly pathPrefix: string | null;
  /** From the last enumeration; null before the first. */
  readonly subjectsTotal: number | null;
  readonly cursor: string | null;
  readonly emptyReason: string | null;
  /**
   * Whether one full rotation (ceil(total / max) × interval) outlasts `[fleet] retention_days`, in
   * which case a subject's predecessor expires before it is revisited and the digest can never
   * report movement for this sweep (spec § 10). Null before the first enumeration.
   */
  readonly rotationExceedsRetention: boolean | null;
}

export interface FleetJobListEntry {
  readonly name: string;
  readonly agent: string;
  readonly intervalSeconds: number;
  /** `null` when the job has never run (no `fleet_job_state` row yet) or the store is unavailable. */
  readonly state: FleetJobState | null;
  /** `null` for a config-named job (`sweep` unset in `[[fleet.job]]`); otherwise its sweep config plus the last enumeration's state. */
  readonly sweep: FleetJobSweepListEntry | null;
}

/**
 * Lists every CONFIGURED job (from `[[fleet.job]]`), not just ones that have already run. Sweep
 * PROGRESS lives here rather than on `fleet.status`, which never reads the store.
 */
function handleList(_params: unknown, ctx: FleetRpcCtx): { jobs: readonly FleetJobListEntry[] } {
  const jobs = ctx.jobs ?? [];
  return {
    jobs: jobs.map((j) => {
      const stored = j.sweep === null ? undefined : ctx.store?.loadSweepState(j.name);
      // Only state belonging to the CONFIGURED kind is reported. `recordSweepEnumeration` resets the
      // cursor when the kind changes, but the row keeps the previous kind's `subjects_total` and
      // `empty_reason` until the next SUCCESSFUL enumeration — and a failed one never replaces them.
      // Surfacing those under the new kind would report a total the new corpus never had, and
      // `rotationExceedsRetention` computed from it would be a warning about a rotation that does
      // not exist. Absent is the honest answer until the new kind has actually enumerated.
      const state = stored?.kind === j.sweep?.kind ? stored : undefined;
      const total = state?.subjectsTotal ?? null;
      return {
        name: j.name,
        agent: j.agent,
        intervalSeconds: j.intervalSeconds,
        state: ctx.store?.loadJobState(j.name) ?? null,
        sweep:
          j.sweep === null
            ? null
            : {
                kind: j.sweep.kind,
                maxSubjects: j.sweep.maxSubjects,
                pathPrefix: j.sweep.pathPrefix,
                subjectsTotal: total,
                cursor: state?.cursor ?? null,
                emptyReason: state?.emptyReason ?? null,
                rotationExceedsRetention:
                  total === null
                    ? null
                    : Math.ceil(total / j.sweep.maxSubjects) * j.intervalSeconds * 1000 >
                      ctx.config.retentionDays * 86_400_000,
              },
      };
    }),
  };
}

function handleBriefs(params: unknown, ctx: FleetRpcCtx): { briefs: readonly FleetBriefRow[] } {
  const store = requireStore(ctx);
  const limit = optLimit(params, "limit") ?? DEFAULT_BRIEFS_LIMIT;
  const jobId = optString(params, "jobId");
  const subjectKey = optString(params, "subjectKey");
  return {
    briefs: store.listBriefs({
      limit,
      now: ctx.now(),
      ...(jobId === undefined ? {} : { jobId }),
      ...(subjectKey === undefined ? {} : { subjectKey }),
    }),
  };
}

/**
 * `brief: null` (never a thrown error) when the id does not resolve to a live brief — whether
 * because it never existed or because it has since expired. The caller cannot tell the two apart
 * from this response, which is deliberate: a distinguishable "it expired" answer would itself be a
 * retention disclosure the store's read-path filtering (`FleetStore.listBriefs`/`getBrief`) exists
 * to avoid.
 */
function handleShow(params: unknown, ctx: FleetRpcCtx): { brief: FleetBriefRow | null } {
  const store = requireStore(ctx);
  const id = reqString(params, "id");
  return { brief: store.getBrief(id, ctx.now()) ?? null };
}

/**
 * `jobName` is threaded straight from `params.job` — never dropped. Without it, `{}` would mean
 * "every configured job", so a mistyped job name would silently run the whole fleet rather than
 * erroring via `FleetJobNotFoundError`.
 */
async function handleRunNow(params: unknown, ctx: FleetRpcCtx): Promise<FleetRunSummary> {
  if (ctx.scheduler === undefined) {
    throw new FleetRpcError(
      -32000,
      "fleet: not running (disabled by config or policy, or no jobs configured)",
    );
  }
  const job = optString(params, "job");
  const force = asRecord(params)?.["force"] === true;
  try {
    return await ctx.scheduler.runOnce({ jobName: job, force });
  } catch (e) {
    if (e instanceof FleetDisabledError) throw new FleetRpcError(-32000, e.message);
    if (e instanceof FleetJobNotFoundError) throw new FleetRpcError(-32602, e.message);
    throw e;
  }
}

const DEFAULT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `windowMs` defaults to 24h when omitted, but a caller-supplied `0` is refused rather than
 * defaulted or accepted: `optInt` rejects negatives but ACCEPTS `0`, and `?? DEFAULT` does not
 * catch a zero because zero is not `undefined`. A `windowMs` of `0` would set the window start to
 * `now` and silently return an empty digest — there is no reading of it that means what the
 * caller intended, the same reason `digest_min_delta = 0` is refused.
 */
function handleDigest(params: unknown, ctx: FleetRpcCtx): FleetDigestResult {
  const store = requireStore(ctx);
  const raw = optInt(params, "windowMs");
  if (raw !== undefined && raw <= 0) {
    throw new FleetRpcError(-32602, "fleet: windowMs must be a positive integer");
  }
  const windowMs = raw ?? DEFAULT_DIGEST_WINDOW_MS;
  return buildFleetDigest({
    store,
    jobs: ctx.jobs ?? [],
    windowMs,
    now: ctx.now(),
    retentionDays: ctx.config.retentionDays,
  });
}

const HANDLERS: RpcMethodHandlerMap<FleetRpcCtx> = {
  "fleet.status": handleStatus,
  "fleet.list": handleList,
  "fleet.briefs": handleBriefs,
  "fleet.show": handleShow,
  "fleet.runNow": handleRunNow,
  "fleet.digest": handleDigest,
} as const;

export async function dispatchFleetRpc(
  method: string,
  params: unknown,
  ctx: FleetRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<FleetRpcCtx>(method, params, ctx, HANDLERS);
}
