import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import {
  callMock,
  workflowDeleteMock,
  workflowListRunsMock,
  workflowRunMock,
  workflowSaveMock,
} from "../../src/ipc/__mocks__/client";
import { Workflows } from "../../src/pages/Workflows";
import { useNimbusStore } from "../../src/store";

const WORKFLOW_1 = {
  id: "wf-1",
  name: "Deploy",
  description: "Deploys to prod",
  steps_json: JSON.stringify([{ tool: "github.tag", params: { ref: "main" } }]),
  created_at: 1_700_000_000_000,
  updated_at: 1_700_001_000_000,
};

const WORKFLOW_2 = {
  id: "wf-2",
  name: "Backup",
  description: null,
  steps_json: "[]",
  created_at: 1_700_000_000_000,
  updated_at: 1_700_001_000_000,
};

function stubWorkflowList(rows: unknown[]) {
  callMock.mockImplementation(async (method: string) => {
    if (method === "workflow.list") return { workflows: rows };
    throw new Error(`unexpected method: ${method}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Workflows />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  workflowRunMock.mockReset();
  workflowSaveMock.mockReset();
  workflowDeleteMock.mockReset();
  workflowListRunsMock.mockReset();
  useNimbusStore.setState({ connectionState: "connected" });
});

describe("Workflows page — list", () => {
  it("renders workflow names and descriptions", async () => {
    stubWorkflowList([WORKFLOW_1, WORKFLOW_2]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Deploy")).toBeInTheDocument();
      expect(screen.getByText("Backup")).toBeInTheDocument();
    });
    expect(screen.getByText("Deploys to prod")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("calls workflowRun with dryRun=false by default", async () => {
    stubWorkflowList([WORKFLOW_1]);
    workflowRunMock.mockResolvedValue({ ok: true, dryRun: false });
    callMock
      .mockResolvedValueOnce({ workflows: [WORKFLOW_1] })
      .mockResolvedValue({ workflows: [WORKFLOW_1] });
    renderPage();
    expect(await screen.findByText("Deploy")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /run workflow Deploy/i }));
    expect(workflowRunMock).toHaveBeenCalledWith({ name: "Deploy", dryRun: false });
  });

  it("calls workflowRun with dryRun=true when toggle is on", async () => {
    stubWorkflowList([WORKFLOW_1]);
    workflowRunMock.mockResolvedValue({ ok: true, dryRun: true });
    callMock
      .mockResolvedValueOnce({ workflows: [WORKFLOW_1] })
      .mockResolvedValue({ workflows: [WORKFLOW_1] });
    renderPage();
    expect(await screen.findByText("Deploy")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Dry run"));
    await userEvent.click(screen.getByRole("button", { name: /run workflow Deploy/i }));
    expect(workflowRunMock).toHaveBeenCalledWith({ name: "Deploy", dryRun: true });
  });

  it("calls workflowDelete after confirm and refetches", async () => {
    stubWorkflowList([WORKFLOW_1]);
    workflowDeleteMock.mockResolvedValue({ ok: true });
    callMock
      .mockResolvedValueOnce({ workflows: [WORKFLOW_1] })
      .mockResolvedValue({ workflows: [] });
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderPage();
    expect(await screen.findByText("Deploy")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /delete workflow Deploy/i }));
    expect(workflowDeleteMock).toHaveBeenCalledWith("Deploy");
  });

  it("shows error state when workflow.list fails", async () => {
    callMock.mockRejectedValue(new Error("connection refused"));
    renderPage();
    expect(await screen.findByText(/connection refused/)).toBeInTheDocument();
  });

  it("'New workflow' button is disabled when offline", () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    callMock.mockResolvedValue({ workflows: [] });
    renderPage();
    expect(screen.getByRole("button", { name: /new workflow/i })).toBeDisabled();
  });
});

async function openNewDialog() {
  stubWorkflowList([]);
  renderPage();
  await waitFor(() => expect(callMock).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: /new workflow/i }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
}

describe("Workflows page — step-list editor", () => {
  it("new dialog starts with one empty step", async () => {
    await openNewDialog();
    expect(screen.getByLabelText("Step 1 tool")).toBeInTheDocument();
    expect(screen.getByLabelText("Step 1 params")).toBeInTheDocument();
  });

  it("'Add step' appends a second step row", async () => {
    await openNewDialog();
    await userEvent.click(screen.getByRole("button", { name: /add step/i }));
    expect(screen.getByLabelText("Step 2 tool")).toBeInTheDocument();
    expect(screen.getByLabelText("Step 2 params")).toBeInTheDocument();
  });

  it("'Remove step' on the only step resets to one empty step", async () => {
    await openNewDialog();
    await userEvent.click(screen.getByRole("button", { name: /remove step 1/i }));
    expect(screen.getByLabelText("Step 1 tool")).toBeInTheDocument();
    expect(screen.queryByLabelText("Step 2 tool")).not.toBeInTheDocument();
  });

  it("'Remove step' on second of two steps leaves one", async () => {
    await openNewDialog();
    await userEvent.click(screen.getByRole("button", { name: /add step/i }));
    await userEvent.click(screen.getByRole("button", { name: /remove step 2/i }));
    expect(screen.queryByLabelText("Step 2 tool")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Step 1 tool")).toBeInTheDocument();
  });

  it("workflowSave called with serialized steps JSON on submit", async () => {
    workflowSaveMock.mockResolvedValue({ id: "wf-new" });
    await openNewDialog();

    await userEvent.type(screen.getByLabelText("Workflow name"), "My Workflow");
    await userEvent.clear(screen.getByLabelText("Step 1 tool"));
    await userEvent.type(screen.getByLabelText("Step 1 tool"), "notify.slack");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(workflowSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My Workflow",
        stepsJson: JSON.stringify([{ tool: "notify.slack", params: {} }]),
      }),
    );
  });

  it("workflowSave omits description key when description is empty", async () => {
    workflowSaveMock.mockResolvedValue({ id: "wf-new" });
    await openNewDialog();
    await userEvent.type(screen.getByLabelText("Workflow name"), "Nameless");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    const call = workflowSaveMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.hasOwn(call, "description")).toBe(false);
  });

  it("edit dialog pre-populates steps from the existing workflow", async () => {
    stubWorkflowList([WORKFLOW_1]);
    renderPage();
    expect(await screen.findByText("Deploy")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /edit workflow Deploy/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const toolInput = screen.getByLabelText("Step 1 tool") as HTMLInputElement;
    expect(toolInput.value).toBe("github.tag");

    const dialog = screen.getByRole("dialog");
    const paramsTextarea = within(dialog).getByLabelText("Step 1 params") as HTMLTextAreaElement;
    const parsedParams = JSON.parse(paramsTextarea.value) as unknown;
    expect(parsedParams).toEqual({ ref: "main" });
  });

  it("two steps are serialized into a two-element array", async () => {
    workflowSaveMock.mockResolvedValue({ id: "wf-new" });
    await openNewDialog();

    await userEvent.type(screen.getByLabelText("Workflow name"), "Two-step");
    await userEvent.type(screen.getByLabelText("Step 1 tool"), "step-a");
    await userEvent.click(screen.getByRole("button", { name: /add step/i }));
    await userEvent.type(screen.getByLabelText("Step 2 tool"), "step-b");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    const call = workflowSaveMock.mock.calls[0][0] as { stepsJson: string };
    const parsed = JSON.parse(call.stepsJson) as unknown[];
    expect(parsed).toHaveLength(2);
    expect((parsed[0] as { tool: string }).tool).toBe("step-a");
    expect((parsed[1] as { tool: string }).tool).toBe("step-b");
  });
});

describe("Workflows page — run-history drawer", () => {
  it("expanding a workflow row fetches and renders the last N runs", async () => {
    stubWorkflowList([
      {
        id: "wf1",
        name: "alpha",
        description: null,
        steps_json: "[]",
        created_at: 0,
        updated_at: 0,
      },
    ]);
    workflowListRunsMock.mockResolvedValue({
      runs: [
        {
          id: "r1",
          startedAt: 1000,
          finishedAt: 1200,
          durationMs: 200,
          status: "done",
          errorMsg: null,
          dryRun: false,
          paramsOverrideJson: null,
          triggeredBy: "user",
        },
        {
          id: "r2",
          startedAt: 500,
          finishedAt: 700,
          durationMs: 200,
          status: "preview",
          errorMsg: null,
          dryRun: true,
          paramsOverrideJson: null,
          triggeredBy: "user",
        },
      ],
    });

    renderPage();
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: /show history for alpha/i }));
    await screen.findAllByText(/200 ms/);
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText(/preview/i)).toBeInTheDocument();
    expect(workflowListRunsMock).toHaveBeenCalledWith("alpha", expect.any(Number));
  });

  it("run history row shows a 'View audit entry' link with the runId", async () => {
    stubWorkflowList([
      {
        id: "wf1",
        name: "alpha",
        description: null,
        steps_json: "[]",
        created_at: 0,
        updated_at: 0,
      },
    ]);
    workflowListRunsMock.mockResolvedValue({
      runs: [
        {
          id: "run-abc",
          startedAt: 1000,
          finishedAt: 1200,
          durationMs: 200,
          status: "done",
          errorMsg: null,
          dryRun: false,
          paramsOverrideJson: null,
          triggeredBy: "user",
        },
      ],
    });
    renderPage();
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: /show history for alpha/i }));
    const link = await screen.findByRole("link", { name: /view audit entry/i });
    expect(link.getAttribute("href")).toContain("run-abc");
  });

  it("run history drawer shows an empty state when no runs exist", async () => {
    stubWorkflowList([
      {
        id: "wf1",
        name: "alpha",
        description: null,
        steps_json: "[]",
        created_at: 0,
        updated_at: 0,
      },
    ]);
    workflowListRunsMock.mockResolvedValue({ runs: [] });
    renderPage();
    await screen.findByText("alpha");
    fireEvent.click(screen.getByRole("button", { name: /show history for alpha/i }));
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });
});

const ALPHA_WORKFLOW = {
  id: "wf1",
  name: "alpha",
  description: null,
  steps_json: "[]",
  created_at: 0,
  updated_at: 0,
};

describe("Workflows page — run with params dialog", () => {
  it("Run with params... opens a dialog and forwards paramsOverride to workflow.run", async () => {
    stubWorkflowList([ALPHA_WORKFLOW]);
    workflowRunMock.mockResolvedValue({});

    renderPage();
    await screen.findByText("alpha");
    fireEvent.click(await screen.findByRole("button", { name: /run with params for alpha/i }));

    const textbox = await screen.findByRole("textbox", { name: /params override json/i });
    fireEvent.change(textbox, {
      target: { value: '{"step-1":{"greeting":"hello"}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm run/i }));

    await waitFor(() =>
      expect(workflowRunMock).toHaveBeenCalledWith({
        name: "alpha",
        dryRun: false,
        paramsOverride: { "step-1": { greeting: "hello" } },
      }),
    );
  });

  it("Run with params... rejects invalid JSON with an inline error", async () => {
    stubWorkflowList([ALPHA_WORKFLOW]);

    renderPage();
    await screen.findByText("alpha");
    fireEvent.click(await screen.findByRole("button", { name: /run with params for alpha/i }));
    const textbox = await screen.findByRole("textbox", { name: /params override json/i });
    fireEvent.change(textbox, { target: { value: "not json" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm run/i }));
    expect(await screen.findByText(/invalid json/i)).toBeInTheDocument();
    expect(workflowRunMock).not.toHaveBeenCalled();
  });

  it("Run with params... rejects a top-level array as invalid (must be an object)", async () => {
    stubWorkflowList([ALPHA_WORKFLOW]);

    renderPage();
    await screen.findByText("alpha");
    fireEvent.click(await screen.findByRole("button", { name: /run with params for alpha/i }));
    const textbox = await screen.findByRole("textbox", { name: /params override json/i });
    fireEvent.change(textbox, { target: { value: "[1,2,3]" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm run/i }));
    expect(await screen.findByText(/invalid json|must be a json object/i)).toBeInTheDocument();
    expect(workflowRunMock).not.toHaveBeenCalled();
  });
});
