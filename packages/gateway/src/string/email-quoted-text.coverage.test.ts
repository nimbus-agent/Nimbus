/**
 * Two `stripQuotedTail` edges `email-quoted-text.test.ts` does not pin: the wrapped-attribution
 * join must STOP at a blank line or a quote line, and a body whose trailing block is only blank
 * lines has nothing to cut.
 *
 * Both inputs are built so the guard under test changes the OUTPUT, not just which line runs:
 * joining across the stop would manufacture an attribution (`... wrote:`) out of two unrelated
 * lines and move the cut.
 */
import { describe, expect, test } from "bun:test";
import { stripQuotedTail } from "./email-quoted-text.ts";

describe("stripQuotedTail — wrapped-attribution joining stops", () => {
  test("at a quote line: an unterminated opener above a quote stays in the author's text", () => {
    const body = [
      "My reply",
      "",
      "On Mon, Aug 3, 2026 at 4:32 PM Ada",
      "> she wrote:",
      "> the quoted question",
    ].join("\n");
    // Joined across the `>` line, the opener would read "... Ada > she wrote:" — a complete
    // attribution — and the cut would move up to swallow the author's own last line.
    expect(stripQuotedTail(body)).toBe("My reply\n\nOn Mon, Aug 3, 2026 at 4:32 PM Ada");
  });

  test("at a blank line: prose that merely starts with 'On' is not glued to the next attribution", () => {
    const body = [
      "On second thought, let's ship it.",
      "",
      "On Tue, Bob wrote:",
      "> can we ship?",
    ].join("\n");
    // Joined across the blank line, the first line would become part of "... On Tue, Bob wrote:",
    // the whole body would read as quoted, and nothing would be stripped at all.
    expect(stripQuotedTail(body)).toBe("On second thought, let's ship it.");
  });
});

describe("stripQuotedTail — a tail of blank lines only", () => {
  test("is not a quoted tail: the body comes back exactly as given", () => {
    for (const body of ["Hello there\n\n\n", "Line one\nLine two\n   \n\t\n"]) {
      expect(stripQuotedTail(body)).toBe(body);
    }
  });

  test("a real marker after the blank lines is still cut", () => {
    expect(stripQuotedTail("Hello there\n\n\n> quoted\n")).toBe("Hello there");
  });
});
