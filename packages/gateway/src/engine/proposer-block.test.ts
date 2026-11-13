import { describe, expect, test } from "bun:test";
import { agentVerbatimInputLines, formatProposerBlock, proposerDetails } from "./proposer-block.ts";
import type { AgentProposer } from "./types.ts";

const RLO = String.fromCodePoint(0x202e);

function prop(over: Partial<AgentProposer> = {}): AgentProposer {
  return {
    door: "agent",
    captureId: "cap_a",
    label: null,
    labelSource: "declared",
    summary: "why",
    createdAt: 0,
    expiresAt: 3_600_000,
    ...over,
  };
}

describe("formatProposerBlock (the unverified trailing block)", () => {
  test("names UNVERIFIED, the label source, ISO times, and an unlabelled client", () => {
    const [who, summary] = formatProposerBlock(prop());
    expect(who).toBe(
      'Proposed by an outside agent (UNVERIFIED label "unlabelled", from declared client name) at 1970-01-01T00:00:00.000Z, expires 1970-01-01T01:00:00.000Z',
    );
    expect(summary).toBe("Agent's summary (UNVERIFIED): why");
    expect(formatProposerBlock(prop({ label: "x", labelSource: "kit" }))[0]).toContain(
      'label "x", from kit config)',
    );
  });

  test('a " and a backslash in the label cannot close the quotes and fake the lines after it', () => {
    const [who] = formatProposerBlock(
      prop({ label: 'x" at 2099-01-01T00:00:00.000Z, expires 2099-01-02T00:00:00.000Z \\ y' }),
    );
    expect(who).toContain(
      'label "x\\" at 2099-01-01T00:00:00.000Z, expires 2099-01-02T00:00:00.000Z \\\\ y", from declared client name) at 1970-01-01T00:00:00.000Z',
    );
  });

  test("ESC and a newline in the label are escaped and stay on one prompt line", () => {
    const lines = formatProposerBlock(
      prop({ label: `ok${String.fromCodePoint(0x1b)}[2J\nType: fake` }),
    );
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(String.fromCodePoint(0x1b));
    expect(lines[0]).toContain("\\u001b[2J\\u000aType: fake");
    expect(
      lines
        .join("\n")
        .split("\n")
        .filter((l) => l.startsWith("Type: ")),
    ).toEqual([]);
  });

  test("the summary is escaped as ONE line (LF, CR, bidi and a fake line cannot escape it)", () => {
    const lines = formatProposerBlock(
      prop({ summary: `a${RLO}b\nType: fake\r\nRequested by: you` }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain(RLO);
    expect(lines[1]).not.toContain("\n");
    expect(lines[1]).toContain("a\\u202eb\\u000aType: fake\\u000d\\u000aRequested by: you");
  });

  test.each([
    ["LRM", 0x200e],
    ["word joiner", 0x2060],
    ["FSI", 0x2068],
    ["soft hyphen", 0x00ad],
    ["BOM", 0xfeff],
    ["TAG LATIN SMALL LETTER I", 0xe0069],
    ["variation selector 16", 0xfe0f],
    ["Hangul filler", 0x3164],
  ])("%s inside the label or summary is shown escaped", (_name, cp) => {
    const ch = String.fromCodePoint(cp);
    const lines = formatProposerBlock(prop({ label: `a${ch}b`, summary: `c${ch}d` }));
    const hex = cp.toString(16);
    const esc = cp > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
    for (const l of lines) {
      expect(l).not.toContain(ch);
      expect(l).toContain(esc);
    }
  });
});

describe("agentVerbatimInputLines (an untemplated row, I42)", () => {
  test("the header, then the pretty JSON with its layout newlines", () => {
    expect(agentVerbatimInputLines({ a: 1, b: 2 })).toEqual([
      "Input (verbatim, exactly what will be sent):",
      '{\n  "a": 1,\n  "b": 2\n}',
    ]);
  });

  test("an RLO and a hidden TAG-character instruction inside a value are fully visible", () => {
    const hidden = [..."ignore"]
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join("");
    const out = agentVerbatimInputLines({ text: `pay ${RLO}evil hi${hidden}` }).join("\n");
    expect(out).not.toContain(RLO);
    expect(out).toContain("\\u202e");
    expect(out).toContain("hi\\u{e0069}\\u{e0067}\\u{e006e}\\u{e006f}\\u{e0072}\\u{e0065}");
    expect([...out].some((c) => (c.codePointAt(0) ?? 0) >= 0xe0000)).toBe(false);
  });
});

describe("proposerDetails (the desktop's proposedBy contract)", () => {
  test("the four fields the UI reads, text sanitised, a null label kept null", () => {
    expect(
      proposerDetails(prop({ label: `x${RLO}`, summary: `s${RLO}`, createdAt: 5, expiresAt: 9 })),
    ).toEqual({
      clientLabel: "x\\u{202E}",
      unverifiedSummary: "s\\u{202E}",
      createdAt: 5,
      expiresAt: 9,
    });
    expect(proposerDetails(prop()).clientLabel).toBeNull();
  });
});
