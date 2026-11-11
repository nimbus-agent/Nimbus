import { describe, expect, test } from "bun:test";
import { renderBriefing, renderBriefingFreshness } from "./briefing-render.ts";
import type { BriefingBrief } from "./briefing-types.ts";
import { synthesize } from "./synthesize.ts";

function brief(over: Partial<BriefingBrief> = {}): BriefingBrief {
  return {
    kind: "briefing",
    agentVersion: 1,
    generatedAt: "2026-11-12T08:30:00.000Z",
    latencyMs: 0,
    gaps: [],
    tz: "Europe/London",
    day: { startMs: 0, endMs: 1, dateKey: "2026-11-12", label: "Thursday 2026-11-12" },
    sections: [
      {
        section: "calendar",
        title: "Calendar",
        rows: [
          [
            { t: "text", text: "09:00-09:30 " },
            {
              t: "link",
              title: "Standup](http://evil.example)\nnew line",
              url: "javascript:alert(1)",
            },
          ],
          [
            { t: "link", title: "Safe", url: "https://example.com/a(b)" },
            { t: "text", text: " - from " },
            { t: "plain", text: `${"x".repeat(100)}‮[a](http://evil)\n\`` },
          ],
        ],
        notes: ["and 3 more"],
        emptyText: null,
      },
      { section: "mail", title: "Mail", rows: [], notes: [], emptyText: "No unread mail." },
    ],
    counts: {
      meetings: 2,
      onCallShifts: 0,
      incidents: 0,
      reviews: 0,
      ticketsDue: 0,
      unreadMail: 0,
      unreadChat: 0,
    },
    freshness: [{ section: "Calendar", text: "google_calendar 4 min ago" }],
    ...over,
  };
}

describe("renderBriefing", () => {
  test("header, one section per block, notes, then Gaps and Data freshness", () => {
    const md = renderBriefing(
      brief({ gaps: [{ category: "missing_connector", detail: "No mail source." }] }),
    );
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Morning briefing - Thursday 2026-11-12 (Europe/London)");
    expect(md).toContain("## Calendar");
    expect(md).toContain("_and 3 more_");
    expect(md).toContain("## Mail\n\n_No unread mail._");
    expect(md.indexOf("## Calendar")).toBeLessThan(md.indexOf("## Mail"));
    expect(md.indexOf("## Mail")).toBeLessThan(md.indexOf("## Gaps"));
    expect(md.indexOf("## Gaps")).toBeLessThan(md.indexOf("## Data freshness"));
    expect(md).toContain("- Calendar: google_calendar 4 min ago");
  });

  test("indexed text is hardened: titles neutralised, javascript: dropped, plain text capped and escaped", () => {
    const md = renderBriefing(brief());
    expect(md).not.toContain("javascript:");
    // the closing bracket is escaped, so the link cannot be closed early
    expect(md).not.toMatch(/(?<!\\)\]\(http:\/\/evil\.example\)/);
    expect(md).toContain("Standup\\](http://evil.example)");
    expect(md).not.toContain("‮");
    expect(md).toContain("[Safe](https://example.com/a%28b%29)");
    const sender = md.split("\n").find((l) => l.includes("[Safe]")) ?? "";
    // 80 characters kept, an ellipsis, no raw backtick or newline, brackets escaped
    expect(sender).toContain(`${"x".repeat(80)}…`);
    expect(sender).not.toContain("`");
  });

  test("omitReserved drops exactly Gaps and Data freshness", () => {
    const b = brief({ gaps: [{ category: "empty_index", detail: "Empty." }] });
    const body = renderBriefing(b, { omitReserved: true });
    expect(body).not.toContain("## Gaps");
    expect(body).not.toContain("## Data freshness");
    expect(body).toContain("## Calendar");
  });

  test("no freshness rows gives no freshness block", () => {
    expect(renderBriefingFreshness([])).toBe("");
    expect(renderBriefing(brief({ freshness: [] }))).not.toContain("## Data freshness");
  });

  test("two renders are byte-identical", () => {
    expect(renderBriefing(brief())).toBe(renderBriefing(brief()));
  });
});

describe("synthesize with no runner", () => {
  test("is the deterministic path with the honest footer and no attempt", async () => {
    const out = await synthesize(brief());
    expect(out.provenance).toEqual({ attempted: false, reason: "disabled" });
    expect(out.markdown).toContain("# Morning briefing - Thursday 2026-11-12");
    expect(out.markdown.trimEnd().endsWith("regardless of `[llm]` settings._")).toBe(true);
  });
});
