// packages/gateway/src/connectors/connector-writes/agent-door-definition.ts
// The agent door's definition check (Phase 28 AD3a-2a, D-3): compares one owner-approved tool with a
// live listing and is the ONE place a mismatch is marked (sticky) and audited. `status`, the submit
// path, the approval path and the consent-side veto all call it, so a suspension is recorded once,
// by the first observer, with one `connector.writes.agent.suspend` audit row written in the same
// transaction as the mark.
//
// Five outcomes for an approved, not-yet-suspended tool:
//   - `ok`         the listed definition hashes to the approved value;
//   - `changed`    it hashes to something else: marked suspended;
//   - `unreadable` it is listed but cannot be hashed (schema unreadable, or a present description
//                  that is not a string): marked suspended with a NULL observed hash;
//   - `missing`    the listing omits it (OR-AD-14): NOT marked and NOT audited. A tool can leave a
//                  listing with no change of definition (an Outlook connection without
//                  `Mail.ReadWrite` never lists the draft tool), so absence is a state, not a change;
//   - `drifted`    the hash matches but the schema no longer declares a key the row's typed preview
//                  names (needs the row): refused, NOT marked, as the model door withholds it.
//
// This module never names the approval table (static D49(b)): it goes through the store.
import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import { constantTimeStringEqual } from "../../util/timing-safe-compare.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { definitionSha256 } from "./definition-hash.ts";
import {
  type DoorApproval,
  getDoorApproval,
  markDoorToolSuspended,
} from "./door-approval-store.ts";
import { listedEntryDeclaresPreviewKeys } from "./listed-support.ts";
import type { ConnectorWriteRow } from "./types.ts";

/** One suspended tool as `connector.writesStatus` reports it. */
export interface DoorSuspension {
  readonly toolId: string;
  readonly approvedAt: number;
  readonly approvedSha12: string;
  /** The hash observed when the listing first disagreed; `null` when there was none to hash. */
  readonly nowSha12: string | null;
  readonly reason?: string;
}

export const UNREADABLE_NOW_REASON = "its input schema can no longer be read";
export const STORED_GONE_REASON = "no longer listed, or its input schema cannot be read";

export function sha12(sha: string): string {
  return sha.slice(0, 12);
}

/** The report for an approval that is already suspended, from its stored columns. */
export function suspensionFromRow(a: DoorApproval): DoorSuspension {
  return {
    toolId: a.toolId,
    approvedAt: a.approvedAt,
    approvedSha12: sha12(a.definitionSha256),
    nowSha12: a.suspendedSha256 === null ? null : sha12(a.suspendedSha256),
    ...(a.suspendedSha256 === null ? { reason: STORED_GONE_REASON } : {}),
  };
}

/** What the check needs besides the approval and the listing. */
export interface DefinitionCheckDeps {
  readonly db: Database;
  readonly now: () => number;
}

/**
 * Mark the approval the listing was compared against, and write its one audit row, in ONE
 * transaction: either both commit or neither does (a failed append leaves the tool unmarked, so a
 * later observer sees it again). The first observation wins: a repeat marks nothing and writes no
 * second row. `undefined` when the approval changed underneath (re-approved with another hash or
 * removed), which is not a suspension.
 */
export function recordDoorSuspension(
  deps: DefinitionCheckDeps,
  a: DoorApproval,
  seen: { readonly sha: string | null; readonly reason?: string },
): DoorSuspension | undefined {
  const now = deps.now();
  const entry: DoorSuspension = {
    toolId: a.toolId,
    approvedAt: a.approvedAt,
    approvedSha12: sha12(a.definitionSha256),
    nowSha12: seen.sha === null ? null : sha12(seen.sha),
    ...(seen.reason === undefined ? {} : { reason: seen.reason }),
  };
  const marked = deps.db.transaction(() => {
    if (
      !markDoorToolSuspended(
        deps.db,
        "agent",
        a.service,
        a.toolId,
        a.definitionSha256,
        seen.sha,
        now,
      )
    ) {
      return false;
    }
    appendAuditEntry(deps.db, {
      actionType: "connector.writes.agent.suspend",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        service: a.service,
        toolId: a.toolId,
        approvedSha12: entry.approvedSha12,
        nowSha12: entry.nowSha12,
      }),
      timestamp: now,
    });
    return true;
  })();
  if (marked) return entry;
  // Not marked by this call: another observer suspended the same approval (report it from the stored
  // columns), or the owner re-approved or removed it since the snapshot (nothing to report).
  const current = getDoorApproval(deps.db, "agent", a.service, a.toolId);
  return current !== undefined &&
    current.suspendedAt !== null &&
    constantTimeStringEqual(current.definitionSha256, a.definitionSha256)
    ? suspensionFromRow(current)
    : undefined;
}

export type DefinitionCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "missing" }
  | { readonly kind: "drifted" }
  | { readonly kind: "changed"; readonly suspension: DoorSuspension | undefined }
  | { readonly kind: "unreadable"; readonly suspension: DoorSuspension | undefined };

/**
 * Compare one approved, not-yet-suspended tool with `listed` (its service's raw listing). Pass `row`
 * to also run the drift check (the submit and approval paths do; `status` has no use for it).
 */
export function checkAgentToolDefinition(
  deps: DefinitionCheckDeps,
  approval: DoorApproval,
  listed: Readonly<Record<string, unknown>>,
  row?: ConnectorWriteRow,
): DefinitionCheck {
  const key = mcpClientToolKey(approval.service, approval.toolId);
  if (!Object.hasOwn(listed, key)) return { kind: "missing" };
  const sha = definitionSha256(approval.toolId, listed[key]);
  if (sha === undefined) {
    return {
      kind: "unreadable",
      suspension: recordDoorSuspension(deps, approval, {
        sha: null,
        reason: UNREADABLE_NOW_REASON,
      }),
    };
  }
  if (!constantTimeStringEqual(sha, approval.definitionSha256)) {
    return { kind: "changed", suspension: recordDoorSuspension(deps, approval, { sha }) };
  }
  if (row !== undefined && !listedEntryDeclaresPreviewKeys(row, listed[key]))
    return { kind: "drifted" };
  return { kind: "ok" };
}
