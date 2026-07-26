import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const CANDIDATE_RELATIONS = [
  {
    relation: "owned_by",
    description: "Authored, opened, or posted by target",
    underlyingRelationTypes: ["authored", "opened", "posted"],
  },
  {
    relation: "upstream_of",
    description: "Direct outgoing edge to target",
    underlyingRelationTypes: ["belongs_to", "targets"],
  },
  {
    relation: "downstream_of",
    description: "Target has outgoing edge to item",
    underlyingRelationTypes: ["belongs_to", "targets"],
  },
];

const WATCHER_1 = {
  id: "w1",
  name: "PR opened",
  enabled: 1,
  condition_type: "graph",
  condition_json: "{}",
  action_type: "notify",
  action_json: "{}",
  created_at: 1_700_000_000_000,
  last_checked_at: null,
  last_fired_at: 1_700_001_000_000,
  graph_predicate_json: null,
};

const WATCHER_2 = {
  id: "w2",
  name: "Daily digest",
  enabled: 0,
  condition_type: "schedule",
  condition_json: "{}",
  action_type: "webhook",
  action_json: "{}",
  created_at: 1_700_000_000_000,
  last_checked_at: null,
  last_fired_at: null,
  graph_predicate_json: null,
};

function stubWatcherList(rows: unknown[]) {
  callMock.mockImplementation(async (method: string) => {
    if (method === "watcher.list") return { watchers: rows };
    throw new Error(`unexpected method: ${method}`);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Watchers />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  callMock.mockReset();
  watcherCreateMock.mockReset();
  watcherDeleteMock.mockReset();
  watcherPauseMock.mockReset();
  watcherResumeMock.mockReset();
  watcherListCandidateRelationsMock.mockReset();
  watcherValidateConditionMock.mockReset();
  watcherListHistoryMock.mockReset();
  watcherListCandidateRelationsMock.mockResolvedValue({ relations: CANDIDATE_RELATIONS });
  useNimbusStore.setState({ connectionState: "connected" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Watchers page — list", () => {
  it("renders watcher names from the list", async () => {
    stubWatcherList([WATCHER_1, WATCHER_2]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("PR opened")).toBeInTheDocument();
      expect(screen.getByText("Daily digest")).toBeInTheDocument();
    });
  });

  it("enabled checkbox reflects the watcher state", async () => {
    stubWatcherList([WATCHER_1, WATCHER_2]);
    renderPage();
    expect(await screen.findByText("PR opened")).toBeInTheDocument();
    expect(screen.getByLabelText("PR opened enabled")).toBeChecked();
    expect(screen.getByLabelText("Daily digest enabled")).not.toBeChecked();
  });

  it("toggling a checked watcher calls watcherPause", async () => {
    stubWatcherList([WATCHER_1]);
    watcherPauseMock.mockResolvedValue({ ok: true });
    callMock
      .mockResolvedValueOnce({ watchers: [WATCHER_1] })
      .mockResolvedValue({ watchers: [{ ...WATCHER_1, enabled: 0 }] });
    renderPage();
    expect(await screen.findByLabelText("PR opened enabled")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("PR opened enabled"));
    expect(watcherPauseMock).toHaveBeenCalledWith("w1");
  });

  it("toggling an unchecked watcher calls watcherResume", async () => {
    stubWatcherList([WATCHER_2]);
    watcherResumeMock.mockResolvedValue({ ok: true });
    callMock
      .mockResolvedValueOnce({ watchers: [WATCHER_2] })
      .mockResolvedValue({ watchers: [{ ...WATCHER_2, enabled: 1 }] });
    renderPage();
    expect(await screen.findByLabelText("Daily digest enabled")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Daily digest enabled"));
    expect(watcherResumeMock).toHaveBeenCalledWith("w2");
  });

  it("shows the last-fired timestamp when present", async () => {
    stubWatcherList([WATCHER_1]);
    renderPage();
    expect(await screen.findByTestId("last-fired-w1")).toBeInTheDocument();
    expect(screen.getByTestId("last-fired-w1").textContent).not.toBe("Never fired");
  });

  it("shows 'Never fired' when last_fired_at is null", async () => {
    stubWatcherList([WATCHER_2]);
    renderPage();
    expect(await screen.findByTestId("last-fired-w2")).toBeInTheDocument();
    expect(screen.getByTestId("last-fired-w2")).toHaveTextContent("Never fired");
  });

  it("shows error state when watcher.list fails", async () => {
    callMock.mockRejectedValue(new Error("Gateway timeout"));
    renderPage();
    expect(await screen.findByText(/Gateway timeout/)).toBeInTheDocument();
  });

  it("'New watcher' button is disabled when offline", () => {
    useNimbusStore.setState({ connectionState: "disconnected" });
    callMock.mockResolvedValue({ watchers: [] });
    renderPage();
    expect(screen.getByRole("button", { name: /new watcher/i })).toBeDisabled();
  });

  it("calls watcherDelete after confirm dialog", async () => {
    stubWatcherList([WATCHER_1]);
    watcherDeleteMock.mockResolvedValue({ ok: true });
    callMock.mockResolvedValueOnce({ watchers: [WATCHER_1] }).mockResolvedValue({ watchers: [] });
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderPage();
    expect(await screen.findByText("PR opened")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /delete watcher PR opened/i }));
    expect(watcherDeleteMock).toHaveBeenCalledWith("w1");
  });
});

async function openDialog() {
  stubWatcherList([]);
  renderPage();
  await waitFor(() => expect(callMock).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: /new watcher/i }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(await screen.findByLabelText("Graph relation")).toBeInTheDocument();
}

describe("Watchers page — graph condition builder", () => {
  it("graph condition type shows relation dropdown with candidate relations", async () => {
    await openDialog();
    const select = screen.getByLabelText("Graph relation");
    expect(select).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "owned_by" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "upstream_of" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "downstream_of" })).toBeInTheDocument();
  });

  it("shows target type and target ID inputs", async () => {
    await openDialog();
    expect(screen.getByLabelText("Target entity type")).toBeInTheDocument();
    expect(screen.getByLabelText("Target entity ID")).toBeInTheDocument();
  });

  it("switching to non-graph condition type shows raw textarea", async () => {
    await openDialog();
    await userEvent.selectOptions(screen.getByLabelText("Condition type"), "schedule");
    expect(screen.getByLabelText("Condition JSON")).toBeInTheDocument();
    expect(screen.queryByLabelText("Graph relation")).not.toBeInTheDocument();
  });

  it("validation fires after debounce and shows match count", async () => {
    watcherValidateConditionMock.mockResolvedValue({ matchCount: 7 });
    await openDialog();

    await userEvent.type(screen.getByLabelText("Target entity type"), "person");
    await userEvent.type(screen.getByLabelText("Target entity ID"), "user-42");

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await waitFor(() =>
      expect(screen.getByTestId("validation-result")).toHaveTextContent(
        "7 matching item(s) in the last 30 days",
      ),
    );
    expect(watcherValidateConditionMock).toHaveBeenCalledWith(
      JSON.stringify({
        relation: "owned_by",
        target: { type: "person", externalId: "user-42" },
      }),
      30 * 24 * 60 * 60 * 1000,
    );
  });

  it("validation shows error message on failure", async () => {
    watcherValidateConditionMock.mockRejectedValue(new Error("invalid predicate"));
    await openDialog();

    await userEvent.type(screen.getByLabelText("Target entity type"), "repo");
    await userEvent.type(screen.getByLabelText("Target entity ID"), "my-repo");

    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    await waitFor(() =>
      expect(screen.getByTestId("validation-result")).toHaveTextContent("invalid predicate"),
    );
  });

  it("watcherCreate is called with graphPredicateJson for graph condition type", async () => {
    watcherCreateMock.mockResolvedValue({ id: "w-new" });
    await openDialog();

    await userEvent.type(screen.getByLabelText("Watcher name"), "My Graph Watcher");
    await userEvent.type(screen.getByLabelText("Target entity type"), "person");
    await userEvent.type(screen.getByLabelText("Target entity ID"), "user-99");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    expect(watcherCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My Graph Watcher",
        conditionType: "graph",
        conditionJson: "{}",
        graphPredicateJson: JSON.stringify({
          relation: "owned_by",
          target: { type: "person", externalId: "user-99" },
        }),
      }),
    );
  });

  it("Create button is disabled when graph fields are incomplete", async () => {
    await openDialog();
    await userEvent.type(screen.getByLabelText("Watcher name"), "Incomplete");
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
  });
});

describe("Watchers page — history drawer", () => {
  it("clicking History on a watcher row fetches and renders the last N fires", async () => {
    stubWatcherList([WATCHER_1]);
    watcherListHistoryMock.mockResolvedValue({
      events: [
        { firedAt: 2000, conditionSnapshot: '{"a":2}', actionResult: '{"ok":true}' },
        { firedAt: 1000, conditionSnapshot: '{"a":1}', actionResult: '{"ok":true}' },
      ],
    });

    renderPage();
    await screen.findByText("PR opened");
    const historyButton = await screen.findByRole("button", { name: /history for PR opened/i });
    await userEvent.click(historyButton);
    await screen.findByText('{"a":2}');
    expect(watcherListHistoryMock).toHaveBeenCalledWith("w1", expect.any(Number));
  });

  it("History drawer shows an empty state when no events have fired", async () => {
    stubWatcherList([WATCHER_1]);
    watcherListHistoryMock.mockResolvedValue({ events: [] });

    renderPage();
    await screen.findByText("PR opened");
    await userEvent.click(await screen.findByRole("button", { name: /history for PR opened/i }));
    expect(await screen.findByText(/no fires yet/i)).toBeInTheDocument();
  });

  it("clicking History again collapses the drawer", async () => {
    stubWatcherList([WATCHER_1]);
    watcherListHistoryMock.mockResolvedValue({
      events: [{ firedAt: 3000, conditionSnapshot: '{"x":3}', actionResult: '{"ok":true}' }],
    });

    renderPage();
    await screen.findByText("PR opened");
    const historyButton = await screen.findByRole("button", { name: /history for PR opened/i });
    await userEvent.click(historyButton);
    await screen.findByText('{"x":3}');
    await userEvent.click(historyButton);
    await waitFor(() => expect(screen.queryByText('{"x":3}')).not.toBeInTheDocument());
  });
});
