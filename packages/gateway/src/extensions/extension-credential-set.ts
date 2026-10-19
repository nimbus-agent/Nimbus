import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ResolvedRunCredentials } from "./extension-credentials.ts";
import type { ExtensionRunGrantRow } from "./run-grant-store.ts";

/**
 * The owner's way to set a credential an approved extension declares (`nimbus extension credential
 * set`, CLI-only). The Vault key is NEVER caller-supplied: it is read from the run grant the owner
 * approved (`credentials_json`, V72), so a caller can only name a declared credential, never point a
 * value at an arbitrary key. Neither the value nor the key appears in the gate payload, the response,
 * the audit row (which records the gate payload) or any error message.
 */

/** The existing I2 frozen-set type `vault.set` — one owner prompt per set. */
export const CREDENTIAL_SET_ACTION_TYPE = "vault.set";

export type CredentialOwnerGate = (action: {
  type: string;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

export type ExtensionCredentialErrorCode =
  | "ERR_EXTENSION_CREDENTIAL_BLANK"
  | "ERR_EXTENSION_CREDENTIAL_NO_GRANT"
  | "ERR_EXTENSION_CREDENTIAL_GRANT_INVALID"
  | "ERR_EXTENSION_CREDENTIAL_UNKNOWN"
  | "ERR_EXTENSION_CREDENTIAL_NOT_APPROVED"
  | "ERR_EXTENSION_CREDENTIAL_CHANGED"
  | "ERR_EXTENSION_CREDENTIAL_WRITE_FAILED";

/** A refusal; the code leads the message so a CLI shows it. Never carries a value or a Vault key. */
export class ExtensionCredentialError extends Error {
  readonly code: ExtensionCredentialErrorCode;
  constructor(code: ExtensionCredentialErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ExtensionCredentialError";
    this.code = code;
  }
}

/** Codes raised after the owner was asked — an internal-class error, like the run grant's. */
export const CREDENTIAL_POST_CONSENT_CODES: ReadonlySet<ExtensionCredentialErrorCode> = new Set([
  "ERR_EXTENSION_CREDENTIAL_NOT_APPROVED",
  "ERR_EXTENSION_CREDENTIAL_CHANGED",
  "ERR_EXTENSION_CREDENTIAL_WRITE_FAILED",
]);

export type CredentialReadDeps = {
  readonly vault: NimbusVault;
  readonly readGrant: (extensionId: string) => ExtensionRunGrantRow | null;
};

export type CredentialSetDeps = CredentialReadDeps & { readonly gate: CredentialOwnerGate };

const CREDENTIAL_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses a grant's `credentials_json` defensively — it is DB data. `undefined` for any row that is
 * not exactly the shape `serializeRunCredentials` writes.
 */
export function parseRunCredentials(json: string): ResolvedRunCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const out: Record<string, { env: string; vaultKey: string }> = Object.create(null);
  for (const [name, entry] of Object.entries(parsed)) {
    if (!CREDENTIAL_NAME_RE.test(name) || !isRecord(entry)) return undefined;
    const env = entry["env"];
    const vaultKey = entry["vaultKey"];
    if (typeof env !== "string" || env === "" || typeof vaultKey !== "string" || vaultKey === "") {
      return undefined;
    }
    out[name] = { env, vaultKey };
  }
  return out;
}

/** The consent/audit payload: names the owner can read, and nothing secret. */
export function credentialGatePayload(extensionId: string, name: string): Record<string, unknown> {
  return { extensionId, name };
}

function grantCredentials(deps: CredentialReadDeps, extensionId: string): ResolvedRunCredentials {
  const row = deps.readGrant(extensionId);
  if (row === null) {
    throw new ExtensionCredentialError(
      "ERR_EXTENSION_CREDENTIAL_NO_GRANT",
      `${extensionId} has no run approval; run \`nimbus extension approve ${extensionId}\` first`,
    );
  }
  const creds = parseRunCredentials(row.credentials_json);
  if (creds === undefined) {
    throw new ExtensionCredentialError(
      "ERR_EXTENSION_CREDENTIAL_GRANT_INVALID",
      `${extensionId}'s run approval records unreadable credentials; approve it again`,
    );
  }
  return creds;
}

function declaredVaultKey(creds: ResolvedRunCredentials, name: string): string | undefined {
  return Object.hasOwn(creds, name) ? creds[name]?.vaultKey : undefined;
}

export async function setExtensionCredential(
  deps: CredentialSetDeps,
  input: { extensionId: string; name: string; value: string },
): Promise<{ name: string; set: true }> {
  const { extensionId, name, value } = input;
  if (value.trim() === "") {
    throw new ExtensionCredentialError(
      "ERR_EXTENSION_CREDENTIAL_BLANK",
      `the value for ${name} is blank`,
    );
  }
  const vaultKey = declaredVaultKey(grantCredentials(deps, extensionId), name);
  if (vaultKey === undefined) {
    throw new ExtensionCredentialError(
      "ERR_EXTENSION_CREDENTIAL_UNKNOWN",
      `${extensionId}'s run approval declares no credential named ${JSON.stringify(name)}`,
    );
  }
  const approved = await deps.gate({
    type: CREDENTIAL_SET_ACTION_TYPE,
    payload: credentialGatePayload(extensionId, name),
  });
  if (!approved) {
    throw new ExtensionCredentialError(
      "ERR_EXTENSION_CREDENTIAL_NOT_APPROVED",
      `setting ${name} for ${extensionId} was not approved; nothing was written`,
    );
  }
  // The grant may have been revoked or replaced while the prompt was open: write only to the key
  // the grant still names, which must be the one resolved before the owner was asked.
  let after: string | undefined;
  try {
    after = declaredVaultKey(grantCredentials(deps, extensionId), name);
  } catch {
    after = undefined;
  }
  if (after !== vaultKey) {
    throw new ExtensionCredentialError(
      "ERR_EXTENSION_CREDENTIAL_CHANGED",
      `${extensionId}'s run approval changed while approval was pending; nothing was written`,
    );
  }
  try {
    await deps.vault.set(vaultKey, value);
  } catch {
    // The Vault's own message may name the key; it is deliberately not forwarded.
    throw new ExtensionCredentialError(
      "ERR_EXTENSION_CREDENTIAL_WRITE_FAILED",
      `the Vault refused to store ${name} for ${extensionId}`,
    );
  }
  return { name, set: true };
}

export async function extensionCredentialStatus(
  deps: CredentialReadDeps,
  extensionId: string,
): Promise<{ credentials: Array<{ name: string; set: boolean }> }> {
  const creds = grantCredentials(deps, extensionId);
  const credentials: Array<{ name: string; set: boolean }> = [];
  for (const name of Object.keys(creds).sort()) {
    const vaultKey = declaredVaultKey(creds, name);
    if (vaultKey === undefined) continue;
    const value = await deps.vault.get(vaultKey);
    credentials.push({ name, set: value !== null && value.trim() !== "" });
  }
  return { credentials };
}
