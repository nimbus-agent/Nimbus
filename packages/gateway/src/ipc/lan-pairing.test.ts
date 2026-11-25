import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertPairingCodeFormat,
  derivePairingPsk,
  generatePairingCode,
  PairingWindow,
} from "./lan-pairing.ts";

const CODE = "3J98t1WpEZ73CNmQviec";
const OTHER = "9wRm3tQxZc4KpLnVbHaY";

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

  test("D-FS-16: draws 15 random bytes, and the effective space is about 114 bits (OR-FS-6)", () => {
    const source = readFileSync(new URL("./lan-pairing.ts", import.meta.url), "utf8");
    expect(source).toContain("randomBytes(15)");
    // 120 bits cut to 20 base58 digits: the last digit of a 21-digit value is dropped, so about
    // floor(N / 58) distinct codes remain.
    const bits = 120 - Math.log2(58);
    expect(bits).toBeGreaterThan(114);
    expect(bits).toBeLessThan(114.3);
    expect(20 * Math.log2(58)).toBeLessThan(117.3);
  });
});

describe("pairing code format (D-FS-16)", () => {
  test.each([
    ["too short", "abc"],
    ["empty", ""],
    ["21 characters", `${CODE}1`],
    ["a base58-excluded 0", `0${CODE.slice(1)}`],
    ["a base58-excluded O", `O${CODE.slice(1)}`],
    ["a base58-excluded l", `l${CODE.slice(1)}`],
    ["a space", `${CODE.slice(0, 19)} `],
    ["a newline suffix", `${CODE.slice(0, 19)}\n`],
  ])("%s is refused by assertPairingCodeFormat, open() and derivePairingPsk", (_n, bad) => {
    expect(() => assertPairingCodeFormat(bad)).toThrow("20 base58 characters");
    expect(() => new PairingWindow(1000).open(bad)).toThrow("20 base58 characters");
    expect(() => derivePairingPsk(bad)).toThrow("20 base58 characters");
  });

  test("a refused open() leaves a previously open window untouched", () => {
    const w = new PairingWindow(5_000);
    w.open(CODE);
    expect(() => w.open("abc")).toThrow();
    expect(w.isOpen()).toBe(true);
    expect(w.consumeOpen()).toBe(true);
  });
});

describe("derivePairingPsk (D-FS-6)", () => {
  /** RFC 5869 by hand: extract then expand one block, so the node implementation is not its own oracle. */
  function referenceHkdf(code: string): Uint8Array {
    const prk = createHmac("sha256", "nimbus-lan/2 pair psk").update(code).digest();
    return new Uint8Array(
      createHmac("sha256", prk).update("psk0").update(Uint8Array.of(1)).digest(),
    );
  }

  test("is HKDF-SHA256(salt, ikm = the code's ASCII bytes, info = psk0, 32 bytes)", () => {
    expect(Buffer.from(derivePairingPsk(CODE)).toString("hex")).toBe(
      Buffer.from(referenceHkdf(CODE)).toString("hex"),
    );
  });

  test("different codes give different keys, the same code the same key", () => {
    expect(Buffer.from(derivePairingPsk(CODE)).equals(Buffer.from(derivePairingPsk(OTHER)))).toBe(
      false,
    );
    expect(Buffer.from(derivePairingPsk(CODE)).equals(Buffer.from(derivePairingPsk(CODE)))).toBe(
      true,
    );
  });
});

describe("PairingWindow", () => {
  test("consumeOpen closes an open window once: of two racers only the first wins", () => {
    const w = new PairingWindow(5_000);
    w.open(CODE);
    expect(w.consumeOpen()).toBe(true);
    expect(w.consumeOpen()).toBe(false);
    expect(w.isOpen()).toBe(false);
  });

  test("consumeOpen refuses an expired window", () => {
    let now = 1_000;
    const w = new PairingWindow(10, () => now);
    w.open(CODE);
    now += 10_000;
    expect(w.consumeOpen()).toBe(false);
  });

  test("S3-F9 - getExpiresAt matches the windowMs the constructor was given", () => {
    const t0 = 100_000;
    const w = new PairingWindow(7_000, () => t0);
    w.open(CODE);
    expect(w.getExpiresAt()).toBe(t0 + 7_000);
  });

  test("S3-F9 - getExpiresAt is null before open() and after close()", () => {
    const w = new PairingWindow(5_000);
    expect(w.getExpiresAt()).toBeNull();
    w.open(CODE);
    expect(w.getExpiresAt()).not.toBeNull();
    w.close();
    expect(w.getExpiresAt()).toBeNull();
  });

  test("S3-F9 - the window boundary aligns with getExpiresAt", () => {
    let now = 100_000;
    const w = new PairingWindow(5_000, () => now);
    w.open(CODE);
    expect(w.getExpiresAt()).toBe(100_000 + 5_000);
    now = 100_000 + 5_000;
    expect(w.consumeOpen()).toBe(true);
    expect(w.getExpiresAt()).toBeNull();
  });
});

describe("PairingWindow PSK (D-FS-15)", () => {
  test("currentPsk is undefined before open, the derived key while open, undefined after close", () => {
    const w = new PairingWindow(5_000);
    expect(w.currentPsk()).toBeUndefined();
    w.open(CODE);
    expect(Buffer.from(w.currentPsk() as Uint8Array).toString("hex")).toBe(
      Buffer.from(derivePairingPsk(CODE)).toString("hex"),
    );
    w.close();
    expect(w.currentPsk()).toBeUndefined();
  });

  test("currentPsk returns a copy: zeroing it does not damage the window's key", () => {
    const w = new PairingWindow(5_000);
    w.open(CODE);
    (w.currentPsk() as Uint8Array).fill(0);
    expect(Buffer.from(w.currentPsk() as Uint8Array).toString("hex")).toBe(
      Buffer.from(derivePairingPsk(CODE)).toString("hex"),
    );
  });

  test("an expired window has no PSK and is closed by asking", () => {
    let now = 1_000;
    const w = new PairingWindow(5_000, () => now);
    w.open(CODE);
    now += 5_001;
    expect(w.currentPsk()).toBeUndefined();
    expect(w.getExpiresAt()).toBeNull();
  });

  test("reopening replaces the key", () => {
    const w = new PairingWindow(5_000);
    w.open(CODE);
    w.open(OTHER);
    expect(Buffer.from(w.currentPsk() as Uint8Array).toString("hex")).toBe(
      Buffer.from(derivePairingPsk(OTHER)).toString("hex"),
    );
  });

  test("consumeOpen closes the window once: the second caller is refused", () => {
    const w = new PairingWindow(5_000);
    w.open(CODE);
    expect(w.consumeOpen()).toBe(true);
    expect(w.consumeOpen()).toBe(false);
    expect(w.currentPsk()).toBeUndefined();
    expect(w.isOpen()).toBe(false);
  });

  test("consumeOpen is false on a window that was never opened or has expired", () => {
    expect(new PairingWindow(5_000).consumeOpen()).toBe(false);
    let now = 0;
    const w = new PairingWindow(10, () => now);
    w.open(CODE);
    now = 11;
    expect(w.consumeOpen()).toBe(false);
  });
});
