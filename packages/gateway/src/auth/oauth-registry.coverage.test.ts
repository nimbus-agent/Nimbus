/**
 * The token-response parsers' refusals, their fallbacks, and the error text a failed exchange or an
 * unconfigured credential produces — the paths `oauth-registry.test.ts` does not reach.
 */
import { describe, expect, test } from "bun:test";

import { createMemoryVault } from "../testing/bun-test-support.ts";
import {
  exchangeAuthorizationCode,
  getValidVaultAccessToken,
  OAUTH_PROVIDERS,
  type OAuthProviderDescriptor,
  type PKCEResult,
  parseStandardTokenResponse,
  refreshViaRegistry,
} from "./oauth-registry.ts";

const REQUESTED = ["scope.requested"];

/** Runs `parse` and asserts `expiresAt` landed `seconds` after the call, to the millisecond window. */
function expectExpiresIn(parse: () => PKCEResult, seconds: number): PKCEResult {
  const before = Date.now();
  const r = parse();
  const after = Date.now();
  expect(r.expiresAt).toBeGreaterThanOrEqual(before + seconds * 1000);
  expect(r.expiresAt).toBeLessThanOrEqual(after + seconds * 1000);
  return r;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseStandardTokenResponse", () => {
  test.each([
    ["null", null],
    ["a bare string", "access-token"],
  ])("refuses %s as not JSON-shaped", (_label, json) => {
    expect(() => parseStandardTokenResponse(json, REQUESTED)).toThrow(
      "Token response was not valid JSON",
    );
  });

  test.each([
    ["absent", {}],
    ["empty", { access_token: "" }],
    ["not a string", { access_token: 42 }],
  ])("refuses an access_token that is %s", (_label, json) => {
    expect(() => parseStandardTokenResponse(json, REQUESTED)).toThrow(
      "Token response missing access_token",
    );
  });

  test.each([
    ["absent", { access_token: "a" }],
    ["negative", { access_token: "a", expires_in: -1 }],
    ["an unparseable string", { access_token: "a", expires_in: "soon" }],
  ])("refuses an expires_in that is %s", (_label, json) => {
    expect(() => parseStandardTokenResponse(json, REQUESTED)).toThrow(
      "Token response missing expires_in",
    );
  });

  test("reads a string expires_in, and falls back on a non-string refresh and a blank scope", () => {
    const r = expectExpiresIn(
      () =>
        parseStandardTokenResponse(
          { access_token: "a", expires_in: "3600", refresh_token: 7, scope: "   " },
          REQUESTED,
        ),
      3600,
    );
    expect(r.accessToken).toBe("a");
    expect(r.refreshToken).toBe("");
    expect(r.scopes).toEqual(REQUESTED);
  });
});

describe("Slack token response", () => {
  const parse = (json: unknown): PKCEResult =>
    OAUTH_PROVIDERS.slack.parseTokenResponse(json, REQUESTED);

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "ok"],
  ])("refuses %s at the top level", (_label, json) => {
    expect(() => parse(json)).toThrow("Invalid Slack OAuth response");
  });

  test.each([
    ["absent", {}],
    ["null", { authed_user: null }],
    ["an array", { authed_user: [] }],
  ])("refuses an authed_user that is %s", (_label, json) => {
    expect(() => parse(json)).toThrow("Slack OAuth response missing authed_user");
  });

  test("refuses a user with no access token", () => {
    expect(() => parse({ authed_user: {} })).toThrow("Slack user access token missing");
    expect(() => parse({ authed_user: { access_token: "" } })).toThrow(
      "Slack user access token missing",
    );
  });

  test("refuses a user with no refresh token, naming the fix", () => {
    for (const refresh_token of [undefined, ""]) {
      expect(() =>
        parse({
          authed_user: {
            access_token: "xoxp",
            ...(refresh_token === undefined ? {} : { refresh_token }),
          },
        }),
      ).toThrow(
        "Slack refresh token missing; enable token rotation on the Slack app and re-authorize",
      );
    }
  });

  test("reads a string expires_in and splits a comma/space scope list", () => {
    const r = expectExpiresIn(
      () =>
        parse({
          authed_user: {
            access_token: "xoxp",
            refresh_token: "xoxe",
            expires_in: "7200",
            scope: "channels:read, users:read  chat:write",
          },
        }),
      7200,
    );
    expect(r.refreshToken).toBe("xoxe");
    expect(r.scopes).toEqual(["channels:read", "users:read", "chat:write"]);
  });

  test.each([
    ["zero", 0],
    ["not finite", Number.POSITIVE_INFINITY],
    ["absent", undefined],
  ])("an expires_in that is %s falls back to twelve hours", (_label, expires_in) => {
    const r = expectExpiresIn(
      () =>
        parse({
          authed_user: {
            access_token: "xoxp",
            refresh_token: "xoxe",
            ...(expires_in === undefined ? {} : { expires_in }),
            scope: "",
          },
        }),
      43_200,
    );
    expect(r.scopes).toEqual(REQUESTED); // a blank scope falls back to what was requested
  });
});

describe("Notion token response", () => {
  const parse = (json: unknown): PKCEResult =>
    OAUTH_PROVIDERS.notion.parseTokenResponse(json, REQUESTED);

  test("refuses a non-object response", () => {
    expect(() => parse(null)).toThrow("Notion token response invalid");
    expect(() => parse([])).toThrow("Notion token response invalid");
  });

  test("refuses a missing or empty access token", () => {
    expect(() => parse({})).toThrow("Notion token response missing access_token");
    expect(() => parse({ access_token: "" })).toThrow("Notion token response missing access_token");
  });

  test("a response without a refresh token stores none, with a one-day window", () => {
    const r = expectExpiresIn(() => parse({ access_token: "ntn_x", refresh_token: "" }), 86_400);
    expect(r).toMatchObject({ accessToken: "ntn_x", refreshToken: "", scopes: REQUESTED });
  });
});

describe("Salesforce token response", () => {
  const parse = (json: unknown): PKCEResult =>
    OAUTH_PROVIDERS.salesforce.parseTokenResponse(json, REQUESTED);
  const INSTANCE = "https://acme.my.salesforce.com";

  test("refuses a non-object response", () => {
    expect(() => parse([])).toThrow("Salesforce token response invalid");
    expect(() => parse(null)).toThrow("Salesforce token response invalid");
  });

  test("honours an expires_in when the org sends one, and ignores a non-string scope", () => {
    const r = expectExpiresIn(
      () =>
        parse({
          access_token: "sf",
          refresh_token: 9,
          instance_url: INSTANCE,
          // Deliberately NOT 1800: that is also the default window, and a test using it could not
          // tell "honoured the org's value" from "ignored it".
          expires_in: "5400",
          scope: 42,
        }),
      5400,
    );
    expect(r.refreshToken).toBe("");
    expect(r.scopes).toEqual(REQUESTED);
    expect(r.instanceUrl).toBe(INSTANCE);
  });

  test("a zero expires_in gets the conservative thirty-minute window", () => {
    const r = expectExpiresIn(
      () => parse({ access_token: "sf", instance_url: INSTANCE, expires_in: 0, scope: "api id" }),
      30 * 60,
    );
    expect(r.scopes).toEqual(["api", "id"]);
  });
});

describe("authorize params without a PKCE challenge", () => {
  const args = {
    clientId: "cid",
    scopes: ["a", "b"],
    redirectUri: "http://127.0.0.1:1/cb",
    state: "st",
  };

  test("a PKCE provider sends no challenge fields when none was generated", () => {
    const p = OAUTH_PROVIDERS.microsoft.buildAuthorizeParams(args);
    expect(p).toEqual({
      client_id: "cid",
      redirect_uri: "http://127.0.0.1:1/cb",
      response_type: "code",
      scope: "a b",
      state: "st",
    });
  });

  test("Slack sends no challenge fields when none was generated", () => {
    const p = OAUTH_PROVIDERS.slack.buildAuthorizeParams(args);
    expect(p).toEqual({
      client_id: "cid",
      user_scope: "a,b",
      redirect_uri: "http://127.0.0.1:1/cb",
      state: "st",
      scope: "",
    });
  });
});

describe("a failed token exchange reports what the provider said, and only that", () => {
  const exchange = (body: unknown, status = 400): Promise<PKCEResult> =>
    exchangeAuthorizationCode({
      descriptor: OAUTH_PROVIDERS.microsoft,
      fetchFn: async () => jsonResponse(body, status),
      clientId: "cid",
      redirectUri: "http://127.0.0.1:1/cb",
      authCode: "code",
      requestedScopes: REQUESTED,
    });

  test.each([
    ["an array body", []],
    ["a null body", null],
    ["an empty error code", { error: "" }],
    ["a non-string error code", { error: 401 }],
  ])("%s gives the bare failure", async (_label, body) => {
    await expect(exchange(body)).rejects.toThrow(/^Token exchange failed$/);
  });

  test("a blank error_description is left out of the hint", async () => {
    await expect(exchange({ error: "invalid_grant", error_description: "   " })).rejects.toThrow(
      /^Token exchange failed \(invalid_grant\)$/,
    );
  });

  test("a body that is not JSON at all is named as such, even on HTTP 200", async () => {
    await expect(
      exchangeAuthorizationCode({
        descriptor: OAUTH_PROVIDERS.microsoft,
        fetchFn: async () => new Response("<html>Service Unavailable</html>", { status: 200 }),
        clientId: "cid",
        redirectUri: "http://127.0.0.1:1/cb",
        authCode: "code",
        requestedScopes: REQUESTED,
      }),
    ).rejects.toThrow(/^Token endpoint returned non-JSON$/);
  });
});

describe("refreshViaRegistry", () => {
  test("an empty instanceUrl from a parser is not persisted", async () => {
    const vault = createMemoryVault();
    const descriptor: OAuthProviderDescriptor = {
      ...OAUTH_PROVIDERS.salesforce,
      parseTokenResponse: () => ({
        accessToken: "fresh",
        refreshToken: "",
        expiresAt: 5_000,
        scopes: [],
        instanceUrl: "",
      }),
    };
    const r = await refreshViaRegistry({
      descriptor,
      refreshToken: "kept",
      clientId: "cid",
      vault,
      fetchFn: async () => jsonResponse({}, 200),
    });
    expect(r.refreshToken).toBe("kept"); // an empty refresh in the response keeps the old one
    expect(JSON.parse((await vault.get("salesforce.oauth")) ?? "null")).toEqual({
      accessToken: "fresh",
      refreshToken: "kept",
      expiresAt: 5_000,
      scopes: [],
    });
  });

  test("Salesforce: a rotated refresh token and the tenant host are persisted under the trimmed key", async () => {
    const vault = createMemoryVault();
    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const r = await refreshViaRegistry({
      descriptor: OAUTH_PROVIDERS.salesforce,
      refreshToken: "old-refresh",
      clientId: "sf-client",
      clientSecret: "sf-secret",
      vault,
      persistVaultKey: "  salesforce.alt_oauth  ",
      fetchFn: async (input, init) => {
        sent.push({
          url: String(input),
          body: String(init?.body),
          headers: { ...(init?.headers as Record<string, string>) },
        });
        return jsonResponse(
          {
            access_token: "sf-access",
            refresh_token: "rotated-refresh",
            instance_url: "https://acme.my.salesforce.com",
            expires_in: 3600,
          },
          200,
        );
      },
    });

    // A body-placed secret travels in the form body, never as a Basic header.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(OAUTH_PROVIDERS.salesforce.tokenUrl);
    expect(sent[0]?.headers["Authorization"]).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(sent[0]?.body))).toEqual({
      client_id: "sf-client",
      client_secret: "sf-secret",
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    });

    expect(r.refreshToken).toBe("rotated-refresh"); // a rotated token replaces the old one
    const stored = JSON.parse((await vault.get("salesforce.alt_oauth")) ?? "null") as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      accessToken: "sf-access",
      refreshToken: "rotated-refresh",
      instanceUrl: "https://acme.my.salesforce.com",
    });
    // Persisted ONLY under the caller's key, not also under the descriptor's default.
    expect(await vault.get("salesforce.oauth")).toBeNull();
  });
});

describe("getValidVaultAccessToken default messages", () => {
  test("an unconfigured provider is named in the default error", async () => {
    await expect(
      getValidVaultAccessToken({
        descriptor: OAUTH_PROVIDERS.zoom,
        vault: createMemoryVault(),
        clientId: "cid",
      }),
    ).rejects.toThrow("zoom OAuth not configured");
  });

  test("an expired token with no client id names the provider rather than refreshing", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "hubspot.oauth",
      JSON.stringify({ accessToken: "stale", refreshToken: "r", expiresAt: 0 }),
    );
    let fetched = 0;
    await expect(
      getValidVaultAccessToken({
        descriptor: OAUTH_PROVIDERS.hubspot,
        vault,
        clientId: "",
        fetchFn: async () => {
          fetched += 1;
          return jsonResponse({}, 200);
        },
      }),
    ).rejects.toThrow("Missing client id for hubspot token refresh");
    expect(fetched).toBe(0);
  });
});
