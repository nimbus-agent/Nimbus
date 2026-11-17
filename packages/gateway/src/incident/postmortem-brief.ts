import type { Database } from "bun:sqlite";

import type { GapNote } from "../agents/_lib/findings.ts";

import type {
  IncidentPostmortemBrief,
  PostmortemAction,
  PostmortemImpact,
  PostmortemTemplate,
} from "../agents/_lib/incident-postmortem-types.ts";
import { eventKindOf, groupSteps, readLinkedActions } from "./action-links.ts";
import { IncidentError } from "./assemble.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import { getById } from "./incident-store.ts";
import { readTimeline } from "./timeline-read.ts";
import { isClosedStatusWord } from "./trigger-facts.ts";

/**
 * The inputs of a post-mortem draft (Phase 10 IC7a, spec § 5.7): one stored record, its timeline, the Nimbus
 * actions linked to it and the impact window. Index and audit READS only: no network, no clock of its own
 * (the caller passes `nowMs`), no write, no model (static D46(a), OR-10-8). The draft is for a RESOLVED
 * incident: a record whose trigger status is not `closed` is refused.
 *
 * Evidence, not conclusions (D-IC-2): nothing here ranks a cause. The cascade covers open records only, so a
 * resolved record has none; the Gaps say so rather than inventing one.
 */

export class PostmortemError extends Error {
  readonly code: "ERR_POSTMORTEM_NOT_RESOLVED";
  constructor(code: PostmortemError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "PostmortemError";
    this.code = code;
  }
}

const CASCADE_GAP: GapNote = {
  category: "missing_relation_emit",
  detail:
    "No cascade is shown: the cascade ranks open records only, and this record is resolved. Other records open near it are listed under Contributing factors.",
};
const ACTIONS_GAP: GapNote = {
  category: "missing_relation_emit",
  detail:
    "Runbook step state and remediation proposals are not available in this version, so Action items holds placeholders only.",
};
const RESULT_GAP: GapNote = {
  category: "missing_relation_emit",
  detail:
    "The audit row of a Nimbus action records the decision, not what the connector returned; the Decision log shows the decision.",
};

type StatusHistoryRow = {
  new_value: string | null;
  observed_at_ms: number;
  source_at_ms: number | null;
};

function resolvedFromHistory(
  db: Database,
  record: IncidentRecordV1,
): { ms: number; basis: "history" } | null {
  const t = record.trigger;
  const rows = db
    .query(
      `SELECT new_value, observed_at_ms, source_at_ms FROM item_history
        WHERE item_id = ? AND key IN ('status', 'state')
        ORDER BY observed_at_ms DESC, id DESC LIMIT 1`,
    )
    .all(t.itemId) as StatusHistoryRow[];
  const last = rows[0];
  if (last === undefined || !isClosedStatusWord(t.service, last.new_value)) return null;
  return { ms: last.source_at_ms ?? last.observed_at_ms, basis: "history" };
}

function impactOf(db: Database, record: IncidentRecordV1): PostmortemImpact {
  const t = record.trigger;
  const opened =
    t.opened.ms !== null
      ? {
          ms: t.opened.ms,
          basis: t.opened.basis === "provider" ? ("provider" as const) : ("observed" as const),
        }
      : t.firstObservedMs !== null
        ? { ms: t.firstObservedMs, basis: "observed" as const }
        : { ms: null, basis: "none" as const };
  let resolved: PostmortemImpact["resolvedMs"] = null;
  let resolvedBasis: PostmortemImpact["resolvedBasis"] = "none";
  if (t.closed.ms !== null) {
    resolved = t.closed.ms;
    resolvedBasis = t.closed.basis === "provider" ? "provider" : "observed";
  } else {
    const h = resolvedFromHistory(db, record);
    if (h !== null) {
      resolved = h.ms;
      resolvedBasis = h.basis;
    }
  }
  return { openedMs: opened.ms, openedBasis: opened.basis, resolvedMs: resolved, resolvedBasis };
}

function actionsOf(
  db: Database,
  recordId: string,
): {
  actions: PostmortemAction[];
  truncated: boolean;
} {
  const linked = readLinkedActions(db, recordId);
  const actions = groupSteps(linked.rows)
    // A read with no gate row after it never reached its gate: it is no decision (as the timeline does).
    .filter((s) => s.gate.role === "gate")
    .map((s): PostmortemAction => {
      const kind = eventKindOf(s.gate);
      return {
        auditId: s.gate.auditId,
        timestamp: s.gate.timestamp,
        actionType: s.gate.actionType,
        verdict:
          kind === "action_denied" ? "denied" : kind === "action_undone" ? "undone" : "approved",
        answerSource: s.gate.answerSource,
        subSteps: s.subSteps.length,
        linkVersion: s.gate.link.version,
        prompt:
          s.gate.prompt === undefined
            ? null
            : { sha256: s.gate.prompt.sha256, text: s.gate.prompt.text, cut: s.gate.prompt.cut },
      };
    });
  return { actions, truncated: linked.truncated };
}

/** Builds the brief for `recordId`. Throws {@link IncidentError} (no record) or {@link PostmortemError}. */
export function buildPostmortemBrief(
  db: Database,
  recordId: string,
  nowMs: number,
  template: PostmortemTemplate | null,
): IncidentPostmortemBrief {
  const row = getById(db, recordId);
  if (row === null) {
    throw new IncidentError("ERR_INCIDENT_NOT_FOUND", "no incident record has that id");
  }
  const record = JSON.parse(row.record_json) as IncidentRecordV1;
  if (record.trigger.status !== "closed") {
    throw new PostmortemError(
      "ERR_POSTMORTEM_NOT_RESOLVED",
      "a post-mortem is drafted for a resolved or closed incident, and this record's trigger is not closed in the index",
    );
  }
  const timeline = readTimeline(db, recordId);
  const { actions, truncated } = actionsOf(db, recordId);
  const seen = new Set<string>();
  const gaps: GapNote[] = [];
  for (const g of [...record.gaps, CASCADE_GAP, ACTIONS_GAP, RESULT_GAP]) {
    if (seen.has(g.detail)) continue;
    seen.add(g.detail);
    gaps.push(g);
  }
  return {
    kind: "incident_postmortem",
    agentVersion: 1,
    generatedAt: nowMs,
    latencyMs: 0,
    gaps,
    record,
    recordId,
    impact: impactOf(db, record),
    timeline: timeline.timeline,
    actions,
    actionsTruncated: truncated,
    template,
  };
}
