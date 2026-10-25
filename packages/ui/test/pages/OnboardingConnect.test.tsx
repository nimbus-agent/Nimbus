import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ipc/client");

import { callMock } from "../../src/ipc/__mocks__/client";
import { Connect } from "../../src/pages/onboarding/Connect";
import { useNimbusStore } from "../../src/store";

// Shaped like the gateway's `catalog.list` (role packs P5): builtin rows carry `displayName`,
// `description` and `signIn`; `suggestedConnectors` is the active packs' list.
const CATALOG = {
  agents: [],
  connectors: [
    {
      kind: "builtin",
      id: "slack",
      displayName: "Slack",
      description: "Channels",
      signIn: "browser",
    },
    {
      kind: "builtin",
      id: "jira",
      displayName: "Jira",
      description: "Issues",
      signIn: "atlassian",
    },
    {
      kind: "builtin",
      id: "notion",
      displayName: "Notion",
      description: "Pages",
      signIn: "browser",
    },
    {
      kind: "builtin",
      id: "github",
      displayName: "GitHub",
      description: "Repos",
      signIn: "terminal",
    },
  ],
  suggestedConnectors: ["slack", "jira", "notion", "github"],
  visibility: { basis: "packs", packs: ["pm"], notes: [] },
};
const PACKS = {
  profile: "default",
  installed: [
    {
      id: "pm",
      name: "Product",
      version: "1.0.0",
      source: "bundled",
      updateAvailable: false,
      visibleAgents: ["decisions", "glossary"],
    },
  ],
  available: [],
  skipped: [],
};

type Statuses = { serviceId: string; healthState?: unknown }[];

function gateway(
  over: { statuses?: () => Statuses; auth?: (p: unknown) => Promise<unknown> } = {},
) {
  callMock.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "catalog.list") return CATALOG;
    if (method === "pack.list") return PACKS;
    if (method === "connector.listStatus") return over.statuses?.() ?? [];
    if (method === "connector.auth") return (over.auth ?? (async () => null))(params);
    throw new Error(`unexpected ${method}`);
  });
}

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/onboarding/connect"]}>
      <Routes>
        <Route path="/onboarding/connect" element={<Connect />} />
        <Route path="/onboarding/syncing" element={<div>syncing</div>} />
        <Route path="/onboarding/decisions" element={<div>decisions step</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const authCalls = () => callMock.mock.calls.filter(([m]) => m === "connector.auth");

describe("Onboarding → Connect", () => {
  beforeEach(() => {
    callMock.mockReset();
    useNimbusStore.getState().resetOnboarding();
  });

  it("renders the suggested connectors in the catalog's order", async () => {
    gateway();
    renderAt();
    expect(await screen.findByText("Slack")).toBeTruthy();
    const names = ["Slack", "Jira", "Notion", "GitHub"].map((n) => screen.getByText(n));
    for (let i = 1; i < names.length; i++) {
      const prev = names[i - 1] as HTMLElement;
      const cur = names[i] as HTMLElement;
      expect(prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("an older gateway with no suggestions gets today's six, by id", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "catalog.list") return { agents: [], connectors: [] };
      if (method === "pack.list") return null;
      if (method === "connector.listStatus") return [];
      throw new Error(`unexpected ${method}`);
    });
    renderAt();
    expect(await screen.findByText("google_drive")).toBeTruthy();
    expect(screen.getByText("linear")).toBeTruthy();
  });

  it("browser sign-in sends the connector ID, never its display name", async () => {
    gateway();
    renderAt();
    fireEvent.click(await screen.findByText("Slack"));
    expect(useNimbusStore.getState().selected.has("slack")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /sign in \(1\)/i }));
    await waitFor(() => expect(authCalls()).toEqual([["connector.auth", { service: "slack" }]]));
  });

  it("runs one browser sign-in at a time, never two concurrently", async () => {
    const pending: Array<() => void> = [];
    gateway({
      auth: () =>
        new Promise((resolve) => {
          pending.push(() => resolve(null));
        }),
    });
    renderAt();
    fireEvent.click(await screen.findByText("Slack"));
    fireEvent.click(screen.getByText("Notion"));
    fireEvent.click(screen.getByRole("button", { name: /sign in \(2\)/i }));
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(authCalls()).toHaveLength(1);
    await act(async () => {
      pending[0]?.();
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]?.();
    });
  });

  it("a failed sign-in shows Failed — retry and the reason", async () => {
    gateway({
      auth: async () => {
        throw new Error("ERR_OAUTH: Missing OAuth client id for slack");
      },
    });
    renderAt();
    fireEvent.click(await screen.findByText("Slack"));
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByText("Failed — retry")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Slack: Missing OAuth client id for slack");
  });

  it("the Jira form sends email, token and site once, then clears the token", async () => {
    gateway();
    renderAt();
    const email = (await screen.findByLabelText("Jira email")) as HTMLInputElement;
    const token = screen.getByLabelText("Jira API token") as HTMLInputElement;
    const site = screen.getByLabelText("Jira site URL") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(email, { target: { value: " pm@example.com " } });
    fireEvent.change(token, { target: { value: "tok-123" } });
    fireEvent.change(site, { target: { value: "https://acme.atlassian.net" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Jira" }));
    await waitFor(() =>
      expect(authCalls()).toEqual([
        [
          "connector.auth",
          {
            service: "jira",
            atlassianEmail: "pm@example.com",
            apiToken: "tok-123",
            apiBaseUrl: "https://acme.atlassian.net",
          },
        ],
      ]),
    );
    await waitFor(() => expect(token.value).toBe(""));
  });

  it("the Jira form clears the token even when the gateway refuses it", async () => {
    gateway({
      auth: async () => {
        throw new Error("ERR_X: bad token");
      },
    });
    renderAt();
    const token = (await screen.findByLabelText("Jira API token")) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Jira email"), { target: { value: "a@b.c" } });
    fireEvent.change(token, { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText("Jira site URL"), { target: { value: "https://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Jira" }));
    expect(await screen.findByText("bad token")).toBeTruthy();
    expect(token.value).toBe("");
  });

  it("a terminal connector shows its command and no sign-in button", async () => {
    gateway();
    renderAt();
    expect(await screen.findByText("nimbus connector auth github")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /GitHub/ })).toBeNull();
  });

  it("connecting does not navigate on its own; Continue goes to Decisions for a pack showing decisions", async () => {
    useNimbusStore.getState().setChosenPack("pm");
    gateway({ statuses: () => [{ serviceId: "slack", healthState: "healthy" }] });
    renderAt();
    const cont = await screen.findByRole("button", { name: /continue/i });
    await waitFor(() => expect((cont as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("decisions step")).toBeNull();
    fireEvent.click(cont);
    expect(await screen.findByText("decisions step")).toBeTruthy();
  });

  it("with no pack chosen, Skip for now goes to Syncing", async () => {
    gateway();
    renderAt();
    fireEvent.click(await screen.findByRole("button", { name: /skip for now/i }));
    expect(await screen.findByText("syncing")).toBeTruthy();
  });

  it("Continue stays disabled until a suggested connector is connected (a non-string health is not)", async () => {
    gateway({ statuses: () => [{ serviceId: "slack", healthState: 42 }] });
    renderAt();
    const cont = (await screen.findByRole("button", { name: /continue/i })) as HTMLButtonElement;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(cont.disabled).toBe(true);
  });
});
