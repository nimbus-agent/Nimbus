import { describe, expect, test } from "bun:test";
import { createMockVault } from "../vault/mock.ts";
import {
  exchangeAuthorizationCode,
  OAUTH_PROVIDERS,
  type OAuthProviderDescriptor,
  refreshViaRegistry,
} from "./oauth-registry.ts";

/**
 * F10 — a token response with no `refresh_token` must not be stored as a success.
 *
 * `parseStandardTokenResponse` coerces an absent `refresh_token` to `""`, and `persistTokens`
 * writes it. `access_token` and `expires_in` both throw when absent; `refresh_token` alone
 * degraded silently, so `nimbus connector auth gmail` printed success and wrote a credential
 * that can never refresh — every later attempt sends an empty `refresh_token` and Google
 * answers `invalid_grant: Bad Request`, permanently.
 *
 * The coercion itself is LOAD-BEARING and must stay: a REFRESH response legitimately omits
 * `refresh_token` (the client keeps the one it has), which is exactly what
 * `refreshViaRegistry`'s `partial.refreshToken === "" ? a.refreshToken : …` relies on. So the
 * check belongs at the authorization-code exchange, and only for a provider that ASKED for
 * offline access — a provider that never requests one is not broken by not receiving one.
 */

const okResponse = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function exchangeArgs(descriptor: OAuthProviderDescriptor, body: Record<string, unknown>) {
  return {
    descriptor,
    fetchFn: async (): Promise<Response> => okResponse(body),
    clientId: "client-123.apps.googleusercontent.com",
    redirectUri: "http://127.0.0.1:8765/callback",
    codeVerifier: "verifier",
    authCode: "code",
    requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  };
}

describe("authorization-code exchange — offline access requires a refresh token", () => {
  test("google rejects a token response that carries no refresh_token", async () => {
    await expect(
      exchangeAuthorizationCode(
        exchangeArgs(OAUTH_PROVIDERS.google, { access_token: "ya29.x", expires_in: 3599 }),
      ),
    ).rejects.toThrow(/refresh token/i);
  });

  test("the message names the remedy, since re-running auth alone does not fix it", async () => {
    // Google only re-issues a refresh token after the prior grant is revoked, so "try again"
    // is the one instruction that reliably does not work.
    await expect(
      exchangeAuthorizationCode(
        exchangeArgs(OAUTH_PROVIDERS.google, { access_token: "ya29.x", expires_in: 3599 }),
      ),
    ).rejects.toThrow("myaccount.google.com/permissions");
  });

  test("an empty-string refresh_token is rejected too, not just an absent one", async () => {
    await expect(
      exchangeAuthorizationCode(
        exchangeArgs(OAUTH_PROVIDERS.google, {
          access_token: "ya29.x",
          expires_in: 3599,
          refresh_token: "",
        }),
      ),
    ).rejects.toThrow(/refresh token/i);
  });

  test("a normal google exchange still succeeds", async () => {
    const r = await exchangeAuthorizationCode(
      exchangeArgs(OAUTH_PROVIDERS.google, {
        access_token: "ya29.x",
        expires_in: 3599,
        refresh_token: "1//refresh",
      }),
    );
    expect(r.refreshToken).toBe("1//refresh");
  });

  test("a provider that never requests offline access is unaffected", async () => {
    // `microsoft` uses the same `parseStandardTokenResponse` but does not send
    // `access_type=offline`, so requiring a refresh token of it would invent a failure.
    const r = await exchangeAuthorizationCode(
      exchangeArgs(OAUTH_PROVIDERS.microsoft, { access_token: "eyJ.x", expires_in: 3599 }),
    );
    expect(r.refreshToken).toBe("");
  });

  test("REFRESH still accepts a response with no refresh_token, and keeps the stored one", async () => {
    // The load-bearing half. Google does not re-send a refresh token on refresh; treating that
    // as a failure would break every working credential on the machine.
    const vault = createMockVault();
    const r = await refreshViaRegistry({
      descriptor: OAUTH_PROVIDERS.google,
      refreshToken: "1//stored",
      clientId: "client-123.apps.googleusercontent.com",
      vault,
      fetchFn: async (): Promise<Response> =>
        okResponse({ access_token: "ya29.new", expires_in: 3599 }),
    });
    expect(r.refreshToken).toBe("1//stored");
  });
});

describe("the offline-access flag matches what the descriptor actually asks for", () => {
  test("every descriptor requesting access_type=offline declares offlineAccess", () => {
    // `offlineAccess` and the authorize params are two statements of the same fact, and nothing
    // else ties them together — a provider added with `access_type: "offline"` and no
    // `offlineAccess` would silently reacquire F10. Derived from `buildAuthorizeParams` rather
    // than hand-listed, so the check cannot drift from what is actually sent.
    const offenders: string[] = [];
    for (const [name, d] of Object.entries(OAUTH_PROVIDERS)) {
      const params = d.buildAuthorizeParams({
        clientId: "probe",
        scopes: ["probe.scope"],
        redirectUri: "http://127.0.0.1:1/cb",
        state: "state",
        codeChallenge: "challenge",
      });
      const asksOffline = params["access_type"] === "offline";
      if (asksOffline !== (d.offlineAccess !== undefined)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
