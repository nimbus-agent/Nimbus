// identity-vault.ts
// I18/D14: the ONLY file naming the raw-token Vault keys. The static D14 check asserts these
// literals appear nowhere outside packages/gateway/src/identity/.
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export const IDENTITY_ID_TOKEN_KEY = "identity.oidc.id_token";
export const IDENTITY_REFRESH_TOKEN_KEY = "identity.oidc.refresh_token";
export const IDENTITY_SCIM_BEARER_KEY = "identity.scim.bearer";

export async function storeOidcTokens(
  vault: NimbusVault,
  tokens: { idToken: string; refreshToken?: string },
): Promise<void> {
  await vault.set(IDENTITY_ID_TOKEN_KEY, tokens.idToken);
  if (tokens.refreshToken !== undefined)
    await vault.set(IDENTITY_REFRESH_TOKEN_KEY, tokens.refreshToken);
}
export async function readRefreshToken(vault: NimbusVault): Promise<string | null> {
  return vault.get(IDENTITY_REFRESH_TOKEN_KEY);
}
export async function clearOidcTokens(vault: NimbusVault): Promise<void> {
  await vault.delete(IDENTITY_ID_TOKEN_KEY);
  await vault.delete(IDENTITY_REFRESH_TOKEN_KEY);
}
export async function readScimBearer(vault: NimbusVault): Promise<string | null> {
  return vault.get(IDENTITY_SCIM_BEARER_KEY);
}
export async function writeScimBearer(vault: NimbusVault, token: string): Promise<void> {
  await vault.set(IDENTITY_SCIM_BEARER_KEY, token);
}
