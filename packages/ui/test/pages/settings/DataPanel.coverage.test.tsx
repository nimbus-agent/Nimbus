import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataGetExportPreflightMock } from "../../../src/ipc/__mocks__/client";
import type { ExportPreflightResult } from "../../../src/ipc/types";
import { DataPanel } from "../../../src/pages/settings/DataPanel";
import { type NimbusStore, useNimbusStore } from "../../../src/store";

vi.mock("../../../src/ipc/client");

// Captured before any test touches the store, so every test starts from the real slice defaults
// (full idle flow records, no connectors) rather than a hand-built partial state.
const INITIAL_STATE: NimbusStore = useNimbusStore.getState();

const OFFLINE_REASON = "Gateway offline";
const BUSY_REASON = "An export / import / delete is already in progress.";

function preflight(over: Partial<ExportPreflightResult> = {}): ExportPreflightResult {
  return { lastExportAt: null, estimatedSizeBytes: 0, itemCount: 0, ...over };
}

function renderPanel() {
  // ImportWizard calls useNavigate(), so the panel needs a router once that wizard opens.
  return render(
    <MemoryRouter>
      <DataPanel />
    </MemoryRouter>,
  );
}

/** Text of the <dd> paired with a <dt> label on the export card. */
function exportStat(label: "Last export" | "Index size" | "Items"): string | null | undefined {
  const card = screen.getByTestId("data-card-export");
  return within(card).getByText(label).nextElementSibling?.textContent;
}

/** The three write actions; each lookup throws if its button is missing, so callers always get 3. */
function writeButtons(): HTMLElement[] {
  return [
    screen.getByRole("button", { name: "Export backup…" }),
    screen.getByRole("button", { name: "Restore backup…" }),
    screen.getByRole("button", { name: "Delete service…" }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  dataGetExportPreflightMock.mockReset();
  dataGetExportPreflightMock.mockResolvedValue(preflight());
  useNimbusStore.setState(INITIAL_STATE, true);
  useNimbusStore.setState({ connectionState: "connected" });
});

describe("DataPanel — opening and closing the three dialogs", () => {
  it("opens only the restore wizard from the import card and closes it again on Cancel", async () => {
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 3 }));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("3"));

    await user.click(screen.getByRole("button", { name: "Restore backup…" }));
    const wizard = screen.getByTestId("import-wizard");
    expect(within(wizard).getByRole("heading", { name: "Pick a backup file" })).toBeInTheDocument();
    expect(screen.queryByTestId("export-wizard")).toBeNull();
    expect(screen.queryByTestId("delete-dialog")).toBeNull();

    await user.click(within(wizard).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("import-wizard")).toBeNull();
    expect(screen.getByRole("button", { name: "Restore backup…" })).toBeEnabled();
  });

  it("opens only the delete dialog and re-reads the export preflight once it closes", async () => {
    dataGetExportPreflightMock.mockResolvedValue(
      preflight({ itemCount: 3, estimatedSizeBytes: 3 * 1024 * 1024 }),
    );
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("3"));
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Delete service…" }));
    const dialog = screen.getByTestId("delete-dialog");
    // The card carries the same heading text, so scope the lookup to the dialog itself.
    expect(
      within(dialog).getByRole("heading", { name: "Delete service data" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("export-wizard")).toBeNull();
    expect(screen.queryByTestId("import-wizard")).toBeNull();
    // Opening the dialog alone does not refetch.
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(1);

    // A delete shrinks the index; closing the dialog must bring the card's figures up to date.
    dataGetExportPreflightMock.mockResolvedValue(
      preflight({ itemCount: 1, estimatedSizeBytes: 2048 }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("delete-dialog")).toBeNull();
    await waitFor(() => expect(exportStat("Items")).toBe("1"));
    expect(exportStat("Index size")).toBe("2.0 KB");
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(2);
  });

  it("opens only the export wizard and re-reads the export preflight once it closes", async () => {
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 3 }));
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("3"));
    expect(exportStat("Last export")).toBe("Never");

    await user.click(screen.getByRole("button", { name: "Export backup…" }));
    const wizard = screen.getByTestId("export-wizard");
    expect(within(wizard).getByRole("heading", { name: "Backup scope" })).toBeInTheDocument();
    expect(screen.queryByTestId("import-wizard")).toBeNull();
    expect(screen.queryByTestId("delete-dialog")).toBeNull();
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(1);

    const exportedAt = Date.UTC(2026, 8, 30, 12, 0, 0);
    dataGetExportPreflightMock.mockResolvedValue(
      preflight({ lastExportAt: exportedAt, itemCount: 3 }),
    );
    await user.click(within(wizard).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("export-wizard")).toBeNull();
    await waitFor(() =>
      expect(exportStat("Last export")).toBe(new Date(exportedAt).toLocaleString()),
    );
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(2);
  });
});

describe("DataPanel — loading the export preflight", () => {
  it("retries a failed preflight from the error banner and clears the error once it loads", async () => {
    dataGetExportPreflightMock
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValue(preflight({ itemCount: 4 }));
    const user = userEvent.setup();
    renderPanel();
    expect(
      await screen.findByText("Failed to load preflight: gateway timeout"),
    ).toBeInTheDocument();
    expect(exportStat("Items")).toBe("0");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(exportStat("Items")).toBe("4"));
    expect(screen.queryByText(/Failed to load preflight/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(2);
  });

  it("skips the fetch while the gateway is offline and fetches as soon as it reconnects", async () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 6 }));
    renderPanel();
    expect(dataGetExportPreflightMock).not.toHaveBeenCalled();
    expect(exportStat("Items")).toBe("0");

    act(() => {
      useNimbusStore.setState({ connectionState: "connected" });
    });

    await waitFor(() => expect(exportStat("Items")).toBe("6"));
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(1);
  });
});

describe("DataPanel — why the write actions are disabled", () => {
  it("enables every action with no reason while connected and idle", async () => {
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 9 }));
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("9"));
    for (const button of writeButtons()) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("title");
    }
  });

  it("blames the running flow while connected, including a running delete", async () => {
    useNimbusStore.setState({
      deleteFlow: { ...INITIAL_STATE.deleteFlow, status: "running", service: "slack" },
    });
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 2 }));
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("2"));
    for (const button of writeButtons()) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", BUSY_REASON);
    }
  });

  it("blames the offline gateway ahead of a running flow when both apply", () => {
    // Stub the action so the flow stays "running" and both reasons genuinely apply at once.
    const markDisconnected = vi.fn();
    useNimbusStore.setState({
      connectionState: "disconnected",
      exportFlow: { ...INITIAL_STATE.exportFlow, status: "running" },
      markDisconnected,
    });
    renderPanel();
    // Premise check: the panel saw a running flow while offline. Without it, a panel that stopped
    // counting the export as running would still show the offline reason and pass this test.
    expect(markDisconnected).toHaveBeenCalledTimes(1);
    for (const button of writeButtons()) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", OFFLINE_REASON);
    }
  });

  it("fails a running delete as gateway_disconnected when the gateway drops mid-flow", async () => {
    useNimbusStore.setState({
      deleteFlow: { ...INITIAL_STATE.deleteFlow, status: "running", service: "slack" },
    });
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 2 }));
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("2"));

    act(() => {
      useNimbusStore.setState({ connectionState: "disconnected" });
    });

    expect(useNimbusStore.getState().deleteFlow).toMatchObject({
      status: "error",
      errorKind: "gateway_disconnected",
      service: "slack",
    });
    for (const button of writeButtons()) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", OFFLINE_REASON);
    }
  });

  it("does not mark anything disconnected when the gateway drops while nothing is running", async () => {
    const markDisconnected = vi.fn();
    useNimbusStore.setState({ markDisconnected });
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 2 }));
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("2"));

    act(() => {
      useNimbusStore.setState({ connectionState: "disconnected" });
    });

    expect(writeButtons()[0]).toHaveAttribute("title", OFFLINE_REASON);
    expect(markDisconnected).not.toHaveBeenCalled();
    // Going offline does not trigger another fetch either.
    expect(dataGetExportPreflightMock).toHaveBeenCalledTimes(1);
  });
});

describe("DataPanel — export card figures and stale chips", () => {
  it("shows the cached preflight with a stale chip on the export card while offline", () => {
    const exportedAt = Date.UTC(2026, 0, 15, 9, 30, 0);
    useNimbusStore.setState({
      connectionState: "disconnected",
      lastExportPreflight: preflight({
        lastExportAt: exportedAt,
        estimatedSizeBytes: 512,
        itemCount: 5,
      }),
    });
    renderPanel();
    const card = screen.getByTestId("data-card-export");
    expect(within(card).getByRole("status")).toHaveTextContent("Stale · gateway offline");
    // One chip on the panel header, one on the export card.
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(exportStat("Last export")).toBe(new Date(exportedAt).toLocaleString());
    expect(exportStat("Index size")).toBe("512 B");
    expect(exportStat("Items")).toBe("5");
  });

  it("keeps the export card chip-free while offline when no preflight was ever cached", () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    renderPanel();
    const card = screen.getByTestId("data-card-export");
    expect(within(card).queryByRole("status")).toBeNull();
    // The panel header still flags the whole panel as stale.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(exportStat("Last export")).toBe("Never");
    expect(exportStat("Index size")).toBe("0 B");
    expect(exportStat("Items")).toBe("0");
  });

  it("shows no stale chip anywhere while connected", async () => {
    dataGetExportPreflightMock.mockResolvedValue(preflight({ itemCount: 8 }));
    renderPanel();
    await waitFor(() => expect(exportStat("Items")).toBe("8"));
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  // Every threshold is pinned from both sides. The largest whole unit below a threshold also pins
  // the binary divisor: a 1000-based formatter renders 1023 KiB as "1047.6 KB" (or "1.0 MB" once
  // its threshold moves too), yet still renders 1 KiB as "1.0 KB" and 1 MiB as "1.0 MB".
  it.each([
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1023 * 1024, "1023.0 KB"],
    [1024 * 1024, "1.0 MB"],
    [1023 * 1024 * 1024, "1023.0 MB"],
    [1024 * 1024 * 1024, "1.00 GB"],
    [1.5 * 1024 * 1024 * 1024, "1.50 GB"],
  ])("formats an index of %d bytes as %s", (bytes, expected) => {
    useNimbusStore.setState({
      connectionState: "disconnected",
      lastExportPreflight: preflight({ estimatedSizeBytes: bytes }),
    });
    renderPanel();
    expect(exportStat("Index size")).toBe(expected);
  });
});
