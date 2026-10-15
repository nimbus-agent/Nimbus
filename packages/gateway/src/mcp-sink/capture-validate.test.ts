import { describe, expect, test } from "bun:test";

import { CAPTURED_RELATION_TYPES } from "../graph/relationship-graph.ts";
import { BODY_MAX_PROSE } from "../index/body-caps.ts";
import {
  CAPTURE_KINDS,
  CAPTURE_STATES,
  CaptureError,
  isCaptureKind,
  isCaptureState,
  LINK_RELATIONS,
} from "./capture-types.ts";
import {
  referencedItemIds,
  sanitizeClientLabel,
  validateCapturePayload,
  validateNotePayload,
} from "./capture-validate.ts";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected a CaptureError");
}

describe("validateNotePayload", () => {
  test("rebuilds from named fields only — unknown sibling keys never survive", () => {
    const p = validateNotePayload({ title: "t", body: "b", junk: "x", __proto__: { evil: 1 } });
    expect(p).toEqual({ title: "t", body: "b", tags: [], relatesTo: [] });
    expect(Object.keys(p).sort()).toEqual(["body", "relatesTo", "tags", "title"]);
  });

  test("prose truncates: title at 200, body at BODY_MAX_PROSE", () => {
    const p = validateNotePayload({
      title: "t".repeat(500),
      body: "b".repeat(BODY_MAX_PROSE + 10),
    });
    expect(p.title).toHaveLength(200);
    expect(p.body).toHaveLength(BODY_MAX_PROSE);
  });

  test("a max-length NON-ASCII body truncates instead of tripping the 64 KiB payload cap", () => {
    const p = validateNotePayload({ title: "日本", body: "語".repeat(BODY_MAX_PROSE + 100) });
    expect(p.body).toHaveLength(BODY_MAX_PROSE);
  });

  test("an empty or missing title becomes (untitled)", () => {
    expect(validateNotePayload({ title: "   ", body: "b" }).title).toBe("(untitled)");
    expect(validateNotePayload({ body: "b" }).title).toBe("(untitled)");
  });

  test.each([
    ["not an object", "x"],
    ["null", null],
    ["an array", []],
    ["missing body", { title: "t" }],
    ["blank body", { title: "t", body: "  \n " }],
    ["non-string body", { title: "t", body: 3 }],
    ["non-string title", { title: 3, body: "b" }],
    ["11 tags", { body: "b", tags: Array.from({ length: 11 }, (_, i) => `t${String(i)}`) }],
    ["a 51-char tag", { body: "b", tags: ["x".repeat(51)] }],
    ["a non-string tag", { body: "b", tags: [1] }],
    ["tags not an array", { body: "b", tags: "a" }],
    [
      "11 relatesTo",
      { body: "b", relatesTo: Array.from({ length: 11 }, (_, i) => `github:${String(i)}`) },
    ],
    ["an empty relatesTo id", { body: "b", relatesTo: [""] }],
    ["relatesTo not an array", { body: "b", relatesTo: "github:1" }],
  ])("structured fields REFUSE: %s", (_n, raw) => {
    expect(code(() => validateNotePayload(raw))).toBe("ERR_CAPTURE_INVALID");
  });

  test("a rebuilt payload over 64 KiB of UTF-8 JSON refuses", () => {
    // Every field at its cap in 3-byte characters: 16384*3 + 10*512*3 + 10*50*3 + 200*3 > 65536.
    const refs = Array.from({ length: 10 }, (_, i) => `${String(i)}${"語".repeat(511)}`);
    const tags = Array.from({ length: 10 }, (_, i) => `${String(i)}${"語".repeat(49)}`);
    expect(
      code(() =>
        validateNotePayload({
          title: "語".repeat(200),
          body: "語".repeat(BODY_MAX_PROSE),
          tags,
          relatesTo: refs,
        }),
      ),
    ).toBe("ERR_CAPTURE_INVALID");
  });

  test("control characters are stripped at write time: all of them in the title, all but \\t\\n\\r in the body", () => {
    const p = validateNotePayload({
      title: "a\u001b[2Jb\nc",
      body: "x\u001b]0;pwn\u0007y\n\tz\r\n",
    });
    expect(p.title).toBe("a[2Jbc");
    expect(p.body).toBe("x]0;pwny\n\tz\r\n");
  });

  test("a body made only of control characters is empty, so refused", () => {
    expect(code(() => validateNotePayload({ body: "\u001b\u0007" }))).toBe("ERR_CAPTURE_INVALID");
  });

  test("tags and relatesTo are trimmed and de-duplicated, order kept", () => {
    const p = validateNotePayload({ body: "b", tags: [" a", "a", "b"], relatesTo: ["x:1", "x:1"] });
    expect(p.tags).toEqual(["a", "b"]);
    expect(p.relatesTo).toEqual(["x:1"]);
  });
});

describe("free-text lists strip invisible and bidi characters", () => {
  const ZWSP = String.fromCodePoint(0x200b);
  const RLO = String.fromCodePoint(0x202e);

  test("a synonym W+ZWSP+AL is stored as WAL; an RLO is removed", () => {
    const v = validateCapturePayload(
      "term",
      {
        term: "t",
        definition: "d",
        synonyms: [`W${ZWSP}AL`, `a${RLO}b`, `${ZWSP}`, "WAL"],
      },
      NOW,
    );
    if (v.kind !== "term") throw new Error("kind");
    expect(v.payload.synonyms).toEqual(["WAL", "ab"]);
  });

  test("a tag with a zero-width space is stored without it; one that becomes empty is dropped", () => {
    const p = validateNotePayload({ body: "b", tags: [`t${ZWSP}ag`, ZWSP, "  "] });
    expect(p.tags).toEqual(["tag"]);
  });
});

describe("sanitizeClientLabel", () => {
  test("strips control characters and truncates to 100", () => {
    expect(sanitizeClientLabel("claude\u001b[31m-code\n")).toBe("claude[31m-code");
    expect(sanitizeClientLabel("x".repeat(150))).toHaveLength(100);
  });

  test("non-strings and empty labels become null", () => {
    expect(sanitizeClientLabel(undefined)).toBeNull();
    expect(sanitizeClientLabel(42)).toBeNull();
    expect(sanitizeClientLabel("\u0007")).toBeNull();
  });
});

describe("capture-types guards", () => {
  test("isCaptureKind / isCaptureState accept members and reject everything else", () => {
    for (const k of CAPTURE_KINDS) expect(isCaptureKind(k)).toBe(true);
    for (const s of CAPTURE_STATES) expect(isCaptureState(s)).toBe(true);
    expect(isCaptureKind("memo")).toBe(false);
    expect(isCaptureKind(3)).toBe(false);
    expect(isCaptureState("pending")).toBe(false);
    expect(isCaptureState(null)).toBe(false);
  });

  test("CaptureError carries code and prefixes the message", () => {
    const e = new CaptureError("ERR_CAPTURE_STATE", "nope");
    expect(e.code).toBe("ERR_CAPTURE_STATE");
    expect(e.message).toBe("ERR_CAPTURE_STATE: nope");
  });
});

const NOW = 1_700_000_000_000;

describe("validateCapturePayload — decision", () => {
  test("rebuilds from named fields only, truncates prose, defaults decidedAt to now", () => {
    const v = validateCapturePayload(
      "decision",
      {
        statement: `  ${"s".repeat(600)}\u001b[31m `,
        rationale: "why\nbecause",
        alternatives: ["a", "b".repeat(700)],
        evidence: ["github:pr:1"],
        junk: "dropped",
      },
      NOW,
    );
    expect(v.kind).toBe("decision");
    if (v.kind !== "decision") throw new Error("kind");
    expect(v.payload.statement.length).toBe(500);
    expect(v.payload.statement).not.toContain("\u001b");
    expect(v.payload.rationale).toBe("why\nbecause");
    expect(v.payload.alternatives[1]?.length).toBe(500);
    expect(v.payload.decidedAt).toBe(NOW);
    expect(Object.keys(v.payload).sort()).toEqual([
      "alternatives",
      "decidedAt",
      "evidence",
      "rationale",
      "statement",
    ]);
  });
  test.each([
    ["empty statement", { statement: "   " }],
    ["non-integer decidedAt", { statement: "s", decidedAt: 1.5 }],
    ["decidedAt outside Date range", { statement: "s", decidedAt: 9e15 }],
    [
      "11 alternatives",
      { statement: "s", alternatives: Array.from({ length: 11 }, (_, i) => `a${String(i)}`) },
    ],
    [
      "11 evidence ids",
      { statement: "s", evidence: Array.from({ length: 11 }, (_, i) => `x:${String(i)}`) },
    ],
    ["a non-string rationale", { statement: "s", rationale: 3 }],
    ["a non-array alternatives", { statement: "s", alternatives: "x" }],
  ])("refuses %s", (_n, raw) => {
    expect(() => validateCapturePayload("decision", raw, NOW)).toThrow("ERR_CAPTURE_INVALID");
  });
  test("an explicit decidedAt is kept; a null rationale stays null", () => {
    const v = validateCapturePayload("decision", { statement: "s", decidedAt: 123 }, NOW);
    if (v.kind !== "decision") throw new Error("kind");
    expect(v.payload.decidedAt).toBe(123);
    expect(v.payload.rationale).toBeNull();
  });
  test("a blank rationale becomes null; duplicate alternatives collapse", () => {
    const v = validateCapturePayload(
      "decision",
      { statement: "s", rationale: "  ", alternatives: ["x", "x"] },
      NOW,
    );
    if (v.kind !== "decision") throw new Error("kind");
    expect(v.payload.rationale).toBeNull();
    expect(v.payload.alternatives).toEqual(["x"]);
  });
});

describe("validateCapturePayload — term", () => {
  test("derives termKey with normalizeTerm and truncates the definition", () => {
    const v = validateCapturePayload(
      "term",
      { term: " Write-Ahead Logs ", definition: "d".repeat(3000), synonyms: ["WAL"] },
      NOW,
    );
    if (v.kind !== "term") throw new Error("kind");
    expect(v.payload.term).toBe("Write-Ahead Logs");
    expect(v.payload.termKey).toBe("write-ahead log");
    expect(v.payload.definition.length).toBe(2048);
    expect(v.payload.synonyms).toEqual(["WAL"]);
  });
  test.each([
    ["a 101-char term", { term: "t".repeat(101), definition: "d" }],
    ["an empty definition", { term: "t", definition: "  " }],
    ["a term that normalizes to nothing", { term: "...", definition: "d" }],
    ["a 101-char synonym", { term: "t", definition: "d", synonyms: ["s".repeat(101)] }],
    ["a non-string term", { term: 3, definition: "d" }],
    ["a blank term", { term: "  ", definition: "d" }],
  ])("refuses %s", (_n, raw) => {
    expect(() => validateCapturePayload("term", raw, NOW)).toThrow("ERR_CAPTURE_INVALID");
  });
});

describe("validateCapturePayload — link", () => {
  test("keeps the enum relation and truncates the note", () => {
    const v = validateCapturePayload(
      "link",
      { fromItemId: "a:1", toItemId: "b:2", relation: "fixes", note: "n".repeat(900) },
      NOW,
    );
    if (v.kind !== "link") throw new Error("kind");
    expect(v.payload.relation).toBe("fixes");
    expect(v.payload.note?.length).toBe(500);
    expect(referencedItemIds(v)).toEqual(["a:1", "b:2"]);
  });
  test.each([
    ["the same endpoint twice", { fromItemId: "a:1", toItemId: "a:1", relation: "fixes" }],
    ["an unknown relation", { fromItemId: "a:1", toItemId: "b:2", relation: "owns" }],
    ["a missing endpoint", { fromItemId: "a:1", relation: "fixes" }],
  ])("refuses %s", (_n, raw) => {
    expect(() => validateCapturePayload("link", raw, NOW)).toThrow("ERR_CAPTURE_INVALID");
  });
});

test("every link relation has a captured_ relation type, and nothing else does", () => {
  expect(Object.keys(CAPTURED_RELATION_TYPES).sort()).toEqual([...LINK_RELATIONS].sort());
  for (const [r, t] of Object.entries(CAPTURED_RELATION_TYPES)) expect(t).toBe(`captured_${r}`);
});

test("note still validates through the dispatcher; referencedItemIds reads each kind", () => {
  const n = validateCapturePayload("note", { body: "b", relatesTo: ["x:1"] }, NOW);
  expect(referencedItemIds(n)).toEqual(["x:1"]);
  const d = validateCapturePayload("decision", { statement: "s", evidence: ["y:2"] }, NOW);
  expect(referencedItemIds(d)).toEqual(["y:2"]);
  const t = validateCapturePayload("term", { term: "t", definition: "d" }, NOW);
  expect(referencedItemIds(t)).toEqual([]);
});

describe("write-time Trojan Source stripping", () => {
  // Built from code points: a literal or an escape in source can be rewritten by the format hook.
  const RLO = String.fromCodePoint(0x202e);
  const ZWSP = String.fromCodePoint(0x200b);
  const BOM = String.fromCodePoint(0xfeff);
  const LSEP = String.fromCodePoint(0x2028);
  const LRI = String.fromCodePoint(0x2066);

  test("a decision statement with U+202E is stored without it", () => {
    const v = validateCapturePayload(
      "decision",
      { statement: `use ${RLO}gpj.exe`, rationale: `because${ZWSP}${LSEP} so` },
      NOW,
    );
    if (v.kind !== "decision") throw new Error("kind");
    expect(v.payload.statement).toBe("use gpj.exe");
    expect(v.payload.rationale).toBe("because so");
  });

  test("a term's key cannot differ from what the owner sees", () => {
    const v = validateCapturePayload("term", { term: `W${ZWSP}AL`, definition: "d" }, NOW);
    if (v.kind !== "term") throw new Error("kind");
    expect(v.payload.term).toBe("WAL");
    expect(v.payload.termKey).toBe("wal");
  });

  test("a note's title and body are stripped too", () => {
    const p = validateNotePayload({ title: `${BOM}T${LRI}`, body: `b${RLO}ody\nline` });
    expect(p.title).toBe("T");
    expect(p.body).toBe("body\nline");
  });
});

describe("link endpoint ids are structure: refuse, never strip or truncate", () => {
  const MAX_ID = "x".repeat(512);
  test("a 512-character id is accepted by validation, unchanged", () => {
    const v = validateCapturePayload(
      "link",
      { fromItemId: MAX_ID, toItemId: "b:2", relation: "fixes" },
      NOW,
    );
    if (v.kind !== "link") throw new Error("kind");
    expect(v.payload.fromItemId).toBe(MAX_ID);
  });
  test.each([
    ["a 513-character fromItemId", { fromItemId: `${MAX_ID}x`, toItemId: "b:2" }],
    ["a 513-character toItemId", { fromItemId: "a:1", toItemId: `${MAX_ID}x` }],
    ["a non-string id", { fromItemId: 7, toItemId: "b:2" }],
    ["an empty id", { fromItemId: "", toItemId: "b:2" }],
  ])("refuses %s", (_n, ids) => {
    expect(code(() => validateCapturePayload("link", { ...ids, relation: "fixes" }, NOW))).toBe(
      "ERR_CAPTURE_INVALID",
    );
  });
  test("an id is not trimmed or control-stripped into a different id", () => {
    const v = validateCapturePayload(
      "link",
      { fromItemId: " a:1 ", toItemId: "b:2", relation: "fixes" },
      NOW,
    );
    if (v.kind !== "link") throw new Error("kind");
    expect(v.payload.fromItemId).toBe(" a:1 ");
  });
});

describe("action payload (PR 3)", () => {
  const ok = {
    actionType: "slack.message.post",
    input: { channel: "C1", text: "hi" },
    summary: "why",
  };
  test("rebuilds exactly {actionType, input, summary}; siblings dropped; input verbatim", () => {
    const v = validateCapturePayload("action", { ...ok, extra: 1 }, 0);
    expect(v).toEqual({ kind: "action", payload: ok });
  });
  test("an mcpToolId key in input REFUSES (never dropped)", () => {
    expect(() =>
      validateCapturePayload("action", { ...ok, input: { mcpToolId: "x", text: "hi" } }, 0),
    ).toThrow(/mcpToolId/);
  });
  test("an mcpToolId key beside actionType REFUSES too", () => {
    expect(() =>
      validateCapturePayload("action", { ...ok, mcpToolId: "slack_admin_delete" }, 0),
    ).toThrow(/mcpToolId/);
  });
  test.each([[0x200e], [0x200f], [0x2060], [0x2063], [0x00ad], [0x061c], [0x180e]])(
    "code point %d is stripped from stored prose (widened Trojan-Source set)",
    (cp) => {
      const v = validateCapturePayload(
        "action",
        { ...ok, summary: `a${String.fromCodePoint(cp)}b` },
        0,
      );
      expect(v.kind === "action" && v.payload.summary).toBe("ab");
    },
  );
  test("the widened set also strips from note bodies", () => {
    const p = validateNotePayload({ body: `a${String.fromCodePoint(0x200e)}b` });
    expect(p.body).toBe("ab");
  });
  test.each([[null], [[]], ["s"], [3]])("input %p refuses", (input) => {
    expect(() => validateCapturePayload("action", { ...ok, input }, 0)).toThrow(CaptureError);
  });
  test("actionType must be a non-empty string at most 128 with no whitespace", () => {
    for (const t of ["", " ", "a".repeat(129), 7, "slack. message"]) {
      expect(() => validateCapturePayload("action", { ...ok, actionType: t }, 0)).toThrow(
        CaptureError,
      );
    }
  });
  test("summary truncates at 300 and is control-stripped; missing summary refuses", () => {
    const esc = String.fromCodePoint(0x1b);
    const v = validateCapturePayload(
      "action",
      { ...ok, summary: `a${esc}[2J${"x".repeat(400)}` },
      0,
    );
    expect(v.kind === "action" && v.payload.summary.length).toBeLessThanOrEqual(300);
    expect(v.kind === "action" && v.payload.summary.includes(esc)).toBe(false);
    expect(() =>
      validateCapturePayload("action", { actionType: ok.actionType, input: {} }, 0),
    ).toThrow();
  });
  test("the 64 KiB total cap refuses", () => {
    expect(() =>
      validateCapturePayload("action", { ...ok, input: { text: "x".repeat(70_000) } }, 0),
    ).toThrow(/exceeds/);
  });
  test("input values are NOT stripped: what is approved is what is sent", () => {
    const rlo = String.fromCodePoint(0x202e);
    const v = validateCapturePayload("action", { ...ok, input: { text: `a${rlo}b` } }, 0);
    expect(v.kind === "action" && v.payload.input["text"]).toBe(`a${rlo}b`);
  });
  test("referencedItemIds is empty for an action", () => {
    expect(referencedItemIds(validateCapturePayload("action", ok, 0))).toEqual([]);
  });
});
