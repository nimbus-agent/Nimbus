import { describe, expect, test } from "bun:test";
import { PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, PairingWindowController } from "./pairing-window.ts";

function controllerAt(
  start: number,
  code = "123456",
): {
  ctl: PairingWindowController;
  setNow: (n: number) => void;
} {
  let now = start;
  const ctl = new PairingWindowController({ nowMs: () => now, genCode: () => code });
  return {
    ctl,
    setNow: (n) => {
      now = n;
    },
  };
}

describe("PairingWindowController", () => {
  test("no window open → confirm is null, isOpen false", () => {
    const { ctl } = controllerAt(1000);
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull();
  });

  test("open → confirm with correct code returns the label (single use)", () => {
    const { ctl } = controllerAt(1000);
    const { code } = ctl.open("chrome-work");
    expect(code).toBe("123456");
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.confirm("123456")).toEqual({ label: "chrome-work" });
    // single-use: window now closed
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull();
  });

  test("wrong code does not consume the window but counts an attempt", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("dev");
    expect(ctl.confirm("000000")).toBeNull();
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.confirm("123456")).toEqual({ label: "dev" });
  });

  test("expired window → confirm null even with the right code", () => {
    const { ctl, setNow } = controllerAt(1000);
    ctl.open("dev");
    setNow(1000 + PAIRING_TTL_MS + 1);
    expect(ctl.confirm("123456")).toBeNull();
    expect(ctl.isOpen()).toBe(false);
  });

  test("attempt cap: after PAIRING_MAX_ATTEMPTS wrong tries the window closes", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("dev");
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      expect(ctl.confirm("000000")).toBeNull();
    }
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull(); // even correct code now rejected
  });

  test("isOpen returns false once the window has expired", () => {
    const { ctl, setNow } = controllerAt(1000);
    ctl.open("dev");
    expect(ctl.isOpen()).toBe(true);
    setNow(1000 + PAIRING_TTL_MS + 1);
    expect(ctl.isOpen()).toBe(false);
  });

  test("open replaces a prior window (only one active)", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("first");
    ctl.open("second");
    expect(ctl.confirm("123456")).toEqual({ label: "second" });
  });

  test("default code generator yields a 6-digit numeric code", () => {
    const ctl = new PairingWindowController({ nowMs: () => 0 });
    const { code } = ctl.open("x");
    expect(code).toMatch(/^\d{6}$/);
  });
});
