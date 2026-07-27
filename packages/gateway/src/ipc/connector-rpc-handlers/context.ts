// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { ConnectorOAuthProfile } from "../../connectors/connector-catalog.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";

export type ConnectorRpcHit = { kind: "hit"; value: unknown };

/** One OAuth provider's client credentials plus the help text shown when they are missing. */
export interface OAuthClientConfig {
  /** Empty string when unset — the fail-closed guard in `connectorAuthOAuthPkce` keys off exactly this. */
  readonly clientId: string;
  readonly emptyClientIdMessage: string;
  /** Present when the provider has a config-driven client secret AND it is set. */
  readonly clientSecret?: string;
  /** Present when the provider's `clientSecret` is `required` (for the missing-secret error). */
  readonly clientSecretMissingHelp?: string;
}

/**
 * Resolves a provider's OAuth client config.
 *
 * Production uses the `Config`-backed resolver in `auth.ts`. Tests inject one so the
 * fail-closed guards can be proven directly, instead of depending on `Config`'s
 * module-load env snapshot — which is only blankable by the FIRST test file in a
 * process to import `config.ts`, and therefore silently stops working in a combined
 * run (see issue #812).
 */
export type OAuthClientConfigResolver = (profile: ConnectorOAuthProfile) => OAuthClientConfig;

export type ConnectorRpcHandlerContext = {
  rec: Record<string, unknown> | undefined;
  vault: NimbusVault;
  localIndex: LocalIndex;
  openUrl: (url: string) => Promise<void>;
  syncScheduler: SyncScheduler | undefined;
  connectorMesh: LazyConnectorMesh | undefined;
  notify?: (method: string, params: Record<string, unknown>) => void;
  /**
   * Test seam. Omitted in production, where `auth.ts` falls back to its
   * `Config`-backed `oauthClientConfigForProvider`.
   */
  resolveOAuthClientConfig?: OAuthClientConfigResolver;
};
