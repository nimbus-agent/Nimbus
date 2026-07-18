import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");

import { telemetryGetStatusMock, telemetrySetEnabledMock } from "../../../src/ipc/__mocks__/client";
import { TelemetryPanel } from "../../../src/pages/settings/TelemetryPanel";
import { useNimbusStore } from "../../../src/store";

const ENABLED_PAYLOAD = {
  enabled: true as const,
  session_id: "preview-not-persisted",
  nimbus_version: "0.1.0",
  platform: "linux" as const,
  connector_error_rate: { github: 0.01 },
  connector_health_transitions: { github: 2 },
  query_latency_p50_ms: 3,
  query_latency_p95_ms: 14,
  query_latency_p99_ms: 22,
  agent_invocation_latency_p50_ms: 0,
  agent_invocation_latency_p95_ms: 0,
  sync_duration_p50_ms: {},
  cold_start_ms: 90,
  extension_installs_by_id: {},
  extension_uninstalls_by_id: {},
};

beforeEach(() => {
  localStorage.clear();
  telemetryGetStatusMock.mockReset();
  telemetrySetEnabledMock.mockReset();
  useNimbusStore.setState({
    status: null,
    telemetryActionInFlight: false,
    connectionState: "connected",
  });
});

describe("TelemetryPanel", () => {
  it("renders disabled state when getStatus returns enabled=false", async () => {
    telemetryGetStatusMock.mockResolvedValueOnce({ enabled: false });
    render(<TelemetryPanel />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /telemetry/i })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
  });

  it("renders counter cards when enabled", async () => {
    telemetryGetStatusMock.mockResolvedValueOnce(ENABLED_PAYLOAD);
    render(<TelemetryPanel />);
    expect(await screen.findByText(/query p95/i)).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
  });

  it("toggling fires telemetrySetEnabled(false) and refetches", async () => {
    telemetryGetStatusMock
      .mockResolvedValueOnce(ENABLED_PAYLOAD)
      .mockResolvedValueOnce({ enabled: false });
    telemetrySetEnabledMock.mockResolvedValueOnce({ enabled: false });
    render(<TelemetryPanel />);
    await screen.findByText(/query p95/i);
    await userEvent.click(screen.getByRole("switch", { name: /telemetry/i }));
    await waitFor(() => expect(telemetrySetEnabledMock).toHaveBeenCalledWith(false));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /telemetry/i })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
  });

  it("expander shows the raw JSON payload when opened", async () => {
    telemetryGetStatusMock.mockResolvedValueOnce(ENABLED_PAYLOAD);
    render(<TelemetryPanel />);
    await screen.findByText(/query p95/i);
    await userEvent.click(screen.getByRole("button", { name: /view payload sample/i }));
    expect(screen.getByTestId("telemetry-payload-json")).toHaveTextContent("preview-not-persisted");
  });

  it("toggle is disabled when connectionState is disconnected", async () => {
    telemetryGetStatusMock.mockResolvedValueOnce({ enabled: false });
    render(<TelemetryPanel />);
    await screen.findByRole("switch", { name: /telemetry/i });
    useNimbusStore.setState({ connectionState: "disconnected" });
    await waitFor(() => expect(screen.getByRole("switch", { name: /telemetry/i })).toBeDisabled());
  });
});
