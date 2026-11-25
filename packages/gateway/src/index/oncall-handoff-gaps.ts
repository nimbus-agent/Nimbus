import type { OncallSource } from "./oncall-shift-types.ts";

/**
 * The trailing gaps of the on-call handoff brief (moved out of `oncall-handoff-query.ts` unchanged):
 * every section that cannot be answered says so, and none of these is "nothing happened".
 */

/** `YYYY-MM-DD HH:MM UTC`. */
export function fmtUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What the gaps are decided from: counts and facts the query has already read. */
export interface HandoffGapFacts {
  readonly trackedCount: number;
  readonly historyStartsMs: number | null;
  readonly window: { readonly fromMs: number };
  readonly hasShiftRows: boolean;
  readonly mine: readonly { readonly source: OncallSource; readonly startMs: number | null }[];
  readonly anyDeployments: boolean;
  readonly bindingCount: number;
  readonly snapshotRows: number;
  readonly atNow: boolean;
  readonly unknownOpen: number;
  readonly serviceFiltered: boolean;
  /** The full lengths of the events, still-open and deployment lists, in that order. */
  readonly listLengths: readonly [number, number, number];
  /** The per-list cap the brief shows (`HANDOFF_LIST_CAP`). */
  readonly listCap: number;
}

type Gap = { code: string; detail: string };

/** In order: the incident and history substrate and the shifts, then the other sections and the caps. */
export function handoffGaps(f: HandoffGapFacts): Gap[] {
  return [...substrateGaps(f), ...sectionGaps(f)];
}

function substrateGaps(f: HandoffGapFacts): Gap[] {
  const gaps: Gap[] = [];
  if (f.trackedCount === 0) {
    gaps.push({
      code: "no_incident_data",
      detail:
        "No PagerDuty incidents and no Jira Service Management alerts are indexed, so the event, still-open and watch-list sections are empty because nothing can be read, not because nothing happened. Connect PagerDuty or Jira Service Management (`nimbus connector auth pagerduty` / `nimbus connector auth jira`) and let a sync run.",
    });
  }
  if (f.historyStartsMs === null) {
    gaps.push({
      code: "no_history",
      detail:
        "No state-change history is recorded yet (it begins when the index was upgraded to schema V94), so acknowledgements, severity changes and reopenings cannot be listed. Opens and resolutions are read from the provider's own times where the row carries them.",
    });
  } else if (f.historyStartsMs > f.window.fromMs) {
    gaps.push({
      code: "history_begins_after_window_start",
      detail: `State-change history begins at ${fmtUtc(f.historyStartsMs)}, after the window starts (${fmtUtc(f.window.fromMs)}); changes before it are not recorded.`,
    });
  }
  gaps.push(
    {
      code: "observation_time",
      detail:
        "A state change without a provider time is placed at the moment the sync saw it, which can be later than when it happened (marked observed).",
    },
    {
      code: "sources_covered",
      detail:
        "Only PagerDuty incidents and Jira Service Management Operations alerts are read; other alerting systems (OpsGenie, Sentry, monitoring tools) are not part of this brief, so their silence is not evidence that nothing fired.",
    },
  );
  if (!f.hasShiftRows) {
    gaps.push({
      code: "no_shift_data",
      detail: "No on-call shifts are indexed, so the brief cannot say who was or is on call.",
    });
  } else if (f.mine.length === 0) {
    gaps.push({
      code: "no_own_shift",
      detail:
        "No indexed shift is marked as yours (PagerDuty marks one only with a user-level token or the PagerDuty from-email setting), so the default window could not follow your shift.",
    });
  }
  gaps.push({
    code: "ended_shifts_not_indexed",
    detail:
      "The index holds current and upcoming shifts only. A shift that has already ended cannot be found, so run this before your shift ends or pass --since.",
  });
  if (f.mine.some((s) => s.source === "jsm" && s.startMs === null)) {
    gaps.push({
      code: "jsm_shift_untimed",
      detail:
        "Jira Service Management shifts carry no start or end time, so they cannot set the window.",
    });
  }
  return gaps;
}

function sectionGaps(f: HandoffGapFacts): Gap[] {
  const gaps: Gap[] = [];
  if (!f.anyDeployments) {
    gaps.push({
      code: "no_deployments_indexed",
      detail:
        "No deployments are indexed, so the deployment list and the deploy-versus-incident check are empty because nothing can be read, not because nothing shipped.",
    });
  } else if (f.bindingCount === 0) {
    gaps.push({
      code: "no_service_bindings",
      detail:
        "No `[ci.service.<id>]` or `[metrics.dora.<id>]` bindings are configured, so deployments cannot be matched to incidents and the deploy-versus-incident check is empty for that reason.",
    });
  }
  if (f.snapshotRows === 0) {
    gaps.push({
      code: "work_snapshot_empty",
      detail:
        "No snapshot of your assigned Jira, Linear or GitHub work exists (it is refreshed by those connectors' syncs), so the due-soon list is empty because nothing can be read, not because nothing is due.",
    });
  } else if (!f.atNow) {
    gaps.push({
      code: "work_snapshot_current",
      detail:
        "The due-soon list reads your work as it is now, not as it stood at the end of the window.",
    });
  }
  if (f.unknownOpen > 0) {
    gaps.push({
      code: "end_state_unknown",
      detail: `${String(f.unknownOpen)} resolved or closed item(s) carry no resolution time, so whether they were still open at the end of the window cannot be told; they are not listed as open.`,
    });
  }
  if (!f.atNow && !f.serviceFiltered) {
    gaps.push({
      code: "window_ends_in_past",
      detail:
        "The window ends before now: items are placed by their own open and resolution times, and an item whose state changed after the window but carries no provider time may be misplaced.",
    });
  }
  const hidden =
    Math.max(0, f.listLengths[0] - f.listCap) +
    Math.max(0, f.listLengths[1] - f.listCap) +
    Math.max(0, f.listLengths[2] - f.listCap);
  if (hidden > 0) {
    gaps.push({
      code: "lists_capped",
      detail: `Each list shows at most ${String(f.listCap)} entries; ${String(hidden)} more exist. Totals count them.`,
    });
  }

  return gaps;
}
