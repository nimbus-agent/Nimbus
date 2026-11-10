import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
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
    expect(await screen.findByText("dashboard")).toBeTruthy();
  });

  it("hiding the window records completion once, even when the gateway refuses", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "diag.snapshot") return { indexTotalItems: 1, connectorCount: 1 };
      if (method === "db.setMeta") throw new Error("db busy");
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    await screen.findByRole("button", { name: /open dashboard/i });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() =>
        expect(callMock.mock.calls.filter(([m]) => m === "db.setMeta")).toHaveLength(1),
      );
    } finally {
      visibility.mockRestore();
    }
  });

  it("keeps rendering when a snapshot poll fails", async () => {
    callMock.mockImplementation(async () => {
      throw new Error("gateway down");
    });
    renderAt();
    expect(await screen.findByRole("button", { name: /open dashboard/i })).toBeTruthy();
  });

  it("closing the step before opening the dashboard records completion", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "diag.snapshot") return { indexTotalItems: 0, connectorCount: 0 };
      if (method === "db.setMeta") return null;
      throw new Error(`unexpected ${method}`);
    });
    const r = renderAt();
    await screen.findByRole("button", { name: /open dashboard/i });
    r.unmount();
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "db.setMeta",
        expect.objectContaining({ key: "onboarding_completed" }),
      ),
    );
  });
});
