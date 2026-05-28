import { beforeEach, describe, expect, it } from "vitest";
import { useNimbusStore } from "../../../src/store";

beforeEach(() => {
  localStorage.clear();
  useNimbusStore.setState({
    connectorsList: [],
    perServiceInFlight: {},
    highlightService: null,
  } as never);
});

describe("ConnectorsSlice — Plan 3 additions", () => {
  it("setConnectorInFlight flips the per-service flag", () => {
    useNimbusStore.getState().setConnectorInFlight("github", true);
    expect(useNimbusStore.getState().perServiceInFlight.github).toBe(true);
    useNimbusStore.getState().setConnectorInFlight("github", false);
    expect(useNimbusStore.getState().perServiceInFlight.github).toBe(false);
  });

  it("setConnectorInFlight does not leak across services", () => {
    useNimbusStore.getState().setConnectorInFlight("github", true);
    useNimbusStore.getState().setConnectorInFlight("slack", true);
    expect(useNimbusStore.getState().perServiceInFlight).toEqual({
      github: true,
      slack: true,
    });
  });

  it("setHighlightService stores and clears the highlight target", () => {
    useNimbusStore.getState().setHighlightService("slack");
    expect(useNimbusStore.getState().highlightService).toBe("slack");
    useNimbusStore.getState().setHighlightService(null);
    expect(useNimbusStore.getState().highlightService).toBeNull();
  });

  it("patchConnectorRow upserts an intervalMs change on a matching row", () => {
    useNimbusStore.setState({
      connectorsList: [
        {
          service: "github",
          intervalMs: 60000,
          depth: "summary",
          enabled: true,
          health: "healthy",
        },
      ],
    } as never);
    useNimbusStore.getState().patchConnectorRow("github", { intervalMs: 120000 });
    const row = useNimbusStore.getState().connectorsList.find((r) => r.service === "github");
    expect(row?.intervalMs).toBe(120000);
    expect(row?.depth).toBe("summary");
    expect(row?.enabled).toBe(true);
  });

  it("patchConnectorRow is a no-op for unknown services (empty list)", () => {
    useNimbusStore.getState().patchConnectorRow("unknown", { enabled: false });
    expect(useNimbusStore.getState().connectorsList).toEqual([]);
  });

  it("patchConnectorRow leaves non-matching rows in a populated list untouched", () => {
    useNimbusStore.setState({
      connectorsList: [
        {
          service: "github",
          intervalMs: 60000,
          depth: "summary",
          enabled: true,
          health: "healthy",
        },
      ],
    } as never);
    useNimbusStore.getState().patchConnectorRow("slack", { enabled: false });
    const row = useNimbusStore.getState().connectorsList[0];
    expect(row.service).toBe("github");
    expect(row.enabled).toBe(true);
  });
});

describe("ConnectorsSlice — persist whitelist unchanged", () => {
  it("perServiceInFlight and highlightService are NOT persisted", () => {
    useNimbusStore.setState({
      perServiceInFlight: { github: true },
      highlightService: "slack",
    } as never);
    const raw = localStorage.getItem("nimbus-ui-store");
    if (raw === null) {
      return;
    }
    const parsed = JSON.parse(raw);
    expect(parsed.state?.perServiceInFlight).toBeUndefined();
    expect(parsed.state?.highlightService).toBeUndefined();
  });
});
