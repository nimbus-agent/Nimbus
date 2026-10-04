import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");

import { callMock, connectorSetConfigMock, subscribeMock } from "../../../src/ipc/__mocks__/client";
import { ConnectorsPanel } from "../../../src/pages/settings/ConnectorsPanel";
import { useNimbusStore } from "../../../src/store";

type Handler = (n: { method: string; params: unknown }) => void;

function stubListStatus(rows: unknown): void {
  callMock.mockImplementation(async (method: string) => {
    if (method === "connector.listStatus") return rows;
    throw new Error(`unexpected method in test: ${method}`);
  });
}

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={["/settings/connectors"]}>
      <ConnectorsPanel />
    </MemoryRouter>,
  );
}

const GITHUB = {
  name: "github",
  health: "healthy",
  intervalMs: 120000,
  depth: "summary",
  enabled: true,
};

function dotFor(service: string): string {
  const row = screen.getByTestId(`connector-row-${service}`);
  const dot = row.querySelector("span[aria-hidden]");
  if (dot === null) throw new Error(`no health dot for ${service}`);
  return dot.className;
}

// Captured before any test can swap it for a spy, and restored before every test.
const realPatchConnectorRow = useNimbusStore.getState().patchConnectorRow;

beforeEach(() => {
  callMock.mockReset();
  connectorSetConfigMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockResolvedValue(() => {});
  useNimbusStore.setState({
    connectorsList: [],
    perServiceInFlight: {},
    highlightService: null,
    connectionState: "connected",
    patchConnectorRow: realPatchConnectorRow,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ConnectorsPanel — row rendering", () => {
  it("renders a distinct health dot per state, grey for anything unrecognised", async () => {
    const health = [
      ["svc-healthy", "healthy", "bg-green-500"],
      ["svc-degraded", "degraded", "bg-yellow-500"],
      ["svc-ratelimited", "rate_limited", "bg-amber-500"],
      ["svc-unauth", "unauthenticated", "bg-orange-500"],
      ["svc-error", "error", "bg-red-500"],
      ["svc-paused", "paused", "bg-gray-400"],
      ["svc-unconfigured", "not_configured", "bg-gray-400"],
    ] as const;
    stubListStatus(health.map(([name, h]) => ({ ...GITHUB, name, health: h })));
    renderPanel();
    await screen.findByTestId("connector-row-svc-unconfigured");

    for (const [name, , cls] of health) {
      expect(dotFor(name)).toContain(cls);
    }
    const all = ["bg-green-500", "bg-yellow-500", "bg-amber-500", "bg-orange-500", "bg-red-500"];
    for (const other of all) expect(dotFor("svc-paused")).not.toContain(other);
  });

  it("fills in defaults for a connector that reports no config", async () => {
    stubListStatus([{ name: "jira", health: "healthy" }]);
    renderPanel();
    await screen.findByTestId("connector-row-jira");
    expect(screen.getByLabelText("jira interval value")).toHaveValue(1);
    expect(screen.getByLabelText("jira interval unit")).toHaveValue("min");
    expect(screen.getByLabelText("jira depth")).toHaveValue("summary");
    expect(screen.getByLabelText("jira enabled")).toBeChecked();
    expect(useNimbusStore.getState().connectorsList).toEqual([
      { service: "jira", intervalMs: 60_000, depth: "summary", enabled: true, health: "healthy" },
    ]);
  });
});

describe("ConnectorsPanel — loading and highlighting", () => {
  it("names the failure when the connector list cannot be loaded", async () => {
    callMock.mockRejectedValue(new Error("gateway restarting"));
    renderPanel();
    expect(
      await screen.findByText("Failed to load connector status: gateway restarting"),
    ).toBeInTheDocument();
  });

  it("rings only the connector named by ?highlight", async () => {
    stubListStatus([GITHUB, { ...GITHUB, name: "jira" }]);
    render(
      <MemoryRouter initialEntries={["/settings/connectors?highlight=jira"]}>
        <ConnectorsPanel />
      </MemoryRouter>,
    );
    const jira = await screen.findByTestId("connector-row-jira");
    expect(jira.classList.contains("ring-2")).toBe(true);
    expect(screen.getByTestId("connector-row-github").classList.contains("ring-2")).toBe(false);
  });
});

describe("ConnectorsPanel — interval validation", () => {
  it("accepts exactly the one-minute minimum and saves it", async () => {
    vi.useFakeTimers();
    stubListStatus([GITHUB]);
    connectorSetConfigMock.mockResolvedValue({
      service: "github",
      intervalMs: 60_000,
      depth: null,
      enabled: null,
    });
    renderPanel();
    const input = await screen.findByLabelText("github interval value");
    fireEvent.change(input, { target: { value: "1" } });
    expect(screen.queryByText("minimum 60 seconds")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(connectorSetConfigMock).toHaveBeenCalledWith("github", { intervalMs: 60_000 });
  });

  it("flags a sub-minute interval and clears the flag once the value is valid again", async () => {
    stubListStatus([GITHUB]);
    renderPanel();
    const input = await screen.findByLabelText("github interval value");
    // 2 min -> 2 sec.
    fireEvent.change(screen.getByLabelText("github interval unit"), { target: { value: "sec" } });
    expect(screen.getByText("minimum 60 seconds")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.className).toContain("border-[var(--color-danger-border)]");

    fireEvent.change(input, { target: { value: "90" } });
    expect(screen.queryByText("minimum 60 seconds")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input.className).not.toContain("border-[var(--color-danger-border)]");
  });

  it("combines a typed value with a unit change made before the save fires", async () => {
    vi.useFakeTimers();
    stubListStatus([GITHUB]);
    connectorSetConfigMock.mockResolvedValue({
      service: "github",
      intervalMs: 10_800_000,
      depth: null,
      enabled: null,
    });
    renderPanel();
    const input = await screen.findByLabelText("github interval value");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("github interval unit"), { target: { value: "hr" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(connectorSetConfigMock).toHaveBeenCalledTimes(1);
    expect(connectorSetConfigMock).toHaveBeenCalledWith("github", { intervalMs: 10_800_000 });
  });

  it("hides Saving… while the interval field shows an error", async () => {
    let finish: (v: unknown) => void = () => {};
    connectorSetConfigMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    stubListStatus([GITHUB]);
    renderPanel();
    fireEvent.click(await screen.findByLabelText("github enabled"));
    expect(await screen.findByText("Saving…")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("github interval unit"), { target: { value: "sec" } });
    expect(screen.getByText("minimum 60 seconds")).toBeInTheDocument();
    expect(screen.queryByText("Saving…")).toBeNull();
    await act(async () => {
      finish({ service: "github", intervalMs: null, depth: null, enabled: false });
    });
  });
});

describe("ConnectorsPanel — interval editing", () => {
  it("restarts the debounce when the value changes again before it fires", async () => {
    vi.useFakeTimers();
    stubListStatus([GITHUB]);
    connectorSetConfigMock.mockResolvedValue({
      service: "github",
      intervalMs: 240000,
      depth: null,
      enabled: null,
    });
    renderPanel();
    await screen.findByLabelText("github interval value");
    const input = screen.getByLabelText("github interval value");

    fireEvent.change(input, { target: { value: "3" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(input, { target: { value: "4" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(connectorSetConfigMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(connectorSetConfigMock).toHaveBeenCalledTimes(1);
    expect(connectorSetConfigMock).toHaveBeenCalledWith("github", { intervalMs: 240000 });
  });

  it.each([
    ["zero", "0"],
    ["an empty field", ""],
  ])("shows %s in the field but schedules no save", async (_label, raw) => {
    vi.useFakeTimers();
    stubListStatus([GITHUB]);
    renderPanel();
    await screen.findByLabelText("github interval value");
    const input = screen.getByLabelText("github interval value");
    fireEvent.change(input, { target: { value: raw } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(input).toHaveValue(raw === "" ? null : Number(raw));
    expect(connectorSetConfigMock).not.toHaveBeenCalled();
    expect(screen.queryByText("minimum 60 seconds")).toBeNull();
  });

  it("shows Saving… while a write is in flight, then applies the patch", async () => {
    let finish: (v: unknown) => void = () => {};
    connectorSetConfigMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    stubListStatus([GITHUB]);
    renderPanel();
    await screen.findByLabelText("github enabled");
    fireEvent.click(screen.getByLabelText("github enabled"));

    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(useNimbusStore.getState().perServiceInFlight["github"]).toBe(true);
    expect(screen.getByLabelText("github enabled")).toBeChecked();

    await act(async () => {
      finish({ service: "github", intervalMs: null, depth: null, enabled: false });
    });
    expect(screen.queryByText("Saving…")).toBeNull();
    expect(useNimbusStore.getState().perServiceInFlight["github"]).toBe(false);
    expect(screen.getByLabelText("github enabled")).not.toBeChecked();
  });
});

describe("ConnectorsPanel — configChanged notifications", () => {
  async function renderCapturing(): Promise<Handler> {
    let captured: Handler | null = null;
    subscribeMock.mockImplementation(async (handler: Handler) => {
      captured = handler;
      return () => {};
    });
    stubListStatus([GITHUB]);
    renderPanel();
    await screen.findByLabelText("github depth");
    await waitFor(() => expect(captured).not.toBeNull());
    const handler = captured as Handler | null;
    if (handler === null) throw new Error("subscription handler never registered");
    return handler;
  }

  it("ignores other notification methods", async () => {
    const handler = await renderCapturing();
    act(() =>
      handler({
        method: "connector.healthChanged",
        params: { service: "github", intervalMs: 600000, depth: "full", enabled: false },
      }),
    );
    expect(screen.getByLabelText("github depth")).toHaveValue("summary");
    expect(screen.getByLabelText("github enabled")).toBeChecked();
  });

  // The store's patchConnectorRow skips a service it does not know, so a payload with a non-string
  // service would leave the list untouched even if the panel forwarded it. Spying on the store action
  // is what makes "the panel drops it" observable at all.
  it.each([
    ["a null payload", null],
    ["a payload without a string service", { service: 42, depth: "full" }],
  ])("never forwards a configChanged notification with %s to the store", async (_label, params) => {
    const patchConnectorRow = vi.fn();
    useNimbusStore.setState({ patchConnectorRow });
    const handler = await renderCapturing();
    act(() => handler({ method: "connector.configChanged", params }));
    expect(patchConnectorRow).not.toHaveBeenCalled();

    // Control: the same handler does forward a well-formed payload to the spy.
    act(() =>
      handler({ method: "connector.configChanged", params: { service: "github", depth: "full" } }),
    );
    expect(patchConnectorRow).toHaveBeenCalledTimes(1);
    expect(patchConnectorRow.mock.calls[0]?.[0]).toBe("github");
  });

  it("resets the field and clears its error when the gateway reports a new interval", async () => {
    const handler = await renderCapturing();
    fireEvent.change(screen.getByLabelText("github interval unit"), { target: { value: "sec" } });
    expect(screen.getByText("minimum 60 seconds")).toBeInTheDocument();

    act(() =>
      handler({
        method: "connector.configChanged",
        params: { service: "github", intervalMs: 300_000, depth: "summary", enabled: true },
      }),
    );
    expect(screen.queryByText("minimum 60 seconds")).toBeNull();
    expect(screen.getByLabelText("github interval value")).toHaveValue(5);
    expect(screen.getByLabelText("github interval unit")).toHaveValue("min");
  });

  it("applies a well-formed configChanged notification (control)", async () => {
    const handler = await renderCapturing();
    act(() =>
      handler({
        method: "connector.configChanged",
        params: { service: "github", intervalMs: 7_200_000, depth: "full", enabled: true },
      }),
    );
    expect(screen.getByLabelText("github depth")).toHaveValue("full");
    expect(screen.getByLabelText("github interval value")).toHaveValue(2);
    expect(screen.getByLabelText("github interval unit")).toHaveValue("hr");
  });
});

describe("ConnectorsPanel — subscription lifecycle", () => {
  it("releases a subscription that only resolves after the panel unmounted", async () => {
    let resolveSub: (fn: () => void) => void = () => {};
    subscribeMock.mockImplementation(
      () =>
        new Promise<() => void>((r) => {
          resolveSub = r;
        }),
    );
    stubListStatus([GITHUB]);
    const { unmount } = renderPanel();
    await screen.findByLabelText("github depth");
    unmount();

    const unlisten = vi.fn();
    await act(async () => {
      resolveSub(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("releases a live subscription exactly once on unmount", async () => {
    const unlisten = vi.fn();
    subscribeMock.mockImplementation(async () => unlisten);
    stubListStatus([GITHUB]);
    const { unmount } = renderPanel();
    await screen.findByLabelText("github depth");
    expect(unlisten).not.toHaveBeenCalled();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
