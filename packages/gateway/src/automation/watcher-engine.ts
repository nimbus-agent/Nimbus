import type { Database } from "bun:sqlite";

import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import {
  type GraphPredicate,
  itemMatchesGraphPredicate,
  parseGraphPredicate,
} from "./graph-predicate.ts";
import { type WatcherConditionKind, watcherConditionKind } from "./watcher-condition-kinds.ts";
import {
  insertWatcherEvent,
  listEnabledWatchers,
  updateWatcherLastChecked,
  updateWatcherLastFired,
  type WatcherRow,
} from "./watcher-store.ts";

export type WatcherEvalOptions = {
  graphConditionsEnabled?: boolean;
};

/**
 * Narrows the item query to items whose timeline graph entity names a given affected service.
 *
 * Lives here, not in `watcher-condition-kinds.ts`, precisely because it takes bound parameters:
 * that table's `extraSql` is a constant fragment with none, and a test pins the absence of `?` in
 * it, since the engine's positional binds sit around it. This fragment is still a compile-time
 * constant — the two values are BOUND (I9), never interpolated.
 *
 * `graph_entity.external_id` holds the ITEM PRIMARY KEY (`item.id`) for every entity
 * `graph-populator.ts` writes from an indexed item (`upsertGraphEntity({ externalId: row.id })`),
 * which is why this joins on `item.id` and not `item.external_id`.
 *
 * `json_valid(ge.metadata)` is LOAD-BEARING for the same reason it is on the condition table's own
 * fragments: SQLite's `json_extract` RAISES "malformed JSON" on non-JSON TEXT, and the exception
 * would propagate out of `evaluateOneWatcher` and kill evaluation for EVERY watcher in the loop,
 * not just this one. `graph_entity.metadata` is nullable and written by more than one populator
 * path, so this is a live risk, not a hypothetical.
 */
const AFFECTED_SERVICE_EXISTS_SQL = `AND EXISTS (
           SELECT 1 FROM graph_entity ge
            WHERE ge.type = ?
              AND ge.external_id = item.id
              AND json_valid(ge.metadata)
              AND json_extract(ge.metadata, '$.affectedService') = ?
         )`;

function asRecord(json: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(json) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      return undefined;
    }
    return v as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function evaluateWatchersAfterSync(
  db: Database,
  syncedServiceId: string,
  nowMs: number,
  notify: (title: string, body: string) => void | Promise<void>,
  opts: WatcherEvalOptions = {},
): void {
  if (readIndexedUserVersion(db) < 8) {
    return;
  }

  const graphEnabled = opts.graphConditionsEnabled ?? true;

  for (const w of listEnabledWatchers(db)) {
    const fired = evaluateOneWatcher(db, w, syncedServiceId, graphEnabled);
    updateWatcherLastChecked(db, w.id, nowMs);
    if (fired !== null) {
      insertWatcherEvent(db, w.id, nowMs, fired.snapshot, JSON.stringify({ ok: true }));
      void notify("Nimbus watcher", `${w.name}: ${fired.summary}`);
      updateWatcherLastFired(db, w.id, nowMs);
    }
  }
}

export function evaluateWatchersStartupCatchUp(
  db: Database,
  nowMs: number,
  notify: (title: string, body: string) => void | Promise<void>,
  opts: WatcherEvalOptions = {},
): void {
  if (readIndexedUserVersion(db) < 8) {
    return;
  }

  const graphEnabled = opts.graphConditionsEnabled ?? true;

  for (const w of listEnabledWatchers(db)) {
    const fired = evaluateOneWatcher(db, w, undefined, graphEnabled);
    updateWatcherLastChecked(db, w.id, nowMs);
    if (fired !== null) {
      insertWatcherEvent(db, w.id, nowMs, fired.snapshot, JSON.stringify({ ok: true }));
      void notify("Nimbus watcher", `${w.name}: ${fired.summary}`);
      updateWatcherLastFired(db, w.id, nowMs);
    }
  }
}

/**
 * Parse a watcher's `filter` and decide whether this evaluation is in scope at
 * all. `null` means "this watcher does not apply" — a malformed condition, a
 * `filter.service` that does not match the connector that just synced, or an
 * `affectedService` this condition kind structurally cannot evaluate.
 *
 * Split out of `evaluateOneWatcher` for cognitive complexity (Sonar S3776,
 * scored 19): the guard chain was most of the score, and it is a coherent
 * question on its own — "does this watcher care about what just happened?"
 *
 * Every arm fails CLOSED, which is the whole point. In particular an
 * `affectedService` on a kind with no timeline entity returns `null` rather than
 * being ignored: ignoring it would silently WIDEN the watcher to every item of
 * its type, the exact opposite of the narrowing the operator asked for.
 *
 * `filter.affectedService` scopes on the service the EVENT IS ABOUT, which
 * `filter.service` structurally cannot — `item.service` is the syncable
 * connector id, so every PagerDuty incident carries `pagerduty` there.
 */
function resolveWatcherScope(
  w: WatcherRow,
  kind: WatcherConditionKind,
  syncedServiceId: string | undefined,
): {
  service: string | undefined;
  affectedService: string | undefined;
  affectedServiceEntityType: string | null;
} | null {
  const cond = asRecord(w.condition_json);
  if (cond === undefined) {
    return null;
  }
  const filter = cond["filter"];
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    return null;
  }
  const f = filter as Record<string, unknown>;
  const service = typeof f["service"] === "string" ? f["service"] : undefined;
  if (syncedServiceId !== undefined && service !== undefined && service !== syncedServiceId) {
    return null;
  }
  const affectedService =
    typeof f["affectedService"] === "string" ? f["affectedService"] : undefined;
  const affectedServiceEntityType = kind.affectedServiceEntityType;
  if (affectedService !== undefined && affectedServiceEntityType === null) {
    return null;
  }
  return { service, affectedService, affectedServiceEntityType };
}

function evaluateOneWatcher(
  db: Database,
  w: WatcherRow,
  syncedServiceId: string | undefined,
  graphEnabled: boolean,
): { summary: string; snapshot: string } | null {
  const kind = watcherConditionKind(w.condition_type);
  if (kind === undefined) {
    return null;
  }
  const scope = resolveWatcherScope(w, kind, syncedServiceId);
  if (scope === null) {
    return null;
  }
  const { service, affectedService, affectedServiceEntityType } = scope;

  const since = w.last_checked_at ?? w.created_at;
  const rows = db
    .query(
      `SELECT id, title, service, type, external_id, modified_at FROM item
       WHERE type = ?
         AND modified_at > ?
         AND (? IS NULL OR service = ?)
         ${kind.extraSql}
         ${affectedService === undefined ? "" : AFFECTED_SERVICE_EXISTS_SQL}
       ORDER BY modified_at DESC
       LIMIT 5`,
    )
    .all(
      kind.itemType,
      since,
      service ?? null,
      service ?? null,
      // Appended, never interleaved: the four positional parameters above keep their positions,
      // and this pair is bound only when the fragment that consumes it is present.
      ...(affectedService === undefined
        ? []
        : [affectedServiceEntityType as string, affectedService]),
    ) as Array<{
    id: string;
    title: string;
    service: string;
    type: string;
    external_id: string;
    modified_at: number;
  }>;

  if (rows.length === 0) {
    return null;
  }

  let predicate: GraphPredicate | null = null;
  if (graphEnabled && w.graph_predicate_json !== null && w.graph_predicate_json !== "") {
    const parsed = parseGraphPredicate(w.graph_predicate_json);
    if (!parsed.ok) {
      process.stderr.write(
        `[watcher-engine] watcher ${w.id} (${w.name}): graph_predicate_json parse failed — ${parsed.error}\n`,
      );
      return null;
    }
    predicate = parsed.predicate;
  }

  const pred = predicate;
  const filtered =
    pred === null
      ? rows
      : rows.filter((r) =>
          itemMatchesGraphPredicate({
            db,
            itemEntityType: r.type,
            itemExternalId: r.external_id,
            predicate: pred,
          }),
        );

  if (filtered.length === 0) {
    return null;
  }

  const first = filtered[0];
  if (first === undefined) {
    return null;
  }
  const summary = `${first.service}: ${first.title}`;
  const snapshot = JSON.stringify({ matches: filtered, condition: w.condition_json });
  return { summary, snapshot };
}

export interface ChatopsWatcherNotifyDeps {
  /** Map the current watcher context to a namespace (or undefined for local-only). */
  readonly namespaceForWatcher: () => string | undefined;
  /** Post to a namespace's ChatOps notify channels (ReplyDispatcher.send w/ a namespaceNotify target). */
  readonly sendToNamespace: (namespace: string, text: string) => Promise<void>;
}

/**
 * Build a watcher `notify(title, body)` callback that also routes to a ChatOps notify channel
 * (Slice 5). Composes with the existing IPC-notify callback at the wiring site (both are called);
 * when no namespace maps, this is a no-op (local-only watcher).
 */
export function makeChatopsWatcherNotify(
  deps: ChatopsWatcherNotifyDeps,
): (title: string, body: string) => Promise<void> {
  return async (_title, body) => {
    const ns = deps.namespaceForWatcher();
    if (ns === undefined) return;
    await deps.sendToNamespace(ns, body);
  };
}
