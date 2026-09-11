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
  test("bold inside a link title survives both rules", () => {
    expect(toSlackMrkdwn("[**hot**fix](https://x/2)")).toBe("<https://x/2|*hot*fix>");
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
});
