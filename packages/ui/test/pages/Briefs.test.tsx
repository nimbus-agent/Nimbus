import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { CatalogAgent, CatalogListResult } from "../../src/ipc/types";
import { Briefs } from "../../src/pages/Briefs";

const h = vi.hoisted(() => ({ catalog: null as unknown }));

vi.mock("../../src/ipc/client");
vi.mock("../../src/hooks/useRolePacks", () => ({
  useRolePacks: () => ({ packs: null, catalog: h.catalog, sections: [], loaded: true }),
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
