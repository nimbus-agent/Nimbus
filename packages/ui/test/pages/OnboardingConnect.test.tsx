import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import { callMock } from "../../src/ipc/__mocks__/client";
import { Connect } from "../../src/pages/onboarding/Connect";
import { useNimbusStore } from "../../src/store";

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/onboarding/connect"]}>
      <Routes>
        <Route path="/onboarding/connect" element={<Connect />} />
        <Route path="/onboarding/syncing" element={<div>syncing</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Onboarding → Connect", () => {
  beforeEach(() => {
    callMock.mockReset();
    useNimbusStore.getState().resetOnboarding();
  });

  it("renders the 6 connector cards", () => {
    renderAt();
    for (const name of ["Google Drive", "GitHub", "Slack", "Linear", "Notion", "Gmail"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("clicking a card toggles its selection in the store", () => {
    renderAt();
    fireEvent.click(screen.getByText("GitHub"));
    expect(useNimbusStore.getState().selected.has("GitHub")).toBe(true);
    fireEvent.click(screen.getByText("GitHub"));
    expect(useNimbusStore.getState().selected.has("GitHub")).toBe(false);
  });

  it("Authenticate dispatches connector.startAuth for each selected", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "connector.startAuth") return null;
      if (method === "connector.list") return [{ name: "GitHub", state: "healthy" }];
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByRole("button", { name: /authenticate/i }));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("connector.startAuth", { service: "GitHub" }),
    );
  });

  it("shows Authenticating… immediately after clicking Authenticate", async () => {
    let resolveAuth!: () => void;
    callMock.mockImplementation(async (method) => {
      if (method === "connector.startAuth")
        return new Promise<null>((r) => {
          resolveAuth = () => r(null);
        });
      if (method === "connector.list") return [];
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByRole("button", { name: /authenticate/i }));
    expect(await screen.findByText("Authenticating…")).toBeTruthy();
    resolveAuth();
  });

  it("shows Failed — retry when connector.startAuth throws", async () => {
    callMock.mockImplementation(async (method) => {
      if (method === "connector.startAuth") throw new Error("auth error");
      if (method === "connector.list") return [];
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByRole("button", { name: /authenticate/i }));
    expect(await screen.findByText("Failed — retry")).toBeTruthy();
  });

  it("navigates to /onboarding/syncing when a connector becomes connected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    callMock.mockImplementation(async (method) => {
      if (method === "connector.startAuth") return null;
      if (method === "connector.list") return [{ name: "GitHub", state: "healthy" }];
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    fireEvent.click(screen.getByText("GitHub"));
    fireEvent.click(screen.getByRole("button", { name: /authenticate/i }));
    // advanceTimersByTimeAsync flushes the pending startAuth microtasks first (so onAuth reaches
    // the setInterval poll registration) and then fires the poll — plain advanceTimersByTime would
    // run before the interval is even registered, and the navigation would never trigger.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(await screen.findByText("syncing")).toBeTruthy();
    vi.useRealTimers();
  });
});
