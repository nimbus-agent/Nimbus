import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { BRIEF_WAIT_DEADLINE_MS, type BriefRun as Run } from "../../src/briefs/brief-runs";
import type { CatalogAgent, CatalogParam } from "../../src/ipc/types";
import { BriefRun } from "../../src/pages/BriefRun";

const h = vi.hoisted(() => ({
  runs: new Map<string, unknown>(),
  start: null as unknown as Mock<(a: string, p: Record<string, unknown>) => Promise<void>>,
  writeText: null as unknown as Mock<(t: string) => Promise<void>>,
}));

vi.mock("../../src/ipc/client");
vi.mock("../../src/hooks/useBriefRuns", () => ({
  useBriefRuns: () => ({
    latest: (a: string) => h.runs.get(a),
    start: (a: string, p: Record<string, unknown>) => h.start(a, p),
  }),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (t: string) => h.writeText(t),
}));

import { callMock } from "../../src/ipc/__mocks__/client";

const CATALOG: { agents: CatalogAgent[]; failed: string | null } = { agents: [], failed: null };
vi.mock("../../src/hooks/useRolePacks", () => ({
  useRolePacks: () => ({
    packs: null,
    catalog:
      CATALOG.failed === null
        ? {
            agents: CATALOG.agents,
            connectors: [],
            visibility: { basis: "all", packs: [], notes: [] },
          }
        : null,
    catalogError: CATALOG.failed,
    sections: [],
    loaded: CATALOG.failed === null,
  }),
}));

function agent(name: string, params: CatalogParam[] = []): CatalogAgent {
  return {
    name,
    method: `agents.${name}`,
    displayName: `Name ${name}`,
    description: `About ${name}`,
    category: "knowledge",
    roles: [],
    params,
    surfaces: { external: true, fleet: true },
    visible: true,
  };
}

function Nav(): React.ReactNode {
  const nav = useNavigate();
  return (
    <button type="button" onClick={() => nav("/briefs/b")}>
      go b
    </button>
  );
}

function renderAt(name: string) {
  return render(
    <MemoryRouter initialEntries={[`/briefs/${name}`]}>
      <Nav />
      <Routes>
        <Route path="/briefs/:agent" element={<BriefRun />} />
      </Routes>
    </MemoryRouter>,
  );
}

function pending(agentName: string, requestedAt = Date.now()): Run {
  return { sessionId: "s", agent: agentName, requestedAt, status: "pending" };
}

function agentCalls(): unknown[] {
  return callMock.mock.calls.filter(([m]) => m.startsWith("agents."));
}

beforeEach(() => {
  h.runs.clear();
  h.start = vi.fn(() => Promise.resolve());
  h.writeText = vi.fn(() => Promise.resolve());
  callMock.mockClear();
  CATALOG.failed = null;
  CATALOG.agents = [
    agent("decisions", [{ name: "sinceMs", kind: "number", label: "Since (ms)", required: false }]),
    agent("huddle"),
    agent("ghost"),
    agent("a"),
    agent("b"),
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BriefRun", () => {
  it("never calls the gateway on mount and shows a back link", () => {
    renderAt("decisions");
    expect(agentCalls()).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "← Briefs" }).getAttribute("href")).toBe("/briefs");
  });

  it("Run calls start with the collected params", async () => {
    const user = userEvent.setup();
    renderAt("decisions");
    await user.selectOptions(screen.getByLabelText("Since"), "7 days");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(h.start).toHaveBeenCalledWith("decisions", { sinceMs: 604_800_000 });
  });

  it("disables Run until start settles, so a second click cannot start twice", async () => {
    let release: () => void = () => undefined;
    h.start = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const user = userEvent.setup();
    renderAt("decisions");
    const run = screen.getByRole("button", { name: "Run" });
    await user.click(run);
    expect((run as HTMLButtonElement).disabled).toBe(true);
    await user.click(run);
    expect(h.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
    expect((run as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a rejected start's message beside the form and re-enables Run", async () => {
    h.start = vi.fn(() => Promise.reject(new Error("refused: bad params")));
    const user = userEvent.setup();
    renderAt("decisions");
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("refused: bad params")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows elapsed time and a disabled Run while pending", () => {
    vi.useFakeTimers();
    h.runs.set("decisions", pending("decisions", Date.now()));
    renderAt("decisions");
    expect(screen.getByText("Running… 0s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText("Running… 3s")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
    expect(agentCalls()).toEqual([]);
  });

  it("says check back once past the deadline", () => {
    h.runs.set("decisions", pending("decisions", Date.now() - BRIEF_WAIT_DEADLINE_MS - 1000));
    renderAt("decisions");
    expect(screen.getByText("Still running — check back.")).toBeTruthy();
  });

  it("re-enables Run once past the deadline, and clicking it starts again", async () => {
    h.runs.set("decisions", pending("decisions", Date.now() - BRIEF_WAIT_DEADLINE_MS - 1000));
    const user = userEvent.setup();
    renderAt("decisions");
    const run = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    await user.click(run);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("shows the catalog error instead of Loading… when catalog.list failed", () => {
    CATALOG.failed = "gateway down";
    renderAt("decisions");
    expect(screen.getByText("Could not load the brief list: gateway down")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("labels the sinceMs select 'Since'", () => {
    CATALOG.agents = [
      agent("decisions", [
        { name: "sinceMs", kind: "number", label: "Since (ms)", required: false },
      ]),
    ];
    renderAt("decisions");
    expect(screen.getByLabelText("Since")).toBeTruthy();
    expect(screen.queryByLabelText("Since (ms)")).toBeNull();
  });

  it("an optional group can be un-chosen with None, sending none of its fields", async () => {
    CATALOG.agents = [
      agent("oncall", [
        {
          name: "incident",
          kind: "string",
          label: "Incident",
          required: false,
          oneOf: { group: "target", arm: "incident", required: false, armRequired: false },
        },
        {
          name: "service",
          kind: "string",
          label: "Service",
          required: false,
          oneOf: { group: "target", arm: "service", required: false, armRequired: false },
        },
      ]),
    ];
    const user = userEvent.setup();
    renderAt("oncall");
    expect(screen.getByRole("button", { name: "None" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "incident" }));
    await user.type(screen.getByLabelText("Incident"), "INC-1");
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(screen.queryByLabelText("Incident")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(h.start).toHaveBeenCalledWith("oncall", {});
  });

  it("a required group has no None choice", () => {
    CATALOG.agents = [
      agent("impact", [
        {
          name: "a",
          kind: "string",
          label: "A",
          required: false,
          oneOf: { group: "target", arm: "a", required: true, armRequired: true },
        },
      ]),
    ];
    renderAt("impact");
    expect(screen.queryByRole("button", { name: "None" })).toBeNull();
  });

  it("renders a ready run through Markdown and copies its source", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.runs.set("decisions", {
      sessionId: "s",
      agent: "decisions",
      requestedAt: 1,
      status: "ready",
      markdown: "## Heading\n\nbody",
      finishedAt: 2,
    });
    renderAt("decisions");
    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy as markdown" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.writeText).toHaveBeenCalledWith("## Heading\n\nbody");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button", { name: "Copy as markdown" })).toBeTruthy();
  });

  it("survives a failed clipboard write", async () => {
    h.writeText = vi.fn(() => Promise.reject(new Error("denied")));
    h.runs.set("decisions", {
      sessionId: "s",
      agent: "decisions",
      requestedAt: 1,
      status: "ready",
      markdown: "x",
      finishedAt: 2,
    });
    renderAt("decisions");
    fireEvent.click(screen.getByRole("button", { name: "Copy as markdown" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Copy as markdown" })).toBeTruthy();
  });

  it("shows an error run's message", () => {
    h.runs.set("decisions", {
      sessionId: "s",
      agent: "decisions",
      requestedAt: 1,
      status: "error",
      message: "model unavailable",
      finishedAt: 2,
    });
    renderAt("decisions");
    expect(screen.getByText("model unavailable")).toBeTruthy();
  });

  it("states that huddle and ghost ask paired peers, and decisions does not", () => {
    const { unmount } = renderAt("huddle");
    expect(screen.getByText("Asks your paired peers.")).toBeTruthy();
    unmount();
    const g = renderAt("ghost");
    expect(screen.getByText("Asks your paired peers.")).toBeTruthy();
    g.unmount();
    renderAt("decisions");
    expect(screen.queryByText("Asks your paired peers.")).toBeNull();
  });

  it("renders not-available pages from data alone", () => {
    const pm = renderAt("premortem");
    expect(screen.getByText(/nimbus pre-mortem/)).toBeTruthy();
    pm.unmount();
    const pf = renderAt("preflight");
    expect(screen.getByText(/nimbus preflight/)).toBeTruthy();
    pf.unmount();
    renderAt("nope");
    expect(screen.getByText(/not a built-in brief/)).toBeTruthy();
    expect(agentCalls()).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("shows only the navigated-to agent's state", async () => {
    h.runs.set("a", pending("a"));
    renderAt("a");
    expect(screen.getByText(/Running…/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "go b" }));
    expect(await screen.findByRole("heading", { name: "Name b" })).toBeTruthy();
    expect(screen.queryByText(/Running…/)).toBeNull();
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
