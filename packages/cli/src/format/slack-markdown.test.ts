import { describe, expect, test } from "bun:test";
import { toPlainText, toSlackMrkdwn } from "./slack-markdown.ts";

describe("toSlackMrkdwn", () => {
  test("links become <url|title>", () => {
    expect(toSlackMrkdwn("[Fix auth](https://x/1)")).toBe("<https://x/1|Fix auth>");
  });
  test("bold becomes single-asterisk", () => {
    expect(toSlackMrkdwn("**shipped**")).toBe("*shipped*");
  });
  test("headings become bold lines", () => {
    expect(toSlackMrkdwn("## Deployments")).toBe("*Deployments*");
  });
  test("strikethrough collapses to one tilde", () => {
    expect(toSlackMrkdwn("~~old~~")).toBe("~old~");
  });
  test("a table becomes bullet lines, since Slack renders no tables", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(toSlackMrkdwn(md)).toBe("• a | b\n• 1 | 2");
  });
  test("bold nested inside a link title converts to Slack bold correctly", () => {
    expect(toSlackMrkdwn("[**hot**fix](https://x/2)")).toBe("<https://x/2|*hot*fix>");
  });
  // Regression for a corruption found in review: a link converts to `<url|title>`, which
  // injects a `|` — splitting table cells AFTER that conversion (the previous shape of this
  // code) misread the injected pipe as a cell boundary and broke the link. Changelogs of
  // merged PRs/deployments/incidents are inherently link-heavy table content, so this is not
  // an edge case for this tool.
  test("a link inside a table cell is not split on its injected pipe", () => {
    const md = "| [PR](https://x/9) | merged |";
    expect(toSlackMrkdwn(md)).toBe("• <https://x/9|PR> | merged");
  });
  // Regression: the gateway renderer hardens every entry title with `escapeMarkdownLinkText`,
  // so a `[WIP]`/`[RFC]`/`[PROJ-123]` prefix reaches this module as `\[WIP\]`. A title class of
  // `[^\]]*` stops at the `]` character regardless of the backslash before it, so the whole
  // link failed to match and shipped RAW into Slack. Silent, and routine on real PR titles.
  test("an escaped bracket in the title does not stop the link matcher", () => {
    expect(toSlackMrkdwn("[Fix \\[auth\\] bug](https://x/1)")).toBe("<https://x/1|Fix [auth] bug>");
  });
  test("a literal backslash in the title survives exactly one unescape", () => {
    // The renderer escapes the backslash too, so a title whose real text is `\[a\]` arrives as
    // `\\\[a\\\]`. Unescaping it twice would yield `[a]` and silently lose both backslashes.
    expect(toSlackMrkdwn("[\\\\\\[a\\\\\\]](https://x/1)")).toBe("<https://x/1|\\[a\\]>");
  });
});

describe("toPlainText", () => {
  test("a link keeps its title and drops the URL", () => {
    expect(toPlainText("[Fix auth](https://x/1)")).toBe("Fix auth");
  });
  test("emphasis markers are stripped, not converted", () => {
    expect(toPlainText("**shipped** and _done_ and ~~old~~")).toBe("shipped and done and old");
  });
  test("heading markers are stripped but the text stays on its own line", () => {
    expect(toPlainText("## Deployments")).toBe("Deployments");
  });
  test("a table becomes one plain line per row, delimiter row dropped", () => {
    expect(toPlainText("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe("a | b\n1 | 2");
  });
  test("list bullets survive as hyphens", () => {
    expect(toPlainText("- one\n- two")).toBe("- one\n- two");
  });
  // Regression for a corruption found in review: the underscore-italic rule had no
  // word-boundary check, so a bare `/_(.+?)_/` treated every underscore pair inside an
  // identifier as an italic run and dropped one. PR titles/commit messages in this codebase
  // are dense with SCREAMING_SNAKE_CASE, so this is not theoretical for a changelog tool.
  test("a SCREAMING_SNAKE_CASE identifier with multiple underscores is left alone", () => {
    expect(toPlainText("Fix MAX_SINCE_MS bound")).toBe("Fix MAX_SINCE_MS bound");
  });
  test("a link inside a table cell keeps its title and drops the URL", () => {
    const md = "| [PR](https://x/9) | merged |";
    expect(toPlainText(md)).toBe("PR | merged");
  });
  // The same regression as the Slack side, in the mode whose doc comment makes the stronger
  // promise: an unmatched link leaves the URL in the output, which is exactly what
  // "a plain-text changelog pasted into an email should not carry bare URLs" rules out.
  test("an escaped bracket in the title does not leave a bare URL behind", () => {
    const out = toPlainText("[Fix \\[auth\\] bug](https://x/1)");
    expect(out).toBe("Fix [auth] bug");
    expect(out).not.toContain("https://x/1");
  });
  // Independent of the link matcher: the renderer escapes an entry title whether or not a link
  // wraps it, so an item with no renderable permalink reached the reader as `\[WIP\] Fix auth`.
  test("a bare escaped title with no link is unescaped too", () => {
    expect(toPlainText("- \\[WIP\\] Fix auth — 2027-01-14")).toBe("- [WIP] Fix auth — 2027-01-14");
  });
  // The alternation inside `LINK_RE`'s title class is unambiguous (one branch starts at a
  // backslash, the other cannot), so a long unterminated title is linear, not exponential.
  // Written time-bounded because a future edit to that class would regress it silently.
  test("an unterminated escaped title does not backtrack catastrophically", () => {
    const pathological = `[${"a\\]".repeat(20_000)}`;
    const started = performance.now();
    expect(toPlainText(pathological)).toContain("a]");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
