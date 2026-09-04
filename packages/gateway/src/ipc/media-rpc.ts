/**
 * `media.understand` — runs the multimodal understanding pass (spec § 8).
 *
 * LAN-FORBIDDEN and absent from the Tauri allowlist: it reads local files and spawns subprocesses,
 * the same posture the whole `exec.*` namespace has. Do not add it to `ALLOWED_METHODS`.
 *
 * Params are validated, never coerced — an unparseable `limit` is a caller error, and silently
 * defaulting it would run an unbounded pass the caller thought they had bounded.
 */
import type { MediaPassSummary } from "../multimodal/media-pass.ts";
import type { MediaModality } from "../multimodal/media-types.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";

/**
 * The boot-assembled seam behind `media.understand`.
 *
 * `enforced` is the live org-policy accessor (invariant I22), matching `ExecGateDeps.enforced` and
 * `CuGateDeps.enforced`. It is a GETTER at the wiring site rather than a snapshot, so a policy
 * installed after boot tightens the next pass rather than the next restart.
 *
 * REQUIRED, not optional-with-a-default. `media.understand` refuses when this ctx is absent: a
 * `?? false` fallback would silently restore the state where an org policy disabling
 * `multimodal_input` did nothing, and nothing in the suite would go red. Same reasoning as
 * `MediaGateDeps.gpu.touch` being required rather than defaulted.
 */
export interface MediaRpcCtx {
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
}

export interface MediaRpcDeps {
  readonly runPass: (opts: {
    service?: string;
    modality?: MediaModality;
    sinceMs?: number;
    limit: number;
    /**
     * Overrides `MediaPassDeps.fetchBudgetBytes` (the `[multimodal] fetch_budget_bytes` config
     * default) for this call ONLY — omitted, the caller's own default carries through, since the
     * dispatcher wiring spreads these opts over an already-complete deps object.
     */
    fetchBudgetBytes?: number;
    /** Overrides `MediaPassDeps.preferRenditions` for this call only. Same shape as above. */
    preferRenditions?: boolean;
  }) => Promise<MediaPassSummary>;
  readonly nowMs?: () => number;
}

const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;

export async function dispatchMediaRpc(
  method: string,
  rawParams: unknown,
  deps: MediaRpcDeps,
): Promise<MediaPassSummary | undefined> {
  if (method !== "media.understand") {
    return undefined;
  }
  const params = asRecord(rawParams);

  const limit = readLimit(params["limit"]);
  const modality = readModality(params["modality"]);
  const service = typeof params["service"] === "string" ? params["service"] : undefined;
  const sinceMs = readSinceMs(params["sinceDays"], deps.nowMs ?? (() => Date.now()));
  const fetchBudgetBytes = readBudgetBytes(params["budgetBytes"]);
  const preferRenditions = readRenditionPreference(params["renditions"], params["originals"]);

  return deps.runPass({
    limit,
    ...(service === undefined ? {} : { service }),
    ...(modality === undefined ? {} : { modality }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(fetchBudgetBytes === undefined ? {} : { fetchBudgetBytes }),
    ...(preferRenditions === undefined ? {} : { preferRenditions }),
  });
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readLimit(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error("media.understand: limit must be a positive integer");
  }
  return v;
}

function readModality(v: unknown): MediaModality | undefined {
  if (v === undefined || v === null) return undefined;
  if (v !== "image" && v !== "av") {
    throw new Error('media.understand: modality must be "image" or "av"');
  }
  return v;
}

function readBudgetBytes(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error("media.understand: budgetBytes must be a non-negative number");
  }
  return v;
}

/**
 * `renditions`/`originals` are mutually exclusive request flags, not a resolved preference — the
 * CLI already rejects the pair before this ever runs, but this dispatcher is reachable from any
 * IPC caller, so the rejection is re-asserted here rather than trusted from the edge. Resolving by
 * precedence instead (say, `originals` wins) would be exactly the silent override the CLI-side
 * check exists to prevent — a caller who set both would get one honored and one dropped with no
 * error at all.
 */
function readRenditionPreference(
  renditionsRaw: unknown,
  originalsRaw: unknown,
): boolean | undefined {
  const renditions = readOptionalBool("renditions", renditionsRaw);
  const originals = readOptionalBool("originals", originalsRaw);
  if (renditions === true && originals === true) {
    throw new Error("media.understand: renditions and originals are mutually exclusive");
  }
  if (renditions === true) return true;
  if (originals === true) return false;
  return undefined;
}

function readOptionalBool(name: string, v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new Error(`media.understand: ${name} must be a boolean`);
  }
  return v;
}

function readSinceMs(v: unknown, nowMs: () => number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error("media.understand: sinceDays must be a non-negative number");
  }
  const floorMs = nowMs() - v * DAY_MS;
  // A huge sinceDays (e.g. Number.MAX_SAFE_INTEGER) produces a floor before the Unix epoch —
  // silently nonsensical, or even negative-overflowed — rather than "no since bound". Reject it
  // instead of handing runPass() a floor that means something other than what the caller asked.
  if (!Number.isFinite(floorMs) || floorMs < 0) {
    throw new Error(
      "media.understand: sinceDays is too large — the resulting floor predates the Unix epoch",
    );
  }
  return floorMs;
}
