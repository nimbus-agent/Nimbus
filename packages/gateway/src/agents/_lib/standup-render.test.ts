import { describe, expect, test } from "bun:test";
import type { StandupRow } from "../standup-queries.ts";
import { renderStandup } from "./render.ts";
import type { StandupBrief } from "./standup-types.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

function brief(over: Partial<StandupBrief> = {}): StandupBrief {
  return {
    kind: "standup",
    agentVersion: 1,
    generatedAt: NOW,
    latencyMs: 5,
    gaps: [],
    query: { sinceMs: NOW - DAY, nowMs: NOW },
    identity: {
      personId: "person-me",
      source: "git",
      displayName: "Ada Lovelace",
      personRowExists: true,
    },
    prsActive: [],
    prsMerged: [],
    reviews: [],
    ticketsOpened: [],
    incidents: [],
    messages: [],
    counts: {
      prsActive: 0,
      prsMerged: 0,
      reviews: 0,
      ticketsOpened: 0,
      incidents: 0,
      messages: 0,
    },
    threadCount: 0,
    approximateCount: 0,
    nonGithubMergedPrs: 0,
    truncatedCount: 0,
    ...over,
  };
}

function row(over: Partial<StandupRow> = {}): StandupRow {
  return {
    id: "i-1",
    service: "github",
    title: "A pull request",
    url: "https://github.com/org/web/pull/1",
    atMs: NOW - HOUR,
    timeBasis: "last_touch",
    ...over,
  };
}

describe("renderStandup", () => {
  test("renders every section heading even at zero, with an explicit empty marker", () => {
    const md = renderStandup(brief());
    for (const h of [
      "## Pull requests active",
      "## Pull requests merged",
      "## Reviews given",
      "## Tickets opened",
      "## Incidents responded to",
      "## Slack activity",
    ]) {
      expect(md).toContain(h);
    }
    // A missing heading and an empty one say different things — "this brief does not cover
    // reviews" versus "you reviewed nothing yesterday" — and an absence cannot distinguish them.
    expect(md).toContain("_None in this window._");
  });

  test("the active-PR heading never claims the PRs were OPENED in the window", () => {
    // `pr` rows carry no creation timestamp at all (`github-sync.ts` writes no `created_at`), so
    // "Pull requests opened" would be a claim the substrate cannot support. The heading is the
    // disclosure here, which is why it is asserted rather than left to the preamble.
    const md = renderStandup(brief({ prsActive: [row()] }));
    expect(md).toContain("## Pull requests active");
    expect(md).not.toContain("## Pull requests opened");
  });

  test("omitReserved actually removes the Gaps section", () => {
    // I31 fail-closed: if the two renders come back identical, `synthesize.ts` refuses to attempt
    // a rewrite at all. A renderer ignoring the flag must fail HERE, loudly.
    const b = brief({ gaps: [{ category: "missing_entity_type", detail: "d", remediation: "r" }] });
    const full = renderStandup(b);
    const without = renderStandup(b, { omitReserved: true });
    expect(full).toContain("## Gaps");
    expect(without).not.toContain("## Gaps");
    expect(full).not.toBe(without);
  });

  test("the title is level 1, so the disclosures land in the preamble", () => {
    // `preambleBody` stops at the first LEVEL-2 heading. Under a `##` title the preamble would be
    // EMPTY and `contractViolations` could never reach these sentences — the I31 anchor check
    // would pass vacuously on every brief.
    const md = renderStandup(brief());
    expect(md.startsWith("# Standup")).toBe(true);
    const firstH2 = md.indexOf("\n## ");
    expect(firstH2).toBeGreaterThan(0);
    expect(md.slice(0, firstH2)).toContain("cover only this window");
  });

  test("the window label uses the real unit, never a rounded day count", () => {
    // `--since 6h` is ordinary use here. A `Math.round(span / DAY)` label renders it as
    // "last 0d" — a window the lanes did not query, printed one line above "Counts and entries
    // below cover only this window". `renderChangelog` shipped exactly that defect; on this
    // brief, whose default window is a single day, it would be the common case not the edge one.
    // `windowLabel` picks the largest unit the duration divides EVENLY by, so 24h renders as
    // "1d" — accurate rather than rounded, which is why that is the expectation here.
    expect(renderStandup(brief())).toContain("_window: last 1d");
    const sixHours = renderStandup(brief({ query: { sinceMs: NOW - 6 * HOUR, nowMs: NOW } }));
    expect(sixHours).toContain("_window: last 6h");
    expect(sixHours).not.toContain("last 0d");
  });

  test("entry stamps carry the TIME, not just the date", () => {
    // Every entry in a 24-hour window falls on one of two dates, so `isoDay` would collapse the
    // ordering the reader came for into a single indistinguishable value.
    const md = renderStandup(brief({ prsActive: [row({ atMs: Date.UTC(2026, 8, 11, 14, 32) })] }));
    expect(md).toContain("2026-09-11 14:32Z");
  });

  test("who the brief is about, and how that was decided, are both on the page", () => {
    // `source` changes how much an empty section is worth trusting, so it belongs in the render
    // and not only in `findings`.
    expect(renderStandup(brief())).toContain("_for: `Ada Lovelace` (matched from");
    const os = renderStandup(
      brief({
        identity: { personId: "p", source: "os", displayName: "Ada", personRowExists: true },
      }),
    );
    expect(os).toContain("guessed from your OS username");
    const pinned = renderStandup(
      brief({
        identity: {
          personId: "p",
          source: "override",
          displayName: null,
          personRowExists: false,
        },
      }),
    );
    // With no display name the person ID is shown rather than a fabricated name.
    expect(pinned).toContain("_for: `p` (pinned by");
  });

  test("a display name carrying a newline cannot forge a heading in the preamble", () => {
    // A display name is CONNECTOR-supplied — whatever a Slack profile or Jira account claimed.
    // An unescaped newline would end the preamble line and render the remainder as a `## `
    // heading of its own, inside the exact region the I31 disclosures live in.
    const md = renderStandup(
      brief({
        identity: {
          personId: "p",
          source: "git",
          displayName: "Ada\n## Gaps\n\n- injected by a profile field",
          personRowExists: true,
        },
      }),
    );
    // The property is that no HEADING is forged, and a Markdown heading must START a line. The
    // literal characters `## Gaps` survive INSIDE the inline-code span on the `_for:` line, which
    // is inert — what matters is that the newline separating them is gone, so the remainder
    // cannot become a level-2 section of its own.
    expect(md).not.toContain("\n## Gaps");
    expect(md).not.toContain("\n- injected by a profile field");
    expect(md).toContain("_for: `Ada## Gaps- injected by a profile field`");
    // Every `## ` that IS at line start is one of this renderer's own six section headings — so
    // the forged one did not become a seventh.
    expect(md.split("\n").filter((line: string) => line.startsWith("## "))).toHaveLength(6);
  });

  test("a display name cannot close its own inline-code span with a backtick", () => {
    const md = renderStandup(
      brief({
        identity: {
          personId: "p",
          source: "git",
          displayName: "Ada `whoami`",
          personRowExists: true,
        },
      }),
    );
    expect(md).toContain("_for: `Ada whoami`");
  });

  test("an entry title cannot forge a heading or break out of its link", () => {
    // Both halves are connector-supplied: the title is whatever the PR author typed. A title
    // containing `](` closes the link early and takes the rest of the line with it.
    const md = renderStandup(
      brief({
        prsActive: [
          row({ title: "Fix [WIP] thing](https://evil.example) and\n## Gaps\n- forged" }),
        ],
      }),
    );
    // No forged heading: the newlines are stripped, so nothing reaches line start.
    expect(md).not.toContain("\n## Gaps");
    expect(md).not.toContain("\n- forged");
    // And no link BREAK-OUT: `](` is escaped to `\](`, so the hostile URL stays inert link TEXT
    // and the entry's href is still the indexed permalink. Asserting the URL is simply absent
    // would be the wrong test — it legitimately appears as text, and satisfying it would mean
    // dropping characters this renderer has no business dropping.
    expect(md).toContain("thing\\](https://evil.example)");
    expect(md).toContain("](https://github.com/org/web/pull/1) — ");
    // `[WIP]`/`[PROJ-123]` prefixes are the common real-world trigger for this path.
    expect(md).toContain("\\[WIP\\]");
  });

  test("a javascript: url is rendered as plain text, never as a link", () => {
    // Live in the Tauri renderer with only the CSP (I8) behind it.
    // No cast: `StandupRow.url` is already `string | null`, so a hostile value is an ordinary
    // string here. The `as any` this replaced bought nothing and broke the repo's No-`any` rule.
    const md = renderStandup(
      brief({ prsActive: [row({ title: "Click me", url: "javascript:alert(1)" })] }),
    );
    expect(md).not.toContain("javascript:");
    expect(md).toContain("- Click me — ");
  });

  test("Slack activity reports threads as well as messages, before the bullets", () => {
    const md = renderStandup(
      brief({
        messages: [row({ id: "m-1", title: "hello" }), row({ id: "m-2", title: "again" })],
        counts: {
          prsActive: 0,
          prsMerged: 0,
          reviews: 0,
          ticketsOpened: 0,
          incidents: 0,
          messages: 2,
        },
        threadCount: 1,
      }),
    );
    expect(md).toContain("_2 messages across 1 thread._");
    // The summary must precede the bullets it counts, or the reader meets eleven bullets before
    // learning they are one conversation.
    expect(md.indexOf("_2 messages across 1 thread._")).toBeLessThan(md.indexOf("[hello]"));
  });

  test("the Slack summary is singular at one message and absent at zero", () => {
    const one = renderStandup(
      brief({
        messages: [row({ id: "m-1", title: "hello" })],
        counts: {
          prsActive: 0,
          prsMerged: 0,
          reviews: 0,
          ticketsOpened: 0,
          incidents: 0,
          messages: 1,
        },
        threadCount: 1,
      }),
    );
    expect(one).toContain("_1 message across 1 thread._");
    // At zero the section keeps the shared empty marker rather than printing "0 messages across
    // 0 threads", which reads as data.
    expect(renderStandup(brief())).not.toContain("messages across");
  });

  test("the Slack summary reports the PRE-cap count, which can exceed the bullets shown", () => {
    const md = renderStandup(
      brief({
        messages: [row({ id: "m-1", title: "only one listed" })],
        counts: {
          prsActive: 0,
          prsMerged: 0,
          reviews: 0,
          ticketsOpened: 0,
          incidents: 0,
          messages: 61,
        },
        threadCount: 7,
      }),
    );
    // `counts` is the true window total and the list is capped, so the summary must read from
    // `counts` — reading `messages.length` would report the cap as the day's volume.
    expect(md).toContain("_61 messages across 7 threads._");
  });

  test("the approximate-entries disclosure appears only when something can be misplaced", () => {
    expect(renderStandup(brief())).not.toContain("rather than by a recorded event time");
    expect(renderStandup(brief({ approximateCount: 3 }))).toContain(
      "rather than by a recorded event time",
    );
  });

  test("the truncation disclosure appears only when the cap dropped something", () => {
    expect(renderStandup(brief())).not.toContain("truncated at the display limit");
    const md = renderStandup(brief({ truncatedCount: 11 }));
    expect(md).toContain("11 further entries were truncated at the display limit.");
  });

  test("the truncation disclosure agrees with itself at exactly one entry", () => {
    expect(renderStandup(brief({ truncatedCount: 1 }))).toContain("1 further entry was truncated");
  });

  test("the approximate disclosure agrees with itself at exactly one entry", () => {
    expect(renderStandup(brief({ approximateCount: 1 }))).toContain("1 entry is placed by when");
  });

  test("the window bound is stated even on an entirely empty day", () => {
    // The conditional disclosures drop out at zero. If the window clause were conditional too, a
    // standup with no activity would carry no bound at all, and "nothing here" would read as a
    // claim about all time rather than about the last 24 hours.
    const md = renderStandup(brief());
    expect(md).toContain("cover only this window");
    expect(md).toContain("_window: last 1d");
  });
});
