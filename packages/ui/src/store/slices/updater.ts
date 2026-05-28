import type { StateCreator } from "zustand";
import type {
  UpdaterCheckResult,
  UpdaterDownloadProgressPayload,
  UpdaterRestartingPayload,
  UpdaterRolledBackPayload,
  UpdaterStatus,
  UpdaterVerifyFailedPayload,
} from "../../ipc/types";

export type UpdaterUiState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "verifying"
  | "applying"
  | "restarting"
  | "reconnecting"
  | "success"
  | "rolled_back"
  | "failed";

export type UpdaterFailure =
  | UpdaterRolledBackPayload
  | UpdaterVerifyFailedPayload
  | { reason: "reconnect_timeout" };

export interface UpdaterSlice {
  readonly updaterStatus: UpdaterStatus | null;
  readonly updaterUiState: UpdaterUiState;
  readonly updaterCheck: UpdaterCheckResult | null;
  readonly updaterDownload: UpdaterDownloadProgressPayload | null;
  readonly updaterRestarting: UpdaterRestartingPayload | null;
  readonly updaterFailure: UpdaterFailure | null;
  setUpdaterStatus: (status: UpdaterStatus | null) => void;
  setUpdaterUiState: (state: UpdaterUiState) => void;
  setUpdaterCheck: (check: UpdaterCheckResult | null) => void;
  setUpdaterDownload: (progress: UpdaterDownloadProgressPayload | null) => void;
  setUpdaterRestarting: (payload: UpdaterRestartingPayload | null) => void;
  setUpdaterFailure: (failure: UpdaterFailure | null) => void;
  resetUpdaterTransients: () => void;
}

export const createUpdaterSlice: StateCreator<UpdaterSlice, [], [], UpdaterSlice> = (set) => ({
  updaterStatus: null,
  updaterUiState: "idle",
  updaterCheck: null,
  updaterDownload: null,
  updaterRestarting: null,
  updaterFailure: null,
  setUpdaterStatus: (status) => set({ updaterStatus: status }),
  setUpdaterUiState: (state) => set({ updaterUiState: state }),
  setUpdaterCheck: (check) => set({ updaterCheck: check }),
  setUpdaterDownload: (progress) => set({ updaterDownload: progress }),
  setUpdaterRestarting: (payload) => set({ updaterRestarting: payload }),
  setUpdaterFailure: (failure) => set({ updaterFailure: failure }),
  resetUpdaterTransients: () =>
    set({
      updaterUiState: "idle",
      updaterCheck: null,
      updaterDownload: null,
      updaterRestarting: null,
      updaterFailure: null,
    }),
});
