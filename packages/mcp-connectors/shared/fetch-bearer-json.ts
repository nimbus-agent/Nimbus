/**
 * fetch-bearer-json — re-export of the Bearer-auth JSON fetch helpers now owned
 * by `@nimbus-dev/sdk/connector-kit`.
 *
 * These helpers originated here and were upstreamed to the SDK in 1.11.0. The
 * SDK is now the single owner; this module stays as the connector-facing import
 * path so the ~99 connectors keep their existing relative imports.
 *
 * Named re-exports, deliberately not `export *` — see the note in
 * `mcp-tool-kit.ts`.
 *
 * `resolveUrlWithBase` remains the SSRF chokepoint that refuses a cross-origin
 * absolute URL before a credential-bearing fetch; that behaviour now lives in
 * the SDK and is covered by `fetch-bearer-json.test.ts` through this re-export.
 */

export type { BearerJsonFetchResult } from "@nimbus-dev/sdk/connector-kit";
export { fetchBearerAuthorizedJson, resolveUrlWithBase } from "@nimbus-dev/sdk/connector-kit";
