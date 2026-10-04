import { describe, expect, test } from "bun:test";
import {
  formatBriefText,
  isBriefTextFormat,
  stripUnderscoreItalic,
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

// Plain mode's underscore-italic pass used to be this regex. It is now a scan that skips every
// opening `_` a failed attempt proves cannot match (`stripUnderscoreItalic`), which is what keeps a
// line linear. Unlike the link regex above, this one stays live as the ORACLE: the scan must return
// what it returned for every input, so these tests compare the two rather than pin outputs by
// hand — exhaustively over short strings, then for every UTF-16 code unit at each place the pattern
// reads one, then over seeded pseudo-random strings, then on the edge cases where a skip could
// plausibly go wrong — and then hold the time bound on the inputs the regex was quadratic on.
const OLD_UNDERSCORE_ITALIC_RE = /(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g;

function viaOldRegex(text: string): string {
  return text.replace(OLD_UNDERSCORE_ITALIC_RE, (_m, i: string) => i);
}

/** Every string of `units` of length 0 to `maxLength`, shortest first. */
function* arrangements(units: readonly string[], maxLength: number): Generator<string> {
  for (let length = 0; length <= maxLength; length++) {
    const count = units.length ** length;
    for (let n = 0; n < count; n++) {
      let text = "";
      let rest = n;
      for (let k = 0; k < length; k++) {
        text += units[rest % units.length];
        rest = Math.floor(rest / units.length);
      }
      yield text;
    }
  }
}

/** Mulberry32: a seeded 32-bit generator, so every run draws the same corpus. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("underscore italic keeps the semantics of the old regex", () => {
  // The pattern tells code units apart by five classes only: `_`, any other word character, a
  // space `.` accepts, a line terminator (a space `.` refuses), and anything else. As long as the
  // scan sorts every code unit into the class the regex does, which the next test checks for all
  // 65,536 of them, a string's outcome depends only on its sequence of classes, and this checks
  // every sequence of up to eight: 488,281 strings.
  test("agrees with the old regex on every arrangement of its five classes up to length 8", () => {
    const mismatches: string[] = [];
    let checked = 0;
    let rewritten = 0;
    for (const text of arrangements(["_", "a", " ", "\n", "*"], 8)) {
      const want = viaOldRegex(text);
      if (want !== text) rewritten++;
      if (stripUnderscoreItalic(text) !== want) mismatches.push(JSON.stringify(text));
      checked++;
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBe(488_281);
    // Not vacuous: the oracle rewrites about one string in eight.
    expect(rewritten).toBeGreaterThan(50_000);
  });

  // What makes the five classes above stand for every code unit: the scan must sort each one into
  // the class the regex does, at each of the five places the pattern reads one — before the opener
  // (`(?<!\w)`), right after it (`(?!\s)` and the first unit of `.`), inside the content (`.`),
  // before the closer (`(?<!\s)`) and after it (`(?!\w)`). This puts every UTF-16 code unit at each
  // of them. A whitespace set written out by hand instead of `\s`, whether it leaves out U+1680,
  // U+2000 to U+200A, U+202F or U+205F or adds U+0085 as Python's does, or a `.` that refuses
  // U+0085 as Java's does, passes every other test in this file and fails only this one.
  test("agrees with the old regex on every code unit at each place the pattern reads one", () => {
    const places = [
      ["before the opener", (c: string) => `${c}_a_`],
      ["after the opener", (c: string) => `_${c}a_`],
      ["inside the content", (c: string) => `_a${c}b_`],
      ["before the closer", (c: string) => `_a${c}_`],
      ["after the closer", (c: string) => `_a_${c}`],
    ] as const;
    const mismatches: string[] = [];
    const insensitive: string[] = [];
    let checked = 0;
    for (const [place, build] of places) {
      let kept = 0;
      for (let unit = 0; unit <= 0xffff; unit++) {
        const text = build(String.fromCharCode(unit));
        const want = viaOldRegex(text);
        if (want === text) kept++;
        if (stripUnderscoreItalic(text) !== want) {
          mismatches.push(`U+${unit.toString(16).toUpperCase().padStart(4, "0")} ${place}`);
        }
        checked++;
      }
      // Not vacuous: at every place, some code units stop the run and the others let it through.
      if (kept === 0 || kept === 65_536) insensitive.push(place);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBe(327_680);
    expect(insensitive).toEqual([]);
  });

  // The real members of each class, which the five representatives above stand in for: the
  // markers every other pass reacts to, spaces `.` accepts (U+00A0, U+3000, the BOM and more),
  // U+180E (a space in Unicode before 6.3, not after), a letter `\w` does not cover (`é`), a
  // non-BMP character (two code units) and a lone surrogate. `_` is weighted up because it is the
  // only character the pass acts on.
  const ALPHABET = Array.from(
    "____aZ09\u00e9  \t\v\f\u00a0\u3000\ufeff\u180e*~`[]()#|\\\u{1F600}\ud83d",
  );
  const LINE_TERMINATORS = ["\n", "\r", "\u2028", "\u2029"];

  test("agrees with the old regex on 20,000 seeded pseudo-random strings", () => {
    const random = seededRandom(0x5eed);
    const pick = (from: readonly string[]): string =>
      from[Math.floor(random() * from.length)] ?? "";
    const mismatches: string[] = [];
    let rewritten = 0;
    for (let n = 0; n < 20_000; n++) {
      // Mostly short strings where every character meets every other, crossed by a line terminator
      // one character in ten; every tenth one long, with a line terminator one in a hundred, so it
      // holds several runs and several openers that fail before the end of their line.
      const isLong = n % 10 === 0;
      const length = isLong ? 100 + Math.floor(random() * 400) : Math.floor(random() * 40);
      const terminatorRate = isLong ? 0.01 : 0.1;
      let text = "";
      for (let k = 0; k < length; k++) {
        text += pick(random() < terminatorRate ? LINE_TERMINATORS : ALPHABET);
      }
      const want = viaOldRegex(text);
      if (want !== text) rewritten++;
      if (stripUnderscoreItalic(text) !== want) mismatches.push(JSON.stringify(text));
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(rewritten).toBeGreaterThan(5_000);
  });

  for (const [shape, text] of [
    ["the empty string", ""],
    ["a lone `_`", "_"],
    ["two adjacent `_`", "__"],
    ["three adjacent `_`, the middle one the content", "___"],
    ["four adjacent `_`", "____"],
    ["a run that is the whole string", "_a_"],
    ["a run closing at the end of the string", "x _a_"],
    ["an opener at the end of the string", "x _"],
    ["an opener nothing after it can close", "_a"],
    ["doubled delimiters on both sides", "__a__"],
    ["an inner `_` that a word character keeps from closing", "_a_b_"],
    ["two runs on one line", "_a_ _b_"],
    ["a space after the opener", "_ a_"],
    ["a space before the closer", "_a _"],
    ["punctuation on both sides", "(_a_)"],
    ["a word character before the opener", "x_a_ y"],
    ["a word character after the closer", "_a_b"],
    ["a letter `\\w` does not cover on both sides", "\u00e9_a_\u00e9"],
    ["CRLF after a run", "_a_\r\n"],
    ["CRLF inside a would-be run, then a run", "_a\r\n_b_"],
    ["a lone `\\r` inside a would-be run, then a run", "_a\r_b_"],
    ["an opener at the end of a line", "a _\nb_"],
    ["U+2028 inside a would-be run", "_a\u2028b_"],
    ["U+2029 inside a would-be run", "_a\u2029b_"],
    ["a no-break space on both sides", "\u00a0_a_\u00a0"],
    ["a BOM before the opener", "\ufeff_a_"],
    ["a BOM after the opener", "_\ufeffa_"],
    ["U+180E before the closer", "_a\u180e_"],
    ["a non-BMP character as the content", "_\u{1F600}_"],
    ["a non-BMP character before the opener", "\u{1F600}_a_"],
    ["a lone surrogate as the content", "_\ud83d_"],
    ["a run nested in bold", "**_a_**"],
    ["bold nested in a run", "_**a**_"],
    ["a run nested in single-asterisk italic", "*_a_*"],
    ["single-asterisk italic nested in a run", "_a *b* c_"],
    ["openers that fail, then a closer at the end of the string", `${" _a".repeat(5)} _b_`],
    ["openers that fail at a line terminator, then a run", `${" _a".repeat(5)}\n_b_`],
  ] as const) {
    test(`agrees with the old regex on ${shape}`, () => {
      expect(stripUnderscoreItalic(text)).toBe(viaOldRegex(text));
    });
  }

  test("plain text strips a run and leaves failed openers, identifiers and other lines alone", () => {
    expect(toPlainText("a _b_ c")).toBe("a b c");
    expect(toPlainText("x _\n_y_")).toBe("x _\ny");
    expect(toPlainText("_a_\r\n_b_")).toBe("a\r\nb");
    expect(toPlainText("**_a_**")).toBe("a");
    expect(toPlainText("_a **b** c_")).toBe("a b c");
    expect(toPlainText("| _a_ | b_c |")).toBe("a | b_c");
    expect(toPlainText("## _Deployments_")).toBe("Deployments");
    expect(toPlainText("[_t_](https://x/1)")).toBe("t");
  });

  // Each `_` in these opens a run that nothing on its line can close, and the regex rescanned the
  // rest of the line from every one of them: ` _a` repeated took 0.6 s at 15 KB, 2.4 s at 30 KB,
  // 9.2 s at 60 KB and over 40 s at the 120 KB here on a developer machine, four times as long per
  // doubling. The scan takes milliseconds. These also hold the scan's own skips to the bound —
  // past the end of the text in the first three, past a line terminator in the last — which the
  // equivalence tests above cannot see: a scan that retried every opener would return the same
  // output, quadratically.
  for (const [shape, line] of [
    ["` _a`: a space before each `_` and a word character after it", " _a".repeat(40_000)],
    ["`(_a`: only the word character after each `_` keeps it from closing", "(_a".repeat(40_000)],
    ["` _(`: only the space before each `_` keeps it from closing", " _(".repeat(40_000)],
    ["` _a` in four stretches each ended by `\\r`", `${" _a".repeat(10_000)}\r`.repeat(4)],
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
