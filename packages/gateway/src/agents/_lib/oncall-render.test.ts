import { describe, expect, test } from "bun:test";

import type { OncallBrief } from "./oncall-types.ts";
import { renderOncall } from "./render.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function brief(over: Partial<OncallBrief> = {}): OncallBrief {
  return {
    kind: "oncall",
    agentVersion: 1,
    generatedAt: NOW,
    latencyMs: 12,
    gaps: [],
    query: { sinceMs: NOW - DAY, nowMs: NOW },
    selection: "auto_assigned",
    incident: {
      id: "pagerduty:inc-1",
      title: "Checkout 500s",
      url: null,
      status: "triggered",
      severity: "P1",
      urgency: "high",
      openedAtMs: NOW - 2 * HOUR,
      pagerdutyServiceId: "PSERVICE1",
      assigneeEmails: ["ada@example.com"],
    },
    otherActiveIncidents: [],
    syncFreshness: { lastSyncMs: NOW - 5 * 60_000, ageMs: 5 * 60_000, reason: null },
    onCallNow: null,
    binding: { nimbusServiceId: "checkout", pagerdutyServiceId: "PSERVICE1" },
    deployment: null,
    change: null,
    ciRun: null,
    messages: [],
    priorIncidents: [],
    counts: { messages: 0, priorIncidents: 0 },
    truncatedCount: 0,
    ...over,
  };
}

describe("renderOncall", () => {
  test("titles with `#`, so the preamble is reachable by the I31 contract check", () => {
    // `preambleBody` stops at the first LEVEL-2 heading. Under a `##` title the preamble would be
    // empty and `contractViolations` could never reach the sync-freshness disclosure that
    // qualifies the whole selection. `renderStandup` documents the same constraint.
    const out = renderOncall(brief());
    expect(out.startsWith("# On-call")).toBe(true);
    expect(out.split("\n## ")[0]).toContain("PagerDuty sync");
  });

  test("renders EVERY section even when empty, because absent and empty say different things", () => {
    const out = renderOncall(brief());
    for (const heading of [
      "## Incident",
      "## Last deployment before the alert",
      "## Change in that deployment",
      "## CI",
      "## Chat",
      "## Prior incidents on this service",
    ]) {
      expect(out).toContain(heading);
    }
    expect(out).toContain("_None found._");
  });

  test("the deployment heading states TIMING, never causation", () => {
    // The roadmap row asked for "the triggering PR". Nothing in the index links a deployment to an
    // incident, so neither the heading nor the preamble may call it a cause.
    const out = renderOncall(
      brief({
        deployment: {
          id: "dep-1",
          title: "Deploy prod",
          url: null,
          provider: "github-actions",
          environment: "prod",
          sha: "abc123",
          ref: "refs/heads/main",
          startedAtMs: NOW - 3 * HOUR,
          finishedAtMs: NOW - 3 * HOUR + 60_000,
          conclusion: "success",
          workflowUrl: null,
          ciRunExternalId: "run-9",
        },
      }),
    );
    expect(out).toContain("## Last deployment before the alert");
    expect(out).toContain("timing alone");
    expect(out).toContain("a place to look");
    expect(out.toLowerCase()).not.toContain("root cause");
    expect(out.toLowerCase()).not.toContain("triggering pr");
  });

  test("the correlation disclosure is ABSENT when no deployment was found", () => {
    // An inapplicable caveat is how a reader learns to skip the ones that apply.
    expect(renderOncall(brief())).not.toContain("timing alone");
  });

  test("the sync-freshness line is present even when the sync is seconds old", () => {
    const fresh = renderOncall(
      brief({ syncFreshness: { lastSyncMs: NOW, ageMs: 0, reason: null } }),
    );
    expect(fresh).toContain("from the last PagerDuty sync");
    expect(fresh).toContain("may have been closed");
  });

  test("an unknown sync state says so rather than printing an age of zero", () => {
    const out = renderOncall(
      brief({ syncFreshness: { lastSyncMs: null, ageMs: null, reason: "no_sync_record" } }),
    );
    expect(out).toContain("no record of one having completed");
    expect(out).toContain("may have been closed");
  });

  test("absent incident fields render as `_not recorded_`, never as blanks or `undefined`", () => {
    const out = renderOncall(
      brief({
        incident: {
          ...brief().incident,
          status: null,
          severity: null,
          urgency: null,
          openedAtMs: null,
          assigneeEmails: [],
        },
      }),
    );
    expect(out).not.toContain("undefined");
    expect(out).toContain("_not recorded_");
    expect(out).toContain("_nobody recorded_");
    // A missing status is WHY an incident counts as active, so it must still be visible.
    expect(out).toContain("status unknown");
  });

  test("an unmapped PagerDuty service prints the id the reader has to configure", () => {
    const out = renderOncall(
      brief({ binding: { nimbusServiceId: null, pagerdutyServiceId: "PSERVICE1" } }),
    );
    expect(out).toContain("_unmapped");
    expect(out).toContain("PSERVICE1");
  });

  test("a change renders a DIFFSTAT, and distinguishes absent counts from zero", () => {
    const withStat = renderOncall(
      brief({
        change: {
          id: "pr-42",
          title: "Fix checkout timeout",
          url: null,
          service: "github",
          mergedAtMs: NOW - 4 * HOUR,
          additions: 12,
          deletions: 3,
          changedFiles: 2,
        },
      }),
    );
    expect(withStat).toContain("+12");
    expect(withStat).toContain("2 files");

    const noStat = renderOncall(
      brief({
        change: {
          id: "pr-43",
          title: "Untracked",
          url: null,
          service: "github",
          mergedAtMs: null,
          additions: null,
          deletions: null,
          changedFiles: null,
        },
      }),
    );
    // `+0 −0 across 0 files` is legitimate for an empty-commit deploy, so "not recorded" must
    // stay distinguishable from it.
    expect(noStat).toContain("_line counts not recorded_");
    expect(noStat).not.toContain("+0");
  });

  test("other active incidents are NAMED with their ids, so a runner-up is actionable", () => {
    const out = renderOncall(
      brief({
        otherActiveIncidents: [
          { id: "pagerduty:inc-2", title: "Payments latency", openedAtMs: NOW - 6 * HOUR },
        ],
      }),
    );
    expect(out).toContain("pagerduty:inc-2");
    expect(out).toContain("Payments latency");
    expect(out).toContain("covers the most recently opened one");
  });

  test("prior incidents report who and when, and never claim HOW", () => {
    const out = renderOncall(
      brief({
        priorIncidents: [
          {
            id: "pagerduty:inc-0",
            title: "Checkout 500s (earlier)",
            url: null,
            openedAtMs: NOW - 10 * DAY,
            resolvedAtMs: NOW - 9 * DAY,
            resolvedByEmail: "ada@example.com",
          },
        ],
        counts: { messages: 0, priorIncidents: 1 },
      }),
    );
    expect(out).toContain("closed");
    expect(out).toContain("ada@example.com");
    expect(out).toContain("1 earlier incident on this service");
  });

  test("an unresolved prior incident reads `still open`, not a fabricated close time", () => {
    const out = renderOncall(
      brief({
        priorIncidents: [
          {
            id: "pagerduty:inc-0",
            title: "Earlier",
            url: null,
            openedAtMs: NOW - 10 * DAY,
            resolvedAtMs: null,
            resolvedByEmail: null,
          },
        ],
        counts: { messages: 0, priorIncidents: 1 },
      }),
    );
    expect(out).toContain("still open");
  });

  test("connector-supplied text cannot break out of its link or line", () => {
    // Both halves are connector-supplied: an incident title is written by whoever opened it, and a
    // url is a connector's `canonical_url`. A title containing `](` closes the link early, and a
    // newline would end the preamble line and let the remainder render as a heading of its own —
    // inside the exact region the I31 disclosures live in.
    const out = renderOncall(
      brief({
        incident: {
          ...brief().incident,
          title: "evil](javascript:alert(1)) \n## Fake heading",
          url: "javascript:alert(1)",
        },
      }),
    );
    // The property that matters is that no INJECTED line-start survives, not that the characters
    // are gone: `stripLineStructureChars` collapses the newline, so "## Fake heading" remains as
    // inline text on the preamble line and can never be parsed as a heading. Asserting the
    // substring's absence would have failed against a correct defense — assert the structure.
    const headings = out.split("\n").filter((l) => l.startsWith("#"));
    expect(headings).not.toContain("## Fake heading");
    for (const h of headings) expect(h).not.toContain("Fake heading");
    // The `]` is escaped, so the markdown link cannot close early and take the rest with it.
    expect(out).toContain("evil\\]");
    // `](javascript:` DOES occur here — as escaped literal text from the title — so asserting its
    // absence would fail against a correct defense. The property is that every occurrence is
    // preceded by a backslash, i.e. none of them closes a link.
    for (let i = out.indexOf("](javascript:"); i !== -1; i = out.indexOf("](javascript:", i + 1)) {
      expect(out.slice(i - 1, i)).toBe("\\");
    }
  });

  test("a javascript: url is DROPPED rather than rendered as a link target", () => {
    // The url guard on its own, with a title that cannot confuse the assertion. A `javascript:`
    // href is live in the Tauri renderer with only the CSP (I8) behind it.
    const out = renderOncall(
      brief({
        incident: { ...brief().incident, title: "Plain title", url: "javascript:alert(1)" },
      }),
    );
    expect(out).toContain("Plain title");
    expect(out).not.toContain("javascript:");
    // Rendered as plain text, never as a link to nowhere.
    expect(out).not.toContain("[Plain title](");
  });

  test("the reserved Gaps section is withheld under omitReserved and present without it", () => {
    // The I31 mechanism: the canonical and `omitReserved` renders must DIFFER, or `synthesize.ts`
    // fails closed and attempts no rewrite at all.
    const b = brief({
      gaps: [{ category: "missing_entity_type", detail: "d", remediation: "r" }],
    });
    const canonical = renderOncall(b);
    const omitted = renderOncall(b, { omitReserved: true });
    expect(canonical).toContain("## Gaps");
    expect(omitted).not.toContain("## Gaps");
    expect(canonical).not.toBe(omitted);
  });
});

describe("renderOncall — review fixes (CodeRabbit #1509)", () => {
  const RUNNER_UP = {
    id: "pagerduty:inc-2",
    title: "Payments latency",
    openedAtMs: NOW - 6 * HOUR,
  };

  test("a --service brief does NOT call runner-ups `assigned to you`", () => {
    // `selectActiveIncidentsForPagerdutyServices` filters on service and status ONLY — no
    // assignee predicate — so those incidents may belong to anyone. Saying otherwise is a plain
    // falsehood about someone else's page, in the exact class of defect this brief exists to
    // avoid.
    const out = renderOncall(
      brief({ selection: "auto_service", otherActiveIncidents: [RUNNER_UP] }),
    );
    expect(out).not.toContain("assigned to you");
    expect(out).toContain("Other active incidents on this service");
    expect(out).toContain("on this service and");
  });

  test("an owner-scoped brief still says `assigned to you`, which is true there", () => {
    // The fix must not make the accurate case vaguer — that was the reason for splitting the
    // selection union rather than adopting one scope-neutral phrase everywhere.
    const out = renderOncall(
      brief({ selection: "auto_assigned", otherActiveIncidents: [RUNNER_UP] }),
    );
    expect(out).toContain("Other active incidents assigned to you");
    expect(out).toContain("assigned to you and");
  });

  test("the runner-up disclosure keeps its anchor under BOTH selection modes", () => {
    // The anchor sits on the half that is true either way, so the I31 guard cannot start
    // depending on which branch rendered.
    for (const selection of ["auto_assigned", "auto_service"] as const) {
      const out = renderOncall(brief({ selection, otherActiveIncidents: [RUNNER_UP] }));
      expect(out).toContain("covers the most recently opened one");
    }
  });

  test("a SATURATED prior-incident count renders as a floor, not an exact total", () => {
    // `buildOncallBrief` over-fetches by exactly one past the display cap, so a service with forty
    // earlier incidents reports eleven. Recurrence is the one thing this lane exists to convey, so
    // printing the saturated value as though it were exact understates it by 29.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `pagerduty:inc-${String(i)}`,
      title: `Earlier ${String(i)}`,
      url: null,
      openedAtMs: NOW - (i + 3) * DAY,
      resolvedAtMs: null,
      resolvedByEmail: null,
    }));
    const out = renderOncall(
      brief({ priorIncidents: rows, counts: { messages: 0, priorIncidents: 11 } }),
    );
    expect(out).toContain("At least 11 earlier incidents on this service");
    expect(out).toContain("more than this brief counted");
  });

  test("an UNSATURATED count still renders as the exact total it is", () => {
    // The floor wording must not leak into the ordinary case, or every brief would hedge a number
    // it actually knows.
    const rows = [
      {
        id: "pagerduty:inc-0",
        title: "Earlier",
        url: null,
        openedAtMs: NOW - 10 * DAY,
        resolvedAtMs: null,
        resolvedByEmail: null,
      },
    ];
    const out = renderOncall(
      brief({ priorIncidents: rows, counts: { messages: 0, priorIncidents: 1 } }),
    );
    expect(out).toContain("1 earlier incident on this service");
    expect(out).not.toContain("At least");
  });
});

describe("renderOncall: the on-call line (MB3)", () => {
  const shift = (over: Record<string, unknown> = {}) => ({
    userName: "Alice Ng",
    scheduleName: "Payments primary",
    policyName: "Payments policy",
    level: 1,
    endMs: NOW + 3_600_000,
    isMe: false,
    source: "pagerduty" as const,
    ...over,
  });
  const src = (over: Record<string, unknown> = {}) => ({
    source: "pagerduty" as const,
    oldestFetchedMs: NOW - 3 * 60_000,
    stale: false,
    ...over,
  });
  const now = (over: Record<string, unknown> = {}) => ({
    status: "ok" as const,
    asOfMs: NOW,
    shifts: [shift()],
    next: [],
    sources: [src()],
    ...over,
  });
  const line = (out: string): string =>
    out.split("\n").find((l) => l.startsWith("- **On call now:**")) ?? "";

  test("a current shift renders with its schedule, level, end and data age", () => {
    const out = line(renderOncall(brief({ onCallNow: now() })));
    expect(out).toContain("Alice Ng (Payments primary, level 1, until ");
    expect(out).toContain("(PagerDuty data 3 min old)");
  });

  test("two shifts are both listed in order, and the owner is marked", () => {
    const out = line(
      renderOncall(
        brief({
          onCallNow: now({ shifts: [shift(), shift({ userName: "Bob", level: 2, isMe: true })] }),
        }),
      ),
    );
    expect(out.indexOf("Alice Ng")).toBeLessThan(out.indexOf("Bob"));
    expect(out).toContain("Bob (Payments primary, level 2, until ");
    expect(out).toContain("(you)");
  });

  test("a JSM shift has no time, and a stale or unknown-age source says the shift may have changed", () => {
    const jsm = line(
      renderOncall(
        brief({
          onCallNow: now({
            shifts: [
              shift({
                source: "jsm",
                endMs: null,
                level: null,
                scheduleName: null,
                policyName: null,
              }),
            ],
            sources: [src({ source: "jsm", oldestFetchedMs: NOW - 3 * 3_600_000, stale: true })],
          }),
        }),
      ),
    );
    expect(jsm).toContain(
      "Alice Ng (Jira Service Management data 3 h old; the shift may have changed)",
    );
    const unknown = line(
      renderOncall(
        brief({ onCallNow: now({ sources: [src({ oldestFetchedMs: null, stale: true })] }) }),
      ),
    );
    expect(unknown).toContain("age unknown; the shift may have changed");
    const noSources = line(renderOncall(brief({ onCallNow: now({ sources: [] }) })));
    expect(noSources.endsWith(")")).toBe(true);
    expect(noSources).not.toContain("data");
  });

  test("none_on_call, no_data, no_match and no service id are each explicit", () => {
    const none = line(
      renderOncall(
        brief({
          onCallNow: now({
            status: "none_on_call",
            shifts: [],
            next: [shift({ userName: "Bob" })],
          }),
        }),
      ),
    );
    expect(none).toContain("_nobody on call per the index (next: Bob (Payments primary");
    expect(
      line(renderOncall(brief({ onCallNow: now({ status: "none_on_call", shifts: [] }) }))),
    ).toBe("- **On call now:** _nobody on call per the index_");
    expect(
      line(renderOncall(brief({ onCallNow: now({ status: "no_data", shifts: [] }) }))),
    ).toContain("_no on-call data indexed_");
    expect(
      line(renderOncall(brief({ onCallNow: now({ status: "no_match", shifts: [] }) }))),
    ).toContain("_no indexed schedule covers this service_");
    expect(line(renderOncall(brief({ onCallNow: null })))).toContain("_unknown (no service id)_");
  });

  test("provider-supplied names cannot start a heading", () => {
    const out = renderOncall(
      brief({
        onCallNow: now({
          shifts: [shift({ userName: "Eve\n## Fake heading\n`x", scheduleName: "S\r\n# H" })],
        }),
      }),
    );
    expect(
      out.split("\n").some((l) => l.startsWith("## Fake heading") || l.startsWith("# H")),
    ).toBe(false);
    expect(line(out)).toContain("Eve## Fake heading`x");
  });
});
