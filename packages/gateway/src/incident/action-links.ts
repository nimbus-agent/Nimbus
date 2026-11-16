import type { Database } from "bun:sqlite";

import { INCIDENT_LINK_ID_RE } from "../engine/incident-link.ts";

/**
 * Reading the incident links of audit rows (Phase 10 IC4, spec § 5.4). The executor writes `{"incident":
 * {"id","version"}` as the FIRST key of an audit row of an incident-linked action (`engine/executor.ts`
 * `auditPayload`), then, for a prompted action, `promptSha256`, `prompt` and `promptCut`. This module finds
 * those rows and parses them from their PREFIX only, never a `JSON.parse` of the whole row (a row cut by the
 * 4,096-character cap is not JSON), the discipline `audit/agent-door-proof.ts` uses for the agent door.
 *
 * Why an anchor and not a search: an action's own payload can hold any text, including text that looks like a
 * link. The scan compares the first 40 characters of `action_json` with a bound exact prefix (`substr(...) =
 * ?`, never `LIKE`: `_` is a wildcard there and it folds ASCII case), and the parser anchors the same prefix
 * at offset 0, so a link spelled inside an input is never read as one.
 *
 * Stated bound: the scan is a full pass over `audit_log` (no index on the link) with a cap of
 * {@link LINK_SCAN_CAP} rows and `truncated` reported. If a measured scan breaks its budget, the expression
 * index belongs in IC5's migration. Reads only; nothing here writes, dispatches or imports `egress/` (D46(a)).
 */

export const LINK_SCAN_CAP = 5_000;

/** `{"incident":{"id":"` is 19 characters, the id 20, the closing quote 1. */
const PREFIX_LEN = 40;

const STR = String.raw`(?:[^"\\]|\\.)*`;
const LINK_HEAD = String.raw`^\{"incident":\{"id":"(inc_[0-9a-f]{16})","version":(\d{1,7})\}`;
const PROMPT_PART = String.raw`(?:,"promptSha256":"([0-9a-f]{64})","prompt":"(${STR})")?`;
const CUT_PART = String.raw`(,"promptCut":true)?`;
const ROW_RE = new RegExp(`${LINK_HEAD}${PROMPT_PART}${CUT_PART}`);
/** A prompt string that was itself cut by the row cap (no closing quote). */
const OPEN_PROMPT_RE = new RegExp(
  `${LINK_HEAD},"promptSha256":"([0-9a-f]{64})","prompt":"(${STR})$`,
);

const TRUNCATED_MARK = "…[truncated]";

export type ParsedLink = {
  readonly id: string;
  readonly version: number;
  readonly prompt:
    | {
        readonly sha256: string;
        /** The stored text (credential-redacted, cut to 1,600 escaped characters at most). */
        readonly text: string;
        /** True when the executor cut the text, or the row cap cut it, or it did not decode. */
        readonly cut: boolean;
      }
    | undefined;
};

function decodeJsonString(body: string): string | undefined {
  try {
    const v: unknown = JSON.parse(`"${body}"`);
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The link (and the prompt record, when present) a row's FIRST characters name, or `undefined` when the row
 * does not start with a well-formed link. Anchored at offset 0 and tolerant of a row cut by the audit cap.
 */
export function parseLinkPrefix(actionJson: string): ParsedLink | undefined {
  const m = ROW_RE.exec(actionJson);
  // A prompt string the row cap cut has no closing quote, so the optional prompt group did not match.
  if (m === null || (m[3] === undefined && actionJson.startsWith(',"promptSha256"', m[0].length))) {
    const open = OPEN_PROMPT_RE.exec(actionJson);
    if (open === null) return undefined;
    const version = Number(open[2]);
    if (!Number.isInteger(version) || version < 1 || version > 1_000_000) return undefined;
    const body = (open[4] ?? "").replace(TRUNCATED_MARK, "");
    return {
      id: open[1] ?? "",
      version,
      prompt: { sha256: open[3] ?? "", text: decodeJsonString(body) ?? "", cut: true },
    };
  }
  const id = m[1] ?? "";
  const version = Number(m[2]);
  if (!INCIDENT_LINK_ID_RE.test(id) || !Number.isInteger(version)) return undefined;
  if (version < 1 || version > 1_000_000) return undefined;
  if (m[3] === undefined) return { id, version, prompt: undefined };
  const text = decodeJsonString(m[4] ?? "");
  return {
    id,
    version,
    prompt: { sha256: m[3], text: text ?? "", cut: m[5] !== undefined || text === undefined },
  };
}

export type StepRole = "gate" | "sub_step";

export type LinkedActionRow = {
  readonly auditId: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly timestamp: number;
  readonly rowHash: string;
  readonly link: { readonly id: string; readonly version: number };
  readonly prompt: ParsedLink["prompt"];
  /** True when the audit row cap cut the row, so `answerSource` and `confirm` may be unknown. */
  readonly rowTruncated: boolean;
  readonly answerSource: string | undefined;
  readonly confirm: string | undefined;
  readonly role: StepRole;
};

/** A before-state read, a prepare read or a change-set discard: a step the executor ran FOR an action. */
export function isSubStepType(actionType: string): boolean {
  return (
    actionType.endsWith(".before.read") ||
    actionType.endsWith(".write.prepare") ||
    actionType === "iac.cloudformation.changeset.discard"
  );
}

function tailFields(
  actionJson: string,
  truncated: boolean,
): { answerSource: string | undefined; confirm: string | undefined } {
  // The decision fields follow the action object; only a row the cap did NOT cut can be read as JSON.
  if (truncated) return { answerSource: undefined, confirm: undefined };
  try {
    const v = JSON.parse(actionJson) as Record<string, unknown>;
    const pick = (k: string): string | undefined =>
      typeof v[k] === "string" ? (v[k] as string) : undefined;
    return { answerSource: pick("answerSource"), confirm: pick("confirm") };
  } catch {
    return { answerSource: undefined, confirm: undefined };
  }
}

type AuditRowRead = {
  id: number;
  action_type: string;
  hitl_status: string;
  action_json: string;
  timestamp: number;
  row_hash: string;
};

/** The exact 40-character prefix of a row linked to `recordId`, or `undefined` when the id is malformed. */
export function linkPrefixFor(recordId: string): string | undefined {
  if (!INCIDENT_LINK_ID_RE.test(recordId)) return undefined;
  const p = `{"incident":{"id":"${recordId}"`;
  return p.length === PREFIX_LEN ? p : undefined;
}

export type LinkedActions = {
  readonly rows: readonly LinkedActionRow[];
  /** True when more than {@link LINK_SCAN_CAP} rows matched, so the list is its first rows by id. */
  readonly truncated: boolean;
};

/**
 * Every audit row whose first 40 characters are this record's link prefix, in id order, parsed. The id is
 * validated against the record id shape and BOUND, never concatenated (I9).
 */
export function readLinkedActions(db: Database, recordId: string): LinkedActions {
  const prefix = linkPrefixFor(recordId);
  if (prefix === undefined) return { rows: [], truncated: false };
  const read = db
    .query(
      `SELECT id, action_type, hitl_status, action_json, timestamp, row_hash
         FROM audit_log WHERE substr(action_json, 1, ${String(PREFIX_LEN)}) = ?
        ORDER BY id ASC LIMIT ?`,
    )
    .all(prefix, LINK_SCAN_CAP + 1) as AuditRowRead[];
  const truncated = read.length > LINK_SCAN_CAP;
  const rows: LinkedActionRow[] = [];
  for (const r of read.slice(0, LINK_SCAN_CAP)) {
    const parsed = parseLinkPrefix(r.action_json);
    if (parsed === undefined || parsed.id !== recordId) continue;
    const rowTruncated = r.action_json.endsWith(TRUNCATED_MARK);
    const tail = tailFields(r.action_json, rowTruncated);
    rows.push({
      auditId: r.id,
      actionType: r.action_type,
      hitlStatus: r.hitl_status,
      timestamp: r.timestamp,
      rowHash: r.row_hash,
      link: { id: parsed.id, version: parsed.version },
      prompt: parsed.prompt,
      rowTruncated,
      answerSource: tail.answerSource,
      confirm: tail.confirm,
      role: isSubStepType(r.action_type) ? "sub_step" : "gate",
    });
  }
  return { rows, truncated };
}

/** What a linked row says happened, for the timeline. The executed, failed and proposed kinds arrive with IC5. */
export type ActionEventKind = "action_approved" | "action_denied" | "action_undone";

export function eventKindOf(
  row: Pick<LinkedActionRow, "actionType" | "hitlStatus">,
): ActionEventKind {
  if (row.actionType.endsWith(".undo")) return "action_undone";
  return row.hitlStatus === "rejected" ? "action_denied" : "action_approved";
}

export type ActionStep = {
  /** The gate row of the action: the one with the prompt, the verdict and the answer source. */
  readonly gate: LinkedActionRow;
  /** The reads the executor ran for it, in id order. */
  readonly subSteps: readonly LinkedActionRow[];
};

/**
 * Group rows into steps. A before-state read and a prepare read are recorded BEFORE the action's own gate row
 * (the gate records after its phases), a change-set discard AFTER it, so a run of sub-step rows attaches to the
 * gate row that follows it, and a discard to the one before. A sub-step row with no gate row on either side
 * (the gate threw before its row) is returned alone, as its own step with `gate` set to that row.
 */
export function groupSteps(rows: readonly LinkedActionRow[]): ActionStep[] {
  const steps: { gate: LinkedActionRow; subSteps: LinkedActionRow[] }[] = [];
  let pending: LinkedActionRow[] = [];
  for (const r of rows) {
    if (r.role === "sub_step") {
      if (r.actionType === "iac.cloudformation.changeset.discard" && steps.length > 0) {
        steps[steps.length - 1]?.subSteps.push(r);
      } else {
        pending.push(r);
      }
      continue;
    }
    steps.push({ gate: r, subSteps: pending });
    pending = [];
  }
  for (const r of pending) steps.push({ gate: r, subSteps: [] });
  return steps;
}
