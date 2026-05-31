import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  getValidVaultOAuthAccessToken,
  microsoftOAuthAccessFromConfig,
} from "./oauth-vault-tokens.ts";

export async function getValidMicrosoftAccessToken(vault: NimbusVault): Promise<string> {
  const c = microsoftOAuthAccessFromConfig();
  return getValidVaultOAuthAccessToken({ vault, ...c });
}
