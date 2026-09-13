import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorStatus } from "../../../src/ipc/types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

const patchConnectorSpy = vi.fn<(name: string, patch: Partial<ConnectorStatus>) => void>();

// What `connector.listStatus` returns to `useIpcQuery` — defaults to the gateway's real wire
// shape (`SyncStatus`: `serviceId`/`healthState`, no `name`/`health`). Individual tests below
// that only care about a preset `store.connectors` never read this, since their `setConnectors`
// stays the default no-op.
let wireListStatus: unknown = [{ serviceId: "drive", healthState: "healthy" }];

const store: {
  connectors: ConnectorStatus[];
  highlightConnector: string | null;
  setConnectors: (c: ConnectorStatus[]) => void;
  patchConnector: (name: string, patch: Partial<ConnectorStatus>) => void;
  recomputeAggregate: (c: ConnectorStatus[]) => void;
  setConnectorsMenu: (items: Array<{ name: string; health: ConnectorStatus["health"] }>) => void;
} = {
  connectors: [{ name: "drive", health: "healthy" }],
  highlightConnector: null,
  setConnectors: () => undefined,
  patchConnector: patchConnectorSpy,
  recomputeAggregate: () => undefined,
  setConnectorsMenu: () => undefined,
};

vi.mock("../../../src/store", () => ({
  useNimbusStore: (sel: (s: typeof store) => unknown) => sel(store),
}));

vi.mock("../../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: () => ({ data: wireListStatus, error: null, isLoading: false }),
}));

type HealthPayload = {
  name: string;
  health: ConnectorStatus["health"];
  degradationReason?: string;
};
let capturedHealthHandler: ((payload: HealthPayload) => void) | null = null;

vi.mock("../../../src/hooks/useIpcSubscription", () => ({
  useIpcSubscription: (_event: string, handler: (payload: HealthPayload) => void) => {
    capturedHealthHandler = handler;
  },
}));

import { ConnectorGrid } from "../../../src/components/dashboard/ConnectorGrid";

beforeEach(() => {
  patchConnectorSpy.mockReset();
  capturedHealthHandler = null;
  store.connectors = [{ name: "drive", health: "healthy" }];
  store.setConnectors = () => undefined;
  store.patchConnector = patchConnectorSpy;
  wireListStatus = [{ serviceId: "drive", healthState: "healthy" }];
});

describe("ConnectorGrid", () => {
  it("renders one tile per connector", () => {
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Google Drive/)).toBeInTheDocument();
  });

  it("shows empty state when no connectors", () => {
    store.connectors = [];
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No connectors configured/i)).toBeInTheDocument();
  });

  it("onHealth: CLEARS degradationReason (sets it to undefined) when the payload omits it", () => {
    // `patchConnector` merges via `{ ...x, ...patch }`, so omitting the key would leave a STALE
    // amber reason from a previous degraded state on the row after a recovery. The key must be
    // explicitly present with value `undefined`, not merely absent — `toHaveProperty` (unlike
    // `toHaveBeenCalledWith`, which by design treats `{ a: undefined }` as equal to `{}`) is what
    // actually distinguishes the two.
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    act(() => {
      capturedHealthHandler?.({ name: "drive", health: "degraded" });
    });
    const patch = patchConnectorSpy.mock.calls[0]?.[1];
    expect(patch).toHaveProperty("degradationReason");
    expect(patch?.degradationReason).toBeUndefined();
  });

  it("onHealth: includes degradationReason when present in payload", () => {
    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );
    act(() => {
      capturedHealthHandler?.({
        name: "drive",
        health: "rate_limited",
        degradationReason: "too many requests",
      });
    });
    expect(patchConnectorSpy).toHaveBeenCalledWith("drive", {
      health: "rate_limited",
      degradationReason: "too many requests",
    });
  });

  it("maps a real connector.listStatus (SyncStatus) row so a later health-changed patch lands on it", () => {
    // Real wire shape from the gateway (`SyncStatus`, `packages/gateway/src/sync/types.ts`):
    // `serviceId`/`healthState`, no `name`/`health` at all. Wire `setConnectors`/`patchConnector`
    // up to real (store-mutating) semantics for this test only, so the assertions below prove the
    // mapping landed in the shape `patchConnector`'s `x.name === name` actually matches on — not
    // just that the RPC mock returned something.
    store.setConnectors = (c) => {
      store.connectors = c;
    };
    store.patchConnector = (name, patch) => {
      patchConnectorSpy(name, patch);
      store.connectors = store.connectors.map((x) => (x.name === name ? { ...x, ...patch } : x));
    };
    wireListStatus = [
      {
        serviceId: "drive",
        status: "ok",
        healthState: "healthy",
        lastError: null,
        itemCount: 12,
        intervalMs: 60_000,
        depth: "summary",
        enabled: true,
      },
    ];
    store.connectors = [];

    render(
      <MemoryRouter>
        <ConnectorGrid />
      </MemoryRouter>,
    );

    // The initial fetch mapped `serviceId` -> `name` and `healthState` -> `health`, plus the
    // other listed fields — not `undefined`, which is what the unchecked-assertion bug produced.
    expect(store.connectors).toEqual([
      expect.objectContaining({
        name: "drive",
        health: "healthy",
        itemCount: 12,
        intervalMs: 60_000,
        depth: "summary",
        enabled: true,
      }),
    ]);

    act(() => {
      capturedHealthHandler?.({ name: "drive", health: "degraded" });
    });

    // The patch actually LANDS: `patchConnector`'s `x.name === name` now has a real "drive" row
    // to match, rather than every row's `name` being `undefined`.
    expect(patchConnectorSpy).toHaveBeenCalledWith("drive", { health: "degraded" });
    expect(store.connectors[0]?.health).toBe("degraded");
  });
});
