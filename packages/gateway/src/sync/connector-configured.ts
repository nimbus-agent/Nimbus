// packages/gateway/src/sync/connector-configured.ts

import { resolveGoogleOAuthVaultKey } from "../auth/google-access-token.ts";
import { hasUsableAwsCredentials } from "../connectors/_lib/aws-cli.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { readConnectorSecret } from "../connectors/connector-vault.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * `onedrive`/`outlook` both read this single fixed key (`getValidMicrosoftAccessToken` →
 * `microsoftOAuthAccessFromConfig()`) — it is not in `connector-secrets-manifest.ts` at all (no
 * per-service Microsoft resolver analogous to Google's `resolveGoogleOAuthVaultKey` exists), so
 * this reads it directly rather than through `readConnectorSecret` (which builds `service.key`
 * keys, not this shared cross-service one).
 */
async function hasMicrosoftOAuthVaultKey(vault: NimbusVault): Promise<boolean> {
  const value = await vault.get("microsoft.oauth");
  return value !== null && value.trim() !== "";
}

/**
 * Mirrors `bigquery-sync.ts` / `cloud-logging-sync.ts` / `vertex-ai-sync.ts`'s shared `loadCreds`
 * gate exactly: BOTH `gcp.credentials_json_path` AND `gcp.project_id` must be present. `gcp.region`
 * is an OPTIONAL non-secret config key (Vertex AI defaults to `us-central1` when unset) and is
 * deliberately NOT part of this check — a vault carrying only a region would not let any of the
 * three connectors' `loadCreds` produce usable credentials either. Reads via `readConnectorSecret`
 * (the same helper each connector's own `loadCreds` uses) rather than a raw `vault.get` template,
 * so the allow-listed key constructor stays the sole place `service.key` strings are assembled.
 */
async function isGcpCredentialConfigured(vault: NimbusVault): Promise<boolean> {
  const [credPath, project] = await Promise.all([
    readConnectorSecret(vault, "gcp", "credentials_json_path"),
    readConnectorSecret(vault, "gcp", "project_id"),
  ]);
  return (credPath?.trim() ?? "") !== "" && (project?.trim() ?? "") !== "";
}

/** `github_actions` reads the same key `readConnectorSecret(vault, "github", "pat")` reads before any GitHub API call. */
async function isGithubPatConfigured(vault: NimbusVault): Promise<boolean> {
  const pat = await readConnectorSecret(vault, "github", "pat");
  return pat !== null && pat.trim() !== "";
}

/** `google_drive`/`gmail`/`google_photos`/`google_meet` each resolve via the same OAuth lookup their `sync()` uses. */
function googleOAuthConfigured(
  serviceId: "google_drive" | "gmail" | "google_photos" | "google_meet",
): (vault: NimbusVault) => Promise<boolean> {
  return async (vault) => (await resolveGoogleOAuthVaultKey(vault, serviceId)) !== null;
}

/**
 * Configured-checks for the 13 registered, non-local-only syncables whose OWN
 * `CONNECTOR_VAULT_SECRET_KEYS` entry is an empty array — so the generic "any manifest key
 * present" loop below has nothing to check — but whose `sync()` nonetheless reads a REAL vault
 * signal before doing any outbound work. Each entry here reuses (never reimplements) exactly the
 * predicate that service's own `sync()` gates on:
 *
 *  - `google_drive`/`gmail`/`google_photos`/`google_meet`: `resolveGoogleOAuthVaultKey` — the
 *    same per-service-then-shared `google.oauth` lookup `getValidGoogleAccessToken` uses.
 *  - `onedrive`/`outlook`: both read the single fixed `microsoft.oauth` vault key
 *    (`getValidMicrosoftAccessToken` → `microsoftOAuthAccessFromConfig()`) — there is no
 *    per-service Microsoft resolver analogous to Google's, so this checks that literal key.
 *  - `github_actions`: `github.pat` — the same key `readConnectorSecret(vault, "github", "pat")`
 *    reads before any GitHub API call.
 *  - `bigquery`/`cloud_logging`/`vertex_ai`: `isGcpCredentialConfigured` — the shared
 *    `gcp.credentials_json_path` + `gcp.project_id` pair each connector's own `loadCreds` requires.
 *  - `athena`/`cloudwatch`/`sagemaker`: `hasUsableAwsCredentials` — the exact usable-combination
 *    formula `_lib/aws-cli.ts`'s `awsCredentialsExtra` gates its spawn on.
 *
 * Executed failure this closes (I29 Critical, follow-up to the manifest-key gate below): every one
 * of these 13 has an EMPTY manifest key list, so before this map existed the function below fell
 * through to "no signal, no gate" and returned `true` unconditionally — `sync/scheduler.ts`'s
 * `runJob` then ledgered an "authorized" `sync` egress row for every run even though each
 * connector's own `sync()` made ZERO outbound network calls. Proven against a real
 * `assemblePlatformServices` boot with an empty Vault: 0 network attempts, 15 fabricated rows
 * before this fix (`platform/assemble.test.ts`).
 */
const DERIVED_CONFIGURED_CHECKS: Readonly<
  Record<string, (vault: NimbusVault) => Promise<boolean>>
> = {
  google_drive: googleOAuthConfigured("google_drive"),
  gmail: googleOAuthConfigured("gmail"),
  google_photos: googleOAuthConfigured("google_photos"),
  google_meet: googleOAuthConfigured("google_meet"),
  onedrive: hasMicrosoftOAuthVaultKey,
  outlook: hasMicrosoftOAuthVaultKey,
  github_actions: isGithubPatConfigured,
  bigquery: isGcpCredentialConfigured,
  cloud_logging: isGcpCredentialConfigured,
  vertex_ai: isGcpCredentialConfigured,
  athena: hasUsableAwsCredentials,
  cloudwatch: hasUsableAwsCredentials,
  sagemaker: hasUsableAwsCredentials,
};

/**
 * Whether `serviceId` has at least one non-blank Vault secret among the keys
 * `connector-secrets-manifest.ts` lists for it — the same manifest `sync/fetch-host-boundary.ts`
 * uses to decide whether a service is fetchable, reused here to decide whether a scheduled sync
 * is worth running AND worth ledgering (I29 Critical 1).
 *
 * Executed failure this closes: `platform/assemble-sync-registrations.ts` registers ~90 cloud
 * syncables with NO credential gate, and each one's `sync()` short-circuits to `syncNoopResult`
 * when unconfigured — without touching the network. `sync/scheduler.ts`'s `runJob` used to append
 * a `sync` egress row unconditionally before EVERY run, so an empty Vault with N cloud connectors
 * registered produced N fabricated "authorized" rows per run, with zero outbound requests.
 *
 * A service whose OWN manifest key list is EMPTY is checked against `DERIVED_CONFIGURED_CHECKS`
 * FIRST — those 13 syncables have no manifest-listed secret of their own (an OAuth-managed
 * connector like `gmail`, or one that reuses a DIFFERENT service's credential like `bigquery`
 * reusing `gcp.*`) but their `sync()` still reads a real signal before doing any outbound work, so
 * "empty manifest key list" must not mean "no signal, no gate" for them. A service with an empty
 * manifest list and NO entry in that map (including every `LOCAL_ONLY_SYNC_SERVICES` local indexer,
 * which is never in the manifest at all, and any future connector whose manifest entry has not yet
 * grown a `DERIVED_CONFIGURED_CHECKS` entry) still returns `true` unconditionally — a known,
 * pinned-empty-by-test bound, not a silent gap (see `connector-configured.test.ts`'s
 * "no service still bypasses the gate" pin).
 *
 * For every OTHER (non-empty-key-list) service, this is deliberately permissive — ANY key
 * present, not ALL — for two reasons:
 *   1. A manifest with an EMPTY key list not covered above has no vault-derived signal to check at
 *      all, so it is treated as configured.
 *   2. Several manifests list keys that are alternates (Snowflake's OAuth-token-or-key-pair-JWT)
 *      or auxiliary/optional (`aws.profile`, `gcp.region`). Requiring every key would
 *      false-negative (skip) a connector that IS configured under an alternate credential shape.
 *      The cost of that stricter rule — a silently skipped sync — is worse than this rule's cost:
 *      still running `connector.sync()` against a partially-configured service, which each
 *      connector already handles by no-op'ing internally (see `sync/scheduler.ts`'s `runJob`,
 *      the sole caller, for why that no-op is not itself an outbound call worth gating further).
 *
 * KNOWN BOUND (deliberately deferred, not an oversight): because the rule is ANY-key-present, a
 * multi-key service is "configured" the moment ONE key is set, even when that key alone cannot
 * make an outbound request. Proven examples: `jenkins` with only `jenkins.base_url` set (no
 * username/token), `discord` with only `discord.enabled` set (no bot token), `sentry` with only
 * `sentry.org_slug` set (no auth token), and `aws` with only `aws.profile` set with a profile that
 * resolves to nothing locally — each yields `configured=true`, so the scheduler appends ONE `sync`
 * egress row per run while the connector's own `sync()` makes zero network calls, for as long as
 * that single non-credential key stays set. This residual is narrower than the pre-fix defect
 * (bounded to services that already have SOME key set, not every registered connector) and is
 * knowingly left in place rather than fixed here — closing it would mean hand-auditing which
 * subset of each multi-key manifest entry is actually credential-bearing vs. optional/alternate,
 * service by service, which is out of scope for this pass.
 */
export async function isConnectorConfigured(
  vault: NimbusVault,
  serviceId: string,
): Promise<boolean> {
  const derivedCheck = Object.hasOwn(DERIVED_CONFIGURED_CHECKS, serviceId)
    ? DERIVED_CONFIGURED_CHECKS[serviceId]
    : undefined;
  if (derivedCheck !== undefined) {
    return derivedCheck(vault);
  }
  const keys = Object.hasOwn(CONNECTOR_VAULT_SECRET_KEYS, serviceId)
    ? (CONNECTOR_VAULT_SECRET_KEYS as Record<string, readonly string[]>)[serviceId]
    : undefined;
  if (keys === undefined || keys.length === 0) {
    return true;
  }
  for (const key of keys) {
    const value = await vault.get(key);
    if (value !== null && value.trim() !== "") {
      return true;
    }
  }
  return false;
}
