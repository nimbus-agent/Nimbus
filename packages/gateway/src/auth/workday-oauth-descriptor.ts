import { Config } from "../config.ts";
import {
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type OAuthProviderDescriptor,
  parseStandardTokenResponse,
  standardAuthorizeParams,
} from "./oauth-registry.ts";

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function makeWorkdayDescriptor(args: {
  tenantHost: string;
  tenant: string;
}): OAuthProviderDescriptor {
  const host = trimSlash(args.tenantHost.trim());
  const tenant = args.tenant.trim();
  if (host === "" || tenant === "") {
    throw new Error(
      "Workday tenant not configured; set NIMBUS_WORKDAY_TENANT_HOST and NIMBUS_WORKDAY_TENANT",
    );
  }
  const base = `${host}/ccx/oauth2/${encodeURIComponent(tenant)}`;
  return {
    id: "workday",
    // Reference the allow-listed literal from the OAUTH_PROVIDERS registry rather than
    // constructing a new vault-key literal here (static D11 — vault keys live in the
    // registry's allow-listed site, not in per-connector factories).
    vaultKey: OAUTH_PROVIDERS.workday.vaultKey,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  };
}

export function resolveOAuthDescriptor(provider: OAuthProvider): OAuthProviderDescriptor {
  if (provider === "workday") {
    return makeWorkdayDescriptor({
      tenantHost: Config.workdayTenantHost,
      tenant: Config.workdayTenant,
    });
  }
  return OAUTH_PROVIDERS[provider];
}
