import { describe, expect, test } from "bun:test";
import type { WireImageMime } from "./image-mime.ts";
import { resolveWireMime, sniffImageMime } from "./image-mime.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
// HEIC: a real ftyp box, and deliberately NOT one of the four wire types.
const heic = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

describe("sniffImageMime", () => {
  test.each<[string, Uint8Array, WireImageMime]>([
    ["jpeg", jpeg, "image/jpeg"],
    ["png", png, "image/png"],
    ["gif", gif, "image/gif"],
    ["webp", webp, "image/webp"],
  ])("recognises %s", (_n, bytes, expected) => {
    expect(sniffImageMime(bytes)).toBe(expected);
  });

  test("returns null for a format no vendor accepts on the wire", () => {
    expect(sniffImageMime(heic)).toBeNull();
  });

  test("returns null rather than throwing on a truncated buffer", () => {
    expect(sniffImageMime(new Uint8Array([0xff]))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });

  /** RIFF alone is not WebP — it is also WAV and AVI. */
  test("does not accept a RIFF container that is not WebP", () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffImageMime(wav)).toBeNull();
  });
});

describe("resolveWireMime", () => {
  /**
   * § 19.2, and the inversion of what the reviewer proposed. The sniff is AUTHORITATIVE and the
   * declared value is the fallback: on the cloud arm the declared value is a remote provider's
   * Content-Type header, which `media-types.ts` already says not to trust, and a wrong media_type
   * is not a soft failure — Anthropic rejects image/png over JPEG bytes outright.
   */
  test("the SNIFF wins over a contradicting declared type", () => {
    expect(resolveWireMime(jpeg, "image/png")).toBe("image/jpeg");
  });

  test("falls back to the declared type only when the sniff is inconclusive", () => {
    expect(resolveWireMime(heic, "image/png")).toBe("image/png");
  });

  test("ignores a declared type that is not a wire type", () => {
    expect(resolveWireMime(heic, "application/octet-stream")).toBeNull();
    expect(resolveWireMime(heic, "image/heic")).toBeNull();
  });

  test("tolerates parameters and casing on the declared type", () => {
    expect(resolveWireMime(heic, "IMAGE/PNG; charset=binary")).toBe("image/png");
  });

  test("returns null when neither resolves — the caller must refuse, not guess", () => {
    expect(resolveWireMime(heic, null)).toBeNull();
  });
});
