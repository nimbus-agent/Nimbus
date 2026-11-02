import { describe, expect, test } from "bun:test";
import { MAX_EVAL_REPLY_BYTES } from "./caps.ts";
import {
  buildRecordedSuite,
  type EvalRecordInputs,
  parseEvalRecordDocument,
  parseEvalRecordInputs,
  serialiseEvalSuite,
} from "./eval-record.ts";
import { type EvalReply, judgeCase } from "./eval-score.ts";
import { type EvalCase, parseEvalSuite } from "./eval-suite.ts";

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const okInputs = { format: 1, name: "golden", cases: [{ name: "a", tool: "t", input: { x: 1 } }] };
const reply = (text: string, isError = false): EvalReply => ({ kind: "reply", text, isError });
const failed: EvalReply = { kind: "failed", reason: "timeout" };
const j = (v: unknown): EvalReply => reply(JSON.stringify(v));

function refuses(bytes: Uint8Array): void {
  expect(() => parseEvalRecordInputs("inputs.json", bytes)).toThrow(
    /ERR_REGISTRY_EVAL_SUITE_INVALID/,
  );
}

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

function withCase(c: unknown): Uint8Array {
  return enc({ ...okInputs, cases: [c] });
}

describe("parseEvalRecordInputs", () => {
  test("accepts a valid file", () => {
    const r = parseEvalRecordInputs("inputs.json", enc(okInputs));
    expect(r.name).toBe("golden");
    expect(r.cases).toEqual([{ name: "a", tool: "t", input: { x: 1 } }]);
  });
  test("refuses format, extra key, expect, duplicates, counts", () => {
    refuses(enc({ ...okInputs, format: 2 }));
    refuses(enc({ ...okInputs, extra: 1 }));
    refuses(withCase({ name: "a", tool: "t", input: {}, expect: {} }));
    refuses(
      enc({
        ...okInputs,
        cases: [
          { name: "a", tool: "t", input: {} },
          { name: "a", tool: "t", input: {} },
        ],
      }),
    );
    refuses(
      enc({
        ...okInputs,
        cases: Array.from({ length: 201 }, (_, i) => ({ name: `c${i}`, tool: "t", input: {} })),
      }),
    );
    refuses(enc({ ...okInputs, cases: [] }));
  });
  test("refuses bad names, tools and inputs", () => {
    refuses(withCase({ name: "n".repeat(121), tool: "t", input: {} }));
    refuses(withCase({ name: "a", tool: "t".repeat(129), input: {} }));
    refuses(withCase({ name: "a", tool: "t", input: [] }));
    refuses(withCase({ name: "a", tool: "t", input: { s: "x".repeat(65 * 1024) } }));
    refuses(withCase({ name: "a", tool: "t", input: nested(65) }));
  });
  test("refuses an oversize file, a BOM and invalid UTF-8", () => {
    refuses(new Uint8Array(1024 * 1024 + 1));
    refuses(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(okInputs)]));
    refuses(new Uint8Array([0x7b, 0xff, 0x7d]));
  });
});

function inputsFor(n: number): EvalRecordInputs {
  return {
    name: "s",
    cases: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, tool: "t", input: {} })),
  };
}

function one(a: EvalReply, b: EvalReply) {
  return buildRecordedSuite(inputsFor(1), [a], [b]);
}

function expectOf(r: ReturnType<typeof one>): EvalCase["expect"] {
  return (r.suite.cases[0] as EvalCase).expect;
}

function patternOf(r: ReturnType<typeof one>): Record<string, unknown> {
  return (expectOf(r) as { value: Record<string, unknown> }).value;
}

/** The generated case, read back through the real parser. */
function roundTrip(r: ReturnType<typeof one>): EvalCase {
  return parseEvalSuite("x", serialiseEvalSuite(r.suite)).cases[0] as EvalCase;
}

describe("buildRecordedSuite", () => {
  test("identical text is exact, with the error flag copied", () => {
    const r = one(reply("hello", true), reply("hello", true));
    expect(r.suite.cases).toEqual([
      {
        name: "c0",
        tool: "t",
        input: {},
        expect: { rubric: "exact", value: "hello", error: true },
      },
    ]);
  });
  test("identical JSON text is still exact", () => {
    expect(expectOf(one(j({ a: 1 }), j({ a: 1 }))).rubric).toBe("exact");
  });
  test("differing scalars become type markers", () => {
    const r = one(
      j({ id: 1, at: "2026-11-02T00:00:00Z", n: 2 }),
      j({ id: 2, at: "2026-11-03T00:00:00Z", n: 2 }),
    );
    expect(expectOf(r)).toEqual({
      rubric: "json-match",
      value: { id: { $type: "number" }, at: { $type: "string" }, n: 2 },
      error: false,
    });
  });
  test("nested object and array merges", () => {
    const r = one(j({ o: { k: [1, "a"], z: true } }), j({ o: { k: [2, "a"], z: false } }));
    expect(patternOf(r)).toEqual({ o: { k: [{ $type: "number" }, "a"], z: { $type: "boolean" } } });
  });
  test("arrays of different lengths are skipped changes-shape", () => {
    expect(one(j([1]), j([1, 2])).skipped).toEqual([{ case: "c0", why: "changes-shape" }]);
  });
  test("only shared keys are kept; no shared key is skipped", () => {
    const r = one(j({ a: 1, b: 2 }), j({ a: 1, c: 3 }));
    expect(patternOf(r)).toEqual({ a: 1 });
    const s = one(j({ a: 1 }), j({ b: 1 }));
    expect(s.skipped).toEqual([{ case: "c0", why: "changes-shape" }]);
    expect(s.suite.cases).toEqual([]);
  });
  test("a root that merges to a bare marker is skipped changes-shape", () => {
    expect(one(j("x"), j("y")).skipped).toEqual([{ case: "c0", why: "changes-shape" }]);
  });
  test("type change is skipped changes-type", () => {
    expect(one(j({ a: 1 }), j({ a: "1" })).skipped).toEqual([{ case: "c0", why: "changes-type" }]);
  });
  test("differing non-JSON is skipped changes-not-json", () => {
    expect(one(reply("a"), reply("b")).skipped).toEqual([{ case: "c0", why: "changes-not-json" }]);
    expect(one(reply("a"), j({ a: 1 })).skipped).toEqual([{ case: "c0", why: "changes-not-json" }]);
  });
  test("failed calls, error flag differences and over-cap replies are skipped", () => {
    expect(one(failed, reply("a")).skipped[0]?.why).toBe("call-failed");
    expect(one(reply("a"), failed).skipped[0]?.why).toBe("call-failed");
    expect(one(reply("a", true), reply("a")).skipped[0]?.why).toBe("error-flag-differs");
    const big = reply("x".repeat(MAX_EVAL_REPLY_BYTES + 1));
    expect(one(big, big).skipped[0]?.why).toBe("reply-too-large");
  });
  test("boundary replies are recorded verbatim and read back", () => {
    const deep = JSON.stringify(nested(63));
    const ctrlText = "a\u0000b\u001f \n\t";
    const r = buildRecordedSuite(
      inputsFor(2),
      [reply(deep), reply(ctrlText)],
      [reply(deep), reply(ctrlText)],
    );
    expect(r.skipped).toEqual([]);
    const parsed = parseEvalSuite("x", serialiseEvalSuite(r.suite));
    expect(parsed.cases[1]?.expect).toMatchObject({ rubric: "exact", value: ctrlText });
    const cap = reply("y".repeat(MAX_EVAL_REPLY_BYTES - 1000));
    const rc = one(cap, cap);
    expect(rc.skipped).toEqual([]);
    expect(roundTrip(rc).expect).toMatchObject({ value: (cap as { text: string }).text });
  });
  test("a reply of exactly the reply cap is not skipped as too large", () => {
    const edge = reply("y".repeat(MAX_EVAL_REPLY_BYTES));
    // too big for a suite file, so the whole suite is refused, not skipped as reply-too-large
    expect(() => one(edge, edge)).toThrow(/ERR_REGISTRY_EVAL_SUITE_INVALID/);
  });
});

describe("escaping", () => {
  test("a merged single-key literal $type is recorded as $$type", () => {
    const a = j({ k: { $type: "x" }, n: 1 });
    const b = j({ k: { $type: "x" }, n: 2 });
    const r = one(a, b);
    expect(Object.keys(patternOf(r)["k"] as object)).toEqual(["$$type"]);
    const c = roundTrip(r);
    expect(judgeCase(c, a).pass).toBe(true);
    expect(judgeCase(c, b).pass).toBe(true);
  });
  test("a merged object with a $type key is escaped", () => {
    const a = j({ $type: "foo", id: 1 });
    const b = j({ $type: "bar", id: 1 });
    const r = one(a, b);
    expect(patternOf(r)).toEqual({ $$type: { $type: "string" }, id: 1 });
    const c = roundTrip(r);
    expect(judgeCase(c, a).pass).toBe(true);
    expect(judgeCase(c, b).pass).toBe(true);
  });
  test("multi-key literals with $-keys are escaped by name", () => {
    const a = j({ $a: 1, $$b: 2, c: { $x: 1 }, d: 1 });
    const b = j({ $a: 1, $$b: 2, c: { $x: 1 }, d: 2 });
    const r = one(a, b);
    expect(Object.keys(patternOf(r)).sort()).toEqual(["$$$b", "$$a", "c", "d"]);
    expect(Object.keys(patternOf(r)["c"] as object)).toEqual(["$$x"]);
    const c = roundTrip(r);
    expect(judgeCase(c, a).pass).toBe(true);
    expect(judgeCase(c, b).pass).toBe(true);
  });
  test("a __proto__ key stays an own property", () => {
    const a = reply('{"__proto__":{"p":1},"n":1}');
    const b = reply('{"__proto__":{"p":1},"n":2}');
    const r = one(a, b);
    expect(r.skipped).toEqual([]);
    const c = roundTrip(r);
    expect(judgeCase(c, a).pass).toBe(true);
    expect(judgeCase(c, b).pass).toBe(true);
  });
});

describe("self-check property", () => {
  test("every built case judges both replies as passing", () => {
    const pairs: [EvalReply, EvalReply][] = [
      [reply("t"), reply("t")],
      [j({ id: 1, s: "a" }), j({ id: 2, s: "b" })],
      [j([{ a: 1 }, { a: 2 }]), j([{ a: 3 }, { a: 4 }])],
      [j({ $type: "q", n: 1 }), j({ $type: "r", n: 1 })],
      [j({ a: { b: [true] } }), j({ a: { b: [false] } })],
    ];
    for (const [a, b] of pairs) {
      const r = one(a, b);
      expect(r.suite.cases.length).toBe(1);
      const c = roundTrip(r);
      expect(judgeCase(c, a).pass).toBe(true);
      expect(judgeCase(c, b).pass).toBe(true);
    }
  });
  test("zero recordable cases still returns an empty suite and the skips", () => {
    const r = one(failed, failed);
    expect(r.suite.cases).toEqual([]);
    expect(r.skipped.length).toBe(1);
    expect(() => serialiseEvalSuite(r.suite)).toThrow(/ERR_REGISTRY_EVAL_SUITE_INVALID/);
  });
});

describe("serialiseEvalSuite", () => {
  test("round-trips with a trailing newline and 2-space indent", () => {
    const bytes = serialiseEvalSuite(one(reply("a"), reply("a")).suite);
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "format": 1');
    expect(parseEvalSuite("x", bytes).cases.map((c) => c.name)).toEqual(["c0"]);
  });
  test("a suite over 1 MiB is refused", () => {
    const big = "z".repeat(600 * 1024);
    expect(() =>
      buildRecordedSuite(inputsFor(2), [reply(big), reply(big)], [reply(big), reply(big)]),
    ).toThrow(/ERR_REGISTRY_EVAL_SUITE_INVALID/);
  });
});

describe("parseEvalRecordDocument", () => {
  const suite = {
    format: 1,
    name: "s",
    cases: [
      { name: "c", tool: "t", input: {}, expect: { rubric: "exact", value: "a", error: false } },
    ],
  };
  const doc = (v: unknown): string => JSON.stringify(v);
  test("accepts both shapes", () => {
    const ok = parseEvalRecordDocument(
      doc({
        ok: true,
        extensionId: "e",
        version: "1.0.0",
        suite,
        skipped: [{ case: "x", why: "call-failed" }],
      }),
    );
    expect(ok?.ok).toBe(true);
    const err = { code: "ERR_EVAL_RECORD_EMPTY", message: "m" };
    const skipped = [{ case: "x", why: "changes-type" as const }];
    expect(parseEvalRecordDocument(doc({ ok: false, error: { ...err, skipped } }))).toEqual({
      ok: false,
      error: { ...err, skipped },
    });
    expect(parseEvalRecordDocument(doc({ ok: false, error: err }))).toEqual({
      ok: false,
      error: err,
    });
  });
  test("refuses extra keys, unknown why and an invalid suite", () => {
    const base = { ok: true, extensionId: "e", version: "1", suite, skipped: [] };
    expect(parseEvalRecordDocument(doc({ ...base, extra: 1 }))).toBeNull();
    expect(
      parseEvalRecordDocument(doc({ ...base, skipped: [{ case: "x", why: "nope" }] })),
    ).toBeNull();
    expect(
      parseEvalRecordDocument(doc({ ...base, skipped: [{ case: "x", why: "call-failed", z: 1 }] })),
    ).toBeNull();
    expect(parseEvalRecordDocument(doc({ ...base, suite: { ...suite, cases: [] } }))).toBeNull();
    expect(
      parseEvalRecordDocument(doc({ ok: false, error: { code: "C", message: "m", x: 1 } })),
    ).toBeNull();
    expect(parseEvalRecordDocument("nope")).toBeNull();
  });
});
