/** Structure refusals of `capture-validate.ts` that name each field (lists, prose, lines, actions). */
import { describe, expect, test } from "bun:test";
import { CaptureError } from "./capture-types.ts";
import { validateCapturePayload } from "./capture-validate.ts";

function why(kind: Parameters<typeof validateCapturePayload>[0], raw: unknown): string {
  try {
    validateCapturePayload(kind, raw, 1);
  } catch (e) {
    if (e instanceof CaptureError) return e.message;
    throw e;
  }
  throw new Error("expected a CaptureError");
}

describe("string lists refuse their structure", () => {
  test("non-string, empty and over-long entries", () => {
    const note = (relatesTo: unknown) => ({ body: "b", relatesTo });
    expect(why("note", note(["a", 5]))).toContain("relatesTo entries must be strings");
    expect(why("note", note(["a", "  "]))).toContain("relatesTo entries must not be empty");
    expect(why("note", note(["x".repeat(513)]))).toContain("at most 512 characters");
    expect(why("note", note("nope"))).toContain("relatesTo must be an array of strings");
    expect(why("note", note(Array.from({ length: 11 }, (_, i) => `id${String(i)}`)))).toContain(
      "allows at most 10 entries",
    );
  });

  test("duplicates collapse", () => {
    const v = validateCapturePayload("note", { body: "b", relatesTo: ["a", " a ", "b"] }, 1);
    expect(v.kind === "note" && v.payload.relatesTo).toEqual(["a", "b"]);
  });
});

describe("decision payload", () => {
  test("statement is required and must be a non-empty string", () => {
    expect(why("decision", {})).toContain("statement is required");
    expect(why("decision", { statement: null })).toContain("statement is required");
    expect(why("decision", { statement: 5 })).toContain("statement must be a string");
    expect(why("decision", { statement: "  " })).toContain("statement must not be empty");
  });

  test("optional prose that is blank becomes null; alternatives refuse a non-array and dedupe", () => {
    const v = validateCapturePayload(
      "decision",
      { statement: "s", rationale: "   ", alternatives: ["x", "x", "y"], decidedAt: 5 },
      1,
    );
    expect(v.kind === "decision" && v.payload).toMatchObject({
      rationale: null,
      alternatives: ["x", "y"],
      decidedAt: 5,
    });
    expect(why("decision", { statement: "s", alternatives: "x" })).toContain(
      "alternatives must be an array of strings",
    );
    expect(
      why("decision", { statement: "s", alternatives: Array.from({ length: 11 }, () => "a") }),
    ).toContain("alternatives allows at most 10 entries");
    expect(why("decision", { statement: "s", rationale: 7 })).toContain(
      "rationale must be a string",
    );
  });

  test("decidedAt must be a bounded integer", () => {
    for (const bad of ["1", 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(why("decision", { statement: "s", decidedAt: bad })).toContain("decidedAt");
    }
  });
});

describe("term, link and action payloads", () => {
  test("term refuses a non-string, a blank, an over-long or a wordless term", () => {
    expect(why("term", { term: 5, definition: "d" })).toContain("term must be a string");
    expect(why("term", { term: " ", definition: "d" })).toContain("must not be empty");
    expect(why("term", { term: "t".repeat(101), definition: "d" })).toContain("at most 100");
    expect(why("term", { term: "!!!", definition: "d" })).toContain("no word characters");
    expect(why("term", { term: "ok" })).toContain("definition is required");
    expect(why("term", { term: "ok", definition: " " })).toContain("definition must not be empty");
  });

  test("link refuses bad ids, equal ids, an unknown relation and a non-string note", () => {
    const base = { fromItemId: "a", toItemId: "b", relation: "fixes" };
    expect(why("link", { ...base, fromItemId: 5 })).toContain("fromItemId must be a string");
    expect(why("link", { ...base, toItemId: "" })).toContain("toItemId must not be empty");
    expect(why("link", { ...base, toItemId: "x".repeat(513) })).toContain("at most");
    expect(why("link", { ...base, toItemId: "a" })).toContain("must differ");
    expect(why("link", { ...base, relation: "loves" })).toContain("relation must be one of");
    expect(why("link", { ...base, note: 5 })).toContain("note must be a string");
    const ok = validateCapturePayload("link", { ...base, note: "  " }, 1);
    expect(ok.kind === "link" && ok.payload.note).toBeNull();
  });

  test("action refuses a bad type, a non-object input and any mcpToolId", () => {
    const base = { actionType: "slack.message.post", input: {}, summary: "s" };
    expect(why("action", { ...base, actionType: "has space" })).toContain("actionType");
    expect(why("action", { ...base, actionType: 5 })).toContain("actionType");
    expect(why("action", { ...base, input: [] })).toContain("input must be a JSON object");
    expect(why("action", { ...base, input: null })).toContain("input must be a JSON object");
    expect(why("action", { ...base, mcpToolId: "x" })).toContain("mcpToolId");
    expect(why("action", { ...base, input: { mcpToolId: "x" } })).toContain("mcpToolId");
    expect(why("action", { ...base, summary: undefined })).toContain("summary is required");
    expect(why("action", "text")).toContain("payload must be an object");
  });

  test("a payload over 64 KiB is refused after the rebuild", () => {
    const big = { actionType: "a.b", input: { blob: "x".repeat(70_000) }, summary: "s" };
    expect(why("action", big)).toContain("payload exceeds 65536 bytes");
  });
});
