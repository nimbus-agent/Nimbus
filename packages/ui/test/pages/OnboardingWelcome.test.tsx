import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callMock = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
vi.mock("../../src/ipc/client", () => ({
  createIpcClient: () => ({
    call: callMock,
    subscribe: async () => () => {},
    onConnectionState: async () => () => {},
  }),
}));

import { Onboarding } from "../../src/pages/Onboarding";
import { Welcome } from "../../src/pages/onboarding/Welcome";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />}>
          <Route path="welcome" element={<Welcome />} />
        </Route>
        <Route path="/" element={<div>dashboard</div>} />
        <Route path="/onboarding/connect" element={<div>connect</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Onboarding → Welcome", () => {
  beforeEach(() => callMock.mockReset());

  it("renders the welcome copy and continue button", () => {
    renderAt("/onboarding/welcome");
    expect(screen.getByText(/Welcome to Nimbus/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue/i })).toBeTruthy();
  });

  it("Skip writes onboarding_completed meta and navigates home", async () => {
    callMock.mockResolvedValueOnce(null);
    renderAt("/onboarding/welcome");
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        "db.setMeta",
        expect.objectContaining({ key: "onboarding_completed" }),
      ),
    );
  });
});
