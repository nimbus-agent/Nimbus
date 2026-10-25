import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const q = vi.hoisted(() => ({
  calls: [] as { method: string; params: unknown; enabled: boolean | undefined }[],
  result: { data: null, error: null, isLoading: false } as {
    data: unknown;
    error: string | null;
    isLoading: boolean;
  },
}));
vi.mock("../../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: (method: string, _i: number, params: unknown, opts?: { enabled?: boolean }) => {
    q.calls.push({ method, params, enabled: opts?.enabled });
    return { ...q.result, refetch: () => undefined };
  },
}));

import { AgentCard, previewLines } from "../../../src/components/home/AgentCard";
import { OncallBriefsContext, type OncallBriefsState } from "../../../src/hooks/useOncallBriefs";
import type { CatalogAgent, PushedBriefList } from "../../../src/ipc/types";

function agent(name: string, required = false): CatalogAgent {
  return {
    name,
    method: `agents.${name}`,
    displayName: name === "oncall" ? "On-call" : name,
    description: "",
    category: "knowledge",
    roles: [],
    params: required ? [{ name: "target", type: "string", required: true } as never] : [],
    surfaces: { external: false, fleet: true },
    visible: true,
  };
}

function oncall(briefs: unknown[]): OncallBriefsState {
  return {
    list: { enabled: true, identity: "resolved", briefs } as unknown as PushedBriefList,
    error: null,
    isLoading: false,
    lastPushed: null,
    refetch: () => undefined,
  };
}

function renderCard(a: CatalogAgent, briefs: unknown[] = []) {
  return render(
    <OncallBriefsContext.Provider value={oncall(briefs)}>
      <MemoryRouter>
        <AgentCard agent={a} />
      </MemoryRouter>
    </OncallBriefsContext.Provider>,
  );
}

const fleetCalls = () => q.calls.filter((c) => c.method === "fleet.briefs" && c.enabled !== false);

beforeEach(() => {
  q.calls = [];
  q.result = { data: null, error: null, isLoading: false };
});

describe("previewLines", () => {
  it("drops a leading title line and blanks", () => {
    expect(previewLines("# Decisions\n\nA\nB", 8)).toBe("A\nB");
  });
  it("caps the line count", () => {
    expect(previewLines("1\n2\n3", 2)).toBe("1\n2");
  });
});

describe("AgentCard", () => {
  it("oncall with a pushed brief links to it and issues no fleet query", () => {
    renderCard(agent("oncall"), [
      { incidentId: "INC-1", createdAt: Date.now(), title: "DB down", service: "payments" },
    ]);
    expect(screen.getByText(/DB down/)).toBeInTheDocument();
    expect(screen.getByText(/payments/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute("href", "/oncall?id=INC-1");
    expect(fleetCalls()).toHaveLength(0);
  });

  it("oncall with none says so and offers Run", () => {
    renderCard(agent("oncall"));
    expect(screen.getByText("No stored brief yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /run/i })).toHaveAttribute("href", "/briefs/oncall");
    expect(fleetCalls()).toHaveLength(0);
  });

  it("decisions shows the newest stored brief", () => {
    q.result = {
      data: {
        briefs: [
          {
            id: "b1",
            runId: "r",
            jobId: "j",
            subjectKey: "",
            agentMethod: "agents.decisions",
            briefMarkdown: "# Decisions\n\nFirst line\nSecond",
            createdAt: Date.now(),
          },
        ],
      },
      error: null,
      isLoading: false,
    };
    renderCard(agent("decisions"));
    expect(fleetCalls()).toHaveLength(1);
    expect(fleetCalls()[0]?.params).toEqual({
      agentMethod: "agents.decisions",
      nonSweep: true,
      withMarkdown: true,
      limit: 1,
    });
    expect(screen.getByText(/First line/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute(
      "href",
      "/briefs/stored/b1",
    );
  });

  it("decisions with no row offers Run", () => {
    q.result = { data: { briefs: [] }, error: null, isLoading: false };
    renderCard(agent("decisions"));
    expect(screen.getByText("No stored brief yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /run/i })).toHaveAttribute("href", "/briefs/decisions");
  });

  it("a rejected fleet.briefs reads the same as empty, with no error text", () => {
    q.result = { data: null, error: "boom", isLoading: false };
    renderCard(agent("decisions"));
    expect(screen.getByText("No stored brief yet.")).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.getByRole("link", { name: /run/i })).toBeInTheDocument();
  });

  it("an agent with required params offers Run only and issues no query", () => {
    renderCard(agent("impact", true));
    expect(screen.getByRole("link", { name: /run/i })).toHaveAttribute("href", "/briefs/impact");
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
    expect(fleetCalls()).toHaveLength(0);
  });

  it("never calls agents.*", () => {
    renderCard(agent("decisions"));
    renderCard(agent("oncall"));
    expect(q.calls.some((c) => c.method.startsWith("agents."))).toBe(false);
  });
});
