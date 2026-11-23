import type { RateLimitCheck } from "../http-rate-limit.ts";
import { POLICY_REJECT_ACTION } from "./constants.ts";
import { jsonResponse, rateLimitHeaders, recordRejection } from "./responses.ts";
import type { PolicyAuthorResult, PolicyWriteSurface, WriteRouteContext } from "./types.ts";

/** Extracts a string `toml` field from the parsed body, or undefined if missing/wrong type. */
export function extractToml(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "toml" in parsed) {
    const t = (parsed as { toml?: unknown }).toml;
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

export async function runPolicyRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  parsed: unknown,
): Promise<Response> {
  // resolveRoute guarantees ctx.policy is defined for every policy-kind route.
  const policy = ctx.policy as PolicyWriteSurface;
  const toml = extractToml(parsed);
  if (toml === undefined) {
    recordRejection(ctx, {
      actionType: POLICY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_body",
    });
    return jsonResponse({ error: "invalid_body", detail: "body.toml (string) is required" }, 400, {
      ...rateLimitHeaders(limit),
    });
  }
  let result: PolicyAuthorResult;
  try {
    result = await policy.authorPolicy(toml);
  } catch {
    recordRejection(ctx, {
      actionType: POLICY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
  if (!result.ok) {
    recordRejection(ctx, {
      actionType: POLICY_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 400,
      reason: "invalid_policy",
    });
    return jsonResponse({ error: result.error }, 400, rateLimitHeaders(limit));
  }
  // The privkey is NEVER in the response — only the applied org/version summary (the {toml, sig}
  // bundle is public, but the response intentionally returns just the applied summary).
  return jsonResponse(
    { data: { applied: true, org: result.org, version: result.version } },
    200,
    rateLimitHeaders(limit),
  );
}
