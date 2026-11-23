import type { Database } from "bun:sqlite";
import {
  countItemsMatchingGraphPredicate,
  listCandidateGraphRelations,
  parseGraphPredicate,
} from "../../automation/graph-predicate.ts";
import {
  supportsAffectedServiceFilter,
  watcherConditionKind,
} from "../../automation/watcher-condition-kinds.ts";
import { listWatcherHistory } from "../../automation/watcher-history.ts";
import {
  deleteWatcher,
  insertWatcher,
  listWatchers,
  setWatcherEnabled,
} from "../../automation/watcher-store.ts";
import { asRecord } from "../connector-rpc-shared.ts";
import {
  type AutomationHandler,
  AutomationRpcError,
  type Hit,
  requireNumber,
  requireString,
} from "./shared.ts";

function handleValidateCondition(rec: Record<string, unknown> | undefined, db: Database): Hit {
  const graphPredicateJson = requireString(rec, "graphPredicateJson");
  const sinceMs = requireNumber(rec, "sinceMs");
  const parsed = parseGraphPredicate(graphPredicateJson);
  if (!parsed.ok) {
    throw new AutomationRpcError(-32602, parsed.error);
  }
  return {
    kind: "hit",
    value: {
      matchCount: countItemsMatchingGraphPredicate({ db, predicate: parsed.predicate, sinceMs }),
    },
  };
}

/**
 * Does this `conditionJson` carry a `filter.affectedService`?
 *
 * Deliberately narrow, and deliberately NOT a general condition-JSON validator: `conditionJson`
 * has always been stored as an opaque string here, and tightening that wholesale would reject
 * rows this endpoint accepts today. Unparseable JSON, a non-object filter, or a non-string
 * `affectedService` all answer `false` and leave the pre-existing behaviour exactly as it was —
 * the only NEW rejection is the one case that is provably inert: a real `affectedService` string
 * on a condition kind whose items have no graph entity to match it against.
 */
function declaresAffectedServiceFilter(conditionJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(conditionJson);
  } catch {
    return false;
  }
  const cond = asRecord(parsed);
  const filter = cond === undefined ? undefined : asRecord(cond["filter"]);
  return filter !== undefined && typeof filter["affectedService"] === "string";
}

export const WATCHER_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  "watcher.list": (_rec, ctx) => ({
    kind: "hit",
    value: { watchers: listWatchers(ctx.db) },
  }),

  "watcher.create": (rec, ctx) => {
    const graphPredicateJson =
      rec !== undefined && typeof rec["graphPredicateJson"] === "string"
        ? rec["graphPredicateJson"]
        : null;
    const name = requireString(rec, "name");
    const conditionType = requireString(rec, "conditionType");
    const kind = watcherConditionKind(conditionType);
    if (kind === undefined) {
      throw new AutomationRpcError(
        -32602,
        `Unsupported conditionType "${conditionType}" — the watcher engine cannot evaluate it`,
      );
    }
    const conditionJson = requireString(rec, "conditionJson");
    if (declaresAffectedServiceFilter(conditionJson) && !supportsAffectedServiceFilter(kind)) {
      throw new AutomationRpcError(
        -32602,
        `conditionType "${conditionType}" does not support a filter.affectedService — ` +
          "no graph entity carries an affected service for it, so the watcher could never fire",
      );
    }
    const id = insertWatcher(ctx.db, {
      name,
      enabled: 1,
      condition_type: conditionType,
      condition_json: conditionJson,
      action_type: requireString(rec, "actionType"),
      action_json: requireString(rec, "actionJson"),
      created_at: Date.now(),
      graph_predicate_json: graphPredicateJson,
    });
    return { kind: "hit", value: { id } };
  },

  "watcher.delete": (rec, ctx) => {
    deleteWatcher(ctx.db, requireString(rec, "id"));
    return { kind: "hit", value: { ok: true } };
  },

  "watcher.pause": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setWatcherEnabled(ctx.db, requireString(rec, "id"), false) },
  }),

  "watcher.resume": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setWatcherEnabled(ctx.db, requireString(rec, "id"), true) },
  }),

  "watcher.listCandidateRelations": () => ({
    kind: "hit",
    value: { relations: listCandidateGraphRelations() },
  }),

  "watcher.validateCondition": (rec, ctx) => handleValidateCondition(rec, ctx.db),

  "watcher.listHistory": (rec, ctx) => ({
    kind: "hit",
    value: listWatcherHistory(ctx.db, {
      watcherId: requireString(rec, "watcherId"),
      limit: requireNumber(rec, "limit"),
    }),
  }),
};
