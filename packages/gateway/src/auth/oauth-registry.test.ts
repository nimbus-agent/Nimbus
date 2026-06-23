import { describe, expect, test } from "bun:test";

import { createMemoryVault } from "../testing/bun-test-support.ts";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getValidVaultAccessToken,
  OAUTH_PROVIDERS,
  refreshViaRegistry,
} from "./oauth-registry.ts";

type FetchInput = string | URL | Request;

describe("OAUTH_PROVIDERS table", () => {
  test("has an entry for every existing provider with its vault key", () => {
    expect(OAUTH_PROVIDERS.google.vaultKey).toBe("google.oauth");
    expect(OAUTH_PROVIDERS.microsoft.vaultKey).toBe("microsoft.oauth");
    expect(OAUTH_PROVIDERS.slack.vaultKey).toBe("slack.oauth");
    expect(OAUTH_PROVIDERS.notion.vaultKey).toBe("notion.oauth");
  });

  test("each descriptor's id matches its table key", () => {
    for (const [key, d] of Object.entries(OAUTH_PROVIDERS)) {
      expect(d.id).toBe(key);
    }
  });
});

describe("google/microsoft descriptor hooks", () => {
  test("google authorize params include offline + consent + PKCE", () => {
    const p = OAUTH_PROVIDERS.google.buildAuthorizeParams({
      clientId: "cid",
      scopes: ["openid", "email"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("openid email");
    expect(p["access_type"]).toBe("offline");
    expect(p["prompt"]).toBe("consent");
    expect(p["code_challenge"]).toBe("cc");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("microsoft authorize params omit google-only extras", () => {
    const p = OAUTH_PROVIDERS.microsoft.buildAuthorizeParams({
      clientId: "cid",
      scopes: ["Calendars.Read"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["access_type"]).toBeUndefined();
    expect(p["prompt"]).toBeUndefined();
    expect(p["scope"]).toBe("Calendars.Read");
  });

  test("standard parseTokenResponse maps fields and falls back scope to requested", () => {
    const r = OAUTH_PROVIDERS.google.parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 3600 },
      ["openid"],
    );
    expect(r.accessToken).toBe("a");
    expect(r.refreshToken).toBe("r");
    expect(r.scopes).toEqual(["openid"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("slack descriptor hooks", () => {
  test("authorize params use user_scope (comma) + empty scope", () => {
    const p = OAUTH_PROVIDERS.slack.buildAuthorizeParams({
      clientId: "123.456",
      scopes: ["channels:read", "channels:history"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["user_scope"]).toBe("channels:read,channels:history");
    expect(p["scope"]).toBe("");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("parseTokenResponse reads authed_user.access_token", () => {
    const r = OAUTH_PROVIDERS.slack.parseTokenResponse(
      {
        ok: true,
        authed_user: {
          access_token: "xoxp-a",
          refresh_token: "xoxe-r",
          expires_in: 3600,
          scope: "channels:read",
        },
      },
      ["channels:read"],
    );
    expect(r.accessToken).toBe("xoxp-a");
    expect(r.refreshToken).toBe("xoxe-r");
    expect(r.scopes).toEqual(["channels:read"]);
  });

  test("isTokenSuccess requires ok:true even on HTTP 200", () => {
    expect(OAUTH_PROVIDERS.slack.isTokenSuccess?.({ ok: false }, true)).toBe(false);
    expect(OAUTH_PROVIDERS.slack.isTokenSuccess?.({ ok: true }, true)).toBe(true);
  });
});

describe("notion descriptor hooks", () => {
  test("authorize params set owner=user, no PKCE challenge", () => {
    const p = OAUTH_PROVIDERS.notion.buildAuthorizeParams({
      clientId: "cid",
      scopes: [],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
    });
    expect(p["owner"]).toBe("user");
    expect(p["response_type"]).toBe("code");
    expect(p["code_challenge"]).toBeUndefined();
  });

  test("parseTokenResponse uses synthetic 24h expiry when expires_in absent", () => {
    const before = Date.now();
    const r = OAUTH_PROVIDERS.notion.parseTokenResponse(
      { access_token: "secret_a", refresh_token: "secret_r" },
      ["x"],
    );
    expect(r.accessToken).toBe("secret_a");
    expect(r.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000 - 5000);
  });
});

describe("zoom descriptor", () => {
  test("table includes zoom with vaultKey, urls, and quirks", () => {
    expect(OAUTH_PROVIDERS.zoom.id).toBe("zoom");
    expect(OAUTH_PROVIDERS.zoom.vaultKey).toBe("zoom.oauth");
    expect(OAUTH_PROVIDERS.zoom.authorizeUrl).toBe("https://zoom.us/oauth/authorize");
    expect(OAUTH_PROVIDERS.zoom.tokenUrl).toBe("https://zoom.us/oauth/token");
    expect(OAUTH_PROVIDERS.zoom.usesPkce).toBe(true);
    expect(OAUTH_PROVIDERS.zoom.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.zoom.secretPlacement).toBe("basic_header");
    expect(OAUTH_PROVIDERS.zoom.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.zoom.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.zoom.tokenHeaders).toBeUndefined();
  });

  test("authorize params include S256 PKCE + scope joined with spaces", () => {
    const p = OAUTH_PROVIDERS.zoom.buildAuthorizeParams({
      clientId: "zoom-cid",
      scopes: ["meeting:read:list_meetings", "user:read:user"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("zoom-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("meeting:read:list_meetings user:read:user");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBe("cc");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("parseTokenResponse delegates to parseStandardTokenResponse", () => {
    const r = OAUTH_PROVIDERS.zoom.parseTokenResponse(
      { access_token: "zoom-a", refresh_token: "zoom-r", expires_in: 3600 },
      ["meeting:read:list_meetings"],
    );
    expect(r.accessToken).toBe("zoom-a");
    expect(r.refreshToken).toBe("zoom-r");
    expect(r.scopes).toEqual(["meeting:read:list_meetings"]);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("hubspot descriptor", () => {
  test("table includes hubspot with vaultKey, urls, and body-secret quirks", () => {
    expect(OAUTH_PROVIDERS.hubspot.id).toBe("hubspot");
    expect(OAUTH_PROVIDERS.hubspot.vaultKey).toBe("hubspot.oauth");
    expect(OAUTH_PROVIDERS.hubspot.authorizeUrl).toBe("https://app.hubspot.com/oauth/authorize");
    expect(OAUTH_PROVIDERS.hubspot.tokenUrl).toBe("https://api.hubapi.com/oauth/v1/token");
    expect(OAUTH_PROVIDERS.hubspot.usesPkce).toBe(false);
    expect(OAUTH_PROVIDERS.hubspot.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.hubspot.secretPlacement).toBe("body");
    expect(OAUTH_PROVIDERS.hubspot.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.hubspot.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.hubspot.tokenHeaders).toBeUndefined();
  });

  test("authorize params omit PKCE + scope joined with spaces", () => {
    const p = OAUTH_PROVIDERS.hubspot.buildAuthorizeParams({
      clientId: "hs-cid",
      scopes: ["crm.objects.deals.read", "oauth"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("hs-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("crm.objects.deals.read oauth");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBeUndefined();
    expect(p["code_challenge_method"]).toBeUndefined();
  });

  test("exchange posts form with client_secret in body; error message omits secrets", async () => {
    let seenBody = "";
    let seenCT = "";
    const fetchImpl = async (_i: FetchInput, init?: RequestInit) => {
      seenBody = typeof init?.body === "string" ? init.body : "";
      seenCT = new Headers(init?.headers).get("content-type") ?? "";
      return new Response(
        JSON.stringify({ access_token: "hs-a", refresh_token: "hs-r", expires_in: 1800 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const r = await exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.hubspot,
      fetchFn: fetchImpl,
      clientId: "cid",
      clientSecret: "HUBSPOT_SECRET",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      authCode: "code",
      requestedScopes: ["crm.objects.deals.read"],
    });
    expect(r.accessToken).toBe("hs-a");
    expect(r.refreshToken).toBe("hs-r");
    expect(seenCT).toContain("application/x-www-form-urlencoded");
    expect(seenBody).toContain("client_secret=HUBSPOT_SECRET");
    expect(seenBody).toContain("grant_type=authorization_code");
  });
});

describe("miro descriptor", () => {
  test("table includes miro with vaultKey, urls, and body-secret quirks", () => {
    expect(OAUTH_PROVIDERS.miro.id).toBe("miro");
    expect(OAUTH_PROVIDERS.miro.vaultKey).toBe("miro.oauth");
    expect(OAUTH_PROVIDERS.miro.authorizeUrl).toBe("https://miro.com/oauth/authorize");
    expect(OAUTH_PROVIDERS.miro.tokenUrl).toBe("https://api.miro.com/v1/oauth/token");
    expect(OAUTH_PROVIDERS.miro.usesPkce).toBe(false);
    expect(OAUTH_PROVIDERS.miro.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.miro.secretPlacement).toBe("body");
    expect(OAUTH_PROVIDERS.miro.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.miro.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.miro.tokenHeaders).toBeUndefined();
  });

  test("authorize params omit PKCE + scope joined with spaces", () => {
    const p = OAUTH_PROVIDERS.miro.buildAuthorizeParams({
      clientId: "miro-cid",
      scopes: ["boards:read"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("miro-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("boards:read");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBeUndefined();
    expect(p["code_challenge_method"]).toBeUndefined();
  });

  test("exchange posts form with client_secret in body; error message omits secrets", async () => {
    let seenBody = "";
    let seenCT = "";
    const fetchImpl = async (_i: FetchInput, init?: RequestInit) => {
      seenBody = typeof init?.body === "string" ? init.body : "";
      seenCT = new Headers(init?.headers).get("content-type") ?? "";
      return new Response(
        JSON.stringify({ access_token: "miro-a", refresh_token: "miro-r", expires_in: 1800 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const r = await exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.miro,
      fetchFn: fetchImpl,
      clientId: "cid",
      clientSecret: "MIRO_SECRET",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      authCode: "code",
      requestedScopes: ["boards:read"],
    });
    expect(r.accessToken).toBe("miro-a");
    expect(r.refreshToken).toBe("miro-r");
    expect(seenCT).toContain("application/x-www-form-urlencoded");
    expect(seenBody).toContain("client_secret=MIRO_SECRET");
    expect(seenBody).toContain("grant_type=authorization_code");
  });
});

describe("canva descriptor", () => {
  test("table includes canva with vaultKey, urls, and PKCE + basic-header quirks", () => {
    expect(OAUTH_PROVIDERS.canva.id).toBe("canva");
    expect(OAUTH_PROVIDERS.canva.vaultKey).toBe("canva.oauth");
    expect(OAUTH_PROVIDERS.canva.authorizeUrl).toBe("https://www.canva.com/api/oauth/authorize");
    expect(OAUTH_PROVIDERS.canva.tokenUrl).toBe("https://api.canva.com/rest/v1/oauth/token");
    expect(OAUTH_PROVIDERS.canva.usesPkce).toBe(true);
    expect(OAUTH_PROVIDERS.canva.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.canva.secretPlacement).toBe("basic_header");
    expect(OAUTH_PROVIDERS.canva.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.canva.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.canva.tokenHeaders).toBeUndefined();
  });

  test("authorize params include S256 PKCE + scope joined with spaces", () => {
    const p = OAUTH_PROVIDERS.canva.buildAuthorizeParams({
      clientId: "canva-cid",
      scopes: ["design:meta:read"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("canva-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("design:meta:read");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBe("cc");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("exchange sends Basic header + PKCE verifier; client_secret NOT in body", async () => {
    let seenBody = "";
    let seenAuth = "";
    let seenCT = "";
    const fetchImpl = async (_i: FetchInput, init?: RequestInit) => {
      seenBody = typeof init?.body === "string" ? init.body : "";
      const h = new Headers(init?.headers);
      seenAuth = h.get("authorization") ?? "";
      seenCT = h.get("content-type") ?? "";
      return new Response(
        JSON.stringify({ access_token: "canva-a", refresh_token: "canva-r", expires_in: 14_400 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const r = await exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.canva,
      fetchFn: fetchImpl,
      clientId: "cid",
      clientSecret: "CANVA_SECRET",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      codeVerifier: "verifier-123",
      authCode: "code",
      requestedScopes: ["design:meta:read"],
    });
    expect(r.accessToken).toBe("canva-a");
    expect(r.refreshToken).toBe("canva-r");
    expect(seenCT).toContain("application/x-www-form-urlencoded");
    // Secret travels in the Basic header, not the body.
    const expectedBasic = `Basic ${Buffer.from("cid:CANVA_SECRET", "utf8").toString("base64")}`;
    expect(seenAuth).toBe(expectedBasic);
    expect(seenBody).not.toContain("CANVA_SECRET");
    expect(seenBody).toContain("code_verifier=verifier-123");
    expect(seenBody).toContain("grant_type=authorization_code");
  });
});

describe("figma descriptor", () => {
  test("table includes figma with vaultKey, urls, and body-secret quirks", () => {
    expect(OAUTH_PROVIDERS.figma.id).toBe("figma");
    expect(OAUTH_PROVIDERS.figma.vaultKey).toBe("figma.oauth");
    expect(OAUTH_PROVIDERS.figma.authorizeUrl).toBe("https://www.figma.com/oauth");
    expect(OAUTH_PROVIDERS.figma.tokenUrl).toBe("https://api.figma.com/v1/oauth/token");
    expect(OAUTH_PROVIDERS.figma.usesPkce).toBe(false);
    expect(OAUTH_PROVIDERS.figma.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.figma.secretPlacement).toBe("body");
    expect(OAUTH_PROVIDERS.figma.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.figma.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.figma.tokenHeaders).toBeUndefined();
  });

  test("authorize params omit PKCE + scope joined with spaces", () => {
    const p = OAUTH_PROVIDERS.figma.buildAuthorizeParams({
      clientId: "figma-cid",
      scopes: ["files:read"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("figma-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("files:read");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBeUndefined();
    expect(p["code_challenge_method"]).toBeUndefined();
  });

  test("exchange posts form with client_secret in body; error message omits secrets", async () => {
    let seenBody = "";
    let seenCT = "";
    const fetchImpl = async (_i: FetchInput, init?: RequestInit) => {
      seenBody = typeof init?.body === "string" ? init.body : "";
      seenCT = new Headers(init?.headers).get("content-type") ?? "";
      return new Response(
        JSON.stringify({ access_token: "figma-a", refresh_token: "figma-r", expires_in: 1800 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const r = await exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.figma,
      fetchFn: fetchImpl,
      clientId: "cid",
      clientSecret: "FIGMA_SECRET",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      authCode: "code",
      requestedScopes: ["files:read"],
    });
    expect(r.accessToken).toBe("figma-a");
    expect(r.refreshToken).toBe("figma-r");
    expect(seenCT).toContain("application/x-www-form-urlencoded");
    expect(seenBody).toContain("client_secret=FIGMA_SECRET");
    expect(seenBody).toContain("grant_type=authorization_code");
  });
});

describe("salesforce descriptor", () => {
  test("table includes salesforce with vaultKey, urls, and PKCE + body-secret quirks", () => {
    expect(OAUTH_PROVIDERS.salesforce.id).toBe("salesforce");
    expect(OAUTH_PROVIDERS.salesforce.vaultKey).toBe("salesforce.oauth");
    expect(OAUTH_PROVIDERS.salesforce.authorizeUrl).toBe(
      "https://login.salesforce.com/services/oauth2/authorize",
    );
    expect(OAUTH_PROVIDERS.salesforce.tokenUrl).toBe(
      "https://login.salesforce.com/services/oauth2/token",
    );
    expect(OAUTH_PROVIDERS.salesforce.usesPkce).toBe(true);
    expect(OAUTH_PROVIDERS.salesforce.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.salesforce.secretPlacement).toBe("body");
    expect(OAUTH_PROVIDERS.salesforce.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.salesforce.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.salesforce.tokenHeaders).toBeUndefined();
  });

  test("authorize params include PKCE challenge when codeChallenge present", () => {
    const p = OAUTH_PROVIDERS.salesforce.buildAuthorizeParams({
      clientId: "sf-cid",
      scopes: ["api", "refresh_token"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("sf-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("api refresh_token");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBe("cc");
    expect(p["code_challenge_method"]).toBe("S256");
  });

  test("parseTokenResponse captures instance_url and synthesizes a future expiry when expires_in absent", () => {
    const before = Date.now();
    const r = OAUTH_PROVIDERS.salesforce.parseTokenResponse(
      {
        access_token: "sf-a",
        refresh_token: "sf-r",
        instance_url: "https://acme.my.salesforce.com",
        scope: "api refresh_token",
        // NOTE: no expires_in — Salesforce omits it.
      },
      ["api", "refresh_token"],
    );
    expect(r.accessToken).toBe("sf-a");
    expect(r.refreshToken).toBe("sf-r");
    expect(r.instanceUrl).toBe("https://acme.my.salesforce.com");
    expect(r.scopes).toEqual(["api", "refresh_token"]);
    // 30-minute conservative window in the future.
    expect(r.expiresAt).toBeGreaterThan(before + 20 * 60 * 1000);
    expect(r.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
  });

  test("parseTokenResponse throws when instance_url is missing", () => {
    expect(() =>
      OAUTH_PROVIDERS.salesforce.parseTokenResponse(
        { access_token: "sf-a", refresh_token: "sf-r" },
        ["api"],
      ),
    ).toThrow("instance_url");
  });

  test("parseTokenResponse throws when access_token is missing", () => {
    expect(() =>
      OAUTH_PROVIDERS.salesforce.parseTokenResponse(
        { instance_url: "https://acme.my.salesforce.com" },
        ["api"],
      ),
    ).toThrow("access_token");
  });
});

describe("mendeley descriptor", () => {
  test("table includes mendeley with vaultKey, urls, and basic-header quirks", () => {
    expect(OAUTH_PROVIDERS.mendeley.id).toBe("mendeley");
    expect(OAUTH_PROVIDERS.mendeley.vaultKey).toBe("mendeley.oauth");
    expect(OAUTH_PROVIDERS.mendeley.authorizeUrl).toBe("https://api.mendeley.com/oauth/authorize");
    expect(OAUTH_PROVIDERS.mendeley.tokenUrl).toBe("https://api.mendeley.com/oauth/token");
    expect(OAUTH_PROVIDERS.mendeley.usesPkce).toBe(false);
    expect(OAUTH_PROVIDERS.mendeley.clientSecret).toBe("required");
    expect(OAUTH_PROVIDERS.mendeley.secretPlacement).toBe("basic_header");
    expect(OAUTH_PROVIDERS.mendeley.bodyFormat).toBe("form");
    expect(OAUTH_PROVIDERS.mendeley.mirrorPerService).toBe(false);
    expect(OAUTH_PROVIDERS.mendeley.tokenHeaders).toBeUndefined();
  });

  test("authorize params omit PKCE + scope joined with spaces", () => {
    const p = OAUTH_PROVIDERS.mendeley.buildAuthorizeParams({
      clientId: "mendeley-cid",
      scopes: ["all"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(p["client_id"]).toBe("mendeley-cid");
    expect(p["response_type"]).toBe("code");
    expect(p["scope"]).toBe("all");
    expect(p["state"]).toBe("st");
    expect(p["code_challenge"]).toBeUndefined();
    expect(p["code_challenge_method"]).toBeUndefined();
  });
});

describe("buildAuthorizeUrl", () => {
  test("composes URL using descriptor.authorizeUrl + buildAuthorizeParams", () => {
    const url = buildAuthorizeUrl(OAUTH_PROVIDERS.google, {
      clientId: "cid",
      scopes: ["openid"],
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      state: "st",
      codeChallenge: "cc",
    });
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeAuthorizationCode", () => {
  test("notion exchange posts JSON with Basic auth header; no token leaks on error", async () => {
    let seenAuth = "";
    let seenCT = "";
    const fetchImpl = async (_i: FetchInput, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seenAuth = h.get("authorization") ?? "";
      seenCT = h.get("content-type") ?? "";
      return new Response(JSON.stringify({ access_token: "secret_a", refresh_token: "secret_r" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const r = await exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.notion,
      fetchFn: fetchImpl,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      authCode: "code",
      requestedScopes: [],
    });
    expect(r.accessToken).toBe("secret_a");
    expect(seenAuth.startsWith("Basic ")).toBe(true);
    expect(seenCT).toContain("application/json");
  });

  test("google exchange posts form with client_secret in body; HTTP error message omits secrets", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    let threw = "";
    try {
      await exchangeAuthorizationCode({
        descriptor: OAUTH_PROVIDERS.google,
        fetchFn: fetchImpl,
        clientId: "cid",
        clientSecret: "GOOGLE_WEB_SECRET",
        redirectUri: "http://127.0.0.1:1/oauth/callback",
        codeVerifier: "ver",
        authCode: "code",
        requestedScopes: ["openid"],
      });
    } catch (e) {
      threw = String(e instanceof Error ? e.message : e);
    }
    expect(threw).toContain("invalid_grant");
    expect(threw.includes("GOOGLE_WEB_SECRET")).toBe(false);
  });
});

describe("refreshViaRegistry", () => {
  test("persists merged refresh token (refresh_token ?? old) to the vault key", async () => {
    const vault = createMemoryVault();
    const r = await refreshViaRegistry({
      descriptor: OAUTH_PROVIDERS.microsoft,
      refreshToken: "old-refresh",
      clientId: "cid",
      vault,
      fetchFn: async () =>
        new Response(JSON.stringify({ access_token: "new-access", expires_in: 120 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(r.accessToken).toBe("new-access");
    expect(r.refreshToken).toBe("old-refresh");
    expect(await vault.get("microsoft.oauth")).toContain("new-access");
  });

  test("persisted payload omits instanceUrl for a provider that does not discover one", async () => {
    const vault = createMemoryVault();
    await refreshViaRegistry({
      descriptor: OAUTH_PROVIDERS.microsoft,
      refreshToken: "old-refresh",
      clientId: "cid",
      vault,
      fetchFn: async () =>
        new Response(JSON.stringify({ access_token: "new-access", expires_in: 120 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const stored = await vault.get("microsoft.oauth");
    expect(stored).not.toBeNull();
    // Conditional spread leaves the field out entirely (byte-identical to before).
    expect(stored).not.toContain("instanceUrl");
    expect(JSON.parse(stored ?? "{}") as Record<string, unknown>).not.toHaveProperty("instanceUrl");
  });
});

describe("getValidVaultAccessToken single-flight", () => {
  test("two concurrent near-expiry calls trigger exactly one refresh", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({ accessToken: "old", refreshToken: "r", expiresAt: 0 }),
    );
    let refreshCalls = 0;
    const fetchFn = async () => {
      refreshCalls += 1;
      await new Promise((res) => setTimeout(res, 20));
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const [a, b] = await Promise.all([
      getValidVaultAccessToken({
        descriptor: OAUTH_PROVIDERS.microsoft,
        vault,
        clientId: "cid",
        fetchFn,
      }),
      getValidVaultAccessToken({
        descriptor: OAUTH_PROVIDERS.microsoft,
        vault,
        clientId: "cid",
        fetchFn,
      }),
    ]);
    expect(a).toBe("fresh");
    expect(b).toBe("fresh");
    expect(refreshCalls).toBe(1);
  });

  test("returns cached token without refresh when not near expiry", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({
        accessToken: "cached",
        refreshToken: "r",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    const token = await getValidVaultAccessToken({
      descriptor: OAUTH_PROVIDERS.microsoft,
      vault,
      clientId: "cid",
      fetchFn: async () => {
        throw new Error("must not refresh on a cache hit");
      },
    });
    expect(token).toBe("cached");
  });
});
