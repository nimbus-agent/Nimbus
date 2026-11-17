import { describe, expect, test } from "bun:test";

import { runIncidentWith } from "./incident.ts";
import {
  cleanDebtText,
  type DebtReplyLike,
  formatDebt,
  parseDebtArgs,
} from "./incident-debt-format.ts";
import { INCIDENT_USAGE, parseIncidentArgs } from "./incident-format.ts";

const T = Date.UTC(2026, 4, 3);

function reply(over: Partial<DebtReplyLike> = {}): DebtReplyLike {
  return {
    status: "ok",
    windowDays: 365,
    untouchedDays: 180,
    minIncidents: 2,
    symbols: [
      {
        name: "charge",
        file: "src/pay.ts",
        root: "/work/web",
        incidentCount: 2,
        lastTouchMs: T,
        incidents: [{ id: "inc_0123456789abcdef", title: "Payments latency", openedAtMs: T }],
      },
    ],
    omitted: 0,
    gaps: [],
    counts: { incidentsScanned: 2, rootsScanned: 1, filesJudged: 1 },
    ...over,
  };
}

describe("parseDebtArgs", () => {
  test("no flags is the defaults; each flag takes its value", () => {
    expect(parseDebtArgs([])).toEqual({ verb: "debt", json: false });
    expect(
      parseDebtArgs([
        "--since",
        "400d",
        "--untouched",
        "30d",
        "--min-incidents",
        "3",
        "--limit",
        "10",
        "--json",
      ]),
    ).toEqual({ verb: "debt", json: true, since: 400, untouched: 30, minIncidents: 3, limit: 10 });
    expect(parseIncidentArgs(["debt", "--json"])).toEqual({ verb: "debt", json: true });
  });

  test("refuses malformed, duplicate, unknown and out-of-range flags", () => {
    const bad: string[][] = [
      ["--since"],
      ["--since", "90"],
      ["--since", "0d"],
      ["--since", "3651d"],
      ["--since", "9d", "--since", "9d"],
      ["--min-incidents", "51"],
      ["--limit", "201"],
      ["--limit", "x"],
      ["--json", "--json"],
      ["--wat"],
      ["extra"],
    ];
    for (const argv of bad) expect(parseDebtArgs(argv), argv.join(" ")).toBeUndefined();
  });

  test("the usage line names the verb", () => {
    expect(INCIDENT_USAGE).toContain("nimbus incident debt");
  });
});

describe("cleanDebtText", () => {
  test("drops control, ANSI, bidi, zero-width and line-separator characters", () => {
    const hostile = "a\u001b[31mred\u202ereversed\u200bz\u2028\u2029\u0007b";
    expect(cleanDebtText(hostile)).toBe("a[31mredreversedz b");
    expect(cleanDebtText("  two\n\tlines  ")).toBe("two lines");
  });
});

describe("formatDebt", () => {
  test("lists symbols, dates and incidents, and sanitises every repository-derived string", () => {
    const text = formatDebt(
      reply({
        symbols: [
          {
            name: "ch\u202earge",
            file: "src/\u001b[2Jpay.ts",
            root: "/work/\u2066web",
            incidentCount: 2,
            lastTouchMs: null,
            incidents: [{ id: "inc_1", title: "T\u200bitle\u001b]0;x\u0007", openedAtMs: T }],
          },
        ],
        omitted: 3,
        gaps: [{ category: "x", detail: "repo \u202edetail", remediation: "fix\u001b it" }],
      }),
    );
    expect(/[\p{Cc}\p{Cf}]/u.test(text.replaceAll("\n", ""))).toBe(false);
    expect(text).toContain("charge  src/[2Jpay.ts");
    expect(text).toContain("before the history read");
    expect(text).toContain("and 3 more");
    expect(text).toContain("- repo detail fix it");
    expect(text).toContain("2 incidents");
  });

  test("a dated last touch, and each empty status says what is missing", () => {
    expect(formatDebt(reply())).toContain("last commit 2026-05-03");
    expect(formatDebt(reply({ status: "none", symbols: [] }))).toContain("No symbol qualifies.");
    expect(formatDebt(reply({ status: "no_incidents", symbols: [] }))).toContain(
      "No incident record",
    );
    expect(formatDebt(reply({ status: "no_roots", symbols: [] }))).toContain(
      "No git-aware filesystem root",
    );
    expect(
      formatDebt(reply({ status: "none", symbols: [], gaps: [{ category: "c", detail: "d" }] })),
    ).toContain("Gaps:\n  - d");
  });
});

describe("runIncidentWith debt", () => {
  function run(r: DebtReplyLike, args: string[]) {
    const out: string[] = [];
    const calls: { method: string; params: unknown }[] = [];
    const ipc = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return method === "session.declareKind" ? {} : r;
      },
    };
    const a = parseIncidentArgs(["debt", ...args]);
    if (a === undefined) throw new Error("bad args");
    return runIncidentWith(ipc as never, a, { out: (s) => out.push(s), err: () => {} }).then(
      (code) => ({
        code,
        out: out.join(""),
        calls,
      }),
    );
  }

  test("declares cli, sends only the given params, and exits 0 for ok, none and no_incidents", async () => {
    const r = await run(reply(), ["--since", "400d", "--limit", "5"]);
    expect(r.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.debt"]);
    expect(r.calls[1]?.params).toEqual({ since: 400, limit: 5 });
    expect(r.code).toBe(0);
    for (const status of ["none", "no_incidents"] as const) {
      expect((await run(reply({ status, symbols: [] }), [])).code).toBe(0);
    }
  });

  test("a missing git-aware root exits 1; --json prints the raw reply", async () => {
    expect((await run(reply({ status: "no_roots", symbols: [] }), [])).code).toBe(1);
    const j = await run(reply(), ["--json"]);
    expect(JSON.parse(j.out)).toMatchObject({ status: "ok", windowDays: 365 });
  });
});
