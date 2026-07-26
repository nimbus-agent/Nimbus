import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/store", () => ({
  useNimbusStore: (sel: (s: { pendingHitl: number }) => unknown) => sel({ pendingHitl: 3 }),
}));

import { Sidebar } from "../../../src/components/chrome/Sidebar";

describe("Sidebar", () => {
  it("renders all six top-level nav entries", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /HITL/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Marketplace/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Watchers/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Workflows/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings/i })).toBeInTheDocument();
  });

  it("shows the pending-HITL badge when count > 0", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
