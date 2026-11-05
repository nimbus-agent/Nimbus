import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  regexLiteralEnd,
  startsRegexLiteral,
  stripComments,
  stripStringLiterals,
} from "../../../../../scripts/structure-audit/lib.ts";
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

// ---------------------------------------------------------------------------------------------
// Source pin (plan Global Constraints; CodeQL js/incomplete-multi-character-sanitization and
// js/bad-tag-filter): the B3r detector files never strip or replace, and no regex in them matches
// a tag. Their comment-stripped source has no `.replace(` / `.replaceAll(` call, no runtime
// `RegExp(` construction (which could hide a `<` in a string), and no regex literal containing `<`.
// ---------------------------------------------------------------------------------------------

const PINNED_FILES: string[] = ["markup-tokens.ts", "remote-content.ts"];

/**
 * `text-normalise.ts` (the shared normalisation the detectors read) is pinned too (final review
 * item 5), with an explicit allowlist: these two lines build MATCHING COPIES (the entity decode
 * and the whitespace collapse), never text that is sent, shown or written back. No other replace
 * call may appear there.
 */
const TEXT_NORMALISE_MATCHING_COPIES: readonly string[] = [
  "return s.replace(ENTITY, (m: string, hex?: string, dec?: string, name?: string) => {",
  String.raw`return (keepLines ? cur : cur.replaceAll(/\s+/g, " ")).toLowerCase();`,
];

/** The trimmed lines of comment-free `src` that call `.replace(` or `.replaceAll(` (strings skipped). */
function replaceCallLines(src: string): string[] {
  const code = stripComments(src);
  const blanked = stripStringLiterals(code).split("\n");
  const lines = code.split("\n");
  const out: string[] = [];
  blanked.forEach((b, i) => {
    if (/\.replace(?:All)?\s*\(/.test(b)) out.push((lines[i] ?? "").trim());
  });
  return out;
}

/**
 * Every regex literal of comment-free `code`. A `/` that `stripStringLiterals` blanked is inside a
 * string and skipped; the literal itself is read from `code` (that helper blanks regex bodies).
 */
function regexLiterals(code: string): string[] {
  const blanked = stripStringLiterals(code);
  const out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    if (blanked[i] !== "/" || !startsRegexLiteral(code, i)) continue;
    const end = regexLiteralEnd(code, i);
    if (end === null) continue;
    out.push(code.slice(i, end));
    i = end - 1;
  }
  return out;
}

/** The pin's violations in one source text. */
function pinViolations(src: string): string[] {
  const code = stripComments(src);
  const calls = stripStringLiterals(code);
  const out: string[] = [];
  if (/\.replace(?:All)?\s*\(/.test(calls)) out.push("replace call");
  if (/\bRegExp\s*\(/.test(calls)) out.push("RegExp construction");
  for (const re of regexLiterals(code)) if (regexCanMatchLt(re)) out.push(`regex ${re}`);
  return out;
}

/** Whether `atom`, compiled alone with `flags`, matches `<` (a throw counts as yes: fail closed). */
function atomMatchesLt(atom: string, flags: string): boolean {
  try {
    return new RegExp(
      `^(?:${atom})$`,
      flags
        .split("")
        .filter((f) => f !== "g" && f !== "y")
        .join(""),
    ).test("<");
  } catch {
    return true;
  }
}

/** The escape atom starting at the `\` at `i` of a regex body (`\x3c`, `<`, `\u{3c}`, `\074`). */
function escapeAtom(body: string, i: number): string {
  const next = body.charAt(i + 1);
  const braced = body.charAt(i + 2) === "{";
  if ((next === "u" || next === "p" || next === "P") && braced) {
    const close = body.indexOf("}", i + 3);
    return body.slice(i, close === -1 ? body.length : close + 1);
  }
  if (next === "x") return body.slice(i, i + 4);
  if (next === "u") return body.slice(i, i + 6);
  if (next === "c") return body.slice(i, i + 3);
  if (/[0-9]/.test(next)) {
    let j = i + 1;
    while (/[0-9]/.test(body.charAt(j))) j++;
    return body.slice(i, j);
  }
  return body.slice(i, i + 2);
}

/** The character class starting at the `[` at `i` of a regex body, brackets included. */
function classAtom(body: string, i: number): string {
  let j = i + 1;
  if (body.charAt(j) === "^") j++;
  if (body.charAt(j) === "]") j++;
  while (j < body.length && body.charAt(j) !== "]") j += body.charAt(j) === "\\" ? 2 : 1;
  return body.slice(i, j + 1);
}

/**
 * Whether a regex literal can match `<` anywhere (the source pin, closed after the adversarial
 * review found `\x3c` slipped past a literal-`<` check): a literal `<` (which also catches the
 * `(?<` lookbehind and named-group syntax), an escape that names it (`\x3c`, `<`, `\u{3c}`,
 * octal `\074`), a named backreference `\k<...>`, a `.` or `\W`/`\S`/`\D`, or a character class
 * that contains it (a range across U+003C, or a negated class). Each escape and class is compiled
 * on its own and tested against `<`.
 */
function regexCanMatchLt(literal: string): boolean {
  const close = literal.lastIndexOf("/");
  const body = literal.slice(1, close);
  const flags = literal.slice(close + 1);
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    let atom = ch;
    if (ch === "\\") {
      if (body.charAt(i + 1) === "k") return true;
      atom = escapeAtom(body, i);
    } else if (ch === "[") {
      atom = classAtom(body, i);
    } else if (ch === "<") {
      return true;
    } else if (ch !== ".") {
      i++;
      continue;
    }
    if (atomMatchesLt(atom, flags)) return true;
    i += atom.length;
  }
  return false;
}

describe("source pin: the remote-content files never strip, replace or match a tag", () => {
  test.each(PINNED_FILES)("%s", (file) => {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    expect(pinViolations(src)).toEqual([]);
  });

  test("text-normalise.ts: no RegExp construction or `<`-matching regex, and its ONLY replace calls are the two matching-copy lines", () => {
    const src = readFileSync(join(import.meta.dir, "text-normalise.ts"), "utf8");
    expect(pinViolations(src).filter((v) => v !== "replace call")).toEqual([]);
    expect(replaceCallLines(src)).toEqual([...TEXT_NORMALISE_MATCHING_COPIES]);
  });

  test("guard: the replace-call lister sees every call, one line each", () => {
    expect(
      replaceCallLines(
        `const a = s.replace(x, y);\n// t.replace(z)\nconst b = "u.replace(";\nconst c = v.replaceAll (w, q);`,
      ),
    ).toEqual(["const a = s.replace(x, y);", "const c = v.replaceAll (w, q);"]);
  });

  test("the pin's matcher fails mutated snippets and passes clean ones", () => {
    expect(pinViolations(`const a = s.replace(/x/g, "");`)).toEqual(["replace call"]);
    expect(pinViolations("const a = s.replaceAll ( 'x', '' );")).toEqual(["replace call"]);
    expect(pinViolations(`const r = new RegExp("<img");`)).toEqual(["RegExp construction"]);
    expect(pinViolations("const r = /<img/i;")).toEqual(["regex /<img/i"]);
    expect(pinViolations("if (x) return /a[<]b/.test(s);")).toEqual(["regex /a[<]b/"]);
    // Every other way a regex literal can match `<` (adversarial review).
    for (const re of [
      String.raw`/\x3c/`,
      String.raw`/\x3Cimg/i`,
      "/</",
      String.raw`/\u{3c}/u`,
      String.raw`/\u{0003C}/u`,
      String.raw`/\074/`,
      String.raw`/\74img/`,
      "/[;-=]/",
      String.raw`/[\x3b-\x3d]/`,
      "/[^a]/",
      "/a.b/",
      String.raw`/\W/`,
      String.raw`/\S/`,
      String.raw`/\D/`,
      String.raw`/\P{L}/u`,
      "/(?<=a)b/",
      String.raw`/(?<n>a)\k<n>/`,
    ]) {
      expect(pinViolations(`const r = ${re};`)).toEqual([`regex ${re}`]);
    }
    for (const re of [
      String.raw`/url\(/`,
      "/[a-z0-9+.-]/",
      String.raw`/\s*=\s*(?:["'\x60]\s*)?/`,
      String.raw`/[\\/][\\/]/`,
      "/^[0-9a-f]$/i",
      String.raw`/\p{L}/u`,
      String.raw`/\x3d/`,
    ]) {
      expect(pinViolations(`const r = ${re};`)).toEqual([]);
    }
    // Clean: a `<` comparison, a `<` in a string, and a mention in a comment.
    expect(
      pinViolations(`// s.replace(/<a/)\nconst a = b < c; const t = "<p>"; const r = /url\\(/;`),
    ).toEqual([]);
  });
});
