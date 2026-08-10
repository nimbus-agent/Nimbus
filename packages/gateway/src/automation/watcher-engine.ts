import type { Database } from "bun:sqlite";

import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import {
  type GraphPredicate,
  itemMatchesGraphPredicate,
  parseGraphPredicate,
} from "./graph-predicate.ts";
import { watcherConditionKind } from "./watcher-condition-kinds.ts";
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

  const since = w.last_checked_at ?? w.created_at;
  const rows = db
    .query(
      `SELECT id, title, service, type, external_id, modified_at FROM item
       WHERE type = ?
         AND modified_at > ?
         AND (? IS NULL OR service = ?)
         ${kind.extraSql}
       ORDER BY modified_at DESC
       LIMIT 5`,
    )
    .all(kind.itemType, since, service ?? null, service ?? null) as Array<{
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
