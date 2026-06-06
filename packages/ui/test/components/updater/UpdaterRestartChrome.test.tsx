import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { UpdaterRestartChrome } from "../../../src/components/updater/UpdaterRestartChrome";
import { diagGetVersionMock, updaterGetStatusMock } from "../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../src/store";

beforeEach(() => {
  diagGetVersionMock.mockReset();
  updaterGetStatusMock.mockReset();
  useNimbusStore.setState({
    updaterStatus: null,
    updaterUiState: "idle",
    updaterCheck: null,
    updaterDownload: null,
    updaterRestarting: null,
    updaterFailure: null,
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

describe("UpdaterRestartChrome", () => {
  it("renders nothing when uiState is idle", () => {
    const { queryByTestId } = render(<UpdaterRestartChrome />);
    expect(queryByTestId("restart-overlay")).toBeNull();
  });

  it("renders the overlay when uiState transitions to restarting", () => {
    const { queryByTestId } = render(<UpdaterRestartChrome />);
    expect(queryByTestId("restart-overlay")).toBeNull();
    act(() => {
      useNimbusStore.getState().setUpdaterRestarting({ fromVersion: "0.1.0", toVersion: "0.2.0" });
      useNimbusStore.getState().setUpdaterUiState("restarting");
    });
    expect(queryByTestId("restart-overlay")).not.toBeNull();
  });

  it("renders the overlay when uiState is reconnecting", () => {
    const { queryByTestId } = render(<UpdaterRestartChrome />);
    act(() => {
      useNimbusStore.getState().setUpdaterRestarting({ fromVersion: "0.1.0", toVersion: "0.2.0" });
      useNimbusStore.getState().setUpdaterUiState("reconnecting");
    });
    expect(queryByTestId("restart-overlay")).not.toBeNull();
  });

  it("flips to failed with reconnect_timeout after 2 minutes in reconnecting", async () => {
    vi.useFakeTimers();
    try {
      render(<UpdaterRestartChrome />);
      act(() => {
        useNimbusStore
          .getState()
          .setUpdaterRestarting({ fromVersion: "0.1.0", toVersion: "0.2.0" });
        useNimbusStore.getState().setUpdaterUiState("reconnecting");
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(useNimbusStore.getState().updaterUiState).toBe("reconnecting");
      await act(async () => {
        vi.advanceTimersByTime(61_000);
      });
      expect(useNimbusStore.getState().updaterUiState).toBe("failed");
      expect(useNimbusStore.getState().updaterFailure).toEqual({ reason: "reconnect_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
