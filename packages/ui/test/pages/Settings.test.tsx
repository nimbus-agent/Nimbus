import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { Settings } from "../../src/pages/Settings";

describe("Settings layout", () => {
  it("renders SettingsSidebar and the nested Outlet content", () => {
    render(
      <MemoryRouter initialEntries={["/settings/profiles"]}>
        <Routes>
          <Route path="/settings" element={<Settings />}>
            <Route
              path="profiles"
              element={<div data-testid="child-outlet">Profiles content</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByTestId("child-outlet")).toHaveTextContent("Profiles content");
  });
});
