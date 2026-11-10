import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import { callMock } from "../../src/ipc/__mocks__/client";
import { Pack } from "../../src/pages/onboarding/Pack";
import { useNimbusStore } from "../../src/store";

const PACKS = {
  profile: "default",
  installed: [],
  available: [
    {
      id: "pm",
      name: "Product",
      version: "1.0.0",
      description: "Decisions for product work.",
      roles: ["product"],
      suggestedConnectors: ["ext_notes", "slack", "unknown-svc"],
      visibleAgents: ["decisions", "mystery"],
    },
  ],
  skipped: [],
};

function mount() {
  return render(
    <MemoryRouter initialEntries={["/onboarding/pack"]}>
      <Routes>
        <Route path="/onboarding/pack" element={<Pack />} />
        <Route path="/onboarding/role" element={<div>role step</div>} />
        <Route path="/onboarding/connect" element={<div>connect step</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  useNimbusStore.getState().resetOnboarding();
});

describe("Onboarding → Pack: edges", () => {
  it("sends the owner back to Role when no pack was chosen", async () => {
    callMock.mockResolvedValue(null);
    mount();
    expect(await screen.findByText("role step")).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith("pack.install", expect.anything());
  });

  it("names connectors by display name, by an extension's service id, or by their raw id", async () => {
    useNimbusStore.getState().setChosenPack("pm");
    callMock.mockImplementation(async (m: string) => {
      if (m === "pack.list") return PACKS;
      if (m === "catalog.list") {
        return {
          agents: [{ name: "decisions", displayName: "Decisions" }, "junk", { id: 5 }],
          connectors: [
            { kind: "extension", id: "pkg.notes", serviceId: "ext_notes", name: "Notes" },
            { kind: "builtin", id: "slack", displayName: "Slack" },
            null,
          ],
        };
      }
      throw new Error(`unexpected ${m}`);
    });
    mount();
    expect(await screen.findByText("Suggests: Notes, Slack, unknown-svc")).toBeTruthy();
    expect(screen.getByText("Shows: Decisions, mystery")).toBeTruthy();
    expect(screen.getByText("Decisions for product work.")).toBeTruthy();
    expect(screen.getByRole("heading").textContent).toBe("Set up Nimbus for Product");
  });

  it("falls back to the pack id and prints no summary when both lists fail", async () => {
    useNimbusStore.getState().setChosenPack("pm");
    callMock.mockRejectedValue(new Error("down"));
    mount();
    expect(await screen.findByText("Set up Nimbus for pm")).toBeTruthy();
    expect(screen.queryByText(/Suggests:/)).toBeNull();
    expect(screen.queryByText(/Shows:/)).toBeNull();
  });

  it("Back returns to Role", async () => {
    useNimbusStore.getState().setChosenPack("pm");
    callMock.mockResolvedValue(null);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /back/i }));
    expect(await screen.findByText("role step")).toBeTruthy();
  });

  it("a second click while waiting does not install twice", async () => {
    useNimbusStore.getState().setChosenPack("pm");
    let release: () => void = () => undefined;
    let installs = 0;
    callMock.mockImplementation(async (m: string) => {
      if (m === "pack.list") return PACKS;
      if (m === "catalog.list") return null;
      if (m === "pack.install") {
        installs += 1;
        return new Promise((r) => {
          release = () => r(null);
        });
      }
      throw new Error(`unexpected ${m}`);
    });
    mount();
    const btn = await screen.findByRole("button", { name: /continue →/i });
    fireEvent.click(btn);
    await screen.findByText("Waiting for your approval…");
    fireEvent.click(btn);
    expect(installs).toBe(1);
    await act(async () => release());
  });
});
