import { describe, expect, it } from "bun:test";
import { decodeWatermarkCursorV1, encodeWatermarkCursorV1 } from "./sync-watermark-cursor-v1.ts";

const PREFIX = "wm:v1:";

describe("encodeWatermarkCursorV1 / decodeWatermarkCursorV1", () => {
  // ── Happy-path round-trips ────────────────────────────────────────────────

  it("round-trips a cursor with a string watermark", () => {
    const cursor = { v: 1 as const, watermark: "2026-05-21T00:00:00Z" };
    const encoded = encodeWatermarkCursorV1(PREFIX, cursor);
    expect(typeof encoded).toBe("string");
    expect(encoded.startsWith(PREFIX)).toBe(true);
    const decoded = decodeWatermarkCursorV1(encoded, PREFIX);
    expect(decoded).toEqual({ v: 1, watermark: "2026-05-21T00:00:00Z" });
  });

  it("round-trips a cursor with a null watermark", () => {
    const cursor = { v: 1 as const, watermark: null };
    const encoded = encodeWatermarkCursorV1(PREFIX, cursor);
    const decoded = decodeWatermarkCursorV1(encoded, PREFIX);
    expect(decoded).toEqual({ v: 1, watermark: null });
  });

  it("decodes a cursor whose watermark field is missing → normalises to null", () => {
    // Encode an object without the watermark key to exercise the `w === undefined` branch.
    const encoded = PREFIX + Buffer.from(JSON.stringify({ v: 1 }), "utf8").toString("base64url");
    const decoded = decodeWatermarkCursorV1(encoded, PREFIX);
    expect(decoded).toEqual({ v: 1, watermark: null });
  });

  // ── null / empty raw input ────────────────────────────────────────────────

  it("returns null when raw is null", () => {
    expect(decodeWatermarkCursorV1(null, PREFIX)).toBeNull();
  });

  it("returns null when raw is an empty string", () => {
    expect(decodeWatermarkCursorV1("", PREFIX)).toBeNull();
  });

  // ── prefix / schema-version mismatch ──────────────────────────────────────

  it("returns null when raw has the wrong prefix (prefix mismatch)", () => {
    const cursor = { v: 1 as const, watermark: "tok" };
    const encoded = encodeWatermarkCursorV1("other:", cursor);
    // Trying to decode with the different prefix → decodeNimbusJsonCursorPayload returns undefined
    expect(decodeWatermarkCursorV1(encoded, PREFIX)).toBeNull();
  });

  it("returns null when schema version is not 1", () => {
    // v: 2 should fail the rec["v"] !== 1 check
    const encoded =
      PREFIX +
      Buffer.from(JSON.stringify({ v: 2, watermark: "tok" }), "utf8").toString("base64url");
    expect(decodeWatermarkCursorV1(encoded, PREFIX)).toBeNull();
  });

  // ── bad payload shapes ────────────────────────────────────────────────────

  it("returns null when payload is JSON null", () => {
    const encoded = PREFIX + Buffer.from("null", "utf8").toString("base64url");
    expect(decodeWatermarkCursorV1(encoded, PREFIX)).toBeNull();
  });

  it("returns null when payload is a JSON array", () => {
    const encoded = PREFIX + Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    expect(decodeWatermarkCursorV1(encoded, PREFIX)).toBeNull();
  });

  it("returns null when payload is not valid base64url JSON (malformed)", () => {
    // '!!!!' is not valid base64url → JSON.parse throws → returns undefined → null
    expect(decodeWatermarkCursorV1(PREFIX + "!!!!", PREFIX)).toBeNull();
  });

  it("returns null when watermark field is a non-string, non-null value", () => {
    // watermark: 42 is a number → should return null
    const encoded =
      PREFIX + Buffer.from(JSON.stringify({ v: 1, watermark: 42 }), "utf8").toString("base64url");
    expect(decodeWatermarkCursorV1(encoded, PREFIX)).toBeNull();
  });
});
