import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVALS_USAGE,
  type ApprovalsArgs,
  parseApprovalsArgs,
  runApprovalsWith,
} from "./approvals.ts";

const TTY = { stdin: true, stdout: true };
const cp = (n: number): string => String.fromCodePoint(n);
const ESC = cp(0x1b);
const BIDI = cp(0x202e);

type Call = [string, unknown];

function fake(impl: (m: string, p: unknown) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      call: async <T>(m: string, p?: unknown): Promise<T> => {
        calls.push([m, p]);
        return impl(m, p) as T;
      },
    },
  };
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
}

const ROW = {
  id: "cap_aaaa",
  actionType: "jira.comment.add",
  wave: 2,
  typedConfirm: false,
  label: "claude-code",
  labelSource: "declared",
  summary: "comment on PROJ-1",
  createdAt: 1_000,
  expiresAt: 1_000 + 3_600_000,
};

describe("parseApprovalsArgs", () => {
  test.each<[string[], ApprovalsArgs]>([
    [[], { verb: "list", json: false }],
    [["list"], { verb: "list", json: false }],
    [["--json"], { verb: "list", json: true }],
    [["list", "--json"], { verb: "list", json: true }],
    [["show", "cap_x"], { verb: "show", id: "cap_x", json: false }],
    [["show", "cap_x", "--json"], { verb: "show", id: "cap_x", json: true }],
    [["cap_x"], { verb: "approve", id: "cap_x" }],
    [["cap_x", "--decline"], { verb: "decline", id: "cap_x", json: false }],
    [["--decline", "cap_x"], { verb: "decline", id: "cap_x", json: false }],
    [["cap_x", "--decline", "--json"], { verb: "decline", id: "cap_x", json: true }],
    [["--decline-all-from", "a b"], { verb: "declineAll", label: "a b", json: false }],
    [["--decline-all-from", "a b", "--json"], { verb: "declineAll", label: "a b", json: true }],
  ])("%j", (argv, want) => {
    expect(parseApprovalsArgs(argv)).toEqual(want);
  });

  test.each([
    ["--yes", ["cap_x", "--yes"]],
    ["-y", ["cap_x", "-y"]],
    ["--yes on list", ["--yes"]],
    ["--script-consent-source", ["cap_x", "--script-consent-source", "x"]],
    ["--script-consent-source=", ["cap_x", "--script-consent-source=x"]],
    ["an id without cap_", ["abc"]],
    ["two ids", ["cap_a", "cap_b"]],
    ["an unknown verb", ["nuke", "cap_x"]],
    ["approve with --json (the prompt owns stdout)", ["cap_x", "--json"]],
    ["show without an id", ["show"]],
    ["show with a non-capture id", ["show", "x"]],
    ["show with two ids", ["show", "cap_a", "cap_b"]],
    ["list with an id", ["list", "cap_x"]],
    ["--decline without an id", ["--decline"]],
    ["--decline-all-from without a label", ["--decline-all-from"]],
    ["--decline-all-from with a flag as label", ["--decline-all-from", "--json"]],
    ["--decline-all-from with an extra word", ["--decline-all-from", "a", "b"]],
    ["--decline-all-from with an id", ["--decline-all-from", "a", "cap_x"]],
    ["an unknown flag", ["--frobnicate"]],
  ])("usage error: %s", (_n, argv) => {
    expect(parseApprovalsArgs(argv)).toBeUndefined();
  });
});

describe("approvals list", () => {
  test("declares cli first, then lists; prints a table with the label marked unverified", async () => {
    const f = fake((m) => (m === "approvals.list" ? { proposals: [ROW] } : {}));
    const o = sink();
    const code = await runApprovalsWith(f.client, { verb: "list", json: false }, o.s, TTY, 2_000);
    expect(code).toBe(0);
    expect(f.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["approvals.list", {}],
    ]);
    const text = o.out.join("");
    expect(text).toContain("cap_aaaa");
    expect(text).toContain("jira.comment.add");
    expect(text).toContain("claude-code");
    expect(text).toContain("unverified");
    expect(text).toContain("comment on PROJ-1");
    expect(text).toContain("nimbus approvals <id>");
  });

  test("wave 4 and typed confirmation are shown; a null wave is a dash", async () => {
    const f = fake(() => ({
      proposals: [
        { ...ROW, id: "cap_w4", wave: 4, typedConfirm: true },
        { ...ROW, id: "cap_mcp", wave: null, label: null },
      ],
    }));
    const o = sink();
    await runApprovalsWith(f.client, { verb: "list", json: false }, o.s, TTY, 2_000);
    const text = o.out.join("");
    expect(text).toMatch(/cap_w4.*4/);
    expect(text).toContain("type-to-confirm");
    expect(text).toMatch(/cap_mcp.*-/);
  });

  test("strips control and bidi characters the gateway did not", async () => {
    const f = fake(() => ({
      proposals: [
        { ...ROW, label: `a${ESC}[31m${BIDI}b`, summary: `s${ESC}[2Jt`, actionType: "x" },
      ],
    }));
    const o = sink();
    await runApprovalsWith(f.client, { verb: "list", json: false }, o.s, TTY, 2_000);
    const text = o.out.join("");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain(BIDI);
  });

  test("an empty queue says so", async () => {
    const f = fake(() => ({ proposals: [] }));
    const o = sink();
    expect(await runApprovalsWith(f.client, { verb: "list", json: false }, o.s, TTY, 2_000)).toBe(
      0,
    );
    expect(o.out.join("")).toContain("No agent proposals are waiting");
  });

  test("--json prints the gateway result as it is", async () => {
    const raw = { proposals: [ROW] };
    const f = fake(() => raw);
    const o = sink();
    await runApprovalsWith(f.client, { verb: "list", json: true }, o.s, NO_TTY, 2_000);
    expect(JSON.parse(o.out.join(""))).toEqual(raw);
  });

  test("a malformed result is an error, exit 1", async () => {
    const f = fake(() => ({ nope: 1 }));
    const o = sink();
    expect(await runApprovalsWith(f.client, { verb: "list", json: false }, o.s, TTY, 2_000)).toBe(
      1,
    );
    expect(o.err.join("")).toContain("malformed");
  });
});

const NO_TTY = { stdin: false, stdout: false };

describe("approvals show", () => {
  const DETAIL = {
    id: "cap_aaaa",
    state: "proposed",
    actionType: "jira.comment.add",
    wave: 2,
    typedConfirm: false,
    label: "claude-code",
    labelSource: "declared",
    summary: "comment on PROJ-1",
    createdAt: 1_000,
    expiresAt: 1_000 + 3_600_000,
    inputLines: ["{", `  "body": "hi${ESC}"`, "}"],
    note: "the typed preview and the target's current state appear when you approve",
  };

  test("prints what the agent sent, marked unverified, and the note", async () => {
    const f = fake(() => DETAIL);
    const o = sink();
    const code = await runApprovalsWith(
      f.client,
      { verb: "show", id: "cap_aaaa", json: false },
      o.s,
      NO_TTY,
      2_000,
    );
    expect(code).toBe(0);
    expect(f.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["approvals.get", { id: "cap_aaaa" }],
    ]);
    const text = o.out.join("");
    expect(text).toContain("UNVERIFIED");
    expect(text).toContain("jira.comment.add");
    expect(text).toContain('"body": "hi"');
    expect(text).not.toContain(ESC);
    expect(text).toContain("appear when you approve");
    expect(text).toContain("nimbus approvals cap_aaaa");
  });

  test("a typed-confirmation row and a user-MCP row render their facts", async () => {
    const f = fake(() => ({ ...DETAIL, wave: 4, typedConfirm: true }));
    const o = sink();
    await runApprovalsWith(f.client, { verb: "show", id: "cap_aaaa", json: false }, o.s, NO_TTY, 1);
    expect(o.out.join("")).toContain("type-to-confirm");
    const g = fake(() => ({ ...DETAIL, wave: null, label: null }));
    const p = sink();
    await runApprovalsWith(g.client, { verb: "show", id: "cap_aaaa", json: false }, p.s, NO_TTY, 1);
    expect(p.out.join("")).toContain("an unnamed MCP client");
  });

  test("--json prints the raw result", async () => {
    const f = fake(() => DETAIL);
    const o = sink();
    await runApprovalsWith(f.client, { verb: "show", id: "cap_aaaa", json: true }, o.s, NO_TTY, 1);
    expect(JSON.parse(o.out.join(""))).toEqual(DETAIL);
  });

  test("an RPC error is printed stripped, exit 1; --json prints {error}", async () => {
    const f = fake((m) => {
      if (m === "approvals.get") throw new Error(`ERR_CAPTURE_NOT_FOUND${ESC}[1m: no such`);
      return {};
    });
    const o = sink();
    expect(
      await runApprovalsWith(f.client, { verb: "show", id: "cap_x", json: false }, o.s, NO_TTY, 1),
    ).toBe(1);
    expect(o.err.join("")).toBe("ERR_CAPTURE_NOT_FOUND[1m: no such\n");
    const j = sink();
    expect(
      await runApprovalsWith(f.client, { verb: "show", id: "cap_x", json: true }, j.s, NO_TTY, 1),
    ).toBe(1);
    expect(JSON.parse(j.out.join("")).error).toContain("ERR_CAPTURE_NOT_FOUND");
  });
});

describe("approvals approve", () => {
  test("without a TTY on either end: exit 1, the message, and ZERO RPC calls", async () => {
    for (const tty of [
      { stdin: false, stdout: false },
      { stdin: true, stdout: false },
      { stdin: false, stdout: true },
    ]) {
      const f = fake(() => ({ id: "cap_x", state: "executed" }));
      const o = sink();
      const code = await runApprovalsWith(f.client, { verb: "approve", id: "cap_x" }, o.s, tty, 1);
      expect(code).toBe(1);
      expect(f.calls).toEqual([]);
      expect(o.err.join("")).toContain("requires an interactive terminal");
    }
  });

  test("with a TTY the wire is exactly declareKind then approvals.approve (one owner action)", async () => {
    const f = fake((m) =>
      m === "approvals.approve" ? { id: "cap_x", state: "executed", outcomeRef: "PROJ-1#7" } : {},
    );
    const o = sink();
    const code = await runApprovalsWith(f.client, { verb: "approve", id: "cap_x" }, o.s, TTY, 1);
    expect(code).toBe(0);
    expect(f.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["approvals.approve", { id: "cap_x" }],
    ]);
    expect(o.out.join("")).toBe("[ok] executed the action (PROJ-1#7)\n");
  });

  test("an executed result without a reference says so", async () => {
    const f = fake(() => ({ id: "cap_x", state: "executed" }));
    const o = sink();
    await runApprovalsWith(f.client, { verb: "approve", id: "cap_x" }, o.s, TTY, 1);
    expect(o.out.join("")).toContain("no outcome reference");
  });

  test("rejected with a reason prints it stripped; without one prints the declined line", async () => {
    const f = fake(() => ({ id: "cap_x", state: "rejected", reason: `refused${ESC}[0m: guard` }));
    const o = sink();
    expect(await runApprovalsWith(f.client, { verb: "approve", id: "cap_x" }, o.s, TTY, 1)).toBe(1);
    expect(o.out.join("")).toBe("[rejected] not executed: refused[0m: guard\n");
    const g = fake(() => ({ id: "cap_x", state: "rejected" }));
    const p = sink();
    await runApprovalsWith(g.client, { verb: "approve", id: "cap_x" }, p.s, TTY, 1);
    expect(p.out.join("")).toBe("[rejected] not executed — you declined the approval\n");
  });

  test.each([
    ["ERR_ACTION_TOOL_NOT_FOUND", "[failed] ERR_ACTION_TOOL_NOT_FOUND\n"],
    [
      "ERR_ACTION_DISPATCH",
      "[failed] ERR_ACTION_DISPATCH — the action may or may not have reached the service\n",
    ],
  ])("failed %s", async (errorCode, line) => {
    const f = fake(() => ({ id: "cap_x", state: "failed", errorCode }));
    const o = sink();
    expect(await runApprovalsWith(f.client, { verb: "approve", id: "cap_x" }, o.s, TTY, 1)).toBe(1);
    expect(o.out.join("")).toBe(line);
  });

  test("a thrown RPC error is stripped, exit 1", async () => {
    const f = fake((m) => {
      if (m === "approvals.approve") throw new Error(`ERR_CAPTURE_FORBIDDEN_CLIENT${ESC}[1m`);
      return {};
    });
    const o = sink();
    expect(await runApprovalsWith(f.client, { verb: "approve", id: "cap_x" }, o.s, TTY, 1)).toBe(1);
    expect(o.err.join("")).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT[1m\n");
  });

  test("a malformed result is an error, not a success line", async () => {
    const f = fake(() => ({ state: "weird" }));
    const o = sink();
    expect(await runApprovalsWith(f.client, { verb: "approve", id: "cap_x" }, o.s, TTY, 1)).toBe(1);
    expect(o.err.join("")).toContain("malformed");
  });
});

describe("approvals decline", () => {
  test("declines one id; needs no TTY", async () => {
    const f = fake((m) => (m === "approvals.decline" ? { id: "cap_x", state: "rejected" } : {}));
    const o = sink();
    const code = await runApprovalsWith(
      f.client,
      { verb: "decline", id: "cap_x", json: false },
      o.s,
      NO_TTY,
      1,
    );
    expect(code).toBe(0);
    expect(f.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["approvals.decline", { id: "cap_x" }],
    ]);
    expect(o.out.join("")).toContain("Declined cap_x");
  });

  test("--json prints the raw result; an error is {error}", async () => {
    const f = fake(() => ({ id: "cap_x", state: "rejected" }));
    const o = sink();
    await runApprovalsWith(f.client, { verb: "decline", id: "cap_x", json: true }, o.s, NO_TTY, 1);
    expect(JSON.parse(o.out.join(""))).toEqual({ id: "cap_x", state: "rejected" });
    const g = fake((m) => {
      if (m === "approvals.decline") throw new Error("ERR_CAPTURE_STATE: nope");
      return {};
    });
    const p = sink();
    expect(
      await runApprovalsWith(
        g.client,
        { verb: "decline", id: "cap_x", json: true },
        p.s,
        NO_TTY,
        1,
      ),
    ).toBe(1);
    expect(JSON.parse(p.out.join("")).error).toContain("ERR_CAPTURE_STATE");
  });
});

describe("approvals --decline-all-from", () => {
  const rows = [
    { ...ROW, id: "cap_1", label: "a b" },
    { ...ROW, id: "cap_2", label: "other" },
    { ...ROW, id: "cap_3", label: "a b" },
    { ...ROW, id: "cap_4", label: null },
    { ...ROW, id: "cap_5", label: String.raw`say \"hi\"` },
  ];

  function declineFake() {
    return fake((m) => {
      if (m === "approvals.list") return { proposals: rows };
      if (m === "approvals.decline") return { state: "rejected" };
      return {};
    });
  }

  test("declines exactly the rows with that label and prints a count", async () => {
    const f = declineFake();
    const o = sink();
    const code = await runApprovalsWith(
      f.client,
      { verb: "declineAll", label: "a b", json: false },
      o.s,
      NO_TTY,
      1,
    );
    expect(code).toBe(0);
    expect(f.calls.map(([m]) => m)).toEqual([
      "session.declareKind",
      "approvals.list",
      "approvals.decline",
      "approvals.decline",
    ]);
    expect(f.calls.slice(2).map(([, p]) => p)).toEqual([{ id: "cap_1" }, { id: "cap_3" }]);
    expect(o.out.join("")).toContain("Declined 2 proposals");
  });

  test("a label typed with quotes matches the gateway's escaped form", async () => {
    const f = declineFake();
    const o = sink();
    await runApprovalsWith(
      f.client,
      { verb: "declineAll", label: 'say "hi"', json: false },
      o.s,
      NO_TTY,
      1,
    );
    expect(f.calls.filter(([m]) => m === "approvals.decline")).toEqual([
      ["approvals.decline", { id: "cap_5" }],
    ]);
    expect(o.out.join("")).toContain("Declined 1 proposal ");
  });

  test("one argument never declines two differently-labelled agents: the typed form wins", async () => {
    // Declared labels `a"b` (wire `a\"b`) and `a\"b` (wire `a\\\"b`). The argument `a\"b` equals the
    // first one's wire form AND is the second one's declared label: only the declared match is declined.
    const bs = String.fromCodePoint(92);
    const wireOfQuote = `a${bs}"b`;
    const wireOfBackslashQuote = `a${bs}${bs}${bs}"b`;
    const f = fake((m) => {
      if (m === "approvals.list") {
        return {
          proposals: [
            { ...ROW, id: "cap_q", label: wireOfQuote },
            { ...ROW, id: "cap_bq", label: wireOfBackslashQuote },
          ],
        };
      }
      return { state: "rejected" };
    });
    const o = sink();
    await runApprovalsWith(
      f.client,
      { verb: "declineAll", label: wireOfQuote, json: false },
      o.s,
      NO_TTY,
      1,
    );
    expect(f.calls.filter(([m]) => m === "approvals.decline")).toEqual([
      ["approvals.decline", { id: "cap_bq" }],
    ]);
  });

  test("a label pasted as printed matches when no declared label equals it", async () => {
    const bs = String.fromCodePoint(92);
    const printed = `bot${bs}u202e`;
    const f = fake((m) => {
      if (m === "approvals.list") return { proposals: [{ ...ROW, id: "cap_p", label: printed }] };
      return { state: "rejected" };
    });
    const o = sink();
    await runApprovalsWith(
      f.client,
      { verb: "declineAll", label: printed, json: false },
      o.s,
      NO_TTY,
      1,
    );
    expect(f.calls.filter(([m]) => m === "approvals.decline")).toEqual([
      ["approvals.decline", { id: "cap_p" }],
    ]);
  });

  test("no match: nothing declined, says so, exit 0", async () => {
    const f = declineFake();
    const o = sink();
    expect(
      await runApprovalsWith(
        f.client,
        { verb: "declineAll", label: "zzz", json: false },
        o.s,
        NO_TTY,
        1,
      ),
    ).toBe(0);
    expect(f.calls.some(([m]) => m === "approvals.decline")).toBe(false);
    expect(o.out.join("")).toContain("No waiting proposal is labelled");
  });

  test("one failed decline does not stop the run; exit 1; --json lists results", async () => {
    let n = 0;
    const f = fake((m) => {
      if (m === "approvals.list") return { proposals: rows };
      if (m === "approvals.decline") {
        n += 1;
        if (n === 1) throw new Error("ERR_CAPTURE_STATE: gone");
        return { state: "rejected" };
      }
      return {};
    });
    const o = sink();
    const code = await runApprovalsWith(
      f.client,
      { verb: "declineAll", label: "a b", json: true },
      o.s,
      NO_TTY,
      1,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(o.out.join(""));
    expect(parsed.declined).toBe(1);
    expect(parsed.total).toBe(2);
    expect(parsed.results).toHaveLength(2);
  });

  test("a failing list is reported, exit 1", async () => {
    const f = fake((m) => {
      if (m === "approvals.list") throw new Error("ERR_CAPTURE_FORBIDDEN_CLIENT");
      return {};
    });
    const o = sink();
    expect(
      await runApprovalsWith(
        f.client,
        { verb: "declineAll", label: "x", json: false },
        o.s,
        NO_TTY,
        1,
      ),
    ).toBe(1);
  });
});

describe("source pins", () => {
  const src = readFileSync(join(import.meta.dir, "approvals.ts"), "utf8");

  test("imports nothing from llm/ (A4: the flow needs no model)", () => {
    expect(src).not.toMatch(/from ["'][^"']*\/llm\//);
  });

  test("the command connects with the human consent choice and the long budget", () => {
    expect(src).toContain('consent: { kind: "human" }');
    expect(src).toContain("BATCH_RPC_TIMEOUT_MS");
  });

  test("usage text names every form", () => {
    for (const form of ["show <id>", "<id> --decline", "--decline-all-from", "approvals <id>"]) {
      expect(APPROVALS_USAGE).toContain(form);
    }
  });
});

describe("AD3a-2a: the deprecation header and the per-row marker", () => {
  const HEADER = "Some proposals below were accepted without approval by name (deprecated)";

  test("list prints the header FIRST when the gateway sends one, and marks the legacy rows", async () => {
    const f = fake(() => ({
      deprecation: HEADER,
      proposals: [
        { ...ROW, id: "cap_old", legacy: true },
        { ...ROW, id: "cap_new", legacy: false },
      ],
    }));
    const o = sink();
    await runApprovalsWith(f.client, { verb: "list", json: false }, o.s, TTY, 2_000);
    const text = o.out.join("");
    expect(text.startsWith(HEADER)).toBe(true);
    const lines = text.split("\n");
    expect(lines.find((l) => l.includes("cap_old"))).toContain("deprecated");
    expect(lines.find((l) => l.includes("cap_new"))).not.toContain("deprecated");
  });

  test("no header when the gateway sends none", async () => {
    const f = fake(() => ({ proposals: [{ ...ROW, legacy: false }] }));
    const o = sink();
    await runApprovalsWith(f.client, { verb: "list", json: false }, o.s, TTY, 2_000);
    expect(o.out.join("")).not.toContain("deprecated");
  });

  test("the header is control-stripped; show prints it too", async () => {
    const f = fake((m) =>
      m === "approvals.get"
        ? { ...ROW, legacy: true, deprecation: `${HEADER}${ESC}[2J`, inputLines: [], note: "n" }
        : {},
    );
    const o = sink();
    await runApprovalsWith(
      f.client,
      { verb: "show", id: "cap_aaaa", json: false },
      o.s,
      TTY,
      2_000,
    );
    const text = o.out.join("");
    expect(text).toContain(HEADER);
    expect(text).not.toContain(ESC);
  });
});
