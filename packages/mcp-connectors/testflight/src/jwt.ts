import type { AppStoreConnectJwtParams } from "@nimbus-dev/sdk";

/**
 * App Store Connect credential plumbing.
 *
 * The ES256 JWT signer lives in `@nimbus-dev/sdk` (`signAppStoreConnectJwt`) so
 * the gateway sync and this MCP server share one signer across the package
 * boundary. This module holds only the connector's env glue: reading the
 * spawn-injected `TESTFLIGHT_*` credentials.
 */

/** Read the three `TESTFLIGHT_*` env vars; throws if any is unset. */
export function jwtParamsFromEnv(): AppStoreConnectJwtParams {
  const issuerId = process.env["TESTFLIGHT_ISSUER_ID"]?.trim();
  const keyId = process.env["TESTFLIGHT_KEY_ID"]?.trim();
  const privateKeyPem = process.env["TESTFLIGHT_PRIVATE_KEY"];
  if (issuerId === undefined || issuerId === "") {
    throw new Error("TESTFLIGHT_ISSUER_ID is not set");
  }
  if (keyId === undefined || keyId === "") {
    throw new Error("TESTFLIGHT_KEY_ID is not set");
  }
  if (privateKeyPem === undefined || privateKeyPem.trim() === "") {
    throw new Error("TESTFLIGHT_PRIVATE_KEY is not set");
  }
  return { issuerId, keyId, privateKeyPem };
}
