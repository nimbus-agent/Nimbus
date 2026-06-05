// identity-boot.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { NimbusIdentityToml, NimbusScimToml } from "../config/nimbus-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { LongRunningEmit } from "../ipc/_lib/long-running.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildIdentityBoot } from "./identity-boot.ts";
import type { IdentityRuntimeDeps } from "./identity-runtime.ts";
import { IDENTITY_ID_TOKEN_KEY, IDENTITY_SCIM_BEARER_KEY } from "./identity-vault.ts";
import type { DeviceAuthResponse, OidcDiscovery, TokenResponse, ValidatedClaims } from "./types.ts";

const CFG: NimbusIdentityToml = {
  enabled: true,
  issuer: "https://acme",
  clientId: "c1",
  flow: "device_code",
  scopes: ["openid"],
  sessionGraceSeconds: 1000,
  revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300,
  jwksMaxAgeSeconds: 86400,
};
const SCIM: NimbusScimToml = { enabled: true };

function freshIndex(): LocalIndex {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 34);
  return new LocalIndex(db);
}

function fakeVault(): { vault: NimbusVault; store: Map<string, string> } {
  const m = new Map<string, string>();
  const vault: NimbusVault = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    listKeys: async () => [...m.keys()],
  };
  return { vault, store: m };
}

describe("buildIdentityBoot", () => {
  test("exposes config-derived fields", () => {
    const { vault } = fakeVault();
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(boot.enabled).toBe(true);
    expect(boot.issuer).toBe("https://acme");
    expect(boot.graceSeconds).toBe(1000);
  });

  test("resolveScimToken returns '' when no bearer is stored", async () => {
    const { vault } = fakeVault();
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(await boot.resolveScimToken()).toBe("");
  });

  test("resolveScimToken returns the stored bearer when set", async () => {
    const { vault, store } = fakeVault();
    store.set(IDENTITY_SCIM_BEARER_KEY, "scim-secret");
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(await boot.resolveScimToken()).toBe("scim-secret");
  });

  test("startLogin returns a string jobId synchronously (background job runs fully offline)", () => {
    const { vault } = fakeVault();
    // Fully override the runtime deps with instant-resolving offline fakes so the background login
    // job does NO real network I/O (no fetch to https://acme). The jobId is returned synchronously.
    const discovery: OidcDiscovery = {
      issuer: "https://acme",
      deviceAuthorizationEndpoint: "https://acme/device",
      tokenEndpoint: "https://acme/token",
      jwksUri: "https://acme/jwks",
    };
    const deviceAuth: DeviceAuthResponse = {
      deviceCode: "dc",
      userCode: "UC-1234",
      verificationUri: "https://acme/verify",
      interval: 1,
      expiresIn: 600,
    };
    const tokens: TokenResponse = { idToken: "h.p.s" };
    const claims: ValidatedClaims = {
      sub: "user-1",
      iss: "https://acme",
      aud: "c1",
      exp: Math.floor(Date.now() / 1000) + 3600,
      raw: {},
    };
    const deps: Partial<IdentityRuntimeDeps> = {
      discover: async () => discovery,
      requestDeviceCode: async () => deviceAuth,
      pollDeviceToken: async () => tokens,
      validateIdToken: async () => claims,
    };
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault, { deps });
    const handle = boot.startLogin();
    expect(typeof handle.jobId).toBe("string");
    expect(handle.jobId.startsWith("identity-login")).toBe(true);
  });

  test("bindLoginNotify is a no-op-safe binder", () => {
    const { vault } = fakeVault();
    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault);
    expect(() => boot.bindLoginNotify(() => {})).not.toThrow();
  });

  test("a full login through the REAL production deps with a fake fetchImpl (no network)", async () => {
    // Drive discover → device_authorization → token → jwks → validateIdToken through the actual
    // buildProductionDeps closures, with a canned-Response fetch so NO real network is touched.
    const { vault, store } = fakeVault();
    const issuer = "https://acme";
    const kid = "boot-k1";
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const { jwt, jwk } = await makeSignedJwt(
      { iss: issuer, aud: "c1", sub: "user-boot", email: "boot@acme.com", exp: expSec },
      kid,
    );

    const discoveryDoc = {
      issuer,
      device_authorization_endpoint: `${issuer}/device`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    };
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const seenUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);
      if (url.endsWith("/.well-known/openid-configuration")) return json(discoveryDoc);
      if (url.endsWith("/device"))
        return json({
          device_code: "dc-1",
          user_code: "UC-9999",
          verification_uri: `${issuer}/verify`,
          interval: 1,
          expires_in: 600,
        });
      if (url.endsWith("/token")) return json({ id_token: jwt, refresh_token: "ref-boot" });
      if (url.endsWith("/jwks")) return json({ keys: [jwk] });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const boot = buildIdentityBoot(CFG, SCIM, freshIndex(), vault, { fetchImpl });

    // Bind a notify that resolves once the background job emits loginDone (or loginError).
    const done = new Promise<{ method: string; payload: Record<string, unknown> }>((resolve) => {
      const notify: LongRunningEmit = (method, payload) => {
        if (method === "identity.loginDone" || method === "identity.loginError")
          resolve({ method, payload });
      };
      boot.bindLoginNotify(notify);
    });

    const handle = boot.startLogin();
    expect(handle.jobId.startsWith("identity-login")).toBe(true);

    const result = await done;
    expect(result.method).toBe("identity.loginDone");
    // The real closures executed end-to-end: discovery + device + token + jwks were all fetched,
    // the session was persisted from the validated claims, and the tokens were stored in the Vault.
    expect(seenUrls.some((u) => u.endsWith("/.well-known/openid-configuration"))).toBe(true);
    expect(seenUrls.some((u) => u.endsWith("/jwks"))).toBe(true);
    expect(boot.store.getSession(issuer)?.externalId).toBe("user-boot");
    expect(store.get(IDENTITY_ID_TOKEN_KEY)).toBe(jwt);
  });
});

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}
async function makeSignedJwt(claims: Record<string, unknown>, kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const header = { alg: "RS256", kid, typ: "JWT" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { jwt: `${signingInput}.${b64url(sig)}`, jwk: { ...jwk, kid, alg: "RS256" } };
}
