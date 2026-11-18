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

  it("selecting a row asks incident.get, incident.timeline and incident.proposals for that id, and nothing else", async () => {
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
    expect([...methods].sort()).toEqual([
      "incident.findings",
      "incident.get",
      "incident.list",
      "incident.proposals",
      "incident.timeline",
    ]);
    expect(h.calls.filter((c) => c.method === "incident.proposals").at(-1)?.params).toEqual({
      id: "r1",
    });
  });

  it("asks the owner to pick a row when none is selected, and reads no detail", () => {
    h.answers.set("incident.list", {
      data: { status: "ok", records: [summary("r1", "x")], sources: [], groups: [] },
      error: null,
    });
    renderPage();
    expect(screen.getByText(/Select an incident/)).toBeInTheDocument();
    expect(h.calls.map((c) => c.method)).toEqual(["incident.list", "incident.findings"]);
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

  it("shows the findings, escaped, and the CLI fallback when they cannot be read", () => {
    h.answers.set("incident.list", {
      data: { status: "ok", records: [], sources: [] },
      error: null,
    });
    h.answers.set("incident.findings", {
      data: {
        findings: [
          {
            id: "f1",
            kind: "anomaly",
            key: HOSTILE,
            service: null,
            detail: { z: 4.2, metric: HOSTILE, nested: { a: 1 } },
            openedAtMs: 0,
            lastSeenAtMs: 0,
            clearedAtMs: null,
          },
        ],
      },
      error: null,
    });
    const a = renderPage();
    expect(h.calls[1]).toEqual({ method: "incident.findings", params: { limit: 50 } });
    const region = screen.getByRole("region", { name: "Findings" });
    const text = region.textContent ?? "";
    expect(text).toContain("anomaly - no service");
    expect(text).toContain("nested: (not shown)");
    expect(text).toContain("z: 4.2");
    expect(text).not.toContain(String.fromCharCode(0x202e));
    expect(text).toContain(String.raw`\u{202E}`);
    expect(a.container.querySelector("img")).toBeNull();
    a.unmount();
    h.answers.set("incident.findings", { data: { findings: [] }, error: null });
    const b = renderPage();
    expect(screen.getByText("No open findings.")).toBeInTheDocument();
    b.unmount();
    h.answers.set("incident.findings", { data: null, error: "ERR_X: no" });
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("nimbus incident findings");
  });
});

describe("Incidents page: proposals (IC10b)", () => {
  const REC = "inc_0123456789abcdef";
  const PRP = "prp_0123456789abcdef";

  function proposal(over: Record<string, unknown> = {}) {
    return {
      id: PRP,
      kind: "rollback_deploy",
      toolId: "argocd_rollback",
      input: { app: HOSTILE, id: 7 },
      evidence: {
        rule: "deploy_before_incident",
        items: ["argocd:app1"],
        blast: {
          service: "payments",
          environment: "prod",
          dependents: ["checkout"],
          dependentsTruncated: true,
        },
        confidence: {
          terms: [
            { name: "deploy within 30m", weight: 0.5, met: true },
            { name: "same service", weight: 0.3, met: false },
          ],
          total: 0.5,
        },
        dryRun: "none available",
        target: HOSTILE,
      },
      confidence: 0.5,
      reversibility: "reversible",
      irreversibleReason: null,
      status: "proposed",
      createdAtMs: 0,
      expiresAtMs: 0,
      actionId: null,
      undoStatus: null,
      undoable: false,
      ...over,
    };
  }

  function withRecord(proposals: Q) {
    h.answers.set("incident.list", {
      data: { status: "ok", records: [summary(REC, "x")], sources: [] },
      error: null,
    });
    h.answers.set("incident.get", {
      data: {
        record: {
          summary: summary(REC, "x"),
          markdown: "m",
          versions: [],
          triggerStillIndexed: true,
          cascade: null,
        },
      },
      error: null,
    });
    h.answers.set("incident.proposals", proposals);
  }

  it("shows each proposal's evidence escaped, and the exact remediate command to copy, never a run button", () => {
    withRecord({
      data: {
        recordId: REC,
        version: 2,
        advisory: false,
        proposals: [proposal()],
        unavailable: [{ kind: "flag_revert", code: "flag_no_history", reason: HOSTILE }],
      },
      error: null,
    });
    const { container } = renderPage(`/incidents?id=${REC}`);
    const region = screen.getByRole("region", { name: "Proposals" });
    const text = region.textContent ?? "";
    expect(text).toContain("rollback_deploy - argocd_rollback - proposed");
    expect(text).toContain("Blast radius: payments (prod); dependents: checkout and more");
    expect(text).toContain("met: deploy within 30m (0.5)");
    expect(text).toContain("not met: same service (0.3)");
    expect(text).toContain("Dry run: none available");
    expect(text).toContain("Not proposed (flag_revert)");
    expect(text).not.toContain(String.fromCharCode(0x202e));
    expect(text).toContain(String.raw`\u{202E}`);
    expect(
      within(region).getByText(`nimbus incident remediate ${REC} --pick ${PRP}`),
    ).toBeInTheDocument();
    const buttons = within(region).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Copy command"]);
    expect(container.querySelector("img")).toBeNull();
  });

  it("in advisory mode, or for a closed proposal, offers no command to run", () => {
    withRecord({
      data: {
        recordId: REC,
        version: 2,
        advisory: true,
        proposals: [
          proposal(),
          proposal({
            id: "prp_fedcba9876543210",
            status: "denied",
            evidence: null,
            confidence: null,
            irreversibleReason: "cannot be undone",
          }),
        ],
        unavailable: [],
      },
      error: null,
    });
    renderPage(`/incidents?id=${REC}`);
    const region = screen.getByRole("region", { name: "Proposals" });
    expect(region).toHaveTextContent("Advisory mode is on");
    expect(region).toHaveTextContent("Irreversible: cannot be undone");
    expect(region).toHaveTextContent("confidence not scored");
    expect(region).toHaveTextContent("This proposal is denied");
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
    expect(region.textContent ?? "").not.toContain("--pick");
  });

  it("reports no proposals, loading for another record, and an error with the CLI fallback", () => {
    withRecord({
      data: { recordId: REC, version: 1, advisory: false, proposals: [], unavailable: [] },
      error: null,
    });
    const a = renderPage(`/incidents?id=${REC}`);
    expect(screen.getByText("No remediation is proposed.")).toBeInTheDocument();
    a.unmount();
    withRecord({
      data: { recordId: "inc_other", version: 1, advisory: false, proposals: [], unavailable: [] },
      error: null,
    });
    const b = renderPage(`/incidents?id=${REC}`);
    expect(screen.getByText("Loading proposals...")).toBeInTheDocument();
    b.unmount();
    withRecord({ data: null, error: "ERR_REMEDIATION_UNAVAILABLE: none" });
    renderPage(`/incidents?id=${REC}`);
    expect(screen.getByRole("alert")).toHaveTextContent(
      `Could not load the proposals: ERR_REMEDIATION_UNAVAILABLE: none. From a terminal: nimbus incident remediate ${REC}`,
    );
  });
});
