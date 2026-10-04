import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/store", () => ({
  useNimbusStore: (sel: (s: { pendingHitl: number; lastSeenPushedAt: number }) => unknown) =>
    sel({ pendingHitl: 3, lastSeenPushedAt: 100 }),
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

describe("Sidebar", () => {
  it("renders all seven top-level nav entries", () => {
    renderSidebar(null);
    expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /On-call/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /HITL/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Marketplace/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Watchers/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Workflows/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings/i })).toBeInTheDocument();
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
