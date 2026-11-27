// packages/gateway/src/ipc/connector-rpc-handlers/oauth-token-keys.ts
// Where `connectorAuthOAuthPkce` (`auth.ts`) saves a PKCE token. Moved out of that file, whose size
// is locked by `audit:file-size`.
//
// A Google or Microsoft consent is saved under the provider's SHARED key (`google.oauth`,
// `microsoft.oauth`) by the flow and then mirrored to the service's own key. An own-key-only
// service (`GOOGLE_OWN_KEY_ONLY_SERVICES`: Google Calendar) is the exception: its token is saved
// straight to its own key and the shared key is never written. Since connectors 0.20.0 that token
// can carry `calendar` (event writes), and the shared key is what Drive, Photos, Meet and Gmail
// fall back to, so a calendar consent there would hand them a calendar-write token, and Gmail's
// scope read would report calendar scopes as Gmail's.
import { GOOGLE_OWN_KEY_ONLY_SERVICES } from "../../auth/google-access-token.ts";
import type { OAuthProvider } from "../../auth/pkce.ts";
import type { ConnectorServiceId } from "../../connectors/connector-catalog.ts";
import {
  perServiceOAuthVaultKey,
  sharedOAuthKey,
  writePerServiceOAuthKey,
} from "../../connectors/connector-vault.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";

const OWN_KEY_ONLY: ReadonlySet<string> = GOOGLE_OWN_KEY_ONLY_SERVICES;

/**
 * The key the PKCE flow saves `id`'s token under INSTEAD of the provider's shared key, or
 * `undefined` when the flow keeps its shared key (every service but an own-key-only Google one).
 */
export function ownOnlyOAuthSaveKey(
  id: ConnectorServiceId,
  provider: OAuthProvider,
): string | undefined {
  if (provider !== "google" || !OWN_KEY_ONLY.has(id)) return undefined;
  return perServiceOAuthVaultKey(id);
}

/** After a shared-key consent: copy the Google or Microsoft shared token to `id`'s own key. */
export async function mirrorSharedOAuthToken(
  vault: NimbusVault,
  id: ConnectorServiceId,
  provider: OAuthProvider,
): Promise<void> {
  if (provider === "google" || provider === "microsoft") {
    await writePerServiceOAuthKey(vault, id, sharedOAuthKey(provider));
  }
}
