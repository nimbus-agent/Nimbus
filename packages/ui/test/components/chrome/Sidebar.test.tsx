import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/store", () => ({
  useNimbusStore: (sel: (s: { pendingHitl: number; lastSeenPushedAt: number }) => unknown) =>
    sel({ pendingHitl: 3, lastSeenPushedAt: 100 }),
}));

const rolePacks = vi.hoisted(() => ({
  sections: [] as readonly {
    id: string;
    name: string;
    agents: readonly { name: string; displayName: string }[];
  }[],
}));
vi.mock("../../../src/hooks/useRolePacks", () => ({
  useRolePacks: () => ({ packs: null, catalog: null, sections: rolePacks.sections, loaded: true }),
}));

import { Sidebar } from "../../../src/components/chrome/Sidebar";
import { OncallBriefsContext, type OncallBriefsState } from "../../../src/hooks/useOncallBriefs";
import type { PushedBriefList } from "../../../src/ipc/types";

function stub(newestCreatedAt: number | null): OncallBriefsState {
  const briefs = newestCreatedAt === null ? [] : [{ createdAt: newestCreatedAt }];
  return {
    list: { enabled: true, briefs } as unknown as PushedBriefList,
    error: null,
    isLoading: false,
    lastPushed: null,
    refetch: () => undefined,
  };
}

function renderSidebar(newestCreatedAt: number | null) {
  return render(
    <OncallBriefsContext.Provider value={stub(newestCreatedAt)}>
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>
    </OncallBriefsContext.Provider>,
  );
}

beforeEach(() => {
  rolePacks.sections = [];
});

describe("Sidebar", () => {
  it("renders all nine top-level nav entries", () => {
    renderSidebar(null);
    expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Briefs/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /On-call/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Captures/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /HITL/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Marketplace/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Watchers/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Workflows/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings/i })).toBeInTheDocument();
  });

  it("puts Briefs directly after Dashboard, linking to /briefs", () => {
    renderSidebar(null);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveTextContent("Dashboard");
    expect(links[1]).toHaveTextContent("Briefs");
    expect(links[1]).toHaveAttribute("href", "/briefs");
  });

  it("adds only Briefs when there are no pack sections", () => {
    renderSidebar(null);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getAllByRole("link")).toHaveLength(9);
  });

  it("lists a pack's agents in a labelled group", () => {
    rolePacks.sections = [
      {
        id: "devops",
        name: "DevOps",
        agents: [
          { name: "oncall", displayName: "On-call brief" },
          { name: "why", displayName: "Why" },
        ],
      },
    ];
    renderSidebar(null);
    const group = screen.getByRole("group", { name: "DevOps" });
    const links = within(group).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/briefs/oncall", "/briefs/why"]);
    expect(links[0]).toHaveTextContent("On-call brief");
  });

  it("makes the nav scrollable and gives labels a title", () => {
    renderSidebar(null);
    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveClass("overflow-y-auto");
    expect(screen.getByText("Dashboard")).toHaveAttribute("title", "Dashboard");
  });

  it("shows the pending-HITL badge when count > 0", () => {
    renderSidebar(null);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows the on-call dot when the newest brief is newer than last seen", () => {
    renderSidebar(200);
    expect(screen.getByTestId("nav-dot")).toBeInTheDocument();
    expect(screen.getByText("new pushed brief")).toBeInTheDocument();
  });

  it("hides the dot when the newest brief is not newer", () => {
    renderSidebar(100);
    expect(screen.queryByTestId("nav-dot")).toBeNull();
  });

  it("hides the dot when there are no briefs", () => {
    renderSidebar(null);
    expect(screen.queryByTestId("nav-dot")).toBeNull();
  });
});
