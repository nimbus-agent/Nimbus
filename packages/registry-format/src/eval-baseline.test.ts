import { describe, expect, test } from "bun:test";
import { RegistryError } from "./errors.ts";
import {
  EVAL_BASELINE_FAILURES,
  type EvalBaseline,
  judgeToolDefinitions,
  MAX_EVAL_BASELINE_TOOLS,
  parseEvalBaseline,
  parseEvalBaselineDocument,
  readVersionBaseline,
} from "./eval-baseline.ts";
import type { RegistryVersionEntry } from "./index-format.ts";

const PASSED = { scorer: 1, passed: true, tools: 4 } as const;
const FAILED = { scorer: 1, passed: false, tools: 0, failure: "no-listing" } as const;

const entry = (baseline?: unknown): RegistryVersionEntry =>
  ({ ...(baseline !== undefined && { baseline }) }) as unknown as RegistryVersionEntry;

describe("parseEvalBaseline", () => {
  test("accepts both shapes and returns a rebuilt object", () => {
    const p = parseEvalBaseline(PASSED);
    expect(p).toEqual(PASSED);
    expect(p).not.toBe(PASSED);
    expect(parseEvalBaseline(FAILED)).toEqual(FAILED);
  });

  test("every failure code is accepted", () => {
    for (const failure of EVAL_BASELINE_FAILURES) {
      expect(parseEvalBaseline({ ...FAILED, failure })).toEqual({ ...FAILED, failure });
    }
  });

  test.each([
    ["an extra key", { ...PASSED, note: "x" }],
    ["passed true with a failure", { ...PASSED, failure: "no-listing" }],
    ["passed false with no failure", { scorer: 1, passed: false, tools: 0 }],
    ["free text as the failure", { ...FAILED, failure: "it crashed: <text>" }],
    ["negative tools", { ...PASSED, tools: -1 }],
    ["fractional tools", { ...PASSED, tools: 1.5 }],
    ["tools above the max", { ...PASSED, tools: MAX_EVAL_BASELINE_TOOLS + 1 }],
    ["a string for tools", { ...PASSED, tools: "4" }],
    ["scorer 2", { ...PASSED, scorer: 2 }],
    ["a non-boolean passed", { ...PASSED, passed: "yes" }],
    ["an array", []],
    ["null", null],
  ])("refuses %s", (_l, raw) => {
    expect(() => parseEvalBaseline(raw)).toThrow(RegistryError);
  });

  test("a __proto__ key is only a key and is refused as extra", () => {
    const raw = JSON.parse('{"scorer":1,"passed":true,"tools":1,"__proto__":{"passed":false}}');
    expect(() => parseEvalBaseline(raw)).toThrow(RegistryError);
  });

  test("tools at the max is accepted", () => {
    expect(parseEvalBaseline({ ...PASSED, tools: MAX_EVAL_BASELINE_TOOLS }).tools).toBe(
      MAX_EVAL_BASELINE_TOOLS,
    );
  });
});

describe("readVersionBaseline", () => {
  test("absent is unchecked", () => {
    expect(readVersionBaseline(entry())).toEqual({ state: "unchecked" });
  });
  test("valid is checked", () => {
    expect(readVersionBaseline(entry(PASSED))).toEqual({ state: "checked", baseline: PASSED });
  });
  test("malformed is invalid and does not throw", () => {
    const r = readVersionBaseline(entry({ passed: "x" }));
    expect(r.state).toBe("invalid");
    expect(readVersionBaseline(entry(null)).state).toBe("invalid");
  });
});

describe("judgeToolDefinitions", () => {
  const tool = (over: Record<string, unknown> = {}) => ({
    name: "a",
    inputSchema: { type: "object" },
    ...over,
  });

  test("one good tool passes with one tool", () => {
    expect(judgeToolDefinitions({ a: tool() })).toEqual({ scorer: 1, passed: true, tools: 1 });
  });
  test("an empty listing passes with no tools", () => {
    expect(judgeToolDefinitions({})).toEqual({ scorer: 1, passed: true, tools: 0 });
  });
  test("a list of definitions is read like a record", () => {
    expect(judgeToolDefinitions([tool(), tool({ name: "b" })])).toEqual({
      scorer: 1,
      passed: true,
      tools: 2,
    });
  });
  test("full schemas pass", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "string" }, y: true },
      required: ["x"],
    };
    expect(judgeToolDefinitions({ a: tool({ inputSchema: schema }) }).passed).toBe(true);
  });

  test.each([
    ["a name with a space", tool({ name: "a b" })],
    ["a 129-character name", tool({ name: "n".repeat(129) })],
    ["an empty name", tool({ name: "" })],
    ["no name", { inputSchema: { type: "object" } }],
    ["a name with a control character", tool({ name: "a\u0007b" })],
    ["a string schema", tool({ inputSchema: { type: "string" } })],
    ["no schema", { name: "a" }],
    ["properties as an array", tool({ inputSchema: { type: "object", properties: [] } })],
    ["a non-object property", tool({ inputSchema: { type: "object", properties: { x: 1 } } })],
    ["required as a string", tool({ inputSchema: { type: "object", required: "x" } })],
    ["required with a non-string", tool({ inputSchema: { type: "object", required: [1] } })],
    ["a non-object definition", 7],
  ])("%s is invalid-tool, tools still counted", (_l, def) => {
    expect(judgeToolDefinitions({ a: def, b: tool({ name: "b" }) })).toEqual({
      scorer: 1,
      passed: false,
      tools: 2,
      failure: "invalid-tool",
    });
  });

  test("a 128-character name is fine", () => {
    expect(judgeToolDefinitions({ a: tool({ name: "n".repeat(128) }) }).passed).toBe(true);
  });

  test("a record whose prototype a listed tool replaced is invalid-tool, and that tool counts", () => {
    // What `definitions[tool.name] = value` does for a tool named `__proto__`: no key shows it.
    const record: Record<string, unknown> = { a: tool() };
    Object.setPrototypeOf(record, { name: "__proto__", inputSchema: { type: "object" } });
    expect(Object.keys(record)).toEqual(["a"]);
    expect(judgeToolDefinitions(record)).toEqual({
      scorer: 1,
      passed: false,
      tools: 2,
      failure: "invalid-tool",
    });
  });

  test("a record with a null prototype is judged by its values", () => {
    const record = Object.assign(Object.create(null) as Record<string, unknown>, { a: tool() });
    expect(judgeToolDefinitions(record)).toEqual({ scorer: 1, passed: true, tools: 1 });
  });

  test.each([
    ["null", null],
    ["a string", "x"],
    ["undefined", undefined],
    ["a number", 3],
  ])("%s is no-listing", (_l, v) => {
    expect(judgeToolDefinitions(v)).toEqual({
      scorer: 1,
      passed: false,
      tools: 0,
      failure: "no-listing",
    } satisfies EvalBaseline);
  });
});

describe("parseEvalBaselineDocument", () => {
  test("accepts an ok document", () => {
    const text = JSON.stringify({
      ok: true,
      extensionId: "acme/x",
      version: "1.0.0",
      baseline: PASSED,
    });
    expect(parseEvalBaselineDocument(text)).toEqual({
      ok: true,
      extensionId: "acme/x",
      version: "1.0.0",
      baseline: PASSED,
    });
  });
  test("accepts an error document", () => {
    const text = JSON.stringify({ ok: false, error: { code: "E", message: "m" } });
    expect(parseEvalBaselineDocument(text)).toEqual({
      ok: false,
      error: { code: "E", message: "m" },
    });
  });
  test.each([
    ["garbage", "{nope"],
    ["an array", "[]"],
    [
      "a bad baseline",
      JSON.stringify({
        ok: true,
        extensionId: "a/b",
        version: "1.0.0",
        baseline: { passed: true },
      }),
    ],
    ["no extensionId", JSON.stringify({ ok: true, version: "1.0.0", baseline: PASSED })],
    ["no version", JSON.stringify({ ok: true, extensionId: "a/b", baseline: PASSED })],
    ["an error with no message", JSON.stringify({ ok: false, error: { code: "E" } })],
    ["no ok", JSON.stringify({ baseline: PASSED })],
  ])("%s is null", (_l, text) => {
    expect(parseEvalBaselineDocument(text)).toBeNull();
  });
});
