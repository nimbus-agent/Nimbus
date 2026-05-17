import { describe, expect, it } from "bun:test";
import type { PKCEFetch } from "../../../src/auth/pkce.ts";
import {
  pkceCodeChallengeS256,
  refreshAccessToken,
  refreshNotionToken,
  refreshSlackUserToken,
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

    expect(capturedUrl).toMatch(/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token/);
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
