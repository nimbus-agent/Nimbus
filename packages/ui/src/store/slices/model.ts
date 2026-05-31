import type { StateCreator } from "zustand";
import type { LlmPullProgressPayload, RouterStatusResult } from "../../ipc/types";

export interface PersistedModelRow {
  readonly id: string;
  readonly provider: "ollama" | "llamacpp";
}

export interface ModelSlice {
  readonly installedModels: ReadonlyArray<PersistedModelRow>;
  readonly activePullId: string | null;
  readonly routerStatus: RouterStatusResult | null;
  readonly pullProgress: Readonly<Record<string, LlmPullProgressPayload>>;
  readonly pullStalled: boolean;
  readonly loadedKeys: Readonly<Record<string, boolean>>;
  setInstalledModels: (list: ReadonlyArray<PersistedModelRow>) => void;
  setActivePullId: (id: string | null) => void;
  setRouterStatus: (status: RouterStatusResult) => void;
  upsertPullProgress: (p: LlmPullProgressPayload) => void;
  clearPullProgress: (pullId: string) => void;
  setPullStalled: (stalled: boolean) => void;
  patchLoaded: (provider: "ollama" | "llamacpp", modelName: string, isLoaded: boolean) => void;
}

function loadedKey(provider: string, modelName: string): string {
  return `${provider}:${modelName}`;
}

export const createModelSlice: StateCreator<ModelSlice, [], [], ModelSlice> = (set) => ({
  installedModels: [],
  activePullId: null,
  routerStatus: null,
  pullProgress: {},
  pullStalled: false,
  loadedKeys: {},
  setInstalledModels: (list) => set({ installedModels: list }),
  setActivePullId: (id) => set({ activePullId: id }),
  setRouterStatus: (status) => set({ routerStatus: status }),
  upsertPullProgress: (p) =>
    set((s) => ({
      pullProgress: { ...s.pullProgress, [p.pullId]: p },
    })),
  clearPullProgress: (pullId) =>
    set((s) => {
      if (!(pullId in s.pullProgress)) return s;
      const next = { ...s.pullProgress };
      delete (next as Record<string, unknown>)[pullId];
      return { pullProgress: next };
    }),
  setPullStalled: (stalled) => set({ pullStalled: stalled }),
  patchLoaded: (provider, modelName, isLoaded) =>
    set((s) => ({
      loadedKeys: { ...s.loadedKeys, [loadedKey(provider, modelName)]: isLoaded },
    })),
});
