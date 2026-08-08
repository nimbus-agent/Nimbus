import { afterEach, describe, expect, test } from "bun:test";

import { jwtParamsFromEnv } from "../src/jwt.ts";

const KEYS = ["TESTFLIGHT_ISSUER_ID", "TESTFLIGHT_KEY_ID", "TESTFLIGHT_PRIVATE_KEY"] as const;

describe("jwtParamsFromEnv", () => {
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  test("reads the three TESTFLIGHT_* env vars", () => {
    process.env["TESTFLIGHT_ISSUER_ID"] = "issuer-123";
    process.env["TESTFLIGHT_KEY_ID"] = "KEY456";
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "test-private-key-placeholder";
    expect(jwtParamsFromEnv()).toEqual({
      issuerId: "issuer-123",
      keyId: "KEY456",
      privateKeyPem: "test-private-key-placeholder",
    });
  });

  test("trims whitespace from environment variables", () => {
    process.env["TESTFLIGHT_ISSUER_ID"] = "  issuer-123  ";
    process.env["TESTFLIGHT_KEY_ID"] = "  KEY456  ";
    // NOTE: privateKeyPem is explicitly NOT trimmed in the returned object,
    // only trimmed for validation purposes in the source code.
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "  test-private-key-placeholder  ";

    expect(jwtParamsFromEnv()).toEqual({
      issuerId: "issuer-123",
      keyId: "KEY456",
      privateKeyPem: "  test-private-key-placeholder  ",
    });
  });

  test("throws when any of the three is unset", () => {
    for (const k of KEYS) {
      delete process.env[k];
    }
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_ISSUER_ID is not set");

    process.env["TESTFLIGHT_ISSUER_ID"] = "i";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_KEY_ID is not set");

    process.env["TESTFLIGHT_KEY_ID"] = "k";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_PRIVATE_KEY is not set");
  });

  test("throws when environment variables are empty strings", () => {
    process.env["TESTFLIGHT_ISSUER_ID"] = "";
    process.env["TESTFLIGHT_KEY_ID"] = "KEY456";
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "test-private-key-placeholder";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_ISSUER_ID is not set");

    process.env["TESTFLIGHT_ISSUER_ID"] = "issuer-123";
    process.env["TESTFLIGHT_KEY_ID"] = "";
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "test-private-key-placeholder";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_KEY_ID is not set");

    process.env["TESTFLIGHT_ISSUER_ID"] = "issuer-123";
    process.env["TESTFLIGHT_KEY_ID"] = "KEY456";
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_PRIVATE_KEY is not set");
  });

  test("throws when environment variables are whitespace-only strings", () => {
    process.env["TESTFLIGHT_ISSUER_ID"] = "   ";
    process.env["TESTFLIGHT_KEY_ID"] = "KEY456";
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "test-private-key-placeholder";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_ISSUER_ID is not set");

    process.env["TESTFLIGHT_ISSUER_ID"] = "issuer-123";
    process.env["TESTFLIGHT_KEY_ID"] = "   ";
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "test-private-key-placeholder";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_KEY_ID is not set");

    process.env["TESTFLIGHT_ISSUER_ID"] = "issuer-123";
    process.env["TESTFLIGHT_KEY_ID"] = "KEY456";
    process.env["TESTFLIGHT_PRIVATE_KEY"] = "   ";
    expect(() => jwtParamsFromEnv()).toThrow("TESTFLIGHT_PRIVATE_KEY is not set");
  });
});
