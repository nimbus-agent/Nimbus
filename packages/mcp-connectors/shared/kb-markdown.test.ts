import { describe, expect, test } from "bun:test";
import {
  type KbCitation,
  markdownToConfluenceStorage,
  markdownToNotionBlocks,
  parseCitationsJson,
  parseSimpleMarkdown,
} from "./kb-markdown.ts";

const cites: KbCitation[] = [
  { itemId: "slack:C1:1", channelId: "C1", url: "https://s/1" },
  { itemId: "slack:C1:2", channelId: "C1", url: null },
];

describe("parseSimpleMarkdown", () => {
  test("classifies bullets, paragraphs, skips blanks", () => {
    expect(parseSimpleMarkdown("Intro line\n\n- one\n- two\nOutro")).toEqual([
      { kind: "paragraph", text: "Intro line" },
      { kind: "bullet", text: "one" },
      { kind: "bullet", text: "two" },
      { kind: "paragraph", text: "Outro" },
    ]);
  });

  test("paragraph fallback never throws on stray markup (header/code line)", () => {
    const lines = parseSimpleMarkdown("# Title\n```\ncode\n```\n| a | b |");
    // every non-blank line degrades to a paragraph; no throw
    expect(lines.every((l) => l.kind === "paragraph")).toBe(true);
    expect(lines[0]?.text).toBe("# Title");
  });
});

describe("markdownToNotionBlocks", () => {
  test("emits paragraph + bullet blocks then a Sources section", () => {
    const blocks = markdownToNotionBlocks("Answer text\n\n- step one", cites);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    expect(blocks[1]).toMatchObject({ type: "bulleted_list_item" });
    // Sources paragraph + 2 citation bullets
    const sources = blocks.find(
      (b) => b["type"] === "paragraph" && JSON.stringify(b).includes("Sources:"),
    );
    expect(sources).toBeDefined();
    const linked = blocks.find((b) => JSON.stringify(b).includes("https://s/1"));
    expect(linked).toBeDefined();
  });

  test("a stray header line becomes paragraph text, not a thrown error", () => {
    expect(() => markdownToNotionBlocks("# Heading\nbody", [])).not.toThrow();
    const blocks = markdownToNotionBlocks("# Heading", []);
    expect(JSON.stringify(blocks)).toContain("# Heading");
  });
});

describe("markdownToConfluenceStorage", () => {
  test("renders <p>, <ul><li>, and a Sources list with escaped HTML", () => {
    const html = markdownToConfluenceStorage("Answer <b>x</b>\n\n- one\n- two", cites);
    expect(html).toContain("<p>Answer &lt;b&gt;x&lt;/b&gt;</p>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<p>Sources:</p>");
    expect(html).toContain(`<a href="https://s/1">`);
  });

  test("stray markup degrades to a paragraph (no throw)", () => {
    expect(() => markdownToConfluenceStorage("```\ncode\n```", [])).not.toThrow();
  });
});

describe("parseCitationsJson", () => {
  test("parses well-formed citations and drops malformed entries", () => {
    const raw = JSON.stringify([
      { itemId: "i1", channelId: "C1", url: "u1" },
      { itemId: "i2", channelId: "C1" },
      { itemId: 5, channelId: "C1" },
      "nope",
    ]);
    expect(parseCitationsJson(raw)).toEqual([
      { itemId: "i1", channelId: "C1", url: "u1" },
      { itemId: "i2", channelId: "C1", url: null },
    ]);
  });

  test("invalid JSON → empty array (never throws)", () => {
    expect(parseCitationsJson("not json")).toEqual([]);
    expect(parseCitationsJson("{}")).toEqual([]);
  });
});
