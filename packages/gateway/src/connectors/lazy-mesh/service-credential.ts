/**
 * Per-SERVICE credential predicates: whether ONE first-party service's own credential is stored,
 * read from the Vault and the spawn context only. Never a token refresh and never any network call:
 * the connector-write listing asks this BEFORE it ensures a slot, so the check itself must not reach
 * a provider (`ensureGoogleDriveMcp` and `ensureMicrosoftBundleMcp` refresh tokens; this does not).
 *
 * Per service, not per slot: the Google and Microsoft bundles host several services, and a bundle
 * already running for a sibling must never make an unconfigured service look usable.
 */
import { resolveGoogleOAuthVaultKey } from "../../auth/google-access-token.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret, sharedOAuthKey } from "../connector-vault.ts";
import { isPagerdutyFromEmail } from "../pagerduty-from-email.ts";

/** The spawn-context fields a predicate may read (obsidian's vault paths come from config). */
export interface ServiceCredentialContext {
  readonly obsidianVaultPaths?: readonly string[] | undefined;
}

type Predicate = (vault: NimbusVault, ctx: ServiceCredentialContext) => Promise<boolean>;

function present(v: string | null): boolean {
  return v !== null && v !== "";
}

/** Present and not blank: a value of only whitespace is not a credential. */
function presentTrimmed(v: string | null): boolean {
  return v !== null && v.trim() !== "";
}

async function allPresentTrimmed(reads: ReadonlyArray<Promise<string | null>>): Promise<boolean> {
  const values = await Promise.all(reads);
  return values.every(presentTrimmed);
}

async function allPresent(reads: ReadonlyArray<Promise<string | null>>): Promise<boolean> {
  const values = await Promise.all(reads);
  return values.every(present);
}

const PREDICATES: Readonly<Record<string, Predicate>> = {
  gmail: async (vault) => (await resolveGoogleOAuthVaultKey(vault, "gmail")) !== null,
  google_drive: async (vault) => (await resolveGoogleOAuthVaultKey(vault, "google_drive")) !== null,
  outlook: async (vault) => present(await vault.get(sharedOAuthKey("microsoft"))),
  teams: async (vault) => present(await vault.get(sharedOAuthKey("microsoft"))),
  onedrive: async (vault) => present(await vault.get(sharedOAuthKey("microsoft"))),
  // The model door WRITES (acknowledge, resolve, escalate), and PagerDuty needs the `From` e-mail of
  // a valid user on every write, so both the token and a well-formed e-mail must be stored. Reads
  // (sync) need only the token; this predicate is the write door's.
  pagerduty: async (vault) => {
    const token = await readConnectorSecret(vault, "pagerduty", "api_token");
    const email = await readConnectorSecret(vault, "pagerduty", "from_email");
    return token !== null && token.trim() !== "" && email !== null && isPagerdutyFromEmail(email);
  },
  github: async (vault) => present(await readConnectorSecret(vault, "github", "pat")),
  gitlab: async (vault) => present(await readConnectorSecret(vault, "gitlab", "pat")),
  // GitHub Actions runs as a second server in the github slot, spawned with the SAME PAT.
  github_actions: async (vault) => presentTrimmed(await readConnectorSecret(vault, "github", "pat")),
  // The spawner needs BOTH the Bitbucket username and the app password.
  bitbucket: (vault) =>
    allPresentTrimmed([
      readConnectorSecret(vault, "bitbucket", "username"),
      readConnectorSecret(vault, "bitbucket", "app_password"),
    ]),
  // The Jenkins spawner needs the base URL, the username and the API token (each non-blank).
  jenkins: (vault) =>
    allPresentTrimmed([
      readConnectorSecret(vault, "jenkins", "base_url"),
      readConnectorSecret(vault, "jenkins", "username"),
      readConnectorSecret(vault, "jenkins", "api_token"),
    ]),
  circleci: async (vault) => presentTrimmed(await readConnectorSecret(vault, "circleci", "api_token")),
  slack: async (vault) => present(await readConnectorSecret(vault, "slack", "oauth")),
  linear: async (vault) => present(await readConnectorSecret(vault, "linear", "api_key")),
  notion: async (vault) => present(await readConnectorSecret(vault, "notion", "oauth")),
  jira: (vault) =>
    allPresent([
      readConnectorSecret(vault, "jira", "api_token"),
      readConnectorSecret(vault, "jira", "email"),
      readConnectorSecret(vault, "jira", "base_url"),
    ]),
  confluence: (vault) =>
    allPresent([
      readConnectorSecret(vault, "confluence", "api_token"),
      readConnectorSecret(vault, "confluence", "email"),
      readConnectorSecret(vault, "confluence", "base_url"),
    ]),
  discord: async (vault) => {
    const enabled = await readConnectorSecret(vault, "discord", "enabled");
    return enabled === "1" && present(await readConnectorSecret(vault, "discord", "bot_token"));
  },
  // The spawner needs BOTH the iCloud email and the app password.
  apple: (vault) =>
    allPresent([
      readConnectorSecret(vault, "apple", "icloud_email"),
      readConnectorSecret(vault, "apple", "icloud_app_password"),
    ]),
  obsidian: (_vault, ctx) => Promise.resolve((ctx.obsidianVaultPaths ?? []).length > 0),
};

/** The services this module has a predicate for (a test pins it against the listing map). */
export const SERVICE_CREDENTIAL_SERVICES: readonly string[] = Object.keys(PREDICATES).sort((a, b) =>
  a.localeCompare(b),
);

/**
 * Whether `service`'s OWN credential is configured. `false` for any service without a predicate
 * (fail closed), including prototype member names.
 */
export async function isServiceCredentialConfigured(
  vault: NimbusVault,
  service: string,
  ctx: ServiceCredentialContext,
): Promise<boolean> {
  const predicate = Object.hasOwn(PREDICATES, service) ? PREDICATES[service] : undefined;
  if (predicate === undefined) return false;
  return predicate(vault, ctx);
}
