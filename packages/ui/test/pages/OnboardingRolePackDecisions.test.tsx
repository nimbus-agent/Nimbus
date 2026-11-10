import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import { callMock } from "../../src/ipc/__mocks__/client";
import { Decisions } from "../../src/pages/onboarding/Decisions";
import { Pack } from "../../src/pages/onboarding/Pack";
import { Role } from "../../src/pages/onboarding/Role";
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
      suggestedConnectors: ["slack", "jira"],
      visibleAgents: ["decisions"],
    },
  ],
  skipped: [],
};
const CATALOG = {
  agents: [{ name: "decisions", displayName: "Decisions" }],
  connectors: [
    { kind: "builtin", id: "slack", displayName: "Slack", signIn: "browser" },
    { kind: "builtin", id: "jira", displayName: "Jira", signIn: "atlassian" },
  ],
  suggestedConnectors: ["slack", "jira"],
};

function routes(start: string) {
  return render(
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/onboarding/role" element={<Role />} />
        <Route path="/onboarding/pack" element={<Pack />} />
        <Route path="/onboarding/decisions" element={<Decisions />} />
        <Route path="/onboarding/connect" element={<div>connect step</div>} />
        <Route path="/onboarding/welcome" element={<div>welcome step</div>} />
        <Route path="/briefs/decisions" element={<div>decisions brief</div>} />
        <Route path="/settings/connectors" element={<div>connectors settings</div>} />
        <Route path="/" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  useNimbusStore.getState().resetOnboarding();
});

describe("Onboarding → Role", () => {
  beforeEach(() => {
    callMock.mockImplementation(async (m: string) => {
      if (m === "pack.list") return PACKS;
      throw new Error(`unexpected ${m}`);
    });
  });

  it("asks what you do: the pack, then the three fixed answers", async () => {
    routes("/onboarding/role");
    expect(await screen.findByText("Product")).toBeTruthy();
    for (const l of ["Engineering", "Design", "Something else"])
      expect(screen.getByText(l)).toBeTruthy();
  });

  it("a pack not installed goes to the Pack step and is remembered", async () => {
    routes("/onboarding/role");
    fireEvent.click(await screen.findByText("Product"));
    expect(useNimbusStore.getState().chosenPackId).toBe("pm");
    expect(await screen.findByText(/Set up Nimbus for Product/)).toBeTruthy();
  });

  it("Engineering goes straight to Connect with no pack", async () => {
    routes("/onboarding/role");
    fireEvent.click(await screen.findByText("Engineering"));
    expect(await screen.findByText("connect step")).toBeTruthy();
    expect(useNimbusStore.getState().chosenPackId).toBeNull();
  });

  it("a failed pack.list still offers the fixed answers", async () => {
    callMock.mockRejectedValue(new Error("down"));
    routes("/onboarding/role");
    expect(await screen.findByText("Something else")).toBeTruthy();
  });
});

describe("Onboarding → Pack", () => {
  beforeEach(() => useNimbusStore.getState().setChosenPack("pm"));

  it("summarises the pack in plain words and installs it by id only", async () => {
    callMock.mockImplementation(async (m: string, p?: unknown) => {
      if (m === "pack.list") return PACKS;
      if (m === "catalog.list") return CATALOG;
      if (m === "pack.install") {
        expect(p).toEqual({ id: "pm" });
        return { outcome: "installed" };
      }
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/pack");
    expect(await screen.findByText("Suggests: Slack, Jira")).toBeTruthy();
    expect(screen.getByText("Shows: Decisions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /continue →/i }));
    expect(await screen.findByText("connect step")).toBeTruthy();
  });

  it("a denied approval says so plainly and offers to continue without the pack", async () => {
    callMock.mockImplementation(async (m: string) => {
      if (m === "pack.list") return PACKS;
      if (m === "catalog.list") return CATALOG;
      if (m === "pack.install")
        throw new Error("ERR_PACK_INSTALL_NOT_APPROVED: the owner did not approve");
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/pack");
    fireEvent.click(await screen.findByRole("button", { name: /continue →/i }));
    expect((await screen.findByRole("alert")).textContent).toBe("the owner did not approve");
    fireEvent.click(screen.getByRole("button", { name: /continue without the pack/i }));
    expect(await screen.findByText("connect step")).toBeTruthy();
    expect(useNimbusStore.getState().chosenPackId).toBeNull();
  });

  it("shows that it is waiting while the approval popup is open", async () => {
    let release: () => void = () => undefined;
    callMock.mockImplementation(async (m: string) => {
      if (m === "pack.list") return PACKS;
      if (m === "catalog.list") return CATALOG;
      if (m === "pack.install") return new Promise((r) => (release = () => r(null)));
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/pack");
    fireEvent.click(await screen.findByRole("button", { name: /continue →/i }));
    expect(await screen.findByText("Waiting for your approval…")).toBeTruthy();
    await act(async () => release());
  });
});

describe("Onboarding → Decisions", () => {
  const base = {
    enabled: true,
    state: "idle",
    lastPassAt: 1,
    minConfidence: 0.3,
    windowDays: 90,
    sources: [{ service: "slack", type: "message", kind: "message", items: 40 }],
    candidates: { pending: 0, extracted: 0, vetoed: 0 },
    shown: 0,
    recent: [],
  };
  const synced = [
    { serviceId: "slack", healthState: "healthy", status: "ok", itemCount: 40, lastSyncAt: 9 },
  ];

  function gateway(status: unknown) {
    callMock.mockImplementation(async (m: string) => {
      if (m === "catalog.list") return CATALOG;
      if (m === "decisions.status") return status;
      if (m === "connector.listStatus") return synced;
      if (m === "db.setMeta") return null;
      throw new Error(`unexpected ${m}`);
    });
  }

  it("shows decisions as they are found and opens the brief", async () => {
    gateway({
      ...base,
      shown: 2,
      recent: [{ statement: "We decided to ship v2", service: "slack", at: 1 }],
    });
    routes("/onboarding/decisions");
    expect(await screen.findByText("We decided to ship v2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Decisions" }));
    expect(await screen.findByText("decisions brief")).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith(
      "db.setMeta",
      expect.objectContaining({ key: "onboarding_completed" }),
    );
  });

  it("none found: what was read, why, and the next steps", async () => {
    gateway(base);
    routes("/onboarding/decisions");
    expect(
      await screen.findByText("We read 40 messages from Slack and found no clear decisions."),
    ).toBeTruthy();
    expect(
      screen.getByText("None of it used decision language like 'we decided' or 'Decision:'."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a channel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Notion or Google Drive" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Widen the window" }));
    expect(await screen.findByText("decisions brief")).toBeTruthy();
  });

  it("a disabled pass is stated, not spun", async () => {
    gateway({ ...base, enabled: false, state: "disabled" });
    routes("/onboarding/decisions");
    expect(
      await screen.findByText(
        "The decisions pass is turned off in your config ([decisions] enabled).",
      ),
    ).toBeTruthy();
  });

  it("keeps only well-formed, connected suggested connectors and fills in defaults", async () => {
    callMock.mockImplementation(async (m: string) => {
      if (m === "catalog.list") return CATALOG;
      if (m === "decisions.status") return base;
      if (m === "connector.listStatus") {
        return [
          null,
          { serviceId: 5, healthState: "healthy" },
          { serviceId: "github", healthState: "healthy" },
          { serviceId: "jira", healthState: "unauthenticated" },
          { serviceId: "jira", healthState: 3 },
          {
            serviceId: "slack",
            healthState: "healthy",
            status: 7,
            itemCount: "many",
            lastSyncAt: "x",
          },
        ];
      }
      if (m === "db.setMeta") return null;
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/decisions");
    expect(await screen.findByText("Slack: 0 items")).toBeTruthy();
    expect(screen.queryByText(/Jira/)).toBeNull();
    expect(screen.queryByText(/github/)).toBeNull();
  });

  it("shows every connected connector by id when the catalog cannot be read", async () => {
    callMock.mockImplementation(async (m: string) => {
      if (m === "catalog.list") throw new Error("catalog down");
      if (m === "decisions.status") return base;
      if (m === "connector.listStatus") {
        return [{ serviceId: "mystery", healthState: "healthy", status: "syncing", itemCount: 1 }];
      }
      if (m === "db.setMeta") return null;
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/decisions");
    expect(await screen.findByText("Syncing mystery… 1 item")).toBeTruthy();
  });

  it("an unreadable connector list does not break the step", async () => {
    callMock.mockImplementation(async (m: string) => {
      if (m === "catalog.list") return CATALOG;
      if (m === "decisions.status") return base;
      if (m === "connector.listStatus") return { not: "an array" };
      if (m === "db.setMeta") return null;
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/decisions");
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("connector.listStatus", {}));
    expect(screen.queryByText(/Syncing/)).toBeNull();
    expect(screen.getByRole("button", { name: "Open dashboard →" })).toBeTruthy();
  });

  it("keeps the last answer when a poll fails", async () => {
    callMock.mockImplementation(async (m: string) => {
      if (m === "catalog.list") return CATALOG;
      if (m === "decisions.status") throw new Error("gateway restarting");
      if (m === "connector.listStatus") return synced;
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/decisions");
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("decisions.status", {}));
    expect(screen.getByRole("button", { name: "Open dashboard →" })).toBeTruthy();
  });

  it("ignores an answer that arrives after the step was left", async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise<unknown>((r) => {
      release = r;
    });
    callMock.mockImplementation(async (m: string) => {
      if (m === "catalog.list") return CATALOG;
      if (m === "decisions.status") return slow;
      if (m === "connector.listStatus") return synced;
      if (m === "db.setMeta") return null;
      throw new Error(`unexpected ${m}`);
    });
    const r = routes("/onboarding/decisions");
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("decisions.status", {}));
    r.unmount();
    release(base);
    await act(async () => {
      await slow;
    });
    // Leaving the step completed onboarding exactly once.
    expect(callMock.mock.calls.filter(([m]) => m === "db.setMeta")).toHaveLength(1);
  });

  it("hiding the window completes onboarding once", async () => {
    gateway(base);
    routes("/onboarding/decisions");
    await screen.findByText("We read 40 messages from Slack and found no clear decisions.");
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

  it("still leaves the step when recording completion fails, and records it only once", async () => {
    callMock.mockImplementation(async (m: string) => {
      if (m === "catalog.list") return CATALOG;
      if (m === "decisions.status") return base;
      if (m === "connector.listStatus") return synced;
      if (m === "db.setMeta") throw new Error("db busy");
      throw new Error(`unexpected ${m}`);
    });
    routes("/onboarding/decisions");
    fireEvent.click(await screen.findByRole("button", { name: "Open dashboard →" }));
    expect(await screen.findByText("dashboard")).toBeTruthy();
    expect(callMock.mock.calls.filter(([m]) => m === "db.setMeta")).toHaveLength(1);
  });

  it("Connect Notion or Google Drive goes back to the connect step", async () => {
    gateway(base);
    routes("/onboarding/decisions");
    fireEvent.click(await screen.findByRole("button", { name: "Connect Notion or Google Drive" }));
    expect(await screen.findByText("connect step")).toBeTruthy();
  });

  it("Add a channel leaves for the connectors settings", async () => {
    gateway(base);
    routes("/onboarding/decisions");
    fireEvent.click(await screen.findByRole("button", { name: "Add a channel" }));
    expect(await screen.findByText("connectors settings")).toBeTruthy();
  });

  it("stops polling when it unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      gateway(base);
      const r = routes("/onboarding/decisions");
      await waitFor(() => expect(callMock).toHaveBeenCalledWith("decisions.status", {}));
      r.unmount();
      const before = callMock.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(callMock.mock.calls).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
