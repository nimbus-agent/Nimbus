import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { listOpenSessions, updateSessionState } from "./cu-store.ts";

/**
 * The `close_reason` a boot-time reconciliation writes.
 *
 * Deliberately NOT `terminated_target_lost`, even though the browser target genuinely is gone.
 * That outcome is assigned by `runAction` when a LIVE session's lane dies under it, and it carries
 * an implication this case does not have: that the gate observed the loss and stopped an action
 * because of it. Nothing observed anything here — the process that held the session is not the
 * process writing this row. Recording the real reason keeps the two distinguishable in the audit
 * log, which is the only place anyone will ever ask the question.
 */
export const ORPHANED_SESSION_REASON = "orphaned_by_gateway_restart";

export interface ReconcileResult {
  readonly reconciled: number;
  readonly sessionIds: readonly string[];
}

/**
 * Close out `cu_session` rows left open by a previous gateway process, at boot.
 *
 * **The bug this closes.** `computer.sessionStatus` reads the durable `cu_session` table; the gate
 * reads its in-memory `liveSessions` map. The map does not survive a restart and the table does,
 * so after one they disagree PERMANENTLY and in the worst direction: `nimbus computer sessions`
 * shows a session as open forever, `computer.sessionClose` answers `not_found` because the gate has
 * no entry for it, and the CLI's watch loop — which exits when it sees the session close — polls
 * until the user kills it. There is no self-healing path, because nothing else ever writes
 * `closed_at` for a session no live entry backs.
 *
 * It is also a correctness claim, not only a UX one: a row reading "open" asserts that a browser is
 * running inside an approved envelope. After a restart no browser is running at all — every child
 * of the previous gateway died with it (and `openBrowserLane`'s teardown kills its own on any
 * failure path). Leaving the assertion standing would make the durable record say something untrue
 * about the machine's state.
 *
 * Idempotent by construction: it only ever selects rows with `closed_at IS NULL` and immediately
 * sets `closed_at`, so a second run finds nothing. Called ONCE per boot, from `platform/assemble.ts`,
 * before any session can be opened — a session opened by THIS process would otherwise be a
 * candidate for its own reconciliation.
 *
 * Each reconciled session gets one chained `computer.session` audit row, matching every other
 * terminal path in `cu-gate.ts`: a session ending is a fact the audit log records, and a session
 * that ended because the gateway stopped is no less of one. `hitl_status` is `rejected` — the
 * CHECK-constrained value every non-approval terminal outcome uses (`not_required` would read as
 * "this ran without needing approval", which is precisely what it must not say).
 */
export function reconcileOrphanedSessions(
  db: Database,
  opts: { readonly now: () => number },
): ReconcileResult {
  const orphans = listOpenSessions(db);
  const closed: string[] = [];
  for (const row of orphans) {
    const at = opts.now();
    // The row FIRST, then the audit append. If the append throws, the row is already closed, so a
    // retry on the next boot finds nothing and cannot double-close it; the reverse order could
    // leave an audit row claiming a closure that never landed.
    updateSessionState(db, row.id, { closedAt: at, closeReason: ORPHANED_SESSION_REASON });
    appendAuditEntry(db, {
      actionType: "computer.session",
      hitlStatus: "rejected",
      actionJson: JSON.stringify({
        outcome: ORPHANED_SESSION_REASON,
        sessionId: row.id,
        lane: row.lane,
        openedAt: row.openedAt,
        reason:
          "the gateway process that opened this session is gone; its browser died with it and no live session backs this row",
      }),
      timestamp: at,
      sessionId: row.id,
    });
    closed.push(row.id);
  }
  return { reconciled: closed.length, sessionIds: closed };
}
