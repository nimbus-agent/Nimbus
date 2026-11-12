import type { ChatReadMarkerInput, ChatReadMarkerKind } from "../index/chat-read-marker-store.ts";
import type { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import { type SlackApiReply, slackWebApi } from "./slack-web-api.ts";
import { asRecord } from "./unknown-record.ts";

/**
 * The Slack read-marker pass (Phase 10 MB4): at the end of a history round the sync asks
 * `conversations.info` for the owner's `last_read` of the channels it indexes (a user token returns it
 * for public, private, IM and MPIM conversations; documented, not verified against a live workspace) and
 * hands the result to the `setChatReadMarkers` capability. Best effort: it never throws and never fails
 * the sync. Whatever it fetched is stored; a channel it did not reach keeps its previous marker.
 *
 * Every request takes a token from the shared `slack` limiter (20/min, burst 5) with `tryAcquire`, polled
 * until the pass's deadline, so a saturated limiter ends the pass partial instead of holding the
 * provider mutex. Logs carry Slack error CODES only, never response text or the token.
 */

export const MARKER_PASS_BUDGET_MS = 30_000;
export const MARKER_PASS_MAX_CHANNELS = 100;
const POLL_MS = 500;
const SLACK_TS_RE = /^\d{10}\.\d{6}$/;

/** Errors that mean no further call of this pass can succeed. */
const FATAL_CODES: ReadonlySet<string> = new Set([
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "missing_scope",
  "account_inactive",
]);

export type ParsedMarker =
  | { readonly ok: true; readonly marker: ChatReadMarkerInput }
  | { readonly ok: false; readonly reason: "no_channel" | "id_mismatch" | "no_last_read" };

function kindOf(channel: Record<string, unknown>): ChatReadMarkerKind {
  if (channel["is_mpim"] === true) return "mpim";
  if (channel["is_im"] === true) return "im";
  if (channel["is_private"] === true || channel["is_group"] === true) return "private_channel";
  return "public_channel";
}

/** Reads one `conversations.info` reply into a marker, or says why it cannot. */
export function parseConversationInfo(
  json: Record<string, unknown>,
  requestedId: string,
): ParsedMarker {
  const channel = asRecord(json["channel"]);
  if (channel === undefined) return { ok: false, reason: "no_channel" };
  if (channel["id"] !== requestedId) return { ok: false, reason: "id_mismatch" };
  const lastRead = channel["last_read"];
  if (typeof lastRead !== "string" || !SLACK_TS_RE.test(lastRead)) {
    return { ok: false, reason: "no_last_read" };
  }
  return {
    ok: true,
    marker: { channelId: requestedId, channelKind: kindOf(channel), lastReadTs: lastRead },
  };
}

/**
 * The channels one pass attempts: up to `max` of `ids`, starting at `mkIdx % ids.length` and wrapping,
 * each at most once. Round-robin by offset because a syncable cannot read `captured_at` (D24).
 */
export function selectMarkerChannels(ids: readonly string[], mkIdx: number, max: number): string[] {
  const n = ids.length;
  if (n === 0) return [];
  const start = mkIdx % n;
  const count = Math.min(max, n);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(ids[(start + i) % n] as string);
  }
  return out;
}

/** The offset after `attempted` channels were processed (0 when there are no channels). */
export function advanceMarkerIndex(mkIdx: number, attempted: number, n: number): number {
  return n === 0 ? 0 : (mkIdx + attempted) % n;
}

export type MarkerPassDeps = {
  readonly callApi: (
    token: string,
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<SlackApiReply>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly budgetMs: number;
  readonly maxChannels: number;
};

export const DEFAULT_MARKER_PASS_DEPS: MarkerPassDeps = {
  callApi: slackWebApi,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  budgetMs: MARKER_PASS_BUDGET_MS,
  maxChannels: MARKER_PASS_MAX_CHANNELS,
};

export type MarkerPassInput = {
  readonly token: string;
  /** The fresh, sorted, de-duplicated list of the channels the sync indexes. */
  readonly ids: readonly string[];
  readonly mkIdx: number;
  readonly selfUserId: string | null;
  /**
   * Whether `ids` is the COMPLETE list (every page read, no malformed entry). Only then are markers of
   * channels outside `ids` deleted: a partial list must never prune.
   */
  readonly listComplete: boolean;
};

export type MarkerPassResult = {
  readonly selfUserId: string | null;
  readonly mkIdx: number;
};

/** Polls `tryAcquire` until a token is free or `deadline` passes. */
async function acquireWithin(
  limiter: ProviderRateLimiter,
  deadline: number,
  deps: MarkerPassDeps,
): Promise<boolean> {
  for (;;) {
    if (deps.now() >= deadline) return false;
    if (await limiter.tryAcquire("slack")) return true;
    await deps.sleep(POLL_MS);
  }
}

type FetchOne =
  | { readonly kind: "marker"; readonly marker: ChatReadMarkerInput }
  | { readonly kind: "skip" }
  | { readonly kind: "stop"; readonly reason: string };

function errorCode(reply: SlackApiReply): string {
  const code = reply.json["error"];
  return typeof code === "string" && code !== "" ? code.slice(0, 64) : "unknown_error";
}

async function fetchOne(
  ctx: SyncContext,
  token: string,
  id: string,
  signal: AbortSignal,
  deps: MarkerPassDeps,
): Promise<FetchOne> {
  let reply: SlackApiReply;
  try {
    reply = await deps.callApi(token, "conversations.info", { channel: id }, signal);
  } catch {
    return { kind: "stop", reason: "aborted" };
  }
  if (!reply.ok) {
    const code = errorCode(reply);
    if (code === "ratelimited") {
      ctx.rateLimiter.penalise("slack", 60_000);
      return { kind: "stop", reason: code };
    }
    if (FATAL_CODES.has(code)) return { kind: "stop", reason: code };
    return { kind: "skip" };
  }
  const parsed = parseConversationInfo(reply.json, id);
  return parsed.ok ? { kind: "marker", marker: parsed.marker } : { kind: "skip" };
}

/** `auth.test` for the token's own user id; null when the call fails or returns none. */
async function fetchSelfUserId(
  token: string,
  signal: AbortSignal,
  deps: MarkerPassDeps,
): Promise<string | null> {
  try {
    const reply = await deps.callApi(token, "auth.test", {}, signal);
    const id = reply.ok ? reply.json["user_id"] : undefined;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Refreshes the owner's Slack read markers for the sync's channels. NEVER throws. Returns the own user
 * id to cache (the new one, or `input.selfUserId` when `auth.test` failed) and the round-robin offset
 * advanced by the channels actually processed.
 */
export async function refreshSlackReadMarkers(
  ctx: SyncContext,
  input: MarkerPassInput,
  deps: MarkerPassDeps = DEFAULT_MARKER_PASS_DEPS,
): Promise<MarkerPassResult> {
  const controller = new AbortController();
  // A ref'd timer of our own: `AbortSignal.timeout`'s does not keep the loop alive.
  const timer = setTimeout(() => controller.abort(), deps.budgetMs);
  const deadline = deps.now() + deps.budgetMs;
  const markers: ChatReadMarkerInput[] = [];
  let selfUserId = input.selfUserId;
  let attempted = 0;
  let stopReason: string | null = null;
  try {
    if (await acquireWithin(ctx.rateLimiter, deadline, deps)) {
      selfUserId = (await fetchSelfUserId(input.token, controller.signal, deps)) ?? selfUserId;
    } else {
      stopReason = "deadline";
    }
    const todo =
      stopReason === null ? selectMarkerChannels(input.ids, input.mkIdx, deps.maxChannels) : [];
    for (const id of todo) {
      if (!(await acquireWithin(ctx.rateLimiter, deadline, deps))) {
        stopReason = "deadline";
        break;
      }
      const out = await fetchOne(ctx, input.token, id, controller.signal, deps);
      if (out.kind === "stop") {
        stopReason = out.reason;
        break;
      }
      attempted += 1;
      if (out.kind === "marker") markers.push(out.marker);
    }
  } catch (err) {
    stopReason = err instanceof Error ? err.name : "error";
  } finally {
    clearTimeout(timer);
  }
  if (stopReason !== null) {
    ctx.logger.warn({ service: "slack", code: stopReason }, "slack read markers: pass ended early");
  }
  try {
    if (markers.length > 0 || input.listComplete) {
      ctx.setChatReadMarkers(
        markers,
        input.listComplete ? { keepChannelIds: input.ids } : undefined,
      );
    }
  } catch (err) {
    ctx.logger.warn(
      { service: "slack", code: err instanceof Error ? err.name : "error" },
      "slack read markers: storing failed",
    );
  }
  return { selfUserId, mkIdx: advanceMarkerIndex(input.mkIdx, attempted, input.ids.length) };
}
