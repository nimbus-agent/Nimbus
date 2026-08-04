import { expect, test } from "bun:test";

import { plainTextFromHtmlLines } from "./html-plain-text-lines.ts";

test("a <p>-separated body keeps each paragraph on its own line", () => {
  expect(plainTextFromHtmlLines("<p>Line one.</p><p>Line two.</p>")).toBe("Line one.\nLine two.");
});

test("<br>, <br/>, and <br /> variants each become a newline", () => {
  expect(plainTextFromHtmlLines("A<br>B<br/>C<br />D")).toBe("A\nB\nC\nD");
});

test("nested block tags collapse to a single boundary, not stacked blank lines", () => {
  expect(plainTextFromHtmlLines("<div><p>Hello</p></div>")).toBe("Hello");
  expect(plainTextFromHtmlLines("<blockquote><p>Quoted line</p></blockquote>")).toBe("Quoted line");
});

test("adjacent block tags produce no blank-line explosion", () => {
  expect(plainTextFromHtmlLines("<p>A</p><p>B</p><p>C</p>")).toBe("A\nB\nC");
});

test("an inline-tag-only body stays a single line", () => {
  expect(plainTextFromHtmlLines("<b>Hello</b> <i>world</i>")).toBe("Hello world");
});

test("empty input returns empty string", () => {
  expect(plainTextFromHtmlLines("")).toBe("");
});

test("opening <li> tags separate list items even when left unclosed", () => {
  expect(plainTextFromHtmlLines("<ul><li>One<li>Two<li>Three</ul>")).toBe("One\nTwo\nThree");
});

test("a body consisting solely of an empty block tag collapses to empty string", () => {
  expect(plainTextFromHtmlLines("<p></p>")).toBe("");
});

test("collapses horizontal whitespace within a line but preserves the line break between blocks", () => {
  expect(plainTextFromHtmlLines("<p>a   b\t\tc</p><p>d</p>")).toBe("a b c\nd");
});

test("a raw newline inside a single block does not fragment the line", () => {
  // Pretty-printed source HTML routinely soft-wraps inside one logical
  // paragraph — that must collapse like ordinary whitespace, not be mistaken
  // for an intentional block boundary.
  expect(plainTextFromHtmlLines("<p>Hello\n   world</p>")).toBe("Hello world");
});

test("a double <br><br> paragraph gap (a common email idiom) keeps one blank line", () => {
  expect(plainTextFromHtmlLines("Line1<br><br>Line2")).toBe("Line1\n\nLine2");
});

test("a well-formed <li>...</li><li>...</li> pair does not insert a spurious blank line", () => {
  expect(plainTextFromHtmlLines("<ul><li>One</li><li>Two</li></ul>")).toBe("One\nTwo");
});

test("heading and table-row closing tags are recognised block boundaries", () => {
  expect(plainTextFromHtmlLines("<h1>Title</h1><tr>Row</tr>")).toBe("Title\nRow");
});

test("a quoted-tail-shaped body keeps its attribution line separate for downstream stripping", () => {
  expect(plainTextFromHtmlLines("<p>Ship it.</p><p>On Mon, Ana wrote:</p>")).toBe(
    "Ship it.\nOn Mon, Ana wrote:",
  );
});
