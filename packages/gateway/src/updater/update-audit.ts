import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { redactUrlUserinfo } from "./redact-url-userinfo.ts";
import type { UpdateEventPhase } from "./updater.ts";

export type UpdateAuditRecorder = (
  phase: UpdateEventPhase,
  payload: Record<string, unknown>,
) => void;

/**
 * The production `recordUpdateEvent`: one BLAKE3-chained `audit_log` row per apply phase.
 *
 * - `action_type` is the phase string itself (`system.update.start|verified|installed|failed`);
 *   `hitl_status` is `not_required` — `nimbus update` is an owner command, not a gated
 *   connector action.
 * - `manifestUrl` is passed through `redactUrlUserinfo`, so a `user:token@` in a configured
 *   `[updater] url` never lands in the audit log.
 * - Failure policy is phase-dependent. An append failure at `system.update.start` THROWS, and
 *   because `Updater.applyUpdate` records `start` before it downloads anything, that aborts the
 *   apply fail-closed. At every later phase the failure is logged and swallowed: a throw after a
 *   real install would make the updater report a completed install as failed.
 */
export function buildUpdateAuditRecorder(db: Database, logger: Logger): UpdateAuditRecorder {
  return (phase, payload) => {
    const sanitized: Record<string, unknown> = { ...payload };
    const manifestUrl = sanitized["manifestUrl"];
    if (typeof manifestUrl === "string") {
      sanitized["manifestUrl"] = redactUrlUserinfo(manifestUrl);
    }
    try {
      appendAuditEntry(db, {
        actionType: phase,
        hitlStatus: "not_required",
        actionJson: JSON.stringify(sanitized),
        timestamp: Date.now(),
      });
    } catch (err) {
      if (phase === "system.update.start") {
        throw err;
      }
      logger.warn(
        { phase, err: err instanceof Error ? err.message : String(err) },
        "updater: audit append failed; continuing",
      );
    }
  };
}
