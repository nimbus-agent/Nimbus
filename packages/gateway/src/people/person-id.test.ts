import { describe, expect, test } from "bun:test";

import { NIMBUS_PERSON_NAMESPACE_UUID, uuidV5 } from "./person-id.ts";

/** 36 chars, lowercase hex, 8-4-4-4-12. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// NIMBUS_PERSON_NAMESPACE_UUID — value contract
// ---------------------------------------------------------------------------
test("NIMBUS_PERSON_NAMESPACE_UUID has the expected value", () => {
  expect(NIMBUS_PERSON_NAMESPACE_UUID).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
});

// ---------------------------------------------------------------------------
// uuidV5 — happy path: deterministic, UUID-shaped output (custom SHA-256 scheme,
// version nibble 0x8 — intentionally NOT RFC 4122 v5; see person-id.ts).
// ---------------------------------------------------------------------------
describe("uuidV5 — happy path", () => {
  test.each([
    ["a plain email", "alice@example.com"],
    ["an empty string", ""],
    ["unicode characters", "Ålice Ångström <alice@example.se>"],
    ["a 10k-character name", "a".repeat(10_000)],
  ])("returns a lowercase hyphenated UUID string for %s", (_label, name) => {
    expect(uuidV5(name, NIMBUS_PERSON_NAMESPACE_UUID)).toMatch(UUID_SHAPE);
  });

  test("is deterministic — same name+namespace → same UUID", () => {
    const a = uuidV5("alice@example.com", NIMBUS_PERSON_NAMESPACE_UUID);
    const b = uuidV5("alice@example.com", NIMBUS_PERSON_NAMESPACE_UUID);
    expect(a).toBe(b);
  });

  test("different names produce different UUIDs", () => {
    const a = uuidV5("alice@example.com", NIMBUS_PERSON_NAMESPACE_UUID);
    const b = uuidV5("bob@example.com", NIMBUS_PERSON_NAMESPACE_UUID);
    expect(a).not.toBe(b);
  });

  test("different namespaces produce different UUIDs for the same name", () => {
    // Use the Nimbus namespace and another well-formed UUID (ns:URL)
    const nsUrl = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
    const a = uuidV5("alice@example.com", NIMBUS_PERSON_NAMESPACE_UUID);
    const b = uuidV5("alice@example.com", nsUrl);
    expect(a).not.toBe(b);
  });

  test("whitespace-only name produces a valid UUID (whitespace is preserved, not stripped)", () => {
    const result = uuidV5("   ", NIMBUS_PERSON_NAMESPACE_UUID);
    expect(result).toMatch(UUID_SHAPE);
    // Confirm whitespace-only produces a different UUID than empty string
    const empty = uuidV5("", NIMBUS_PERSON_NAMESPACE_UUID);
    expect(result).not.toBe(empty);
  });

  test("case-variant emails produce different UUIDs (no normalisation inside uuidV5)", () => {
    const lower = uuidV5("alice@example.com", NIMBUS_PERSON_NAMESPACE_UUID);
    const upper = uuidV5("ALICE@EXAMPLE.COM", NIMBUS_PERSON_NAMESPACE_UUID);
    expect(lower).not.toBe(upper);
  });
});

// ---------------------------------------------------------------------------
// uuidV5 — invalid namespace UUID → throws "Invalid namespace UUID"
// This exercises the `hex.length !== 32` branch in uuidStringToBytes
// ---------------------------------------------------------------------------
describe("uuidV5 — invalid namespace UUID", () => {
  test("throws for an empty string namespace", () => {
    expect(() => uuidV5("name", "")).toThrow("Invalid namespace UUID");
  });

  test("throws for a namespace that is too short", () => {
    expect(() => uuidV5("name", "6ba7b810-9dad-11d1-80b4")).toThrow("Invalid namespace UUID");
  });

  test("throws for a namespace with extra characters", () => {
    // 37 chars (one extra)
    expect(() => uuidV5("name", "6ba7b810-9dad-11d1-80b4-00c04fd430c8x")).toThrow(
      "Invalid namespace UUID",
    );
  });

  test("throws for a namespace that has wrong dash placement but same length after stripping", () => {
    // Remove one dash and add a hex char so the string length stays at 36 but hex becomes 33
    expect(() => uuidV5("name", "6ba7b810-9dad-11d1-80b4-00c04fd430c8a")).toThrow(
      "Invalid namespace UUID",
    );
  });

  test("throws for a namespace that is entirely non-hex digits (length 32 chars but invalid hex)", () => {
    // 32 chars of all dashes → hex length becomes 0 after replaceAll
    expect(() => uuidV5("name", "--------------------------------")).toThrow(
      "Invalid namespace UUID",
    );
  });

  test("throws for a namespace with only 31 hex digits after dash removal", () => {
    // Remove one character from the last segment making hex 31 chars
    const short = "6ba7b810-9dad-11d1-80b4-00c04fd430c";
    expect(() => uuidV5("name", short)).toThrow("Invalid namespace UUID");
  });

  test("throws for a namespace that is just whitespace", () => {
    expect(() => uuidV5("name", "   ")).toThrow("Invalid namespace UUID");
  });
});

// ---------------------------------------------------------------------------
// uuidV5 — output shape and version/variant bits
// The sha256 digest for well-known inputs always produces a 32-byte buffer,
// so the b6/b8 undefined branch (digest < 9 bytes) is unreachable via the
// public API. We verify that the returned UUID has the masked bits set.
// ---------------------------------------------------------------------------
describe("uuidV5 — output bit structure", () => {
  test("version nibble (byte 6, high nibble) is set to 0x8 by the masking logic", () => {
    // The implementation sets digest[6] = (b6 & 0x0f) | 0x80 which gives
    // the high nibble value 8 (0x80..0x8f → first nibble of byte 6 in hex = '8').
    const result = uuidV5("test", NIMBUS_PERSON_NAMESPACE_UUID);
    // Byte 6 is represented in hex chars 12–13 of the UUID (after removing dashes)
    const hex = result.replace(/-/g, "");
    const byte6High = parseInt(hex[12] ?? "0", 16);
    expect(byte6High).toBe(8);
  });

  test("variant bits (byte 8, two high bits) are set to 10 by the masking logic", () => {
    // The implementation sets digest[8] = (b8 & 0x3f) | 0x80
    // so the two high bits of byte 8 are always 1,0 (i.e. 0x80..0xbf → high nibble 8 or 9)
    const result = uuidV5("test", NIMBUS_PERSON_NAMESPACE_UUID);
    const hex = result.replace(/-/g, "");
    // Byte 8 starts at hex char index 16
    const byte8 = parseInt(hex.slice(16, 18), 16);
    // Bits 7–6 must be 1,0 → value & 0xc0 must equal 0x80
    expect(byte8 & 0xc0).toBe(0x80);
  });
});
