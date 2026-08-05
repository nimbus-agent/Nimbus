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

test("a pathological run of unterminated <li tags does not cause catastrophic backtracking", () => {
  // Adversarial shape: many "<li " starts with no closing ">" anywhere, so a
  // match at each start position fails only after the engine gives up.
  // Unbounded (`[^>]*`), this scales quadratically with input length
  // (measured against this exact file's prior regex: 20 KB -> 28.1 ms,
  // 40 KB -> 114.9 ms, 80 KB -> 456.5 ms, 160 KB -> 1833.4 ms — a clean 4x
  // per doubling); at this input size (~200 KB) the unbounded regex would
  // take several seconds. `[^<>]*` clears this in well under a millisecond
  // regardless of input length (it can only ever scan as far as the next `<`
  // or `>`), so a 1000 ms ceiling leaves multiple orders of magnitude of
  // headroom against CI jitter while still reliably catching a regression
  // back to the unbounded form.
  // No ">" anywhere means no tag pattern ever matches, so the frozen
  // `stripHtmlTagsToSpaces` (entered at the very first "<") never sees a
  // closing ">" to exit tag mode either — by that function's own documented
  // behavior ("treats unclosed < as hiding the remainder"), it swallows the
  // rest of the string, including the trailing "x". The result is legitimately
  // "" for this input; what this test actually guards is elapsed time.
  const pathological = `${"<li ".repeat(50_000)}x`;
  const startedAt = performance.now();
  const result = plainTextFromHtmlLines(pathological);
  const elapsedMs = performance.now() - startedAt;
  expect(result).toBe("");
  expect(elapsedMs).toBeLessThan(1000);
});

// ── hidden sections: <style> / <script> / <head> ──────────────────────────────

test("a <head><style> block's CSS is not indexed as body text", () => {
  expect(
    plainTextFromHtmlLines(
      '<html><head><style type="text/css">p.MsoNormal{mso-style-parent:"";font-size:11.0pt}</style></head>' +
        "<body><p>Hello.</p></body></html>",
    ),
  ).toBe("Hello.");
});

test("a <script> block's source is not indexed as body text", () => {
  expect(plainTextFromHtmlLines("<p>A</p><script>var x = 1 < 2;</script><p>B</p>")).toBe("A\nB");
});

test("a bare <style> outside <head> is dropped too", () => {
  expect(plainTextFromHtmlLines("<style>a{color:red}</style><p>Z</p>")).toBe("Z");
});

test("hidden-section matching is case-insensitive and tolerates a spaced closer", () => {
  expect(plainTextFromHtmlLines('<STYLE TYPE="text/css">a{}</STYLE ><p>Z</p>')).toBe("Z");
});

test("<header> is not mistaken for <head>", () => {
  // `\b` after the name: `<head` must not match the `head` prefix of
  // `<header>`, or an entire page's visible content would vanish.
  expect(plainTextFromHtmlLines("<header>Masthead</header><p>Body.</p>")).toBe("Masthead Body.");
});

test("an UNTERMINATED hidden section is left in place rather than truncating the body", () => {
  // Fail-open: treating "no closer" as "hidden to end of document" would
  // delete author prose on malformed markup, which is strictly worse than
  // indexing some CSS. The second unterminated opener also exercises the
  // exhausted-name short-circuit that keeps the scan linear.
  expect(plainTextFromHtmlLines("<p>Kept.</p><style>leak<style>more")).toBe("Kept.\nleak more");
});

test("a hostile run of unterminated hidden-section openers does not blow up", () => {
  // The obvious one-regex form
  // `/<(style|script|head)\b[^<>]*>[\s\S]*?<\/\1\s*>/gi` is QUADRATIC on this
  // exact shape: each opener's lazy `[\s\S]*?` scans to end-of-string before
  // failing, and the global replace retries at the next opener (measured
  // 100 KB -> 285 ms, 200 KB -> 1150 ms, 400 KB -> 4608 ms, 800 KB ->
  // 17977 ms — a clean 4x per doubling). The forward-only scan with the
  // exhausted-name memo clears the same 800 KB input in ~13 ms, so a 1000 ms
  // ceiling leaves three orders of magnitude of headroom against CI jitter
  // while still catching a regression back to the quadratic form.
  const pathological = "<script a>zzzzzzzzzz".repeat(40_000);
  const startedAt = performance.now();
  const result = plainTextFromHtmlLines(pathological);
  const elapsedMs = performance.now() - startedAt;
  // Openers are stripped as ordinary tags; their "content" survives, which is
  // the fail-open behaviour above. What this test guards is elapsed time.
  expect(result.startsWith("zzzzzzzzzz")).toBe(true);
  expect(elapsedMs).toBeLessThan(1000);
});

// ── stray `<` in author prose ────────────────────────────────────────────────

test("an unescaped < in prose does not swallow the following text or block boundary", () => {
  // `stripHtmlTagsToSpaces` enters tag mode at every `<` and stays there to
  // the next `>`, so `"if a < b</p>"` used to lose BOTH `" b"` and the `</p>`
  // boundary — gluing the attribution onto the prose so `stripQuotedTail`
  // could never see it. "if a < b" is ordinary technical mail.
  expect(plainTextFromHtmlLines("<p>if a < b</p><p>On Mon, Ana wrote:</p><p>&gt; old</p>")).toBe(
    "if a < b\nOn Mon, Ana wrote:\n> old",
  );
});

test("a < followed by a tag-name character is still treated as a tag start", () => {
  expect(plainTextFromHtmlLines("<p>x</p><!-- comment --><p>y</p>")).toBe("x\ny");
});

// ── character references ─────────────────────────────────────────────────────

test("the XML predefined entities and &nbsp; are decoded", () => {
  expect(
    plainTextFromHtmlLines("<p>a &amp; b &nbsp;&nbsp; c &lt;tag&gt; &quot;q&quot; &apos;</p>"),
  ).toBe(`a & b c <tag> "q" '`);
});

test("decoding happens AFTER tag stripping, so an authored &lt;p&gt; stays text", () => {
  expect(plainTextFromHtmlLines("<p>use &lt;p&gt; for a paragraph</p>")).toBe(
    "use <p> for a paragraph",
  );
});

test("decimal and hexadecimal numeric references are decoded", () => {
  expect(plainTextFromHtmlLines("<p>&#8217;&#x2019;&#X2014;</p>")).toBe("’’—");
});

test("an out-of-range, NUL or lone-surrogate numeric reference is left literal", () => {
  expect(plainTextFromHtmlLines("<p>&#0;|&#xD800;|&#x110000;</p>")).toBe(
    "&#0;|&#xD800;|&#x110000;",
  );
});

test("an unknown named entity is left literal rather than guessed", () => {
  expect(plainTextFromHtmlLines("<p>&copy; 2026</p>")).toBe("&copy; 2026");
});

test("a decoded &#10; collapses as whitespace instead of fabricating a line", () => {
  expect(plainTextFromHtmlLines("<p>one&#10;two</p><p>three</p>")).toBe("one two\nthree");
});
