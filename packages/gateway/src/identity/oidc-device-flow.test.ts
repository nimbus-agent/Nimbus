// oidc-device-flow.test.ts
import { describe, expect, test } from "bun:test";
import { pollDeviceToken, requestDeviceCode } from "./oidc-device-flow.ts";

const DISCOVERY = {
  issuer: "https://acme",
  deviceAuthorizationEndpoint: "https://acme/dev",
  tokenEndpoint: "https://acme/token",
  jwksUri: "https://acme/jwks",
};

describe("requestDeviceCode", () => {
  test("POSTs client_id + scope and returns the device authorization", async () => {
    const fetchLike = async () =>
      new Response(
        JSON.stringify({
          device_code: "dc",
          user_code: "ABCD",
          verification_uri: "https://acme/act",
          interval: 1,
          expires_in: 60,
        }),
      );
    const r = await requestDeviceCode(DISCOVERY, "client-1", ["openid"], fetchLike);
    expect(r.deviceCode).toBe("dc");
    expect(r.userCode).toBe("ABCD");
  });
});

describe("pollDeviceToken", () => {
  test("polls through authorization_pending then returns tokens", async () => {
    const bodies = [
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      new Response(JSON.stringify({ id_token: "h.p.s", refresh_token: "rt", expires_in: 3600 }), {
        status: 200,
      }),
    ];
    let i = 0;
    const fetchLike = async () => bodies[i++] as Response;
    const tok = await pollDeviceToken(DISCOVERY, "client-1", "dc", {
      fetchLike,
      sleep: async () => {},
      intervalSeconds: 1,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 0,
      onPoll: () => {},
    });
    expect(tok.idToken).toBe("h.p.s");
    expect(tok.refreshToken).toBe("rt");
  });

  test("throws on access_denied and surfaces error_description (review S1)", async () => {
    const fetchLike = async () =>
      new Response(
        JSON.stringify({
          error: "access_denied",
          error_description: "user rejected the request",
          error_uri: "https://acme/help",
        }),
        { status: 400 },
      );
    await expect(
      pollDeviceToken(DISCOVERY, "client-1", "dc", {
        fetchLike,
        sleep: async () => {},
        intervalSeconds: 1,
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => 0,
        onPoll: () => {},
      }),
    ).rejects.toThrow(/access_denied — user rejected the request \(https:\/\/acme\/help\)/);
  });
});
