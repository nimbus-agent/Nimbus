import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");

import { callMock, connectorSetConfigMock, subscribeMock } from "../../../src/ipc/__mocks__/client";
import { ConnectorsPanel } from "../../../src/pages/settings/ConnectorsPanel";
import { useNimbusStore } from "../../../src/store";

function renderPanel(initialEntries: string[] = ["/settings/connectors"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ConnectorsPanel />
    </MemoryRouter>,
  );
}

function stubListStatus(rows: unknown): void {
  callMock.mockImplementation(async (method: string) => {
    if (method === "connector.listStatus") return rows;
    throw new Error(`unexpected method in test: ${method}`);
  });
}

beforeEach(() => {
  localStorage.clear();
  callMock.mockReset();
  connectorSetConfigMock.mockReset();
  subscribeMock.mockReset();
  subscribeMock.mockResolvedValue(() => {});
  useNimbusStore.setState({
    connectorsList: [],
    perServiceInFlight: {},
    highlightService: null,
    connectionState: "connected",
  });
});

describe("ConnectorsPanel", () => {
  it("fetches listStatus on mount and renders one row per connector with the current fields", async () => {
    stubListStatus([
      {
        name: "github",
        health: "healthy",
        intervalMs: 120000,
        depth: "summary",
        enabled: true,
      },
      {
        name: "slack",
        health: "rate_limited",
        intervalMs: 300000,
        depth: "metadata_only",
        enabled: false,
      },
    ]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("github")).toBeInTheDocument();
      expect(screen.getByText("slack")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("github interval value")).toHaveValue(2);
    expect(screen.getByLabelText("github interval unit")).toHaveValue("min");
    expect(screen.getByLabelText("slack enabled")).not.toBeChecked();
  });

  it("editing the interval debounces by 500 ms then calls setConfig in ms", async () => {
    vi.useFakeTimers();
    try {
      stubListStatus([
        {
          name: "github",
          health: "healthy",
          intervalMs: 120000,
          depth: "summary",
          enabled: true,
        },
      ]);
      connectorSetConfigMock.mockResolvedValueOnce({
        service: "github",
        intervalMs: 180000,
        depth: null,
        enabled: null,
      });
      renderPanel();
      await screen.findByLabelText("github interval value");
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const input = screen.getByLabelText("github interval value");
      await user.clear(input);
      await user.type(input, "3");
      expect(connectorSetConfigMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      await waitFor(() =>
        expect(connectorSetConfigMock).toHaveBeenCalledWith("github", { intervalMs: 180000 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("below-60-second interval shows inline error and never calls setConfig", async () => {
    vi.useFakeTimers();
    try {
      stubListStatus([
        {
          name: "github",
          health: "healthy",
          intervalMs: 120000,
          depth: "summary",
          enabled: true,
        },
      ]);
      renderPanel();
      await screen.findByLabelText("github interval value");
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const input = screen.getByLabelText("github interval value");
      const unit = screen.getByLabelText("github interval unit");
      await user.selectOptions(unit, "sec");
      await user.clear(input);
      await user.type(input, "30");
      vi.advanceTimersByTime(500);
      expect(screen.getByText(/minimum 60 seconds/i)).toBeInTheDocument();
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(connectorSetConfigMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("changing the depth select fires setConfig with the new depth", async () => {
    stubListStatus([
      {
        name: "github",
        health: "healthy",
        intervalMs: 120000,
        depth: "summary",
        enabled: true,
      },
    ]);
    connectorSetConfigMock.mockResolvedValueOnce({
      service: "github",
      intervalMs: null,
      depth: "full",
      enabled: null,
    });
    renderPanel();
    await screen.findByLabelText("github depth");
    await userEvent.selectOptions(screen.getByLabelText("github depth"), "full");
    await waitFor(() =>
      expect(connectorSetConfigMock).toHaveBeenCalledWith("github", { depth: "full" }),
    );
  });

  it("toggling the enabled checkbox fires setConfig with the flipped value", async () => {
    stubListStatus([
      {
        name: "github",
        health: "healthy",
        intervalMs: 120000,
        depth: "summary",
        enabled: true,
      },
    ]);
    connectorSetConfigMock.mockResolvedValueOnce({
      service: "github",
      intervalMs: null,
      depth: null,
      enabled: false,
    });
    renderPanel();
    await screen.findByLabelText("github enabled");
    await userEvent.click(screen.getByLabelText("github enabled"));
    await waitFor(() =>
      expect(connectorSetConfigMock).toHaveBeenCalledWith("github", { enabled: false }),
    );
  });

  it("disables write controls when connectionState=disconnected (renders cached rows)", async () => {
    useNimbusStore.setState({
      connectionState: "disconnected",
      connectorsList: [
        {
          service: "github",
          intervalMs: 120000,
          depth: "summary",
          enabled: true,
          health: "healthy",
        },
      ],
    });
    stubListStatus([]);
    renderPanel();
    await screen.findByLabelText("github enabled");
    expect(screen.getByLabelText("github enabled")).toBeDisabled();
    expect(screen.getByLabelText("github depth")).toBeDisabled();
    expect(screen.getByLabelText("github interval value")).toBeDisabled();
  });

  it("clears a pending debounce when interval becomes invalid after a valid entry", async () => {
    vi.useFakeTimers();
    try {
      stubListStatus([
        { name: "github", health: "healthy", intervalMs: 120000, depth: "summary", enabled: true },
      ]);
      renderPanel();
      await screen.findByLabelText("github interval value");
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const input = screen.getByLabelText("github interval value");
      const unit = screen.getByLabelText("github interval unit");
      await user.clear(input);
      await user.type(input, "3");
      expect(connectorSetConfigMock).not.toHaveBeenCalled();
      await user.selectOptions(unit, "sec");
      expect(screen.getByText(/minimum 60 seconds/i)).toBeInTheDocument();
      vi.advanceTimersByTime(600);
      expect(connectorSetConfigMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Retry button triggers a refetch when the initial fetch fails", async () => {
    callMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce([
        { name: "github", health: "healthy", intervalMs: 60000, depth: "summary", enabled: true },
      ]);
    renderPanel();
    await screen.findByRole("button", { name: /retry/i });
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("github")).toBeInTheDocument();
  });

  it("rings the row whose service matches ?highlight=<name>", async () => {
    stubListStatus([
      {
        name: "slack",
        health: "rate_limited",
        intervalMs: 300000,
        depth: "metadata_only",
        enabled: true,
      },
    ]);
    renderPanel(["/settings/connectors?highlight=slack"]);
    await screen.findByText("slack");
    const row = screen.getByTestId("connector-row-slack");
    expect(row.className).toMatch(/ring-2/);
  });
});

describe("ConnectorsPanel — connector.configChanged reconcile", () => {
  it("patches the matching row when a configChanged notification arrives", async () => {
    stubListStatus([
      {
        name: "github",
        health: "healthy",
        intervalMs: 120000,
        depth: "summary",
        enabled: true,
      },
    ]);
    let captured: ((n: { method: string; params: unknown }) => void) | null = null;
    subscribeMock.mockImplementation(async (handler) => {
      captured = handler;
      return () => {};
    });
    renderPanel();
    await screen.findByLabelText("github depth");
    expect(captured).not.toBeNull();
    captured?.({
      method: "connector.configChanged",
      params: { service: "github", intervalMs: 600000, depth: "full", enabled: false },
    });
    await waitFor(() => {
      expect(screen.getByLabelText("github depth")).toHaveValue("full");
      expect(screen.getByLabelText("github enabled")).not.toBeChecked();
      expect(screen.getByLabelText("github interval value")).toHaveValue(10);
      expect(screen.getByLabelText("github interval unit")).toHaveValue("min");
    });
  });
});
