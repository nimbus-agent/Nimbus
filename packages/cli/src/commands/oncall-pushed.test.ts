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
