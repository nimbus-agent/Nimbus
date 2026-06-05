// oidc-device-flow.ts
import {
  type DeviceAuthResponse,
  type FetchLike,
  type OidcDiscovery,
  parseDeviceAuthResponse,
  parseTokenResponse,
  type TokenResponse,
} from "./types.ts";

function form(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  };
}

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

export async function pollDeviceToken(
  d: OidcDiscovery,
  clientId: string,
  deviceCode: string,
  opts: PollOpts,
): Promise<TokenResponse> {
  let intervalMs = opts.intervalSeconds * 1000;
  for (;;) {
    if (opts.now() > opts.deadlineMs)
      throw new Error("identity: device code expired before authorization");
    opts.onPoll();
    const res = await opts.fetchLike(
      d.tokenEndpoint,
      form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
      }),
    );
    const body: unknown = await res.json().catch(() => ({}));
    if (res.ok) return parseTokenResponse(body);
    const err = asRecord(body)["error"];
    if (err === "slow_down") intervalMs += 5000;
    else if (err !== "authorization_pending") throw deviceTokenError(body);
    await opts.sleep(intervalMs);
  }
}
