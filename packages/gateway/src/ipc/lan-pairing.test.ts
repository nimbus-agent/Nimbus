import { describe, expect, test } from "bun:test";
import { generatePairingCode, PairingWindow } from "./lan-pairing.ts";

describe("generatePairingCode", () => {
  test("produces 20-character base58 strings", () => {
    const c = generatePairingCode();
    expect(c).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20}$/);
  });

  test("produces unique codes", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) codes.add(generatePairingCode());
    expect(codes.size).toBe(1000);
  });
});

describe("PairingWindow", () => {
  test("consume returns true within window", () => {
    const w = new PairingWindow(5_000);
    w.open("abc");
    expect(w.consume("abc")).toBe(true);
  });

  test("consume returns false outside window", () => {
    const w = new PairingWindow(10, () => Date.now());
    w.open("abc");
    const later = Date.now() + 10_000;
    expect(w.consumeAt("abc", later)).toBe(false);
  });

  test("consume returns false on wrong code", () => {
    const w = new PairingWindow(5_000);
    w.open("abc");
    expect(w.consume("xyz")).toBe(false);
  });

  test("consume is single-shot (closes window)", () => {
    const w = new PairingWindow(5_000);
    w.open("abc");
    expect(w.consume("abc")).toBe(true);
    expect(w.consume("abc")).toBe(false);
  });

  test("S3-F9 — getExpiresAt matches the windowMs the constructor was given", () => {
    const t0 = 100_000;
    const w = new PairingWindow(7_000, () => t0);
    w.open("abc");
    expect(w.getExpiresAt()).toBe(t0 + 7_000);
  });

  test("S3-F9 — getExpiresAt is null before open() and after close()", () => {
    const w = new PairingWindow(5_000);
    expect(w.getExpiresAt()).toBeNull();
    w.open("abc");
    expect(w.getExpiresAt()).not.toBeNull();
    w.close();
    expect(w.getExpiresAt()).toBeNull();
  });

  test("S3-F9 — consume() boundary aligns with getExpiresAt", () => {
    const t0 = 100_000;
    const w = new PairingWindow(5_000, () => t0);
    w.open("abc");
    const expiresAt = w.getExpiresAt();
    expect(expiresAt).toBe(t0 + 5_000);
    expect(w.consumeAt("abc", t0 + 5_000)).toBe(true);
    expect(w.getExpiresAt()).toBeNull();
  });
});

describe("PairingWindow.consumeMatching (LAN v2 proof pairing)", () => {
  test("a matching proof consumes the code once and hands it back", () => {
    const w = new PairingWindow(5_000);
    w.open("code-1");
    expect(w.consumeMatching((c) => c === "code-1")).toBe("code-1");
    expect(w.isOpen()).toBe(false);
    expect(w.consumeMatching(() => true)).toBeNull();
  });

  test("a non-matching proof leaves the window open", () => {
    const w = new PairingWindow(5_000);
    w.open("code-1");
    expect(w.consumeMatching(() => false)).toBeNull();
    expect(w.isOpen()).toBe(true);
  });

  test("an expired window closes and never asks the matcher", () => {
    let now = 0;
    const w = new PairingWindow(5_000, () => now);
    w.open("code-1");
    now = 5_001;
    let asked = false;
    expect(
      w.consumeMatching(() => {
        asked = true;
        return true;
      }),
    ).toBeNull();
    expect(asked).toBe(false);
    expect(w.getExpiresAt()).toBeNull();
  });

  test("a closed window returns null", () => {
    expect(new PairingWindow(5_000).consumeMatching(() => true)).toBeNull();
  });
});
