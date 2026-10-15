import { describe, expect, test } from "bun:test";
import {
  actionAcceptTtyRefusal,
  parseAcceptResult,
  parseCapturesArgs,
  runCapturesWith,
} from "./captures.ts";
import {
  doctorCapturesLines,
  formatCaptureDetail,
  formatCaptureTable,
  parseDetail,
  parseStatus,
  stripControl,
} from "./captures-format.ts";
import { doctorPrintCaptures } from "./doctor-core.ts";

const ROW = {
  id: "cap_1",
  kind: "note",
  state: "live",
  title: "Why WAL",
  clientLabel: "claude-code",
  createdAt: 1_000,
  decidedAt: null,
  expiresAt: null,
};

// Mirrors captures-format.ts's UNSAFE_TEXT_RANGES minus C0/C1 (asserted separately). Built from
// numeric code points at runtime: the format hook can rewrite regex escapes into the invisibles.
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
const HIDDEN_RE = new RegExp(
  HIDDEN_RANGES.map(([lo, hi]) => `[${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}]`).join(
    "|",
  ),
  "u",
);
const cp = (n: number): string => String.fromCodePoint(n);
const LRM = cp(0x200e);
const WJ = cp(0x2060);
const TAG_I = cp(0xe0069);
const VS16 = cp(0xfe0f);

function fake(impl: (m: string, p: unknown) => unknown) {
  const calls: Array<[string, unknown]> = [];
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

describe("parseCapturesArgs", () => {
  test.each([
    [[], { verb: "list", json: false }],
    [
      ["list", "--state", "revoked", "--kind", "note", "--json"],
      { verb: "list", state: "revoked", kind: "note", json: true },
    ],
    [["--state", "live"], { verb: "list", state: "live", json: false }],
    [["show", "cap_1"], { verb: "show", id: "cap_1", json: false }],
    [["revoke", "cap_1"], { verb: "revoke", id: "cap_1", json: false }],
    [["accept", "cap_1"], { verb: "accept", id: "cap_1", json: false }],
    [["reject", "cap_1", "--json"], { verb: "reject", id: "cap_1", json: true }],
    [["list", "--limit", "20"], { verb: "list", limit: 20, json: false }],
  ])("%j", (argv, want) => {
    expect(parseCapturesArgs(argv)).toEqual(want as never);
  });

  test.each([
    [["show"]],
    [["revoke"]],
    [["show", "--json"]],
    [["show", "a", "b"]],
    [["accept"]],
    [["accept", "a", "b"]],
    [["list", "--limit", "0"]],
    [["list", "--limit", "201"]],
    [["list", "--limit", "x"]],
    [["list", "--limit", "1.5"]],
    [["list", "--state"]],
    [["list", "--bogus", "x"]],
  ])("usage error: %j", (argv) => {
    expect(parseCapturesArgs(argv)).toBeUndefined();
  });
});

describe("runCapturesWith", () => {
  test("list prints a table and exits 0; filters are forwarded", async () => {
    const { client, calls } = fake(() => ({ captures: [ROW] }));
    const { out, s } = sink();
    expect(await runCapturesWith(client, { verb: "list", json: false }, s)).toBe(0);
    expect(calls).toEqual([["captures.list", {}]]);
    expect(out.join("")).toContain("cap_1");
    expect(out.join("")).toContain("Why WAL");
    const f = fake(() => ({ captures: [] }));
    await runCapturesWith(
      f.client,
      { verb: "list", state: "live", kind: "note", json: false },
      sink().s,
    );
    expect(f.calls).toEqual([["captures.list", { state: "live", kind: "note" }]]);
  });

  test("Review Focus 1: control characters in agent-supplied strings never reach the terminal", async () => {
    const evil = { ...ROW, title: "x\u001b[2J\u001b]0;pwned\u0007y", clientLabel: "c\u001b[31m" };
    const { client } = fake(() => ({ captures: [evil] }));
    const { out, s } = sink();
    await runCapturesWith(client, { verb: "list", json: false }, s);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no control char survives.
    expect(out.join("")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  test("bidi override in a title never reaches the terminal (list and show)", async () => {
    const evil = {
      ...ROW,
      title: `safe${cp(0x202e)}gnp${LRM}.${WJ}exe${TAG_I}${VS16}`,
      clientLabel: `a${cp(0x2066)}b${cp(0x200b)}c`,
    };
    // Self-check: the fixture really carries what HIDDEN_RE matches, so the assertions bite.
    for (const ch of [cp(0x202e), LRM, WJ, TAG_I, VS16]) expect(ch).toMatch(HIDDEN_RE);
    const l = sink();
    await runCapturesWith(
      fake(() => ({ captures: [evil] })).client,
      { verb: "list", json: false },
      l.s,
    );
    expect(l.out.join("")).toContain("safegnp.exe");
    expect(l.out.join("")).not.toMatch(HIDDEN_RE);
    const d = sink();
    const detail = {
      ...evil,
      payload: { body: `x${cp(0x202e)}y${LRM}${WJ}${TAG_I}${VS16}` },
      payloadBytes: 3,
      itemId: null,
      nativeRef: null,
    };
    await runCapturesWith(
      fake(() => detail).client,
      { verb: "show", id: "cap_1", json: false },
      d.s,
    );
    expect(d.out.join("")).not.toMatch(HIDDEN_RE);
  });

  test("revoke prints confirmation; a refusal prints the code and exits 1", async () => {
    const ok = fake(() => ({ id: "cap_1", state: "revoked" }));
    const a = sink();
    expect(
      await runCapturesWith(ok.client, { verb: "revoke", id: "cap_1", json: false }, a.s),
    ).toBe(0);
    expect(a.out.join("")).toContain("Revoked cap_1");
    const bad = fake(() => {
      throw new Error("ERR_CAPTURE_NOT_FOUND: no capture cap_9");
    });
    const b = sink();
    expect(
      await runCapturesWith(bad.client, { verb: "revoke", id: "cap_9", json: false }, b.s),
    ).toBe(1);
    expect(b.err.join("")).toContain("ERR_CAPTURE_NOT_FOUND");
  });

  test("a refusal message is printed with control and bidi characters stripped", async () => {
    // Code points, not literals or escapes: the format hook can rewrite escapes into invisibles.
    const ESC = String.fromCodePoint(0x1b);
    const RLO = String.fromCodePoint(0x202e);
    const bad = fake(() => {
      throw new Error(`ERR_CAPTURE_SUPERSEDED: the term "${ESC}[31mW${RLO}AL"`);
    });
    const b = sink();
    expect(
      await runCapturesWith(bad.client, { verb: "accept", id: "cap_1", json: false }, b.s),
    ).toBe(1);
    const printed = b.err.join("");
    expect(printed).toContain("ERR_CAPTURE_SUPERSEDED");
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain(RLO);
    expect(printed).toContain('the term "[31mWAL"');
  });

  test("--json prints raw JSON, and an error as {error}", async () => {
    const { client } = fake(() => ({ captures: [ROW] }));
    const { out, s } = sink();
    await runCapturesWith(client, { verb: "list", json: true }, s);
    expect(JSON.parse(out.join(""))).toEqual({ captures: [ROW] });
    const bad = fake(() => {
      throw new Error("ERR_CAPTURE_STATE: x");
    });
    const b = sink();
    expect(await runCapturesWith(bad.client, { verb: "show", id: "cap_1", json: true }, b.s)).toBe(
      1,
    );
    expect(JSON.parse(b.out.join(""))).toEqual({ error: "ERR_CAPTURE_STATE: x" });
  });

  test("json output for show and revoke is raw", async () => {
    const r = sink();
    await runCapturesWith(
      fake(() => ({ id: "cap_1", state: "revoked" })).client,
      { verb: "revoke", id: "cap_1", json: true },
      r.s,
    );
    expect(JSON.parse(r.out.join(""))).toEqual({ id: "cap_1", state: "revoked" });
    const d = sink();
    const detail = { ...ROW, payload: null, payloadBytes: 0, itemId: null, nativeRef: null };
    await runCapturesWith(
      fake(() => detail).client,
      { verb: "show", id: "cap_1", json: true },
      d.s,
    );
    expect(JSON.parse(d.out.join("")).id).toBe("cap_1");
  });

  test("show prints the agent-authored banner and the payload", async () => {
    const { client } = fake(() => ({
      ...ROW,
      decidedAt: 2_000,
      payload: { title: "Why WAL", body: "Because", tags: ["a"] },
      payloadBytes: 9,
      itemId: "nimbus:cap_1",
      nativeRef: null,
    }));
    const { out, s } = sink();
    await runCapturesWith(client, { verb: "show", id: "cap_1", json: false }, s);
    expect(out.join("")).toContain("Agent-authored");
    expect(out.join("")).toContain("Because");
    expect(out.join("")).toContain("Item: nimbus:cap_1");
    expect(out.join("")).toContain("Decided:");
  });

  test("show of a revoked capture (null payload, null label) says the payload was cleared", async () => {
    const { client } = fake(() => ({
      ...ROW,
      clientLabel: null,
      state: "revoked",
      payload: null,
      payloadBytes: 0,
      itemId: null,
      nativeRef: null,
    }));
    const { out, s } = sink();
    await runCapturesWith(client, { verb: "show", id: "cap_1", json: false }, s);
    expect(out.join("")).toContain("payload cleared");
    expect(out.join("")).toContain("an unnamed MCP client");
  });

  test("a malformed response is reported as an error, exit 1", async () => {
    const { client } = fake(() => ({ nope: true }));
    const { err, s } = sink();
    expect(await runCapturesWith(client, { verb: "list", json: false }, s)).toBe(1);
    expect(err.join("")).toContain("malformed");
  });

  test("a non-Error throw is stringified", async () => {
    const client = {
      call: async <T>(): Promise<T> => {
        throw "boom";
      },
    };
    const { err, s } = sink();
    expect(await runCapturesWith(client, { verb: "list", json: false }, s)).toBe(1);
    expect(err.join("")).toContain("boom");
  });
});

describe("doctor", () => {
  const BASE = {
    enabled: true,
    kinds: ["note"],
    pending: 0,
    maxPending: 100,
    maxPerHour: 30,
    refusedSinceStart: {},
    actionEnabled: false,
    actionPending: 0,
    actionMaxPending: 0,
    actionExpiringWithinHour: 0,
  };

  test("disabled → nothing printed, exit 0", () => {
    expect(doctorCapturesLines({ ...BASE, enabled: false, disabledReason: "config" })).toEqual({
      lines: [],
      exit: 0,
    });
  });

  test("enabled quiet → one ok line", () => {
    expect(doctorCapturesLines(BASE).lines).toEqual([
      "[ok] MCP capture sink: on (kinds: note). Review with `nimbus captures`.",
    ]);
  });

  test("pending below the cap → info line, exit 0", () => {
    const r = doctorCapturesLines({ ...BASE, pending: 3 });
    expect(r.exit).toBe(0);
    expect(r.lines.join("\n")).toContain("3 captures awaiting review");
  });

  test("queue full → warning, exit 1", () => {
    const r = doctorCapturesLines({ ...BASE, pending: 100 });
    expect(r.exit).toBe(1);
    expect(r.lines.join("\n")).toContain("capture queue full (100/100)");
  });

  test("refusals since start → info line naming codes and counts, but exit 0 (history, not a fault)", () => {
    const r = doctorCapturesLines({ ...BASE, refusedSinceStart: { ERR_CAPTURE_RATE_LIMITED: 4 } });
    expect(r.exit).toBe(0);
    expect(r.lines.join("\n")).toContain("[info]");
    expect(r.lines.join("\n")).toContain("ERR_CAPTURE_RATE_LIMITED×4");
  });

  test("policy lock-off → info line, exit 0", () => {
    expect(doctorCapturesLines({ ...BASE, enabled: false, disabledReason: "policy" })).toEqual({
      lines: ["[info] MCP capture sink: locked off by org policy (mcp_capture)."],
      exit: 0,
    });
  });

  test("config_error → warning, exit 1", () => {
    const r = doctorCapturesLines({ ...BASE, enabled: false, disabledReason: "config_error" });
    expect(r.exit).toBe(1);
    expect(r.lines[0]).toContain("[mcp_sink] is invalid");
  });

  test("doctorPrintCaptures: Method not found is quiet", async () => {
    const { client } = fake(() => {
      throw Object.assign(new Error("nope"), { code: -32601 });
    });
    expect(await doctorPrintCaptures(client)).toBe(0);
  });

  test("doctorPrintCaptures: other RPC failure and malformed response warn, exit 1", async () => {
    const a = fake(() => {
      throw new Error("down");
    });
    expect(await doctorPrintCaptures(a.client)).toBe(1);
    const b = fake(() => "garbage");
    expect(await doctorPrintCaptures(b.client)).toBe(1);
  });

  test("doctorPrintCaptures: healthy status exits 0", async () => {
    const { client } = fake(() => ({
      ...BASE,
      refusedSinceStart: { X: "bad", ERR_A: 1 },
      disabledReason: "config",
    }));
    expect(await doctorPrintCaptures(client)).toBe(0);
  });
});

describe("stripControl / formatCaptureTable", () => {
  test("strip keeps printable text", () => {
    expect(stripControl("a\u001bb\nc")).toBe("abc");
  });

  test("strip removes bidi, zero-width and line-separator characters", () => {
    expect(stripControl("a\u202Eb\u2066c\u200Bd\uFEFFe\u2028f\u2029g")).toBe("abcdefg");
  });

  test.each([
    ["LRM", 0x200e],
    ["word joiner", 0x2060],
    ["soft hyphen", 0x00ad],
    ["Arabic letter mark", 0x061c],
    ["combining grapheme joiner", 0x034f],
    ["Hangul filler", 0x3164],
    ["variation selector 16", 0xfe0f],
    ["TAG LATIN SMALL LETTER I", 0xe0069],
    ["supplementary variation selector", 0xe0100],
    ["interlinear annotation anchor", 0xfff9],
  ])("strip removes %s", (_n, code) => {
    expect(stripControl(`a${cp(code)}b`)).toBe("ab");
  });

  test("strip keeps ordinary non-ASCII text, astral included", () => {
    const text = `caf${cp(0xe9)} ${cp(0x2014)} ok ${cp(0x2192)} ${cp(0x1f600)}`;
    expect(stripControl(text)).toBe(text);
  });

  test("detail keeps line structure of a multi-line value, stripping each line", () => {
    const out = formatCaptureDetail({
      id: "cap_1",
      kind: "note",
      state: "live",
      title: "T",
      clientLabel: null,
      createdAt: 0,
      decidedAt: null,
      payload: { title: "one\u001b", body: "first line\r\n\tsecond \u202Eline" },
      payloadBytes: 10,
      itemId: null,
      nativeRef: null,
      nativeStatus: null,
      expiresAt: null,
      outcomeRef: null,
      errorCode: null,
    });
    const lines = out.split("\n");
    expect(lines).toContain("title: one");
    const i = lines.indexOf("body:");
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe("  first line");
    expect(lines[i + 2]).toBe("    second line");
  });

  test("table has a header row", () => {
    expect(formatCaptureTable([], 0)).toContain("ID");
  });

  test("table renders relative ages", () => {
    const mk = (createdAt: number) => ({ ...ROW, createdAt, title: "t".repeat(80) });
    const now = 10_000_000_000;
    const t = formatCaptureTable(
      [mk(now - 5_000), mk(now - 600_000), mk(now - 7_200_000), mk(now - 200_000_000)],
      now,
    );
    expect(t).toContain("5s ago");
    expect(t).toContain("10m ago");
    expect(t).toContain("2h ago");
    expect(t).toContain("2d ago");
  });
});

describe("accept / reject / limit / native status", () => {
  test.each([
    ["capture:abc", "decision"],
    ["a|b", "link"],
    ["term-1", "glossary term"],
  ])("accept %s prints a %s noun", async (nativeRef, noun) => {
    const f = fake(() => ({ id: "cap_1", state: "accepted", nativeRef }));
    const o = sink();
    expect(await runCapturesWith(f.client, { verb: "accept", id: "cap_1", json: false }, o.s)).toBe(
      0,
    );
    expect(f.calls).toEqual([
      ["captures.get", { id: "cap_1" }],
      ["captures.accept", { id: "cap_1" }],
    ]);
    expect(o.out.join("")).toBe(
      `Accepted cap_1: it now counts as a ${noun} (${nativeRef}) and is labelled agent-authored.
`,
    );
  });

  test("reject prints the retention note; --json is raw; refusal exits 1", async () => {
    const f = fake(() => ({ id: "cap_1", state: "rejected" }));
    const o = sink();
    expect(await runCapturesWith(f.client, { verb: "reject", id: "cap_1", json: false }, o.s)).toBe(
      0,
    );
    expect(f.calls[0]).toEqual(["captures.reject", { id: "cap_1" }]);
    expect(o.out.join("")).toBe(
      "Rejected cap_1. Nothing was written; the record is kept 90 days, then pruned.\n",
    );
    const j = sink();
    await runCapturesWith(f.client, { verb: "reject", id: "cap_1", json: true }, j.s);
    expect(JSON.parse(j.out.join(""))).toEqual({ id: "cap_1", state: "rejected" });
    const aj = sink();
    await runCapturesWith(
      fake(() => ({ id: "cap_1", state: "accepted", nativeRef: "capture:x" })).client,
      { verb: "accept", id: "cap_1", json: true },
      aj.s,
    );
    expect(JSON.parse(aj.out.join("")).state).toBe("accepted");
    const bad = fake(() => {
      throw new Error("ERR_CAPTURE_STATE: not proposed");
    });
    const b = sink();
    expect(
      await runCapturesWith(bad.client, { verb: "accept", id: "cap_1", json: false }, b.s),
    ).toBe(1);
    expect(b.err.join("")).toContain("ERR_CAPTURE_STATE");
  });

  test("list --limit forwards limit", async () => {
    const f = fake(() => ({ captures: [] }));
    await runCapturesWith(f.client, { verb: "list", limit: 20, json: false }, sink().s);
    expect(f.calls[0]).toEqual(["captures.list", { limit: 20 }]);
  });

  const base = {
    ...ROW,
    payload: { a: "b" },
    payloadBytes: 3,
    itemId: "nimbus:cap_1",
    nativeRef: null,
  };
  test.each([
    [
      "superseded",
      "Superseded: a later accepted capture or the owner's own entry now owns this; revoking this capture leaves it in place.",
    ],
    ["absent", "Native row: gone (removed since it was accepted)."],
    ["owned", "Native row: present and owned by this capture."],
  ] as const)("formatCaptureDetail nativeStatus %s", (ns, line) => {
    expect(formatCaptureDetail({ ...parseDetail({ ...base, nativeStatus: ns }) })).toContain(line);
  });

  test("null / unknown nativeStatus prints nothing extra", () => {
    expect(parseDetail({ ...base, nativeStatus: "weird" }).nativeStatus).toBeNull();
    expect(parseDetail(base).nativeStatus).toBeNull();
    const t = formatCaptureDetail(parseDetail({ ...base, nativeStatus: null }));
    expect(t).not.toContain("Native row");
    expect(t).not.toContain("Superseded");
  });
});

describe("accept with a malformed result", () => {
  test.each([
    [null],
    [{}],
    [{ nativeRef: 5 }],
    [{ state: "accepted", nativeRef: "" }],
    [{ state: "proposed", nativeRef: "capture:x" }],
  ])("%j is refused with exit 1", async (raw) => {
    const o = sink();
    expect(
      await runCapturesWith(fake(() => raw).client, { verb: "accept", id: "c", json: false }, o.s),
    ).toBe(1);
    expect(o.out.join("")).not.toContain("Accepted");
    expect(o.err.join("")).toContain("malformed");
  });

  test("--json prints {error} for a malformed result", async () => {
    const o = sink();
    expect(
      await runCapturesWith(fake(() => ({})).client, { verb: "accept", id: "c", json: true }, o.s),
    ).toBe(1);
    expect(JSON.parse(o.out.join("")).error).toContain("malformed");
  });
});

describe("captures accept — act door", () => {
  const TTY = { stdin: true, stdout: true };
  const ACTION = { kind: "action", payload: { actionType: "slack.message.post" } };

  test("TTY guard: only for actions; both streams required (Review Focus 4)", () => {
    expect(actionAcceptTtyRefusal("decision", { stdin: false, stdout: false })).toBeUndefined();
    expect(actionAcceptTtyRefusal("action", { stdin: true, stdout: true })).toBeUndefined();
    expect(actionAcceptTtyRefusal("action", { stdin: false, stdout: true })).toBe(
      "nimbus captures accept requires an interactive terminal (TTY) to approve an agent-proposed action.",
    );
    expect(actionAcceptTtyRefusal("action", { stdin: true, stdout: false })).toBeDefined();
  });

  test.each([
    [{ id: "cap_1", state: "executed", outcomeRef: "https://x/1" }, 0, "[ok] executed"],
    [{ id: "cap_1", state: "executed" }, 0, "no outcome reference"],
    [{ id: "cap_1", state: "rejected" }, 1, "[rejected] not executed — you declined the approval"],
    [
      { id: "cap_1", state: "failed", errorCode: "ERR_ACTION_TIMEOUT" },
      1,
      "may or may not have reached",
    ],
    [
      { id: "cap_1", state: "failed", errorCode: "ERR_ACTION_TOOL_NOT_FOUND" },
      1,
      "[failed] ERR_ACTION_TOOL_NOT_FOUND",
    ],
  ])("result %p → exit %d, says %p", async (raw, exit, text) => {
    const out: string[] = [];
    const c = { call: (m: string) => Promise.resolve(m === "captures.accept" ? raw : ACTION) };
    const code = await runCapturesWith(
      c as never,
      { verb: "accept", id: "cap_1", json: false },
      { out: (s) => out.push(s), err: (s) => out.push(s) },
      TTY,
    );
    expect(code).toBe(exit);
    expect(out.join("")).toContain(text);
  });

  test("executed names the action type and the outcome reference", async () => {
    const out: string[] = [];
    const c = {
      call: (m: string) =>
        Promise.resolve(
          m === "captures.accept"
            ? { id: "cap_1", state: "executed", outcomeRef: "https://x/1" }
            : ACTION,
        ),
    };
    await runCapturesWith(
      c as never,
      { verb: "accept", id: "cap_1", json: false },
      { out: (s) => out.push(s), err: (s) => out.push(s) },
      TTY,
    );
    expect(out.join("")).toBe("[ok] executed slack.message.post (https://x/1)\n");
  });

  test("an ambiguous failure names the service", async () => {
    const out: string[] = [];
    const c = {
      call: (m: string) =>
        Promise.resolve(
          m === "captures.accept"
            ? { id: "cap_1", state: "failed", errorCode: "ERR_ACTION_DISPATCH" }
            : ACTION,
        ),
    };
    await runCapturesWith(
      c as never,
      { verb: "accept", id: "cap_1", json: false },
      { out: (s) => out.push(s), err: (s) => out.push(s) },
      TTY,
    );
    expect(out.join("")).toBe(
      "[failed] ERR_ACTION_DISPATCH — the action may or may not have reached slack\n",
    );
  });

  test("failed ERR_ACTION_TOOL_NOT_FOUND does NOT claim it may have reached the service", async () => {
    const out: string[] = [];
    const c = {
      call: (m: string) =>
        Promise.resolve(
          m === "captures.accept"
            ? { id: "cap_1", state: "failed", errorCode: "ERR_ACTION_TOOL_NOT_FOUND" }
            : ACTION,
        ),
    };
    await runCapturesWith(
      c as never,
      { verb: "accept", id: "cap_1", json: false },
      { out: (s) => out.push(s), err: (s) => out.push(s) },
      TTY,
    );
    expect(out.join("")).not.toContain("may or may not");
  });

  test("--json prints the raw action result with the same exit code", async () => {
    const out: string[] = [];
    const raw = { id: "cap_1", state: "rejected" };
    const c = { call: (m: string) => Promise.resolve(m === "captures.accept" ? raw : ACTION) };
    const code = await runCapturesWith(
      c as never,
      { verb: "accept", id: "cap_1", json: true },
      { out: (s) => out.push(s), err: (s) => out.push(s) },
      TTY,
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(""))).toEqual(raw);
  });

  test.each([
    ["piped stdin", { stdin: false, stdout: true }],
    ["redirected stdout", { stdin: true, stdout: false }],
    ["no tty info (default)", undefined],
  ])(
    "action accept with %s refuses BEFORE captures.accept is called (Review Focus 4)",
    async (_n, tty) => {
      const calls: string[] = [];
      const err: string[] = [];
      const c = {
        call: (m: string) => {
          calls.push(m);
          return Promise.resolve(ACTION);
        },
      };
      const code = await runCapturesWith(
        c as never,
        { verb: "accept", id: "cap_1", json: false },
        { out: () => {}, err: (s) => err.push(s) },
        tty,
      );
      expect(code).toBe(1);
      expect(calls).toEqual(["captures.get"]);
      expect(err.join("")).toContain("requires an interactive terminal");
    },
  );

  test("a failed captures.get fails the accept closed: no captures.accept call", async () => {
    const calls: string[] = [];
    const c = {
      call: (m: string) => {
        calls.push(m);
        return Promise.reject(new Error("Capture not found"));
      },
    };
    expect(
      await runCapturesWith(
        c as never,
        { verb: "accept", id: "cap_1", json: false },
        { out: () => {}, err: () => {} },
        TTY,
      ),
    ).toBe(1);
    expect(calls).toEqual(["captures.get"]);
  });

  test("a native accept with piped stdin still works (the guard is action-only)", async () => {
    const c = {
      call: (m: string) =>
        Promise.resolve(
          m === "captures.accept"
            ? { id: "cap_1", state: "accepted", nativeRef: "capture:cap_1" }
            : { kind: "decision", payload: {} },
        ),
    };
    expect(
      await runCapturesWith(
        c as never,
        { verb: "accept", id: "cap_1", json: false },
        { out: () => {}, err: () => {} },
      ),
    ).toBe(0);
  });

  test("native accept is unchanged", async () => {
    const out: string[] = [];
    const c = {
      call: () => Promise.resolve({ id: "cap_1", state: "accepted", nativeRef: "capture:cap_1" }),
    };
    expect(
      await runCapturesWith(
        c as never,
        { verb: "accept", id: "cap_1", json: false },
        { out: (s) => out.push(s), err: () => {} },
      ),
    ).toBe(0);
    expect(out.join("")).toContain("now counts as a decision");
  });

  test("a malformed result still errors", async () => {
    const c = { call: () => Promise.resolve({ state: "weird" }) };
    expect(
      await runCapturesWith(
        c as never,
        { verb: "accept", id: "cap_1", json: false },
        { out: () => {}, err: () => {} },
      ),
    ).toBe(1);
  });

  test("parseAcceptResult: failed without a code and executed with a non-string ref", () => {
    expect(() => parseAcceptResult({ state: "failed" })).toThrow("malformed");
    expect(parseAcceptResult({ state: "executed", outcomeRef: 5 })).toEqual({ state: "executed" });
  });

  test.each([
    [
      "already swept to expired",
      "ERR_CAPTURE_STATE: capture cap_1 is expired; only a proposed action can be accepted",
    ],
    [
      "due but unswept",
      "ERR_CAPTURE_EXPIRED: capture cap_1 expired; ask the agent to propose it again",
    ],
  ])(
    "an expired action (%s) prints the gateway's refusal naming the state, exit 1",
    async (_n, msg) => {
      const err: string[] = [];
      const c = {
        call: (m: string) =>
          m === "captures.accept" ? Promise.reject(new Error(msg)) : Promise.resolve(ACTION),
      };
      expect(
        await runCapturesWith(
          c as never,
          { verb: "accept", id: "cap_1", json: false },
          { out: () => {}, err: (s) => err.push(s) },
          TTY,
        ),
      ).toBe(1);
      expect(err.join("")).toBe(`${msg}\n`);
    },
  );

  test("doctor: action pending line", () => {
    const { lines } = doctorCapturesLines({
      enabled: true,
      kinds: ["action"],
      pending: 0,
      maxPending: 100,
      maxPerHour: 30,
      refusedSinceStart: {},
      actionEnabled: true,
      actionPending: 3,
      actionMaxPending: 10,
      actionExpiringWithinHour: 1,
    });
    expect(lines).toContain(
      "[info] MCP capture sink: 3 agent-proposed actions awaiting review (1 expire within 1h) — nimbus captures",
    );
  });

  test("doctor: action queue full → warning, exit 1 (mirrors the native queue-full line)", () => {
    const { lines, exit } = doctorCapturesLines({
      enabled: true,
      kinds: ["action"],
      pending: 0,
      maxPending: 100,
      maxPerHour: 30,
      refusedSinceStart: {},
      actionEnabled: true,
      actionPending: 10,
      actionMaxPending: 10,
      actionExpiringWithinHour: 0,
    });
    expect(exit).toBe(1);
    expect(lines).toContain(
      "[warn] MCP capture sink: action queue full (10/10): new action proposals are being refused — nimbus captures",
    );
    expect(lines.some((l) => l.includes("awaiting review"))).toBe(false);
  });

  test("doctor: an older gateway's status (no action fields) parses to act door off, no line", () => {
    const st = parseStatus({
      enabled: true,
      kinds: ["note"],
      pending: 0,
      maxPending: 100,
      maxPerHour: 30,
    });
    expect(st).toMatchObject({
      actionEnabled: false,
      actionPending: 0,
      actionMaxPending: 0,
      actionExpiringWithinHour: 0,
    });
    expect(doctorCapturesLines(st).lines).toEqual([
      "[ok] MCP capture sink: on (kinds: note). Review with `nimbus captures`.",
    ]);
  });
});

describe("action list / show formatting", () => {
  const ACT = {
    id: "cap_a",
    kind: "action",
    state: "proposed",
    title: "slack.message.post: tell the team",
    clientLabel: "agent",
    createdAt: 0,
    decidedAt: null,
  };

  test("a proposed action's STATE cell shows its expiry; other rows are unchanged", () => {
    const now = 1_000_000;
    const t = formatCaptureTable(
      [
        { ...ACT, expiresAt: now + 3 * 3_600_000 },
        { ...ACT, state: "executed", expiresAt: now + 60_000 },
        { ...ROW, expiresAt: null },
      ],
      now,
    );
    const lines = t.split("\n");
    expect(lines[1]).toContain("exp 3h");
    expect(lines[2]).toContain("executed");
    expect(lines[2]).not.toContain("exp ");
    expect(lines[3]).toContain("live");
  });

  test("an expiry already past (not yet swept) reads as exp 0s, never negative", () => {
    expect(formatCaptureTable([{ ...ACT, expiresAt: 0 }], 10_000)).toContain("exp 0s");
  });

  test("parseList / parseDetail read the new fields leniently", () => {
    const d = parseDetail({
      ...ACT,
      expiresAt: "soon",
      outcomeRef: 3,
      errorCode: null,
      payload: null,
      payloadBytes: 0,
    });
    expect(d.expiresAt).toBeNull();
    expect(d.outcomeRef).toBeNull();
    expect(d.errorCode).toBeNull();
  });

  test("show of an action prints Expires/Outcome/Error, the full input JSON and a labelled summary", () => {
    const out = formatCaptureDetail(
      parseDetail({
        ...ACT,
        state: "failed",
        expiresAt: 86_400_000,
        outcomeRef: "https://x/1",
        errorCode: "ERR_ACTION_TIMEOUT",
        payload: {
          actionType: "slack.message.post",
          input: { channel: "C1", text: `hi${cp(0x202e)}there`, nested: { a: [1, 2] } },
          summary: "tell the team",
        },
        payloadBytes: 10,
      }),
    );
    const lines = out.split("\n");
    expect(lines).toContain("Expires: 1970-01-02T00:00:00.000Z");
    expect(lines).toContain("Outcome: https://x/1");
    expect(lines).toContain("Error: ERR_ACTION_TIMEOUT");
    expect(lines).toContain("actionType: slack.message.post");
    expect(lines).toContain("summary (agent-written, unverified): tell the team");
    const i = lines.indexOf("input:");
    expect(lines.slice(i + 1, i + 10)).toEqual([
      "  {",
      '    "channel": "C1",',
      '    "text": "hithere",',
      '    "nested": {',
      '      "a": [',
      "        1,",
      "        2",
      "      ]",
      "    }",
    ]);
    expect(out).not.toMatch(HIDDEN_RE);
  });

  test("a non-action never prints Expires and keeps the plain summary label", () => {
    const out = formatCaptureDetail(
      parseDetail({ ...ROW, expiresAt: 5, payload: { summary: "s" }, payloadBytes: 1 }),
    );
    expect(out).not.toContain("Expires:");
    expect(out).toContain("summary: s");
  });
});
