// identity-runtime.ts
import type { NimbusIdentityToml } from "../config/nimbus-toml.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { IdentityStore } from "./identity-store.ts";
import { readRefreshToken, storeOidcTokens } from "./identity-vault.ts";
import type { DeviceAuthResponse, OidcDiscovery, TokenResponse, ValidatedClaims } from "./types.ts";

export interface IdentityRuntimeDeps {
  discover(issuer: string): Promise<OidcDiscovery>;
  requestDeviceCode(
    d: OidcDiscovery,
    clientId: string,
    scopes: readonly string[],
  ): Promise<DeviceAuthResponse>;
  pollDeviceToken(
    d: OidcDiscovery,
    clientId: string,
    deviceCode: string,
    onPoll: () => void,
  ): Promise<TokenResponse>;
  validateIdToken(jwt: string, nowMs: number): Promise<ValidatedClaims>;
  refreshTokens?(d: OidcDiscovery, clientId: string, refreshToken: string): Promise<TokenResponse>;
}

export class IdentityRuntime {
  private lastRevalidateMs: number | null = null;
  constructor(
    private readonly o: {
      cfg: NimbusIdentityToml;
      store: IdentityStore;
      vault: NimbusVault;
      now: () => number;
      deps: IdentityRuntimeDeps;
      /** Warn sink for non-fatal refresh failures (review P2). Production wiring passes the structured
       *  logger's warn; defaults to a no-op so tests can assert it without a logger dependency. */
      log?: (msg: string) => void;
    },
  ) {}

  /** Begin device-code login; returns the user-facing prompt, then completes in the background-awaitable promise. */
  async login(onProgress: (info: DeviceAuthResponse) => void): Promise<DeviceAuthResponse> {
    const { cfg, deps } = this.o;
    const d = await deps.discover(cfg.issuer);
    const auth = await deps.requestDeviceCode(d, cfg.clientId, cfg.scopes);
    onProgress(auth);
    const tokens = await deps.pollDeviceToken(d, cfg.clientId, auth.deviceCode, () => {});
    await this.persist(tokens);
    return auth;
  }

  private async persist(tokens: TokenResponse): Promise<void> {
    const claims = await this.o.deps.validateIdToken(tokens.idToken, this.o.now());
    const now = this.o.now();
    this.o.store.upsertSession({
      issuer: this.o.cfg.issuer,
      externalId: claims.sub,
      email: claims.email ?? null,
      validatedAt: now,
      expiresAt: claims.exp * 1000,
      status: "active",
      claimsJson: JSON.stringify({ sub: claims.sub, email: claims.email }),
    });
    await storeOidcTokens(this.o.vault, {
      idToken: tokens.idToken,
      ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
    });
  }

  /** Single throttled refresh attempt. Never throws on refresh failure (grace is the fallback). */
  async revalidateSession(): Promise<void> {
    const { cfg, store, now, deps } = this.o;
    const t = now();
    if (
      this.lastRevalidateMs !== null &&
      t - this.lastRevalidateMs < cfg.revalidateIntervalSeconds * 1000
    )
      return;
    this.lastRevalidateMs = t;
    const session = store.getSession(cfg.issuer);
    if (session?.status !== "active") return;
    if (t < session.expiresAt - cfg.tokenRefreshSkewSeconds * 1000) return; // not near expiry
    if (deps.refreshTokens === undefined) return;
    const refresh = await readRefreshToken(this.o.vault);
    if (refresh === null) return;
    try {
      const d = await deps.discover(cfg.issuer);
      const tokens = await deps.refreshTokens(d, cfg.clientId, refresh);
      await this.persist(tokens);
    } catch (e) {
      // offline / revoked → leave session as-is (expires_at NOT advanced, status NOT forced to
      // expired); the grace window governs isOperatorValid() until now > expires_at + grace.
      this.o.log?.(
        `identity: token refresh failed, relying on grace window: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
