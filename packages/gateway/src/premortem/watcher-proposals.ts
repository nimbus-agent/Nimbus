import type { Database } from "bun:sqlite";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { insertWatcherIfAbsent } from "../automation/watcher-store.ts";
import { dbRun } from "../db/write.ts";

export type WatcherProposal = {
  watcherId: string;
  service: string;
  riskKind: "incident_coupling";
  state: "created" | "already_present" | "suppressed";
};

/**
 * Content-derived identity: hash(epicItemId, riskKind, service). Same scheme
 * as `decisionRowId` (`decisions/cue-mining.ts`) and `themeId`
 * (`premortem/theme-identity.ts`) — length-prefixed fields so a boundary
 * shift between two adjacent fields can never collide with a different
 * three-way split of the same bytes.
 */
function proposedWatcherId(epicItemId: string, riskKind: string, service: string): string {
  const encoder = new TextEncoder();
  const joined = [epicItemId, riskKind, service]
    .map((field) => `${String(field.length)}:${field}`)
    .join("");
  const digest = bytesToHex(blake3(encoder.encode(joined)));
  return digest.slice(0, 32);
}

/**
 * Propose one paused `incident_opened` watcher per service.
 *
 * Only incident-coupling watchers are proposed: a deployment item's
 * `item.service` is the annotate provider slug (`github-actions`,
 * `gitlab`, …) while the watcher engine matches syncable service ids, so a
 * service-filtered deploy-failure watcher could never fire. The
 * deploy-failure risk is still computed and reported by Task 2's
 * calculators — it simply proposes nothing here, exactly as cycle time,
 * size overrun and review drag do.
 *
 * Every proposed id is recorded in `premortem_watcher_proposal`, INCLUDING
 * the `already_present` case, so the tombstone stays complete across runs.
 * The `watcher` insert and the proposal-tombstone insert are wrapped in one
 * `db.transaction` so a watcher row can never exist without its tombstone —
 * without both landing together, "never proposed" and "deliberately
 * deleted" become indistinguishable on the next run.
 */
export function proposeWatchers(
  db: Database,
  input: { epicItemId: string; services: readonly string[]; nowMs: number },
): WatcherProposal[] {
  const riskKind = "incident_coupling" as const;
  const out: WatcherProposal[] = [];

  for (const service of input.services) {
    const watcherId = proposedWatcherId(input.epicItemId, riskKind, service);

    const wasTombstoned =
      db.query(`SELECT 1 FROM premortem_watcher_proposal WHERE watcher_id = ?`).get(watcherId) !==
      null;
    const watcherExists = db.query(`SELECT 1 FROM watcher WHERE id = ?`).get(watcherId) !== null;

    // Deliberately deleted: the tombstone survives, the watcher row does not.
    // Never call insertWatcherIfAbsent here — that would resurrect it.
    if (wasTombstoned && !watcherExists) {
      out.push({ watcherId, service, riskKind, state: "suppressed" });
      continue;
    }

    // Not suppressed, so it is safe to (re-)attempt both writes every run —
    // insertWatcherIfAbsent never touches an existing row's `enabled`, and the
    // tombstone insert is idempotent (INSERT OR IGNORE). Re-attempting on every
    // re-run, rather than short-circuiting once tombstoned, is what keeps this
    // path actually exercised: a regression that made insertWatcherIfAbsent
    // overwrite `enabled` on conflict would otherwise only be reachable on the
    // very first proposal, when there is nothing yet to overwrite.
    let inserted = false;
    db.transaction(() => {
      inserted = insertWatcherIfAbsent(db, {
        id: watcherId,
        name: `Pre-mortem: incidents on ${service}`,
        enabled: 0,
        condition_type: "incident_opened",
        condition_json: JSON.stringify({ filter: { service } }),
        action_type: "notify",
        action_json: "{}",
        created_at: input.nowMs,
      });
      dbRun(
        db,
        `INSERT OR IGNORE INTO premortem_watcher_proposal
           (watcher_id, epic_item_id, risk_kind, service, proposed_at)
         VALUES (?, ?, ?, ?, ?)`,
        [watcherId, input.epicItemId, riskKind, service, input.nowMs],
      );
    })();

    out.push({
      watcherId,
      service,
      riskKind,
      state: inserted ? "created" : "already_present",
    });
  }

  return out;
}

/**
 * Clears THIS epic's tombstones so a deliberately-deleted proposal can be
 * re-created — backs `nimbus pre-mortem <ref> --repropose` (Task 5). Scoped
 * to one epic; must never wipe tombstones globally. Reversing an explicit
 * user "no" requires an explicit user "yes", which is why this is a flag
 * and not automatic expiry.
 */
export function clearProposalTombstones(db: Database, epicItemId: string): number {
  const result = dbRun(db, `DELETE FROM premortem_watcher_proposal WHERE epic_item_id = ?`, [
    epicItemId,
  ]);
  return result.changes;
}
