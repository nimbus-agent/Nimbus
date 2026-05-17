import { describe, expect, it } from "bun:test";
import type { PKCEFetch } from "../../../src/auth/pkce.ts";
import {
  pkceCodeChallengeS256,
  refreshAccessToken,
  refreshNotionToken,
  refreshSlackUserToken,
  runPKCEFlow,
} from "../../../src/auth/pkce.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

// ---------------------------------------------------------------------------
// pkceCodeChallengeS256
// ---------------------------------------------------------------------------

describe("pkceCodeChallengeS256", () => {
  it("matches the RFC 7636 Appendix B test vector", async () => {
    // RFC 7636 §Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // produces challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await pkceCodeChallengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("produces base64url output (no '+', '/', or '=')", async () => {
    const challenge = await pkceCodeChallengeS256("a".repeat(43));
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  it("Google: posts to token endpoint and returns new access token", async () => {
    const vault = createMockVault();

    let capturedReq: Request | undefined;
    const fakeFetch: PKCEFetch = async (input, init) => {
      capturedReq = new Request(input, init);
      return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await refreshAccessToken("stored-refresh", "google", "client-x", {
      vault,
      fetchImpl: fakeFetch,
    });

    expect(result.accessToken).toBe("new-access");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(capturedReq!.url).toContain("oauth2.googleapis.com/token");
    const body = await capturedReq!.text();
    expect(body).toContain("refresh_token=stored-refresh");
    expect(body).toContain("client_id=client-x");
    expect(body).toContain("grant_type=refresh_token");
  });

  it("Google: persists refreshed tokens to vault under google.oauth key", async () => {
    const vault = createMockVault();

    const fakeFetch: PKCEFetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "persisted-access",
          expires_in: 3600,
          refresh_token: "new-refresh",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await refreshAccessToken("old-refresh", "google", "client-x", {
      vault,
      fetchImpl: fakeFetch,
    });

    const stored = await vault.get("google.oauth");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as { accessToken: string; refreshToken: string };
    expect(parsed.accessToken).toBe("persisted-access");
    expect(parsed.refreshToken).toBe("new-refresh");
  });

  it("Microsoft: posts to v2.0 token endpoint", async () => {
    const vault = createMockVault();

    let capturedUrl = "";
    const fakeFetch: PKCEFetch = async (input, init) => {
      capturedUrl = new Request(input, init).url;
      return new Response(JSON.stringify({ access_token: "ms-new", expires_in: 1800 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await refreshAccessToken("ms-refresh", "microsoft", "c", {
      vault,
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/,
    );
  });

  it("throws on non-200 response", async () => {
    const vault = createMockVault();
    const fakeFetch: PKCEFetch = async () => new Response("invalid_grant", { status: 400 });
    await expect(
      refreshAccessToken("x", "google", "c", { vault, fetchImpl: fakeFetch }),
    ).rejects.toThrow();
  });

  it("uses persistVaultKey when provided instead of provider default", async () => {
    const vault = createMockVault();

    const fakeFetch: PKCEFetch = async () =>
      new Response(JSON.stringify({ access_token: "custom-access", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await refreshAccessToken("r", "google", "c", {
      vault,
      fetchImpl: fakeFetch,
      persistVaultKey: "google.drive",
    });

    const defaultKey = await vault.get("google.oauth");
    const customKey = await vault.get("google.drive");
    // Default key should not have been written
    expect(defaultKey).toBeNull();
    // Custom key should have the data
    expect(customKey).not.toBeNull();
  });

  it("includes clientSecret in body when provided", async () => {
    const vault = createMockVault();

    let capturedBody = "";
    const fakeFetch: PKCEFetch = async (input, init) => {
      const req = new Request(input, init);
      capturedBody = await req.text();
      return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await refreshAccessToken("r", "google", "c", {
      vault,
      fetchImpl: fakeFetch,
      clientSecret: "my-secret",
    });

    expect(capturedBody).toContain("client_secret=my-secret");
  });

  it("falls back to input refresh token when response omits refresh_token", async () => {
    const vault = createMockVault();
    const fakeFetch: PKCEFetch = async () =>
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await refreshAccessToken("original-refresh", "google", "client-x", {
      vault,
      fetchImpl: fakeFetch,
    });

    expect(result.refreshToken).toBe("original-refresh");
    expect(result.accessToken).toBe("new-access");
  });
});

// ---------------------------------------------------------------------------
// refreshSlackUserToken
// ---------------------------------------------------------------------------

describe("refreshSlackUserToken", () => {
  it("posts to slack.com/api/oauth.v2.access and returns authed_user.access_token", async () => {
    const vault = createMockVault();

    let capturedUrl = "";
    const fakeFetch: PKCEFetch = async (input, init) => {
      capturedUrl = new Request(input, init).url;
      return new Response(
        JSON.stringify({
          ok: true,
          authed_user: {
            access_token: "slack-new",
            refresh_token: "slack-new-refresh",
            expires_in: 7200,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const r = await refreshSlackUserToken("slack-refresh", "slack-cid", {
      vault,
      fetchImpl: fakeFetch,
    });

    expect(r.accessToken).toBe("slack-new");
    expect(r.refreshToken).toBe("slack-new-refresh");
    expect(capturedUrl).toContain("slack.com/api/oauth.v2.access");
  });

  it("persists tokens to vault under slack.oauth key", async () => {
    const vault = createMockVault();

    const fakeFetch: PKCEFetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          authed_user: {
            access_token: "slack-a",
            refresh_token: "slack-r",
            expires_in: 3600,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await refreshSlackUserToken("old-r", "cid", { vault, fetchImpl: fakeFetch });

    const stored = await vault.get("slack.oauth");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as { accessToken: string };
    expect(parsed.accessToken).toBe("slack-a");
  });

  it("throws when response body has ok: false", async () => {
    const vault = createMockVault();
    const fakeFetch: PKCEFetch = async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await expect(
      refreshSlackUserToken("x", "c", { vault, fetchImpl: fakeFetch }),
    ).rejects.toThrow();
  });

  it("throws when HTTP status is not 200", async () => {
    const vault = createMockVault();
    const fakeFetch: PKCEFetch = async () => new Response("error", { status: 503 });
    await expect(
      refreshSlackUserToken("x", "c", { vault, fetchImpl: fakeFetch }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// refreshNotionToken
// ---------------------------------------------------------------------------

describe("refreshNotionToken", () => {
  it("posts to api.notion.com/v1/oauth/token with Basic auth header", async () => {
    const vault = createMockVault();

    let capturedReq: Request | undefined;
    const fakeFetch: PKCEFetch = async (input, init) => {
      capturedReq = new Request(input, init);
      return new Response(JSON.stringify({ access_token: "notion-new" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await refreshNotionToken("notion-refresh", "notion-cid", "notion-secret", {
      vault,
      fetchImpl: fakeFetch,
    });

    expect(capturedReq!.url).toContain("api.notion.com/v1/oauth/token");
    const auth = capturedReq!.headers.get("Authorization");
    expect(auth).toMatch(/^Basic /);
    const decoded = Buffer.from(auth!.slice(6), "base64").toString();
    expect(decoded).toBe("notion-cid:notion-secret");
  });

  it("sends grant_type=refresh_token with refresh_token in body", async () => {
    const vault = createMockVault();

    let capturedBodyText = "";
    const fakeFetch: PKCEFetch = async (input, init) => {
      const req = new Request(input, init);
      capturedBodyText = await req.text();
      return new Response(JSON.stringify({ access_token: "notion-a" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await refreshNotionToken("my-refresh-token", "cid", "secret", {
      vault,
      fetchImpl: fakeFetch,
    });

    const body = JSON.parse(capturedBodyText) as { grant_type: string; refresh_token: string };
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("my-refresh-token");
  });

  it("persists tokens to vault under notion.oauth key", async () => {
    const vault = createMockVault();

    const fakeFetch: PKCEFetch = async () =>
      new Response(JSON.stringify({ access_token: "notion-stored" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await refreshNotionToken("r", "cid", "sec", { vault, fetchImpl: fakeFetch });

    const stored = await vault.get("notion.oauth");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as { accessToken: string };
    expect(parsed.accessToken).toBe("notion-stored");
  });

  it("throws on non-200 response", async () => {
    const vault = createMockVault();
    const fakeFetch: PKCEFetch = async () => new Response("forbidden", { status: 403 });
    await expect(
      refreshNotionToken("r", "cid", "sec", { vault, fetchImpl: fakeFetch }),
    ).rejects.toThrow();
  });

  it("falls back to the supplied refresh token when response omits refresh_token", async () => {
    // Notion may omit refresh_token on rotation — the implementation falls back to the input token.
    const vault = createMockVault();

    const fakeFetch: PKCEFetch = async () =>
      new Response(
        JSON.stringify({ access_token: "notion-a" }), // no refresh_token field
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await refreshNotionToken("original-refresh", "cid", "sec", {
      vault,
      fetchImpl: fakeFetch,
    });

    expect(result.refreshToken).toBe("original-refresh");
  });
});

// ---------------------------------------------------------------------------
// runPKCEFlow — end-to-end: real Bun.serve callback server
// ---------------------------------------------------------------------------

async function waitForOpenUrl(signal: { value: string }, timeoutMs = 5_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (signal.value) return resolve();
      if (Date.now() > deadline)
        return reject(new Error(`openUrl was never called within ${timeoutMs} ms`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("runPKCEFlow", () => {
  it("completes the OAuth flow: opens URL, receives callback, exchanges code, persists tokens", async () => {
    const vault = createMockVault();

    const capturedUrl = { value: "" };
    const openUrl = async (url: string): Promise<void> => {
      capturedUrl.value = url;
    };

    let tokenRequest: Request | undefined;
    const fakeFetch: PKCEFetch = async (input, init) => {
      tokenRequest = new Request(input, init);
      return new Response(
        JSON.stringify({
          access_token: "flow-access",
          refresh_token: "flow-refresh",
          expires_in: 3600,
          scope: "read write",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // Start the flow. No redirectPort supplied → OS picks an ephemeral port.
    const flowPromise = runPKCEFlow({
      provider: "google",
      clientId: "test-client",
      scopes: ["read", "write"],
      vault,
      openUrl,
      fetchImpl: fakeFetch,
    });

    // Wait until openUrl was called (guarantees the server is bound + auth URL is ready).
    await waitForOpenUrl(capturedUrl);
    const capturedAuthUrl = capturedUrl.value;

    const authUrlParsed = new URL(capturedAuthUrl);
    const redirectUri = authUrlParsed.searchParams.get("redirect_uri");
    const state = authUrlParsed.searchParams.get("state");
    expect(redirectUri).toBeTruthy();
    expect(state).toBeTruthy();

    // Verify standard PKCE / OAuth params in the auth URL.
    expect(authUrlParsed.hostname).toBe("accounts.google.com");
    expect(authUrlParsed.searchParams.get("response_type")).toBe("code");
    expect(authUrlParsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrlParsed.searchParams.get("client_id")).toBe("test-client");

    // Drive the callback: GET redirect_uri?code=auth-code-xyz&state=<extracted state>.
    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("code", "auth-code-xyz");
    callbackUrl.searchParams.set("state", state!);
    const callbackResp = await fetch(callbackUrl.toString());
    expect(callbackResp.status).toBe(200);

    // Now wait for the full flow to resolve.
    const result = await flowPromise;
    expect(result.accessToken).toBe("flow-access");
    expect(result.refreshToken).toBe("flow-refresh");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.scopes).toEqual(["read", "write"]);

    // Token exchange request — verify wire contract.
    expect(tokenRequest).toBeDefined();
    const body = await tokenRequest!.text();
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-xyz");
    expect(body).toContain("code_verifier=");
    expect(body).toContain("client_id=test-client");
    expect(tokenRequest!.url).toContain("oauth2.googleapis.com/token");

    // Vault persistence — tokens stored under google.oauth as a JSON blob.
    const stored = await vault.get("google.oauth");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scopes: string[];
    };
    expect(parsed.accessToken).toBe("flow-access");
    expect(parsed.refreshToken).toBe("flow-refresh");
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());
    expect(parsed.scopes).toEqual(["read", "write"]);
  }, 15_000);

  it("rejects when the callback arrives with ?error=access_denied (user denied)", async () => {
    const vault = createMockVault();

    const capturedUrl = { value: "" };
    const openUrl = async (url: string): Promise<void> => {
      capturedUrl.value = url;
    };

    // fakeFetch should not be called for this path (error before token exchange).
    const fakeFetch: PKCEFetch = async () => {
      throw new Error("fakeFetch should not be called for the error path");
    };

    const flowPromise = runPKCEFlow({
      provider: "google",
      clientId: "test-client-deny",
      scopes: ["read"],
      vault,
      openUrl,
      fetchImpl: fakeFetch,
    });

    // Wait for the server to bind and openUrl to fire.
    await waitForOpenUrl(capturedUrl);
    const capturedAuthUrl = capturedUrl.value;

    const authUrlParsed = new URL(capturedAuthUrl);
    const redirectUri = authUrlParsed.searchParams.get("redirect_uri");
    const state = authUrlParsed.searchParams.get("state");

    // Send back an OAuth error response (user clicked "Deny").
    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("state", state!);
    const callbackResp = await fetch(callbackUrl.toString());
    // Server returns 200 with a plain-text denial message.
    expect(callbackResp.status).toBe(200);

    // The flow promise must reject with the OAuth error code or the production message.
    await expect(flowPromise).rejects.toThrow(/access_denied|authorization did not complete/i);
  }, 15_000);

  it("uses microsoft token endpoint when provider is microsoft", async () => {
    const vault = createMockVault();

    const capturedUrl = { value: "" };
    const openUrl = async (url: string): Promise<void> => {
      capturedUrl.value = url;
    };

    let capturedTokenUrl = "";
    const fakeFetch: PKCEFetch = async (input, init) => {
      const req = new Request(input, init);
      capturedTokenUrl = req.url;
      return new Response(
        JSON.stringify({
          access_token: "ms-flow-access",
          refresh_token: "ms-flow-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const flowPromise = runPKCEFlow({
      provider: "microsoft",
      clientId: "ms-client",
      scopes: ["offline_access"],
      vault,
      openUrl,
      fetchImpl: fakeFetch,
    });

    await waitForOpenUrl(capturedUrl);
    const capturedAuthUrl = capturedUrl.value;

    const authUrlParsed = new URL(capturedAuthUrl);
    // Microsoft auth URL uses login.microsoftonline.com
    expect(authUrlParsed.hostname).toBe("login.microsoftonline.com");

    const redirectUri = authUrlParsed.searchParams.get("redirect_uri");
    const state = authUrlParsed.searchParams.get("state");

    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("code", "ms-auth-code");
    callbackUrl.searchParams.set("state", state!);
    await fetch(callbackUrl.toString());

    const result = await flowPromise;
    expect(result.accessToken).toBe("ms-flow-access");

    // Token exchange should target the Microsoft endpoint.
    expect(capturedTokenUrl).toContain("login.microsoftonline.com");
    expect(capturedTokenUrl).toContain("oauth2/v2.0/token");

    // Persisted under microsoft.oauth.
    const stored = await vault.get("microsoft.oauth");
    expect(stored).not.toBeNull();
  }, 15_000);

  it("invokes onRandomPortFallback and still completes the flow", async () => {
    const vault = createMockVault();
    let fallbackCalled = false;

    const capturedUrl = { value: "" };
    const openUrl = async (url: string): Promise<void> => {
      capturedUrl.value = url;
    };

    const fakeFetch: PKCEFetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "fallback-access",
          refresh_token: "fallback-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    // Not providing redirectPort or portRange → only path is "ephemeral".
    const flowPromise = runPKCEFlow({
      provider: "google",
      clientId: "fallback-client",
      scopes: ["profile"],
      vault,
      openUrl,
      fetchImpl: fakeFetch,
      onRandomPortFallback: () => {
        fallbackCalled = true;
      },
    });

    await waitForOpenUrl(capturedUrl);
    const capturedAuthUrl = capturedUrl.value;

    const authUrlParsed = new URL(capturedAuthUrl);
    const redirectUri = authUrlParsed.searchParams.get("redirect_uri");
    const state = authUrlParsed.searchParams.get("state");

    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("code", "fallback-code");
    callbackUrl.searchParams.set("state", state!);
    await fetch(callbackUrl.toString());

    const result = await flowPromise;
    expect(result.accessToken).toBe("fallback-access");

    // onRandomPortFallback must have been invoked (ephemeral port path).
    expect(fallbackCalled).toBe(true);
  }, 15_000);

  it("completes the Notion OAuth flow: opens URL, receives callback, exchanges code, persists tokens", async () => {
    const vault = createMockVault();

    const capturedUrl = { value: "" };
    const openUrl = async (url: string): Promise<void> => {
      capturedUrl.value = url;
    };

    let tokenRequest: Request | undefined;
    const fakeFetch: PKCEFetch = async (input, init) => {
      tokenRequest = new Request(input, init);
      return new Response(
        JSON.stringify({
          access_token: "notion-flow-access",
          refresh_token: "notion-flow-refresh",
          token_type: "bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const flowPromise = runPKCEFlow({
      provider: "notion",
      clientId: "notion-client",
      oauthClientSecret: "notion-secret",
      scopes: ["read_content"],
      vault,
      openUrl,
      fetchImpl: fakeFetch,
    });

    // Wait for openUrl to fire.
    await waitForOpenUrl(capturedUrl);
    const capturedAuthUrl = capturedUrl.value;

    const authUrlParsed = new URL(capturedAuthUrl);
    // Notion auth URL uses api.notion.com
    expect(authUrlParsed.hostname).toBe("api.notion.com");
    expect(authUrlParsed.searchParams.get("response_type")).toBe("code");
    expect(authUrlParsed.searchParams.get("owner")).toBe("user");

    const redirectUri = authUrlParsed.searchParams.get("redirect_uri");
    const state = authUrlParsed.searchParams.get("state");
    expect(redirectUri).toBeTruthy();
    expect(state).toBeTruthy();

    // Send the callback.
    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("code", "notion-auth-code");
    callbackUrl.searchParams.set("state", state!);
    const callbackResp = await fetch(callbackUrl.toString());
    expect(callbackResp.status).toBe(200);

    const result = await flowPromise;
    expect(result.accessToken).toBe("notion-flow-access");
    expect(result.refreshToken).toBe("notion-flow-refresh");

    // Token exchange went to Notion's token endpoint with Basic auth + JSON body.
    expect(tokenRequest).toBeDefined();
    const authHeader = tokenRequest!.headers.get("Authorization");
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(authHeader!.slice(6), "base64").toString();
    expect(decoded).toBe("notion-client:notion-secret");

    const bodyText = await tokenRequest!.text();
    const body = JSON.parse(bodyText) as {
      grant_type: string;
      code: string;
      redirect_uri: string;
    };
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("notion-auth-code");
    expect(body.redirect_uri).toBe(redirectUri);

    // Vault persistence under notion.oauth.
    const stored = await vault.get("notion.oauth");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as { accessToken: string; refreshToken: string };
    expect(parsed.accessToken).toBe("notion-flow-access");
    expect(parsed.refreshToken).toBe("notion-flow-refresh");
  }, 15_000);

  it("Notion flow rejects when oauthClientSecret is missing", async () => {
    const vault = createMockVault();
    const openUrl = async (_url: string): Promise<void> => {
      /* never called when secret validation fails */
    };
    const fakeFetch: PKCEFetch = async () => {
      throw new Error("should not be called");
    };

    await expect(
      runPKCEFlow({
        provider: "notion",
        clientId: "notion-client",
        // oauthClientSecret deliberately omitted
        scopes: ["read_content"],
        vault,
        openUrl,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/oauthClientSecret/);
  });

  it("completes the Slack OAuth flow: opens URL, receives callback, exchanges code, persists tokens", async () => {
    const vault = createMockVault();

    const capturedUrl = { value: "" };
    const openUrl = async (url: string): Promise<void> => {
      capturedUrl.value = url;
    };

    const fakeFetch: PKCEFetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          authed_user: {
            access_token: "slack-flow-access",
            refresh_token: "slack-flow-refresh",
            expires_in: 43200,
            scope: "channels:read,chat:write",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const flowPromise = runPKCEFlow({
      provider: "slack",
      clientId: "slack-client",
      scopes: ["channels:read", "chat:write"],
      vault,
      openUrl,
      fetchImpl: fakeFetch,
    });

    // Wait for openUrl to fire.
    await waitForOpenUrl(capturedUrl);
    const capturedAuthUrl = capturedUrl.value;

    const authUrlParsed = new URL(capturedAuthUrl);
    expect(authUrlParsed.hostname).toBe("slack.com");
    expect(authUrlParsed.pathname).toBe("/oauth/v2/authorize");

    const redirectUri = authUrlParsed.searchParams.get("redirect_uri");
    const state = authUrlParsed.searchParams.get("state");

    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("code", "slack-auth-code");
    callbackUrl.searchParams.set("state", state!);
    const callbackResp = await fetch(callbackUrl.toString());
    expect(callbackResp.status).toBe(200);

    const result = await flowPromise;
    expect(result.accessToken).toBe("slack-flow-access");
    expect(result.refreshToken).toBe("slack-flow-refresh");

    // Vault persistence under slack.oauth.
    const stored = await vault.get("slack.oauth");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as { accessToken: string };
    expect(parsed.accessToken).toBe("slack-flow-access");
  }, 15_000);

  it("accepts a portRange and uses one of those ports for the callback server", async () => {
    const vault = createMockVault();

    const capturedUrl = { value: "" };
    const openUrl = async (url: string): Promise<void> => {
      capturedUrl.value = url;
    };

    const fakeFetch: PKCEFetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "range-access",
          refresh_token: "range-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    // Use a wide portRange so we don't clash with other tests; OS picks from the range.
    const flowPromise = runPKCEFlow({
      provider: "google",
      clientId: "range-client",
      scopes: ["profile"],
      vault,
      openUrl,
      fetchImpl: fakeFetch,
      portRange: [49200, 49250],
    });

    await waitForOpenUrl(capturedUrl);
    const capturedAuthUrl = capturedUrl.value;

    const authUrlParsed = new URL(capturedAuthUrl);
    const redirectUri = authUrlParsed.searchParams.get("redirect_uri");
    const state = authUrlParsed.searchParams.get("state");

    // Confirm the redirect_uri uses a port in the declared range (or ephemeral if all were busy).
    const boundPort = parseInt(new URL(redirectUri!).port);
    expect(boundPort).toBeGreaterThan(0);

    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("code", "range-code");
    callbackUrl.searchParams.set("state", state!);
    await fetch(callbackUrl.toString());

    const result = await flowPromise;
    expect(result.accessToken).toBe("range-access");
  }, 15_000);

  it("throws when portRange is invalid", () => {
    const vault = createMockVault();
    const openUrl = async (_url: string): Promise<void> => {
      /* no-op */
    };

    expect(() =>
      runPKCEFlow({
        provider: "google",
        clientId: "c",
        scopes: [],
        vault,
        openUrl,
        portRange: [500, 100], // lo > hi — invalid
      }),
    ).toThrow(/Invalid portRange/);
  });
});
