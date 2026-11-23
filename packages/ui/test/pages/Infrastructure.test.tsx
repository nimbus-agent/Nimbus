import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Infrastructure } from "../../src/pages/Infrastructure";

interface Q {
  data: unknown;
  error: string | null;
}

const h = vi.hoisted(() => ({
  answer: { data: null, error: null } as { data: unknown; error: string | null },
  calls: [] as Array<{ method: string; params: unknown }>,
}));

vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: (method: string, _i: number, params?: Record<string, unknown>) => {
    h.calls.push({ method, params });
    const q: Q = h.answer;
    return { data: q.data, error: q.error, isLoading: false, refetch: vi.fn() };
  },
}));
vi.mock("../../src/store", () => ({
  useNimbusStore: (sel: (s: unknown) => unknown) => sel({ aggregateHealth: "healthy" }),
}));

const HOSTILE = `<img src=x onerror=alert(1)> dir${String.fromCharCode(0x202e)}x`;

function finding(over: Record<string, unknown>) {
  return {
    workdir: "/srv/tf/a",
    checkedAt: 1_700_000_000_000,
    startedBy: "owner_cli",
    status: "clean",
    driftCount: 0,
    plannedChanges: 0,
    lines: [],
    ...over,
  };
}

beforeEach(() => {
  h.answer = { data: null, error: null };
  h.calls.length = 0;
});

describe("Infrastructure page", () => {
  it("asks iac.driftLatest and nothing else", () => {
    render(<Infrastructure />);
    expect(h.calls.map((c) => c.method)).toEqual(["iac.driftLatest"]);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows the CLI fallback on an error and the empty state", () => {
    h.answer = { data: null, error: "boom" };
    const a = render(<Infrastructure />);
    expect(screen.getByRole("alert").textContent).toContain("nimbus iac drift --latest");
    a.unmount();
    h.answer = { data: { findings: [] }, error: null };
    render(<Infrastructure />);
    expect(screen.getByText(/No drift check has run yet/)).toBeInTheDocument();
  });

  it("renders each status and the drift lines as plain text", () => {
    h.answer = {
      error: null,
      data: {
        findings: [
          finding({
            workdir: HOSTILE,
            status: "drift",
            driftCount: 2,
            plannedChanges: 3,
            lines: ["aws_s3_bucket.a: tags", "aws_instance.b: deleted"],
          }),
          finding({ workdir: "/b", status: "clean" }),
          finding({ workdir: "/c", status: "failed", reason: "drift: unreadable" }),
          finding({ workdir: "/d", status: "busy", reason: "busy", startedBy: "schedule" }),
        ],
      },
    };
    const { container } = render(<Infrastructure />);
    expect(screen.getByText(/Drift: 2 object\(s\) changed outside Terraform/)).toBeInTheDocument();
    expect(screen.getByText(/An apply would make 3 change/)).toBeInTheDocument();
    expect(screen.getByText("aws_s3_bucket.a: tags")).toBeInTheDocument();
    expect(screen.getByText(/Clean: no drift found/)).toBeInTheDocument();
    expect(screen.getByText("drift: unreadable")).toBeInTheDocument();
    expect(screen.getByText(/Busy: another run held this directory/)).toBeInTheDocument();
    expect(screen.getByText(/scheduled/)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("\\u{202E}");
  });

  it("ignores a malformed finding", () => {
    h.answer = { error: null, data: { findings: [{ workdir: 1 }, finding({ workdir: "/ok" })] } };
    render(<Infrastructure />);
    expect(screen.getByText("/ok")).toBeInTheDocument();
  });
});
