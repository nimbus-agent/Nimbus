import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler<T> = (payload: T) => void;
const connectionHandlers: Handler<string>[] = [];
const callMock = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();

vi.mock("../../src/ipc/client", async () => {
  return {
    createIpcClient: () => ({
      call: callMock,
      subscribe: async () => () => {},
      onConnectionState: async (h: Handler<string>) => {
        connectionHandlers.push(h);
        return () => {};
      },
    }),
  };
});

import { GatewayConnectionProvider } from "../../src/providers/GatewayConnectionProvider";
import { useNimbusStore } from "../../src/store";

function Consumer({ onPath }: { onPath: (p: string) => void }) {
  const loc = useLocation();
  onPath(loc.pathname);
  return null;
}

/** Renders the provider with a path-recording Consumer and fires a "connected" event. */
async function renderAndConnect(initialEntry: string) {
  const seen: string[] = [];
  const { rerender } = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <GatewayConnectionProvider>
        <Consumer onPath={(p) => seen.push(p)} />
      </GatewayConnectionProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(connectionHandlers.length).toBeGreaterThan(0));
  connectionHandlers[0]?.("connected");
  return { seen, rerender };
}

describe("GatewayConnectionProvider", () => {
  beforeEach(() => {
    connectionHandlers.length = 0;
    callMock.mockReset();
    useNimbusStore.setState({ connectionState: "initializing" });
  });

  it("mirrors connection state into the store", async () => {
    render(
      <MemoryRouter>
        <GatewayConnectionProvider>
          <div>child</div>
        </GatewayConnectionProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(connectionHandlers.length).toBeGreaterThan(0));
    connectionHandlers[0]?.("connected");

    await waitFor(() => expect(useNimbusStore.getState().connectionState).toBe("connected"));
  });

  it.each([
    { label: "has items", indexTotalItems: 5, connectorCount: 2 },
    { label: "zero items but meta non-null", indexTotalItems: 0, connectorCount: 0 },
  ])("routes to / when meta is non-null ($label)", async ({ indexTotalItems, connectorCount }) => {
    callMock.mockImplementation(async (method) => {
      if (method === "diag.snapshot") return { indexTotalItems, connectorCount };
      if (method === "db.getMeta") return "true";
      throw new Error(`unexpected method ${method}`);
    });
    const { seen, rerender } = await renderAndConnect("/onboarding/welcome");
    await waitFor(() => expect(seen.at(-1)).toBe("/"));
    rerender(<div />);
  });

  it("routes to /onboarding/welcome on first connected when no data and no meta", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "diag.snapshot") return { indexTotalItems: 0, connectorCount: 0 };
      if (method === "db.getMeta") return null;
      throw new Error(`unexpected method ${method}`);
    });
    const { seen, rerender } = await renderAndConnect("/");
    await waitFor(() => expect(seen.at(-1)).toBe("/onboarding/welcome"));
    rerender(<div />);
  });

  it("fires runFirstConnect only once when 'connected' arrives twice", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "diag.snapshot") return { indexTotalItems: 1, connectorCount: 1 };
      if (method === "db.getMeta") return "true";
      throw new Error(`unexpected method ${method}`);
    });
    const { rerender } = await renderAndConnect("/");
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
    const callCountAfterFirst = callMock.mock.calls.length;
    // Fire connected a second time — firstConnectHandled guard should short-circuit
    connectionHandlers[0]?.("connected");
    await new Promise((r) => setTimeout(r, 50));
    expect(callMock.mock.calls.length).toBe(callCountAfterFirst);
    rerender(<div />);
  });

  it("exhausts MAX_ATTEMPTS without throwing when all IPC calls fail", async () => {
    vi.useFakeTimers();
    callMock.mockRejectedValue(new Error("always fails"));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <GatewayConnectionProvider>
          <div />
        </GatewayConnectionProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(connectionHandlers.length).toBeGreaterThan(0));
    act(() => {
      connectionHandlers[0]?.("connected");
    });
    await vi.runAllTimersAsync();
    // 5 attempts made, no unhandled rejection
    expect(callMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    vi.useRealTimers();
  });
});
