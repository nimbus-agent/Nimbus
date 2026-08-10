// packages/gateway/src/connectors/credential-probe.ts

import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import { basicAuthHeader } from "./atlassian-api-sync-helpers.ts";
import type { ConnectorServiceId } from "./connector-catalog.ts";

/**
 * Bounds the single probe request. Without it `nimbus connector auth` — an
 * INTERACTIVE command — can hang indefinitely on a stalled provider. Mirrors
 * `FETCH_ONE_TIMEOUT_MS` (`sync/types.ts`); a timeout is a transport failure and
 * resolves to `unconfirmed`, so the credential is still stored.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export type ProbeVerdict =
  | { readonly kind: "valid" }
  | { readonly kind: "rejected"; readonly httpStatus: number }
  | { readonly kind: "unconfirmed" };

export interface ProbeRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export type CredentialProbe = (creds: Record<string, string>) => ProbeRequest;

/**
 * Identity endpoints, one per service that has a cheap one.
 *
 * A `Partial<Record<...>>`, not a total map: the ~14 other PAT connectors are
 * EXPLICITLY absent rather than silently unchecked, and `runCredentialProbe`
 * answers `null` for them so the caller reports "stored, not verified" instead
 * of inventing a verdict.
 */
export const CREDENTIAL_PROBES: Partial<Record<ConnectorServiceId, CredentialProbe>> = {
  github: (c) => ({
    url: "https://api.github.com/user",
    headers: {
      Authorization: `Bearer ${c["pat"] ?? ""}`,
      Accept: "application/vnd.github+json",
    },
  }),
  gitlab: (c) => ({
    url: `${stripTrailingSlashes(c["api_base"] ?? "https://gitlab.com/api/v4")}/user`,
    headers: { "PRIVATE-TOKEN": c["pat"] ?? "" },
  }),
  bitbucket: (c) => ({
    url: "https://api.bitbucket.org/2.0/user",
    headers: {
      Authorization: basicAuthHeader(c["username"] ?? "", c["app_password"] ?? ""),
      Accept: "application/json",
    },
  }),
  jira: (c) => ({
    url: `${stripTrailingSlashes(c["base_url"] ?? "")}/rest/api/3/myself`,
    headers: {
      Authorization: basicAuthHeader(c["email"] ?? "", c["api_token"] ?? ""),
      Accept: "application/json",
    },
  }),
  jenkins: (c) => ({
    url: `${stripTrailingSlashes(c["base_url"] ?? "")}/api/json`,
    headers: {
      Authorization: basicAuthHeader(c["username"] ?? "", c["api_token"] ?? ""),
      Accept: "application/json",
    },
  }),
};

/**
 * Maps a probe response status to a verdict.
 *
 * ONLY 401 rejects. A 401 is "we do not know who you are" — the credential did
 * not authenticate. Everything else that is not 2xx (403, 429, 5xx, a
 * misconfigured base URL's 404) leaves the question open, so the credential is
 * stored and honestly reported as unverified.
 *
 * `unconfirmed` means exactly this: the provider did not confirm the
 * credential. It deliberately does NOT distinguish its causes — 403 (forbidden
 * on this endpoint, not necessarily on everything Nimbus needs), 429
 * (rate-limited), 5xx (provider error), 404 (a misconfigured base URL), or a
 * transport failure (DNS, TLS, timeout) — because none of those prove the
 * credential is bad, and reporting a specific cause here would claim more than
 * this one cheap identity-endpoint call actually determined.
 *
 * NOTE the deliberate divergence from `connectors/fetch-miss-reason.ts`, where
 * 403 maps to `unauthorized`. Fetching a SPECIFIC ITEM, a 403 means the user
 * cannot have it either way, so `unauthorized` is the actionable answer.
 * Verifying a CREDENTIAL, a 403 is proof it authenticated. Different questions.
 */
export function verdictForProbeResponse(httpStatus: number): ProbeVerdict {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { kind: "valid" };
  }
  if (httpStatus === 401) {
    return { kind: "rejected", httpStatus };
  }
  return { kind: "unconfirmed" };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Runs `serviceId`'s probe. Returns `null` when no probe is registered.
 *
 * Deliberately does NOT acquire from the connector rate limiter, unlike
 * `sync/targeted-fetch.ts`. A targeted fetch is machine-driven and sweepable, so
 * it must share the scheduler's bucket. A probe is ONE request because a human
 * typed a command: routing it through that bucket would let a saturated
 * background sync block interactive setup for the full acquire timeout and would
 * consume a token the scheduler needs.
 *
 * Never throws and never returns provider text — a transport error's message can
 * carry the request URL, which for jenkins/jira embeds the Vault-stored
 * `base_url`.
 */
export async function runCredentialProbe(
  serviceId: ConnectorServiceId,
  creds: Record<string, string>,
  fetchFn: FetchFn = globalThis.fetch as FetchFn,
): Promise<ProbeVerdict | null> {
  const probe = CREDENTIAL_PROBES[serviceId];
  if (probe === undefined) {
    return null;
  }
  try {
    const req = probe(creds);
    const res = await fetchFn(req.url, {
      method: "GET",
      headers: req.headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return verdictForProbeResponse(res.status);
  } catch {
    return { kind: "unconfirmed" };
  }
}
