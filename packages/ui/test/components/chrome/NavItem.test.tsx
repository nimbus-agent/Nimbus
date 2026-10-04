import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { NavItem } from "../../../src/components/chrome/NavItem";

const at = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("NavItem indicator", () => {
  it("renders a dot with its hidden label", () => {
    at(<NavItem to="/oncall" icon="☎" label="On-call" dot dotLabel="new pushed brief" />);
    expect(screen.getByTestId("nav-dot")).toBeInTheDocument();
    expect(screen.getByText("new pushed brief")).toHaveClass("sr-only");
  });
  it("a positive badge wins over the dot", () => {
    at(<NavItem to="/x" icon="x" label="X" badge={2} dot dotLabel="d" />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-dot")).toBeNull();
  });
  it("no dot when dot is false or absent", () => {
    at(<NavItem to="/x" icon="x" label="X" dot={false} />);
    expect(screen.queryByTestId("nav-dot")).toBeNull();
  });
});
