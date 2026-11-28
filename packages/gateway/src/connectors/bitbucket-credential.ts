// Bitbucket credential resolution (Phase 7, slice 9; owner ruling D5). Atlassian removed app passwords on
// 2026-07-28, so the connector moves to an Atlassian API token (`bitbucket.email` + `bitbucket.api_token`). The old pair
// (`bitbucket.username` + `bitbucket.app_password`) is still read as a fallback so an existing install keeps
// working until the owner stores a token. Basic auth has the same shape for both: `<user>:<secret>`.
//
// Every site that needs the Bitbucket credential reads it here; none reads the four keys directly.
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { readConnectorSecret } from "./connector-vault.ts";

export type BitbucketCredentialKey = "email" | "api_token" | "username" | "app_password";

export type BitbucketCredential =
  | { readonly kind: "token"; readonly user: string; readonly secret: string }
  | { readonly kind: "app_password"; readonly user: string; readonly secret: string }
  | { readonly kind: "none" };

/** Shown by `nimbus connector status bitbucket` while only the old pair is stored. */
export const BITBUCKET_APP_PASSWORD_DEPRECATION =
  "deprecated: app password (Atlassian removed app passwords on 2026-07-28; store an API token)";

function pair(user: string | null, secret: string | null): { user: string; secret: string } | null {
  const u = user?.trim() ?? "";
  const s = secret?.trim() ?? "";
  return u === "" || s === "" ? null : { user: u, secret: s };
}

/** The API token pair when both halves are non-blank, else the app password pair, else `none`. Values are trimmed. */
export async function readBitbucketCredential(
  read: (key: BitbucketCredentialKey) => Promise<string | null>,
): Promise<BitbucketCredential> {
  const token = pair(await read("email"), await read("api_token"));
  if (token !== null) return { kind: "token", ...token };
  const legacy = pair(await read("username"), await read("app_password"));
  if (legacy !== null) return { kind: "app_password", ...legacy };
  return { kind: "none" };
}

/** {@link readBitbucketCredential} over the Vault. */
export function readBitbucketVaultCredential(vault: NimbusVault): Promise<BitbucketCredential> {
  return readBitbucketCredential((key) => readConnectorSecret(vault, "bitbucket", key));
}
