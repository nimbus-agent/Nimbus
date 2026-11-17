import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Incidents } from "../../src/pages/Incidents";

interface Q {
  data: unknown;
  error: string | null;
}

const h = vi.hoisted(() => ({
  answers: new Map<string, Q>(),
  calls: [] as Array<{ method: string; params: unknown }>,
}));

vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: (method: string, _i: number, params?: Record<string, unknown>) => {
    h.calls.push({ method, params });
    const q = h.answers.get(method) ?? { data: null, error: null };
    return { data: q.data, error: q.error, isLoading: false, refetch: vi.fn() };
  },
}));
vi.mock("../../src/store", () => ({
  useNimbusStore: (sel: (s: unknown) => unknown) => sel({ aggregateHealth: "healthy" }),
}));

const HOSTILE = `<img src=x onerror=alert(1)> pay${String.fromCharCode(0x202e)}load${String.fromCharCode(0x200b)}`;

function summary(id: string, title: string) {
  return {
    id,
    triggerItemId: `pagerduty:${id}`,
    triggerService: "pagerduty",
    service: "payments",
    title,
    severity: "P1",
    status: "open",
    openedAtMs: Date.now() - 5 * 60_000,
    version: 2,
    assembledAtMs: 1,
    checkedAtMs: 1,
  };
}

function renderPage(url = "/incidents") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Incidents />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.answers.clear();
  h.calls.length = 0;
});

describe("Incidents page", () => {
  it("asks incident.list for open records with the cascade", () => {
    renderPage();
    expect(h.calls[0]).toEqual({
      method: "incident.list",
      params: { open: true, cascade: true, limit: 50 },
    });
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders no_data, none and an error with the CLI fallback", () => {
    h.answers.set("incident.list", {
      data: { status: "no_data", records: [], sources: [] },
      error: null,
    });
    const a = renderPage();
    expect(screen.getByText(/No incident source is connected/)).toBeInTheDocument();
    a.unmount();
    h.answers.set("incident.list", {
      data: { status: "none", records: [], sources: [] },
      error: null,
    });
    const b = renderPage();
    expect(screen.getByText("No incident records.")).toBeInTheDocument();
    b.unmount();
    h.answers.set("incident.list", { data: null, error: "ERR_INCIDENT_FORBIDDEN_CLIENT: no" });
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("nimbus incident list");
  });

  it("shows hostile provider text as text: no element is created, invisible characters are visible", () => {
    h.answers.set("incident.list", {
      data: { status: "ok", records: [summary("r1", HOSTILE)], sources: [], groups: [] },
      error: null,
    });
    const { container } = renderPage();
    const list = screen.getByRole("list", { name: "Incidents" });
    expect(list).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(list).toHaveTextContent(String.raw`pay\u{202E}load\u{200B}`);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("selecting a row asks incident.get and incident.timeline for that id, and nothing else", async () => {
    h.answers.set("incident.list", {
      data: {
        status: "ok",
        records: [summary("r1", "DB down")],
        sources: [],
        groups: [{ root: "r1", members: [] }],
      },
      error: null,
    });
    h.answers.set("incident.get", {
      data: {
        record: {
          summary: summary("r1", HOSTILE),
          markdown: `# Brief\n\n${HOSTILE}\n\n![x](http://evil/x.png) [l](http://evil)`,
          versions: [{ version: 1, assembledAtMs: 1, sha256: "a" }],
          triggerStillIndexed: false,
          cascade: {
            status: "ok",
            role: "root",
            rootRecordId: "r1",
            truncated: true,
            markdown: "casc",
          },
        },
      },
      error: null,
    });
    h.answers.set("incident.timeline", {
      data: {
        recordId: "r1",
        version: 2,
        currentVersion: 2,
        events: [
          {
            atMs: 0,
            atBasis: "observed",
            kind: "opened",
            source: "pagerduty",
            itemId: null,
            text: HOSTILE,
            rule: "concurrent_30m",
          },
        ],
        notes: ["history begins late", HOSTILE],
      },
      error: null,
    });
    const { container } = renderPage();
    expect(screen.getByText(/1 cascade group/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /DB down/ }));
    const get = h.calls.filter((c) => c.method === "incident.get").at(-1);
    expect(get?.params).toEqual({ id: "r1" });
    expect(h.calls.filter((c) => c.method === "incident.timeline").at(-1)?.params).toEqual({
      id: "r1",
    });
    const art = screen.getByRole("article", { name: "Incident" });
    expect(within(art).getByRole("heading", { level: 2 })).toHaveTextContent(
      String.raw`pay\u{202E}load`,
    );
    expect(art).toHaveTextContent("no longer indexed");
    expect(screen.getByText(/membership can be incomplete/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Timeline" })).toHaveTextContent(
      "1970-01-01T00:00:00Z (observed)",
    );
    expect(screen.getByText("history begins late")).toBeInTheDocument();
    // the hostile event text and note are escaped to visible escape sequences, never rendered raw
    const tlText = screen.getByRole("region", { name: "Timeline" }).textContent ?? "";
    expect(tlText.split("\\u{202E}")).toHaveLength(3);
    expect(tlText).not.toContain(String.fromCharCode(0x202e));
    expect(tlText).not.toContain(String.fromCharCode(0x200b));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    const methods = new Set(h.calls.map((c) => c.method));
    expect([...methods].sort()).toEqual(["incident.get", "incident.list", "incident.timeline"]);
  });

  it("asks the owner to pick a row when none is selected, and reads no detail", () => {
    h.answers.set("incident.list", {
      data: { status: "ok", records: [summary("r1", "x")], sources: [], groups: [] },
      error: null,
    });
    renderPage();
    expect(screen.getByText(/Select an incident/)).toBeInTheDocument();
    expect(h.calls.map((c) => c.method)).toEqual(["incident.list"]);
  });

  it("reports an unavailable cascade, a gone record and a failed detail", () => {
    h.answers.set("incident.list", {
      data: { status: "ok", records: [summary("r1", "x")], sources: [], groups: null },
      error: null,
    });
    h.answers.set("incident.get", {
      data: {
        record: {
          summary: summary("r1", "x"),
          markdown: "m",
          versions: [],
          triggerStillIndexed: true,
          cascade: { status: "unavailable" },
        },
      },
      error: null,
    });
    h.answers.set("incident.timeline", { data: null, error: "boom" });
    renderPage("/incidents?id=r1");
    expect(screen.getAllByText("The cascade could not be read right now.")).toHaveLength(2);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the timeline: boom");
  });

  it("a record that is gone reads as not stored; a failed detail shows the CLI command", () => {
    h.answers.set("incident.list", {
      data: { status: "ok", records: [summary("r1", "x")], sources: [] },
      error: null,
    });
    h.answers.set("incident.get", { data: { record: null, reason: "no_item" }, error: null });
    const a = renderPage("/incidents?id=r1");
    expect(
      screen.getByText(/No record is stored for this incident \(no_item\)/),
    ).toBeInTheDocument();
    a.unmount();
    h.answers.set("incident.get", { data: null, error: "nope" });
    renderPage("/incidents?id=r1");
    expect(screen.getByRole("alert")).toHaveTextContent("nimbus incident show r1");
  });
});
