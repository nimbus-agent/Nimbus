import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadUpdaterPublicKey, UPDATER_PUBLIC_KEY_BASE64 } from "./public-key.ts";

// Save originals so we can restore them after each test
let savedOverrideKey: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedOverrideKey = process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"];
  savedNodeEnv = process.env["NODE_ENV"];
  // Clear override key by default — tests that need it will set it
  delete process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"];
});

afterEach(() => {
  // Restore env vars to their original state
  if (savedOverrideKey === undefined) {
    delete process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"];
  } else {
    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = savedOverrideKey;
  }
  if (savedNodeEnv === undefined) {
    delete process.env["NODE_ENV"];
  } else {
    process.env["NODE_ENV"] = savedNodeEnv;
  }
});

describe("UPDATER_PUBLIC_KEY_BASE64", () => {
  test("is a non-empty base64 string", () => {
    expect(typeof UPDATER_PUBLIC_KEY_BASE64).toBe("string");
    expect(UPDATER_PUBLIC_KEY_BASE64.length).toBeGreaterThan(0);
  });

  test("decodes to exactly 32 bytes", () => {
    const bytes = Buffer.from(UPDATER_PUBLIC_KEY_BASE64, "base64");
    expect(bytes).toHaveLength(32);
  });
});

describe("loadUpdaterPublicKey — no override", () => {
  test("returns a Uint8Array of exactly 32 bytes using the embedded key", () => {
    const key = loadUpdaterPublicKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
  });

  test("return value matches UPDATER_PUBLIC_KEY_BASE64 decoded bytes", () => {
    const key = loadUpdaterPublicKey();
    const expected = new Uint8Array(Buffer.from(UPDATER_PUBLIC_KEY_BASE64, "base64"));
    expect(key).toEqual(expected);
  });
});

describe("loadUpdaterPublicKey — NIMBUS_DEV_UPDATER_PUBLIC_KEY override", () => {
  test("uses the override key in non-production when it is a valid 32-byte key", () => {
    // Generate a 32-byte override key (all zeros for determinism)
    const overrideBytes = new Uint8Array(32).fill(0x42);
    const overrideB64 = Buffer.from(overrideBytes).toString("base64");

    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = overrideB64;
    // Ensure we are not in production
    process.env["NODE_ENV"] = "development";

    const key = loadUpdaterPublicKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
    expect(key).toEqual(overrideBytes);
  });

  test("throws when NODE_ENV is 'production' and the override is set", () => {
    const overrideBytes = new Uint8Array(32).fill(0x01);
    const overrideB64 = Buffer.from(overrideBytes).toString("base64");

    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = overrideB64;
    process.env["NODE_ENV"] = "production";

    expect(() => loadUpdaterPublicKey()).toThrow(
      "NIMBUS_DEV_UPDATER_PUBLIC_KEY is not permitted in production builds.",
    );
  });

  test("throws when the override key decodes to fewer than 32 bytes", () => {
    // A 16-byte key encoded as base64
    const shortBytes = new Uint8Array(16).fill(0x01);
    const shortB64 = Buffer.from(shortBytes).toString("base64");

    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = shortB64;
    process.env["NODE_ENV"] = "development";

    expect(() => loadUpdaterPublicKey()).toThrow("updater public key must be 32 bytes, got 16");
  });

  test("throws when the override key decodes to more than 32 bytes", () => {
    // A 64-byte key encoded as base64
    const longBytes = new Uint8Array(64).fill(0x02);
    const longB64 = Buffer.from(longBytes).toString("base64");

    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = longB64;
    process.env["NODE_ENV"] = "development";

    expect(() => loadUpdaterPublicKey()).toThrow("updater public key must be 32 bytes, got 64");
  });

  test("override works when NODE_ENV is undefined (not set)", () => {
    const overrideBytes = new Uint8Array(32).fill(0x07);
    const overrideB64 = Buffer.from(overrideBytes).toString("base64");

    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = overrideB64;
    delete process.env["NODE_ENV"];

    const key = loadUpdaterPublicKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toEqual(overrideBytes);
  });
});
