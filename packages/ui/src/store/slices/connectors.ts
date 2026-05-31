import type { StateCreator } from "zustand";
import type { ConnectorHealth } from "../../ipc/types";

export interface PersistedConnectorRow {
  readonly service: string;
  readonly intervalMs: number;
  readonly depth: "metadata_only" | "summary" | "full";
  readonly enabled: boolean;
  readonly health: ConnectorHealth;
}

export interface ConnectorsSlice {
  readonly connectorsList: ReadonlyArray<PersistedConnectorRow>;
  readonly perServiceInFlight: Readonly<Record<string, boolean>>;
  readonly highlightService: string | null;
  setConnectorsList: (list: ReadonlyArray<PersistedConnectorRow>) => void;
  setConnectorInFlight: (service: string, inFlight: boolean) => void;
  setHighlightService: (service: string | null) => void;
  patchConnectorRow: (service: string, patch: Partial<PersistedConnectorRow>) => void;
}

export const createConnectorsSlice: StateCreator<ConnectorsSlice, [], [], ConnectorsSlice> = (
  set,
) => ({
  connectorsList: [],
  perServiceInFlight: {},
  highlightService: null,
  setConnectorsList: (list) => set({ connectorsList: list }),
  setConnectorInFlight: (service, inFlight) =>
    set((s) => ({
      perServiceInFlight: { ...s.perServiceInFlight, [service]: inFlight },
    })),
  setHighlightService: (service) => set({ highlightService: service }),
  patchConnectorRow: (service, patch) =>
    set((s) => ({
      connectorsList: s.connectorsList.map((r) => (r.service === service ? { ...r, ...patch } : r)),
    })),
});
