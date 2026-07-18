import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import { callMock } from "../../src/ipc/__mocks__/client";
import { Syncing } from "../../src/pages/onboarding/Syncing";

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/onboarding/syncing"]}>
      <Routes>
        <Route path="/onboarding/syncing" element={<Syncing />} />
        <Route path="/" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Onboarding → Syncing", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("polls diag.snapshot and renders counters", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "diag.snapshot") return { indexTotalItems: 42, connectorCount: 1 };
      if (method === "db.setMeta") return null;
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    expect(await screen.findByText(/42/)).toBeTruthy();
  });

  it("Open Dashboard writes onboarding_completed and navigates", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "diag.snapshot") return { indexTotalItems: 0, connectorCount: 0 };
      if (method === "db.setMeta") return null;
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: /open dashboard/i }));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "db.setMeta",
        expect.objectContaining({ key: "onboarding_completed" }),
      ),
    );
  });
});
