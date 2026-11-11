import { describe, expect, test } from "bun:test";

import {
  APPROVE_USAGE,
  APPROVE_YES_REFUSAL,
  formatRuleDetail,
  formatRuleTable,
  parseApproveArgs,
  parseWindowArg,
  runApproveCmd,
  runApproveWith,
} from "./approve.ts";
import { runAuditStanding } from "./audit.ts";

type Call = { method: string; params: unknown };

function client(reply: (method: string, params: unknown) => unknown): {
  c: { call: <T>(m: string, p?: unknown) => Promise<T> };
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    c: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        const r = reply(method, params);
        if (r instanceof Error) throw r;
        return r as T;
      },
    },
  };
}

function sink(): {
  out: string[];
  err: string[];
  s: { out(x: string): void; err(x: string): void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x) => void out.push(x), err: (x) => void err.push(x) } };
}

const RULE = {
  id: "sr_0123456789abcdef",
  state: "live",
  workflowName: "weekly\u001b[2J-clean",
  workflowId: "wf1",
  workflowSha256: "ab".repeat(32),
  stepIndex: 1,
  actionType: "gmail.thread.archive",
  toolId: "gmail_thread_archive",
  scope: { threadId: { query: 0, column: "metadata.threadId" } },
  window: { label: "Mon-Fri 06:00-10:00 Europe/Berlin" },
  createdAt: Date.UTC(2026, 10, 11),
  expiresAt: Date.UTC(2026, 11, 11),
  maxActions: 100,
  actionsUsed: 3,
  lastFiredAt: null,
};

describe("parseApproveArgs", () => {
  test("add: workflow and step are required; days, max and window are optional", () => {
    expect(parseApproveArgs(["add", "--workflow", "wf", "--step", "archive"])).toEqual({
      verb: "add",
      workflow: "wf",
      step: "archive",
    });
    expect(
      parseApproveArgs([
        "add",
        "--workflow",
        "wf",
        "--step",
        "2",
        "--days",
        "7",
        "--max",
        "50",
        "--window",
        "Mon-Fri 06:00-10:00 Europe/Berlin",
      ]),
    ).toEqual({
      verb: "add",
      workflow: "wf",
      step: 2,
      days: 7,
      max: 50,
      window: { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00", tz: "Europe/Berlin" },
    });
  });

  test("add: a missing or repeated flag, an unknown flag and a bad value refuse the parse", () => {
    for (const bad of [
      ["add"],
      ["add", "--workflow", "wf"],
      ["add", "--step", "x"],
      ["add", "--workflow", "wf", "--step", "x", "--days", "x"],
      ["add", "--workflow", "wf", "--step", "x", "--max"],
      ["add", "--workflow", "wf", "--step", "x", "--window", "later"],
      ["add", "--workflow", "wf", "--step", "x", "--step", "y"],
      ["add", "--workflow", "wf", "--step", "x", "--scope", "{}"],
      ["add", "--workflow", "", "--step", "x"],
    ]) {
      expect(parseApproveArgs(bad), bad.join(" ")).toBeUndefined();
    }
  });

  test("list is the default; show, pause and revoke take one id; resume takes one id and no --json", () => {
    expect(parseApproveArgs([])).toEqual({ verb: "list", json: false });
    expect(parseApproveArgs(["list", "--json"])).toEqual({ verb: "list", json: true });
    expect(parseApproveArgs(["show", "sr_1", "--json"])).toEqual({
      verb: "show",
      id: "sr_1",
      json: true,
    });
    expect(parseApproveArgs(["pause", "sr_1"])).toEqual({ verb: "pause", id: "sr_1", json: false });
    expect(parseApproveArgs(["revoke", "sr_1"])).toEqual({
      verb: "revoke",
      id: "sr_1",
      json: false,
    });
    expect(parseApproveArgs(["resume", "sr_1"])).toEqual({ verb: "resume", id: "sr_1" });
    for (const bad of [
      ["show"],
      ["show", "--json"],
      ["pause", "a", "b"],
      ["resume"],
      ["resume", "sr_1", "--json"],
      ["list", "extra"],
      ["frobnicate"],
    ]) {
      expect(parseApproveArgs(bad), bad.join(" ")).toBeUndefined();
    }
  });

  test("parseWindowArg reads ranges, lists and refuses nonsense", () => {
    expect(parseWindowArg("Sat,Sun 09:00-12:00 UTC")?.days).toEqual([6, 7]);
    expect(parseWindowArg("mon 09:00-12:00 UTC")?.days).toEqual([1]);
    for (const bad of [
      "",
      "Fri-Mon 06:00-10:00 UTC",
      "Fun 06:00-10:00 UTC",
      "Mon-Tue-Wed 06:00-10:00 UTC",
    ]) {
      expect(parseWindowArg(bad), bad).toBeUndefined();
    }
  });
});

describe("runApproveWith", () => {
  test("add sends only the named fields and prints the rule id", async () => {
    const { c, calls } = client(() => ({ rule: RULE }));
    const o = sink();
    const code = await runApproveWith(
      c,
      { verb: "add", workflow: "wf", step: "archive", days: 7 },
      o.s,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      { method: "standing.create", params: { workflow: "wf", step: "archive", days: 7 } },
    ]);
    expect(o.out.join("")).toBe("Created standing rule sr_0123456789abcdef.\n");
  });

  test("list prints a table with the state and strips terminal controls; --json prints the raw rules", async () => {
    const { c } = client(() => ({ rules: [RULE] }));
    const o = sink();
    expect(await runApproveWith(c, { verb: "list", json: false }, o.s)).toBe(0);
    const text = o.out.join("");
    expect(text).toContain("sr_0123456789abcdef");
    expect(text).toContain("3/100");
    expect(text).toContain("live");
    expect(text).not.toContain("\u001b");
    const j = sink();
    await runApproveWith(c, { verb: "list", json: true }, j.s);
    expect(JSON.parse(j.out.join("")).rules[0].id).toBe(RULE.id);
  });

  test("an empty list says so", async () => {
    const { c } = client(() => ({ rules: [] }));
    const o = sink();
    await runApproveWith(c, { verb: "list", json: false }, o.s);
    expect(o.out.join("")).toBe("No standing rules.\n");
  });

  test("show, pause, resume and revoke call their method with the id", async () => {
    const { c, calls } = client(() => ({ rule: RULE }));
    const o = sink();
    await runApproveWith(c, { verb: "show", id: RULE.id, json: false }, o.s);
    await runApproveWith(c, { verb: "pause", id: RULE.id, json: false }, o.s);
    await runApproveWith(c, { verb: "resume", id: RULE.id }, o.s);
    await runApproveWith(c, { verb: "revoke", id: RULE.id, json: false }, o.s);
    expect(calls.map((x) => x.method)).toEqual([
      "standing.show",
      "standing.pause",
      "standing.resume",
      "standing.revoke",
    ]);
    const text = o.out.join("");
    expect(text).toContain("Rule sr_0123456789abcdef (live)");
    expect(text).toContain("Paused rule");
    expect(text).toContain("Resumed rule");
    expect(text).toContain("Revoked rule");
    expect(text).toContain("When: Mon-Fri 06:00-10:00 Europe/Berlin");
  });

  test("a gateway refusal exits 1 with its message on stderr (stripped), or as JSON", async () => {
    const { c } = client(() => new Error("the rule was not approved\u001b[31m"));
    const o = sink();
    expect(await runApproveWith(c, { verb: "add", workflow: "w", step: "s" }, o.s)).toBe(1);
    expect(o.err.join("").includes(String.fromCharCode(27))).toBe(false);
    expect(o.err.join("")).toContain("the rule was not approved");
    const j = sink();
    expect(await runApproveWith(c, { verb: "pause", id: "x", json: true }, j.s, true)).toBe(1);
    expect(JSON.parse(j.out.join("")).error).toContain("not approved");
  });

  test("formatRuleTable tolerates a rule with no workflow name; formatRuleDetail shows an any-time rule", () => {
    expect(formatRuleTable([{ ...RULE, workflowName: null } as never])).toContain("wf1");
    expect(formatRuleDetail({ ...RULE, window: null } as never)).toContain("When: any time");
  });
});

describe("runApproveCmd", () => {
  test("add and resume refuse --yes before anything is sent", async () => {
    for (const argv of [
      ["add", "--workflow", "w", "--step", "s", "--yes"],
      ["resume", "sr_1", "-y"],
    ]) {
      const written: string[] = [];
      const real = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        await expect(runApproveCmd(argv)).rejects.toMatchObject({ code: 2 });
      } finally {
        process.stderr.write = real;
      }
      expect(written.join("")).toContain(APPROVE_YES_REFUSAL);
    }
  });

  test("an unparseable command prints the usage and exits 2", async () => {
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(runApproveCmd(["bogus"])).rejects.toMatchObject({ code: 2 });
    } finally {
      process.stderr.write = real;
    }
    expect(written.join("")).toContain(APPROVE_USAGE);
  });
});

describe("nimbus audit standing", () => {
  const fires = [
    {
      fireId: "sf_0000000000000001",
      ruleId: RULE.id,
      firedAt: Date.UTC(2026, 10, 11, 8, 0),
      actionType: "gmail.thread.archive",
      matchedScopeSha256: "a".repeat(64),
      audit: { id: 12, timestamp: 1, rowHash: "x" },
    },
    {
      fireId: "sf_0000000000000002",
      ruleId: RULE.id,
      firedAt: Date.UTC(2026, 10, 11, 8, 1),
      actionType: "gmail.thread.archive",
      matchedScopeSha256: "a".repeat(64),
      audit: null,
    },
  ];

  async function capture(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      await fn();
    } finally {
      console.log = real;
    }
    return lines.join("\n");
  }

  test("lists each fire with its audit row, and shows a fire with none as such", async () => {
    const { c, calls } = client(() => ({ fires }));
    const text = await capture(() => runAuditStanding(c, RULE.id));
    expect(calls).toEqual([{ method: "standing.fires", params: { id: RULE.id } }]);
    expect(text).toContain("#12");
    expect(text).toContain("NO AUDIT ROW");
    expect(text).toContain("sf_0000000000000001");
  });

  test("with no rule it asks for every fire; --json prints them raw; none says so", async () => {
    const { c, calls } = client(() => ({ fires }));
    const raw = await capture(() => runAuditStanding(c, undefined, { json: true }));
    expect(calls[0]).toEqual({ method: "standing.fires", params: {} });
    expect(JSON.parse(raw).fires).toHaveLength(2);
    const none = client(() => ({ fires: [] }));
    expect(await capture(() => runAuditStanding(none.c, undefined))).toBe(
      "No standing-rule fires recorded.",
    );
  });
});
