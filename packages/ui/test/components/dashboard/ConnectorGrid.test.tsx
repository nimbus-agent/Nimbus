import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorStatus } from "../../../src/ipc/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

const patchConnectorSpy = vi.fn<(name: string, patch: Partial<ConnectorStatus>) => void>();

const store: {
  connectors: ConnectorStatus[];
  highlightConnector: string | null;
  setConnectors: (c: ConnectorStatus[]) => void;
  patchConnector: (name: string, patch: Partial<ConnectorStatus>) => void;
  recomputeAggregate: (c: ConnectorStatus[]) => void;
  setConnectorsMenu: (items: Array<{ name: string; health: ConnectorStatus["health"] }>) => void;
} = {
  connectors: [{ name: "drive", health: "healthy" }],
  highlightConnector: null,
  setConnectors: () => undefined,
  patchConnector: patchConnectorSpy,
  recomputeAggregate: () => undefined,
  setConnectorsMenu: () => undefined,
};

vi.mock("../../../src/store", () => ({
  useNimbusStore: (sel: (s: typeof store) => unknown) => sel(store),
}));

vi.mock("../../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: () => ({ data: store.connectors, error: null, isLoading: false }),
}));

type HealthPayload = {
  name: string;
  health: ConnectorStatus["health"];
  degradationReason?: string;
};
let capturedHealthHandler: ((payload: HealthPayload) => void) | null = null;

vi.mock("../../../src/hooks/useIpcSubscription", () => ({
  useIpcSubscription: (_event: string, handler: (payload: HealthPayload) => void) => {
    capturedHealthHandler = handler;
  },
}));

import { ConnectorGrid } from "../../../src/components/dashboard/ConnectorGrid";

beforeEach(() => {
  patchConnectorSpy.mockReset();
  capturedHealthHandler = null;
  store.connectors = [{ name: "drive", health: "healthy" }];
});

describe("ConnectorGrid", () => {
  it("renders one tile per connector", () => {
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Google Drive/)).toBeInTheDocument();
  });

  it("shows empty state when no connectors", () => {
    store.connectors = [];
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No connectors configured/i)).toBeInTheDocument();
  });

  it("onHealth: patches connector health without degradationReason", () => {
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    act(() => {
      capturedHealthHandler?.({ name: "drive", health: "degraded" });
    });
    expect(patchConnectorSpy).toHaveBeenCalledWith("drive", { health: "degraded" });
    const patch = patchConnectorSpy.mock.calls[0]?.[1];
    expect(patch).not.toHaveProperty("degradationReason");
  });

  it("onHealth: includes degradationReason when present in payload", () => {
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    act(() => {
      capturedHealthHandler?.({
        name: "drive",
        health: "rate_limited",
        degradationReason: "too many requests",
      });
    });
    expect(patchConnectorSpy).toHaveBeenCalledWith("drive", {
      health: "rate_limited",
      degradationReason: "too many requests",
    });
  });
});
