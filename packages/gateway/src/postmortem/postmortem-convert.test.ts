import { describe, expect, test } from "bun:test";

import { renderIncidentPostmortem } from "../agents/_lib/incident-postmortem-render.ts";
import { buildPostmortemFixture } from "../incident/__fixtures__/postmortem-brief.ts";
import {
  cleanTitle,
  matchHeading,
  matchItem,
  NOTION_MAX_BLOCKS,
  type PostmortemConvertError,
  splitTitleAndBody,
  toConfluenceStorage,
  toNotionBlocksJson,
} from "./postmortem-convert.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as PostmortemConvertError).code;
  }
  return undefined;
}

describe("toConfluenceStorage", () => {
  test("headings, paragraphs, lists, code and inline marks", () => {
    const html = toConfluenceStorage(
      [
        "## Summary",
        "",
        "First line",
        "continues here with **bold**, _italic_, *also* and `code`.",
        "",
        "- one",
        "* two",
        "",
        "```",
        "a < b && c",
        "```",
      ].join("\n"),
    );
    expect(html).toBe(
      "<h2>Summary</h2><p>First line continues here with <strong>bold</strong>, <em>italic</em>, <em>also</em> and <code>code</code>.</p><ul><li>one</li><li>two</li></ul><pre>a &lt; b &amp;&amp; c</pre>",
    );
  });

  test("raw HTML is escaped, never interpreted", () => {
    const html = toConfluenceStorage(
      '<script>alert(1)</script> <img src="http://x/y.png"> <iframe>',
    );
    expect(html).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=&quot;http://x/y.png&quot;&gt; &lt;iframe&gt;</p>",
    );
    expect(html).not.toMatch(/<(?:script|img|iframe)/);
  });

  test("only http and https links keep their target; the rest keep their text", () => {
    const html = toConfluenceStorage(
      "[ok](https://example.com/a?b=1&c=2) [js](javascript:alert(1)) [data](data:text/html,x) [file](file:///etc/passwd) [rel](/x) [empty]()",
    );
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">ok</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("file:///");
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain("js) data file rel empty");
  });

  test("a link target over 2,000 characters keeps its text only; code and link marks combine in Notion", () => {
    const long = `[t](https://e.com/${"a".repeat(2_001)})`;
    expect(toConfluenceStorage(long)).toBe("<p>t</p>");
    const blocks = JSON.parse(toNotionBlocksJson("**b** *i* `c`")) as {
      paragraph: { rich_text: { annotations?: object }[] };
    }[];
    expect(blocks[0]?.paragraph.rich_text.map((r) => r.annotations)).toEqual([
      { bold: true },
      undefined,
      { italic: true },
      undefined,
      { code: true },
    ]);
  });

  test("backslash escapes become literal text, so the draft's escaped titles round-trip", () => {
    expect(toConfluenceStorage("\\[not a link\\](x) and \\_not italic\\_")).toBe(
      "<p>[not a link](x) and _not italic_</p>",
    );
  });

  test("a Markdown image is refused, in a line or a heading, but not inside a code span or a fence", () => {
    expect(codeOf(() => toConfluenceStorage("see ![x](http://e/x.png)"))).toBe(
      "ERR_POSTMORTEM_PUSH_IMAGE",
    );
    expect(codeOf(() => toConfluenceStorage("## ![x][ref]"))).toBe("ERR_POSTMORTEM_PUSH_IMAGE");
    expect(toConfluenceStorage("write `![x](y)` literally")).toContain("<code>![x](y)</code>");
    expect(toConfluenceStorage("```\n![x](y)\n```")).toBe("<pre>![x](y)</pre>");
  });

  test("an unterminated fence runs to the end; a heading-looking line inside a fence stays code", () => {
    expect(toConfluenceStorage("```\n# not a heading\nmore")).toBe(
      "<pre># not a heading\nmore</pre>",
    );
  });

  test("blockquotes lose their marker; invisible characters become spaces; empty input is refused", () => {
    expect(toConfluenceStorage("> quoted\u202etext")).toBe("<p>quoted text</p>");
    expect(codeOf(() => toConfluenceStorage("   \n\n"))).toBe("ERR_POSTMORTEM_PUSH_EMPTY");
  });

  test("the real default draft converts and carries no remote-content element", () => {
    const html = toConfluenceStorage(renderIncidentPostmortem(buildPostmortemFixture()));
    expect(html).toContain("<h2>Timeline</h2>");
    expect(html).not.toMatch(/<(?:img|iframe|embed|object|link|script|style)\b/i);
  });
});

describe("toNotionBlocksJson", () => {
  test("headings cap at level 3, lists, code and annotations", () => {
    const blocks = JSON.parse(
      toNotionBlocksJson("# One\n#### Four\ntext **b** [l](https://e.com)\n- item\n```\nx\n```"),
    ) as Record<string, unknown>[];
    expect(blocks.map((b) => b["type"])).toEqual([
      "heading_1",
      "heading_3",
      "paragraph",
      "bulleted_list_item",
      "code",
    ]);
    const para = (blocks[2] as { paragraph: { rich_text: unknown[] } }).paragraph.rich_text;
    expect(para).toEqual([
      { type: "text", text: { content: "text " } },
      { type: "text", text: { content: "b" }, annotations: { bold: true } },
      { type: "text", text: { content: " " } },
      { type: "text", text: { content: "l", link: { url: "https://e.com" } } },
    ]);
  });

  test("rich text is split at 2,000 characters and a paragraph over 100 items is refused", () => {
    const blocks = JSON.parse(toNotionBlocksJson("a".repeat(4_500))) as {
      paragraph: { rich_text: { text: { content: string } }[] };
    }[];
    expect(blocks[0]?.paragraph.rich_text.map((r) => r.text.content.length)).toEqual([
      2000, 2000, 500,
    ]);
    expect(codeOf(() => toNotionBlocksJson("a".repeat(2_000 * 101)))).toBe(
      "ERR_POSTMORTEM_PUSH_TOO_LARGE",
    );
  });

  test("an astral character at the 2,000 boundary is never split", () => {
    const text = `${"a".repeat(1_999)}😀${"b".repeat(5)}`;
    const blocks = JSON.parse(toNotionBlocksJson(text)) as {
      paragraph: { rich_text: { text: { content: string } }[] };
    }[];
    const parts = blocks[0]?.paragraph.rich_text.map((r) => r.text.content) ?? [];
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(p).toBe(Array.from(p).join(""));
    expect(parts.every((p) => Array.from(p).length <= 2000)).toBe(true);
  });

  test("more than 100 blocks is refused, 100 is accepted; an empty file or empty fence is refused", () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `- item ${String(i)}`).join("\n");
    expect(JSON.parse(toNotionBlocksJson(lines(NOTION_MAX_BLOCKS)))).toHaveLength(
      NOTION_MAX_BLOCKS,
    );
    expect(codeOf(() => toNotionBlocksJson(lines(NOTION_MAX_BLOCKS + 1)))).toBe(
      "ERR_POSTMORTEM_PUSH_TOO_LARGE",
    );
    expect(codeOf(() => toNotionBlocksJson("\n\n"))).toBe("ERR_POSTMORTEM_PUSH_EMPTY");
    expect(codeOf(() => toNotionBlocksJson("```\n\n```"))).toBe("ERR_POSTMORTEM_PUSH_EMPTY");
  });

  test("an image is refused and a non-http link keeps its text only", () => {
    expect(codeOf(() => toNotionBlocksJson("![x](http://e/x.png)"))).toBe(
      "ERR_POSTMORTEM_PUSH_IMAGE",
    );
    const json = toNotionBlocksJson("[x](javascript:alert(1))");
    expect(json).not.toContain("javascript");
    expect(json).not.toContain('"link"');
  });

  test("the real default draft fits one append", () => {
    const blocks = JSON.parse(
      toNotionBlocksJson(renderIncidentPostmortem(buildPostmortemFixture())),
    );
    expect(blocks.length).toBeGreaterThan(10);
    expect(blocks.length).toBeLessThanOrEqual(NOTION_MAX_BLOCKS);
  });
});

describe("splitTitleAndBody and cleanTitle", () => {
  test("the leading H1 is the title and is dropped from the body; unescaped", () => {
    expect(splitTitleAndBody("\n\n# Post-mortem: a \\[b\\] ##\nbody\n", undefined)).toEqual({
      title: "Post-mortem: a [b]",
      body: "body\n",
    });
  });

  test("--title replaces the heading; a file with neither is refused; a deeper heading is not a title", () => {
    expect(splitTitleAndBody("# H\nbody", "Mine")).toEqual({ title: "Mine", body: "body" });
    expect(splitTitleAndBody("no heading\nbody", "Mine").body).toBe("no heading\nbody");
    expect(codeOf(() => splitTitleAndBody("body only", undefined))).toBe(
      "ERR_POSTMORTEM_PUSH_TITLE",
    );
    expect(codeOf(() => splitTitleAndBody("## second level\nx", undefined))).toBe(
      "ERR_POSTMORTEM_PUSH_TITLE",
    );
    expect(codeOf(() => splitTitleAndBody("", undefined))).toBe("ERR_POSTMORTEM_PUSH_TITLE");
  });

  test("a file over 256 KiB is refused", () => {
    expect(codeOf(() => splitTitleAndBody(`# t\n${"x".repeat(300_000)}`, undefined))).toBe(
      "ERR_POSTMORTEM_PUSH_TOO_LARGE",
    );
  });

  test("a title is cleaned of control and bidi characters and limited to 200 characters", () => {
    expect(cleanTitle("  a\u202e\u0007  b\n c ")).toBe("a b c");
    expect(codeOf(() => cleanTitle("   "))).toBe("ERR_POSTMORTEM_PUSH_TITLE");
    expect(codeOf(() => cleanTitle("x".repeat(201)))).toBe("ERR_POSTMORTEM_PUSH_TITLE");
    expect(cleanTitle("x".repeat(200))).toHaveLength(200);
  });
});

describe("matchHeading and matchItem equal the former regexes", () => {
  const formerHeading = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
  const formerTitle = /^#[ \t]+(.+?)[ \t#]*$/;
  const formerItem = /^[ \t]*[-*+][ \t]+(.*)$/;
  const asHeading = (m: RegExpExecArray | null) =>
    m === null ? null : { level: (m[1] as string).length, text: m[2] as string };

  test("every line of up to 7 characters over hashes, blanks, list markers, text and line terminators", () => {
    const alphabet = ["#", " ", "\t", "a", "-", "*", "\r", "\u2028"];
    let level = [""];
    for (let len = 1; len <= 7; len += 1) {
      level = level.flatMap((p) => alphabet.map((c) => p + c));
      for (const line of level) {
        const t = formerTitle.exec(line);
        const got = [matchHeading(line, 6), matchHeading(line, 1)?.text ?? null, matchItem(line)];
        const want = [
          asHeading(formerHeading.exec(line)),
          t === null ? null : (t[1] as string),
          formerItem.exec(line)?.[1] ?? null,
        ];
        if (JSON.stringify(got) !== JSON.stringify(want)) expect([line, got]).toEqual([line, want]);
      }
    }
    expect(matchHeading("####### x", 6)).toBeNull();
    expect(matchHeading("###### x ##", 6)).toEqual({ level: 6, text: "x" });
  });

  test("long blank runs stay linear", () => {
    const long = `# a${" ".repeat(100_000)}b\r`;
    const t0 = performance.now();
    expect(matchHeading(long, 6)).toBeNull();
    expect(matchItem(`- ${" ".repeat(100_000)}\r`)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
