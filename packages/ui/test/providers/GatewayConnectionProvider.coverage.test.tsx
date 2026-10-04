import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StateHandler = (state: string) => void;
type NotifHandler = (n: unknown) => void;

const h = vi.hoisted(() => ({
  callMock: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  onConnectionStateMock: vi.fn<(handler: (s: string) => void) => Promise<() => void>>(),
  subscribeMock: vi.fn<(handler: (n: unknown) => void) => Promise<() => void>>(),
}));

vi.mock("../../src/ipc/client", () => ({
  createIpcClient: () => ({
    call: h.callMock,
    onConnectionState: h.onConnectionStateMock,
    subscribe: h.subscribeMock,
  }),
}));

import { GatewayConnectionProvider } from "../../src/providers/GatewayConnectionProvider";
import { useNimbusStore } from "../../src/store";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let stateHandler: StateHandler | null = null;
let notifHandler: NotifHandler | null = null;
let setProviderMounted: (mounted: boolean) => void = () => {};
const seenPaths: string[] = [];
const seenNavigationTypes: string[] = [];

function PathProbe() {
  seenPaths.push(useLocation().pathname);
  seenNavigationTypes.push(useNavigationType());
  return null;
}

/** Keeps the router (and the path probe) mounted while the provider itself can be removed. */
function Harness() {
  const [mounted, setMounted] = useState(true);
  setProviderMounted = setMounted;
  return (
    <>
      {mounted && (
        <GatewayConnectionProvider>
          <span>child</span>
        </GatewayConnectionProvider>
      )}
      <PathProbe />
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  );
}

function unmountProvider(): void {
  act(() => setProviderMounted(false));
}

function stubSnapshot(snapshot: unknown, meta: unknown): void {
  h.callMock.mockImplementation(async (method: string) => {
    if (method === "diag.snapshot") return snapshot;
    if (method === "db.getMeta") return meta;
    throw new Error(`unexpected method ${method}`);
  });
}

function calledMethods(): string[] {
  return h.callMock.mock.calls.map(([m]) => m);
}

async function connect(): Promise<void> {
  await waitFor(() => expect(stateHandler).not.toBeNull());
  await act(async () => {
    stateHandler?.("connected");
  });
}

beforeEach(() => {
  stateHandler = null;
  notifHandler = null;
  seenPaths.length = 0;
  seenNavigationTypes.length = 0;
  h.callMock.mockReset();
  h.onConnectionStateMock.mockReset();
  h.subscribeMock.mockReset();
  h.onConnectionStateMock.mockImplementation(async (handler) => {
    stateHandler = handler;
    return () => {};
  });
  h.subscribeMock.mockImplementation(async (handler) => {
    notifHandler = handler;
    return () => {};
  });
  useNimbusStore.setState({ connectionState: "initializing" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GatewayConnectionProvider — first-connect routing", () => {
  it.each([
    {
      label: "connectors but no onboarding flag",
      snapshot: { indexTotalItems: 0, connectorCount: 3 },
      from: "/onboarding/welcome",
      to: "/",
    },
    {
      label: "indexed items but no connectors or flag",
      snapshot: { indexTotalItems: 4, connectorCount: 0 },
      from: "/onboarding/welcome",
      to: "/",
    },
    {
      label: "nothing at all (control)",
      snapshot: { indexTotalItems: 0, connectorCount: 0 },
      from: "/",
      to: "/onboarding/welcome",
    },
  ])("routes an install with $label to $to", async ({ snapshot, from, to }) => {
    stubSnapshot(snapshot, null);
    renderAt(from);
    expect(seenPaths.at(-1)).toBe(from);
    await connect();
    await waitFor(() => expect(seenPaths.at(-1)).toBe(to));
    expect(h.callMock).toHaveBeenCalledWith("db.getMeta", { key: "onboarding_completed" });
    // The routing replaces the entry it started from, so Back does not return to it.
    expect(seenNavigationTypes.at(-1)).toBe("REPLACE");
  });

  it("routes once on success and does not keep probing the gateway", async () => {
    vi.useFakeTimers();
    stubSnapshot({ indexTotalItems: 9, connectorCount: 1 }, "true");
    // Start on "/": routing there keeps the pathname, so `navigate` keeps its identity and the
    // effect is not re-run. Nothing but the loop's own stop-on-success can end it. (Routing to a
    // different path would cancel the loop anyway and mask a loop that does not stop.)
    renderAt("/");
    await connect();
    await waitFor(() => expect(seenNavigationTypes.at(-1)).toBe("REPLACE"));
    // Advance past the whole 200+500+1000+2000 ms backoff schedule. (runAllTimersAsync is not
    // enough: it can return before the success path has scheduled a first backoff.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calledMethods()).toEqual(["diag.snapshot", "db.getMeta"]);
    expect(seenPaths.at(-1)).toBe("/");
  });

  it("backs off 200 ms, then 500 ms, between failed first-connect attempts", async () => {
    vi.useFakeTimers();
    h.callMock.mockRejectedValue(new Error("gateway still booting"));
    renderAt("/onboarding/welcome");
    await connect();
    const snapshots = () => calledMethods().filter((m) => m === "diag.snapshot").length;
    expect(snapshots()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(snapshots()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(snapshots()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(snapshots()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(snapshots()).toBe(3);
  });

  it("makes no further attempt once unmounted during a backoff wait", async () => {
    vi.useFakeTimers();
    h.callMock.mockRejectedValue(new Error("gateway still booting"));
    renderAt("/onboarding/welcome");
    await connect();
    expect(calledMethods()).toEqual(["diag.snapshot"]);

    unmountProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calledMethods()).toEqual(["diag.snapshot"]);
  });

  it("retries the routing on the next connected event once every attempt failed", async () => {
    vi.useFakeTimers();
    h.callMock.mockRejectedValue(new Error("gateway still booting"));
    renderAt("/onboarding/welcome");
    await connect();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(calledMethods().filter((m) => m === "diag.snapshot")).toHaveLength(5);

    stubSnapshot({ indexTotalItems: 9, connectorCount: 1 }, "true");
    await connect();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(calledMethods().filter((m) => m === "diag.snapshot")).toHaveLength(6);
    expect(seenPaths.at(-1)).toBe("/");
  });
});

describe("GatewayConnectionProvider — cancellation", () => {
  it("stops before db.getMeta when unmounted while diag.snapshot is in flight", async () => {
    const snap = deferred<unknown>();
    h.callMock.mockImplementation(async (method: string) => {
      if (method === "diag.snapshot") return snap.promise;
      return null;
    });
    renderAt("/settings");
    await connect();
    expect(calledMethods()).toEqual(["diag.snapshot"]);

    unmountProvider();
    await act(async () => {
      snap.resolve({ indexTotalItems: 0, connectorCount: 0 });
    });
    expect(calledMethods()).toEqual(["diag.snapshot"]);
    expect(seenPaths.at(-1)).toBe("/settings");
  });

  it("does not navigate when unmounted while db.getMeta is in flight", async () => {
    const meta = deferred<unknown>();
    h.callMock.mockImplementation(async (method: string) => {
      if (method === "diag.snapshot") return { indexTotalItems: 0, connectorCount: 0 };
      if (method === "db.getMeta") return meta.promise;
      throw new Error(`unexpected method ${method}`);
    });
    renderAt("/settings");
    await connect();
    await waitFor(() => expect(calledMethods()).toEqual(["diag.snapshot", "db.getMeta"]));

    unmountProvider();
    await act(async () => {
      meta.resolve(null);
    });
    expect(seenPaths.at(-1)).toBe("/settings");
    expect(seenPaths).not.toContain("/onboarding/welcome");
  });

  it("ignores connection-state events delivered after unmount", async () => {
    stubSnapshot({ indexTotalItems: 1, connectorCount: 1 }, "true");
    renderAt("/");
    await waitFor(() => expect(stateHandler).not.toBeNull());
    act(() => stateHandler?.("connecting"));
    expect(useNimbusStore.getState().connectionState).toBe("connecting");

    unmountProvider();
    act(() => stateHandler?.("connected"));
    expect(useNimbusStore.getState().connectionState).toBe("connecting");
    expect(h.callMock).not.toHaveBeenCalled();
  });

  it("releases the state listener, and never subscribes, when unmounted mid-registration", async () => {
    const registration = deferred<() => void>();
    h.onConnectionStateMock.mockReturnValueOnce(registration.promise);
    renderAt("/");
    await waitFor(() => expect(h.onConnectionStateMock).toHaveBeenCalledTimes(1));

    unmountProvider();
    const stopState = vi.fn();
    await act(async () => {
      registration.resolve(stopState);
    });
    expect(stopState).toHaveBeenCalledTimes(1);
    expect(h.subscribeMock).not.toHaveBeenCalled();
  });

  it("releases the notification listener when unmounted before it registered", async () => {
    const stopState = vi.fn();
    h.onConnectionStateMock.mockResolvedValueOnce(stopState);
    const subscription = deferred<() => void>();
    h.subscribeMock.mockReturnValueOnce(subscription.promise);
    renderAt("/");
    await waitFor(() => expect(h.subscribeMock).toHaveBeenCalledTimes(1));

    unmountProvider();
    expect(stopState).toHaveBeenCalledTimes(1);
    const stopNotif = vi.fn();
    await act(async () => {
      subscription.resolve(stopNotif);
    });
    expect(stopNotif).toHaveBeenCalledTimes(1);
  });

  it("releases both listeners exactly once on a normal unmount and ignores notifications", async () => {
    const stopState = vi.fn();
    const stopNotif = vi.fn();
    h.onConnectionStateMock.mockImplementationOnce(async (handler) => {
      stateHandler = handler;
      return stopState;
    });
    h.subscribeMock.mockImplementationOnce(async (handler) => {
      notifHandler = handler;
      return stopNotif;
    });
    renderAt("/settings");
    await waitFor(() => expect(notifHandler).not.toBeNull());

    // The provider subscribes only to keep the channel open; notifications are consumed elsewhere.
    act(() => notifHandler?.({ method: "connector.healthChanged", params: {} }));
    expect(useNimbusStore.getState().connectionState).toBe("initializing");
    expect(seenPaths.at(-1)).toBe("/settings");
    expect(h.callMock).not.toHaveBeenCalled();

    unmountProvider();
    expect(stopState).toHaveBeenCalledTimes(1);
    expect(stopNotif).toHaveBeenCalledTimes(1);
  });
});
