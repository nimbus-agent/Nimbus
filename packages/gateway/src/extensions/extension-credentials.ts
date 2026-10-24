import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import type { ExtensionManifest } from "./manifest.ts";

/**
 * Where each credential an extension declares lives, resolved once at approval and stored on the
 * run grant (`extension_run_grant.credentials_json`, V72). Credential name -> the env var the child
 * receives it under and the Vault key it is read from. Names and keys only — never a value; values
 * reach the child only through `extensionProcessEnv` (I1).
 */
export type ResolvedRunCredentials = Readonly<
  Record<string, { readonly env: string; readonly vaultKey: string }>
>;

/**
 * The extension's OWN Vault keyspace: `ext.<serviceId>.<name>`. Composed dynamically, so the D11
 * literal scan cannot see it; this file is on `VAULT_KEY_ALLOW_LIST` to document the keyspace.
 * `serviceId` is an `ext_` id and `name` matches the manifest's `[a-z][a-z0-9_]{0,31}`, so the
 * key cannot collide with a bundled connector's `<service>.<field>` key.
 */
export function extensionCredentialVaultKey(serviceId: string, name: string): string {
  return `ext.${serviceId}.${name}`;
}

/**
 * Credential names in ORDINAL (code-unit) order. Not `localeCompare`: `serializeRunCredentials`'s
 * output is stored on the grant and compared byte-for-byte at every spawn, so its order must not
 * depend on the ICU build a later gateway ships with. Names are unique, so ties cannot occur.
 */
export function sortedNames(o: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(o).sort((a, b) => (a < b ? -1 : 1));
}

/**
 * Resolves every DECLARED credential. A continuity binding's mapping wins for a name it carries (so a
 * migrated connector keeps reading its legacy key); a declared name the binding lacks falls back to
 * the extension's own key. A name only the binding carries is never granted.
 */
export function resolveRunCredentials(
  manifest: Pick<ExtensionManifest, "credentials">,
  serviceId: string,
  binding: ContinuityEntry | undefined,
): ResolvedRunCredentials {
  const out: Record<string, { env: string; vaultKey: string }> = {};
  const decls = manifest.credentials ?? {};
  for (const name of sortedNames(decls)) {
    const decl = decls[name];
    if (decl === undefined) continue;
    const legacy =
      binding !== undefined && Object.hasOwn(binding.credentials, name)
        ? binding.credentials[name]
        : undefined;
    out[name] = { env: decl.env, vaultKey: legacy ?? extensionCredentialVaultKey(serviceId, name) };
  }
  return out;
}

/** Canonical form: names sorted, fields in a fixed order. `{}` when nothing is declared. */
export function serializeRunCredentials(c: ResolvedRunCredentials): string {
  const out: Record<string, { env: string; vaultKey: string }> = {};
  for (const name of sortedNames(c)) {
    const v = c[name];
    if (v === undefined) continue;
    out[name] = { env: v.env, vaultKey: v.vaultKey };
  }
  return JSON.stringify(out);
}

function isNonBlank(v: string | null): v is string {
  return v !== null && v.trim() !== "";
}

/** env var -> value for every credential whose Vault value is non-blank; blank ones are omitted. */
export async function readCredentialEnv(
  vault: NimbusVault,
  c: ResolvedRunCredentials,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  // Sequential on purpose: on Linux each Vault read spawns a `secret-tool` process, and this runs
  // before every extension spawn.
  for (const name of sortedNames(c)) {
    const v = c[name];
    if (v === undefined) continue;
    const value = await vault.get(v.vaultKey); // NOSONAR S9382: each read spawns secret-tool on Linux; runs before every extension spawn
    if (isNonBlank(value)) env[v.env] = value;
  }
  return env;
}

/** `true` when every declared credential has a non-blank Vault value (and when none is declared). */
export async function credentialsConfigured(
  vault: NimbusVault,
  c: ResolvedRunCredentials,
): Promise<boolean> {
  for (const v of Object.values(c)) {
    if (!isNonBlank(await vault.get(v.vaultKey))) return false;
  }
  return true;
}
