import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, bridgeFailures } = vi.hoisted(() => ({
  // Records bridge commands only; the promise the panel receives comes from the plain wrapper in
  // the module mock below. vi.fn attaches settle handlers to every promise it returns (for
  // mock.settledResults), so a rejection returned by the spy itself would always count as handled
  // and a missing `.catch` on a fire-and-forget bridge call could never surface.
  invokeMock: vi.fn<(cmd: string, args?: unknown) => void>(),
  /** Bridge command → the message it is rejected with. */
  bridgeFailures: new Map<string, string>(),
}));

vi.mock("../../../src/ipc/client");
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown): Promise<unknown> => {
    invokeMock(cmd, args);
    const failure = bridgeFailures.get(cmd);
    return failure === undefined ? Promise.resolve(undefined) : Promise.reject(new Error(failure));
  },
}));

import {
  updaterApplyUpdateMock,
  updaterCheckNowMock,
  updaterGetStatusMock,
  updaterRollbackMock,
} from "../../../src/ipc/__mocks__/client";
import { UpdatesPanel } from "../../../src/pages/settings/UpdatesPanel";
import { useNimbusStore } from "../../../src/store";

const STATUS = {
  state: "idle",
  currentVersion: "0.1.0",
  configUrl: "https://updates.example.test/manifest.json",
} as const;

const RESET = {
  updaterStatus: null,
  updaterUiState: "idle",
  updaterCheck: null,
  updaterDownload: null,
  updaterRestarting: null,
  updaterFailure: null,
} as const;

beforeEach(() => {
  invokeMock.mockReset();
  bridgeFailures.clear();
  updaterApplyUpdateMock.mockReset();
  updaterCheckNowMock.mockReset();
  updaterGetStatusMock.mockReset();
  updaterRollbackMock.mockReset();
  updaterGetStatusMock.mockResolvedValue(STATUS);
  useNimbusStore.setState({ connectionState: "connected", ...RESET });
});

afterEach(() => {
  cleanup();
  useNimbusStore.setState(RESET);
});

async function renderLoaded(): Promise<void> {
  render(<UpdatesPanel />);
  await screen.findByText("0.1.0");
}

describe("UpdatesPanel — status loading", () => {
  it("shows the fetch error and recovers through Retry", async () => {
    updaterGetStatusMock.mockRejectedValueOnce(new Error("gateway asleep"));
    render(<UpdatesPanel />);
    expect(await screen.findByText("Updater error: gateway asleep")).toBeInTheDocument();
    expect(screen.queryByText("Current version:")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("0.1.0")).toBeInTheDocument();
    expect(screen.queryByText(/Updater error:/)).toBeNull();
    expect(updaterGetStatusMock).toHaveBeenCalledTimes(2);
  });

  it("shows the last-checked time only when the status carries one", async () => {
    const iso = "2026-09-30T12:34:56.000Z";
    updaterGetStatusMock.mockResolvedValueOnce({ ...STATUS, lastCheckAt: iso });
    await renderLoaded();
    expect(screen.getByText("Last checked:")).toBeInTheDocument();
    expect(screen.getByText(new Date(iso).toLocaleString(), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/Last error:/)).toBeNull();
  });

  it("omits the last-checked row for a never-checked install", async () => {
    await renderLoaded();
    expect(screen.queryByText("Last checked:")).toBeNull();
    expect(screen.getByText(STATUS.configUrl)).toBeInTheDocument();
  });

  it("labels each status row with its value", async () => {
    const iso = "2026-09-30T12:34:56.000Z";
    updaterGetStatusMock.mockResolvedValueOnce({ ...STATUS, lastCheckAt: iso });
    await renderLoaded();
    expect(screen.getByText("Current version:").parentElement?.textContent).toBe(
      "Current version: 0.1.0",
    );
    expect(screen.getByText("Manifest URL:").parentElement?.textContent).toBe(
      `Manifest URL: ${STATUS.configUrl}`,
    );
    expect(screen.getByText("Last checked:").parentElement?.textContent).toBe(
      `Last checked: ${new Date(iso).toLocaleString()}`,
    );
  });

  it("shows the gateway's last error under the status rows", async () => {
    updaterGetStatusMock.mockResolvedValueOnce({ ...STATUS, lastError: "manifest unreachable" });
    await renderLoaded();
    expect(screen.getByText("Last error: manifest unreachable")).toBeInTheDocument();
  });
});

describe("UpdatesPanel — actions in flight", () => {
  it.each(["applying", "restarting", "reconnecting"] as const)(
    "keeps Check now disabled while the update is %s",
    async (state) => {
      useNimbusStore.setState({ updaterUiState: state });
      await renderLoaded();
      expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    },
  );

  it.each(["applying", "failed"] as const)(
    "does not offer Apply while the UI is %s, even with an update on offer",
    async (state) => {
      useNimbusStore.setState({
        updaterUiState: state,
        updaterCheck: { currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true },
      });
      await renderLoaded();
      expect(screen.queryByRole("button", { name: "Apply 0.2.0" })).toBeNull();
      expect(screen.getByText("New version available: 0.2.0")).toBeInTheDocument();
    },
  );
});

describe("UpdatesPanel — check in flight", () => {
  it("labels and disables the button while checking", async () => {
    let finish: (v: unknown) => void = () => {};
    updaterCheckNowMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    const busy = await screen.findByRole("button", { name: "Checking…" });
    expect(busy).toBeDisabled();

    await act(async () => {
      finish({ currentVersion: "0.1.0", latestVersion: "0.1.0", updateAvailable: false });
    });
    expect(screen.getByRole("button", { name: "Check now" })).not.toBeDisabled();
    expect(screen.queryByText(/New version available/)).toBeNull();
  });

  it("shows the new version without a notes block when the manifest has none", async () => {
    updaterCheckNowMock.mockResolvedValueOnce({
      currentVersion: "0.1.0",
      latestVersion: "0.3.0",
      updateAvailable: true,
    });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("New version available: 0.3.0")).toBeInTheDocument();
    expect(document.querySelector("pre")).toBeNull();
  });
});

describe("UpdatesPanel — download progress", () => {
  it("shows a percentage bar when the download size is known", async () => {
    useNimbusStore.setState({
      updaterUiState: "downloading",
      updaterDownload: { receivedBytes: 50, totalBytes: 200 },
    });
    await renderLoaded();
    expect(screen.getByText("Downloading update…")).toBeInTheDocument();
    expect(screen.getByTestId("download-progress-bar")).toHaveStyle({ width: "25%" });
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
  });

  it("rounds down, so the bar never reads 100% before the last byte arrives", async () => {
    useNimbusStore.setState({
      updaterUiState: "downloading",
      updaterDownload: { receivedBytes: 199, totalBytes: 200 },
    });
    await renderLoaded();
    expect(screen.getByTestId("download-progress-bar")).toHaveStyle({ width: "99%" });
    expect(screen.getByText("99%")).toBeInTheDocument();
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("caps an over-reported download at 100%", async () => {
    useNimbusStore.setState({
      updaterUiState: "downloading",
      updaterDownload: { receivedBytes: 999, totalBytes: 100 },
    });
    await renderLoaded();
    expect(screen.getByTestId("download-progress-bar")).toHaveStyle({ width: "100%" });
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it.each([
    ["an unknown size", { receivedBytes: 10 }],
    ["a zero size", { receivedBytes: 10, totalBytes: 0 }],
  ])("shows an indeterminate bar without a percentage for %s", async (_label, download) => {
    useNimbusStore.setState({ updaterUiState: "downloading", updaterDownload: download });
    await renderLoaded();
    expect(screen.getByTestId("download-progress-bar")).toHaveStyle({ width: "30%" });
    // No percentage line at all, not even a bare "%".
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("hides the download section until a progress payload arrives", async () => {
    useNimbusStore.setState({ updaterUiState: "downloading", updaterDownload: null });
    await renderLoaded();
    expect(screen.queryByText("Downloading update…")).toBeNull();
    expect(screen.queryByTestId("download-progress-bar")).toBeNull();
  });

  it("does not show a stale progress payload outside the downloading state", async () => {
    useNimbusStore.setState({
      updaterUiState: "verifying",
      updaterDownload: { receivedBytes: 50, totalBytes: 100 },
    });
    await renderLoaded();
    expect(screen.queryByTestId("download-progress-bar")).toBeNull();
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
  });
});

describe("UpdatesPanel — terminal states", () => {
  it("names the running version after a successful update", async () => {
    useNimbusStore.setState({ updaterUiState: "success" });
    await renderLoaded();
    expect(screen.getByText("Update applied successfully. Now running 0.1.0.")).toBeInTheDocument();
  });

  it("shows the success message only once an update has succeeded", async () => {
    await renderLoaded();
    expect(screen.queryByText(/Update applied successfully/)).toBeNull();
  });

  it("offers Rollback, with the reason, when the UI reports a rolled-back update", async () => {
    useNimbusStore.setState({
      updaterUiState: "rolled_back",
      updaterFailure: { reason: "signature_invalid" },
    });
    await renderLoaded();
    expect(screen.getByRole("button", { name: "Rollback" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe(
      "Update rejected: signature invalid. Your Nimbus is safe.",
    );
  });

  it("rolls back, then clears the failed update and re-reads the status", async () => {
    let finish: (v: unknown) => void = () => {};
    updaterRollbackMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    useNimbusStore.setState({
      updaterUiState: "failed",
      updaterFailure: { reason: "hash_mismatch" },
      updaterCheck: { currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true },
    });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();

    updaterGetStatusMock.mockResolvedValueOnce({ ...STATUS, currentVersion: "0.0.9" });
    await act(async () => {
      finish({ ok: true });
    });
    expect(await screen.findByText("0.0.9")).toBeInTheDocument();
    expect(useNimbusStore.getState()).toMatchObject({
      updaterUiState: "idle",
      updaterFailure: null,
      updaterCheck: null,
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Updater error:/)).toBeNull();
  });

  it("falls back to a placeholder version before the status has loaded", async () => {
    updaterGetStatusMock.mockReturnValue(new Promise(() => {}));
    useNimbusStore.setState({ updaterUiState: "success" });
    render(<UpdatesPanel />);
    expect(
      screen.getByText("Update applied successfully. Now running new version."),
    ).toBeInTheDocument();
  });

  it("explains a reconnect timeout with recovery steps", async () => {
    useNimbusStore.setState({
      updaterUiState: "failed",
      updaterFailure: { reason: "reconnect_timeout" },
    });
    await renderLoaded();
    expect(screen.getByRole("alert").textContent).toBe(
      "Gateway failed to restart within 2 minutes. Run `nimbus start` in a terminal, then reload.",
    );
    expect(screen.getByRole("button", { name: "Rollback" })).toBeInTheDocument();
  });

  it("keeps the failure message hidden unless the UI is in a failed state", async () => {
    useNimbusStore.setState({
      updaterUiState: "idle",
      updaterFailure: { reason: "reconnect_timeout" },
    });
    await renderLoaded();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();
  });

  it("offers Rollback from a failed gateway state even when the UI is idle", async () => {
    updaterGetStatusMock.mockResolvedValueOnce({ ...STATUS, state: "failed" });
    await renderLoaded();
    expect(screen.getByRole("button", { name: "Rollback" })).toBeInTheDocument();
  });
});

describe("UpdatesPanel — apply failure", () => {
  it("tells the bridge apply finished and swallows a failure of that signal", async () => {
    useNimbusStore.setState({
      updaterUiState: "available",
      updaterCheck: { currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true },
    });
    updaterApplyUpdateMock.mockRejectedValueOnce(new Error("download refused"));
    // A rejected finished-signal that escaped its `.catch` would fail the run as unhandled.
    bridgeFailures.set("updater_apply_finished", "bridge gone");
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Apply 0.2.0" }));

    await waitFor(() => expect(useNimbusStore.getState().updaterUiState).toBe("failed"));
    expect(screen.getByText("Updater error: download refused")).toBeInTheDocument();
    expect(invokeMock.mock.calls.map(([cmd]) => cmd)).toEqual([
      "updater_apply_started",
      "updater_apply_finished",
    ]);
  });

  it("drops the previous attempt's failure reason when a new apply starts", async () => {
    useNimbusStore.setState({
      updaterUiState: "available",
      updaterCheck: { currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true },
      updaterFailure: { reason: "hash_mismatch" },
    });
    updaterApplyUpdateMock.mockRejectedValueOnce(new Error("download refused"));
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Apply 0.2.0" }));

    await waitFor(() => expect(useNimbusStore.getState().updaterUiState).toBe("failed"));
    expect(screen.getByText("Updater error: download refused")).toBeInTheDocument();
    // The stale "hash mismatch" reason belongs to the earlier attempt, not this one.
    expect(useNimbusStore.getState().updaterFailure).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not call the apply RPC when the bridge refuses to start", async () => {
    useNimbusStore.setState({
      updaterUiState: "available",
      updaterCheck: { currentVersion: "0.1.0", latestVersion: "0.2.0", updateAvailable: true },
    });
    bridgeFailures.set("updater_apply_started", "already applying");
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Apply 0.2.0" }));
    expect(await screen.findByText("Updater error: already applying")).toBeInTheDocument();
    expect(updaterApplyUpdateMock).not.toHaveBeenCalled();
    expect(useNimbusStore.getState().updaterUiState).toBe("failed");
    expect(useNimbusStore.getState().updaterFailure).toBeNull();
  });
});
