import { Config } from "../config.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { getValidVaultAccessToken } from "./oauth-registry.ts";
import { makeWorkdayDescriptor } from "./workday-oauth-descriptor.ts";

export async function getValidWorkdayAccessToken(vault: NimbusVault): Promise<string> {
  return getValidVaultAccessToken({
    descriptor: makeWorkdayDescriptor({
      tenantHost: Config.workdayTenantHost,
      tenant: Config.workdayTenant,
    }),
    vault,
    clientId: Config.oauthWorkdayClientId,
    clientSecret: Config.oauthWorkdayClientSecret,
    notConfiguredError: "Workday OAuth not configured; run: nimbus connector auth workday",
    parseErrors: {
      invalidJson: "Invalid workday.oauth vault payload",
      invalidPayload: "Invalid workday.oauth vault payload",
      missingAccess: "Missing Workday access token",
      missingRefresh: "Missing Workday refresh token",
      missingExpiry: "Missing token expiry",
    },
    emptyClientIdError:
      "Set NIMBUS_OAUTH_WORKDAY_CLIENT_ID and NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET for Workday token refresh",
  });
}
