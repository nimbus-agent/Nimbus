import type { ActionEventKind } from "./action-links.ts";
import type { IncidentRecordV1, TimeValue } from "./incident-record-types.ts";
import { codeUnitCompare, oneLine } from "./lanes/caps.ts";
import { redactHistoryValue } from "./lanes/history.ts";

/**
 * The timeline of one incident record (Phase 10 IC4, spec § 5.4). A PURE function of three inputs: the record
 * JSON of one version, the trigger's `item_history` rows and the linked audit rows. It reads nothing, calls
 * nothing and has no clock, so two calls with the same inputs return the same events in the same order.
 *
 * Every event says which clock it comes from: `source` (the provider's own time) or `observed` (the sync's, or
 * the audit row's). A commit has no authored time in the record, so it is detail on the deployment event, not its
 * own line (a stated bound). Text is `oneLine`-clean and goes through `hardenedPlain` when rendered; it is never
 * Markdown. History address keys are reduced to a count or a presence flag (`redactHistoryValue`).
 */

export type TimelineEventKind =
  | "opened"
  | "record_opened"
  | "state_change"
  | "deployment"
  | "deployment_finished"
  | "pr_merged"
  | "ci_run"
  | "chat_first"
  | "chat_last"
  | ActionEventKind
  | "closed";

export type TimelineEvent = {
  readonly atMs: number;
  readonly atBasis: "source" | "observed";
  readonly kind: TimelineEventKind;
  readonly source: string;
  readonly itemId: string | null;
  readonly text: string;
  /** The rule that tied the event to the record (`last_deployment_before_open`, `concurrent_30m`, ...), or null. */
  readonly rule: string | null;
};

export type TimelineHistoryInput = {
  readonly key: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly observedAtMs: number;
  readonly sourceAtMs: number | null;
};

export type TimelineActionInput = {
  readonly auditId: number;
  readonly timestamp: number;
  readonly actionType: string;
  readonly kind: ActionEventKind;
  readonly answerSource: string | undefined;
  readonly linkVersion: number;
  readonly subSteps: number;
};

export type Timeline = {
  readonly events: readonly TimelineEvent[];
  /** What the reader must know about how complete the events are (each at most once). */
  readonly notes: readonly string[];
};

export type TimelineInput = {
  readonly record: IncidentRecordV1;
  readonly history: readonly TimelineHistoryInput[];
  /** True when more history rows exist than were read. */
  readonly historyTruncated: boolean;
  readonly actions: readonly TimelineActionInput[];
  /** True when the audit scan hit its cap, so later linked actions are missing. */
  readonly actionsTruncated: boolean;
};

/** Rank at an equal time: the order a reader expects a story to read in. */
const RANK: Readonly<Record<TimelineEventKind, number>> = Object.freeze({
  opened: 0,
  record_opened: 1,
  state_change: 2,
  deployment: 3,
  deployment_finished: 4,
  pr_merged: 5,
  ci_run: 6,
  chat_first: 7,
  chat_last: 8,
  action_approved: 9,
  action_denied: 10,
  action_undone: 11,
  closed: 12,
});

const basisOf = (t: TimeValue): "source" | "observed" =>
  t.basis === "provider" ? "source" : "observed";

const MAX_TEXT = 200;

function ev(
  atMs: number,
  atBasis: TimelineEvent["atBasis"],
  kind: TimelineEventKind,
  source: string,
  itemId: string | null,
  text: string,
  rule: string | null = null,
): TimelineEvent {
  return { atMs, atBasis, kind, source, itemId, text: oneLine(text, MAX_TEXT), rule };
}

function triggerEvents(r: IncidentRecordV1): TimelineEvent[] {
  const t = r.trigger;
  const out: TimelineEvent[] = [];
  if (t.opened.ms !== null) {
    out.push(
      ev(t.opened.ms, basisOf(t.opened), "opened", t.service, t.itemId, `Opened: ${t.title}`),
    );
  } else if (t.firstObservedMs !== null) {
    out.push(
      ev(
        t.firstObservedMs,
        "observed",
        "opened",
        t.service,
        t.itemId,
        `First observed by Nimbus (the source gave no open time): ${t.title}`,
      ),
    );
  }
  if (t.status === "closed" && t.closed.ms !== null) {
    out.push(
      ev(t.closed.ms, basisOf(t.closed), "closed", t.service, t.itemId, `Closed: ${t.title}`),
    );
  }
  return out;
}

function changeEvents(r: IncidentRecordV1): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const d = r.change.deployment;
  if (d !== null) {
    const commit = d.sha.slice(0, 7);
    out.push(
      ev(
        d.startedAtMs,
        "source",
        "deployment",
        d.provider,
        d.id,
        `Deployment started: ${d.title} (${d.environment}, commit ${commit}, ref ${d.ref}, ${d.conclusion})`,
        d.rule,
      ),
    );
    if (d.finishedAtMs !== null) {
      out.push(
        ev(
          d.finishedAtMs,
          "source",
          "deployment_finished",
          d.provider,
          d.id,
          `Deployment finished: ${d.title} (${d.conclusion})`,
          d.rule,
        ),
      );
    }
  }
  const pr = r.change.pr;
  if (pr !== null && pr.mergedAtMs !== null) {
    out.push(
      ev(
        pr.mergedAtMs,
        "source",
        "pr_merged",
        pr.service,
        pr.id,
        `Pull request merged: ${pr.title}`,
        pr.rule,
      ),
    );
  }
  const ci = r.change.ci;
  if (ci !== null) {
    const verdict = ci.conclusion === null ? "no conclusion recorded" : ci.conclusion;
    out.push(
      ev(
        ci.atMs,
        "source",
        "ci_run",
        ci.service,
        ci.id,
        `CI run: ${ci.title} (${verdict})`,
        ci.rule,
      ),
    );
  }
  return out;
}

function chatEvents(r: IncidentRecordV1): TimelineEvent[] {
  const msgs = [...r.chat.messages].sort((a, b) => a.atMs - b.atMs || codeUnitCompare(a.id, b.id));
  const first = msgs[0];
  const last = msgs.at(-1);
  if (first === undefined || last === undefined) return [];
  const more =
    r.chat.total > msgs.length
      ? ` (of the ${String(msgs.length)} shown; ${String(r.chat.total)} matched)`
      : "";
  const out = [
    ev(
      first.atMs,
      "source",
      "chat_first",
      first.service,
      first.id,
      `First chat mention${more}: ${first.title}`,
      first.rule,
    ),
  ];
  if (last !== first) {
    out.push(
      ev(
        last.atMs,
        "source",
        "chat_last",
        last.service,
        last.id,
        `Latest chat mention${more}: ${last.title}`,
        last.rule,
      ),
    );
  }
  return out;
}

function otherRecordEvents(r: IncidentRecordV1): TimelineEvent[] {
  return r.concurrent.records.map((c) =>
    ev(
      c.openedAtMs,
      "source",
      "record_opened",
      c.source,
      c.triggerItemId,
      `Another record opened: ${c.source}${c.severity === null ? "" : ` ${c.severity}`}${c.service === null ? "" : ` on ${c.service}`} (${c.recordId})`,
      c.rule,
    ),
  );
}

function historyEvents(
  r: IncidentRecordV1,
  rows: readonly TimelineHistoryInput[],
): TimelineEvent[] {
  const t = r.trigger;
  return rows
    .filter((h) => !h.key.startsWith("__"))
    .map((h) => {
      const from = redactHistoryValue(h.key, h.oldValue);
      const to = redactHistoryValue(h.key, h.newValue);
      const hasSource = h.sourceAtMs !== null;
      return ev(
        h.sourceAtMs ?? h.observedAtMs,
        hasSource ? "source" : "observed",
        "state_change",
        t.service,
        t.itemId,
        `${h.key}: ${from === null ? "(none)" : from} -> ${to === null ? "(none)" : to}`,
      );
    });
}

function actionEvents(rows: readonly TimelineActionInput[]): TimelineEvent[] {
  return rows.map((a) => {
    const how = a.answerSource === undefined ? "" : `, answered by ${a.answerSource}`;
    const reads =
      a.subSteps === 0 ? "" : `, ${String(a.subSteps)} read${a.subSteps === 1 ? "" : "s"}`;
    const verdict =
      a.kind === "action_denied" ? "denied" : a.kind === "action_undone" ? "undone" : "approved";
    return ev(
      a.timestamp,
      "observed",
      a.kind,
      "nimbus",
      `audit:${String(a.auditId)}`,
      `Nimbus action ${a.actionType} ${verdict}${how}${reads} (record version ${String(a.linkVersion)})`,
    );
  });
}

function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  const rank = RANK[a.kind] - RANK[b.kind];
  if (rank !== 0) return rank;
  const byItem = codeUnitCompare(a.itemId ?? "", b.itemId ?? "");
  return byItem !== 0 ? byItem : codeUnitCompare(a.text, b.text);
}

function notesOf(input: TimelineInput): string[] {
  const r = input.record;
  const notes: string[] = [];
  const opened = r.trigger.opened.ms;
  const starts = r.history.startsMs;
  if (opened !== null && starts !== null && opened < starts) {
    notes.push(
      "State changes before this service's history began were not recorded; the first observed state stands in for earlier ones.",
    );
  }
  if (input.historyTruncated) {
    notes.push("More state changes exist than are shown; the oldest 200 were read.");
  }
  if (input.actionsTruncated) {
    notes.push("More linked actions exist than were read; the first 5,000 audit rows are shown.");
  }
  return notes;
}

export function buildTimeline(input: TimelineInput): Timeline {
  const r = input.record;
  const events = [
    ...triggerEvents(r),
    ...otherRecordEvents(r),
    ...historyEvents(r, input.history),
    ...changeEvents(r),
    ...chatEvents(r),
    ...actionEvents(input.actions),
  ].sort(compareEvents);
  return { events, notes: notesOf(input) };
}
