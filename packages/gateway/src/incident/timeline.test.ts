import { describe, expect, test } from "bun:test";

import { renderTimeline } from "../agents/_lib/incident-render.ts";
import { buildRecord } from "./__fixtures__/record-builder.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import {
  buildTimeline,
  type TimelineActionInput,
  type TimelineEvent,
  type TimelineHistoryInput,
  type TimelineInput,
} from "./timeline.ts";

const T = Date.parse("2026-11-10T12:00:00.000Z");
const MIN = 60_000;

function rich(): IncidentRecordV1 {
  const base = buildRecord({ openedAtMs: T, boundService: "payments" });
  return {
    ...base,
    trigger: { ...base.trigger, status: "closed", closed: { ms: T + 60 * MIN, basis: "provider" } },
    change: {
      skipped: null,
      graphCorrelated: true,
      deployment: {
        id: "deployment:d1",
        title: "Deploy payments",
        url: null,
        provider: "github-actions",
        environment: "prod",
        sha: "0123456789abcdef0123456789abcdef01234567",
        ref: "main",
        startedAtMs: T - 10 * MIN,
        finishedAtMs: T - 8 * MIN,
        conclusion: "success",
        minutesBeforeOpen: 10,
        rule: "last_deployment_before_open",
      },
      pr: {
        id: "github:pr1",
        title: "Fix retries",
        url: null,
        service: "github",
        mergedAtMs: T - 12 * MIN,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        rule: "merge_commit_sha",
      },
      ci: {
        id: "github-actions:run1",
        title: "build",
        url: null,
        service: "github-actions",
        conclusion: "success",
        atMs: T - 11 * MIN,
        rule: "ci_run_external_id",
      },
    },
    chat: {
      ...base.chat,
      total: 3,
      messages: [
        {
          id: "slack:m2",
          service: "slack",
          title: "late",
          url: null,
          atMs: T + 20 * MIN,
          rule: "chat_phrase:payments",
        },
        {
          id: "slack:m1",
          service: "slack",
          title: "early",
          url: null,
          atMs: T + 2 * MIN,
          rule: "chat_phrase:payments",
        },
      ],
    },
    concurrent: {
      skipped: null,
      total: 1,
      records: [
        {
          recordId: "inc_aaaaaaaaaaaaaaaa",
          triggerItemId: "sentry:s1",
          source: "sentry",
          severity: "fatal",
          service: "web",
          openedAtMs: T + 5 * MIN,
          rule: "concurrent_30m",
        },
      ],
    },
    history: { startsMs: T - 60 * MIN, total: 1, truncated: 0, rows: [] },
  };
}

const HIST: TimelineHistoryInput[] = [
  {
    key: "status",
    oldValue: "triggered",
    newValue: "acknowledged",
    observedAtMs: T + 3 * MIN,
    sourceAtMs: T + 2 * MIN,
  },
  { key: "severity", oldValue: "p2", newValue: "p1", observedAtMs: T + 4 * MIN, sourceAtMs: null },
];
const ACTIONS: TimelineActionInput[] = [
  {
    auditId: 7,
    timestamp: T + 30 * MIN,
    actionType: "slack.message.post",
    kind: "action_approved",
    answerSource: "human",
    linkVersion: 2,
    subSteps: 1,
  },
  {
    auditId: 9,
    timestamp: T + 31 * MIN,
    actionType: "jira.issue.create",
    kind: "action_denied",
    answerSource: "human",
    linkVersion: 2,
    subSteps: 0,
  },
];

function input(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    record: rich(),
    history: HIST,
    historyTruncated: false,
    actions: ACTIONS,
    actionsTruncated: false,
    ...over,
  };
}

const of = (events: readonly TimelineEvent[], kind: TimelineEvent["kind"]): TimelineEvent[] =>
  events.filter((e) => e.kind === kind);

describe("6.1 one event per kind, with its time, basis, source and item", () => {
  const { events } = buildTimeline(input());

  test("opened and closed", () => {
    expect(of(events, "opened")[0]).toMatchObject({
      atMs: T,
      atBasis: "source",
      source: "pagerduty",
      itemId: "pagerduty:PD1",
    });
    expect(of(events, "closed")[0]).toMatchObject({ atMs: T + 60 * MIN, atBasis: "source" });
  });
  test("deployment start and finish, with the commit as detail", () => {
    expect(of(events, "deployment")[0]).toMatchObject({
      atMs: T - 10 * MIN,
      atBasis: "source",
      itemId: "deployment:d1",
      rule: "last_deployment_before_open",
    });
    expect(of(events, "deployment")[0]?.text).toContain("commit 0123456");
    expect(of(events, "deployment_finished")[0]?.atMs).toBe(T - 8 * MIN);
  });
  test("pull request merge and CI run", () => {
    expect(of(events, "pr_merged")[0]).toMatchObject({ atMs: T - 12 * MIN, itemId: "github:pr1" });
    expect(of(events, "ci_run")[0]).toMatchObject({
      atMs: T - 11 * MIN,
      itemId: "github-actions:run1",
    });
  });
  test("first and last chat mention, oldest and newest of the stored list", () => {
    expect(of(events, "chat_first")[0]).toMatchObject({ atMs: T + 2 * MIN, itemId: "slack:m1" });
    expect(of(events, "chat_last")[0]).toMatchObject({ atMs: T + 20 * MIN, itemId: "slack:m2" });
  });
  test("another record opening", () => {
    expect(of(events, "record_opened")[0]).toMatchObject({
      atMs: T + 5 * MIN,
      itemId: "sentry:s1",
      rule: "concurrent_30m",
    });
  });
  test("state changes of the trigger", () => {
    const s = of(events, "state_change");
    expect(s.map((e) => e.text)).toEqual([
      "status: triggered -> acknowledged",
      "severity: p2 -> p1",
    ]);
  });
  test("linked actions, by the audit timestamp, observed", () => {
    expect(of(events, "action_approved")[0]).toMatchObject({
      atMs: T + 30 * MIN,
      atBasis: "observed",
      source: "nimbus",
    });
    expect(of(events, "action_approved")[0]?.text).toContain(
      "answered by human, 1 read (record version 2)",
    );
    expect(of(events, "action_denied")[0]?.text).toContain("denied");
  });
  test("a single chat message gives one chat event", () => {
    const r = rich();
    const one = buildTimeline(
      input({
        record: { ...r, chat: { ...r.chat, total: 1, messages: r.chat.messages.slice(0, 1) } },
      }),
    );
    expect(of(one.events, "chat_first")).toHaveLength(1);
    expect(of(one.events, "chat_last")).toHaveLength(0);
  });
  test("an open record has no closed event; an unknown open time uses the first observation", () => {
    const base = rich();
    const open = buildTimeline(
      input({ record: { ...base, trigger: { ...base.trigger, status: "open" } } }),
    );
    expect(of(open.events, "closed")).toHaveLength(0);
    const noOpen = buildTimeline(
      input({
        record: {
          ...base,
          trigger: {
            ...base.trigger,
            opened: { ms: null, basis: "none" },
            firstObservedMs: T + MIN,
          },
        },
      }),
    );
    expect(of(noOpen.events, "opened")[0]).toMatchObject({ atMs: T + MIN, atBasis: "observed" });
    expect(of(noOpen.events, "opened")[0]?.text).toContain("no open time");
  });
});

describe("6.2 the clock of each line", () => {
  test("a history row with source_at_ms is source, one without says observed, and its time is the one shown", () => {
    const s = of(buildTimeline(input()).events, "state_change");
    expect(s[0]).toMatchObject({ atBasis: "source", atMs: T + 2 * MIN });
    expect(s[1]).toMatchObject({ atBasis: "observed", atMs: T + 4 * MIN });
    expect(renderTimeline(buildTimeline(input()))).toContain(
      "(observed) state_change: severity: p2 -> p1",
    );
  });
});

describe("6.3 the order is a function of the inputs", () => {
  test("shuffling every input array 50 times gives the same events", () => {
    const base = buildTimeline(input());
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const shuffle = <X>(a: readonly X[]): X[] => {
      const out = [...a];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j] as X, out[i] as X];
      }
      return out;
    };
    for (let i = 0; i < 50; i += 1) {
      const r = rich();
      const t = buildTimeline(
        input({
          record: { ...r, chat: { ...r.chat, messages: shuffle(r.chat.messages) } },
          history: shuffle(HIST),
          actions: shuffle(ACTIONS),
        }),
      );
      expect(t).toEqual(base);
    }
  });

  test("events at one instant come out in kind rank, then item id", () => {
    const r = rich();
    const t = buildTimeline(
      input({
        record: {
          ...r,
          change: { ...r.change, pr: null, ci: null, deployment: null },
          concurrent: {
            ...r.concurrent,
            records: [
              {
                ...(r.concurrent.records[0] as never as object),
                recordId: "inc_bbbbbbbbbbbbbbbb",
                triggerItemId: "sentry:b",
                source: "sentry",
                severity: null,
                service: null,
                openedAtMs: T,
                rule: "concurrent_30m",
              },
              {
                ...(r.concurrent.records[0] as never as object),
                recordId: "inc_aaaaaaaaaaaaaaaa",
                triggerItemId: "sentry:a",
                source: "sentry",
                severity: null,
                service: null,
                openedAtMs: T,
                rule: "concurrent_30m",
              },
            ] as never,
          },
        },
        history: [],
        actions: [],
      }),
    );
    expect(t.events.filter((e) => e.atMs === T).map((e) => e.itemId)).toEqual([
      "pagerduty:PD1",
      "sentry:a",
      "sentry:b",
    ]);
  });
});

describe("6.4 / 6.7 what the reader is told about completeness", () => {
  test("chat.total above the stored list says 'of N shown'", () => {
    const events = buildTimeline(input()).events;
    expect(of(events, "chat_first")[0]?.text).toContain("of the 2 shown; 3 matched");
  });
  test("history starting after the open time is said once; truncated reads are said", () => {
    const r = rich();
    const t = buildTimeline(
      input({
        record: { ...r, history: { ...r.history, startsMs: T + 10 * MIN } },
        historyTruncated: true,
        actionsTruncated: true,
      }),
    );
    expect(t.notes).toHaveLength(3);
    expect(t.notes[0]).toContain("before this service's history began");
    expect(buildTimeline(input()).notes).toEqual([]);
  });
});

describe("6.5 hostile text renders inert; address keys are never shown", () => {
  test("a title with ANSI, bidi, a heading and javascript: stays on one inert line", () => {
    const evil = "\u001b[31mred\u001b[0m \u202eevil\n## Gaps\n[x](javascript:alert(1))";
    const r = rich();
    const t = buildTimeline(
      input({
        record: { ...r, trigger: { ...r.trigger, title: evil, url: "javascript:alert(1)" } },
      }),
    );
    const md = renderTimeline(t);
    expect(md).not.toContain("\u001b");
    expect(md).not.toContain("\u202e");
    expect(md.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## Timeline"]);
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
  });

  test("an assignee address key is reduced to a count, never shown", () => {
    const t = buildTimeline(
      input({
        history: [
          {
            key: "assignee_emails",
            oldValue: null,
            newValue: JSON.stringify(["a@example.com", "b@example.com"]),
            observedAtMs: T,
            sourceAtMs: null,
          },
          {
            key: "resolved_by_email",
            oldValue: null,
            newValue: "boss@example.com",
            observedAtMs: T + 1,
            sourceAtMs: null,
          },
        ],
      }),
    );
    const text = renderTimeline(t);
    expect(text).toContain("2 assigned");
    expect(text).not.toContain("example.com");
  });

  test("history's own bookkeeping keys never show", () => {
    const t = buildTimeline(
      input({
        history: [
          { key: "__created", oldValue: null, newValue: "x", observedAtMs: T, sourceAtMs: null },
        ],
      }),
    );
    expect(of(t.events, "state_change")).toHaveLength(0);
  });
});
