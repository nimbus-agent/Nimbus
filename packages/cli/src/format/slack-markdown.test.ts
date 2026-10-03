import { describe, expect, test } from "bun:test";
import {
  formatBriefText,
  isBriefTextFormat,
  toPlainText,
  toSlackMrkdwn,
} from "./slack-markdown.ts";

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
  // Regression: bold used to be parked between two Private Use Area sentinels (U+E000/U+E001)
  // until the italic pass had run, then `replaceAll`-ed back to `*`. The premise ("cannot occur
  // in Markdown source") did not hold — the input is a brief assembled from connector-supplied
  // titles, not hand-written Markdown — so a PR title carrying a literal U+E000 had it rewritten
  // into a live Slack emphasis delimiter.
  test("a literal private-use sentinel character in the input is left untouched", () => {
    expect(toSlackMrkdwn("a  b  c")).toBe("a  b  c");
    expect(toSlackMrkdwn("[WIP fix](https://x/1)")).toBe("<https://x/1|WIP fix>");
  });
  test("bold and italic on one line still convert independently", () => {
    expect(toSlackMrkdwn("**b** and *i*")).toBe("*b* and _i_");
  });
  test("bold nested inside an italic run survives both passes", () => {
    expect(toSlackMrkdwn("*a **b** c*")).toBe("_a *b* c_");
  });
  // Regression: `split("|")` split `\|` as well, so a cell holding an escaped pipe produced an
  // extra column. Reachable through SYNTHESIS — a model rewriting a brief into a GFM table
  // escapes an in-cell pipe exactly this way.
  test("an escaped pipe stays inside its cell rather than opening a new one", () => {
    expect(toSlackMrkdwn("| A \\| B | merged |")).toBe("• A | B | merged");
  });
  test("an escaped backslash before a real pipe still separates two cells", () => {
    // The `(?<!\\)\|` one-liner gets this wrong: the lookbehind sees the second backslash of an
    // escaped BACKSLASH and calls the following pipe escaped, merging two real cells into one.
    expect(toSlackMrkdwn("| a \\\\| b |")).toBe("• a \\ | b");
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
  test("an escaped pipe stays inside its cell in plain text too", () => {
    expect(toPlainText("| A \\| B | merged |")).toBe("A | B | merged");
  });
  test("a literal private-use sentinel character survives the plain-text pass", () => {
    expect(toPlainText("a  b")).toBe("a  b");
  });
  // The title scan consumes a `\x` pair as one unit, so a long unterminated title is one linear
  // pass. Written time-bounded because a future edit to that scan would regress it silently.
  test("an unterminated escaped title does not backtrack catastrophically", () => {
    const pathological = `[${"a\\]".repeat(20_000)}`;
    const started = performance.now();
    expect(toPlainText(pathological)).toContain("a]");
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// The link matcher used to be one regex, `/\[((?:\\[\s\S]|[^\\\]])*)\]\(([^)]+)\)/g`. It is now a
// scan that skips every start position a failed attempt proves cannot match, which is what keeps
// a line linear. These pin what that regex did on the shapes where the skip could plausibly go
// wrong, so the two stay byte-identical, and then the time bound on the inputs the regex took
// seconds on (each `[` after a failed attempt re-scanned the rest of the line).
describe("link matching keeps the leftmost-match semantics of the old regex", () => {
  test("an unescaped `[` inside a title stays part of that title", () => {
    expect(toSlackMrkdwn("[x [y](https://x/1)")).toBe("<https://x/1|x [y>");
  });
  test("the title ends at the FIRST unescaped `]`, so an outer bracket is left as text", () => {
    expect(toSlackMrkdwn("[[a](https://x/1)](https://x/2)")).toBe("<https://x/1|[a>](https://x/2)");
  });
  test("a failed candidate does not hide a later link on the same line", () => {
    expect(toPlainText("[a] then [b](https://x/1)")).toBe("[a] then b");
    expect(toPlainText("[a]() then [b](https://x/1)")).toBe("[a]() then b");
  });
  test("an empty URL is not a link, and neither is one that never closes", () => {
    expect(toPlainText("[a]()")).toBe("[a]()");
    expect(toPlainText("[a](https://x/1")).toBe("[a](https://x/1");
  });
  test("the URL runs to the FIRST `)`", () => {
    expect(toSlackMrkdwn("[t](a(b)c)")).toBe("<a(b|t>c)");
  });
  test("an empty title is still a link", () => {
    expect(toSlackMrkdwn("[](https://x/1)")).toBe("<https://x/1|>");
  });
  test("an escaped backslash before `]` does not escape the bracket", () => {
    expect(toSlackMrkdwn("[a\\\\](https://x/1)")).toBe("<https://x/1|a\\>");
  });

  // 40,000 repetitions, not fewer: the quadratic regex finished `[](` x 20,000 in ~0.7 s on a fast
  // machine, inside the bound, so a smaller input does not reliably fail against a regression.
  for (const [shape, line] of [
    ["`[](` repeated with no `)` anywhere", "[](".repeat(40_000)],
    ["`[` repeated with no `]`", "[".repeat(40_000)],
    ["`[` repeated, closed once but never followed by `(`", `${"[".repeat(40_000)}]`],
  ] as const) {
    test(`stays linear on ${shape}`, () => {
      const started = performance.now();
      expect(toPlainText(line)).toBe(line);
      expect(toSlackMrkdwn(line)).toBe(line);
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  }
});

describe("headings", () => {
  test("a heading with no text after its separator renders as an empty one", () => {
    expect(toSlackMrkdwn("## ")).toBe("**");
    expect(toPlainText("##\t ")).toBe("");
  });
  test("only the space/tab run is stripped; any other leading character is kept", () => {
    expect(toPlainText("# \u00a0Deployments")).toBe("\u00a0Deployments");
  });
  test("seven hashes, no separator, or a `\\r` before the end is not a heading", () => {
    expect(toSlackMrkdwn("####### Deployments")).toBe("####### Deployments");
    expect(toSlackMrkdwn("#Deployments")).toBe("#Deployments");
    expect(toSlackMrkdwn("## Deployments\r")).toBe("## Deployments\r");
  });
  // `[ \t]+(.*)$` let the separator run and the text trade characters, so a line `$` rejects
  // re-scanned the rest of the line once per separator character: seconds at this length.
  test("a long separator run on a line that cannot match stays linear", () => {
    const line = `#${" \t".repeat(40_000)}\r`;
    const started = performance.now();
    expect(toPlainText(line)).toBe(line);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("formatBriefText", () => {
  const brief = "## Deployments\n[Fix auth](https://x/1) **shipped**";

  test("markdown passes the brief through verbatim", () => {
    expect(formatBriefText(brief, "markdown")).toBe(brief);
  });
  test("slack and plain each apply their own transform", () => {
    expect(formatBriefText(brief, "slack")).toBe("*Deployments*\n<https://x/1|Fix auth> *shipped*");
    expect(formatBriefText(brief, "plain")).toBe("Deployments\nFix auth shipped");
  });
  test("isBriefTextFormat accepts exactly the three formats, case-sensitively", () => {
    for (const f of ["markdown", "slack", "plain"]) expect(isBriefTextFormat(f)).toBe(true);
    for (const f of ["html", "", "Slack", "plain "]) expect(isBriefTextFormat(f)).toBe(false);
  });
});
