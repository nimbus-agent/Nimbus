import { describe, expect, it } from "bun:test";
import { type IpcCallable, supportsClose, supportsNotifications } from "./client-surface.ts";

/**
 * Build a minimal `IpcCallable` carrying arbitrary extra members.
 *
 * `Object.assign` rather than an object literal so the extras are not excess-property-checked
 * against `IpcCallable`, and so nothing needs a cast: the result is
 * `{call;disconnect} & Record<string, unknown>`, which satisfies `IpcCallable` outright.
 */
function clientWith(extras: Record<string, unknown>): IpcCallable {
  return Object.assign(
    {
      call: <T>(): Promise<T> => Promise.resolve(null as T),
      disconnect: async (): Promise<void> => {},
    },
    extras,
  );
}

const noop = (): void => {};

describe("supportsNotifications", () => {
  it("is true for a client that implements onNotification", () => {
    expect(supportsNotifications(clientWith({ onNotification: noop }))).toBe(true);
  });

  it("is false when onNotification is absent", () => {
    expect(supportsNotifications(clientWith({}))).toBe(false);
  });

  it("is false when onNotification is present but not callable", () => {
    // The `in` check alone would pass here. A truthy non-function would then be invoked by the
    // brief router and throw at the first notification instead of being reported up front.
    expect(supportsNotifications(clientWith({ onNotification: "nope" }))).toBe(false);
  });
});

describe("supportsClose", () => {
  it("is true only when BOTH onClose and offClose are callable", () => {
    expect(supportsClose(clientWith({ onClose: noop, offClose: noop }))).toBe(true);
  });

  it("is false when neither is present", () => {
    expect(supportsClose(clientWith({}))).toBe(false);
  });

  it("is false when onClose is present but not callable", () => {
    expect(supportsClose(clientWith({ onClose: "nope", offClose: noop }))).toBe(false);
  });

  it("is false when offClose is missing", () => {
    // Half a handler pair is worse than none: the adapter would bind a close handler it can never
    // remove, keeping a dead connection's router reachable.
    expect(supportsClose(clientWith({ onClose: noop }))).toBe(false);
  });

  it("is false when offClose is present but not callable", () => {
    expect(supportsClose(clientWith({ onClose: noop, offClose: 42 }))).toBe(false);
  });
});
