import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { CatalogAgent, CatalogListResult } from "../../src/ipc/types";
import { Briefs } from "../../src/pages/Briefs";

const h = vi.hoisted(() => ({ catalog: null as unknown, error: null as string | null }));

vi.mock("../../src/ipc/client");
vi.mock("../../src/hooks/useRolePacks", () => ({
  useRolePacks: () => ({
    packs: null,
    catalog: h.catalog,
    catalogError: h.error,
    sections: [],
    loaded: true,
  }),
}));

import { callMock } from "../../src/ipc/__mocks__/client";

function agent(name: string, category: CatalogAgent["category"]): CatalogAgent {
  return {
    name,
    method: `agents.${name}`,
    displayName: `Name ${name}`,
    description: `About ${name}`,
    category,
    roles: [],
    params: [],
    surfaces: { external: true, fleet: true },
    visible: true,
  };
}

function setCatalog(agents: CatalogAgent[]): void {
  const c: CatalogListResult = {
    agents,
    connectors: [],
    visibility: { basis: "all", packs: [], notes: [] },
  };
  h.catalog = c;
}

describe("Briefs", () => {
  it("shows the catalog error instead of Loading… when catalog.list failed", () => {
    h.catalog = null;
    h.error = "gateway down";
    render(
      <MemoryRouter>
        <Briefs />
      </MemoryRouter>,
    );
    h.error = null;
    expect(screen.getByText("Could not load the brief list: gateway down")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("groups by category in CATEGORY_ORDER, excludes preflight/premortem, includes negotiate", () => {
    callMock.mockClear();
    setCatalog([
      agent("impact", "code"),
      agent("preflight", "operations"),
      agent("premortem", "operations"),
      agent("negotiate", "people"),
      agent("catchup", "catch-up"),
      agent("glossary", "knowledge"),
    ]);
    render(
      <MemoryRouter>
        <Briefs />
      </MemoryRouter>,
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent);
    expect(headings).toEqual(["Catch-up", "Knowledge", "People", "Code"]);
    expect(screen.getByRole("link", { name: "Name negotiate" }).getAttribute("href")).toBe(
      "/briefs/negotiate",
    );
    expect(screen.queryByText("Name preflight")).toBeNull();
    expect(screen.queryByText("Name premortem")).toBeNull();
    expect(callMock.mock.calls.filter(([m]) => m.startsWith("agents."))).toEqual([]);
  });
});
