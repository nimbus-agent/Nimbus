import { describe, expect, test } from "bun:test";

import { CliExit } from "../lib/cli-exit.ts";
import {
  ONCALL_NOW_USAGE,
  type OncallNowIpc,
  parseOncallNowArgs,
  runOncallNow,
  runOncallNowWith,
} from "./oncall-now.ts";

function fake(r: unknown | Error): OncallNowIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function sink() {
  const s = { out: "", err: "" };
  return {
    s,
    sink: {
      out: (x: string) => {
        s.out += x;
      },
      err: (x: string) => {
        s.err += x;
      },
    },
  };
}

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const SHIFT = {
  source: "pagerduty",
  userName: "Alice Ng",
  policyName: "Payments policy",
  scheduleName: "Payments primary",
  level: 1,
  endMs: Date.UTC(2026, 10, 12, 8, 0),
  isMe: false,
};
const BASE = {
  status: "ok",
  asOfMs: NOW,
  query: "payment-service",
  resolvedVia: "service_name",
  sources: [{ source: "pagerduty", oldestFetchedMs: NOW - 3 * 60_000, stale: false }],
  shifts: [SHIFT],
  next: [],
  known: [],
  gaps: [],
};

describe("parseOncallNowArgs", () => {
  test("accepted shapes", () => {
    expect(parseOncallNowArgs([])).toEqual({ json: false });
    expect(parseOncallNowArgs(["--json"])).toEqual({ json: true });
    expect(parseOncallNowArgs(["--service", "payment-service"])).toEqual({
      json: false,
      service: "payment-service",
    });
    expect(parseOncallNowArgs(["--service=payment-service", "--json"])).toEqual({
      json: true,
      service: "payment-service",
    });
  });

  test("everything else is refused", () => {
    for (const bad of [
      ["--bogus"],
      ["--service"],
      ["--service", "--json"],
      ["--service="],
      ["--service", "a", "--service", "b"],
      ["--service=a", "--service=b"],
      ["positional"],
      ["--incident", "x"],
    ]) {
      expect(parseOncallNowArgs(bad)).toBeUndefined();
    }
  });
});

describe("runOncallNowWith text output", () => {
  test("ok: lists shifts with the source and a data age line, exit 0", async () => {
    const c = fake({ ...BASE, shifts: [{ ...SHIFT, isMe: true }] });
    const { s, sink: k } = sink();
    expect(await runOncallNowWith(c, { json: false, service: "payment-service" }, k)).toBe(0);
    expect(c.calls).toEqual([["oncall.now", { service: "payment-service" }]]);
    expect(s.out).toContain(
      "Payments primary -> Alice Ng [Payments policy, level 1, until 2026-11-12 08:00 UTC] (PagerDuty) <- you",
    );
    expect(s.out).toContain("PagerDuty data 3 min old");
    expect(s.out).toContain("Matched by service name.");
    expect(s.out).not.toContain("WARNING");
  });

  test("no service sends {}; upcoming, gaps and JSM label render", async () => {
    const c = fake({
      ...BASE,
      query: null,
      resolvedVia: null,
      shifts: [{ ...SHIFT, source: "jsm", policyName: null, level: null, endMs: null }],
      next: [{ ...SHIFT, scheduleName: null, policyName: null }],
      gaps: ["map incomplete"],
      sources: [{ source: "jsm", oldestFetchedMs: null, stale: true }],
    });
    const { s, sink: k } = sink();
    expect(await runOncallNowWith(c, { json: false }, k)).toBe(0);
    expect(c.calls[0]).toEqual(["oncall.now", {}]);
    expect(s.out).toContain("Payments primary -> Alice Ng (Jira Service Management)");
    expect(s.out).toContain("Next:");
    expect(s.out).toContain("unknown schedule -> Alice Ng");
    expect(s.out).toContain("Note: map incomplete");
    expect(s.out).toContain("Jira Service Management data age unknown");
    expect(s.out).toContain("WARNING: older than 1 h; the shift may have changed");
  });

  test("a source with an unknown key still renders", async () => {
    const c = fake({
      ...BASE,
      shifts: [{ ...SHIFT, source: "other" }],
      sources: [{ source: "other", oldestFetchedMs: NOW + 5 * 60_000, stale: false }],
    });
    const { s, sink: k } = sink();
    await runOncallNowWith(c, { json: false }, k);
    expect(s.out).toContain("(other)");
    expect(s.out).toContain("other data 0 min old");
  });

  test("none_on_call: an answer, exit 0, with the next shifts", async () => {
    const c = fake({ ...BASE, status: "none_on_call", shifts: [], next: [SHIFT] });
    const { s, sink: k } = sink();
    expect(await runOncallNowWith(c, { json: false }, k)).toBe(0);
    expect(s.out).toContain("No on-call shift covers now for payment-service.");
    expect(s.out).toContain("Next:");
    const none = fake({ ...BASE, status: "none_on_call", shifts: [], query: null });
    const o = sink();
    await runOncallNowWith(none, { json: false }, o.sink);
    expect(o.s.out).toContain("for any schedule");
  });

  test("no_match prints the known names to stderr, exit 1", async () => {
    const c = fake({ ...BASE, status: "no_match", shifts: [], known: ["A", "B"] });
    const { s, sink: k } = sink();
    expect(await runOncallNowWith(c, { json: false }, k)).toBe(1);
    expect(s.err).toContain('matches "payment-service"');
    expect(s.err).toContain("Known names: A, B");
    expect(s.out).toBe("");
    const none = fake({ ...BASE, status: "no_match", shifts: [], known: [] });
    const o = sink();
    await runOncallNowWith(none, { json: false }, o.sink);
    expect(o.s.err).not.toContain("Known names");
  });

  test("no_match prints the source ages and the gaps before exiting 1", async () => {
    const c = fake({
      ...BASE,
      status: "no_match",
      shifts: [],
      gaps: ["service map incomplete"],
      sources: [{ source: "pagerduty", oldestFetchedMs: NOW - 3 * 3_600_000, stale: true }],
    });
    const { s, sink: k } = sink();
    expect(await runOncallNowWith(c, { json: false }, k)).toBe(1);
    expect(s.err).toContain("Note: service map incomplete");
    expect(s.err).toContain("PagerDuty data 180 min old");
    expect(s.err).toContain("WARNING: older than 1 h");
    expect(s.out).toBe("");
  });

  test("no_data prints the gaps to stderr, exit 1", async () => {
    const c = fake({ ...BASE, status: "no_data", shifts: [], gaps: ["connect PagerDuty or Jira"] });
    const { s, sink: k } = sink();
    expect(await runOncallNowWith(c, { json: false }, k)).toBe(1);
    expect(s.err).toContain("connect PagerDuty or Jira");
  });

  test("provider-supplied names cannot inject terminal escapes", async () => {
    const c = fake({
      ...BASE,
      shifts: [{ ...SHIFT, userName: "Eve\u001b[2J\u0007", scheduleName: "S\u001b]0;x\u0007" }],
    });
    const { s, sink: k } = sink();
    await runOncallNowWith(c, { json: false }, k);
    expect(s.out.includes("\u001b")).toBe(false);
    expect(s.out.includes("\u0007")).toBe(false);
  });
});

describe("runOncallNowWith --json and errors", () => {
  test("prints the result verbatim on one line with the same exit codes", async () => {
    for (const [status, code] of [
      ["ok", 0],
      ["none_on_call", 0],
      ["no_match", 1],
      ["no_data", 1],
    ] as const) {
      const r = { ...BASE, status };
      const { s, sink: k } = sink();
      expect(await runOncallNowWith(fake(r), { json: true }, k)).toBe(code);
      expect(s.out).toBe(`${JSON.stringify(r)}\n`);
    }
  });

  test("an IPC error prints {error} in json and the message otherwise, exit 1", async () => {
    const j = sink();
    expect(await runOncallNowWith(fake(new Error("boom")), { json: true }, j.sink)).toBe(1);
    expect(j.s.out).toBe('{"error":"boom"}\n');
    const t = sink();
    expect(await runOncallNowWith(fake(new Error("boom")), { json: false }, t.sink)).toBe(1);
    expect(t.s.err).toBe("boom\n");
    const n = sink();
    expect(await runOncallNowWith(fake("x" as never), { json: false }, n.sink)).toBe(1);
  });
});

describe("runOncallNow", () => {
  test("a bad argument prints the usage and exits 1 before touching the gateway", async () => {
    const orig = process.stderr.write.bind(process.stderr);
    let seen = "";
    process.stderr.write = ((c: string | Uint8Array) => {
      seen += String(c);
      return true;
    }) as typeof process.stderr.write;
    try {
      const err = await runOncallNow(["--bogus"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
    expect(seen).toContain(ONCALL_NOW_USAGE);
  });
});
