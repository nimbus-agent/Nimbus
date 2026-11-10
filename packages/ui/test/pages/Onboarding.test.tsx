import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { Onboarding } from "../../src/pages/Onboarding";
import { useNimbusStore } from "../../src/store";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />}>
          <Route path="role" element={<div>role body</div>} />
          <Route path="pack" element={<div>pack body</div>} />
          <Route path="connect" element={<div>connect body</div>} />
          <Route path="decisions" element={<div>decisions body</div>} />
          <Route path="syncing" element={<div>syncing body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Onboarding shell", () => {
  beforeEach(() => {
    useNimbusStore.getState().resetOnboarding();
  });

  it("lists the steps without Pack when no pack was chosen, and renders the step body", () => {
    renderAt("/onboarding/role");
    expect(screen.getByText("role body")).toBeTruthy();
    expect(screen.getByText(/1 · Welcome/)).toBeTruthy();
    expect(screen.getByText(/2 · Role/)).toBeTruthy();
    expect(screen.getByText(/3 · Connect/)).toBeTruthy();
    expect(screen.getByText(/4 · Syncing/)).toBeTruthy();
    expect(screen.queryByText(/Pack/)).toBeNull();
  });

  it("shows the Pack step on the pack page even before a pack is chosen", () => {
    renderAt("/onboarding/pack");
    expect(screen.getByText(/3 · Pack/)).toBeTruthy();
  });

  it("ends on Decisions when the chosen pack shows decisions", () => {
    useNimbusStore.getState().setChosenPack("pm", true);
    renderAt("/onboarding/connect");
    expect(screen.getByText(/4 · Connect/)).toBeTruthy();
    expect(screen.getByText(/5 · Decisions/)).toBeTruthy();
    expect(screen.queryByText(/Syncing/)).toBeNull();
  });
});
