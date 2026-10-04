import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OncallBriefsState } from "../../src/hooks/useOncallBriefs";
import type { PushedBriefDetail, PushedBriefList, PushedBriefSummary } from "../../src/ipc/types";
import { Oncall } from "../../src/pages/Oncall";
import { useNimbusStore } from "../../src/store";

interface Q {
  data: unknown;
  error: string | null;
  isLoading: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  briefs: null as unknown as OncallBriefsState,
  queries: new Map<string, Q>(),
  calls: [] as string[],
  mounts: [] as string[],
  stale: false,
}));

vi.mock("../../src/hooks/useOncallBriefs", async (orig) => {
  const actual = await orig<typeof import("../../src/hooks/useOncallBriefs")>();
  return { ...actual, useOncallBriefs: () => h.briefs };
});
vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: (_m: string, _i: number, params?: Record<string, unknown>) => {
    const id = String(params?.["incidentId"]);
    h.calls.push(id);
    if (h.mounts.filter((m) => m === id).length > 5) {
      throw new Error(`useIpcQuery mock: ${id} mounted >5 times — auto-select/prune loop`);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: one entry per mount of this id
    useEffect(() => {
      h.mounts.push(id);
    }, []);
    let q = h.queries.get(id);
    if (q === undefined) {
      q = { data: null, error: null, isLoading: false, refetch: vi.fn() };
      h.queries.set(id, q);
    }
    // Like the real hook, a still-mounted instance keeps the PREVIOUS id's data until its refetch lands.
    const prev = useRef<Q | null>(null);
    const out = h.stale && prev.current !== null && prev.current !== q ? prev.current : q;
    prev.current = out === q ? q : prev.current;
    return out;
  },
}));

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "oncall-pushed.json"), "utf8"),
) as {
  list: PushedBriefList;
  getOk: { brief: PushedBriefDetail };
  getFailed: { brief: PushedBriefDetail };
  getMissing: { brief: null };
};

const OK_ID = "pagerduty:PDEMO412";
const FAIL_ID = "pagerduty:PCONTRACTFAIL";

function row(id: string, createdAt: number): PushedBriefSummary {
  return {
    incidentId: id,
    status: "ok",
    createdAt,
    retriedAt: null,
    title: `t-${id}`,
    service: null,
  };
}

function setBriefs(list: PushedBriefList | null, extra: Partial<OncallBriefsState> = {}): void {
  h.briefs = {
    list,
    error: null,
    isLoading: false,
    lastPushed: null,
    refetch: vi.fn(),
    ...extra,
  };
}

function setQuery(id: string, data: unknown): Q {
  const q: Q = { data, error: null, isLoading: false, refetch: vi.fn() };
  h.queries.set(id, q);
  return q;
}

function Probe() {
  const loc = useLocation();
  const nav = useNavigationType();
  return (
    <>
      <div data-testid="search">{loc.search}</div>
      <div data-testid="nav">{nav}</div>
    </>
  );
}

function ui(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="/oncall" element={<Oncall />} />
      </Routes>
    </MemoryRouter>
  );
}

const search = () => screen.getByTestId("search").textContent;
const enc = encodeURIComponent;
const markPushedSeen = vi.fn();

beforeEach(() => {
  h.queries.clear();
  h.calls.length = 0;
  h.mounts.length = 0;
  h.stale = false;
  markPushedSeen.mockReset();
  useNimbusStore.setState({ markPushedSeen });
  setBriefs(fixture.list);
  setQuery(OK_ID, fixture.getOk);
  setQuery(FAIL_ID, fixture.getFailed);
});

describe("Oncall page", () => {
  it("1: renders both rows; a null title/service shows the id, never null/undefined", () => {
    render(ui("/oncall"));
    const list = screen.getByRole("list", { name: "Pushed briefs" });
    expect(list.textContent).toContain("payment-service: 5xx rate above 5% on /v1/charges");
    expect(list.textContent).toContain(FAIL_ID);
    expect(list.textContent).not.toMatch(/undefined|null/);
  });

  it("2: no id selects the newest by REPLACE", async () => {
    render(ui("/oncall"));
    await waitFor(() => expect(search()).toBe("?id=pagerduty%3APCONTRACTFAIL"));
    expect(screen.getByTestId("nav").textContent).toBe("REPLACE");
  });

  it("3: the detail <pre> is the brief verbatim and the strip shows chatops", () => {
    const { container } = render(ui(`/oncall?id=${enc(OK_ID)}`));
    expect(container.querySelector("pre")?.textContent).toBe(fixture.getOk.brief.briefMarkdown);
    expect(screen.getByText(/chatops: skipped/)).toBeTruthy();
  });

  it("4: HTML in the markdown stays literal text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    setQuery(OK_ID, { brief: { ...fixture.getOk.brief, briefMarkdown: evil } });
    const { container } = render(ui(`/oncall?id=${enc(OK_ID)}`));
    expect(container.querySelector("pre")?.textContent).toBe(evil);
    expect(container.querySelector("img")).toBeNull();
  });

  it("5: a failed row shows the code and the CLI retry command, no button", () => {
    render(ui(`/oncall?id=${enc(FAIL_ID)}`));
    expect(screen.getByText(/timeout: no brief in 30000ms/)).toBeTruthy();
    expect(screen.getByText(`nimbus oncall pushed ${FAIL_ID} --retry`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("6: a pruned id is announced, cleared from the URL, and falls back to the newest", async () => {
    setQuery("pagerduty:NOPE", fixture.getMissing);
    render(ui("/oncall?id=pagerduty:NOPE"));
    expect(
      await screen.findByText("pagerduty:NOPE was pruned (older than retention_days)."),
    ).toBeTruthy();
    await waitFor(() => expect(search()).toBe("?id=pagerduty%3APCONTRACTFAIL"));
    expect(search()).not.toContain("NOPE");
    await userEvent.click(screen.getByRole("button", { name: /payment-service: 5xx/ }));
    expect(screen.queryByText(/was pruned/)).toBeNull();
  });

  it("7: push off, identity unresolved, and no rows", () => {
    setBriefs({ enabled: false, identity: "resolved", briefs: [] });
    const a = render(ui("/oncall"));
    expect(
      screen.getByText("On-call push is off. Set [oncall.push] enabled = true in nimbus.toml."),
    ).toBeTruthy();
    a.unmount();
    setBriefs({ enabled: true, identity: "unresolved", briefs: [] });
    const b = render(ui("/oncall"));
    expect(
      screen.getByText(
        "On-call push is enabled but your identity is unresolved, so no incident can be selected. Set [user] me_person_id in nimbus.toml or `git config user.email`.",
      ),
    ).toBeTruthy();
    b.unmount();
    setBriefs({ enabled: true, identity: "resolved", briefs: [] });
    render(ui("/oncall"));
    expect(screen.getByText("No pushed briefs yet.")).toBeTruthy();
  });

  it("8: an RPC error names the terminal fallback", () => {
    setBriefs(null, { error: "Method not found" });
    render(ui("/oncall"));
    expect(
      screen.getByText(
        "Could not load pushed briefs: Method not found. From a terminal: nimbus oncall pushed",
      ),
    ).toBeTruthy();
  });

  it("9: a new newest row never moves a reader off the brief they selected", () => {
    const { container, rerender } = render(ui(`/oncall?id=${enc(OK_ID)}`));
    setBriefs({
      ...fixture.list,
      briefs: [row("pagerduty:NEWEST", 1_790_000_999_000), ...fixture.list.briefs],
    });
    rerender(ui(`/oncall?id=${enc(OK_ID)}`));
    expect(search()).toBe(`?id=${enc(OK_ID)}`);
    expect(container.querySelector("pre")?.textContent).toBe(fixture.getOk.brief.briefMarkdown);
  });

  it("10: an id with reserved characters round-trips through the URL and the query", async () => {
    const odd = "pagerduty:A/B#c?d";
    setBriefs({ enabled: true, identity: "resolved", briefs: [row(odd, 5), row(OK_ID, 4)] });
    render(ui(`/oncall?id=${enc(OK_ID)}`));
    const buttons = screen.getAllByRole("button");
    const target = buttons.find((b) => b.textContent?.includes(`t-${odd}`));
    expect(target).toBeDefined();
    await userEvent.click(target as HTMLElement);
    expect(search()).toBe("?id=pagerduty%3AA%2FB%23c%3Fd");
    expect(h.calls).toContain(odd);
  });

  it("11: a live arrival marks the new newest seen", () => {
    const { rerender } = render(ui("/oncall"));
    expect(markPushedSeen).toHaveBeenCalledWith(1_790_000_060_000);
    setBriefs({
      ...fixture.list,
      briefs: [row("pagerduty:NEW", 1_790_000_900_000), ...fixture.list.briefs],
    });
    rerender(ui("/oncall"));
    expect(markPushedSeen).toHaveBeenCalledWith(1_790_000_900_000);
  });

  it("12: a pushed event for the selected id refetches its detail; another id does not", () => {
    const { rerender } = render(ui(`/oncall?id=${enc(OK_ID)}`));
    const q = h.queries.get(OK_ID) as Q;
    q.refetch.mockClear();
    setBriefs(fixture.list, { lastPushed: { incidentId: FAIL_ID, seq: 1 } });
    rerender(ui(`/oncall?id=${enc(OK_ID)}`));
    expect(q.refetch).not.toHaveBeenCalled();
    setBriefs(fixture.list, { lastPushed: { incidentId: OK_ID, seq: 2 } });
    rerender(ui(`/oncall?id=${enc(OK_ID)}`));
    expect(q.refetch).toHaveBeenCalled();
  });

  it("14: switching rows never shows the previous row's brief while the new one loads", async () => {
    h.stale = true;
    const { container } = render(ui(`/oncall?id=${enc(OK_ID)}`));
    expect(container.querySelector("pre")?.textContent).toBe(fixture.getOk.brief.briefMarkdown);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(FAIL_ID) }));
    expect(search()).toBe(`?id=${enc(FAIL_ID)}`);
    expect(container.textContent).not.toContain("# On-call");
    expect(screen.getByText(/timeout: no brief in 30000ms/)).toBeTruthy();
  });

  it("15: two pruned rows at the head of a stale list settle on the third, no loop", async () => {
    const g1 = "pagerduty:PGONE1";
    const g2 = "pagerduty:PGONE2";
    setBriefs({
      enabled: true,
      identity: "resolved",
      briefs: [
        row(g1, 1_790_000_700_000),
        row(g2, 1_790_000_600_000),
        row(OK_ID, 1_790_000_000_000),
      ],
    });
    setQuery(g1, { brief: null });
    setQuery(g2, { brief: null });
    render(ui("/oncall"));
    await waitFor(() => expect(search()).toBe(`?id=${enc(OK_ID)}`));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.mounts.filter((c) => c === g1).length).toBeLessThanOrEqual(1);
    expect(h.mounts.filter((c) => c === g2).length).toBeLessThanOrEqual(1);
    expect(search()).toBe(`?id=${enc(OK_ID)}`);
  });

  it("16: re-clicking the open row adds no history entry", async () => {
    render(ui(`/oncall?id=${enc(OK_ID)}`));
    await userEvent.click(screen.getByRole("button", { name: /payment-service: 5xx/ }));
    expect(screen.getByTestId("nav").textContent).toBe("POP");
  });

  it("13: a pruned newest row does not loop; auto-select skips it and the list refetches once", async () => {
    const gone = "pagerduty:PGONE";
    const refetch = vi.fn();
    setBriefs(
      {
        enabled: true,
        identity: "resolved",
        briefs: [row(gone, 1_790_000_500_000), row(OK_ID, 1_790_000_000_000)],
      },
      { refetch },
    );
    setQuery(gone, { brief: null });
    render(ui("/oncall"));
    expect(await screen.findByText(`${gone} was pruned (older than retention_days).`)).toBeTruthy();
    await waitFor(() => expect(search()).toBe(`?id=${enc(OK_ID)}`));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.mounts.filter((c) => c === gone)).toHaveLength(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(search()).toBe(`?id=${enc(OK_ID)}`);
  });
});
