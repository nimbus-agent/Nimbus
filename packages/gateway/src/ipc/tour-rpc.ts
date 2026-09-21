import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";
import { resolveSelfPerson } from "../agents/_lib/self-person.ts";
import { buildTourPlan } from "../agents/_lib/tour-plan.ts";
import type { TourSelectorCtx } from "../agents/_lib/tour-selectors.ts";
import {
  TOUR_STEPS_DEFAULT,
  TOUR_STEPS_MAX,
  TOUR_STEPS_MIN,
  type TourPlan,
} from "../agents/_lib/tour-types.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import {
  loadNimbusDecisionsFromConfigDir,
  loadNimbusUserFromConfigDir,
} from "../config/nimbus-toml.ts";
import { ownershipRoots } from "../ownership/ownership-target.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class TourRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "TourRpcError";
  }
}

export type TourRpcContext = {
  readonly db: Database;
  readonly configDir: string | undefined;
  readonly demo: boolean;
  readonly nowMs: () => number;
};

/** Defaults to {@link TOUR_STEPS_DEFAULT} when absent; refuses (never clamps) outside 1..6. */
function requireSteps(params: unknown): number {
  const obj =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const raw = obj["steps"];
  if (raw === undefined) return TOUR_STEPS_DEFAULT;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < TOUR_STEPS_MIN ||
    raw > TOUR_STEPS_MAX
  ) {
    throw new TourRpcError(-32602, "tour.plan: steps must be an integer in 1..6");
  }
  return raw;
}

function safeOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * Reads `nimbus.toml` fresh on every call — mirroring `handleStandup`/`handleDecisions`/`whyRoots`
 * in `ipc/agents-rpc.ts` — so a `[user]`/`[decisions]`/`[[filesystem.roots]]` edit applies without
 * a gateway restart, and delegates identity resolution to the SAME loader + fields `handleStandup`
 * uses, so `nimbus wow` and `nimbus standup` cannot disagree about who "me" is.
 */
function buildSelectorCtx(ctx: TourRpcContext): TourSelectorCtx {
  const { configDir } = ctx;
  const fsRoots =
    configDir === undefined
      ? []
      : loadNimbusFilesystemRootsFromConfigDir(configDir).map((r) => r.path);
  const roots = configDir === undefined ? [] : ownershipRoots(configDir);
  const decisionsMinConfidence =
    configDir === undefined ? 0 : (loadNimbusDecisionsFromConfigDir(configDir).minConfidence ?? 0);
  const mePersonId =
    configDir === undefined ? undefined : loadNimbusUserFromConfigDir(configDir).mePersonId;
  const osUsername = safeOsUsername();
  return {
    db: ctx.db,
    nowMs: ctx.nowMs(),
    fsRoots,
    ownershipRoots: roots,
    decisionsMinConfidence,
    // MUST NOT throw — `resolveSelfPerson` doesn't today, but the contract belongs here rather
    // than resting on that staying true.
    resolveSelf: async () => {
      try {
        const resolution = await resolveSelfPerson(ctx.db, {
          ...(mePersonId === undefined ? {} : { override: mePersonId }),
          osUsername,
        });
        return resolution.personId;
      } catch {
        return null;
      }
    },
  };
}

async function handleTourPlan(params: unknown, ctx: TourRpcContext): Promise<TourPlan> {
  const steps = requireSteps(params);
  const selectorCtx = buildSelectorCtx(ctx);
  return buildTourPlan(selectorCtx, { steps, demo: ctx.demo });
}

export async function dispatchTourRpc(
  method: string,
  params: unknown,
  ctx: TourRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "tour.plan": handleTourPlan });
}
