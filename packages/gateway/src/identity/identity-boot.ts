// identity-boot.ts
// Phase 6 Slice 3 (Identity & Access) — production boot wiring.
//
// `buildIdentityBoot` assembles the identity subsystem from the already-committed
// Tasks 5/6/7/8/9 modules and exposes exactly the seams the IPC + HTTP layers need:
//   - `store`            — the IdentityStore over the gateway index DB
//   - `issuer`/`graceSeconds` — config values the federation gate + identity.status consult
//   - `startLogin()`     — kicks off the long-running device-code login job, returns { jobId }
//   - `resolveScimToken` — async resolver the SCIM HTTP route uses for bearer auth (Vault-only)
//   - `enabled`          — whether [identity] is on
//
// NOTE on the login progress notify/emit (Slice 3 design choice):
//   `buildIdentityBoot` runs at assemble time, BEFORE the IPC server's broadcast exists, and the
//   `startLogin: () => { jobId }` contract takes no notify argument (the identity dispatcher calls
//   it with no args). The LongRunningJobRegistry's `emit` is therefore forwarded to a mutable
//   `loginNotify` closure variable that defaults to a no-op-safe stub. Assemble binds the live
//   broadcast into it via `boot.bindLoginNotify(ipc.broadcast)` after `createIpcServer(...)` so the
//   device-code prompt is delivered on `identity.loginProgress` / `identity.loginDone` /
//   `identity.loginError`. If the binder is never called (e.g. in a unit test), emits are dropped
//   harmlessly — the registry isolates the background job and the login still completes.
import type { Database } from "bun:sqlite";
import type { NimbusIdentityToml, NimbusScimToml } from "../config/nimbus-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { type LongRunningEmit, LongRunningJobRegistry } from "../ipc/_lib/long-running.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { IdentityRuntime, type IdentityRuntimeDeps } from "./identity-runtime.ts";
import { IdentityStore } from "./identity-store.ts";
import { readScimBearer } from "./identity-vault.ts";
import { JwksCache } from "./jwks-cache.ts";
import { pollDeviceToken, requestDeviceCode } from "./oidc-device-flow.ts";
import { fetchOidcDiscovery } from "./oidc-discovery.ts";
import { form, type OidcDiscovery, parseTokenResponse, type TokenResponse } from "./types.ts";
import { IdTokenVerifier } from "./verifier.ts";

/** Default device-code poll interval (RFC 8628 default) when the IdP omits one. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** Generous absolute deadline for the device-code grant — most IdPs expire the user_code well before this. */
const DEFAULT_DEVICE_DEADLINE_MS = 15 * 60 * 1000;

export interface IdentityBoot {
  readonly store: IdentityStore;
  readonly issuer: string;
  readonly graceSeconds: number;
  readonly startLogin: () => { jobId: string };
  readonly resolveScimToken: () => Promise<string>;
  readonly enabled: boolean;
  /**
   * Binds the live IPC broadcast so login progress is delivered to subscribers. Safe to call once,
   * after `createIpcServer(...)`. Until called (or if never called) login emits are dropped.
   */
  bindLoginNotify(notify: LongRunningEmit): void;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `grant_type=refresh_token` POST mirroring the device-flow form helper.
 *  Exported for direct branch-coverage testing (B2); still used internally by buildProductionDeps. */
export async function refreshTokens(
  d: OidcDiscovery,
  clientId: string,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const res = await fetchImpl(
    d.tokenEndpoint,
    form({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
  );
  if (!res.ok) throw new Error(`identity: token refresh failed (${res.status})`);
  return parseTokenResponse(await res.json());
}

function buildProductionDeps(
  cfg: NimbusIdentityToml,
  db: Database,
  log: (msg: string) => void,
  fetchImpl: typeof fetch,
): IdentityRuntimeDeps {
  const jwks = new JwksCache(db, fetchImpl, { maxAgeSeconds: cfg.jwksMaxAgeSeconds });
  return {
    discover: (issuer) => fetchOidcDiscovery(issuer, fetchImpl),
    requestDeviceCode: (d, clientId, scopes) => requestDeviceCode(d, clientId, scopes, fetchImpl),
    pollDeviceToken: (d, clientId, deviceCode, onPoll) =>
      pollDeviceToken(d, clientId, deviceCode, {
        fetchLike: fetchImpl,
        sleep: realSleep,
        intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
        deadlineMs: Date.now() + DEFAULT_DEVICE_DEADLINE_MS,
        now: () => Date.now(),
        onPoll,
      }),
    // The verifier discovers the jwks_uri lazily so we never block boot on a network round-trip.
    validateIdToken: async (jwt, nowMs) => {
      const d = await fetchOidcDiscovery(cfg.issuer, fetchImpl);
      const verifier = new IdTokenVerifier(jwks, {
        issuer: cfg.issuer,
        clientId: cfg.clientId,
        jwksUri: d.jwksUri,
      });
      return verifier.validateIdToken(jwt, nowMs);
    },
    refreshTokens: (d, clientId, refresh) => {
      log("identity: attempting token refresh");
      return refreshTokens(d, clientId, refresh, fetchImpl);
    },
  };
}

export function buildIdentityBoot(
  cfg: NimbusIdentityToml,
  // `scimCfg` is intentionally not consumed here: assemble independently gates the SCIM HTTP wiring
  // on `scimCfg.enabled` (only then is `resolveScimToken` handed to the read-only HTTP server), so
  // the boot always exposes the resolver and the param is kept for contract symmetry with assemble.
  _scimCfg: NimbusScimToml,
  index: LocalIndex,
  vault: NimbusVault,
  opts?: {
    log?: (msg: string) => void;
    deps?: Partial<IdentityRuntimeDeps>;
    /** Injectable `fetch` for the production dep closures — defaults to the global `fetch`. Tests
     *  pass a canned-Response fetch to exercise the real discover/device/token/jwks closures offline. */
    fetchImpl?: typeof fetch;
  },
): IdentityBoot {
  const db = index.getDatabase();
  const store = new IdentityStore(db);

  // No-op-safe until assemble binds the live broadcast (see file header note).
  let loginNotify: LongRunningEmit = () => {};
  const registry = new LongRunningJobRegistry();

  // Production deps with optional test/caller overrides (keeps the unit test fully offline).
  const deps: IdentityRuntimeDeps = {
    ...buildProductionDeps(
      cfg,
      db,
      (m) => loginNotify("identity.loginProgress", { message: m }),
      opts?.fetchImpl ?? fetch,
    ),
    ...opts?.deps,
  };

  const runtime = new IdentityRuntime({
    cfg,
    store,
    vault,
    now: () => Date.now(),
    deps,
    // Wire the P2 refresh-failure warn sink when assemble (or a test) provides one.
    ...(opts?.log === undefined ? {} : { log: opts.log }),
  });

  const startLogin = (): { jobId: string } =>
    registry.start({
      jobIdPrefix: "identity-login",
      progressMethod: "identity.loginProgress",
      doneMethod: "identity.loginDone",
      errorMethod: "identity.loginError",
      emit: (method, payload) => loginNotify(method, payload),
      run: async (progress) => {
        await runtime.login((info) => {
          progress({ verificationUri: info.verificationUri, userCode: info.userCode });
        });
        return { ok: true };
      },
    });

  return {
    store,
    issuer: cfg.issuer,
    graceSeconds: cfg.sessionGraceSeconds,
    enabled: cfg.enabled,
    startLogin,
    resolveScimToken: async () => (await readScimBearer(vault)) ?? "",
    bindLoginNotify(notify: LongRunningEmit): void {
      loginNotify = notify;
    },
  };
}
