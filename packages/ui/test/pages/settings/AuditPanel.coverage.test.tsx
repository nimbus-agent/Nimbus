import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, Array<(payload: unknown) => void>>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const cb = (payload: unknown) => handler({ payload });
    listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    return () => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((f) => f !== cb),
      );
    };
  }),
}));
vi.mock("../../../src/ipc/client");
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));

import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  auditExportMock,
  auditGetSummaryMock,
  auditVerifyMock,
  callMock,
} from "../../../src/ipc/__mocks__/client";
import { AuditPanel } from "../../../src/pages/settings/AuditPanel";
import { useNimbusStore } from "../../../src/store";

const saveMock = vi.mocked(save);
const writeTextFileMock = vi.mocked(writeTextFile);

const T_NEW = 1745126400000;
const T_MID = 1745122800000;
const T_OLD = 1745119200000;

const SAMPLE_ROWS = [
  { id: 3, actionType: "github.sync", hitlStatus: "approved", actionJson: "{}", timestamp: T_NEW },
  { id: 2, actionType: "data.delete", hitlStatus: "rejected", actionJson: "{}", timestamp: T_MID },
  { id: 1, actionType: "startup", hitlStatus: "not_required", actionJson: "{}", timestamp: T_OLD },
] as const;

const DEFAULT_FILTER = { service: "", outcome: "all", sinceMs: null, untilMs: null } as const;

function auditListCalls(): number {
  return callMock.mock.calls.filter(([method]) => method === "audit.list").length;
}

function fireNotification(method: string): void {
  for (const h of listeners.get("gateway://notification") ?? []) {
    act(() => h({ method, params: {} }));
  }
}

function renderAt(url = "/settings/audit") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuditPanel />
    </MemoryRouter>,
  );
}

async function renderWithRows(count: number, url?: string): Promise<void> {
  renderAt(url);
  await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(count));
}

beforeEach(() => {
  listeners.clear();
  callMock.mockReset();
  auditGetSummaryMock.mockReset();
  auditVerifyMock.mockReset();
  auditExportMock.mockReset();
  saveMock.mockReset();
  writeTextFileMock.mockReset();
  useNimbusStore.setState({
    connectionState: "connected",
    auditFilter: DEFAULT_FILTER,
    auditSummary: null,
    auditActionInFlight: false,
  });
  callMock.mockImplementation(async (method: string) => {
    if (method === "audit.list") return SAMPLE_ROWS;
    return [];
  });
  auditGetSummaryMock.mockResolvedValue({
    byOutcome: { approved: 1, rejected: 1, not_required: 1 },
    byService: { github: 1, data: 1, startup: 1 },
    total: 3,
  });
});

afterEach(() => {
  // Unmount before resetting the store: this hook runs before RTL's own auto-cleanup, and a
  // store write to a still-mounted panel re-renders it outside act().
  cleanup();
  useNimbusStore.setState({
    auditFilter: DEFAULT_FILTER,
    auditSummary: null,
    auditActionInFlight: false,
  });
});

describe("AuditPanel — live refresh", () => {
  it("refetches on audit.entryAppended and data.delete.completed only", async () => {
    await renderWithRows(3);
    await waitFor(() => expect(listeners.get("gateway://notification")).toHaveLength(1));
    const before = auditListCalls();

    fireNotification("connector.healthChanged");
    expect(auditListCalls()).toBe(before);

    fireNotification("audit.entryAppended");
    await waitFor(() => expect(auditListCalls()).toBe(before + 1));

    fireNotification("data.delete.completed");
    await waitFor(() => expect(auditListCalls()).toBe(before + 2));
  });

  it("asks the gateway for the newest 1,000 rows", async () => {
    await renderWithRows(3);
    expect(callMock).toHaveBeenCalledWith("audit.list", { limit: 1000 });
  });

  it("re-reads the summary when a refetch changes the row count", async () => {
    let rows: ReadonlyArray<unknown> = SAMPLE_ROWS;
    callMock.mockImplementation(async (method: string) => (method === "audit.list" ? rows : []));
    auditGetSummaryMock.mockImplementation(async () => ({
      byOutcome: {},
      byService: {},
      total: rows.length,
    }));
    await renderWithRows(3);
    expect(
      await screen.findByText("Total rows: 3 · approved: 0 · rejected: 0 · auto: 0"),
    ).toBeInTheDocument();
    await waitFor(() => expect(listeners.get("gateway://notification")).toHaveLength(1));

    rows = [
      {
        id: 4,
        actionType: "github.sync",
        hitlStatus: "approved",
        actionJson: "{}",
        timestamp: T_NEW,
      },
      ...SAMPLE_ROWS,
    ];
    fireNotification("audit.entryAppended");
    expect(
      await screen.findByText("Total rows: 4 · approved: 0 · rejected: 0 · auto: 0"),
    ).toBeInTheDocument();
  });
});

describe("AuditPanel — filters", () => {
  it("filters by outcome", async () => {
    await renderWithRows(3);
    fireEvent.change(screen.getByLabelText("Outcome filter"), { target: { value: "rejected" } });
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(1));
    expect(screen.getByText("1 of 3 rows")).toBeInTheDocument();
    expect(screen.getAllByTestId("audit-row")[0]?.textContent).toContain("delete");
  });

  it("drops rows older than sinceMs", async () => {
    useNimbusStore.setState({ auditFilter: { ...DEFAULT_FILTER, sinceMs: T_MID } });
    await renderWithRows(2);
    expect(screen.getByText("2 of 3 rows")).toBeInTheDocument();
    const text = screen
      .getAllByTestId("audit-row")
      .map((r) => r.textContent)
      .join("|");
    expect(text).not.toContain("startup");
  });

  it("treats untilMs as an inclusive calendar day and drops rows after it", async () => {
    // A row survives while ms <= untilMs + 86_399_000 (end of the selected day).
    useNimbusStore.setState({ auditFilter: { ...DEFAULT_FILTER, untilMs: T_OLD - 86_399_000 } });
    await renderWithRows(1);
    expect(screen.getByText("1 of 3 rows")).toBeInTheDocument();
    expect(screen.getAllByTestId("audit-row")[0]?.textContent).toContain("startup");
  });

  it("restores every row when the filters are reset", async () => {
    useNimbusStore.setState({ auditFilter: { ...DEFAULT_FILTER, outcome: "rejected" } });
    await renderWithRows(1);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(3));
    expect(useNimbusStore.getState().auditFilter).toEqual(DEFAULT_FILTER);
  });

  it("offers the services found in the log in alphabetical order", async () => {
    await renderWithRows(3);
    const options = Array.from(
      screen.getByLabelText("Service filter").querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(options).toEqual(["all", "data", "github", "startup"]);
  });
});

describe("AuditPanel — row rendering", () => {
  it("colours each outcome distinctly", async () => {
    await renderWithRows(3);
    expect(screen.getByText("approved", { selector: "span" }).className).toContain(
      "text-green-600",
    );
    expect(screen.getByText("rejected", { selector: "span" }).className).toContain("text-red-500");
    const auto = screen.getByText("not_required", { selector: "span" }).className;
    expect(auto).not.toContain("text-green-600");
    expect(auto).not.toContain("text-red-500");
  });

  it("falls back to zero for outcomes the summary does not carry", async () => {
    auditGetSummaryMock.mockResolvedValue({ byOutcome: {}, byService: {}, total: 0 });
    renderAt();
    expect(
      await screen.findByText("Total rows: 0 · approved: 0 · rejected: 0 · auto: 0"),
    ).toBeInTheDocument();
  });

  it("keeps rendering rows when the summary fetch fails", async () => {
    auditGetSummaryMock.mockRejectedValue(new Error("summary down"));
    await renderWithRows(3);
    expect(screen.queryByText(/Total rows:/)).toBeNull();
    expect(screen.queryByText(/summary down/)).toBeNull();
  });

  it("marks no row as the current run when no run was linked", async () => {
    await renderWithRows(3);
    for (const row of screen.getAllByTestId("audit-row")) {
      expect(row).not.toHaveAttribute("aria-current");
    }
  });

  it("shows no run banner for an empty log when no run was linked", async () => {
    callMock.mockImplementation(async () => []);
    renderAt();
    await waitFor(() => expect(auditListCalls()).toBe(1));
    await act(async () => {});
    expect(screen.getByText("0 of 0 rows")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-runid-banner")).toBeNull();
  });
});

describe("AuditPanel — runId deep-link extraction", () => {
  const RUN_ROWS = [
    {
      id: 20,
      actionType: "workflow.run.completed",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ runId: "run-ok" }),
      timestamp: T_NEW,
    },
    {
      id: 21,
      actionType: "workflow.run.completed",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ runId: 42 }),
      timestamp: T_NEW,
    },
    {
      id: 22,
      actionType: "workflow.run.completed",
      hitlStatus: "not_required",
      actionJson: JSON.stringify(["run-arr"]),
      timestamp: T_NEW,
    },
    {
      id: 23,
      actionType: "workflow.run.completed",
      hitlStatus: "not_required",
      actionJson: '{"runId":"run-bad"',
      timestamp: T_NEW,
    },
    {
      id: 24,
      actionType: "github.sync",
      hitlStatus: "approved",
      actionJson: JSON.stringify({ runId: "run-gh" }),
      timestamp: T_NEW,
    },
  ];

  beforeEach(() => {
    callMock.mockImplementation(async (method: string) =>
      method === "audit.list" ? RUN_ROWS : [],
    );
  });

  it("matches a string runId on a workflow completion row", async () => {
    await renderWithRows(1, "/settings/audit?runId=run-ok");
    expect(screen.getByText("1 of 5 rows")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-runid-banner")).toBeNull();
    expect(screen.getByTestId("audit-row")).toHaveAttribute("aria-current", "true");
  });

  it.each([
    ["a numeric runId is not coerced to a string", "42"],
    ["a JSON array payload carries no runId", "run-arr"],
    ["malformed JSON carries no runId", "run-bad"],
    ["only workflow.run.completed rows carry a runId", "run-gh"],
  ])("%s", async (_label, runId) => {
    renderAt(`/settings/audit?runId=${runId}`);
    const banner = await screen.findByTestId("audit-runid-banner");
    expect(within(banner).getByText(runId)).toBeInTheDocument();
    expect(screen.getByText("0 of 5 rows")).toBeInTheDocument();
    expect(screen.queryAllByTestId("audit-row")).toHaveLength(0);
  });
});

describe("AuditPanel — verify", () => {
  it("shows an info toast and disables both actions while verifying", async () => {
    let resolveVerify: (v: unknown) => void = () => {};
    auditVerifyMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveVerify = r;
      }),
    );
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    // The panel always re-verifies the whole chain, never just the tail.
    expect(auditVerifyMock).toHaveBeenCalledWith(true);

    const toastText = await screen.findByText("Verifying audit chain…");
    expect(toastText.closest('[role="status"]')?.className).toContain("bg-blue-700");
    expect(screen.getByRole("button", { name: "Verify chain" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();

    await act(async () => {
      resolveVerify({ ok: true, lastVerifiedId: 3, totalChecked: 3 });
    });
    const done = await screen.findByText("Chain verified — 3 rows through id 3.");
    expect(done.closest('[role="status"]')?.className).toContain("bg-green-700");
    expect(screen.getByRole("button", { name: "Verify chain" })).not.toBeDisabled();
  });

  it("reports a broken chain in red with both hashes cut to 12 characters", async () => {
    auditVerifyMock.mockResolvedValueOnce({
      ok: false,
      brokenAtId: 7,
      expectedHash: `${"a".repeat(12)}EXPECTED-TAIL`,
      actualHash: `${"b".repeat(12)}ACTUAL-TAIL`,
    });
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    const toast = await screen.findByText(/Chain BROKEN at id 7/);
    expect(toast.textContent).toBe(
      `Chain BROKEN at id 7: expected ${"a".repeat(12)}…, got ${"b".repeat(12)}…`,
    );
    expect(toast.closest('[role="status"]')?.className).toContain("bg-red-700");
  });

  it("reports an Error rejection as a red verify-failed toast", async () => {
    auditVerifyMock.mockRejectedValueOnce(new Error("socket closed"));
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    const toast = await screen.findByText("Verify failed: socket closed");
    expect(toast.closest('[role="status"]')?.className).toContain("bg-red-700");
    expect(useNimbusStore.getState().auditActionInFlight).toBe(false);
  });

  it("stringifies a non-Error rejection", async () => {
    auditVerifyMock.mockRejectedValueOnce("ERR_PLAIN");
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    expect(await screen.findByText("Verify failed: ERR_PLAIN")).toBeInTheDocument();
  });

  it("dismisses the toast", async () => {
    auditVerifyMock.mockResolvedValueOnce({ ok: true, lastVerifiedId: 3, totalChecked: 3 });
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    await screen.findByText("Chain verified — 3 rows through id 3.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("audit-toast-text")).toBeNull();
  });
});

describe("AuditPanel — export", () => {
  const EXPORT_ROWS = [
    {
      id: 2,
      actionType: "data.delete",
      hitlStatus: "rejected",
      actionJson: "{}",
      timestamp: T_MID,
      rowHash: "h2",
      prevHash: "h1",
    },
    {
      id: 1,
      actionType: "startup",
      hitlStatus: "not_required",
      actionJson: "{}",
      timestamp: T_OLD,
      rowHash: "h1",
      prevHash: "0",
    },
  ];

  it("opens the save dialog titled for the audit log with JSON and CSV choices", async () => {
    saveMock.mockResolvedValueOnce(null);
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      title: "Export audit log",
      defaultPath: expect.stringMatching(/^audit-\d+\.json$/),
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "CSV", extensions: ["csv"] },
      ],
    });
  });

  it("disables both actions while the save dialog is open", async () => {
    let pick: (path: string | null) => void = () => {};
    saveMock.mockReturnValueOnce(
      new Promise<string | null>((r) => {
        pick = r;
      }),
    );
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Verify chain" })).toBeDisabled();

    await act(async () => {
      pick(null);
    });
    expect(screen.getByRole("button", { name: "Export…" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Verify chain" })).not.toBeDisabled();
  });

  it("confirms a finished export in green with the row count and the path", async () => {
    saveMock.mockResolvedValueOnce("/mock-export/audit.json");
    auditExportMock.mockResolvedValueOnce(EXPORT_ROWS);
    writeTextFileMock.mockResolvedValueOnce(undefined);
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    const toast = await screen.findByText("Exported 2 rows to /mock-export/audit.json");
    expect(toast.closest('[role="status"]')?.className).toContain("bg-green-700");
  });

  it("clears the previous export error as soon as the next export starts", async () => {
    saveMock
      .mockResolvedValueOnce("/mock-export/audit.json")
      .mockReturnValueOnce(new Promise<string | null>(() => {}));
    auditExportMock.mockRejectedValueOnce(new Error("export refused"));
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(await screen.findByText("Export failed: export refused")).toBeInTheDocument();

    // The second save dialog is still open, so this attempt has neither failed nor finished.
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Export failed:/)).toBeNull();
  });
});

describe("AuditPanel — export failures", () => {
  it("shows the export error and clears it on Retry", async () => {
    saveMock.mockResolvedValueOnce("/mock-export/audit.json");
    auditExportMock.mockRejectedValueOnce(new Error("export refused"));
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));

    expect(await screen.findByText("Export failed: export refused")).toBeInTheDocument();
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(useNimbusStore.getState().auditActionInFlight).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByText(/Export failed:/)).toBeNull();
  });

  it("stringifies a non-Error write failure", async () => {
    saveMock.mockResolvedValueOnce("/mock-export/audit.csv");
    auditExportMock.mockResolvedValueOnce([]);
    writeTextFileMock.mockRejectedValueOnce("EACCES");
    await renderWithRows(3);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(await screen.findByText("Export failed: EACCES")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-toast-text")).toBeNull();
  });
});

describe("AuditPanel — list load failure", () => {
  it("shows the load error and recovers on Retry", async () => {
    let failing = true;
    callMock.mockImplementation(async (method: string) => {
      if (method !== "audit.list") return [];
      if (failing) throw new Error("index locked");
      return SAMPLE_ROWS;
    });
    renderAt();
    expect(await screen.findByText("Failed to load audit log: index locked")).toBeInTheDocument();
    expect(screen.queryAllByTestId("audit-row")).toHaveLength(0);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getAllByTestId("audit-row")).toHaveLength(3));
    expect(screen.queryByText(/Failed to load audit log/)).toBeNull();
  });
});
