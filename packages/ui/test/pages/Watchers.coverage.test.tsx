import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import {
  callMock,
  watcherCreateMock,
  watcherDeleteMock,
  watcherListCandidateRelationsMock,
  watcherListHistoryMock,
  watcherPauseMock,
  watcherResumeMock,
  watcherValidateConditionMock,
} from "../../src/ipc/__mocks__/client";
import { Watchers } from "../../src/pages/Watchers";
import { useNimbusStore } from "../../src/store";

const CANDIDATES = [
  { relation: "owned_by", description: "Owned by the target", underlyingRelationTypes: [] },
  { relation: "upstream_of", description: "Feeds into the target", underlyingRelationTypes: [] },
];

const WATCHER = {
  id: "w1",
  name: "PR opened",
  enabled: 1,
  condition_type: "incident_opened",
  condition_json: "{}",
  action_type: "notify",
  action_json: "{}",
  created_at: 0,
  last_checked_at: null,
  last_fired_at: null,
  graph_predicate_json: null,
};

function stubList(rows: unknown[]): void {
  callMock.mockImplementation(async (method: string) => {
    if (method === "watcher.list") return { watchers: rows };
    throw new Error(`unexpected method: ${method}`);
  });
}

function listCalls(): number {
  return callMock.mock.calls.filter(([m]) => m === "watcher.list").length;
}

async function renderPage(rows: unknown[] = []): Promise<void> {
  stubList(rows);
  render(
    <MemoryRouter>
      <Watchers />
    </MemoryRouter>,
  );
  await waitFor(() => expect(listCalls()).toBe(1));
  await act(async () => {});
}

async function openDialog(): Promise<HTMLElement> {
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New watcher" }));
  });
  return screen.getByRole("dialog", { name: "Create watcher" });
}

function enableGraph(): void {
  fireEvent.click(screen.getByLabelText("Narrow with a graph predicate"));
}

function fillTargets(type: string, id: string): void {
  fireEvent.change(screen.getByLabelText("Target entity type"), { target: { value: type } });
  fireEvent.change(screen.getByLabelText("Target entity ID"), { target: { value: id } });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  });
}

beforeEach(() => {
  callMock.mockReset();
  watcherCreateMock.mockReset();
  watcherDeleteMock.mockReset();
  watcherListCandidateRelationsMock.mockReset();
  watcherListCandidateRelationsMock.mockResolvedValue({ relations: CANDIDATES });
  watcherValidateConditionMock.mockReset();
  watcherListHistoryMock.mockReset();
  watcherPauseMock.mockReset();
  watcherResumeMock.mockReset();
  useNimbusStore.setState({ connectionState: "connected" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Watchers — relation candidates", () => {
  it("falls back to the built-in relations when the gateway cannot list them", async () => {
    watcherListCandidateRelationsMock.mockRejectedValueOnce(new Error("graph offline"));
    await openDialog();
    enableGraph();
    const select = screen.getByLabelText("Graph relation");
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "owned_by",
      "upstream_of",
      "downstream_of",
    ]);
    expect(screen.getByText("Authored, opened, or posted by target")).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "upstream_of" } });
    expect(screen.getByText("Direct outgoing edge to target")).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "downstream_of" } });
    expect(screen.getByText("Target has outgoing edge to item")).toBeInTheDocument();
  });

  it("defaults to the gateway's first relation when that is not owned_by", async () => {
    watcherListCandidateRelationsMock.mockResolvedValueOnce({ relations: CANDIDATES.slice(1) });
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Up" } });
    enableGraph();
    expect(screen.getByLabelText("Graph relation")).toHaveValue("upstream_of");

    fillTargets("repo", "nimbus");
    await submit();
    const params = watcherCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.parse(String(params["graphPredicateJson"]))).toMatchObject({
      relation: "upstream_of",
    });
  });

  it("shows the chosen relation's description and sends that relation", async () => {
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Upstream" } });
    enableGraph();
    expect(screen.getByText("Owned by the target")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Graph relation"), {
      target: { value: "upstream_of" },
    });
    expect(screen.getByText("Feeds into the target")).toBeInTheDocument();
    expect(screen.queryByText("Owned by the target")).toBeNull();

    fillTargets("repo", "nimbus");
    await submit();
    expect(watcherCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        graphPredicateJson: JSON.stringify({
          relation: "upstream_of",
          target: { type: "repo", externalId: "nimbus" },
        }),
      }),
    );
  });

  it("keeps owned_by when the gateway lists no relations at all", async () => {
    watcherListCandidateRelationsMock.mockResolvedValueOnce({ relations: [] });
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Bare" } });
    enableGraph();
    expect(screen.getByLabelText("Graph relation").querySelectorAll("option")).toHaveLength(0);
    expect(screen.queryByText("Owned by the target")).toBeNull();

    fillTargets("person", "u-1");
    await submit();
    const params = watcherCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.parse(String(params["graphPredicateJson"]))).toMatchObject({
      relation: "owned_by",
    });
  });
});

describe("Watchers — create dialog fields", () => {
  it("sends the edited condition JSON, action type and action JSON verbatim", async () => {
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "  Hook  " } });
    fireEvent.change(screen.getByLabelText("Condition JSON"), {
      target: { value: '{ "filter": { "service": "pagerduty" } }' },
    });
    fireEvent.change(screen.getByLabelText("Action type"), { target: { value: "webhook" } });
    fireEvent.change(screen.getByLabelText("Action JSON"), {
      target: { value: '{"url":"https://hooks.example.test"}' },
    });
    await submit();

    expect(watcherCreateMock).toHaveBeenCalledWith({
      name: "Hook",
      conditionType: "incident_opened",
      conditionJson: '{ "filter": { "service": "pagerduty" } }',
      actionType: "webhook",
      actionJson: '{"url":"https://hooks.example.test"}',
    });
  });

  it("creates a watcher from the defaults when only a name is given", async () => {
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Plain" } });
    await submit();
    expect(watcherCreateMock).toHaveBeenCalledWith({
      name: "Plain",
      conditionType: "incident_opened",
      conditionJson: '{ "filter": {} }',
      actionType: "notify",
      actionJson: "{}",
    });
  });

  it("keeps Create disabled for an empty or whitespace-only name", async () => {
    await openDialog();
    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "   " } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "x" } });
    expect(create).not.toBeDisabled();
  });

  it("keeps Create disabled while the graph target ID is whitespace-only", async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "G" } });
    enableGraph();
    fillTargets("person", "   ");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("handles the create form in place instead of letting the webview submit it", async () => {
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    const dialog = await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "N" } });
    const form = dialog.querySelector("form");
    if (form === null) throw new Error("the create dialog has no form");
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.submit(form);
    });
    expect(notPrevented).toBe(false);
    expect(watcherCreateMock).toHaveBeenCalledTimes(1);
  });

  it("shows Creating… and clears a stale error while a retry is in flight", async () => {
    let finish: (v: unknown) => void = () => {};
    watcherCreateMock
      .mockRejectedValueOnce(new Error("-32602 invalid condition"))
      .mockReturnValueOnce(
        new Promise((r) => {
          finish = r;
        }),
      );
    const dialog = await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Retry" } });
    await submit();
    expect(within(dialog).getByText("-32602 invalid condition")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    });
    expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(within(dialog).queryByText("-32602 invalid condition")).toBeNull();
    await act(async () => {
      finish({ id: "w-new" });
    });
    expect(screen.queryByRole("dialog", { name: "Create watcher" })).toBeNull();
  });

  it("closes the dialog and refetches after a successful create", async () => {
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    await openDialog();
    const before = listCalls();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Ok" } });
    await submit();
    expect(screen.queryByRole("dialog", { name: "Create watcher" })).toBeNull();
    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it("keeps the dialog open with the error when create fails", async () => {
    watcherCreateMock.mockRejectedValueOnce(new Error("-32602 invalid condition"));
    const dialog = await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Bad" } });
    await submit();
    expect(within(dialog).getByText("-32602 invalid condition")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create" })).not.toBeDisabled();
  });

  it("stringifies a non-Error create failure", async () => {
    watcherCreateMock.mockRejectedValueOnce("E_WATCHER");
    const dialog = await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Bad" } });
    await submit();
    expect(within(dialog).getByText("E_WATCHER")).toBeInTheDocument();
  });

  it("Cancel closes the dialog without creating", async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Create watcher" })).toBeNull();
    expect(watcherCreateMock).not.toHaveBeenCalled();
  });

  it("re-enables Create once whitespace-only graph targets are filled in", async () => {
    await openDialog();
    fireEvent.change(screen.getByLabelText("Watcher name"), { target: { value: "G" } });
    enableGraph();
    fillTargets("   ", "u-1");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fillTargets("person", "u-1");
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled();
  });
});

describe("Watchers — live predicate validation", () => {
  it("debounces edits so only the final predicate is validated", async () => {
    vi.useFakeTimers();
    watcherValidateConditionMock.mockResolvedValue({ matchCount: 2 });
    await openDialog();
    enableGraph();
    fillTargets("person", "u-1");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(screen.getByLabelText("Target entity ID"), { target: { value: "u-2" } });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(watcherValidateConditionMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(watcherValidateConditionMock).toHaveBeenCalledTimes(1);
    expect(watcherValidateConditionMock).toHaveBeenCalledWith(
      JSON.stringify({ relation: "owned_by", target: { type: "person", externalId: "u-2" } }),
      30 * 24 * 60 * 60 * 1000,
    );
    const result = screen.getByTestId("validation-result");
    expect(result).toHaveTextContent("2 matching item(s) in the last 30 days");
    expect(result.className).toContain("text-green-700");
  });

  it("clears the result when a target becomes whitespace-only, without re-validating", async () => {
    vi.useFakeTimers();
    watcherValidateConditionMock.mockResolvedValue({ matchCount: 5 });
    await openDialog();
    enableGraph();
    fillTargets("person", "u-1");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId("validation-result")).toHaveTextContent("5 matching");

    fireEvent.change(screen.getByLabelText("Target entity ID"), { target: { value: "   " } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId("validation-result")).toBeNull();
    expect(watcherValidateConditionMock).toHaveBeenCalledTimes(1);
  });

  it("does not validate while the target type is whitespace-only", async () => {
    vi.useFakeTimers();
    watcherValidateConditionMock.mockResolvedValue({ matchCount: 1 });
    await openDialog();
    enableGraph();
    fillTargets("   ", "u-1");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(watcherValidateConditionMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("validation-result")).toBeNull();
  });

  it("drops a pending validation when the graph predicate is switched off", async () => {
    vi.useFakeTimers();
    watcherValidateConditionMock.mockResolvedValue({ matchCount: 1 });
    await openDialog();
    enableGraph();
    fillTargets("person", "u-1");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // Unchecking unmounts the builder while its 500 ms debounce is still pending.
    enableGraph();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(watcherValidateConditionMock).not.toHaveBeenCalled();
  });

  it("shows a non-Error validation failure as text in red", async () => {
    vi.useFakeTimers();
    watcherValidateConditionMock.mockRejectedValue("E_PREDICATE");
    await openDialog();
    enableGraph();
    fillTargets("repo", "r-1");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const result = screen.getByTestId("validation-result");
    expect(result).toHaveTextContent("E_PREDICATE");
    expect(result.className).toContain("text-red-600");
  });
});

describe("Watchers — list and row actions in flight", () => {
  it("shows Loading… until the watcher list arrives, with no dialog open", async () => {
    let resolveList: (v: unknown) => void = () => {};
    callMock.mockImplementation((method: string) =>
      method === "watcher.list"
        ? new Promise((r) => {
            resolveList = r;
          })
        : Promise.reject(new Error(`unexpected method: ${method}`)),
    );
    render(
      <MemoryRouter>
        <Watchers />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Create watcher" })).toBeNull();

    await act(async () => {
      resolveList({ watchers: [WATCHER] });
    });
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByLabelText("PR opened enabled")).toBeInTheDocument();
  });

  it("disables the row controls while a pause is in flight, then refetches", async () => {
    let finish: (v: unknown) => void = () => {};
    watcherPauseMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await renderPage([WATCHER, { ...WATCHER, id: "w2", name: "Deploy failed" }]);
    const before = listCalls();
    fireEvent.click(screen.getByLabelText("PR opened enabled"));
    expect(watcherPauseMock).toHaveBeenCalledWith("w1");
    expect(screen.getByLabelText("Deploy failed enabled")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete watcher Deploy failed" })).toBeDisabled();

    await act(async () => {
      finish({ ok: true });
    });
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    expect(screen.getByLabelText("Deploy failed enabled")).not.toBeDisabled();
  });

  it("disables the row controls while a delete is in flight, then refetches", async () => {
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    let finish: (v: unknown) => void = () => {};
    watcherDeleteMock.mockReturnValueOnce(
      new Promise((r) => {
        finish = r;
      }),
    );
    await renderPage([WATCHER]);
    const before = listCalls();
    fireEvent.click(screen.getByRole("button", { name: "Delete watcher PR opened" }));
    expect(watcherDeleteMock).toHaveBeenCalledWith("w1");
    expect(screen.getByLabelText("PR opened enabled")).toBeDisabled();

    await act(async () => {
      finish({ ok: true });
    });
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    expect(screen.getByLabelText("PR opened enabled")).not.toBeDisabled();
  });

  it("disables the row controls while offline", async () => {
    await renderPage([WATCHER]);
    act(() => {
      useNimbusStore.setState({ connectionState: "disconnected" });
    });
    expect(screen.getByLabelText("PR opened enabled")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete watcher PR opened" })).toBeDisabled();
  });
});

describe("Watchers — row actions", () => {
  it("leaves the watcher alone when the delete confirmation is declined", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    await renderPage([WATCHER]);
    fireEvent.click(screen.getByRole("button", { name: "Delete watcher PR opened" }));
    expect(confirmSpy).toHaveBeenCalledWith('Delete watcher "PR opened"?');
    expect(watcherDeleteMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("PR opened enabled")).not.toBeDisabled();
  });

  it("collapses the history drawer from its own Close button", async () => {
    watcherListHistoryMock.mockResolvedValue({ events: [] });
    await renderPage([WATCHER]);
    fireEvent.click(screen.getByRole("button", { name: "History for PR opened" }));
    expect(await screen.findByText("No fires yet.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "History for PR opened" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("No fires yet.")).toBeNull();
    expect(screen.queryByRole("region", { name: "History for PR opened" })).toBeNull();
  });
});
