import { describe, expect, test } from "bun:test";

import { isPagerdutyFromEmail } from "./pagerduty-from-email.ts";

describe("isPagerdutyFromEmail", () => {
  test("accepts a single-line address with a dot inside the domain (trimmed first)", () => {
    for (const ok of ["oncall@example.com", "a.b+c@sub.example.co.uk", "  me@x.io  ", "a@b.c"]) {
      expect(isPagerdutyFromEmail(ok), ok).toBe(true);
    }
  });

  test("refuses empty, whitespace-only, no @, two @, empty local part or domain", () => {
    for (const bad of ["", "   ", "plain", "a@@b.co", "a@b@c.co", "@b.co", "a@", "a@.", "a@b"]) {
      expect(isPagerdutyFromEmail(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("refuses a dot that is not strictly inside the domain", () => {
    for (const bad of ["a@.co", "a@co.", "a@b.", "a@.b"]) {
      expect(isPagerdutyFromEmail(bad), bad).toBe(false);
    }
    // A dot only in the local part does not count.
    expect(isPagerdutyFromEmail("a.b@host")).toBe(false);
  });

  test("refuses interior whitespace and control characters", () => {
    const bad = [
      "a b@x.co",
      "a@x .co",
      "a\t@x.co",
      "a@x .co",
      "a@x .co",
      "a@x\u0000.co",
      "a@x\u007f.co",
      "a@x\u0085.co",
      "a@x.co\r\nBcc: z@y.co",
    ];
    for (const s of bad) expect(isPagerdutyFromEmail(s), JSON.stringify(s)).toBe(false);
  });

  test("a trailing newline is trimmed away, an interior one is not", () => {
    expect(isPagerdutyFromEmail("a@x.co\n")).toBe(true);
    expect(isPagerdutyFromEmail("a@x.\nco")).toBe(false);
  });

  test("at most 254 characters", () => {
    const domain = "@example.com";
    const at254 = `${"a".repeat(254 - domain.length)}${domain}`;
    expect(at254).toHaveLength(254);
    expect(isPagerdutyFromEmail(at254)).toBe(true);
    expect(isPagerdutyFromEmail(`a${at254}`)).toBe(false);
  });

  test("keeps the verdicts of the pattern it replaced on edge inputs", () => {
    const table: ReadonlyArray<readonly [string, boolean]> = [
      ["a@b.co", true],
      ["a@b", false],
      ["a@.co", false],
      ["a@co.", false],
      ["a@..", false],
      ["a@b..c", true],
      ["@@", false],
      ["a@b.c@d.e", false],
      ["ünï@exämple.com", true],
    ];
    for (const [input, want] of table) expect(isPagerdutyFromEmail(input), input).toBe(want);
  });

  test("adversarial 100k-character inputs finish fast and are refused", () => {
    const attacks = [
      "a".repeat(100_000),
      `${"a@".repeat(50_000)}`,
      `a@${".".repeat(100_000)}`,
      `a@${"b.".repeat(50_000)}`,
      `${"a".repeat(100_000)}@x.co`,
      `a@x.co${" ".repeat(100_000)}z`,
    ];
    const start = performance.now();
    for (const s of attacks) expect(isPagerdutyFromEmail(s)).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
