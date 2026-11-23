import { describe, expect, test } from "bun:test";
import {
  MARKUP_MAX_TOKENS,
  type MarkupToken,
  REMOTE_SCAN_MAX_CHARS,
  tokenizeMarkup,
} from "./markup-tokens.ts";

const VT = String.fromCodePoint(0x0b);
const FF = String.fromCodePoint(0x0c);
const NBSP = String.fromCodePoint(0xa0);
const FULLWIDTH_QUOTE = String.fromCodePoint(0xff02);

function tokens(src: string): readonly MarkupToken[] {
  const t = tokenizeMarkup(src);
  if (t === undefined) throw new Error(`does not tokenize: ${src}`);
  return t;
}

/** The tokens without offsets, for exact comparisons. */
function shapes(src: string): unknown[] {
  return tokens(src).map((t) => {
    const { start: _s, end: _e, ...rest } = t;
    return rest;
  });
}

describe("tokenizeMarkup: exact tokens (plan R7)", () => {
  test("a start tag, text and an end tag", () => {
    expect(shapes(`<p class="a">x</p>`)).toEqual([
      {
        kind: "start",
        name: "p",
        attrs: [{ name: "class", value: "a", quoted: true }],
        selfClosing: false,
      },
      { kind: "text", text: "x" },
      { kind: "end", name: "p" },
    ]);
  });

  test("an unquoted value keeps its trailing `/` (HTML does)", () => {
    expect(shapes("<img src=x/>")).toEqual([
      {
        kind: "start",
        name: "img",
        attrs: [{ name: "src", value: "x/", quoted: false }],
        selfClosing: false,
      },
    ]);
  });

  test("`/` between the name and an attribute is a separator; `/>` is self-closing", () => {
    expect(shapes(`<img/src="x">`)).toEqual([
      {
        kind: "start",
        name: "img",
        attrs: [{ name: "src", value: "x", quoted: true }],
        selfClosing: false,
      },
    ]);
    expect(shapes(`<br/>`)).toEqual([{ kind: "start", name: "br", attrs: [], selfClosing: true }]);
    expect(shapes(`<img src="x" />`)).toEqual([
      {
        kind: "start",
        name: "img",
        attrs: [{ name: "src", value: "x", quoted: true }],
        selfClosing: true,
      },
    ]);
  });

  test("a `>` inside a quoted value does not end the tag", () => {
    expect(shapes(`<a title="x>">`)).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [{ name: "title", value: "x>", quoted: true }],
        selfClosing: false,
      },
    ]);
    expect(shapes(`<a b='"'>`)).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [{ name: "b", value: '"', quoted: true }],
        selfClosing: false,
      },
    ]);
  });

  test("VT is not tag whitespace: the value is unquoted and starts with VT", () => {
    expect(shapes(`<a b=${VT}"x>`)).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [{ name: "b", value: `${VT}"x`, quoted: false }],
        selfClosing: false,
      },
    ]);
  });

  test("NBSP and a fullwidth quote are ordinary characters (no normalisation)", () => {
    expect(shapes(`<a b=${NBSP}c>`)).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [{ name: "b", value: `${NBSP}c`, quoted: false }],
        selfClosing: false,
      },
    ]);
    const t = tokens(`<a b=${FULLWIDTH_QUOTE}c><link href=//h>${FULLWIDTH_QUOTE}>`);
    expect(t.map((x) => x.kind)).toEqual(["start", "start", "text"]);
    expect(t[1]).toMatchObject({ kind: "start", name: "link" });
  });

  test("whitespace around `=` and LF, TAB, FF and CR inside a tag", () => {
    expect(shapes(`<link\n\thref\n=\n"//h">`)).toEqual([
      {
        kind: "start",
        name: "link",
        attrs: [{ name: "href", value: "//h", quoted: true }],
        selfClosing: false,
      },
    ]);
    expect(shapes(`<a${FF}b\r=c>`)).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [{ name: "b", value: "c", quoted: false }],
        selfClosing: false,
      },
    ]);
  });

  test("an attribute after a quoted value with no space, a value-less attribute, an empty value", () => {
    expect(shapes(`<a b="1"c d e=>`)).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [
          { name: "b", value: "1", quoted: true },
          { name: "c", value: "", quoted: false },
          { name: "d", value: "", quoted: false },
          { name: "e", value: "", quoted: false },
        ],
        selfClosing: false,
      },
    ]);
  });

  test("a leading `=` is part of an attribute name", () => {
    expect(shapes("<a =b=c>")).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [{ name: "=b", value: "c", quoted: false }],
        selfClosing: false,
      },
    ]);
  });

  test("`<` inside a tag is part of a name: `<a <b>` and `<im<x>`", () => {
    expect(shapes("<a <b>")).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [{ name: "<b", value: "", quoted: false }],
        selfClosing: false,
      },
    ]);
    expect(shapes("<im<x>")).toEqual([
      { kind: "start", name: "im<x", attrs: [], selfClosing: false },
    ]);
  });

  test("comments, including the empty forms and `--!>`", () => {
    expect(shapes("<!-- a -->")).toEqual([{ kind: "comment", text: " a " }]);
    expect(shapes("<!-->")).toEqual([{ kind: "comment", text: "" }]);
    expect(shapes("<!--->")).toEqual([{ kind: "comment", text: "" }]);
    expect(shapes("<!---->")).toEqual([{ kind: "comment", text: "" }]);
    expect(shapes("<!-- a --!>")).toEqual([{ kind: "comment", text: " a " }]);
    // A `--` that closes nothing is skipped; a run of dashes closes at its last two.
    expect(shapes("<!-- a -- b -- c -->")).toEqual([{ kind: "comment", text: " a -- b -- c " }]);
    expect(shapes("<!-- a --->")).toEqual([{ kind: "comment", text: " a -" }]);
    expect(tokenizeMarkup("<!-- a -- b")).toBeUndefined();
    // The first of the two closers ends it.
    expect(shapes("<!-- a --!> b -->")).toEqual([
      { kind: "comment", text: " a " },
      { kind: "text", text: " b -->" },
    ]);
    expect(shapes("<!-- a --> b --!>")).toEqual([
      { kind: "comment", text: " a " },
      { kind: "text", text: " b --!>" },
    ]);
  });

  test("CDATA (case-sensitive); a lower-case form is a declaration", () => {
    expect(shapes("<![CDATA[a]]>")).toEqual([{ kind: "cdata", text: "a" }]);
    expect(shapes("<![CDATA[x>y]]>")).toEqual([{ kind: "cdata", text: "x>y" }]);
    expect(shapes("<![cdata[a]]>")).toEqual([{ kind: "declaration", text: "![cdata[a]]" }]);
  });

  test("declarations: `<?x?>`, `<!DOCTYPE html>`, `</1>`, `<!x>`, `</>`", () => {
    expect(shapes("<?x?>")).toEqual([{ kind: "declaration", text: "?x?" }]);
    expect(shapes("<!DOCTYPE html>")).toEqual([{ kind: "declaration", text: "!DOCTYPE html" }]);
    expect(shapes("</1>")).toEqual([{ kind: "declaration", text: "/1" }]);
    expect(shapes("<!x>")).toEqual([{ kind: "declaration", text: "!x" }]);
    expect(shapes("</>")).toEqual([{ kind: "declaration", text: "/" }]);
  });

  test("a `<` that opens nothing is text, and consecutive text is one token", () => {
    expect(shapes("a < b")).toEqual([{ kind: "text", text: "a < b" }]);
    expect(shapes("a <1")).toEqual([{ kind: "text", text: "a <1" }]);
    expect(shapes("a <")).toEqual([{ kind: "text", text: "a <" }]);
    expect(shapes("<p>a < b</p>")).toEqual([
      { kind: "start", name: "p", attrs: [], selfClosing: false },
      { kind: "text", text: "a < b" },
      { kind: "end", name: "p" },
    ]);
  });

  test("`if a<b then</p>`: `<b` opens a tag whose attribute is `then<`", () => {
    expect(shapes("<p>if a<b then</p>")).toEqual([
      { kind: "start", name: "p", attrs: [], selfClosing: false },
      { kind: "text", text: "if a" },
      {
        kind: "start",
        name: "b",
        attrs: [
          { name: "then<", value: "", quoted: false },
          { name: "p", value: "", quoted: false },
        ],
        selfClosing: false,
      },
    ]);
  });

  test("duplicated attributes are all kept", () => {
    expect(shapes("<a x=1 x=2>")).toEqual([
      {
        kind: "start",
        name: "a",
        attrs: [
          { name: "x", value: "1", quoted: false },
          { name: "x", value: "2", quoted: false },
        ],
        selfClosing: false,
      },
    ]);
  });

  test("an end tag's attributes are read (a quoted `>` does not end it) and dropped", () => {
    expect(shapes(`</a title=">"><b>`)).toEqual([
      { kind: "end", name: "a" },
      { kind: "start", name: "b", attrs: [], selfClosing: false },
    ]);
  });

  test("the source case of names is kept", () => {
    expect(shapes("<LiNk HREF=//h>")).toEqual([
      {
        kind: "start",
        name: "LiNk",
        attrs: [{ name: "HREF", value: "//h", quoted: false }],
        selfClosing: false,
      },
    ]);
  });

  test("offsets: every token's slice reproduces its source, and the tokens tile the input", () => {
    const srcs = [
      `<p class="a">x</p>`,
      "a <1 <!-- c --> <![CDATA[d]]> <?x?> </1> <img/src=x/> tail",
      `<a b='"'><base href=//h>`,
      "<!-->x<!--->y",
    ];
    for (const src of srcs) {
      let at = 0;
      for (const t of tokens(src)) {
        expect(t.start).toBe(at);
        const slice = src.slice(t.start, t.end);
        if (t.kind === "text") expect(slice).toBe(t.text);
        if (t.kind === "comment") expect(slice.includes(t.text)).toBe(true);
        if (t.kind === "cdata") expect(slice).toBe(`<![CDATA[${t.text}]]>`);
        if (t.kind === "declaration") expect(slice).toBe(`<${t.text}>`);
        if (t.kind === "start" || t.kind === "end") expect(slice.startsWith("<")).toBe(true);
        at = t.end;
      }
      expect(at).toBe(src.length);
    }
  });

  test("the empty input has no tokens", () => {
    expect(tokens("")).toEqual([]);
  });
});

describe("tokenizeMarkup: does not tokenize (undefined, refused)", () => {
  test.each([
    ["end inside a tag name", "<a"],
    ["end inside attributes", "<a b"],
    ["end after `=`", "<a b="],
    ["end inside a quoted value", `<a b="x`],
    ["end inside an unquoted value", "<a b=x"],
    ["end after `/` in a tag", "<a /"],
    ["end inside an end tag", "</a"],
    ["end inside a comment", "<!-- x"],
    ["end inside CDATA", "<![CDATA[x"],
    ["end inside a processing instruction", "<?x"],
    ["end inside a declaration", "<!DOCTYPE"],
    ["end inside `</` + non-letter", "</1"],
  ])("%s", (_label, src) => {
    expect(tokenizeMarkup(src)).toBeUndefined();
  });

  test(`more than MARKUP_MAX_TOKENS (${MARKUP_MAX_TOKENS}) tokens`, () => {
    // `<b>x` is two tokens: 100,000 of them is exactly the cap, one more is over it.
    expect(tokenizeMarkup("<b>x".repeat(100_000))?.length).toBe(MARKUP_MAX_TOKENS);
    expect(tokenizeMarkup("<b>x".repeat(100_001))).toBeUndefined();
    // Over the cap through tags alone, too (the in-loop check).
    expect(tokenizeMarkup("<b>".repeat(MARKUP_MAX_TOKENS + 1))).toBeUndefined();
    // Over the cap only by the trailing text token (the final check).
    expect(tokenizeMarkup(`${"<b>".repeat(MARKUP_MAX_TOKENS)}x`)).toBeUndefined();
  });

  test(`an input longer than REMOTE_SCAN_MAX_CHARS (${REMOTE_SCAN_MAX_CHARS})`, () => {
    expect(tokenizeMarkup("a".repeat(REMOTE_SCAN_MAX_CHARS))).toHaveLength(1);
    expect(tokenizeMarkup("a".repeat(REMOTE_SCAN_MAX_CHARS + 1))).toBeUndefined();
  });
});
