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

  test("throws when the device authorization endpoint returns a non-ok status", async () => {
    const fetchLike = async () => new Response("", { status: 500 });
    await expect(requestDeviceCode(DISCOVERY, "c1", ["openid"], fetchLike)).rejects.toThrow(
      /device authorization failed \(500\)/,
    );
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

  test("clamps a non-positive interval to the RFC 8628 default (5s) instead of tight-looping", async () => {
    const bodies = [
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      new Response(JSON.stringify({ id_token: "h.p.s" }), { status: 200 }),
    ];
    let i = 0;
    const sleeps: number[] = [];
    await pollDeviceToken(DISCOVERY, "client-1", "dc", {
      fetchLike: async () => bodies[i++] as Response,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      intervalSeconds: 0,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 0,
      onPoll: () => {},
    });
    expect(sleeps).toEqual([5000]);
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

  test("throws with code 'unknown' when error body is a non-object (covers asRecord :{}, err not string, no desc, no uri)", async () => {
    // body is a JSON number → asRecord returns {}, err undefined → code "unknown", desc "", uri ""
    const fetchLike = async () => new Response(JSON.stringify(123), { status: 400 });
    await expect(
      pollDeviceToken(DISCOVERY, "client-1", "dc", {
        fetchLike,
        sleep: async () => {},
        intervalSeconds: 1,
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => 0,
        onPoll: () => {},
      }),
    ).rejects.toThrow(/device token error: unknown$/);
  });

  test("applies slow_down backoff of intervalMs + 5000 then returns the token", async () => {
    const bodies: Response[] = [
      new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }),
      new Response(JSON.stringify({ id_token: "h.p.s" }), { status: 200 }),
    ];
    let i = 0;
    const sleeps: number[] = [];
    const tok = await pollDeviceToken(DISCOVERY, "client-1", "dc", {
      fetchLike: async () => bodies[i++] as Response,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      intervalSeconds: 1,
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 0,
      onPoll: () => {},
    });
    // normalizeIntervalMs(1) = 1000; slow_down adds 5000 → 6000
    expect(sleeps).toEqual([6000]);
    expect(tok.idToken).toBe("h.p.s");
  });

  test("throws when deadline is exceeded before the first poll", async () => {
    await expect(
      pollDeviceToken(DISCOVERY, "client-1", "dc", {
        fetchLike: async () => new Response("{}", { status: 200 }),
        sleep: async () => {},
        intervalSeconds: 1,
        deadlineMs: 5,
        now: () => 10,
        onPoll: () => {},
      }),
    ).rejects.toThrow(/device code expired before authorization/);
  });
});
