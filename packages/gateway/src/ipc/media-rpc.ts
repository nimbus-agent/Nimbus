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

export interface MediaRpcDeps {
  readonly runPass: (opts: {
    service?: string;
    modality?: MediaModality;
    sinceMs?: number;
    limit: number;
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

  return deps.runPass({
    limit,
    ...(service === undefined ? {} : { service }),
    ...(modality === undefined ? {} : { modality }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
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
