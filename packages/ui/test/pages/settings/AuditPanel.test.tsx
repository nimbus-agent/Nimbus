import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

vi.mock("../../../src/ipc/client");
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(),
}));

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

const SAMPLE_ROWS = [
  {
    id: 3,
    actionType: "github.sync",
    hitlStatus: "approved" as const,
    actionJson: "{}",
    timestamp: 1745126400000,
  },
  {
    id: 2,
    actionType: "data.delete",
    hitlStatus: "rejected" as const,
    actionJson: "{}",
    timestamp: 1745122800000,
  },
  {
    id: 1,
    actionType: "startup",
    hitlStatus: "not_required" as const,
    actionJson: "{}",
    timestamp: 1745119200000,
  },
];

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuditPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  auditGetSummaryMock.mockReset();
  auditVerifyMock.mockReset();
  auditExportMock.mockReset();
  saveMock.mockReset();
  writeTextFileMock.mockReset();
  useNimbusStore.setState({
    connectionState: "connected",
    auditFilter: { service: "", outcome: "all", sinceMs: null, untilMs: null },
    auditSummary: null,
    auditActionInFlight: false,
  } as never);
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
  useNimbusStore.setState({
    auditFilter: { service: "", outcome: "all", sinceMs: null, untilMs: null },
    auditSummary: null,
    auditActionInFlight: false,
  } as never);
});

async function renderAndWaitForRows(): Promise<void> {
  renderAt("/settings/audit");
  await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBe(3));
}

describe("AuditPanel", () => {
  it("renders summary and one row per fetched entry", async () => {
    renderAt("/settings/audit");
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/Total rows: 3/)).toBeTruthy());
    expect(screen.getByText("3 of 3 rows")).toBeTruthy();
  });

  it("filters by service via the chip", async () => {
    await renderAndWaitForRows();
    const select = screen.getByLabelText("Service filter") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "github" } });
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBe(1));
    expect(screen.getByText("1 of 3 rows")).toBeTruthy();
  });

  it("Verify chain success surfaces a green toast", async () => {
    auditVerifyMock.mockResolvedValueOnce({ ok: true, lastVerifiedId: 3, totalChecked: 3 });
    await renderAndWaitForRows();
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    await waitFor(() =>
      expect(screen.getByTestId("audit-toast-text").textContent).toMatch(/Chain verified/),
    );
  });

  it("Verify chain broken surfaces a red toast with the broken id", async () => {
    auditVerifyMock.mockResolvedValueOnce({
      ok: false,
      brokenAtId: 7,
      expectedHash: "expected_hash_value",
      actualHash: "actual_hash_value",
    });
    await renderAndWaitForRows();
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    await waitFor(() =>
      expect(screen.getByTestId("audit-toast-text").textContent).toMatch(/BROKEN at id 7/),
    );
  });

  it("Export with .json path writes flattened display rows as JSON", async () => {
    saveMock.mockResolvedValueOnce("/mock-export/audit-test.json");
    auditExportMock.mockResolvedValueOnce([
      {
        id: 3,
        actionType: "github.sync",
        hitlStatus: "approved",
        actionJson: '{"actor":"alice"}',
        timestamp: 1,
        rowHash: "abc",
        prevHash: "0",
      },
    ]);
    writeTextFileMock.mockResolvedValueOnce(undefined);
    await renderAndWaitForRows();
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(writeTextFileMock).toHaveBeenCalled());
    const [path, contents] = writeTextFileMock.mock.calls[0]!;
    expect(path).toBe("/mock-export/audit-test.json");
    const parsed = JSON.parse(contents as string) as Array<{ service: string; actor: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.service).toBe("github");
    expect(parsed[0]?.actor).toBe("alice");
  });

  it("Export with .csv path writes the 6-column CSV", async () => {
    saveMock.mockResolvedValueOnce("/mock-export/audit-test.csv");
    auditExportMock.mockResolvedValueOnce([
      {
        id: 3,
        actionType: "github.sync",
        hitlStatus: "approved",
        actionJson: '{"actor":"alice"}',
        timestamp: 1,
        rowHash: "abc",
        prevHash: "0",
      },
    ]);
    writeTextFileMock.mockResolvedValueOnce(undefined);
    await renderAndWaitForRows();
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(writeTextFileMock).toHaveBeenCalled());
    const [, contents] = writeTextFileMock.mock.calls[0]!;
    const [header, line] = (contents as string).split("\n");
    expect(header).toBe("timestamp,service,actor,action,outcome,rowHash");
    expect(line).toContain("github");
    expect(line).toContain("alice");
    expect(line).toContain("abc");
  });

  it("Export cancelled (save returns null) writes nothing", async () => {
    saveMock.mockResolvedValueOnce(null);
    await renderAndWaitForRows();
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(auditExportMock).not.toHaveBeenCalled();
  });

  it("disconnected state disables write buttons", async () => {
    useNimbusStore.setState({ connectionState: "disconnected" } as never);
    renderAt("/settings/audit");
    expect(
      (screen.getByRole("button", { name: "Verify chain" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Export…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

// ── runId deep-link tests ──────────────────────────────────────────────────────

const WORKFLOW_ROWS = [
  {
    id: 10,
    actionType: "workflow.run.completed",
    hitlStatus: "not_required" as const,
    actionJson: JSON.stringify({
      runId: "run-abc",
      workflowName: "alpha",
      status: "done",
      durationMs: 100,
      dryRun: false,
    }),
    timestamp: 1745126400000,
  },
  {
    id: 11,
    actionType: "workflow.run.completed",
    hitlStatus: "not_required" as const,
    actionJson: JSON.stringify({
      runId: "run-xyz",
      workflowName: "beta",
      status: "done",
      durationMs: 200,
      dryRun: false,
    }),
    timestamp: 1745126500000,
  },
];

describe("AuditPanel runId deep-link", () => {
  beforeEach(() => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "audit.list") return WORKFLOW_ROWS;
      return [];
    });
    auditGetSummaryMock.mockResolvedValue({
      byOutcome: { not_required: 2 },
      byService: { workflow: 2 },
      total: 2,
    });
  });

  test("filters rows by runId extracted from actionJson when ?runId=<id> is present", async () => {
    renderAt("/settings/audit?runId=run-abc");
    // Only the run-abc row should be visible; run-xyz row should be filtered out.
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBe(1));
    // The "1 of 2" counter confirms the runId filter is on top of the full list.
    expect(screen.getByText("1 of 2 rows")).toBeTruthy();
  });

  test("highlights the matched row with aria-current", async () => {
    renderAt("/settings/audit?runId=run-abc");
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBe(1));
    const rows = screen.getAllByTestId("audit-row");
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
  });

  test("shows the full list when no runId is provided", async () => {
    renderAt("/settings/audit");
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBe(2));
    expect(screen.getByText("2 of 2 rows")).toBeTruthy();
  });

  test("shows a pruning-semantics banner when runId matches no entries", async () => {
    renderAt("/settings/audit?runId=run-missing");
    // The banner text spans a <p> with an inner <code>; query the container by testid.
    await waitFor(() => expect(screen.getByTestId("audit-runid-banner")).toBeInTheDocument());
    expect(screen.getByTestId("audit-runid-banner").textContent).toMatch(
      /no audit entries found for run run-missing/i,
    );
  });

  test("does not show the pruning banner when runId is absent", async () => {
    renderAt("/settings/audit");
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBe(2));
    expect(screen.queryByText(/no audit entries found/i)).toBeNull();
  });

  test("does not highlight rows when no runId is in the URL", async () => {
    renderAt("/settings/audit");
    await waitFor(() => expect(screen.getAllByTestId("audit-row").length).toBe(2));
    const rows = screen.getAllByTestId("audit-row");
    for (const row of rows) {
      expect(row.getAttribute("aria-current")).toBeNull();
    }
  });
});
