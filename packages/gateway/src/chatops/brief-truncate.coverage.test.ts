/**
 * `truncateBrief` shapes `brief-truncate.test.ts` leaves unexercised. Every brief there opens with
 * a `# Title` heading, which `topLevelSections` counts as a SECTION — so none of them has a real
 * preamble (text before the first heading). These do, and they also pin the forced-fit notice
 * with NO extra clause (nothing but reserved content to cut) and a glossary `## Terms` block with
 * no parseable entries reaching that forced-fit path.
 */
import { describe, expect, test } from "bun:test";
import { truncateBrief } from "./brief-truncate.ts";

const cutNotice = (kind: string, extra = ""): string =>
  `_(truncated — content was cut to fit the chat size limit${extra}; run \`nimbus ${kind}\` locally for the full brief)_`;

const omittedNotice = (kind: string, n: number): string =>
  `_(truncated — ${String(n)} sections omitted; run \`nimbus ${kind}\` locally for the full brief)_`;

describe("truncateBrief — a real preamble", () => {
  test("a preamble that fits is kept while a trailing body section is dropped", () => {
    const brief =
      "Owner summary: three incidents this week.\n\n" +
      `## Timeline\n\n${"t".repeat(600)}\n\n` +
      "## Gaps\n\n- pagerduty sync is 3h old\n";
    const out = truncateBrief(brief, "oncall", 300);
    expect(out).toBe(
      "Owner summary: three incidents this week.\n\n" +
        "## Gaps\n\n- pagerduty sync is 3h old\n\n" +
        omittedNotice("oncall", 1),
    );
  });

  test("a preamble that is the whole body is dropped last, and the notice counts it as a section", () => {
    const preamble = `Owner summary: ${"p".repeat(400)}`;
    const brief = `${preamble}\n\n## Gaps\n\n- no deployments indexed\n`;
    const out = truncateBrief(brief, "catchup", 200);
    expect(out).not.toContain("Owner summary");
    expect(out.trimStart()).toBe(
      `## Gaps\n\n- no deployments indexed\n\n${omittedNotice("catchup", 1)}`,
    );
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
  });
});

describe("truncateBrief — forced fit with nothing but reserved content", () => {
  test("a Gaps-only brief over the cap is cut to the cap with the bare content-was-cut notice", () => {
    const gaps = Array.from({ length: 40 }, (_, i) => `- gap number ${String(i)}`).join("\n");
    const brief = `## Gaps\n\n${gaps}\n`;
    const out = truncateBrief(brief, "catchup", 300);

    // No body was dropped and no glossary is involved, so the notice carries NO extra clause.
    const notice = cutNotice("catchup");
    expect(out.endsWith(`\n\n${notice}`)).toBe(true);
    expect(out).not.toContain("sections omitted");
    expect(out).not.toContain("terms");
    // ASCII content, so the cut lands exactly on the cap: content budget + "\n\n" + notice.
    expect(Buffer.byteLength(out, "utf8")).toBe(300);
    expect(out.startsWith("## Gaps\n\n- gap number 0\n- gap number 1\n")).toBe(true);
    expect(out).not.toContain("- gap number 39");
  });

  test("a glossary ## Terms block with no parseable entries is dropped whole and ## Gaps kept intact", () => {
    const caption = `_${"ranking caption ".repeat(30).trim()}_`;
    const brief = `## Terms\n\n${caption}\n\n## Gaps\n\n- definitions are unauthored\n`;
    const out = truncateBrief(brief, "glossary", 250);
    expect(out).toBe(
      `## Gaps\n\n- definitions are unauthored\n\n${cutNotice("glossary", " — showing 0 of 0 terms")}`,
    );
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(250);
  });
});
