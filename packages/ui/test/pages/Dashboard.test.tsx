import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: () => ({ data: null, error: null, isLoading: false }),
}));
vi.mock("../../src/hooks/useIpcSubscription", () => ({
  useIpcSubscription: () => undefined,
}));

vi.mock("../../src/store", () => ({
  useNimbusStore: (
    sel: (s: {
      connectors: never[];
      highlightConnector: null;
      setConnectors: () => void;
      patchConnector: () => void;
      recomputeAggregate: () => void;
      setConnectorsMenu: () => void;
      aggregateHealth: "normal" | "amber" | "red";
    }) => unknown,
  ) =>
    sel({
      connectors: [],
      highlightConnector: null,
      setConnectors: () => undefined,
      patchConnector: () => undefined,
      recomputeAggregate: () => undefined,
      setConnectorsMenu: () => undefined,
      aggregateHealth: "normal",
    }),
}));

const rolePacks = vi.hoisted(() => ({
  loaded: true,
  sections: [] as readonly { id: string; name: string; agents: readonly unknown[] }[],
}));
vi.mock("../../src/hooks/useRolePacks", () => ({
  useRolePacks: () => ({ packs: null, catalog: null, ...rolePacks }),
}));
vi.mock("../../src/components/home/AgentCard", () => ({
  AgentCard: ({ agent }: { agent: { name: string } }) => <div>card-{agent.name}</div>,
}));

import { Dashboard } from "../../src/pages/Dashboard";

function renderDash() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe("Dashboard", () => {
  it("renders PageHeader + three panels", () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Index metrics/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Connectors/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Recent activity/i)).toBeInTheDocument();
  });

  it("shows one section per active pack above the existing panels", () => {
    rolePacks.loaded = true;
    rolePacks.sections = [
      { id: "devops", name: "DevOps", agents: [{ name: "oncall" }, { name: "why" }] },
      { id: "pm", name: "PM", agents: [{ name: "decisions" }] },
    ];
    renderDash();
    expect(screen.getByRole("heading", { name: "DevOps" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "PM" })).toBeInTheDocument();
    expect(screen.getByText("card-why")).toBeInTheDocument();
    expect(screen.getByLabelText(/Index metrics/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Connectors/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Recent activity/i)).toBeInTheDocument();
  });

  it("points at nimbus pack list when loaded with no sections", () => {
    rolePacks.loaded = true;
    rolePacks.sections = [];
    renderDash();
    expect(
      screen.getByText("Role packs tailor this screen — see nimbus pack list."),
    ).toBeInTheDocument();
  });

  it("shows neither while role packs are loading", () => {
    rolePacks.loaded = false;
    rolePacks.sections = [];
    renderDash();
    expect(screen.queryByText(/Role packs tailor/)).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "DevOps" })).toBeNull();
  });
});
