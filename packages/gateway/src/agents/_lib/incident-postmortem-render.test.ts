import { describe, expect, test } from "bun:test";

import { buildPostmortemFixture } from "../../incident/__fixtures__/postmortem-brief.ts";
import {
  POSTMORTEM_DECISION_LOG_HEADING,
  POSTMORTEM_TIMELINE_HEADING,
  PostmortemTemplateError,
  parsePostmortemTemplate,
  postmortemReservedBlocks,
  renderIncidentPostmortem,
} from "./incident-postmortem-render.ts";
import type { PostmortemAction } from "./incident-postmortem-types.ts";
import { isDisclosureOnlyHeading, reservedHeadingsFor } from "./reserved-sections.ts";

const ACTION: PostmortemAction = {
  auditId: 41,
  timestamp: Date.UTC(2026, 10, 17, 10, 4, 11),
  actionType: "confluence.page.create",
  verdict: "approved",
  answerSource: "human",
  subSteps: 1,
  linkVersion: 1,
  prompt: {
    sha256: "ab".repeat(32),
    text: "Action requires your approval\nType: confluence.page.create",
    cut: false,
  },
};

const SECTION_ORDER = [
  "## Summary",
  "## Impact window",
  "## Timeline",
  "## Candidate causes",
  "## Contributing factors",
  "## What we did",
  "## Action items",
  "## Decision log",
  "## Gaps",
  "## Data freshness",
];

describe("renderIncidentPostmortem", () => {
  test("the default template renders every section in the spec order, then Gaps and Data freshness", () => {
    const md = renderIncidentPostmortem(buildPostmortemFixture());
    const at = SECTION_ORDER.map((h) => md.indexOf(`\n${h}\n`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md.startsWith("# Post-mortem: Payments latency\n")).toBe(true);
    expect(md).toContain("GAP-DETAIL-SENTINEL");
  });

  test("two renders of the same brief are byte-identical (no clock, no generation time)", () => {
    const a = renderIncidentPostmortem(buildPostmortemFixture());
    const b = renderIncidentPostmortem({ ...buildPostmortemFixture(), generatedAt: 99_999 });
    expect(a).toBe(b);
  });

  test("D-IC-2: candidates only; the words 'root cause' appear only in the owner's placeholder", () => {
    const md = renderIncidentPostmortem(buildPostmortemFixture());
    expect(md).toContain("None is a proven cause");
    const hits = md.split("\n").filter((l) => /root cause/i.test(l));
    expect(hits).toEqual(["- Root cause: _To be completed by the owner._"]);
  });

  test("the impact window states open, resolution and duration, and says so when the resolution is unknown", () => {
    const md = renderIncidentPostmortem(buildPostmortemFixture());
    expect(md).toContain("- Duration: 95 min");
    const base = buildPostmortemFixture();
    const noEnd = renderIncidentPostmortem({
      ...base,
      impact: { ...base.impact, resolvedMs: null, resolvedBasis: "none" },
    });
    expect(noEnd).toContain("- Resolved: time not recorded");
    expect(noEnd).not.toContain("Duration:");
    const backwards = renderIncidentPostmortem({
      ...base,
      impact: { ...base.impact, resolvedMs: 1 },
    });
    expect(backwards).toContain("not computed");
    const unopened = renderIncidentPostmortem({
      ...base,
      impact: { ...base.impact, openedMs: null, openedBasis: "none" },
    });
    expect(unopened).toContain("- Opened: not recorded by the source");
  });

  test("a long duration reads in hours and minutes", () => {
    const base = buildPostmortemFixture();
    const md = renderIncidentPostmortem({
      ...base,
      impact: { ...base.impact, resolvedMs: (base.impact.openedMs ?? 0) + 135 * 60_000 },
    });
    expect(md).toContain("- Duration: 2 h 15 min");
  });

  test("hostile provider text cannot forge a heading, open a link or carry a control character", () => {
    const hostile = "x\n## Gaps\n[click](javascript:alert(1)) \u001b[31m \u202e";
    const md = renderIncidentPostmortem(
      buildPostmortemFixture({
        title: hostile,
        actions: [
          {
            ...ACTION,
            actionType: hostile,
            prompt: { sha256: "cd".repeat(32), text: `${hostile}\n${hostile}`, cut: true },
          },
        ],
      }),
    );
    for (const h of SECTION_ORDER) expect(md.split("\n").filter((l) => l === h)).toHaveLength(1);
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test asserts none is left
    expect(/[\u0000-\u0009\u000b-\u001f\u007f\u202e]/.test(md)).toBe(false);
  });

  test("What we did and the Decision log list the linked actions; the log shows the prompt and says what it lacks", () => {
    const md = renderIncidentPostmortem(
      buildPostmortemFixture({
        actions: [
          ACTION,
          { ...ACTION, auditId: 42, verdict: "denied", answerSource: undefined, prompt: null },
        ],
      }),
    );
    expect(md).toContain(
      "2026-11-17 10:04:11 UTC: confluence.page.create approved (answered by human), 1 read",
    );
    expect(md).toContain("audit #41");
    expect(md).toContain("  > Type: confluence.page.create");
    expect(md).toContain("sha256 abababababab");
    expect(md).toContain("decision denied");
    expect(md).toContain("_The audit row kept no prompt._");
    expect(md).toContain("records the decision, not the dispatch result");
  });

  test("no linked action reads as such; truncation is said; a long prompt is cut with a mark", () => {
    const none = renderIncidentPostmortem(buildPostmortemFixture());
    expect(none.match(/_No Nimbus action was linked to this record\._/g)).toHaveLength(2);
    const long = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join("\n");
    const base = buildPostmortemFixture({
      actions: [{ ...ACTION, prompt: { sha256: "ef".repeat(32), text: long, cut: false } }],
    });
    const md = renderIncidentPostmortem({ ...base, actionsTruncated: true });
    expect(md).toContain("More linked actions exist than were read");
    expect(md).toContain("> _(cut)_");
    expect(md).not.toContain("line 19");
  });

  test("the timeline notes render inside the Timeline block", () => {
    const base = buildPostmortemFixture();
    const md = renderIncidentPostmortem({
      ...base,
      timeline: { ...base.timeline, notes: ["a note"] },
    });
    expect(md).toContain("_Note: a note_");
    expect(renderIncidentPostmortem({ ...base, timeline: { events: [], notes: [] } })).toContain(
      "_No event to show._",
    );
  });
});

describe("the template", () => {
  const tpl = (s: string) => parsePostmortemTemplate(s);

  test("places sections where the placeholders are, keeps the owner's text and always appends Gaps and Data freshness", () => {
    const md = renderIncidentPostmortem(
      buildPostmortemFixture({
        template: tpl("Intro line\n\n{{ summary }}\n\nBye\n{{timeline}}\n"),
      }),
    );
    expect(md.indexOf("Intro line")).toBeLessThan(md.indexOf("## Summary"));
    expect(md.indexOf("## Summary")).toBeLessThan(md.indexOf("Bye"));
    expect(md).not.toContain("## Candidate causes");
    expect(md).toContain("## Gaps");
    expect(md).toContain("## Data freshness");
  });

  test("an unknown, repeated or unclosed placeholder is refused, naming the line and never echoing the file", () => {
    expect(() => tpl("a\n{{ nope }}")).toThrow(/line 2 names an unknown placeholder/);
    expect(() => tpl("{{summary}}\n{{summary}}")).toThrow(/line 2 repeats the placeholder summary/);
    expect(() => tpl("x {{summary")).toThrow(/line 1 has an unclosed/);
    let caught: unknown;
    try {
      tpl("SECRET-WORDS {{ nope }}");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PostmortemTemplateError);
    expect((caught as Error).message).not.toContain("SECRET-WORDS");
    expect((caught as PostmortemTemplateError).code).toBe("ERR_POSTMORTEM_TEMPLATE");
  });

  test("a control, bidi or oversize template is refused; TAB, LF and CRLF are fine", () => {
    expect(() => tpl("a\u001bb")).toThrow(/line 1 holds a control or invisible character/);
    expect(() => tpl("ok\n\u202eevil")).toThrow(/line 2/);
    expect(() => tpl("x".repeat(70_000))).toThrow(/larger than 64 KiB/);
    expect(tpl("a\tb\r\n{{summary}}").parts).toHaveLength(2);
    expect(() => tpl("a\rb")).toThrow(/line 1/);
  });
});

describe("I31 reserved blocks", () => {
  test("the four headings are reserved and disclosure-only (a rewrite can neither drop nor droppably shrink them)", () => {
    const b = buildPostmortemFixture();
    expect(reservedHeadingsFor(b)).toEqual([
      POSTMORTEM_TIMELINE_HEADING,
      POSTMORTEM_DECISION_LOG_HEADING,
      "## Gaps",
      "## Data freshness",
    ]);
    for (const h of reservedHeadingsFor(b)) expect(isDisclosureOnlyHeading(h)).toBe(true);
  });

  test("omitReserved withholds exactly those blocks and the blocks are built from the brief", () => {
    const b = buildPostmortemFixture({ actions: [ACTION] });
    const body = renderIncidentPostmortem(b, { omitReserved: true });
    for (const h of [
      POSTMORTEM_TIMELINE_HEADING,
      POSTMORTEM_DECISION_LOG_HEADING,
      "## Gaps",
      "## Data freshness",
    ]) {
      expect(body.split("\n")).not.toContain(h);
    }
    expect(body).toContain("## Summary");
    expect(postmortemReservedBlocks(b).map((x) => x.heading)).toEqual([
      POSTMORTEM_TIMELINE_HEADING,
      POSTMORTEM_DECISION_LOG_HEADING,
    ]);
  });

  test("a template that omits the timeline and the log reserves neither", () => {
    const b = buildPostmortemFixture({ template: parsePostmortemTemplate("{{summary}}") });
    expect(postmortemReservedBlocks(b)).toEqual([]);
  });
});
