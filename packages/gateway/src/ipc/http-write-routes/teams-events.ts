import type { RateLimitCheck } from "../http-rate-limit.ts";
import { TEAMS_EVENTS_REJECT_ACTION } from "./constants.ts";
import { jsonResponse, rateLimitHeaders, recordRejection } from "./responses.ts";
import type { TeamsEventsSurface, WriteRouteContext } from "./types.ts";

export async function runTeamsEventsRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.messaging is defined for every teamsEvents-kind route.
  const messaging = ctx.messaging as TeamsEventsSurface;
  let valid: boolean;
  try {
    valid = await messaging.validateBotJwt(req.headers.get("authorization"), ctx.nowMs());
  } catch {
    valid = false; // fail closed on any verifier error (e.g. JWKS unreachable on cold start)
  }
  if (!valid) {
    recordRejection(ctx, {
      actionType: TEAMS_EVENTS_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 401,
      reason: "invalid_bot_jwt",
    });
    return jsonResponse({ error: "unauthorized" }, 401, rateLimitHeaders(limit));
  }
  // Ack first, process after. Bot Framework redelivers an activity it has not seen acked within
  // ~15 s, and a Wave 4 write waits on the owner's approval for far longer than that, so awaiting
  // the handler here turned one message into several. The adapter dedupes redeliveries on the
  // activity id; a handler fault after the ack is audited, never surfaced to Microsoft.
  void Promise.resolve()
    .then(() => messaging.onActivity(parsed))
    .catch(() => {
      recordRejection(ctx, {
        actionType: TEAMS_EVENTS_REJECT_ACTION,
        tokenFingerprint: fingerprint,
        resultCode: 500,
        reason: "internal_error",
      });
    });
  return jsonResponse({ ok: true }, 200, rateLimitHeaders(limit));
}
