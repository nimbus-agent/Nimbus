import { readConnectorSecret } from "../connectors/connector-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Which services can serve a targeted fetch-on-miss. Deliberately a CLOSED union, not `string`:
 * adding a service here without landing its `fetchOne` implementation at the dispatch table is a
 * compile error, not a silent runtime gap.
 */
export type FetchableService = "github" | "gitlab" | "bitbucket" | "jenkins" | "jira";

/**
 * Static SaaS hosts. EXACT hosts only — there is no wildcard, no suffix match and no
 * first-segment fallback.
 *
 * Explicitly NOT `agents/impact.ts`'s `HOST_TO_SERVICE`, which ends in
 * `HOST_TO_SERVICE[host] ?? hostFirstSegment` (impact.ts:150) and so resolves an arbitrary host
 * like `github.evil.example` to the plausible-looking service `"github"`. That guessing fallback
 * is acceptable as a hint inside a generated brief and unacceptable as a gate on an outbound
 * request that carries the user's stored credentials: here a miss must mean "not fetchable",
 * never "guess".
 */
export const SAAS_HOSTS: Readonly<Record<string, FetchableService>> = Object.freeze({
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
});

/** Every service this boundary can resolve, in the order the map is built. */
const FETCHABLE_SERVICES: readonly FetchableService[] = [
  "github",
  "gitlab",
  "bitbucket",
  "jenkins",
  "jira",
];

/**
 * The Vault secret that proves a service is CONFIGURED.
 *
 * `readConnectorSecret`'s key parameter is type-checked per literal service id against
 * `connector-secrets-manifest.ts`, so this is a `switch` over the literal `FetchableService`
 * rather than a lookup table keyed generically — a lookup table's value type would widen to
 * `string` and lose that compile-time check (a typo'd key becomes a runtime null instead of a
 * compile error).
 */
async function credentialSecret(
  vault: NimbusVault,
  service: FetchableService,
): Promise<string | null> {
  switch (service) {
    case "github":
      return readConnectorSecret(vault, "github", "pat");
    case "gitlab":
      return readConnectorSecret(vault, "gitlab", "pat");
    case "bitbucket":
      return readConnectorSecret(vault, "bitbucket", "app_password");
    case "jenkins":
      return readConnectorSecret(vault, "jenkins", "base_url");
    case "jira":
      return readConnectorSecret(vault, "jira", "api_token");
  }
}

/**
 * The Vault secret whose value carries a service's self-hosted origin, or `null` for a
 * SaaS-only service (`github`, `bitbucket`) that has no self-hosted variant to resolve.
 *
 * `gitlab` uses `api_base`, NOT `base_url` — the Jenkins/Jira `base_url` convention does not
 * cover it, and a map built by scanning for `*.base_url` would silently omit self-hosted GitLab.
 * Naming the key per service (rather than pattern-matching a suffix) is what makes that a
 * decision instead of an accident.
 */
async function selfHostedOriginSecret(
  vault: NimbusVault,
  service: FetchableService,
): Promise<string | null> {
  switch (service) {
    case "gitlab":
      return readConnectorSecret(vault, "gitlab", "api_base");
    case "jenkins":
      return readConnectorSecret(vault, "jenkins", "base_url");
    case "jira":
      return readConnectorSecret(vault, "jira", "base_url");
    case "github":
    case "bitbucket":
      return null;
  }
}

/** The host of a URL, lowercased, or null when the value is not a usable http(s) origin. */
function hostOf(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed.host.toLowerCase();
}

/**
 * Builds the host→service map from what is ACTUALLY configured in the Vault right now.
 *
 * Absent credentials, a service is not in the map at all — so "unknown host" and "service not
 * configured" collapse to the same fail-closed answer, and the boundary is derived from the
 * machine's real configuration rather than declared in a list that can drift from it. Every path
 * that cannot prove a service is configured (missing/blank credential, missing/malformed origin,
 * non-http(s) scheme) contributes no entry and never throws.
 */
export async function deriveFetchHostMap(
  vault: NimbusVault,
): Promise<ReadonlyMap<string, FetchableService>> {
  const map = new Map<string, FetchableService>();
  for (const service of FETCHABLE_SERVICES) {
    const credential = await credentialSecret(vault, service);
    if (credential === null || credential.trim() === "") {
      continue;
    }

    for (const [host, saasService] of Object.entries(SAAS_HOSTS)) {
      if (saasService === service) {
        map.set(host, service);
      }
    }

    const origin = await selfHostedOriginSecret(vault, service);
    if (origin === null) {
      continue;
    }
    const host = hostOf(origin);
    if (host === null) {
      continue;
    }
    map.set(host, service);
  }
  return map;
}

/** Exact, case-insensitive host lookup. A miss is a refusal, never a guess. */
export function serviceForHost(
  map: ReadonlyMap<string, FetchableService>,
  host: string,
): FetchableService | null {
  return map.get(host.toLowerCase()) ?? null;
}
