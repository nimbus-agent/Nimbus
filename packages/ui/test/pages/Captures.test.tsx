import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureDetail, CaptureList, CaptureSummary } from "../../src/ipc/types";
import { Captures } from "../../src/pages/Captures";

const h = vi.hoisted(() => ({
  listData: null as unknown,
  listError: null as string | null,
  listCalls: [] as Record<string, unknown>[],
  methods: [] as string[],
  details: new Map<string, unknown>(),
  detailError: null as string | null,
  refetch: vi.fn(),
}));

vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: (method: string, _i: number, params?: Record<string, unknown>) => {
    h.methods.push(method);
    if (method === "captures.list") {
      h.listCalls.push(params ?? {});
      return { data: h.listData, error: h.listError, isLoading: false, refetch: h.refetch };
    }
    if (method === "captures.get") {
      const data = h.details.get(String(params?.["id"])) ?? null;
      return { data, error: h.detailError, isLoading: false, refetch: vi.fn() };
    }
    throw new Error(`Captures page called an unexpected method: ${method}`);
  },
}));

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "captures.json"), "utf8"),
) as { list: CaptureList; get: CaptureDetail; getRevoked: CaptureDetail };

const NOW = Date.now();

function detail(over: Partial<CaptureDetail>): CaptureDetail {
  return { ...fixture.get, ...over };
}

function asSummary(d: CaptureDetail): CaptureSummary {
  return {
    id: d.id,
    kind: d.kind,
    state: d.state,
    title: d.title,
    clientLabel: d.clientLabel,
    createdAt: d.createdAt,
    decidedAt: d.decidedAt,
    expiresAt: d.expiresAt,
  };
}

/** Puts `d` in both the list and the detail map, so `?id=<d.id>` renders it. */
function only(d: CaptureDetail): void {
  h.listData = { captures: [asSummary(d)] };
  h.details.set(d.id, d);
}

function Probe() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function ui(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="/captures" element={<Captures />} />
      </Routes>
    </MemoryRouter>,
  );
}

const commands = () => screen.queryByTestId("capture-commands")?.textContent ?? null;

beforeEach(() => {
  h.listData = fixture.list;
  h.listError = null;
  h.listCalls = [];
  h.methods = [];
  h.details = new Map<string, unknown>([
    [fixture.get.id, fixture.get],
    [fixture.getRevoked.id, fixture.getRevoked],
  ]);
  h.detailError = null;
  h.refetch = vi.fn();
});

describe("Captures page", () => {
  it("shows Loading while the list has not arrived", () => {
    h.listData = null;
    ui("/captures");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty state naming [mcp_sink]", () => {
    h.listData = { captures: [] };
    ui("/captures");
    expect(
      screen.getByText(
        "No captures. MCP clients write here when `[mcp_sink]` is enabled in nimbus.toml.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an alert pointing at the terminal when the list fails with no data", () => {
    h.listData = null;
    h.listError = "gateway down";
    ui("/captures");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("gateway down");
    expect(alert).toHaveTextContent("From a terminal: nimbus captures");
  });

  it("lists every capture, newest first, with kind, state and client label", () => {
    ui("/captures");
    const rows = within(screen.getByRole("list", { name: "Captures" })).getAllByRole("link");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("(revoked)"),
      expect.stringContaining("Use WAL"),
      expect.stringContaining("Kept"),
    ]);
    expect(rows[1]).toHaveTextContent("decision");
    expect(rows[1]).toHaveTextContent("accepted");
    expect(rows[1]).toHaveTextContent("claude-desktop");
    expect(h.listCalls.at(-1)).toEqual({ limit: 200 });
  });

  it("shows the time left on a proposed action", () => {
    only(
      detail({
        id: "cap_a",
        kind: "action",
        state: "proposed",
        expiresAt: Date.now() + 3.5 * 3_600_000,
      }),
    );
    ui("/captures");
    expect(screen.getByRole("link")).toHaveTextContent("expires in 3 h");
  });

  it("the kind tabs and the state select change the captures.list params", async () => {
    const user = userEvent.setup();
    ui("/captures");
    await user.click(screen.getByRole("button", { name: "decision" }));
    expect(h.listCalls.at(-1)).toEqual({ limit: 200, kind: "decision" });
    await user.selectOptions(screen.getByRole("combobox", { name: /State/ }), "proposed");
    expect(h.listCalls.at(-1)).toEqual({ limit: 200, kind: "decision", state: "proposed" });
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(h.listCalls.at(-1)).toEqual({ limit: 200, state: "proposed" });
    await user.selectOptions(screen.getByRole("combobox", { name: /State/ }), "");
    expect(h.listCalls.at(-1)).toEqual({ limit: 200 });
  });

  it("Refresh calls refetch", async () => {
    const user = userEvent.setup();
    ui("/captures");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("selecting a row puts its id in the URL and renders the detail", async () => {
    const user = userEvent.setup();
    ui("/captures");
    expect(screen.queryByRole("article", { name: "Capture" })).toBeNull();
    await user.click(screen.getByRole("link", { name: /Use WAL/ }));
    expect(screen.getByTestId("search").textContent).toBe("?id=cap_contract_2");
    const art = screen.getByRole("article", { name: "Capture" });
    expect(art).toHaveTextContent("owned");
    expect(art).toHaveTextContent("Payload (agent-authored text)");
    expect(within(art).getByTestId("capture-payload")).toHaveTextContent('"statement": "Use WAL"');
    expect(h.methods.every((m) => m === "captures.list" || m === "captures.get")).toBe(true);
  });

  it("a revoked capture says its payload was cleared, and offers no command", () => {
    ui("/captures?id=cap_contract_3");
    expect(screen.getByText("payload cleared")).toBeInTheDocument();
    expect(screen.queryByTestId("capture-payload")).toBeNull();
    expect(commands()).toBeNull();
    expect(
      screen.getByText("Accepting, rejecting, revoking and purging happen in a terminal."),
    ).toBeInTheDocument();
  });

  it("a proposed capture prints accept and reject", () => {
    only(detail({ id: "cap_p", state: "proposed", decidedAt: null }));
    ui("/captures?id=cap_p");
    expect(commands()).toBe("nimbus captures accept cap_p\nnimbus captures reject cap_p");
  });

  it("a live capture prints revoke", () => {
    only(detail({ id: "cap_l", kind: "note", state: "live", decidedAt: null, nativeStatus: null }));
    ui("/captures?id=cap_l");
    expect(commands()).toBe("nimbus captures revoke cap_l");
  });

  it("an executed action prints purge and shows the result URL as text", () => {
    only(
      detail({
        id: "cap_x",
        kind: "action",
        state: "executed",
        nativeStatus: null,
        outcomeRef: "https://example.test/pr/1",
        errorCode: "E_SOMETHING",
      }),
    );
    ui("/captures?id=cap_x");
    expect(commands()).toBe("nimbus captures purge cap_x");
    expect(screen.getByText("result URL")).toBeInTheDocument();
    expect(screen.getByText("https://example.test/pr/1").tagName).toBe("DD");
    expect(screen.queryByRole("link", { name: /example\.test/ })).toBeNull();
    expect(screen.getByText("E_SOMETHING")).toBeInTheDocument();
  });

  it("shows invisible and bidi characters escaped, never raw", () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    only(
      detail({
        id: "cap_i",
        title: `evil${rlo}txt`,
        clientLabel: `lab${zwsp}el`,
        payload: { statement: `a${rlo}b${zwsp}c` },
      }),
    );
    ui("/captures?id=cap_i");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(rlo);
    expect(text).not.toContain(zwsp);
    expect(screen.getByTestId("capture-payload")).toHaveTextContent("a\\u{202E}b\\u{200B}c");
    expect(screen.getByRole("heading", { name: "evil\\u{202E}txt" })).toBeInTheDocument();
    expect(text).toContain("lab\\u{200B}el");
  });

  it("has no button that reads like an owner verb, even on a proposed action", () => {
    only(detail({ id: "cap_p", kind: "action", state: "proposed", expiresAt: NOW + 60_000 }));
    ui("/captures?id=cap_p");
    for (const b of screen.getAllByRole("button")) {
      expect(b.textContent ?? "").not.toMatch(/accept|reject|revoke|purge/i);
      expect(b.getAttribute("aria-label") ?? "").not.toMatch(/accept|reject|revoke|purge/i);
    }
    expect(screen.queryByRole("button", { name: /accept|reject|revoke|purge/i })).toBeNull();
  });
});

describe("Captures page — review fixes", () => {
  it("a URL-supplied id that fails to load is never echoed, nor put in a command", () => {
    const hostile = `x; rm -rf ~ #${String.fromCodePoint(0x202e)}`;
    h.detailError = "Capture not found";
    ui(`/captures?id=${encodeURIComponent(hostile)}`);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not load this capture: Capture not found.");
    expect(alert.textContent).toContain("From a terminal: nimbus captures list");
    expect(document.body.textContent).not.toContain("rm -rf");
    expect(commands()).toBeNull();
  });

  it("a failed list refresh is announced while the last good list stays visible", () => {
    h.listError = "gateway restarting";
    ui("/captures");
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not load captures: gateway restarting. Showing the last list that loaded.",
    );
    expect(screen.getByRole("list", { name: "Captures" })).toBeTruthy();
  });

  it("a failed detail refresh is announced while the last good detail stays visible", () => {
    h.detailError = "timeout";
    ui(`/captures?id=${encodeURIComponent(fixture.get.id)}`);
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not load this capture: timeout. Showing the last version that loaded.",
    );
    expect(screen.getByRole("article", { name: "Capture" })).toBeTruthy();
  });

  it("a URL-selected capture stays visible when the filtered list is empty", () => {
    h.listData = { captures: [] };
    ui(`/captures?id=${encodeURIComponent(fixture.get.id)}`);
    expect(screen.getByText(/No captures\./)).toBeTruthy();
    expect(screen.getByRole("article", { name: "Capture" })).toBeTruthy();
    expect(h.methods).toContain("captures.get");
  });

  it("an error string is shown with invisible characters escaped", () => {
    // Written as a code point: a raw U+202E in this file is exactly what a reviewer cannot see.
    const rlo = String.fromCodePoint(0x202e);
    h.listData = null;
    h.listError = `bad ${rlo} term`;
    ui("/captures");
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain(String.raw`\u{202E}`);
    expect(text).not.toContain(rlo);
  });
});
