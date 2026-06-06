// oidc-device-flow.ts
import {
  type DeviceAuthResponse,
  type FetchLike,
  form,
  type OidcDiscovery,
  parseDeviceAuthResponse,
  parseTokenResponse,
  type TokenResponse,
} from "./types.ts";

export async function requestDeviceCode(
  d: OidcDiscovery,
  clientId: string,
  scopes: readonly string[],
  fetchLike: FetchLike,
): Promise<DeviceAuthResponse> {
  const res = await fetchLike(
    d.deviceAuthorizationEndpoint,
    form({ client_id: clientId, scope: scopes.join(" ") }),
  );
  if (!res.ok) throw new Error(`identity: device authorization failed (${res.status})`);
  return parseDeviceAuthResponse(await res.json());
}

export interface PollOpts {
  readonly fetchLike: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly intervalSeconds: number;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly onPoll: () => void;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** Builds a rich error from the IdP's OAuth error body (review S1: surface error_description/uri). */
function deviceTokenError(body: unknown): Error {
  const rec = asRecord(body);
  const err = rec["error"];
  const code = typeof err === "string" ? err : "unknown";
  const desc = typeof rec["error_description"] === "string" ? ` — ${rec["error_description"]}` : "";
  const uri = typeof rec["error_uri"] === "string" ? ` (${rec["error_uri"]})` : "";
  return new Error(`identity: device token error: ${code}${desc}${uri}`);
}

/**
 * Guards against a bad/absent IdP `interval` (≤0 or non-finite) that would otherwise spin a tight
 * retry loop against the token endpoint; RFC 8628 defaults to 5s.
 */
function normalizeIntervalMs(intervalSeconds: number): number {
  const safe = Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 5;
  return safe * 1000;
}

/** Result of a single token-endpoint poll: the token on success, or the next backoff while pending. */
type PollStep = { readonly token: TokenResponse } | { readonly waitMs: number };

/** One token-endpoint poll. Returns the token, the next backoff, or throws the IdP's OAuth error. */
async function pollTokenOnce(
  d: OidcDiscovery,
  clientId: string,
  deviceCode: string,
  opts: PollOpts,
  intervalMs: number,
): Promise<PollStep> {
  const res = await opts.fetchLike(
    d.tokenEndpoint,
    form({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientId,
    }),
  );
  const body: unknown = await res.json().catch(() => ({}));
  if (res.ok) return { token: parseTokenResponse(body) };
  const err = asRecord(body)["error"];
  if (err === "slow_down") return { waitMs: intervalMs + 5000 };
  if (err !== "authorization_pending") throw deviceTokenError(body);
  return { waitMs: intervalMs };
}

export async function pollDeviceToken(
  d: OidcDiscovery,
  clientId: string,
  deviceCode: string,
  opts: PollOpts,
): Promise<TokenResponse> {
  let intervalMs = normalizeIntervalMs(opts.intervalSeconds);
  for (;;) {
    if (opts.now() > opts.deadlineMs)
      throw new Error("identity: device code expired before authorization");
    opts.onPoll();
    const step = await pollTokenOnce(d, clientId, deviceCode, opts, intervalMs);
    if ("token" in step) return step.token;
    intervalMs = step.waitMs;
    await opts.sleep(intervalMs);
  }
}
