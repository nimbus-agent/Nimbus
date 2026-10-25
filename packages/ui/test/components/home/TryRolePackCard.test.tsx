import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/ipc/client");

const rolePacks = vi.hoisted(() => ({
  value: {
    packs: null as unknown,
    catalog: null,
    catalogError: null,
    packError: null as string | null,
    sections: [],
    loaded: true,
  },
}));
vi.mock("../../../src/hooks/useRolePacks", () => ({ useRolePacks: () => rolePacks.value }));

import { TryRolePackCard } from "../../../src/components/home/TryRolePackCard";
import { callMock } from "../../../src/ipc/__mocks__/client";
import { useNimbusStore } from "../../../src/store";

const AVAILABLE = [
  { id: "pm", name: "Product", version: "1.0.0", description: "Decisions for product work." },
];

function meta(values: { dismissed?: string | null; completed?: string | null; items?: number }) {
  callMock.mockImplementation(async (m: string, p?: unknown) => {
    if (m === "db.getMeta") {
      const key = (p as { key: string }).key;
      if (key === "role_pack_card_dismissed") return values.dismissed ?? null;
      if (key === "onboarding_completed") return values.completed ?? null;
    }
    if (m === "diag.snapshot") return { indexTotalItems: values.items ?? 0 };
    if (m === "db.setMeta") return null;
    throw new Error(`unexpected ${m}`);
  });
}

function renderCard() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<TryRolePackCard />} />
        <Route path="/onboarding/pack" element={<div>pack step</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  useNimbusStore.getState().resetOnboarding();
  rolePacks.value = {
    ...rolePacks.value,
    packError: null,
    packs: { profile: "default", installed: [], available: AVAILABLE, skipped: [] },
  };
});

describe("TryRolePackCard", () => {
  it("an established install with no pack sees it once; a pack choice opens the Pack step", async () => {
    meta({ completed: "2026-01-01T00:00:00Z" });
    renderCard();
    fireEvent.click(await screen.findByText("Product"));
    expect(useNimbusStore.getState().chosenPackId).toBe("pm");
    expect(await screen.findByText("pack step")).toBeTruthy();
  });

  it("a non-empty index counts as established too", async () => {
    meta({ items: 12 });
    renderCard();
    expect(await screen.findByText("Nimbus can set itself up for your role.")).toBeTruthy();
  });

  it("never on a fresh install", async () => {
    meta({});
    renderCard();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("diag.snapshot"));
    expect(screen.queryByText("Nimbus can set itself up for your role.")).toBeNull();
  });

  it("never again once dismissed; Not now writes the key", async () => {
    meta({ completed: "x" });
    const r = renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Nimbus can set itself up for your role.")).toBeNull();
    expect(callMock).toHaveBeenCalledWith(
      "db.setMeta",
      expect.objectContaining({ key: "role_pack_card_dismissed" }),
    );
    r.unmount();
    meta({ completed: "x", dismissed: "2026-10-25T00:00:00Z" });
    renderCard();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("diag.snapshot"));
    expect(screen.queryByText("Nimbus can set itself up for your role.")).toBeNull();
  });

  it("hidden when a pack is installed or the list could not be read", async () => {
    meta({ completed: "x" });
    rolePacks.value = {
      ...rolePacks.value,
      packs: {
        profile: "default",
        installed: [
          { id: "pm", name: "Product", version: "1", source: "bundled", updateAvailable: false },
        ],
        available: [],
        skipped: [],
      },
    };
    const a = renderCard();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("diag.snapshot"));
    expect(screen.queryByText("Nimbus can set itself up for your role.")).toBeNull();
    a.unmount();
    rolePacks.value = { ...rolePacks.value, packs: null, packError: "bad json" };
    renderCard();
    await waitFor(() => expect(callMock.mock.calls.length).toBeGreaterThan(3));
    expect(screen.queryByText("Nimbus can set itself up for your role.")).toBeNull();
  });
});
