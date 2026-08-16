import { describe, expect, test } from "bun:test";
import { excerpt, parseFailure, positionOf, squashMessage } from "./check-pr-message-parses.ts";

/**
 * The exact body fragment that broke release-please twice. Reproduced rather than invented,
 * because a guard against a real incident should be tested with the real input.
 */
const POISON = "`.run(`/`.exec(` in this tree are asserted **not** to flag, because a";

describe("squashMessage", () => {
  test("composes subject + (#N) + blank line + body, the way a squash merge does", () => {
    expect(squashMessage("fix: a thing", "why it matters", 1234)).toBe(
      "fix: a thing (#1234)\n\nwhy it matters",
    );
  });

  test("omits the suffix when there is no PR number, and the blank line when there is no body", () => {
    expect(squashMessage("fix: a thing", "", undefined)).toBe("fix: a thing");
    expect(squashMessage("fix: a thing", "   \n  ", 7)).toBe("fix: a thing (#7)");
  });

  test("normalises CRLF, so a Windows-authored body is judged as the server will store it", () => {
    expect(squashMessage("fix: a", "one\r\ntwo", 1)).toBe("fix: a (#1)\n\none\ntwo");
  });
});

describe("parseFailure — against the real parser", () => {
  test("a plain conventional commit parses", () => {
    expect(parseFailure("fix(security): widen a rule (#1218)\n\nA normal body.")).toBeUndefined();
  });

  test("balanced parens in a code span parse", () => {
    // The remedy the error message recommends must actually work, or the advice is useless.
    expect(
      parseFailure("fix: a (#1)\n\n`.run(…)`/`.exec(…)` are asserted not to flag."),
    ).toBeUndefined();
  });

  test("THE regression: unbalanced parens in code spans do not parse", () => {
    const failure = parseFailure(squashMessage("fix: a", POISON, 1));
    expect(failure).toBeDefined();
    expect(failure).toContain("unexpected token '('");
  });

  test("a non-conventional subject does not parse either", () => {
    // Already covered by pr-title-lint, but the composed message is what release-please sees, so
    // this check would catch it too rather than reporting a clean parse on a broken commit.
    expect(parseFailure("Retire CODECOV_TOKEN — it never reached Codecov (#790)")).toBeDefined();
  });
});

describe("positionOf / excerpt", () => {
  test("extracts line:col from the parser's message", () => {
    expect(positionOf("unexpected token '(' at 103:15, valid tokens [)]")).toEqual({
      line: 103,
      col: 15,
    });
    expect(positionOf("something else entirely")).toBeUndefined();
  });

  test("points a caret at the offending column", () => {
    const msg = "fix: a (#1)\n\nabc(def(ghi";
    const at = { line: 3, col: 8 };
    expect(excerpt(msg, at)).toBe("abc(def(ghi\n       ^");
  });

  test("returns empty rather than throwing when the line is out of range", () => {
    expect(excerpt("one line", { line: 99, col: 1 })).toBe("");
  });
});

describe("the two historical incidents", () => {
  /**
   * A message whose COMPOSED line `target` is the poison line.
   *
   * `squashMessage` produces `subject\n\n<body>`, so body line N lands at composed line N+2 and
   * the filler count is `target - 3`. Spelled out because getting it wrong is silent: the first
   * version of these tests used 99 filler lines, which puts the poison at 102, and asserted only
   * the COLUMN — so it passed while reproducing neither historical position.
   */
  function poisonAtComposedLine(subject: string, target: number, pr: number): string {
    const fillerCount = target - 3;
    const filler = Array.from({ length: fillerCount }, (_, i) => `filler ${String(i)}`);
    return squashMessage(subject, [...filler, POISON].join("\n"), pr);
  }

  test("the fixture helper really places the line where it claims", () => {
    // The helper is the load-bearing part of both assertions below, so it is checked directly
    // rather than trusted. Without this, an off-by-one moves both tests together and neither
    // notices.
    const msg = poisonAtComposedLine("fix: x", 103, 1);
    expect(msg.split("\n")[102]).toBe(POISON);
    expect(poisonAtComposedLine("fix: x", 17, 1).split("\n")[16]).toBe(POISON);
  });

  test.each([
    ["#1218", "fix(security): widen D12 past its receiver-name blind spot", 103, 1218],
    ["#1224", "fix(release): make the drop-guard ask whether the release PR is complete", 17, 1224],
  ])("%s reproduces its CI failure at %#", (_label, subject, line, pr) => {
    // Both LINE and column, against the positions CI actually reported (103:15 and 17:15).
    // Column alone cannot tell whether the parser's line accounting still matches production.
    const failure = parseFailure(poisonAtComposedLine(subject, line, pr));
    expect(failure).toBeDefined();
    expect(positionOf(failure as string)).toEqual({ line, col: 15 });
  });
});
