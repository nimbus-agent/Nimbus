import { describe, expect, test } from "bun:test";
import {
  type OncallPushedIpc,
  parseOncallPushedArgs,
  runOncallPushedWith,
} from "./oncall-pushed.ts";

function fake(
  responses: Record<string, unknown | Error>,
): OncallPushedIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      const r = responses[method];
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
const OK = {
  incidentId: "pagerduty:A",
  status: "ok",
  createdAt: 1,
  retriedAt: null,
  title: "P1 A",
  briefMarkdown: "# brief A",
  failureCode: null,
  delivery: {},
};
const FAILED = {
  ...OK,
  status: "failed",
  briefMarkdown: null,
  failureCode: "timeout: no brief in 30000ms",
};

describe("parseOncallPushedArgs", () => {
  test("shapes", () => {
    expect(parseOncallPushedArgs([])).toEqual({ mode: "newest", json: false });
    expect(parseOncallPushedArgs(["list", "--json"])).toEqual({ mode: "list", json: true });
    expect(parseOncallPushedArgs(["pagerduty:A", "--retry"])).toEqual({
      mode: "one",
      incidentId: "pagerduty:A",
      retry: true,
      json: false,
    });
    expect(parseOncallPushedArgs(["--retry"])).toBeUndefined();
    expect(parseOncallPushedArgs(["a", "b"])).toBeUndefined();
    expect(parseOncallPushedArgs(["--bogus"])).toBeUndefined();
  });
});

describe("runOncallPushedWith (spec § 2.7 exit table)", () => {
  test("empty → message, exit 0; hint when disabled", async () => {
    const { s, sink: k } = sink();
    const c = fake({
      "oncall.pushedGet": { brief: null },
      "oncall.pushedList": { enabled: false, identity: "resolved", briefs: [] },
    });
    expect(await runOncallPushedWith(c, { mode: "newest", json: false }, k, false)).toBe(0);
    expect(s.out).toContain("No pushed briefs yet.");
    expect(s.out).toContain("[oncall.push] enabled = true");
  });

  test("ok brief → markdown, exit 0", async () => {
    const { s, sink: k } = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: OK } }),
        { mode: "newest", json: false },
        k,
        false,
      ),
    ).toBe(0);
    expect(s.out).toBe("# brief A\n");
  });

  test("failed brief → code + retry hint, exit 1", async () => {
    const { s, sink: k } = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: FAILED } }),
        { mode: "one", incidentId: "pagerduty:A", retry: false, json: false },
        k,
        false,
      ),
    ).toBe(1);
    expect(s.err).toContain("timeout: no brief in 30000ms");
    expect(s.err).toContain("nimbus oncall pushed pagerduty:A --retry");
  });

  test("unknown id → exit 1", async () => {
    const { s, sink: k } = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: null } }),
        { mode: "one", incidentId: "pagerduty:X", retry: false, json: false },
        k,
        false,
      ),
    ).toBe(1);
    expect(s.err).toContain("No pushed brief for pagerduty:X.");
  });

  test("retry refused → exit 1 with the message", async () => {
    const { s, sink: k } = sink();
    const c = fake({
      "oncall.pushedRetry": Object.assign(
        new Error("ERR_ONCALL_PUSH_NOT_FAILED: already has a brief"),
        { code: -32002 },
      ),
    });
    expect(
      await runOncallPushedWith(
        c,
        { mode: "one", incidentId: "pagerduty:A", retry: true, json: false },
        k,
        false,
      ),
    ).toBe(1);
    expect(s.err).toContain("ERR_ONCALL_PUSH_NOT_FAILED");
  });

  test("--json is ALWAYS valid JSON, with the same exit codes", async () => {
    const { s, sink: k } = sink();
    const c = fake({ "oncall.pushedList": { enabled: true, identity: "resolved", briefs: [] } });
    expect(await runOncallPushedWith(c, { mode: "list", json: true }, k, false)).toBe(0);
    expect(JSON.parse(s.out)).toEqual({ enabled: true, identity: "resolved", briefs: [] });
    const f = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: FAILED } }),
        { mode: "newest", json: true },
        f.sink,
        false,
      ),
    ).toBe(1);
    expect(JSON.parse(f.s.out).brief.status).toBe("failed");
    const n = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: null } }),
        { mode: "newest", json: true },
        n.sink,
        false,
      ),
    ).toBe(0);
    const u = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: null } }),
        { mode: "one", incidentId: "x", retry: false, json: true },
        u.sink,
        false,
      ),
    ).toBe(1);
  });
});

describe("oncall pushed: remaining branches", () => {
  test("parse: list+--retry refused, one id with --json, --json alone", () => {
    expect(parseOncallPushedArgs(["list", "--retry"])).toBeUndefined();
    expect(parseOncallPushedArgs(["--json", "pagerduty:A"])).toEqual({
      mode: "one",
      incidentId: "pagerduty:A",
      retry: false,
      json: true,
    });
    expect(parseOncallPushedArgs(["--json"])).toEqual({ mode: "newest", json: true });
  });

  test("runOncallPushed: bad argv prints usage and exits 1 without touching the gateway", async () => {
    const { runOncallPushed, ONCALL_PUSHED_USAGE } = await import("./oncall-pushed.ts");
    const { CliExit } = await import("../lib/cli-exit.ts");
    const orig = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((s: string | Uint8Array) => {
      captured += String(s);
      return true;
    }) as typeof process.stderr.write;
    let thrown: unknown;
    try {
      await runOncallPushed(["a", "b"]);
    } catch (e) {
      thrown = e;
    } finally {
      process.stderr.write = orig;
    }
    expect(thrown).toBeInstanceOf(CliExit);
    expect((thrown as { code?: number }).code).toBe(1);
    expect(captured).toContain(ONCALL_PUSHED_USAGE);
  });

  test("list renders one line per brief, ok and FAILED, with a null title blank", async () => {
    const { s, sink: k } = sink();
    const c = fake({
      "oncall.pushedList": {
        enabled: true,
        identity: "resolved",
        briefs: [OK, { ...FAILED, incidentId: "pagerduty:B", title: null, createdAt: 2 }],
      },
    });
    expect(await runOncallPushedWith(c, { mode: "list", json: false }, k, false)).toBe(0);
    const lines = s.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ok    ");
    expect(lines[0]).toContain("pagerduty:A  P1 A");
    expect(lines[0]).toContain(new Date(1).toISOString());
    expect(lines[1]).toContain("FAILED");
    expect(lines[1]).toContain(new Date(2).toISOString());
    expect(s.out.split("\n")[1]?.endsWith("pagerduty:B  ")).toBe(true);
    expect(c.calls[0]).toEqual(["oncall.pushedList", { limit: 50 }]);
  });

  test("empty list: hint only when disabled", async () => {
    const on = sink();
    await runOncallPushedWith(
      fake({ "oncall.pushedList": { enabled: true, identity: "resolved", briefs: [] } }),
      { mode: "list", json: false },
      on.sink,
      false,
    );
    expect(on.s.out).toBe("No pushed briefs yet.\n");
    const off = sink();
    await runOncallPushedWith(
      fake({ "oncall.pushedList": { enabled: false, identity: "resolved", briefs: [] } }),
      { mode: "list", json: false },
      off.sink,
      false,
    );
    expect(off.s.out).toContain("[oncall.push] enabled = true");
  });

  test("newest empty with push enabled: no off-hint", async () => {
    const { s, sink: k } = sink();
    const c = fake({
      "oncall.pushedGet": { brief: null },
      "oncall.pushedList": { enabled: true, identity: "resolved", briefs: [] },
    });
    expect(await runOncallPushedWith(c, { mode: "newest", json: false }, k, false)).toBe(0);
    expect(s.out).toBe("No pushed briefs yet.\n");
    expect(c.calls[1]).toEqual(["oncall.pushedList", { limit: 1 }]);
  });

  test("newest empty, then the off-hint lookup fails: reported on stderr, exit 1 (never a rejection)", async () => {
    const { s, sink: k } = sink();
    const c = fake({
      "oncall.pushedGet": { brief: null },
      "oncall.pushedList": new Error("gateway went away"),
    });
    expect(await runOncallPushedWith(c, { mode: "newest", json: false }, k, false)).toBe(1);
    expect(s.out).toBe("No pushed briefs yet.\n");
    expect(s.err).toBe("gateway went away\n");
  });

  test("retry success calls pushedRetry with the id and renders the brief", async () => {
    const { s, sink: k } = sink();
    const c = fake({ "oncall.pushedRetry": { brief: OK } });
    expect(
      await runOncallPushedWith(
        c,
        { mode: "one", incidentId: "pagerduty:A", retry: true, json: false },
        k,
        false,
      ),
    ).toBe(0);
    expect(c.calls).toEqual([["oncall.pushedRetry", { incidentId: "pagerduty:A" }]]);
    expect(s.out).toBe("# brief A\n");
  });

  test("named get passes the incident id; newest passes no params", async () => {
    const c1 = fake({ "oncall.pushedGet": { brief: OK } });
    await runOncallPushedWith(
      c1,
      { mode: "one", incidentId: "pagerduty:A", retry: false, json: false },
      sink().sink,
      false,
    );
    expect(c1.calls[0]).toEqual(["oncall.pushedGet", { incidentId: "pagerduty:A" }]);
    const c2 = fake({ "oncall.pushedGet": { brief: OK } });
    await runOncallPushedWith(c2, { mode: "newest", json: false }, sink().sink, false);
    expect(c2.calls[0]).toEqual(["oncall.pushedGet", {}]);
  });

  test("failed brief with null failureCode says unknown; ok brief with null markdown prints empty", async () => {
    const f = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: { ...FAILED, failureCode: null } } }),
        { mode: "newest", json: false },
        f.sink,
        false,
      ),
    ).toBe(1);
    expect(f.s.err).toContain("could not be assembled: unknown");
    const o = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: { ...OK, briefMarkdown: null } } }),
        { mode: "newest", json: false },
        o.sink,
        false,
      ),
    ).toBe(0);
    expect(o.s.out).toBe("\n");
  });

  test("--json ok brief exits 0; thrown errors become JSON {error}; non-Error is stringified", async () => {
    const ok = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": { brief: OK } }),
        { mode: "newest", json: true },
        ok.sink,
        false,
      ),
    ).toBe(0);
    expect(JSON.parse(ok.s.out).brief.incidentId).toBe("pagerduty:A");
    const e1 = sink();
    expect(
      await runOncallPushedWith(
        fake({ "oncall.pushedGet": new Error("boom") }),
        { mode: "newest", json: true },
        e1.sink,
        false,
      ),
    ).toBe(1);
    expect(JSON.parse(e1.s.out)).toEqual({ error: "boom" });
    const e2 = sink();
    const thrower: OncallPushedIpc = {
      async call() {
        throw "plain string";
      },
    };
    expect(
      await runOncallPushedWith(thrower, { mode: "newest", json: false }, e2.sink, false),
    ).toBe(1);
    expect(e2.s.err).toBe("plain string\n");
  });
});
