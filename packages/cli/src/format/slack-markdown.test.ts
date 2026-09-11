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
});
