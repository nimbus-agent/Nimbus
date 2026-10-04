import { describe, expect, test } from "bun:test";
import { form, parseDeviceAuthResponse, parseTokenResponse } from "./types.ts";

/**
 * The IdP-response parsers refuse shapes `types.test.ts` never sends — a body that is not a JSON
 * object, a device-authorization response missing a required field — and fall back to their
 * defaults (`interval` 5 s, the RFC 8628 default; `expires_in` 600 s, this module's own choice)
 * only where the IdP said nothing usable.
 */

const DEVICE_OK = {
  device_code: "dc",
  user_code: "WXYZ-1234",
  verification_uri: "https://acme/activate",
};

describe("a body that is not a JSON object is refused", () => {
  for (const [label, body] of [
    ["null", null],
    ["an array", [{ id_token: "h.p.s" }]],
    ["a string", "h.p.s"],
    ["a number", 42],
  ] as const) {
    test(`${label}: both parsers throw 'expected a JSON object'`, () => {
      expect(() => parseTokenResponse(body)).toThrow("identity: expected a JSON object");
      expect(() => parseDeviceAuthResponse(body)).toThrow("identity: expected a JSON object");
    });
  }
});

describe("parseDeviceAuthResponse", () => {
  for (const field of ["device_code", "user_code", "verification_uri"] as const) {
    test(`a missing or empty ${field} is a malformed response`, () => {
      const { [field]: _omit, ...without } = DEVICE_OK;
      expect(() => parseDeviceAuthResponse(without)).toThrow(
        "identity: malformed device authorization response",
      );
      expect(() => parseDeviceAuthResponse({ ...DEVICE_OK, [field]: "" })).toThrow(
        "identity: malformed device authorization response",
      );
    });
  }

  test("carries verification_uri_complete through when the IdP sends one", () => {
    const r = parseDeviceAuthResponse({
      ...DEVICE_OK,
      verification_uri_complete: "https://acme/activate?code=WXYZ-1234",
      interval: 7,
      expires_in: 900,
    });
    expect(r).toEqual({
      deviceCode: "dc",
      userCode: "WXYZ-1234",
      verificationUri: "https://acme/activate",
      verificationUriComplete: "https://acme/activate?code=WXYZ-1234",
      interval: 7,
      expiresIn: 900,
    });
  });

  test("absent or unusable interval/expires_in fall back to 5 and 600, and no complete-URI key appears", () => {
    const r = parseDeviceAuthResponse({
      ...DEVICE_OK,
      // A numeric STRING that differs from the default, so a parser coercing it would yield 9.
      interval: "9",
      expires_in: Number.NaN,
      verification_uri_complete: "",
    });
    expect(r).toEqual({
      deviceCode: "dc",
      userCode: "WXYZ-1234",
      verificationUri: "https://acme/activate",
      interval: 5,
      expiresIn: 600,
    });
    expect("verificationUriComplete" in r).toBe(false);
  });
});

describe("parseTokenResponse", () => {
  test("an id_token alone yields exactly that — no undefined optional keys", () => {
    const r = parseTokenResponse({ id_token: "h.p.s", access_token: "", expires_in: "3600" });
    expect(r).toEqual({ idToken: "h.p.s" });
    expect(Object.keys(r)).toEqual(["idToken"]);
  });
});

describe("form", () => {
  test("builds a urlencoded POST body", () => {
    const init = form({ grant_type: "refresh_token", refresh_token: "a b&c" });
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(init.body).toBe("grant_type=refresh_token&refresh_token=a+b%26c");
  });
});
