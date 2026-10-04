import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function workflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wf-1",
    name: "Deploy",
    description: "Deploys to prod",
    steps_json: "[]",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function stubList(rows: unknown[]): void {
  callMock.mockImplementation(async (method: string) => {
    if (method === "workflow.list") return { workflows: rows };
    throw new Error(`unexpected method: ${method}`);
  });
}

function listCalls(): number {
  return callMock.mock.calls.filter(([m]) => m === "workflow.list").length;
}

async function renderWith(rows: unknown[]): Promise<void> {
  stubList(rows);
  render(
    <MemoryRouter>
      <Workflows />
    </MemoryRouter>,
  );
  if (rows.length > 0) {
    expect(await screen.findAllByRole("button", { name: /Edit workflow/ })).toHaveLength(
      rows.length,
    );
  } else {
    await waitFor(() => expect(listCalls()).toBe(1));
    await act(async () => {});
  }
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Save workflow" });
}

async function save(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
  });
}

beforeEach(() => {
  callMock.mockReset();
  workflowSaveMock.mockReset();
  workflowDeleteMock.mockReset();
  workflowListRunsMock.mockReset();
  workflowRunMock.mockReset();
  useNimbusStore.setState({ connectionState: "connected" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Workflows — edit dialog step parsing", () => {
  it.each([
    ["is not valid JSON", "{not json"],
    ["is an object, not an array", '{"tool":"x"}'],
  ])("starts with a single empty step when steps_json %s", async (_label, stepsJson) => {
    await renderWith([workflow({ steps_json: stepsJson })]);
    fireEvent.click(screen.getByRole("button", { name: "Edit workflow Deploy" }));
    expect(within(dialog()).getByRole("heading", { name: "Edit Workflow" })).toBeInTheDocument();
    expect(screen.getByLabelText("Step 1 tool")).toHaveValue("");
    expect(screen.getByLabelText("Step 1 params")).toHaveValue("{}");
    expect(screen.queryByLabelText("Step 2 tool")).toBeNull();
  });

  it("normalises non-object entries, non-string tools and missing params", async () => {
    const steps = [42, null, { tool: 7 }, { tool: "github.tag", params: { ref: "main" } }];
    await renderWith([workflow({ steps_json: JSON.stringify(steps) })]);
    fireEvent.click(screen.getByRole("button", { name: "Edit workflow Deploy" }));

    const tools = [1, 2, 3, 4].map((n) => screen.getByLabelText(`Step ${n} tool`));
    const params = [1, 2, 3, 4].map((n) => screen.getByLabelText(`Step ${n} params`));
    expect(tools.map((t) => (t as HTMLInputElement).value)).toEqual(["", "", "", "github.tag"]);
    expect(params.slice(0, 3).map((p) => (p as HTMLTextAreaElement).value)).toEqual([
      "{}",
      "{}",
      "{}",
    ]);
    expect(params[3]).toHaveValue(JSON.stringify({ ref: "main" }, null, 2));
    expect(screen.getByLabelText("Workflow name")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Workflow description")).toHaveValue("Deploys to prod");
  });

  it("removes exactly the chosen step and renumbers the ones after it", async () => {
    const steps = [{ tool: "first.tool" }, { tool: "second.tool" }, { tool: "third.tool" }];
    await renderWith([workflow({ steps_json: JSON.stringify(steps) })]);
    fireEvent.click(screen.getByRole("button", { name: "Edit workflow Deploy" }));
    expect(within(dialog()).getByText("Step 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove step 2" }));
    expect(screen.getByLabelText("Step 1 tool")).toHaveValue("first.tool");
    expect(screen.getByLabelText("Step 2 tool")).toHaveValue("third.tool");
    expect(screen.queryByLabelText("Step 3 tool")).toBeNull();
    expect(within(dialog()).getByText("Step 2")).toBeInTheDocument();
    expect(within(dialog()).queryByText("Step 3")).toBeNull();
  });
});

describe("Workflows — save dialog", () => {
  it("saves unparseable params as an empty object and trims the description", async () => {
    workflowSaveMock.mockResolvedValue({ id: "wf-new" });
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    expect(within(dialog()).getByRole("heading", { name: "New Workflow" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "  Nightly  " } });
    fireEvent.change(screen.getByLabelText("Workflow description"), {
      target: { value: "  runs at 2am  " },
    });
    fireEvent.change(screen.getByLabelText("Step 1 tool"), { target: { value: "notify.slack" } });
    fireEvent.change(screen.getByLabelText("Step 1 params"), { target: { value: "{oops" } });
    expect(screen.getByLabelText("Step 1 params")).toHaveValue("{oops");
    await save();

    expect(workflowSaveMock).toHaveBeenCalledWith({
      name: "Nightly",
      description: "runs at 2am",
      stepsJson: JSON.stringify([{ tool: "notify.slack", params: {} }]),
    });
  });

  it("saves valid params as the parsed JSON object", async () => {
    workflowSaveMock.mockResolvedValue({ id: "wf-new" });
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Tag" } });
    fireEvent.change(screen.getByLabelText("Step 1 tool"), { target: { value: "github.tag" } });
    fireEvent.change(screen.getByLabelText("Step 1 params"), {
      target: { value: '{"ref":"main"}' },
    });
    await save();
    expect(workflowSaveMock).toHaveBeenCalledWith({
      name: "Tag",
      stepsJson: JSON.stringify([{ tool: "github.tag", params: { ref: "main" } }]),
    });
  });

  it("keeps Save disabled for an empty or whitespace-only name", async () => {
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    const saveButton = within(dialog()).getByRole("button", { name: "Save" });
    expect(saveButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "   " } });
    expect(saveButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "x" } });
    expect(saveButton).not.toBeDisabled();
  });

  it("handles the save form in place instead of letting the webview submit it", async () => {
    workflowSaveMock.mockResolvedValue({ id: "wf-new" });
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "N" } });
    const form = dialog().querySelector("form");
    if (form === null) throw new Error("the save dialog has no form");
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.submit(form);
    });
    expect(notPrevented).toBe(false);
    expect(workflowSaveMock).toHaveBeenCalledTimes(1);
  });

  it("closes the dialog and refetches the list after a successful save", async () => {
    workflowSaveMock.mockResolvedValue({ id: "wf-new" });
    await renderWith([]);
    const before = listCalls();
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "N" } });
    await save();
    expect(screen.queryByRole("dialog", { name: "Save workflow" })).toBeNull();
    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it("keeps the dialog open with the error message when saving fails", async () => {
    workflowSaveMock.mockRejectedValueOnce(new Error("name already taken"));
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Dup" } });
    await save();

    expect(within(dialog()).getByText("name already taken")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("stringifies a non-Error save rejection and clears it as soon as the next attempt starts", async () => {
    let finish: (v: unknown) => void = () => {};
    workflowSaveMock.mockRejectedValueOnce("E_LOCKED").mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Dup" } });
    await save();
    expect(within(dialog()).getByText("E_LOCKED")).toBeInTheDocument();

    // Assert while the retry is still in flight: a successful save closes the dialog, which would
    // hide the stale error whether or not the attempt cleared it.
    await save();
    expect(within(dialog()).getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(within(dialog()).queryByText("E_LOCKED")).toBeNull();
    expect(workflowSaveMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      finish({ id: "wf-x" });
    });
    expect(screen.queryByRole("dialog", { name: "Save workflow" })).toBeNull();
  });

  it("shows Saving… and disables Save while the request is in flight", async () => {
    let finish: (v: unknown) => void = () => {};
    workflowSaveMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Slow" } });
    await save();
    expect(within(dialog()).getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => {
      finish({ id: "wf-slow" });
    });
    expect(screen.queryByRole("dialog", { name: "Save workflow" })).toBeNull();
  });

  it("Cancel closes the dialog without saving", async () => {
    await renderWith([]);
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Draft" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Save workflow" })).toBeNull();
    expect(workflowSaveMock).not.toHaveBeenCalled();
  });
});

describe("Workflows — list and row actions in flight", () => {
  it("shows Loading… until the workflow list arrives", async () => {
    let resolveList: (v: unknown) => void = () => {};
    callMock.mockImplementation((method: string) =>
      method === "workflow.list"
        ? new Promise((r) => {
            resolveList = r;
          })
        : Promise.reject(new Error(`unexpected method: ${method}`)),
    );
    render(
      <MemoryRouter>
        <Workflows />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    await act(async () => {
      resolveList({ workflows: [workflow()] });
    });
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByRole("button", { name: "Run workflow Deploy" })).toBeInTheDocument();
  });

  it("labels the row action Run, or Dry run while the dry-run toggle is on", async () => {
    await renderWith([workflow()]);
    const run = screen.getByRole("button", { name: "Run workflow Deploy" });
    expect(run.textContent).toBe("Run");
    fireEvent.click(screen.getByLabelText("Dry run"));
    expect(run.textContent).toBe("Dry run");
  });

  it("disables every row action while a run is in flight, then re-enables them", async () => {
    let finish: (v: unknown) => void = () => {};
    workflowRunMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await renderWith([workflow(), workflow({ id: "wf-2", name: "Backup" })]);
    fireEvent.click(screen.getByRole("button", { name: "Run workflow Deploy" }));
    expect(workflowRunMock).toHaveBeenCalledWith({ name: "Deploy", dryRun: false });
    expect(screen.getByRole("button", { name: "Run workflow Backup" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete workflow Deploy" })).toBeDisabled();

    await act(async () => {
      finish({});
    });
    expect(screen.getByRole("button", { name: "Run workflow Backup" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete workflow Deploy" })).not.toBeDisabled();
  });

  it("disables the row actions while a delete is in flight, then refetches the list", async () => {
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    let finish: (v: unknown) => void = () => {};
    workflowDeleteMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await renderWith([workflow()]);
    const before = listCalls();
    fireEvent.click(screen.getByRole("button", { name: "Delete workflow Deploy" }));
    expect(workflowDeleteMock).toHaveBeenCalledWith("Deploy");
    expect(screen.getByRole("button", { name: "Run workflow Deploy" })).toBeDisabled();

    await act(async () => {
      finish({ ok: true });
    });
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    expect(screen.getByRole("button", { name: "Run workflow Deploy" })).not.toBeDisabled();
  });

  it("disables the row actions while offline", async () => {
    await renderWith([workflow()]);
    act(() => {
      useNimbusStore.setState({ connectionState: "disconnected" });
    });
    expect(screen.getByRole("button", { name: "Run workflow Deploy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit workflow Deploy" })).toBeDisabled();
  });

  it("closes the run-with-params dialog on Cancel without running anything", async () => {
    await renderWith([workflow()]);
    fireEvent.click(screen.getByRole("button", { name: "Run with params for Deploy" }));
    const paramsDialog = screen.getByRole("dialog", { name: "Run Deploy with params override" });
    fireEvent.click(within(paramsDialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Run Deploy with params override" })).toBeNull();
    expect(workflowRunMock).not.toHaveBeenCalled();
  });
});

describe("Workflows — row actions", () => {
  it("leaves the workflow alone when the delete confirmation is declined", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    await renderWith([workflow()]);
    fireEvent.click(screen.getByRole("button", { name: "Delete workflow Deploy" }));
    expect(confirmSpy).toHaveBeenCalledWith('Delete workflow "Deploy"?');
    expect(workflowDeleteMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run workflow Deploy" })).not.toBeDisabled();
  });

  it("toggles the history drawer closed from the row button and from the drawer", async () => {
    workflowListRunsMock.mockResolvedValue({ runs: [] });
    await renderWith([workflow()]);
    const toggle = screen.getByRole("button", { name: "Show history for Deploy" });

    fireEvent.click(toggle);
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText("Last 10 runs")).toBeNull();

    fireEvent.click(toggle);
    expect(await screen.findByText("No runs yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Last 10 runs")).toBeNull();
    expect(workflowListRunsMock).toHaveBeenCalledTimes(2);
  });

  it("moves the history drawer when another workflow's history is opened", async () => {
    workflowListRunsMock.mockResolvedValue({ runs: [] });
    await renderWith([workflow(), workflow({ id: "wf-2", name: "Backup", description: null })]);
    fireEvent.click(screen.getByRole("button", { name: "Show history for Deploy" }));
    await screen.findByText("No runs yet.");
    fireEvent.click(screen.getByRole("button", { name: "Show history for Backup" }));
    await waitFor(() => expect(workflowListRunsMock).toHaveBeenLastCalledWith("Backup", 10));
    expect(screen.getAllByText("Last 10 runs")).toHaveLength(1);
  });
});
