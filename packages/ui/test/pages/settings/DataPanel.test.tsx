import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataGetExportPreflightMock } from "../../../src/ipc/__mocks__/client";
import { DataPanel } from "../../../src/pages/settings/DataPanel";
import { useNimbusStore } from "../../../src/store";

vi.mock("../../../src/ipc/client");

function resetStore() {
  useNimbusStore.setState({
    connectionState: "connected",
    exportFlow: { status: "idle" },
    importFlow: { status: "idle" },
    deleteFlow: { status: "idle" },
    lastExportPreflight: null,
    connectorsList: [],
  });
}

describe("DataPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    dataGetExportPreflightMock.mockResolvedValue({
      lastExportAt: null,
      estimatedSizeBytes: 0,
      itemCount: 0,
    });
  });

  it("renders the three cards", async () => {
    render(<DataPanel />);
    expect(screen.getByTestId("data-card-export")).toBeInTheDocument();
    expect(screen.getByTestId("data-card-import")).toBeInTheDocument();
    expect(screen.getByTestId("data-card-delete")).toBeInTheDocument();
  });

  it("displays 'Never' when lastExportAt is null", async () => {
    render(<DataPanel />);
    await vi.waitFor(() => {
      expect(screen.getByText("Never")).toBeInTheDocument();
    });
  });

  it("disables all three buttons when connectionState === 'disconnected'", async () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    render(<DataPanel />);
    const exportBtn = screen.getByRole("button", { name: /Export backup/ });
    const importBtn = screen.getByRole("button", { name: /Restore backup/ });
    const deleteBtn = screen.getByRole("button", { name: /Delete service/ });
    expect(exportBtn).toBeDisabled();
    expect(importBtn).toBeDisabled();
    expect(deleteBtn).toBeDisabled();
  });

  it("disables siblings while one flow is running", async () => {
    useNimbusStore.setState({ exportFlow: { status: "running" } });
    render(<DataPanel />);
    expect(screen.getByRole("button", { name: /Restore backup/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete service/ })).toBeDisabled();
  });

  it("disables siblings when importFlow is running", async () => {
    useNimbusStore.setState({ importFlow: { status: "running" } });
    render(<DataPanel />);
    expect(screen.getByRole("button", { name: /Export backup/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete service/ })).toBeDisabled();
  });

  it("opens ExportWizard when Export backup button is clicked", async () => {
    const user = userEvent.setup();
    render(<DataPanel />);
    await user.click(screen.getByRole("button", { name: /Export backup/ }));
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  it("shows PanelError when preflight fetch fails", async () => {
    dataGetExportPreflightMock.mockRejectedValue(new Error("fetch failed"));
    render(<DataPanel />);
    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to load preflight/i)).toBeInTheDocument();
    });
  });

  it("shows stale chip on export card when offline and preflight cached", async () => {
    useNimbusStore.setState({
      connectionState: "disconnected",
      lastExportPreflight: { lastExportAt: 1000, estimatedSizeBytes: 512, itemCount: 5 },
    });
    render(<DataPanel />);
    const staleChips = screen.getAllByRole("status");
    expect(staleChips.length).toBeGreaterThan(0);
  });

  it("displays KB size when estimatedSizeBytes is in KB range", async () => {
    dataGetExportPreflightMock.mockResolvedValue({
      lastExportAt: null,
      estimatedSizeBytes: 2048,
      itemCount: 3,
    });
    render(<DataPanel />);
    await vi.waitFor(() => {
      expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    });
  });

  it("displays MB size when estimatedSizeBytes is in MB range", async () => {
    dataGetExportPreflightMock.mockResolvedValue({
      lastExportAt: null,
      estimatedSizeBytes: 3 * 1024 * 1024,
      itemCount: 10,
    });
    render(<DataPanel />);
    await vi.waitFor(() => {
      expect(screen.getByText("3.0 MB")).toBeInTheDocument();
    });
  });

  it("displays GB size when estimatedSizeBytes is in GB range", async () => {
    dataGetExportPreflightMock.mockResolvedValue({
      lastExportAt: null,
      estimatedSizeBytes: 2 * 1024 * 1024 * 1024,
      itemCount: 10,
    });
    render(<DataPanel />);
    await vi.waitFor(() => {
      expect(screen.getByText(/2\.00 GB/)).toBeInTheDocument();
    });
  });

  it("calls markDisconnected when connection drops during a running flow", async () => {
    const mark = vi.fn();
    useNimbusStore.setState({
      exportFlow: { status: "running" },
      markDisconnected: mark,
    });
    const { rerender } = render(<DataPanel />);
    useNimbusStore.setState({ connectionState: "disconnected" });
    rerender(<DataPanel />);
    await vi.waitFor(() => {
      expect(mark).toHaveBeenCalled();
    });
  });
});
