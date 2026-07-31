/**
 * rest-tool-kit — re-export of the shared REST fetch wrapper for Bearer-auth
 * connectors, now owned by `@nimbus-dev/sdk/connector-kit`.
 *
 * These helpers originated here and were upstreamed to the SDK in 1.11.0. The
 * SDK is now the single owner; this module stays as the connector-facing import
 * path so the ~99 connectors keep their existing relative imports.
 *
 * Named re-exports, deliberately not `export *` — see the note in
 * `mcp-tool-kit.ts`.
 */

export type {
  RestFetcherConfig,
  RestFetchResult,
  RestToolRegistrar,
} from "@nimbus-dev/sdk/connector-kit";
export { makeRestFetcher, makeRestToolRegistrar } from "@nimbus-dev/sdk/connector-kit";
