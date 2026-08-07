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
 *
 * This table is an INGREDIENT, not an authorization decision — it is not itself a source of
 * truth for what is fetchable. Authorization comes only from `deriveFetchHostMap`, which gates
 * every one of these hosts behind proof that its service's credential actually exists in the
 * Vault. Reading `SAAS_HOSTS` directly would authorise all three hosts against a completely
 * empty Vault.
 */
export const SAAS_HOSTS: Readonly<Record<string, FetchableService>> = Object.freeze({
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
});

/**
 * Every service this boundary can resolve, in the order the map is built. Derived from the
 * `FetchableService` union via `satisfies` rather than hand-listed, so a future service added to
 * the union without a corresponding key here is a compile error (`TS2345`/`TS2353`) instead of a
 * silent miss — matching the exhaustiveness the two `switch` statements below already get for
 * free from the union.
 */
const FETCHABLE_SERVICES = Object.keys({
  github: 0,
  gitlab: 0,
  bitbucket: 0,
  jenkins: 0,
  jira: 0,
} satisfies Record<FetchableService, number>) as readonly FetchableService[];

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
      return readConnectorSecret(vault, "jenkins", "api_token");
    case "jira":
      return readConnectorSecret(vault, "jira", "api_token");
  }
}

/**
 * Extra Vault keys `fetchOne` reads BEYOND `credentialSecret`'s single primary key, that this
 * boundary must ALSO prove present before claiming a host — otherwise a partially-configured
 * service (e.g. `bitbucket.app_password` set but `bitbucket.username` absent) is claimed
 * "configured" here while `fetchOne` still declines for missing credentials with zero network
 * activity: a deterministic egress-ledger over-claim, repeatable on EVERY request (I29
 * Critical 2). Mirrors exactly the keys each connector's own `fetchOne` reads before making a
 * request — bitbucket-sync.ts / jenkins-sync.ts / jira-sync.ts's `loadJiraVaultCreds`.
 */
async function extraRequiredSecretsPresent(
  vault: NimbusVault,
  service: FetchableService,
): Promise<boolean> {
  switch (service) {
    case "bitbucket": {
      const username = await readConnectorSecret(vault, "bitbucket", "username");
      return username !== null && username.trim() !== "";
    }
    case "jenkins": {
      const username = await readConnectorSecret(vault, "jenkins", "username");
      return username !== null && username.trim() !== "";
    }
    case "jira": {
      const email = await readConnectorSecret(vault, "jira", "email");
      return email !== null && email.trim() !== "";
    }
    case "github":
    case "gitlab":
      return true;
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
 *
 * A host can be claimed by at most one service. If two DIFFERENT services would claim the same
 * host — e.g. a pasted-wrong `jira.base_url = "https://github.com"` alongside a real
 * `github.pat` — the host is refused for BOTH rather than resolved to whichever service happened
 * to run last (`Map.set` is otherwise last-write-wins, and iteration order is an implementation
 * detail, not a security boundary). Guessing which of two claimants owns a contested host is
 * exactly the kind of guess this module refuses to make elsewhere; once a host is marked
 * ambiguous it stays refused even if a later service in this same pass would also claim it. A
 * service re-claiming a host it already holds (e.g. its self-hosted origin secret happens to
 * equal its own static SaaS host) is not a collision and resolves normally.
 */
export async function deriveFetchHostMap(
  vault: NimbusVault,
): Promise<ReadonlyMap<string, FetchableService>> {
  const map = new Map<string, FetchableService>();
  const ambiguousHosts = new Set<string>();

  const claim = (host: string, service: FetchableService): void => {
    if (ambiguousHosts.has(host)) {
      return;
    }
    const existing = map.get(host);
    if (existing !== undefined && existing !== service) {
      map.delete(host);
      ambiguousHosts.add(host);
      return;
    }
    map.set(host, service);
  };

  for (const service of FETCHABLE_SERVICES) {
    const credential = await credentialSecret(vault, service);
    if (credential === null || credential.trim() === "") {
      continue;
    }
    if (!(await extraRequiredSecretsPresent(vault, service))) {
      continue;
    }

    const origin = await selfHostedOriginSecret(vault, service);
    const selfHostedHost = origin === null ? null : hostOf(origin);

    for (const [host, saasService] of Object.entries(SAAS_HOSTS)) {
      if (saasService !== service) {
        continue;
      }
      // A self-hosted-only deployment (a validly-configured origin secret that resolves to a
      // DIFFERENT host than the public SaaS one) must not ALSO claim the public host — claiming
      // `gitlab.com` alongside a genuinely self-hosted `gitlab.api_base` would send a
      // `gitlab.com` URL to the INTERNAL instance under the internal credential (Important 2).
      // No origin at all (the common case: no self-hosted variant configured) still claims the
      // SaaS host as before; an origin that resolves to the SAME host as the SaaS one (the
      // self-hosted secret simply points back at the public instance) is not a divergence and
      // still claims it too.
      if (selfHostedHost !== null && selfHostedHost !== host) {
        continue;
      }
      claim(host, service);
    }

    if (selfHostedHost !== null) {
      claim(selfHostedHost, service);
    }
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
