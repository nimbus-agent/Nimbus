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
 * Translates an affected service (a PR repo path, e.g. `acme/billing-api` —
 * `epic-services.ts`'s vocabulary) into a `[metrics.dora.<id>]` /
 * `[ci.service.<id>]` config id, or `null` when nothing in the config claims
 * it. A plain function type, not a `ServiceIdentityResolver` import, so
 * `premortem/` keeps no `metrics/` dependency — the same reason
 * `graph/graph-populator.ts` declares its resolver structurally.
 */
export type ResolveConfigServiceId = (repo: string) => string | null;

export type WatcherProposalResult = {
  proposals: WatcherProposal[];
  /**
   * Affected services that resolved to NO config id, in input order. Nothing
   * was proposed for them and nothing was written — the caller reports them
   * as a named gap. Never silently folded into `proposals`.
   */
  unmappedServices: string[];
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
 * Propose one paused `incident_opened` watcher per affected service that
 * resolves to a configured deployment-service id.
 *
 * THE TRANSLATION IS LOAD-BEARING, not a nicety. `services` here are PR repo
 * paths (`acme/billing-api`), and the watcher engine's `filter.affectedService`
 * matches `graph_entity.metadata.affectedService`, which
 * `graph/graph-populator.ts` resolves to a `[ci.service.<id>]` CONFIG id. An
 * earlier version wrote the raw repo path into `filter.service`, which the
 * engine matches against the `item.service` COLUMN — always the connector id
 * (`pagerduty`) for an incident — so every proposal it wrote was inert even
 * once armed. `agents/premortem.ts`'s incident-coupling query already did this
 * exact translation; that asymmetry between the two paths was the bug.
 *
 * A service that resolves to nothing gets NO watcher and NO row: it is
 * returned in `unmappedServices` for the caller to name in the brief. Falling
 * back to the repo path would recreate the inert proposal.
 *
 * Only incident-coupling watchers are proposed. The engine can now scope a
 * `deploy_failed` watcher the same way, so the old vocabulary-mismatch
 * justification no longer holds; the reason it is not proposed today is that
 * `deployment/annotate.ts` — the only writer of the `metadata.conclusion` that
 * condition matches — INSERTs its `item` row directly and creates no
 * `deployment` graph entity, so such a watcher matches nothing until an index
 * regraph. Deploy failure is a watcher CONDITION KIND, not one of the five
 * risks in `premortem/risks.ts` — there is no deploy-failure risk to report.
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
  input: {
    epicItemId: string;
    services: readonly string[];
    nowMs: number;
    resolveConfigServiceId: ResolveConfigServiceId;
  },
): WatcherProposalResult {
  const riskKind = "incident_coupling" as const;
  const out: WatcherProposal[] = [];
  const unmappedServices: string[] = [];

  for (const service of input.services) {
    const configServiceId = input.resolveConfigServiceId(service);
    if (configServiceId === null) {
      unmappedServices.push(service);
      continue;
    }
    // Keyed on the REPO, not the config id: the tombstone identity must stay
    // stable across a config edit that renames or re-points a service id, or
    // a deliberate deletion would silently un-suppress itself.
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
        condition_json: JSON.stringify({ filter: { affectedService: configServiceId } }),
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

  return { proposals: out, unmappedServices };
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
