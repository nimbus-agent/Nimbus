import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBriefRow } from "../../src/ipc/types";
import { StoredBrief } from "../../src/pages/StoredBrief";

const h = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  error: null as string | null,
}));

vi.mock("../../src/ipc/client");
vi.mock("../../src/hooks/useRolePacks", () => ({
  useRolePacks: () => ({
    packs: null,
    catalog: {
      agents: [{ name: "decisions", method: "agents.decisions", displayName: "Decisions" }],
      connectors: [],
      visibility: { basis: "all", packs: [], notes: [] },
    },
    sections: [],
    loaded: true,
  }),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: () => Promise.resolve() }));
// Like the real hook, an instance keeps its PREVIOUS data while a new id's answer is pending.
vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: (_m: string, _i: number, params?: Record<string, unknown>) => {
    const prev = useRef<unknown>(null);
    const cur = h.data.get(String(params?.["id"]));
    if (cur !== undefined) prev.current = cur;
    return { data: prev.current, error: h.error, isLoading: false, refetch: vi.fn() };
  },
}));

import { callMock } from "../../src/ipc/__mocks__/client";

function row(over: Partial<FleetBriefRow>): FleetBriefRow {
  return {
    id: "a",
    runId: "r",
    jobId: "nightly",
    subjectKey: "nightly",
    agentMethod: "agents.decisions",
    briefMarkdown: "Alpha text",
    createdAt: Date.UTC(2026, 9, 25, 12, 0, 0),
    ...over,
  };
}

function Nav(): React.ReactNode {
  const nav = useNavigate();
  return (
    <button type="button" onClick={() => nav("/briefs/stored/b")}>
      go b
    </button>
  );
}

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/briefs/stored/${id}`]}>
      <Nav />
      <Routes>
        <Route path="/briefs/stored/:id" element={<StoredBrief />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("StoredBrief", () => {
  beforeEach(() => {
    h.data.clear();
    h.error = null;
    callMock.mockClear();
  });

  it("renders the markdown with the agent's display name and job", () => {
    h.data.set("a", { brief: row({}) });
    renderAt("a");
    expect(screen.getByText("Alpha text")).toBeTruthy();
    expect(screen.getByText(/Decisions · job nightly/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "← Briefs" }).getAttribute("href")).toBe("/briefs");
    expect(callMock.mock.calls.filter(([m]) => m.startsWith("agents."))).toEqual([]);
  });

  it("says so when the brief is gone and links back to the briefs", () => {
    h.data.set("a", { brief: null });
    renderAt("a");
    expect(screen.getByText("This stored brief is no longer available.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pick a brief to run" })).toBeTruthy();
  });

  it("says so when the run produced no text", () => {
    h.data.set("a", { brief: row({ briefMarkdown: null }) });
    renderAt("a");
    expect(screen.getByText("This run produced no text.")).toBeTruthy();
  });

  it("never shows a's text for b while b is unresolved", async () => {
    h.data.set("a", { brief: row({}) });
    renderAt("a");
    expect(screen.getByText("Alpha text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "go b" }));
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Alpha text")).toBeNull();
  });
});

describe("StoredBrief: odd answers", () => {
  beforeEach(() => {
    h.data.clear();
    h.error = null;
  });

  it("shows the query error while nothing usable has arrived", () => {
    h.error = "fleet.show failed";
    renderAt("a");
    expect(screen.getByRole("alert").textContent).toBe("fleet.show failed");
  });

  it("treats a reply of the wrong shape as not arrived yet", () => {
    for (const bad of ["text", { nope: 1 }, { brief: "str" }, { brief: { id: 1 } }]) {
      h.data.set("a", bad);
      const { unmount } = renderAt("a");
      expect(screen.getByText("Loading…")).toBeTruthy();
      unmount();
    }
  });

  it("falls back to the method name for an agent the catalog does not list", () => {
    h.data.set("a", { brief: row({ agentMethod: "agents.unlisted" }) });
    renderAt("a");
    expect(screen.getByText(/agents\.unlisted · job nightly/)).toBeTruthy();
  });
});
