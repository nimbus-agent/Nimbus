import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SettingsSidebar } from "../../../src/components/settings/SettingsSidebar";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSidebar />
    </MemoryRouter>,
  );
}

describe("SettingsSidebar", () => {
  it("renders all 7 WS5-C panel entries", () => {
    renderAt("/settings/profiles");
    for (const label of [
      "Model",
      "Connectors",
      "Profiles",
      "Audit",
      "Data",
      "Telemetry",
      "Updates",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("every entry links to its sub-route", () => {
    renderAt("/settings/profiles");
    expect(screen.getByRole("link", { name: "Model" })).toHaveAttribute("href", "/settings/model");
    expect(screen.getByRole("link", { name: "Profiles" })).toHaveAttribute(
      "href",
      "/settings/profiles",
    );
    expect(screen.getByRole("link", { name: "Updates" })).toHaveAttribute(
      "href",
      "/settings/updates",
    );
  });

  it("has aria-label 'Settings' so screen readers pick up the nav", () => {
    renderAt("/settings/profiles");
    expect(screen.getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
  });
});
