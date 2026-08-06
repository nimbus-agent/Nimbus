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
    const { code } = ctl.open("chrome-work", ["clip"]);
    expect(code).toBe("123456");
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.confirm("123456")).toEqual({ label: "chrome-work", scopes: ["clip"] });
    // single-use: window now closed
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull();
  });

  test("wrong code does not consume the window but counts an attempt", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("dev", ["clip"]);
    expect(ctl.confirm("000000")).toBeNull();
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.confirm("123456")).toEqual({ label: "dev", scopes: ["clip"] });
  });

  test("expired window → confirm null even with the right code", () => {
    const { ctl, setNow } = controllerAt(1000);
    ctl.open("dev", ["clip"]);
    setNow(1000 + PAIRING_TTL_MS + 1);
    expect(ctl.confirm("123456")).toBeNull();
    expect(ctl.isOpen()).toBe(false);
  });

  test("attempt cap: after PAIRING_MAX_ATTEMPTS wrong tries the window closes", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("dev", ["clip"]);
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      expect(ctl.confirm("000000")).toBeNull();
    }
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull(); // even correct code now rejected
  });

  test("isOpen returns false once the window has expired", () => {
    const { ctl, setNow } = controllerAt(1000);
    ctl.open("dev", ["clip"]);
    expect(ctl.isOpen()).toBe(true);
    setNow(1000 + PAIRING_TTL_MS + 1);
    expect(ctl.isOpen()).toBe(false);
  });

  test("open replaces a prior window (only one active)", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("first", ["clip"]);
    ctl.open("second", ["clip"]);
    expect(ctl.confirm("123456")).toEqual({ label: "second", scopes: ["clip"] });
  });

  test("default code generator yields a 6-digit numeric code", () => {
    const ctl = new PairingWindowController({ nowMs: () => 0 });
    const { code } = ctl.open("x", ["clip"]);
    expect(code).toMatch(/^\d{6}$/);
  });

  test("confirm returns the scopes the OWNER opened the window with", () => {
    const now = 1_000;
    const c = new PairingWindowController({ nowMs: () => now, genCode: () => "123456" });
    c.open("chrome", ["clip", "agents"]);
    expect(c.confirm("123456")).toEqual({ label: "chrome", scopes: ["clip", "agents"] });
  });

  test("a second window's scopes replace the first's", () => {
    const now = 1_000;
    const c = new PairingWindowController({ nowMs: () => now, genCode: () => "123456" });
    c.open("chrome", ["clip", "agents"]);
    c.open("chrome", ["clip"]);
    expect(c.confirm("123456")).toEqual({ label: "chrome", scopes: ["clip"] });
  });
});
