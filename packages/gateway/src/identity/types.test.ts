// types.test.ts
import { describe, expect, test } from "bun:test";
import { parseDeviceAuthResponse, parseTokenResponse } from "./types.ts";

describe("parseTokenResponse", () => {
  test("maps snake_case OIDC token fields", () => {
    const r = parseTokenResponse({
      id_token: "h.p.s",
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
    });
    expect(r).toEqual({ idToken: "h.p.s", accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
  });
  test("throws when id_token is missing", () => {
    expect(() => parseTokenResponse({ access_token: "at" })).toThrow();
  });
});

describe("parseDeviceAuthResponse", () => {
  test("maps device_authorization fields with interval default 5", () => {
    const r = parseDeviceAuthResponse({
      device_code: "dc",
      user_code: "WXYZ-1234",
      verification_uri: "https://acme/activate",
      expires_in: 900,
    });
    expect(r.deviceCode).toBe("dc");
    expect(r.userCode).toBe("WXYZ-1234");
    expect(r.interval).toBe(5);
  });
});
