import { describe, expect, test } from "bun:test";
import { MAX_EVAL_REPLY_BYTES } from "./caps.ts";
import {
  EVAL_SCORER_VERSION,
  type EvalCaseOutcome,
  type EvalReply,
  jsonDeepEqual,
  judgeCase,
  matchesJsonPattern,
  resolveJsonPointer,
  scoreEval,
} from "./eval-score.ts";
import type { EvalCase, EvalExpect } from "./eval-suite.ts";

function mk(expectation: EvalExpect): EvalCase {
  return { name: "c", tool: "t", input: {}, expect: expectation };
}
const ok = (text: string, isError = false): EvalReply => ({ kind: "reply", text, isError });
const exact = (value: string, error = false) => mk({ rubric: "exact", value, error });
const jm = (value: unknown, error = false) => mk({ rubric: "json-match", value, error });
const oneOf = (values: unknown[], path: string | null = null, error = false) =>
  mk({ rubric: "one-of", values, path, error });
function nest(depth: number): string {
  return `${"[".repeat(depth)}${"]".repeat(depth)}`;
}

describe("exact", () => {
  test("equal passes", () => {
    expect(judgeCase(exact("ok"), ok("ok"))).toEqual({ pass: true, reason: null });
  });
  test("trailing newline fails", () => {
    expect(judgeCase(exact("ok"), ok("ok\n"))).toEqual({ pass: false, reason: "text differs" });
  });
});

describe("json-match", () => {
  const cases: [string, unknown, string, boolean][] = [
    ["subset object", { a: 1 }, '{"a":1,"b":2}', true],
    ["object vs array", { a: 1 }, "[1]", false],
    ["object vs null", { a: 1 }, "null", false],
    ["object vs string", { a: 1 }, '"x"', false],
    ["missing key", { a: 1 }, '{"b":1}', false],
    ["array shorter", [1, 2], "[1,2,3]", false],
    ["array equal", [1, 2], "[1,2]", true],
    ["array element mismatch", [1, 2], "[1,3]", false],
    ["array vs object", [1], '{"0":1}', false],
    ["type array ok", { $type: "array" }, "[]", true],
    ["type array vs object", { $type: "array" }, "{}", false],
    ["type object rejects null", { $type: "object" }, "null", false],
    ["type object rejects array", { $type: "object" }, "[]", false],
    ["type object ok", { $type: "object" }, "{}", true],
    ["type null", { $type: "null" }, "null", true],
    ["type null vs 0", { $type: "null" }, "0", false],
    ["type string", { $type: "string" }, '"s"', true],
    ["type number", { $type: "number" }, "3", true],
    ["type number vs string", { $type: "number" }, '"3"', false],
    ["type boolean", { $type: "boolean" }, "false", true],
    ["escaped $$type", { $$type: "x" }, '{"$type":"x"}', true],
    ["escaped $$type missing", { $$type: "x" }, '{"type":"x"}', false],
    ["nested type", { a: { $type: "string" } }, '{"a":"q"}', true],
    ["scalar string vs number", 1, '"1"', false],
    ["scalar equal", 1, "1", true],
    ["null pattern", null, "null", true],
  ];
  for (const [name, pattern, text, pass] of cases) {
    test(name, () => {
      expect(judgeCase(jm(pattern), ok(text)).pass).toBe(pass);
    });
  }
  test("failure reasons", () => {
    expect(judgeCase(jm({ a: 1 }), ok("nope")).reason).toBe("reply is not JSON");
    expect(judgeCase(jm(1), ok("2")).reason).toBe("pattern did not match");
    expect(judgeCase(jm({ $type: "array" }), ok(nest(65))).reason).toBe("reply too deep");
  });
  test("depth 64 allowed", () => {
    expect(judgeCase(jm({ $type: "array" }), ok(nest(64))).pass).toBe(true);
  });
  test("matchesJsonPattern direct", () => {
    expect(matchesJsonPattern({ a: [1, { $type: "string" }] }, { a: [1, "x"], z: 0 })).toBe(true);
  });
});

describe("one-of", () => {
  test("plain text member", () => {
    expect(judgeCase(oneOf(["green", "red"]), ok("green")).pass).toBe(true);
  });
  test("plain text miss", () => {
    expect(judgeCase(oneOf(["red"]), ok("green"))).toEqual({
      pass: false,
      reason: "value not in set",
    });
  });
  test("true matches string and boolean", () => {
    expect(judgeCase(oneOf(["true"]), ok("true")).pass).toBe(true);
    expect(judgeCase(oneOf([true]), ok("true")).pass).toBe(true);
  });
  test("1 vs '2' fails", () => {
    expect(judgeCase(oneOf(["2"]), ok("1")).pass).toBe(false);
  });
  test("plain text does not match non-string", () => {
    expect(judgeCase(oneOf([1]), ok("green")).pass).toBe(false);
  });
  test("$type in values is literal", () => {
    expect(judgeCase(oneOf([{ $type: "string" }]), ok('"x"')).pass).toBe(false);
    expect(judgeCase(oneOf([{ $type: "string" }]), ok('{"$type":"string"}')).pass).toBe(true);
  });
  test("deep reply, no path: not compared as JSON", () => {
    expect(judgeCase(oneOf([[]]), ok(nest(65))).pass).toBe(false);
  });
  test("path with deep reply", () => {
    expect(judgeCase(oneOf([1], "/a"), ok(nest(65))).reason).toBe("reply too deep");
  });
  test("path resolves", () => {
    expect(judgeCase(oneOf(["x"], "/items/0/key"), ok('{"items":[{"key":"x"}]}')).pass).toBe(true);
  });
  test("path with ~1", () => {
    expect(judgeCase(oneOf([1], "/a~1b"), ok('{"a/b":1}')).pass).toBe(true);
  });
  test("path non-JSON", () => {
    expect(judgeCase(oneOf([1], "/a"), ok("zzz")).reason).toBe("reply is not JSON");
  });
  test("path missing", () => {
    expect(judgeCase(oneOf([1], "/b"), ok('{"a":1}')).reason).toBe("path not found");
  });
  test("path non-canonical index", () => {
    expect(judgeCase(oneOf([1], "/items/01"), ok('{"items":[0,1]}')).reason).toBe("path not found");
  });
  test("path value not in set", () => {
    expect(judgeCase(oneOf([2], "/a"), ok('{"a":1}')).reason).toBe("value not in set");
  });
  test("object values order-insensitive", () => {
    expect(judgeCase(oneOf([{ a: 1, b: 2 }]), ok('{"b":2,"a":1}')).pass).toBe(true);
  });
});

describe("resolveJsonPointer", () => {
  const doc = { "a~b": 1, "": 2, arr: [10, 20], n: null };
  test("root", () => {
    expect(resolveJsonPointer(doc, "")).toEqual({ found: true, value: doc });
  });
  test("tilde unescape", () => {
    expect(resolveJsonPointer(doc, "/a~0b")).toEqual({ found: true, value: 1 });
  });
  test("empty key", () => {
    expect(resolveJsonPointer(doc, "/")).toEqual({ found: true, value: 2 });
  });
  test("array index", () => {
    expect(resolveJsonPointer(doc, "/arr/1")).toEqual({ found: true, value: 20 });
  });
  test("array bad index shapes", () => {
    for (const p of ["/arr/-", "/arr/2", "/arr/x", "/arr/-1", "/arr/1.0", "/arr/00"]) {
      expect(resolveJsonPointer(doc, p)).toEqual({ found: false });
    }
  });
  test("through scalar or null", () => {
    expect(resolveJsonPointer(doc, "/n/x")).toEqual({ found: false });
    expect(resolveJsonPointer(doc, "/a~0b/x")).toEqual({ found: false });
  });
  test("inherited key not found", () => {
    expect(resolveJsonPointer(doc, "/toString")).toEqual({ found: false });
    expect(resolveJsonPointer(doc, "/arr/length")).toEqual({ found: false });
  });
  test("first token zero", () => {
    expect(resolveJsonPointer([5], "/0")).toEqual({ found: true, value: 5 });
  });
});

describe("jsonDeepEqual", () => {
  test("cases", () => {
    expect(jsonDeepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonDeepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonDeepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonDeepEqual([1], [1, 2])).toBe(false);
    expect(jsonDeepEqual([], {})).toBe(false);
    expect(jsonDeepEqual(null, {})).toBe(false);
    expect(jsonDeepEqual({}, null)).toBe(false);
    expect(jsonDeepEqual(1, "1")).toBe(false);
    expect(jsonDeepEqual(null, null)).toBe(true);
  });
});

describe("error handling", () => {
  test("unexpected error", () => {
    expect(judgeCase(exact("ok"), ok("ok", true))).toEqual({
      pass: false,
      reason: "tool returned an error",
    });
  });
  test("expected error and match passes", () => {
    expect(judgeCase(exact("bad", true), ok("bad", true)).pass).toBe(true);
  });
  test("expected error but none", () => {
    expect(judgeCase(exact("ok", true), ok("ok"))).toEqual({
      pass: false,
      reason: "tool did not return an error",
    });
  });
  test("expected error, rubric still decides", () => {
    expect(judgeCase(exact("bad", true), ok("worse", true)).reason).toBe("text differs");
  });
});

describe("failed and oversize replies", () => {
  for (const reason of ["timeout", "crash", "unknown-tool", "bad-reply"] as const) {
    test(reason, () => {
      expect(judgeCase(exact("x"), { kind: "failed", reason })).toEqual({ pass: false, reason });
    });
  }
  test("too large by bytes", () => {
    const big = "a".repeat(MAX_EVAL_REPLY_BYTES + 1);
    expect(judgeCase(exact(big), ok(big))).toEqual({ pass: false, reason: "too-large" });
  });
  test("exactly the cap passes size check", () => {
    const edge = "a".repeat(MAX_EVAL_REPLY_BYTES);
    expect(judgeCase(exact(edge), ok(edge)).pass).toBe(true);
  });
  test("multibyte counted in UTF-8 bytes", () => {
    const s = "é".repeat(MAX_EVAL_REPLY_BYTES / 2 + 1);
    expect(s.length).toBeLessThan(MAX_EVAL_REPLY_BYTES);
    expect(judgeCase(exact(s), ok(s)).reason).toBe("too-large");
  });
});

describe("scoreEval", () => {
  const out = (pass: boolean, rubric: EvalCaseOutcome["rubric"] = "exact"): EvalCaseOutcome => ({
    suite: "s",
    case: "c",
    rubric,
    pass,
    reason: pass ? null : "x",
  });
  const many = (passed: number, total: number) =>
    Array.from({ length: total }, (_, i) => out(i < passed));
  test("empty is null", () => {
    expect(scoreEval([])).toBeNull();
  });
  test("floors", () => {
    expect(scoreEval(many(35, 40))?.score).toBe(87);
    expect(scoreEval(many(1, 3))?.score).toBe(33);
    expect(scoreEval(many(2, 3))?.score).toBe(66);
    expect(scoreEval(many(3, 3))?.score).toBe(100);
    expect(scoreEval(many(0, 3))?.score).toBe(0);
  });
  test("tallies, version, order", () => {
    const outcomes = [out(true, "exact"), out(false, "one-of"), out(true, "one-of")];
    const r = scoreEval(outcomes);
    expect(r?.scorer).toBe(1);
    expect(EVAL_SCORER_VERSION).toBe(1);
    expect(r?.cases).toBe(3);
    expect(r?.passed).toBe(2);
    expect(r?.rubrics).toEqual({
      exact: { cases: 1, passed: 1 },
      "json-match": { cases: 0, passed: 0 },
      "one-of": { cases: 2, passed: 1 },
    });
    expect(r?.results).toEqual(outcomes);
  });
});
