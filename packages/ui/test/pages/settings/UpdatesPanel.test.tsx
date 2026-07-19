import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import {
  callMock,
  updaterApplyUpdateMock,
  updaterCheckNowMock,
  updaterGetStatusMock,
  updaterRollbackMock,
} from "../../../src/ipc/__mocks__/client";
import { UpdatesPanel } from "../../../src/pages/settings/UpdatesPanel";
import { useNimbusStore } from "../../../src/store";

beforeEach(() => {
  callMock.mockReset();
  updaterApplyUpdateMock.mockReset();
  updaterCheckNowMock.mockReset();
  updaterGetStatusMock.mockReset();
  updaterRollbackMock.mockReset();
  useNimbusStore.setState({
    connectionState: "connected",
    updaterStatus: null,
    updaterUiState: "idle",
    updaterCheck: null,
    updaterDownload: null,
    updaterRestarting: null,
    updaterFailure: null,
  });
  updaterGetStatusMock.mockResolvedValue({
    state: "idle",
    currentVersion: "0.1.0",
    configUrl: "https://updates.nimbus-agent.dev/manifest.json",
  });
});

afterEach(() => {
  useNimbusStore.setState({
    updaterStatus: null,
    updaterUiState: "idle",
    updaterCheck: null,
    updaterDownload: null,
    updaterRestarting: null,
    updaterFailure: null,
  });
});

describe("UpdatesPanel (slimmed; subscriptions live in UpdaterRestartChrome)", () => {
  it("renders current version once status loads", async () => {
    render(<UpdatesPanel />);
    expect(await screen.findByText("0.1.0")).toBeTruthy();
  });

  it("Check now success with no update keeps state idle", async () => {
    updaterCheckNowMock.mockResolvedValueOnce({
      currentVersion: "0.1.0",
      latestVersion: "0.1.0",
      updateAvailable: false,
    });
    render(<UpdatesPanel />);
    expect(await screen.findByRole("button", { name: "Check now" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(useNimbusStore.getState().updaterUiState).toBe("idle"));
    expect(useNimbusStore.getState().updaterCheck?.updateAvailable).toBe(false);
  });

  it("Check now success with update flips to `available` and surfaces Apply button + notes", async () => {
    updaterCheckNowMock.mockResolvedValueOnce({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      notes: "Bug fixes and improvements.",
    });
    render(<UpdatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(useNimbusStore.getState().updaterUiState).toBe("available"));
    expect(screen.getByRole("button", { name: /Apply 0.2.0/ })).toBeTruthy();
    expect(screen.getByText(/Bug fixes and improvements/)).toBeTruthy();
  });

  it("Apply runs updater_apply_started + updaterApplyUpdate and flips to applying", async () => {
    useNimbusStore.setState({
      updaterUiState: "available",
      updaterCheck: { currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true },
    });
    updaterApplyUpdateMock.mockResolvedValueOnce({ jobId: "x" });
    render(<UpdatesPanel />);
    await screen.findByRole("button", { name: /Apply 0.2.0/ });
    fireEvent.click(screen.getByRole("button", { name: /Apply 0.2.0/ }));
    await waitFor(() => expect(useNimbusStore.getState().updaterUiState).toBe("applying"));
    expect(updaterApplyUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("Rollback button surfaces only when prior state is rolled_back/failed and runs updater.rollback", async () => {
    updaterGetStatusMock.mockResolvedValueOnce({
      state: "rolled_back",
      currentVersion: "0.1.0",
      configUrl: "u",
      lastError: "previous install failed",
    });
    updaterRollbackMock.mockResolvedValueOnce({ ok: true });
    render(<UpdatesPanel />);
    expect(await screen.findByText(/previous install failed/)).toBeTruthy();
    const rollback = screen.getByRole("button", { name: "Rollback" });
    fireEvent.click(rollback);
    await waitFor(() => expect(updaterRollbackMock).toHaveBeenCalledTimes(1));
  });

  it("Disconnected state disables Check now", async () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    render(<UpdatesPanel />);
    expect(await screen.findByText("0.1.0")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("Check now error shows fetch error and resets state to idle", async () => {
    updaterCheckNowMock.mockRejectedValueOnce(new Error("network timeout"));
    render(<UpdatesPanel />);
    await screen.findByRole("button", { name: "Check now" });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText(/network timeout/)).toBeTruthy();
    expect(useNimbusStore.getState().updaterUiState).toBe("idle");
  });

  it("Apply error shows fetch error and transitions to failed", async () => {
    useNimbusStore.setState({
      updaterUiState: "available",
      updaterCheck: { currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true },
    });
    updaterApplyUpdateMock.mockRejectedValueOnce(new Error("installer failed"));
    render(<UpdatesPanel />);
    await screen.findByRole("button", { name: /Apply 0.2.0/ });
    fireEvent.click(screen.getByRole("button", { name: /Apply 0.2.0/ }));
    await waitFor(() => expect(useNimbusStore.getState().updaterUiState).toBe("failed"));
    expect(screen.getByText(/installer failed/)).toBeTruthy();
  });

  it("Rollback error shows fetch error and transitions to failed", async () => {
    useNimbusStore.setState({ updaterUiState: "rolled_back" });
    updaterGetStatusMock.mockResolvedValueOnce({
      state: "rolled_back",
      currentVersion: "0.1.0",
      configUrl: "u",
    });
    updaterRollbackMock.mockRejectedValueOnce(new Error("rollback rpc failed"));
    render(<UpdatesPanel />);
    await screen.findByRole("button", { name: "Rollback" });
    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    await waitFor(() => expect(useNimbusStore.getState().updaterUiState).toBe("failed"));
    expect(screen.getByText(/rollback rpc failed/)).toBeTruthy();
  });

  it("shows signature_invalid failure message when uiState is rolled_back", async () => {
    useNimbusStore.setState({
      updaterUiState: "rolled_back",
      updaterFailure: { reason: "signature_invalid" },
    });
    render(<UpdatesPanel />);
    expect(await screen.findByText(/signature invalid/i)).toBeTruthy();
  });

  it("shows hash_mismatch failure message when uiState is failed", async () => {
    useNimbusStore.setState({
      updaterUiState: "failed",
      updaterFailure: { reason: "hash_mismatch" },
    });
    render(<UpdatesPanel />);
    expect(await screen.findByText(/hash mismatch/i)).toBeTruthy();
  });

  it("shows generic rolled-back message for unknown failure reason", async () => {
    useNimbusStore.setState({
      updaterUiState: "rolled_back",
      updaterFailure: { reason: "unknown_reason" },
    });
    render(<UpdatesPanel />);
    expect(await screen.findByText(/Update rolled back: unknown_reason/)).toBeTruthy();
  });
});
