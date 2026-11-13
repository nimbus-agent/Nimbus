// packages/gateway/src/mcp-sink/capture-describe.ts
// `capture.describe` (Phase 28 AD3a-2b, D-AD-10): tells an outside agent which action types the door
// accepts now and, for the approved ones it names, the description and input schema of each. A read
// surface: it changes nothing about what is accepted, refused, approved or dispatched.
//
// `describeActions` runs a FIXED order; read it top to bottom. Steps 1 to 4 refuse without an audit
// row, counted instead (as submit's early steps), so the limit stays a bound:
//   1. capability: the act door is on (config and live org policy, fail closed);
//   2. client kind: only a declared `mcp` connection reads it, as `capture.state` and `capture.mine`;
//   3. params: at most 10 types, each at most 128 characters, across at most 3 services (pure and
//      cheap, so a malformed call costs and consumes nothing, and cannot burn the window every
//      agent connection shares);
//   4. the describe limiter: its OWN window, so describes and submits cannot starve each other;
//   5. the injected describer (`createAgentDoor(...).describe`): this module imports nothing from
//      `connectors/` or the executor (static D32(f)), so the function arrives through the context;
//   6. the reply cap, in bytes, cut in request order.
//
// The reply carries no definition hash or prefix of one, no approval date, no owner-side reason, no
// listing key, no credential or server address and nothing about another connection: those never
// reach this module, which only caps and forwards what the describer returns.
import { serviceOf } from "../engine/service-of.ts";
import type { CaptureCapability } from "./capture-capability.ts";
import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";
import type { CaptureCaller } from "./capture-gate.ts";
import type { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import {
  type ActionDescription,
  CaptureError,
  type CaptureErrorCode,
  type DescribeReply,
} from "./capture-types.ts";

/** Named types per call. */
export const DESCRIBE_TYPES_MAX = 10;
/** Characters per named type. */
export const DESCRIBE_TYPE_CHARS_MAX = 128;
/** Distinct services (each can cost one connector listing) per call. */
export const DESCRIBE_SERVICES_MAX = 3;
/** Bytes of the JSON reply: a quarter of the IPC line limit, which is 1 MiB. */
export const DESCRIBE_REPLY_MAX_BYTES = 262_144;
/** Describe attempts an hour are this many times `max_per_hour`, on a window of their own. */
const DESCRIBE_ATTEMPT_MULTIPLIER = 4;
/** Room kept for the reply's own braces and the truncation flag. */
const REPLY_ENVELOPE_BYTES = 64;

const CUT_REASON = "the reply was full, so this type is not described; ask for fewer types";

/** What the caller reads when the describer fails with anything but a `CaptureError`. */
const DESCRIBE_FAILED_DETAIL = "describe could not be completed now";

/** What the describe path reads: the gate's capability, counter and clock, and the injected describer. */
export interface CaptureDescribeDeps {
  capability(): CaptureCapability;
  readonly refusals: CaptureRefusalCounter;
  now(): number;
  /** Absent: the method refuses `ERR_CAPTURE_DISABLED`. */
  readonly describer?: {
    /** Its own window, never the submit limiter. */
    readonly limiter: CaptureAttemptLimiter;
    readonly actions: (
      actionTypes: readonly string[] | undefined,
    ) => Promise<readonly ActionDescription[]>;
  };
}

function refuse(deps: CaptureDescribeDeps, code: CaptureErrorCode, detail: string): never {
  deps.refusals.bump(code);
  throw new CaptureError(code, detail);
}

/** Step 1: the act door is on. The sink being off implies it, so one flag decides. */
function requireDescribeCapability(deps: CaptureDescribeDeps): CaptureCapability {
  const cap = deps.capability();
  if (!cap.enabled || !cap.actionEnabled) {
    refuse(deps, "ERR_CAPTURE_DISABLED", "the act door is off (mcp_action or kinds)");
  }
  return cap;
}

/**
 * Step 4: no params (or an empty object) is the summary, `undefined`; otherwise `actionTypes` is 1 to
 * 10 non-empty strings of at most 128 characters naming at most 3 services, de-duplicated in order.
 * The count and length bounds apply to what the caller SENT, so a repeated name is not a way round them.
 */
function requireDescribeParams(
  deps: CaptureDescribeDeps,
  params: unknown,
): readonly string[] | undefined {
  if (params === undefined || params === null) return undefined;
  if (typeof params !== "object" || Array.isArray(params)) {
    refuse(deps, "ERR_CAPTURE_INVALID", "params must be an object");
  }
  const raw = (params as Record<string, unknown>)["actionTypes"];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > DESCRIBE_TYPES_MAX) {
    refuse(
      deps,
      "ERR_CAPTURE_INVALID",
      `actionTypes must be 1 to ${String(DESCRIBE_TYPES_MAX)} action types`,
    );
  }
  for (const t of raw as unknown[]) {
    if (typeof t !== "string" || t.length === 0 || t.length > DESCRIBE_TYPE_CHARS_MAX) {
      refuse(
        deps,
        "ERR_CAPTURE_INVALID",
        `each action type must be 1 to ${String(DESCRIBE_TYPE_CHARS_MAX)} characters`,
      );
    }
  }
  const types = [...new Set(raw as string[])];
  if (new Set(types.map(serviceOf)).size > DESCRIBE_SERVICES_MAX) {
    refuse(
      deps,
      "ERR_CAPTURE_INVALID",
      `actionTypes may name at most ${String(DESCRIBE_SERVICES_MAX)} services`,
    );
  }
  return types;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** What a cut entry is replaced with: its type and the fixed reason, nothing else. */
function cutEntry(a: ActionDescription): ActionDescription {
  return { actionType: a.actionType, state: "undescribed", reason: CUT_REASON };
}

/**
 * Step 6: in request order, keep entries while the JSON fits; the first that would not, and all
 * after it, are cut. The replacements are budgeted FIRST (for every entry), and keeping an entry
 * costs only what it adds over its replacement, so the reply that leaves is never over the cap
 * however the cut falls.
 */
function capReply(actions: readonly ActionDescription[]): DescribeReply {
  const replacement = actions.map((a) => byteLength(cutEntry(a)) + 1);
  let used = REPLY_ENVELOPE_BYTES + replacement.reduce((sum, n) => sum + n, 0);
  let cut = false;
  const kept = actions.map((a, i): ActionDescription => {
    if (!cut) {
      const extra = Math.max(0, byteLength(a) + 1 - (replacement[i] ?? 0));
      if (used + extra <= DESCRIBE_REPLY_MAX_BYTES) {
        used += extra;
        return a;
      }
      cut = true;
    }
    return cutEntry(a);
  });
  return { actions: kept, truncated: cut };
}

export async function describeActions(
  deps: CaptureDescribeDeps,
  caller: CaptureCaller,
  params: unknown,
): Promise<DescribeReply> {
  // 1. Capability (config + live org policy, fail-closed).
  const cap = requireDescribeCapability(deps);
  // 2. Client kind: only a declared `mcp` connection reads the door's types.
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit") {
    refuse(deps, "ERR_CAPTURE_FORBIDDEN_CLIENT", "capture.describe is for MCP clients");
  }
  // 3. Params: bounded before anything is consumed or listed.
  const actionTypes = requireDescribeParams(deps, params);
  const describer = deps.describer;
  if (describer === undefined) {
    refuse(deps, "ERR_CAPTURE_DISABLED", "the agent door is not available");
  }
  // 4. The describe limiter, on its own window.
  const cap4 = cap.config.maxPerHour * DESCRIBE_ATTEMPT_MULTIPLIER;
  if (!describer.limiter.tryAcquire(deps.now(), cap4)) {
    refuse(deps, "ERR_CAPTURE_RATE_LIMITED", "too many describe attempts this hour");
  }
  // 5. The describer (a detailed call may list, and so start, an approved connector). Anything but a
  //    `CaptureError` is internal: it becomes a fixed text, never the thrown message.
  let described: readonly ActionDescription[];
  try {
    described = await describer.actions(actionTypes);
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    throw new CaptureError("ERR_CAPTURE_STATE", DESCRIBE_FAILED_DETAIL);
  }
  // 6. The reply cap.
  return capReply(described);
}
