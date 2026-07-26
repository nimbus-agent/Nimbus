import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: () => ({ data: null, error: null, isLoading: false }),
}));
vi.mock("../../src/hooks/useIpcSubscription", () => ({
  useIpcSubscription: () => undefined,
}));

vi.mock("../../src/store", () => ({
  useNimbusStore: (
    sel: (s: {
      connectors: never[];
      highlightConnector: null;
      setConnectors: () => void;
      patchConnector: () => void;
      recomputeAggregate: () => void;
      setConnectorsMenu: () => void;
      aggregateHealth: "normal" | "amber" | "red";
    }) => unknown,
  ) =>
    sel({
      connectors: [],
      highlightConnector: null,
      setConnectors: () => undefined,
      patchConnector: () => undefined,
      recomputeAggregate: () => undefined,
      setConnectorsMenu: () => undefined,
      aggregateHealth: "normal",
    }),
}));

import { Dashboard } from "../../src/pages/Dashboard";

describe("Dashboard", () => {
  it("renders PageHeader + three panels", () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Index metrics/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Connectors/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Recent activity/i)).toBeInTheDocument();
  });
});
