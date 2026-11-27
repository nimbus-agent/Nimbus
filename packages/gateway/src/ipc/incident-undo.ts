import type { Database } from "bun:sqlite";

import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { callIsReversible } from "../connectors/connector-writes/reversibility.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { listUndoCandidates } from "../incident/proposal-store.ts";
import { type Remediation, RemediationError, type UndoOutcome } from "../incident/remediation.ts";

/**
 * `nimbus incident undo` with no id (Phase 17 one-tap rollback, V106): the action to undo is the most recently
 * executed one whose row is declared `reversible`, not yet undone, and whose kept before-state builds an
 * inverse for that call (a no-op call, or a record that is not JSON, is skipped, never chosen and then refused). Resolving it
 * is a READ; the undo itself is the same `remediation.undo` as for a named action (advisory refusal, claim,
 * the owner's own prompt, a human answer only), so naming the action by this path widens nothing (I57 (b)).
 */

const CANDIDATE_SCAN = 50;

/** Parsed JSON, or `undefined` for null or text that is not JSON (then not undoable). */
function parsedOrUndefined(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The action id of the newest executed action that can be undone, or `undefined` when there is none. */
export function latestUndoableActionId(
  db: Database,
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): string | undefined {
  for (const p of listUndoCandidates(db, CANDIDATE_SCAN)) {
    const row = rows.find((r) => r.toolId === p.tool_id);
    const captured = parsedOrUndefined(p.captured_json);
    const reversible =
      typeof captured === "object" &&
      captured !== null &&
      callIsReversible(row, parsedOrUndefined(p.input_json), captured as Record<string, string>);
    if (reversible && p.action_id !== null) return p.action_id;
  }
  return undefined;
}

/**
 * `incident.undo`: run the undo of the action `actionId` names, or, when the caller named none, of the latest
 * undoable one. A malformed id and an empty history are refusals the owner reads, not crashes.
 */
export function undoOrLatest(
  remediation: Pick<Remediation, "undo">,
  db: Database,
  actionId: unknown,
  clientId: string,
): Promise<UndoOutcome> {
  if (
    actionId !== undefined &&
    (typeof actionId !== "string" || actionId === "" || actionId.length > 64)
  ) {
    throw new RemediationError("ERR_PROPOSAL_NOT_FOUND", "actionId must be a non-empty string");
  }
  const target = actionId ?? latestUndoableActionId(db);
  if (target === undefined) {
    throw new RemediationError(
      "ERR_UNDO_REFUSED",
      "there is no executed reversible action to undo (name one with nimbus incident undo <act_...>)",
    );
  }
  return remediation.undo({ actionId: target, clientId });
}
