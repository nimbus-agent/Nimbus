import { describe, expect, spyOn, test } from "bun:test";

import { CliExit } from "../lib/cli-exit.ts";
import {
  cleanMarkdown,
  type IncidentIpc,
  runIncidentCommand,
  runIncidentWith,
} from "./incident.ts";
import {
  ago,
  INCIDENT_USAGE,
  listLine,
  parseIncidentArgs,
  recordFooter,
  type SummaryLike,
  sourcesLine,
  utc,
} from "./incident-format.ts";

const T = Date.UTC(2026, 10, 12, 8, 30);

function summary(over: Partial<SummaryLike> = {}): SummaryLike {
  return {
    id: "inc_0123456789abcdef",
    triggerItemId: "pagerduty:PD1",
    triggerService: "pagerduty",
    service: "payment-service",
    title: "Payments latency",
    severity: "p1",
    status: "open",
    openedAtMs: T,
    version: 3,
    assembledAtMs: T + 60_000,
    checkedAtMs: T + 5 * 60_000,
    ...over,
  };
}

function harness(replies: Record<string, unknown | ((p: unknown) => unknown)>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const ipc = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "session.declareKind") return {};
      const r = replies[method];
      if (r instanceof Error) throw r;
      return typeof r === "function" ? (r as (p: unknown) => unknown)(params) : r;
    },
  } as unknown as IncidentIpc;
  return {
    out,
    err,
    calls,
    ipc,
    sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

describe("parseIncidentArgs", () => {
  test("list flags", () => {
    expect(parseIncidentArgs(["list"])).toEqual({
      verb: "list",
      json: false,
      open: false,
      cascade: false,
    });
    expect(
      parseIncidentArgs([
        "list",
        "--open",
        "--service",
        "payments",
        "--source",
        "jira",
        "--limit",
        "5",
        "--json",
      ]),
    ).toEqual({
      verb: "list",
      json: true,
      open: true,
      cascade: false,
      service: "payments",
      source: "jira",
      limit: 5,
    });
  });

  test("show takes exactly one id and an optional --json", () => {
    expect(parseIncidentArgs(["show", "inc_x"])).toEqual({
      verb: "show",
      json: false,
      id: "inc_x",
    });
    expect(parseIncidentArgs(["show", "--json", "pagerduty:PD1"])).toEqual({
      verb: "show",
      json: true,
      id: "pagerduty:PD1",
    });
  });

  test.each([
    [[]],
    [["timeline"]],
    [["frobnicate", "x"]],
    [["list", "--open", "--open"]],
    [["list", "--json", "--json"]],
    [["list", "--service"]],
    [["list", "--service", "a", "--service", "b"]],
    [["list", "--source", "github"]],
    [["list", "--limit", "0"]],
    [["list", "--limit", "201"]],
    [["list", "--limit", "x"]],
    [["list", "--limit", "1", "--limit", "2"]],
    [["list", "--wat"]],
    [["show"]],
    [["show", "a", "b"]],
    [["show", "--wat"]],
    [["show", "a", "--json", "--json"]],
  ])("%j is a usage error", (argv) => {
    expect(parseIncidentArgs(argv as string[])).toBeUndefined();
  });
});

describe("format", () => {
  test("utc, ago, footer and the connected line", () => {
    expect(utc(T)).toBe("2026-11-12 08:30 UTC");
    expect(ago(T, T + 5_000)).toBe("5s");
    expect(ago(T, T + 5 * 60_000)).toBe("5m");
    expect(ago(T, T + 3 * 3_600_000)).toBe("3h");
    expect(ago(T, T + 2 * 86_400_000)).toBe("2d");
    expect(ago(T + 10, T)).toBe("0s");
    expect(recordFooter(summary(), T + 4 * 60_000 + 60_000)).toBe(
      "Record inc_0123456789abcdef v3, assembled 2026-11-12 08:31 UTC (4m ago), last checked 2026-11-12 08:35 UTC",
    );
    expect(
      sourcesLine([
        { service: "pagerduty", connected: true, lastSyncMs: 1 },
        { service: "jira", connected: false, lastSyncMs: null },
      ]),
    ).toBe("Connected: pagerduty. Not connected: jira.");
    expect(sourcesLine([{ service: "jira", connected: false, lastSyncMs: null }])).toContain(
      "Connected: none.",
    );
  });

  test("a list line strips control characters from the title and names an unbound record", () => {
    const line = listLine(
      summary({
        title: "x\u001b[31mred\u0007\nnext",
        service: null,
        openedAtMs: null,
        severity: null,
      }),
    );
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\n");
    expect(line).toContain("(unbound)");
    expect(line).toContain("no open time");
    expect(cleanMarkdown("a\u001b[2Jb\nc")).toBe("a[2Jb\nc");
  });
});

describe("incident list", () => {
  test("rows, exit 0; the call declares cli FIRST", async () => {
    const h = harness({
      "incident.list": {
        status: "ok",
        records: [summary(), summary({ id: "inc_2", title: "Other" })],
        sources: [],
      },
    });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "list", json: false, open: true, cascade: false, limit: 5 },
      h.sink,
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.list"]);
    expect(h.calls[0]?.params).toEqual({ kind: "cli" });
    expect(h.calls[1]?.params).toEqual({ open: true, limit: 5 });
    expect(h.out).toHaveLength(2);
    expect(h.out[0]).toContain("Payments latency");
  });

  test("none exits 0 and names the connected sources; no_data exits 1 with the hint", async () => {
    const none = harness({
      "incident.list": {
        status: "none",
        records: [],
        sources: [{ service: "pagerduty", connected: true, lastSyncMs: 1 }],
      },
    });
    expect(
      await runIncidentWith(
        none.ipc,
        { verb: "list", json: false, open: false, cascade: false },
        none.sink,
      ),
    ).toBe(0);
    expect(none.out.join("")).toContain("Connected: pagerduty");
    const nodata = harness({ "incident.list": { status: "no_data", records: [], sources: [] } });
    expect(
      await runIncidentWith(
        nodata.ipc,
        { verb: "list", json: false, open: false, cascade: false },
        nodata.sink,
      ),
    ).toBe(1);
    expect(nodata.err.join("")).toContain("Connect PagerDuty");
  });

  test("--json always prints the status, so a script reads the state, not only the exit code", async () => {
    const h = harness({ "incident.list": { status: "no_data", records: [], sources: [] } });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "list", json: true, open: false, cascade: false, service: "s", source: "jira" },
      h.sink,
    );
    expect(code).toBe(1);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ status: "no_data" });
    expect(h.calls[1]?.params).toEqual({ service: "s", source: "jira" });
    const ok = harness({ "incident.list": { status: "none", records: [], sources: [] } });
    expect(
      await runIncidentWith(
        ok.ipc,
        { verb: "list", json: true, open: false, cascade: false },
        ok.sink,
      ),
    ).toBe(0);
  });

  test("a gateway error is printed and exits 1, as JSON under --json", async () => {
    const h = harness({
      "incident.list": new Error("ERR_INCIDENT_FORBIDDEN_CLIENT: no\u001b[31m"),
    });
    expect(
      await runIncidentWith(
        h.ipc,
        { verb: "list", json: false, open: false, cascade: false },
        h.sink,
      ),
    ).toBe(1);
    expect(h.err.join("")).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
    expect(h.err.join("")).not.toContain("\u001b");
    const j = harness({ "incident.list": new Error("boom") });
    expect(
      await runIncidentWith(
        j.ipc,
        { verb: "list", json: true, open: false, cascade: false },
        j.sink,
      ),
    ).toBe(1);
    expect(JSON.parse(j.out.join(""))).toEqual({ error: "boom" });
  });
});

describe("incident show", () => {
  const got = {
    record: { summary: summary(), markdown: "# Incident Payments\n\nbody\u001b[31m", versions: [] },
  };

  test("a record prints the Markdown and the footer with both times; declares cli before its first call", async () => {
    const h = harness({ "incident.get": got });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "show", json: false, id: "inc_x" },
      h.sink,
      T + 6 * 60_000,
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.get"]);
    const text = h.out.join("");
    expect(text).toContain("# Incident Payments");
    expect(text).not.toContain("\u001b");
    expect(text).toContain(
      "Record inc_0123456789abcdef v3, assembled 2026-11-12 08:31 UTC (5m ago), last checked 2026-11-12 08:35 UTC",
    );
    expect(text).not.toContain("Assembled on demand");
  });

  test("an unassembled trigger item is assembled on demand, then shown, and says so", async () => {
    let n = 0;
    const h = harness({
      "incident.get": () => {
        n += 1;
        return n === 1
          ? { record: null, reason: "not_assembled", triggerItemId: "pagerduty:PD1" }
          : got;
      },
      "incident.assemble": { outcome: "created", record: summary() },
    });
    const code = await runIncidentWith(h.ipc, { verb: "show", json: false, id: "PD1" }, h.sink, T);
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual([
      "session.declareKind",
      "incident.get",
      "incident.assemble",
      "incident.get",
    ]);
    expect(h.calls[2]?.params).toEqual({ id: "pagerduty:PD1" });
    expect(h.out.join("")).toContain("Assembled on demand");
  });

  test("--json returns the incident.get shape; nothing indexed, ambiguous and not-a-trigger exit 1", async () => {
    const j = harness({ "incident.get": got });
    expect(await runIncidentWith(j.ipc, { verb: "show", json: true, id: "x" }, j.sink)).toBe(0);
    expect(JSON.parse(j.out.join(""))).toHaveProperty("record.summary.id");
    const none = harness({ "incident.get": { record: null, reason: "no_item" } });
    expect(await runIncidentWith(none.ipc, { verb: "show", json: false, id: "x" }, none.sink)).toBe(
      1,
    );
    expect(none.err.join("")).toContain("No incident");
    const nonej = harness({ "incident.get": { record: null, reason: "no_item" } });
    expect(
      await runIncidentWith(nonej.ipc, { verb: "show", json: true, id: "x" }, nonej.sink),
    ).toBe(1);
    for (const message of [
      "ERR_INCIDENT_AMBIGUOUS: a, b",
      "ERR_INCIDENT_NOT_A_TRIGGER: github:1",
    ]) {
      const h = harness({ "incident.get": new Error(message) });
      expect(await runIncidentWith(h.ipc, { verb: "show", json: false, id: "x" }, h.sink)).toBe(1);
      expect(h.err.join("")).toContain(message);
    }
  });
});

describe("runIncidentCommand", () => {
  test("a bad argument prints the usage and exits 1 without touching the gateway", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runIncidentCommand(["timeline"])).rejects.toBeInstanceOf(CliExit);
      expect(stderr).toHaveBeenCalledWith(`${INCIDENT_USAGE}\n`);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("incident timeline and the cascade (IC4)", () => {
  test("timeline parses its id, --version and --json, and refuses anything else", () => {
    expect(parseIncidentArgs(["timeline", "inc_x"])).toEqual({
      verb: "timeline",
      json: false,
      id: "inc_x",
    });
    expect(parseIncidentArgs(["timeline", "inc_x", "--version", "3", "--json"])).toEqual({
      verb: "timeline",
      json: true,
      id: "inc_x",
      version: 3,
    });
    for (const bad of [
      ["timeline"],
      ["timeline", "a", "b"],
      ["timeline", "a", "--version"],
      ["timeline", "a", "--version", "0"],
      ["timeline", "a", "--version", "x"],
      ["timeline", "a", "--version", "1", "--version", "2"],
      ["timeline", "a", "--json", "--json"],
      ["timeline", "a", "--bogus"],
    ]) {
      expect(parseIncidentArgs(bad), bad.join(" ")).toBeUndefined();
    }
    expect(INCIDENT_USAGE).toContain("incident timeline <id>");
    expect(INCIDENT_USAGE).toContain("--cascade");
  });

  test("list --cascade parses once and sends cascade: true", () => {
    expect(parseIncidentArgs(["list", "--cascade"])).toMatchObject({ verb: "list", cascade: true });
    expect(parseIncidentArgs(["list", "--cascade", "--cascade"])).toBeUndefined();
  });

  test("timeline prints every line with a clock label, strips control characters, and declares cli first", async () => {
    const h = harness({
      "incident.timeline": {
        recordId: "inc_0123456789abcdef",
        version: 1,
        currentVersion: 2,
        events: [
          { atMs: T, atBasis: "source", kind: "opened", text: "Opened: bad\u001b[31m title" },
        ],
        notes: ["note\u001b[0m one"],
      },
    });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "timeline", json: false, id: "inc_x", version: 1 },
      h.sink,
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.timeline"]);
    expect(h.calls[1]?.params).toEqual({ id: "inc_x", version: 1 });
    const text = h.out.join("");
    expect(text).toContain("version 1 of 2 (an older version: what was known then)");
    expect(text).toContain("2026-11-12 08:30:00 UTC (source) opened: Opened: bad[31m title");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("Note: note[0m one");
    const j = harness({
      "incident.timeline": { recordId: "r", version: 1, currentVersion: 1, events: [], notes: [] },
    });
    expect(await runIncidentWith(j.ipc, { verb: "timeline", json: true, id: "r" }, j.sink)).toBe(0);
    expect(JSON.parse(j.out.join(""))).toMatchObject({ recordId: "r" });
  });

  test("a timeline of an unknown id exits 1 with the gateway's message", async () => {
    const h = harness({
      "incident.timeline": new Error("ERR_INCIDENT_NOT_FOUND: no record is stored for that id"),
    });
    expect(await runIncidentWith(h.ipc, { verb: "timeline", json: false, id: "x" }, h.sink)).toBe(
      1,
    );
    expect(h.err.join("")).toContain("ERR_INCIDENT_NOT_FOUND");
  });

  test("list --cascade prints the groups after the list; an unreadable ranking says so", async () => {
    const h = harness({
      "incident.list": {
        status: "ok",
        records: [summary()],
        sources: [],
        groups: [
          {
            relationLabel: "ranked by declared depends_on, then shared deployment, then open time",
            reachCapped: false,
            members: [
              { recordId: "inc_a", role: "root", title: "db\u001b[31m down", service: "db" },
              { recordId: "inc_b", role: "downstream", title: "api slow", service: null },
            ],
          },
        ],
      },
    });
    expect(
      await runIncidentWith(
        h.ipc,
        { verb: "list", json: false, open: false, cascade: true },
        h.sink,
      ),
    ).toBe(0);
    expect(h.calls[1]?.params).toEqual({ cascade: true });
    const text = h.out.join("");
    expect(text).toContain("Cascade 1: ranked by declared depends_on");
    expect(text).toContain("root candidate  inc_a  db  db[31m down");
    expect(text).toContain("downstream      inc_b  (unbound)  api slow");
    expect(text).not.toContain("\u001b");
    const bad = harness({
      "incident.list": { status: "ok", records: [summary()], sources: [], groups: null },
    });
    await runIncidentWith(
      bad.ipc,
      { verb: "list", json: false, open: false, cascade: true },
      bad.sink,
    );
    expect(bad.out.join("")).toContain("could not be ranked");
    const none = harness({
      "incident.list": { status: "ok", records: [summary()], sources: [], groups: [] },
    });
    await runIncidentWith(
      none.ipc,
      { verb: "list", json: false, open: false, cascade: true },
      none.sink,
    );
    expect(none.out.join("")).toContain("No cascade");
  });

  test("show prints the live cascade block after the stored Markdown, cleaned", async () => {
    const h = harness({
      "incident.get": {
        record: {
          summary: summary(),
          markdown: "# Incident Payments",
          versions: [],
          cascade: {
            status: "ok",
            markdown: "## Cascade\n\n- This record is the ranked root candidate\u001b[31m of 2",
          },
        },
      },
    });
    expect(
      await runIncidentWith(h.ipc, { verb: "show", json: false, id: "inc_x" }, h.sink, T),
    ).toBe(0);
    const text = h.out.join("");
    expect(text.indexOf("# Incident Payments")).toBeLessThan(text.indexOf("## Cascade"));
    expect(text).not.toContain("\u001b");
    const un = harness({
      "incident.get": {
        record: {
          summary: summary(),
          markdown: "# I",
          versions: [],
          cascade: { status: "unavailable" },
        },
      },
    });
    await runIncidentWith(un.ipc, { verb: "show", json: false, id: "inc_x" }, un.sink, T);
    expect(un.out.join("")).toContain("could not be ranked");
  });
});

describe("incident investigate (IC9a)", () => {
  const BIDI = String.fromCharCode(0x202e);
  const ESC = String.fromCharCode(0x1b);

  test("parses an id and --json, and refuses anything else", () => {
    expect(parseIncidentArgs(["investigate", "inc_x"])).toEqual({
      verb: "investigate",
      json: false,
      id: "inc_x",
    });
    expect(parseIncidentArgs(["investigate", "--json", "inc_x"])).toEqual({
      verb: "investigate",
      json: true,
      id: "inc_x",
    });
    for (const bad of [
      ["investigate"],
      ["investigate", "a", "b"],
      ["investigate", "a", "--json", "--json"],
      ["investigate", "--bogus"],
      ["investigate", "a", "--version", "2"],
    ]) {
      expect(parseIncidentArgs(bad)).toBeUndefined();
    }
    expect(INCIDENT_USAGE).toContain("incident investigate <id>");
  });

  test("declares cli first, calls incident.investigate, and prints the markdown stripped of controls and direction overrides", async () => {
    const h = harness({
      "incident.investigate": {
        investigation: {},
        markdown: `# Investigation: bad${ESC}[31m title${BIDI}\n\n## Gaps\n\n- a gap\n`,
      },
    });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "investigate", json: false, id: "inc_x" },
      h.sink,
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.investigate"]);
    expect(h.calls[1]?.params).toEqual({ id: "inc_x" });
    const text = h.out.join("");
    expect(text).toContain("# Investigation: bad[31m title");
    expect(text).toContain("## Gaps");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BIDI);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("--json prints the reply verbatim; a gateway error exits 1", async () => {
    const j = harness({
      "incident.investigate": { investigation: { recordId: "r" }, markdown: "m" },
    });
    expect(await runIncidentWith(j.ipc, { verb: "investigate", json: true, id: "r" }, j.sink)).toBe(
      0,
    );
    expect(JSON.parse(j.out.join(""))).toMatchObject({ investigation: { recordId: "r" } });
    const e = harness({
      "incident.investigate": new Error("ERR_INCIDENT_NOT_FOUND: nothing indexed has that id"),
    });
    expect(
      await runIncidentWith(e.ipc, { verb: "investigate", json: false, id: "x" }, e.sink),
    ).toBe(1);
    expect(e.err.join("")).toContain("ERR_INCIDENT_NOT_FOUND");
  });
});
