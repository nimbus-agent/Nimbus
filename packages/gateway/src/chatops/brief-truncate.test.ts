import { describe, expect, test } from "bun:test";
import { truncateBrief } from "./brief-truncate.ts";

describe("truncateBrief", () => {
  test("keeps ## Gaps even when it sits past the byte cap", () => {
    const body = `## Findings\n${"x".repeat(5000)}\n`;
    const brief = `# Why\n\n${body}## Gaps\n\n- category: coverage\n`;
    const out = truncateBrief(brief, "why", 500);
    expect(out).toContain("## Gaps");
    expect(out).toContain("category: coverage");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500 + 200); // + the notice line
  });

  test("announces the truncation rather than hiding it", () => {
    const brief = `# Why\n\n## A\n${"x".repeat(5000)}\n## Gaps\n\n- none\n`;
    expect(truncateBrief(brief, "why", 400)).toContain("truncated");
  });

  test("a brief under the cap is returned byte-identical", () => {
    const brief = "# Why\n\n## Gaps\n\n- none\n";
    expect(truncateBrief(brief, "why", 10_000)).toBe(brief);
  });

  test("drops a droppable section regardless of its heading level (# and ### too, not only ##)", () => {
    const brief =
      `# Why\n\n# Promoted Section\n${"x".repeat(3000)}\n` +
      `### Demoted Section\n${"y".repeat(3000)}\n` +
      `## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "why", 500);
    expect(out).not.toContain("Promoted Section");
    expect(out).not.toContain("Demoted Section");
    expect(out).toContain("## Gaps"); // the disclosure survives regardless of what else was dropped
  });

  test("a kind with no matching SynthInput literal (the conflicts/conflict mismatch) still keeps Gaps", () => {
    const brief = `# Conflicts\n\n## Findings\n${"z".repeat(4000)}\n## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "conflicts", 500);
    expect(out).toContain("## Gaps");
    expect(out).toContain("truncated");
  });

  test("negotiate's extra reserved sections all survive a truncation", () => {
    const brief =
      `# Negotiate\n\n## Findings\n${"a".repeat(4000)}\n` +
      `## Sources\n\n- src A\n` +
      `## Evidence not available from the index\n\n- none\n` +
      `## Gaps\n\n- none\n`;
    const out = truncateBrief(brief, "negotiate", 500);
    expect(out).not.toContain("Findings");
    expect(out).toContain("## Sources");
    expect(out).toContain("src A");
    expect(out).toContain("## Evidence not available from the index");
    expect(out).toContain("## Gaps");
  });

  test("reserved blocks alone over the cap still come back whole, with a notice, never half-printed", () => {
    const bigGap = `- ${"detail ".repeat(200).trim()}`;
    const brief = `# Why\n\n## Findings\nsmall\n\n## Gaps\n\n${bigGap}\n`;
    const out = truncateBrief(brief, "why", 50);
    expect(out).toContain("## Gaps");
    expect(out).toContain(bigGap);
    expect(out).not.toContain("Findings");
    expect(out).toContain("truncated");
  });

  test("a brief with no reserved section content at all still truncates the body", () => {
    const brief = `# Why\n\n## A\n${"x".repeat(3000)}\n## B\n${"y".repeat(3000)}\n`;
    const out = truncateBrief(brief, "why", 500);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(700);
    expect(out).toContain("truncated");
  });
});
