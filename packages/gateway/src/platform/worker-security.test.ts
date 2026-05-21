/**
 * Coverage for the dedicated-Worker origin acceptance check.
 *
 * Tier D — was at 0 % line coverage. The function has four branches:
 *  - `o === ""` (blank — typical Bun worker spawn)
 *  - `o === "null"` (sandboxed iframe-style origin)
 *  - `selfO === ""` (gateway is itself in a non-browser/blank context — accept anything)
 *  - cross-origin (`o !== selfO`) → reject
 *  - same-origin match → accept
 *
 * `getGlobalOrigin` reads `globalThis.origin` — we stub it via PropertyDescriptor
 * capture/restore so we never leak state into sibling tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isAcceptableWorkerOrigin } from "./worker-security.ts";

function makeEvent(origin: string): MessageEvent {
  return { origin } as unknown as MessageEvent;
}

describe("isAcceptableWorkerOrigin", () => {
  let originalGlobalOrigin: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalGlobalOrigin = Object.getOwnPropertyDescriptor(globalThis, "origin");
  });

  afterEach(() => {
    if (originalGlobalOrigin === undefined) {
      delete (globalThis as Record<string, unknown>)["origin"];
    } else {
      Object.defineProperty(globalThis, "origin", originalGlobalOrigin);
    }
  });

  test("accepts blank origin (typical Bun-spawned dedicated worker)", () => {
    expect(isAcceptableWorkerOrigin(makeEvent(""))).toBe(true);
  });

  test("accepts the literal 'null' origin (sandboxed-iframe style)", () => {
    expect(isAcceptableWorkerOrigin(makeEvent("null"))).toBe(true);
  });

  test("accepts any non-empty origin when self.origin is itself blank (non-browser host)", () => {
    Object.defineProperty(globalThis, "origin", {
      value: "",
      configurable: true,
      writable: true,
    });
    expect(isAcceptableWorkerOrigin(makeEvent("https://attacker.example"))).toBe(true);
  });

  test("rejects a mismatched origin when self.origin is set", () => {
    Object.defineProperty(globalThis, "origin", {
      value: "https://nimbus.local",
      configurable: true,
      writable: true,
    });
    expect(isAcceptableWorkerOrigin(makeEvent("https://attacker.example"))).toBe(false);
  });

  test("accepts a matching origin when self.origin is set", () => {
    Object.defineProperty(globalThis, "origin", {
      value: "https://nimbus.local",
      configurable: true,
      writable: true,
    });
    expect(isAcceptableWorkerOrigin(makeEvent("https://nimbus.local"))).toBe(true);
  });

  test("ignores a non-string self.origin (treats it as blank)", () => {
    // The helper coerces non-string globalThis.origin to "" — exercise the
    // typeof guard inside `getGlobalOrigin`.
    Object.defineProperty(globalThis, "origin", {
      value: 42,
      configurable: true,
      writable: true,
    });
    expect(isAcceptableWorkerOrigin(makeEvent("https://anything"))).toBe(true);
  });
});
