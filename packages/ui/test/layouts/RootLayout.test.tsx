import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenHandlers: new Map<string, Array<(e: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, ...rest: unknown[]) => invokeMock(cmd, ...rest),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const arr = listenHandlers.get(event) ?? [];
    arr.push(handler);
    listenHandlers.set(event, arr);
    return () => {
      const current = listenHandlers.get(event) ?? [];
      listenHandlers.set(
        event,
        current.filter((f) => f !== handler),
      );
    };
  }),
  emit: vi.fn(async () => undefined),
}));

import { RootLayout } from "../../src/layouts/RootLayout";
import { useNimbusStore } from "../../src/store";

function fire(event: string, payload: unknown): void {
  for (const h of listenHandlers.get(event) ?? []) h({ payload });
}

describe("RootLayout", () => {
  beforeEach(() => {
    listenHandlers.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    useNimbusStore.setState({ connectionState: "connected" });
    useNimbusStore.getState().setConnectors([]);
    for (const r of useNimbusStore.getState().pending) {
      useNimbusStore.getState().resolve(r.requestId, false);
    }
  });

  const renderWith = () =>
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<RootLayout />}>
            <Route index element={<div>child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it("does not render the offline banner when connected", () => {
    renderWith();
    expect(screen.queryByText(/Gateway is not running/i)).toBeNull();
    expect(screen.getByText("child")).toBeTruthy();
  });

  it("renders the offline banner when disconnected", () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    renderWith();
    expect(screen.getByText(/Gateway is not running/i)).toBeTruthy();
    expect(screen.getByText("child")).toBeTruthy();
  });

  it("enqueues a consent request when consent://request fires", async () => {
    renderWith();
    await waitFor(() => expect(listenHandlers.get("consent://request")?.length).toBeGreaterThan(0));
    act(() => {
      fire("consent://request", {
        request_id: "r1",
        prompt: "Delete file?",
        details: { path: "/home/nimbus-test/a" },
        received_at_ms: 1,
      });
    });
    expect(useNimbusStore.getState().pending.map((p) => p.requestId)).toEqual(["r1"]);
  });

  it("enqueues a consent request without details when the field is absent", async () => {
    renderWith();
    await waitFor(() => expect(listenHandlers.get("consent://request")?.length).toBeGreaterThan(0));
    act(() => {
      fire("consent://request", {
        request_id: "r2",
        prompt: "Send?",
        received_at_ms: 2,
      });
    });
    const head = useNimbusStore.getState().pending[0];
    expect(head?.requestId).toBe("r2");
    expect(head?.details).toBeUndefined();
  });

  it("resolves a pending request when consent://resolved fires", async () => {
    renderWith();
    await waitFor(() =>
      expect(listenHandlers.get("consent://resolved")?.length).toBeGreaterThan(0),
    );
    act(() => {
      useNimbusStore.getState().enqueue({ requestId: "r3", prompt: "p", receivedAtMs: 1 });
    });
    act(() => {
      fire("consent://resolved", { request_id: "r3", approved: true });
    });
    expect(useNimbusStore.getState().pending).toHaveLength(0);
  });

  it("navigates and highlights a connector when tray://open-connector fires", async () => {
    renderWith();
    await waitFor(() =>
      expect(listenHandlers.get("tray://open-connector")?.length).toBeGreaterThan(0),
    );
    act(() => {
      fire("tray://open-connector", { name: "github" });
    });
    expect(useNimbusStore.getState().highlightConnector).toBe("github");
  });

  it("recovers pending requests from get_pending_hitl on mount", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_pending_hitl") {
        return [
          { request_id: "recovered", prompt: "x", details: { k: "v" }, received_at_ms: 3 },
          { request_id: "no-details", prompt: "y", received_at_ms: 4 },
        ];
      }
      return undefined;
    });
    renderWith();
    await waitFor(() =>
      expect(useNimbusStore.getState().pending.map((p) => p.requestId)).toEqual([
        "recovered",
        "no-details",
      ]),
    );
  });
});
