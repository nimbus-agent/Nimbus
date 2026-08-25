import { getValidCanvaAccessToken } from "../auth/canva-access-token.ts";
import { getValidFigmaAccessToken } from "../auth/figma-access-token.ts";
import { getValidGoogleAccessToken } from "../auth/google-access-token.ts";
import { getValidHubspotAccessToken } from "../auth/hubspot-access-token.ts";
import { getValidMendeleyAccessToken } from "../auth/mendeley-access-token.ts";
import { getValidMicrosoftAccessToken } from "../auth/microsoft-access-token.ts";
import { getValidMiroAccessToken } from "../auth/miro-access-token.ts";
import { getValidNotionAccessToken } from "../auth/notion-access-token.ts";
import { getValidSalesforceAccessToken } from "../auth/salesforce-access-token.ts";
import { getValidSlackAccessToken } from "../auth/slack-access-token.ts";
import { getValidWorkdayAccessToken } from "../auth/workday-access-token.ts";
import { getValidZoomAccessToken } from "../auth/zoom-access-token.ts";
import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * Which OAuth helper resolves an access token for which connector.
 *
 * This exists so `SyncContext` can offer `accessToken()` without every connector holding a vault
 * handle to pass into its own helper. The mapping is a property of the SERVICE, not a caller
 * choice, which is why it is resolved from the bound service id rather than taken as an argument —
 * the same reasoning that keeps the service id out of `getSecret`'s parameters.
 *
 * The four Google connectors share one helper parameterised by service, and OneDrive / Outlook /
 * Teams share one Microsoft helper outright. Keeping the auth imports in this one module rather
 * than in `sync-capabilities.ts` stops the capability layer from depending on fourteen auth
 * modules.
 *
 * EVERY entry is an arrow, including the ones that could be a bare reference. A bare
 * `slack: getValidSlackAccessToken` captures the function at module-init time, which defeats
 * `mock.module` — and 25 slack tests stub exactly that module. Deferring the lookup to call time
 * keeps those tests able to intercept it. CLAUDE.md prefers DI over mock.module for this reason;
 * this is the cheapest way to not break the tests that already chose otherwise.
 *
 * `salesforce` is registered for its TOKEN only. It needs a second value from the same OAuth
 * exchange — the per-tenant instance URL — so `getValidSalesforceAuth` takes this resolver plus the
 * connector's scoped `getSecret` rather than a vault handle. Removing the handle in the final task
 * turned that into a compile error exactly as predicted, which is the intended forcing function.
 */
const RESOLVERS: Partial<Record<ConnectorServiceId, (vault: NimbusVault) => Promise<string>>> = {
  canva: (v) => getValidCanvaAccessToken(v),
  figma: (v) => getValidFigmaAccessToken(v),
  gmail: (v) => getValidGoogleAccessToken(v, "gmail"),
  google_drive: (v) => getValidGoogleAccessToken(v, "google_drive"),
  google_meet: (v) => getValidGoogleAccessToken(v, "google_meet"),
  google_photos: (v) => getValidGoogleAccessToken(v, "google_photos"),
  hubspot: (v) => getValidHubspotAccessToken(v),
  mendeley: (v) => getValidMendeleyAccessToken(v),
  miro: (v) => getValidMiroAccessToken(v),
  notion: (v) => getValidNotionAccessToken(v),
  onedrive: (v) => getValidMicrosoftAccessToken(v),
  outlook: (v) => getValidMicrosoftAccessToken(v),
  salesforce: (v) => getValidSalesforceAccessToken(v),
  slack: (v) => getValidSlackAccessToken(v),
  teams: (v) => getValidMicrosoftAccessToken(v),
  workday: (v) => getValidWorkdayAccessToken(v),
  zoom: (v) => getValidZoomAccessToken(v),
};

export function resolveAccessTokenForService(
  vault: NimbusVault,
  serviceId: ConnectorServiceId,
): Promise<string> {
  const resolver = RESOLVERS[serviceId];
  if (resolver === undefined) {
    // Throws rather than resolving to "" — an empty token would be sent as a real Authorization
    // header and fail at the far end with an opaque 401, far from the actual mistake.
    throw new Error(
      `no OAuth access-token resolver is registered for "${serviceId}". Add one to ` +
        "sync/access-token-registry.ts if that connector authenticates with OAuth.",
    );
  }
  return resolver(vault);
}

export function hasAccessTokenResolver(serviceId: ConnectorServiceId): boolean {
  return RESOLVERS[serviceId] !== undefined;
}
