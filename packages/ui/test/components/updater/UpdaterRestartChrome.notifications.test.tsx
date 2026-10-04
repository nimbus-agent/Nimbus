import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, Array<(payload: unknown) => void>>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const arr = listeners.get(event) ?? [];
    const cb = (payload: unknown) => handler({ payload });
    arr.push(cb);
    listeners.set(event, arr);
    return () => {
      const current = listeners.get(event) ?? [];
      listeners.set(
        event,
        current.filter((f) => f !== cb),
      );
    };
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../../../src/ipc/client");

import { invoke } from "@tauri-apps/api/core";
import { UpdaterRestartChrome } from "../../../src/components/updater/UpdaterRestartChrome";
import {
  diagGetVersionMock,
  updaterCheckNowMock,
  updaterGetStatusMock,
} from "../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../src/store";

function fireNotification(method: string, params: unknown = {}) {
  const handlers = listeners.get("gateway://notification") ?? [];
  for (const h of handlers) act(() => h({ method, params }));
}

function fireRestartEvent(event: "updater://restart-started" | "updater://restart-complete") {
  const handlers = listeners.get(event) ?? [];
  for (const h of handlers) act(() => h(null));
}

beforeEach(() => {
  listeners.clear();
  vi.mocked(invoke).mockClear();
  diagGetVersionMock.mockReset();
  updaterCheckNowMock.mockReset();
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

describe("UpdaterRestartChrome — notification handlers", () => {
  it("updater.downloadProgress transitions uiState to downloading", async () => {
    render(<UpdaterRestartChrome />);
    fireNotification("updater.downloadProgress", { bytesDownloaded: 1024, totalBytes: 4096 });
    expect(useNimbusStore.getState().updaterUiState).toBe("downloading");
    expect(useNimbusStore.getState().updaterDownload).toMatchObject({ bytesDownloaded: 1024 });
  });

  it("updater.downloadProgress does not re-set uiState when already downloading", async () => {
    render(<UpdaterRestartChrome />);
    act(() => useNimbusStore.getState().setUpdaterUiState("downloading"));
    const setUiState = vi.spyOn(useNimbusStore.getState(), "setUpdaterUiState");
    fireNotification("updater.downloadProgress", { bytesDownloaded: 2048, totalBytes: 4096 });
    expect(setUiState).not.toHaveBeenCalled();
    setUiState.mockRestore();
  });

  it("updater.restarting sets restarting payload and uiState", () => {
    render(<UpdaterRestartChrome />);
    fireNotification("updater.restarting", { fromVersion: "0.1.0", toVersion: "0.2.0" });
    expect(useNimbusStore.getState().updaterUiState).toBe("restarting");
    expect(useNimbusStore.getState().updaterRestarting).toMatchObject({ toVersion: "0.2.0" });
  });

  it("updater.rolledBack sets failure and uiState to rolled_back", () => {
    render(<UpdaterRestartChrome />);
    fireNotification("updater.rolledBack", { reason: "installer_failed" });
    expect(useNimbusStore.getState().updaterUiState).toBe("rolled_back");
    expect(useNimbusStore.getState().updaterFailure).toMatchObject({ reason: "installer_failed" });
  });

  it("updater.verifyFailed sets failure and uiState to failed", () => {
    render(<UpdaterRestartChrome />);
    fireNotification("updater.verifyFailed", { reason: "signature_mismatch" });
    expect(useNimbusStore.getState().updaterUiState).toBe("failed");
    expect(useNimbusStore.getState().updaterFailure).toMatchObject({
      reason: "signature_mismatch",
    });
  });

  it("updater.updateAvailable fetches check and transitions to available", async () => {
    const checkResult = { currentVersion: "0.1.0", latestVersion: "0.2.0", releaseNotes: null };
    updaterCheckNowMock.mockResolvedValueOnce(checkResult);
    render(<UpdaterRestartChrome />);
    await act(async () => {
      fireNotification("updater.updateAvailable");
      await Promise.resolve();
    });
    expect(useNimbusStore.getState().updaterUiState).toBe("available");
    expect(useNimbusStore.getState().updaterCheck).toMatchObject(checkResult);
  });

  it("restart-started transitions uiState to reconnecting", () => {
    render(<UpdaterRestartChrome />);
    fireRestartEvent("updater://restart-started");
    expect(useNimbusStore.getState().updaterUiState).toBe("reconnecting");
  });

  it("restart-complete: version matches → success", async () => {
    diagGetVersionMock.mockResolvedValueOnce({ version: "0.2.0", commit: "abc", buildId: "1" });
    updaterGetStatusMock.mockResolvedValueOnce({
      currentVersion: "0.2.0",
      lastCheckAt: null,
      manifest: null,
    });
    render(<UpdaterRestartChrome />);
    act(() => {
      useNimbusStore.getState().setUpdaterRestarting({ fromVersion: "0.1.0", toVersion: "0.2.0" });
    });
    await act(async () => {
      fireRestartEvent("updater://restart-complete");
      await Promise.resolve();
    });
    expect(useNimbusStore.getState().updaterUiState).toBe("success");
  });

  it("restart-complete: version mismatch → rolled_back", async () => {
    diagGetVersionMock.mockResolvedValueOnce({ version: "0.1.0", commit: "abc", buildId: "1" });
    render(<UpdaterRestartChrome />);
    act(() => {
      useNimbusStore.getState().setUpdaterRestarting({ fromVersion: "0.1.0", toVersion: "0.2.0" });
    });
    await act(async () => {
      fireRestartEvent("updater://restart-complete");
      await Promise.resolve();
    });
    expect(useNimbusStore.getState().updaterUiState).toBe("rolled_back");
  });

  it("restart-complete: diag throws → failed", async () => {
    diagGetVersionMock.mockRejectedValueOnce(new Error("network"));
    render(<UpdaterRestartChrome />);
    await act(async () => {
      fireRestartEvent("updater://restart-complete");
      await Promise.resolve();
    });
    expect(useNimbusStore.getState().updaterUiState).toBe("failed");
  });

  // The restart-complete handler fires its async check with `void`, which is only honest while the
  // check owns every failure itself. These pin that: each path ends in a surfaced UI state AND the
  // `updater_apply_finished` signal to the shell, with nothing left to reject.
  it("restart-complete: a failing status refresh after a version match is non-fatal", async () => {
    diagGetVersionMock.mockResolvedValueOnce({ version: "0.2.0", commit: "abc", buildId: "1" });
    updaterGetStatusMock.mockRejectedValueOnce(new Error("status unavailable"));
    render(<UpdaterRestartChrome />);
    act(() => {
      useNimbusStore.getState().setUpdaterRestarting({ fromVersion: "0.1.0", toVersion: "0.2.0" });
    });
    await act(async () => {
      fireRestartEvent("updater://restart-complete");
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("updater_apply_finished"));
    expect(useNimbusStore.getState().updaterUiState).toBe("success");
    expect(useNimbusStore.getState().updaterStatus).toBeNull();
    expect(useNimbusStore.getState().updaterFailure).toBeNull();
  });

  it("restart-complete: a failed version probe still signals the shell", async () => {
    diagGetVersionMock.mockRejectedValueOnce(new Error("network"));
    render(<UpdaterRestartChrome />);
    await act(async () => {
      fireRestartEvent("updater://restart-complete");
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("updater_apply_finished"));
    expect(useNimbusStore.getState().updaterFailure).toEqual({ reason: "installer_failed" });
  });

  it("restart-complete: no recorded target version reads as rolled_back, not success", async () => {
    // `updaterRestarting` is null (no `updater.restarting` seen), so there is no version to match.
    diagGetVersionMock.mockResolvedValueOnce({ version: "0.2.0", commit: "abc", buildId: "1" });
    render(<UpdaterRestartChrome />);
    await act(async () => {
      fireRestartEvent("updater://restart-complete");
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("updater_apply_finished"));
    expect(useNimbusStore.getState().updaterUiState).toBe("rolled_back");
    expect(useNimbusStore.getState().updaterFailure).toEqual({ reason: "installer_failed" });
  });
});
