import { describe, expect, test } from "bun:test";

import {
  createMemoryVault,
  googlePkceOpenUrlCompleter,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  handlePkceCallbackRequest,
  pkceCodeChallengeS256,
  refreshAccessToken,
  runPKCEFlow,
} from "./pkce.ts";

function isHttpsTokenEndpoint(s: string, host: string, pathname: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === host && u.pathname === pathname;
  } catch {
    return false;
  }
}

describe("pkceCodeChallengeS256", () => {
  test("matches SHA-256 base64url of verifier (RFC 7636)", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await pkceCodeChallengeS256(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge.length).toBeGreaterThan(0);
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (const b of bytes) {
      binary += String.fromCodePoint(b);
    }
    const expected = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(challenge).toBe(expected);
  });
});

describe("runPKCEFlow", () => {
  test("completes Google flow, persists vault JSON, no token in thrown errors on exchange failure", async () => {
    const vault = createMemoryVault();
    const secretAccess = "ACCESS_TOKEN_SECRET_VALUE";
    const secretRefresh = "REFRESH_TOKEN_SECRET_VALUE";

    const result = await runPKCEFlow({
      clientId: "test-client",
      scopes: ["openid", "email"],
      provider: "google",
      vault,
      openUrl: googlePkceOpenUrlCompleter("mock-auth-code", { expectAccountsHost: true }),
      fetchImpl: async (input) => {
        const s = requestUrlString(input);
        if (isHttpsTokenEndpoint(s, "oauth2.googleapis.com", "/token")) {
          return new Response(
            JSON.stringify({
              access_token: secretAccess,
              refresh_token: secretRefresh,
              expires_in: 3600,
              scope: "openid email",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(result.accessToken).toBe(secretAccess);
    expect(result.refreshToken).toBe(secretRefresh);
    expect(result.scopes).toEqual(["openid", "email"]);

    const stored = await vault.get("google.oauth");
    expect(stored).toBeTruthy();
    expect(stored).toContain(secretAccess);
    expect(stored).toContain(secretRefresh);

    let tokenPostBody = "";
    await runPKCEFlow({
      clientId: "test-client",
      scopes: ["openid"],
      provider: "google",
      oauthClientSecret: "google-web-client-secret",
      vault: createMemoryVault(),
      openUrl: googlePkceOpenUrlCompleter("mock-auth-code", { expectAccountsHost: true }),
      fetchImpl: async (input, init) => {
        const s = requestUrlString(input);
        if (isHttpsTokenEndpoint(s, "oauth2.googleapis.com", "/token")) {
          tokenPostBody = typeof init?.body === "string" ? init.body : "";
          return new Response(
            JSON.stringify({
              access_token: "a",
              refresh_token: "r",
              expires_in: 3600,
              scope: "openid",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    expect(tokenPostBody).toContain("client_secret=google-web-client-secret");

    let threw = "";
    try {
      await runPKCEFlow({
        clientId: "test-client",
        scopes: ["openid"],
        provider: "google",
        vault,
        openUrl: googlePkceOpenUrlCompleter("code2", {
          missingParamsMessage: "expected redirect_uri and state",
          assertFetchOk: false,
        }),
        fetchImpl: async (_input) =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      });
    } catch (e) {
      threw = String(e instanceof Error ? e.message : e);
    }
    expect(threw.length).toBeGreaterThan(0);
    expect(threw).toContain("invalid_grant");
    expect(threw.includes(secretAccess)).toBe(false);
    expect(threw.includes(secretRefresh)).toBe(false);
  });

  test("Microsoft flow: token exchange failure does not echo secrets in thrown message", async () => {
    const vault = createMemoryVault();
    const secretAccess = "MS_ACCESS_SECRET_X";
    const secretRefresh = "MS_REFRESH_SECRET_Y";

    const ok = await runPKCEFlow({
      clientId: "test-ms-client",
      scopes: ["Calendars.Read"],
      provider: "microsoft",
      vault,
      openUrl: googlePkceOpenUrlCompleter("ms-mock-code", {
        missingParamsMessage: "expected redirect_uri and state",
        assertFetchOk: false,
      }),
      fetchImpl: async (input) => {
        const s = requestUrlString(input);
        if (isHttpsTokenEndpoint(s, "login.microsoftonline.com", "/common/oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({
              access_token: secretAccess,
              refresh_token: secretRefresh,
              expires_in: 3600,
              scope: "Calendars.Read",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    expect(ok.accessToken).toBe(secretAccess);

    let threw2 = "";
    try {
      await runPKCEFlow({
        clientId: "test-ms-client",
        scopes: ["Calendars.Read"],
        provider: "microsoft",
        vault,
        openUrl: googlePkceOpenUrlCompleter("code2", {
          missingParamsMessage: "expected redirect_uri and state",
          assertFetchOk: false,
        }),
        fetchImpl: async (_input) =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      });
    } catch (e) {
      threw2 = String(e instanceof Error ? e.message : e);
    }
    expect(threw2.length).toBeGreaterThan(0);
    expect(threw2).toContain("invalid_grant");
    expect(threw2.includes(secretAccess)).toBe(false);
    expect(threw2.includes(secretRefresh)).toBe(false);
  });

  test("invokes onRandomPortFallback when using ephemeral port after fixed port busy", async () => {
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("busy"),
    });
    const busyPort = blocker.port;
    if (busyPort === undefined) {
      throw new Error("expected blocker to bind a port");
    }

    let fallback = 0;
    const vault = createMemoryVault();

    try {
      await runPKCEFlow({
        clientId: "test-client",
        scopes: ["openid"],
        provider: "google",
        redirectPort: busyPort,
        vault,
        onRandomPortFallback: () => {
          fallback += 1;
        },
        openUrl: googlePkceOpenUrlCompleter("c", {
          missingParamsMessage: "expected redirect_uri and state",
          assertFetchOk: false,
        }),
        fetchImpl: async (input) => {
          const s = requestUrlString(input);
          if (isHttpsTokenEndpoint(s, "oauth2.googleapis.com", "/token")) {
            return new Response(
              JSON.stringify({
                access_token: "a",
                refresh_token: "r",
                expires_in: 60,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response("no", { status: 404 });
        },
      });
    } finally {
      blocker.stop();
    }

    expect(fallback).toBe(1);
  });

  test("completes Slack PKCE flow, persists slack.oauth (user token in authed_user)", async () => {
    const vault = createMemoryVault();
    const secretAccess = "xoxp-slack-access-test";
    const secretRefresh = "xoxe-slack-refresh-test";

    const result = await runPKCEFlow({
      clientId: "123.456",
      scopes: ["channels:read"],
      provider: "slack",
      vault,
      openUrl: googlePkceOpenUrlCompleter("slack-mock-code", {
        missingParamsMessage: "expected redirect_uri and state in Slack auth URL",
      }),
      fetchImpl: async (input) => {
        const s = requestUrlString(input);
        if (isHttpsTokenEndpoint(s, "slack.com", "/api/oauth.v2.access")) {
          return new Response(
            JSON.stringify({
              ok: true,
              authed_user: {
                access_token: secretAccess,
                refresh_token: secretRefresh,
                expires_in: 3600,
                scope: "channels:read",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    expect(result.accessToken).toBe(secretAccess);
    expect(result.refreshToken).toBe(secretRefresh);
    expect(result.scopes).toEqual(["channels:read"]);

    const stored = await vault.get("slack.oauth");
    expect(stored).toBeTruthy();
    expect(stored).toContain(secretAccess);
    expect(stored).toContain(secretRefresh);
  });
});

describe("refreshAccessToken", () => {
  test("writes merged refresh token to vault", async () => {
    const vault = createMemoryVault();
    const r = await refreshAccessToken("old-refresh", "microsoft", "cid", {
      vault,
      fetchImpl: async (_input) =>
        new Response(
          JSON.stringify({
            access_token: "new-access",
            expires_in: 120,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    expect(r.accessToken).toBe("new-access");
    expect(r.refreshToken).toBe("old-refresh");
    const raw = await vault.get("microsoft.oauth");
    expect(raw).toContain("new-access");
    expect(raw).toContain("old-refresh");
  });

  test("includes client_secret in refresh body when context provides it", async () => {
    const vault = createMemoryVault();
    let body = "";
    await refreshAccessToken("old-refresh", "google", "cid", {
      vault,
      clientSecret: "refresh-secret",
      fetchImpl: async (_input, init) => {
        body = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({
            access_token: "new-access",
            expires_in: 120,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    expect(body).toContain("client_secret=refresh-secret");
  });

  test("persists refreshed Google tokens to persistVaultKey when set", async () => {
    const vault = createMemoryVault();
    await vault.set(
      "google_drive.oauth",
      JSON.stringify({
        accessToken: "expired",
        refreshToken: "drive-refresh",
        expiresAt: 0,
      }),
    );
    await refreshAccessToken("drive-refresh", "google", "cid", {
      vault,
      persistVaultKey: "google_drive.oauth",
      fetchImpl: async (_input) =>
        new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const driveRaw = await vault.get("google_drive.oauth");
    expect(driveRaw).toContain("new-access");
    expect(await vault.get("google.oauth")).toBeNull();
  });
});

describe("an OAuth error reaches the user with its provider code (F18)", () => {
  /**
   * A OneDrive sign-in failed. The user was told, in full: "Authorization was denied" in the
   * browser, nothing at all in the gateway log, and "OAuth authorization did not complete" on the
   * CLI. Microsoft had returned a specific machine-readable reason; none of the three surfaces
   * carried it, so "you clicked Deny" was indistinguishable from "admin consent required",
   * "invalid scope" or "unauthorized client".
   *
   * The code was CAPTURED and dropped twice — stored into `sink.value`, then discarded at the
   * throw with `done.error` in scope and unused. `error_description`, which providers populate
   * with a human-readable sentence, was never read at all.
   *
   * This is what made F11 expensive: roughly an hour of black-box probing to establish a fact the
   * provider had already stated in a field Nimbus had in hand.
   */
  test("the callback page names the actual code, not a blanket denial", () => {
    const sink: { value?: unknown } = {};
    const res = handlePkceCallbackRequest(
      new Request("http://127.0.0.1:8765/oauth/callback?error=consent_required"),
      "st",
      sink as never,
    );
    expect(res.status).toBe(200);
    return res.text().then((body) => {
      expect(body).toContain("consent_required");
      // "denied" is true of `access_denied` alone; asserting it for every code is simply wrong.
      expect(body.toLowerCase()).not.toContain("was denied");
    });
  });

  test("an actual denial still reads as a denial", async () => {
    const sink: { value?: unknown } = {};
    const res = handlePkceCallbackRequest(
      new Request("http://127.0.0.1:8765/oauth/callback?error=access_denied"),
      "st",
      sink as never,
    );
    expect((await res.text()).toLowerCase()).toContain("denied");
  });

  test("error_description is captured, since that is the human-readable half", () => {
    const sink: { value?: { error?: string; description?: string } } = {};
    handlePkceCallbackRequest(
      new Request(
        "http://127.0.0.1:8765/oauth/callback?error=unauthorized_client&error_description=The%20client%20is%20not%20enabled",
      ),
      "st",
      sink as never,
    );
    expect(sink.value?.error).toBe("unauthorized_client");
    expect(sink.value?.description).toBe("The client is not enabled");
  });
});
