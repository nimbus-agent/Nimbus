import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const listeners = new Map<string, Array<(payload: unknown) => void>>();

const { mockListen } = vi.hoisted(() => {
  const mockListen = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const arr = listeners.get(event) ?? [];
    const cb = (p: unknown) => handler({ payload: p });
    arr.push(cb);
    listeners.set(event, arr);
    return () => {
      const current = listeners.get(event) ?? [];
      listeners.set(
        event,
        current.filter((f) => f !== cb),
      );
    };
  });
  return { mockListen };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

import { useIpcSubscription } from "../../src/hooks/useIpcSubscription";

describe("useIpcSubscription", () => {
  it("attaches a listener for the event", async () => {
    const handler = vi.fn();
    renderHook(() => useIpcSubscription("connector://health-changed", handler));
    await Promise.resolve();
    expect(mockListen).toHaveBeenCalledWith("connector://health-changed", expect.any(Function));
  });

  it("invokes the handler when the event fires", async () => {
    const handler = vi.fn();
    renderHook(() => useIpcSubscription("topic://x", handler));
    await Promise.resolve();
    const cbs = listeners.get("topic://x") ?? [];
    for (const cb of cbs) cb({ foo: 1 });
    expect(handler).toHaveBeenCalledWith({ foo: 1 });
  });
});
