import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { useNimbusStore } from "../../../src/store";
import { createUpdaterSlice, type UpdaterSlice } from "../../../src/store/slices/updater";

function makeStore() {
  return create<UpdaterSlice>()((...a) => ({ ...createUpdaterSlice(...a) }));
}

describe("updater slice", () => {
  it("seeds idle with all transient fields null", () => {
    const store = makeStore();
    const s = store.getState();
    expect(s.updaterUiState).toBe("idle");
    expect(s.updaterStatus).toBeNull();
    expect(s.updaterCheck).toBeNull();
    expect(s.updaterDownload).toBeNull();
    expect(s.updaterRestarting).toBeNull();
    expect(s.updaterFailure).toBeNull();
  });

  it("setters write each field independently", () => {
    const store = makeStore();
    const status = {
      state: "idle",
      currentVersion: "0.1.0",
      lastCheckedAt: null,
      availableVersion: null,
    } as never;
    store.getState().setUpdaterStatus(status);
    expect(store.getState().updaterStatus).toBe(status);

    store.getState().setUpdaterUiState("checking");
    expect(store.getState().updaterUiState).toBe("checking");

    const check = { updateAvailable: false, currentVersion: "0.1.0" } as never;
    store.getState().setUpdaterCheck(check);
    expect(store.getState().updaterCheck).toBe(check);

    const download = { bytesDownloaded: 1, totalBytes: 10 } as never;
    store.getState().setUpdaterDownload(download);
    expect(store.getState().updaterDownload).toBe(download);

    const restarting = { toVersion: "0.2.0" } as never;
    store.getState().setUpdaterRestarting(restarting);
    expect(store.getState().updaterRestarting).toBe(restarting);

    const failure = { reason: "reconnect_timeout" } as const;
    store.getState().setUpdaterFailure(failure);
    expect(store.getState().updaterFailure).toEqual(failure);
  });

  it("resetUpdaterTransients zeroes everything except updaterStatus", () => {
    const store = makeStore();
    const status = {
      state: "downloading",
      currentVersion: "0.1.0",
      lastCheckedAt: 1,
      availableVersion: "0.2.0",
    } as never;
    store.getState().setUpdaterStatus(status);
    store.getState().setUpdaterUiState("downloading");
    store.getState().setUpdaterCheck({ updateAvailable: true } as never);
    store.getState().setUpdaterDownload({ bytesDownloaded: 5, totalBytes: 10 } as never);
    store.getState().setUpdaterRestarting({ toVersion: "0.2.0" } as never);
    store.getState().setUpdaterFailure({ reason: "reconnect_timeout" });

    store.getState().resetUpdaterTransients();
    const s = store.getState();
    expect(s.updaterStatus).toBe(status);
    expect(s.updaterUiState).toBe("idle");
    expect(s.updaterCheck).toBeNull();
    expect(s.updaterDownload).toBeNull();
    expect(s.updaterRestarting).toBeNull();
    expect(s.updaterFailure).toBeNull();
  });
});

describe("UpdaterSlice — persist whitelist unchanged", () => {
  beforeEach(() => {
    localStorage.clear();
    useNimbusStore.setState({
      updaterStatus: null,
      updaterUiState: "idle",
      updaterCheck: null,
      updaterDownload: null,
      updaterRestarting: null,
      updaterFailure: null,
    } as never);
  });

  it("updaterStatus, updaterUiState, updaterCheck, updaterDownload, updaterRestarting, updaterFailure are NOT persisted", () => {
    useNimbusStore.setState({
      updaterStatus: {
        state: "downloading",
        currentVersion: "0.1.0",
        lastCheckedAt: 1,
        availableVersion: "0.2.0",
      },
      updaterUiState: "downloading",
      updaterCheck: { updateAvailable: true, currentVersion: "0.1.0" },
      updaterDownload: { bytesDownloaded: 5, totalBytes: 10 },
      updaterRestarting: { toVersion: "0.2.0" },
      updaterFailure: { reason: "reconnect_timeout" },
    } as never);
    const raw = localStorage.getItem("nimbus-ui-store");
    if (raw === null) {
      return;
    }
    const parsed = JSON.parse(raw);
    expect(parsed.state?.updaterStatus).toBeUndefined();
    expect(parsed.state?.updaterUiState).toBeUndefined();
    expect(parsed.state?.updaterCheck).toBeUndefined();
    expect(parsed.state?.updaterDownload).toBeUndefined();
    expect(parsed.state?.updaterRestarting).toBeUndefined();
    expect(parsed.state?.updaterFailure).toBeUndefined();
  });
});
