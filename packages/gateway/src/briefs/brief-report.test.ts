import { describe, expect, test } from "bun:test";
import { MAX_ITEM_TEXT_CHARS, MAX_SUMMARY_CHARS } from "./brief-constants.ts";
import { parseModelJson, SynthesisParseError, validateReport } from "./brief-report.ts";
import type { SourceRegistry, SourceRegistryEntry } from "./brief-types.ts";

function reg(...entries: SourceRegistryEntry[]): SourceRegistry {
  return new Map(entries.map((e) => [e.token, e]));
}

const S1: SourceRegistryEntry = {
  token: "S1",
  ref: { kind: "source", title: "MV3 docs", url: "https://x.test/a" },
  body: "Service workers terminate after 30 seconds of inactivity.",
};
const S2: SourceRegistryEntry = {
  token: "S2",
  ref: { kind: "source", title: "MDN", url: "https://y.test/b" },
  body: "Firefox keeps the worker alive indefinitely.",
};
const C1: SourceRegistryEntry = {
  token: "C1",
  ref: { kind: "clip", title: "Saved note", clipId: "nimbus:clip:abc" },
  body: "My earlier note about workers.",
};

describe("parseModelJson", () => {
  test("parses a well-formed payload", () => {
    const m = parseModelJson('{"summary":"s","findings":[],"conflicts":[],"gaps":[]}');
    expect(m.summary).toBe("s");
  });

  test("tolerates a fenced code block around the JSON", () => {
    const m = parseModelJson(
      '```json\n{"summary":"s","findings":[],"conflicts":[],"gaps":[]}\n```',
    );
    expect(m.summary).toBe("s");
  });

  test("throws on non-JSON", () => {
    expect(() => parseModelJson("I'm sorry, I can't help with that.")).toThrow(SynthesisParseError);
  });

  test("throws when a required field has the wrong type", () => {
    expect(() => parseModelJson('{"summary":5,"findings":[],"conflicts":[],"gaps":[]}')).toThrow(
      SynthesisParseError,
    );
  });

  // Additional coverage beyond the brief's 14 tests, to exercise branches the
  // above don't reach (a top-level non-object payload, non-array `findings`/
  // `refs`, the `gaps` default, and a malformed fence). Added, not modified —
  // none of the 14 tests above were changed.
  test("throws when the top-level JSON is not an object", () => {
    expect(() => parseModelJson("[]")).toThrow(SynthesisParseError);
  });

  test("throws when findings is not an array", () => {
    expect(() =>
      parseModelJson('{"summary":"s","findings":"nope","conflicts":[],"gaps":[]}'),
    ).toThrow(SynthesisParseError);
  });

  test("throws when a ref list is not an array", () => {
    expect(() =>
      parseModelJson(
        '{"summary":"s","findings":[{"text":"a","refs":"nope"}],"conflicts":[],"gaps":[]}',
      ),
    ).toThrow(SynthesisParseError);
  });

  test("defaults gaps to an empty array when omitted", () => {
    const m = parseModelJson('{"summary":"s","findings":[],"conflicts":[]}');
    expect(m.gaps).toEqual([]);
  });

  test("throws when a code fence has no closing marker", () => {
    expect(() => parseModelJson("```")).toThrow(SynthesisParseError);
  });
});

describe("validateReport", () => {
  test("keeps a finding whose refs all resolve", () => {
    const { report } = validateReport(
      { summary: "s", findings: [{ text: "f", refs: ["S1"] }], conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.citations[0]?.title).toBe("MV3 docs");
  });

  test("drops an unknown ref but keeps the finding when another survives", () => {
    const { report } = validateReport(
      { summary: "s", findings: [{ text: "f", refs: ["S1", "S9"] }], conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(report.findings[0]?.citations).toHaveLength(1);
  });

  test("drops a finding whose every ref is fabricated", () => {
    const { report } = validateReport(
      { summary: "s", findings: [{ text: "f", refs: ["S9", "S8"] }], conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(report.findings).toHaveLength(0);
  });

  test("drops a conflict with fewer than two distinct refs", () => {
    const { report } = validateReport(
      { summary: "s", findings: [], conflicts: [{ text: "c", refs: ["S1", "S1"] }], gaps: [] },
      reg(S1, S2),
    );
    expect(report.conflicts).toHaveLength(0);
  });

  test("keeps a conflict with two distinct refs", () => {
    const { report } = validateReport(
      { summary: "s", findings: [], conflicts: [{ text: "c", refs: ["S1", "S2"] }], gaps: [] },
      reg(S1, S2),
    );
    expect(report.conflicts).toHaveLength(1);
  });

  test("attaches a verified quote and drops an unverifiable one", () => {
    const { report } = validateReport(
      {
        summary: "s",
        findings: [
          { text: "a", refs: ["S1"], quotes: { S1: "terminate after 30 seconds" } },
          { text: "b", refs: ["S2"], quotes: { S2: "stays alive forever" } },
        ],
        conflicts: [],
        gaps: [],
      },
      reg(S1, S2),
    );
    expect(report.findings[0]?.citations[0]?.quote).toBe("terminate after 30 seconds");
    expect(report.findings[1]?.citations[0]?.quote).toBeUndefined();
    expect(report.findings[1]?.text).toBe("b"); // finding survives; only the quote goes
  });

  test("a fully fabricated report yields an empty but valid report", () => {
    const { report } = validateReport(
      {
        summary: "s",
        findings: [{ text: "f", refs: ["Z1"] }],
        conflicts: [{ text: "c", refs: ["Z1", "Z2"] }],
        gaps: [],
      },
      reg(S1),
    );
    expect(report.findings).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
    expect(report.summary).toBe("s");
  });

  test("bounds findings to 25 and reports the drop as a gap", () => {
    const findings = Array.from({ length: 40 }, (_, i) => ({ text: `f${i}`, refs: ["S1"] }));
    const { report, boundGaps } = validateReport(
      { summary: "s", findings, conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(report.findings).toHaveLength(25);
    expect(boundGaps.join(" ")).toContain("15");
  });

  test("bounds citations per item to 8", () => {
    const many = Array.from({ length: 12 }, () => S1.token);
    const { report } = validateReport(
      { summary: "s", findings: [{ text: "f", refs: many }], conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(report.findings[0]?.citations.length).toBeLessThanOrEqual(8);
  });

  test("resolves a clip ref to a clipId citation", () => {
    const { report } = validateReport(
      { summary: "s", findings: [{ text: "f", refs: ["C1"] }], conflicts: [], gaps: [] },
      reg(C1),
    );
    expect(report.findings[0]?.citations[0]?.clipId).toBe("nimbus:clip:abc");
    expect(report.findings[0]?.citations[0]?.kind).toBe("clip");
  });

  // Additional coverage beyond the brief's 14 tests: the given "bounds
  // citations per item to 8" test repeats a single known token, which the
  // dedup (`seen`) drops down to 1 citation before the MAX_CITATIONS_PER_ITEM
  // check ever fires. This test uses 9 DISTINCT known tokens so the bound
  // itself — not dedup — is what's exercised. Likewise MAX_CONFLICTS has no
  // dedicated test above; added for parity with the findings-bound test.
  test("bounds conflicts to 25 and reports the drop as a gap", () => {
    const conflicts = Array.from({ length: 40 }, (_, i) => ({
      text: `c${i}`,
      refs: ["S1", "S2"],
    }));
    const { report, boundGaps } = validateReport(
      { summary: "s", findings: [], conflicts, gaps: [] },
      reg(S1, S2),
    );
    expect(report.conflicts).toHaveLength(25);
    expect(boundGaps.join(" ")).toContain("15");
  });

  test("enforces the per-item citation bound with distinct sources", () => {
    const entries = Array.from({ length: 9 }, (_, i) => {
      const token = `T${i + 1}`;
      const entry: SourceRegistryEntry = {
        token,
        ref: { kind: "source", title: token, url: `https://z.test/${token}` },
        body: `Body text for ${token}.`,
      };
      return entry;
    });
    const { report } = validateReport(
      {
        summary: "s",
        findings: [{ text: "f", refs: entries.map((e) => e.token) }],
        conflicts: [],
        gaps: [],
      },
      reg(...entries),
    );
    expect(report.findings[0]?.citations).toHaveLength(8);
    expect(report.findings[0]?.citations.some((c) => c.title === "T9")).toBe(false);
  });

  // Finding 1 (Important, code review): the test above proves truncation
  // happens but never asserts that it is REPORTED. Silent truncation reads to
  // the user as absence of evidence, which is the failure `boundGaps` exists
  // to prevent. This test uses 9 DISTINCT registry entries (not repeats of one
  // token) so dedup cannot collapse the count before the bound fires.
  test("reports a boundGaps entry naming the limit when per-item citations are truncated", () => {
    const entries = Array.from({ length: 9 }, (_, i) => {
      const token = `U${i + 1}`;
      const entry: SourceRegistryEntry = {
        token,
        ref: { kind: "source", title: token, url: `https://z.test/${token}` },
        body: `Body text for ${token}.`,
      };
      return entry;
    });
    const { report, boundGaps } = validateReport(
      {
        summary: "s",
        findings: [{ text: "f", refs: entries.map((e) => e.token) }],
        conflicts: [],
        gaps: [],
      },
      reg(...entries),
    );
    expect(report.findings[0]?.citations).toHaveLength(8);
    expect(boundGaps.join(" ")).toContain("8 per item");
  });

  // Finding 2a: summary and item text are unbounded in length. These caps are
  // owned by this module (citation title/url are the registry's, not capped
  // here).
  test("truncates a summary longer than MAX_SUMMARY_CHARS and reports it", () => {
    const longSummary = "x".repeat(MAX_SUMMARY_CHARS + 500);
    const { report, boundGaps } = validateReport(
      { summary: longSummary, findings: [], conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(report.summary.length).toBe(MAX_SUMMARY_CHARS);
    expect(boundGaps.join(" ")).toContain(String(MAX_SUMMARY_CHARS));
  });

  test("truncates a finding's text longer than MAX_ITEM_TEXT_CHARS and reports it", () => {
    const longText = "y".repeat(MAX_ITEM_TEXT_CHARS + 200);
    const { report, boundGaps } = validateReport(
      { summary: "s", findings: [{ text: longText, refs: ["S1"] }], conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(report.findings[0]?.text.length).toBe(MAX_ITEM_TEXT_CHARS);
    expect(boundGaps.join(" ")).toContain(String(MAX_ITEM_TEXT_CHARS));
  });

  test("truncates a conflict's text longer than MAX_ITEM_TEXT_CHARS", () => {
    const longText = "z".repeat(MAX_ITEM_TEXT_CHARS + 50);
    const { report } = validateReport(
      { summary: "s", findings: [], conflicts: [{ text: longText, refs: ["S1", "S2"] }], gaps: [] },
      reg(S1, S2),
    );
    expect(report.conflicts[0]?.text.length).toBe(MAX_ITEM_TEXT_CHARS);
  });

  test("does not add a text-length boundGaps entry when nothing is truncated", () => {
    const { boundGaps } = validateReport(
      { summary: "short", findings: [{ text: "short", refs: ["S1"] }], conflicts: [], gaps: [] },
      reg(S1),
    );
    expect(boundGaps).toEqual([]);
  });
});
