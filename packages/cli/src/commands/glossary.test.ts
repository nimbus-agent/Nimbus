import { expect, test } from "bun:test";

import { isGlossaryBriefLike, parseGlossaryArgs } from "./glossary.ts";

test("no arguments yields a list request", () => {
  const a = parseGlossaryArgs([]);
  expect(a.term).toBeUndefined();
  expect(a.json).toBe(false);
});

test("a positional argument becomes the term", () => {
  expect(parseGlossaryArgs(["CDR"]).term).toBe("CDR");
});

test("a multi-word term is joined", () => {
  expect(parseGlossaryArgs(["Change", "Data", "Record"]).term).toBe("Change Data Record");
});

test("--json sets the json flag", () => {
  expect(parseGlossaryArgs(["--json"]).json).toBe(true);
});

test("--limit parses a positive integer", () => {
  expect(parseGlossaryArgs(["--limit", "10"]).limit).toBe(10);
});

test("--limit rejects a non-positive value", () => {
  expect(() => parseGlossaryArgs(["--limit", "0"])).toThrow();
});

test("--limit rejects a missing value", () => {
  expect(() => parseGlossaryArgs(["--limit"])).toThrow();
});

test("--refresh and --rebuild fail loudly instead of running an ordinary query", () => {
  // The gateway handler reads only `term` and `limit`. Accepting these flags
  // meant `nimbus glossary --rebuild` printed a normal listing while the user
  // believed the glossary had been re-derived from scratch.
  expect(() => parseGlossaryArgs(["--refresh"])).toThrow(/--refresh is not implemented yet/);
  expect(() => parseGlossaryArgs(["--rebuild"])).toThrow(/--rebuild is not implemented yet/);
  expect(() => parseGlossaryArgs(["CDR", "--rebuild"])).toThrow(/Nothing was rebuilt/);
});

test("the usage line does not advertise the unwired flags", () => {
  let usage = "";
  try {
    parseGlossaryArgs(["--help"]);
  } catch (err) {
    usage = err instanceof Error ? err.message : "";
  }
  expect(usage).toContain("nimbus glossary");
  expect(usage).not.toContain("--refresh");
  expect(usage).not.toContain("--rebuild");
});

test("flags combine with a term", () => {
  const a = parseGlossaryArgs(["CDR", "--json"]);
  expect(a.term).toBe("CDR");
  expect(a.json).toBe(true);
});

test("isGlossaryBriefLike accepts a well-formed brief", () => {
  expect(isGlossaryBriefLike({ kind: "glossary", entries: [], gaps: [], mode: "list" })).toBe(true);
});

test("isGlossaryBriefLike rejects malformed payloads", () => {
  expect(isGlossaryBriefLike(null)).toBe(false);
  expect(isGlossaryBriefLike({ kind: "why", entries: [], gaps: [], mode: "list" })).toBe(false);
  expect(isGlossaryBriefLike({ kind: "glossary", entries: "no", gaps: [], mode: "list" })).toBe(
    false,
  );
});

// --- Supplementary tests beyond the brief's 11, added to close branch-coverage gaps
// (local coverage tooling did not produce numbers in this environment; gaps identified
// by manual review of parseGlossaryArgs / isGlossaryBriefLike). See task-15-report.md.

test("--help and -h throw usage", () => {
  expect(() => parseGlossaryArgs(["--help"])).toThrow();
  expect(() => parseGlossaryArgs(["-h"])).toThrow();
});

test("an unknown flag throws", () => {
  expect(() => parseGlossaryArgs(["--bogus"])).toThrow();
});

test("isGlossaryBriefLike rejects non-object, non-null values", () => {
  expect(isGlossaryBriefLike("glossary")).toBe(false);
  expect(isGlossaryBriefLike(42)).toBe(false);
  expect(isGlossaryBriefLike(undefined)).toBe(false);
});

test("isGlossaryBriefLike rejects a non-string mode", () => {
  expect(isGlossaryBriefLike({ kind: "glossary", entries: [], gaps: [], mode: 1 })).toBe(false);
});

test("isGlossaryBriefLike rejects non-array gaps", () => {
  expect(isGlossaryBriefLike({ kind: "glossary", entries: [], gaps: "no", mode: "list" })).toBe(
    false,
  );
});
