import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { type ResolveServiceId, syncGraphFromIndexedItem } from "./graph-populator.ts";
import { isItemLinkedGraphType } from "./relationship-graph.ts";

export type RegraphResult = {
  scanned: number;
  graphed: number;
  skipped: number;
};

export type RegraphOptions = {
  batchSize?: number;
  logger?: Logger;
  /**
   * Threaded through to `syncGraphFromIndexedItem`'s third argument on every
   * row. Without it, `syncTimelineEventGraph` binds `affectedService` from
   * `metadata.service` alone — so a `deployment`/`incident` pair that only
   * correlates via a `[metrics.dora.<id>]`/`[ci.service.<id>]` binding (e.g.
   * PagerDuty's `pagerduty_service_id` or a repo URN, never a plain
   * `metadata.service`) has its `correlates_with` edge unconditionally
   * cleared and NOT re-emitted, and `affectedService` gets rewritten to
   * `null` in the entity's stored metadata. Production callers must supply
   * the same resolver assembled for the live `SyncContext`
   * (`platform/assemble.ts`) or this backfill is destructive for that class
   * of edge.
   */
  resolveServiceId?: ResolveServiceId;
  /**
   * @internal test seam: override the sync function so a test can force a
   * deterministic per-item failure without touching graph-populator.ts or
   * mocking the DB layer. Production callers must never set this.
   */
  _syncItem?: typeof syncGraphFromIndexedItem;
};

type ItemRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  author_id: string | null;
  metadata: string | null;
};

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Item types graphed in dependency order. An entity that is only ever a
 * reference *target* must already exist when the item referencing it is
 * processed, or the edge is silently skipped: `findIssueEntityIds` and
 * `findCommitEntityIds` resolve against `graph_entity`, not `item`.
 *
 * `obsidian_note` is here too: notes are `backlinks` targets
 * (`syncObsidianNoteGraph` resolves `resolved_wikilink_ids` against
 * `graph_entity` the same way issues/commits are resolved), so it must be
 * graphed before anything that references a note (deferred from 1a).
 *
 * `deployment` / `incident` correlate symmetrically (either side emits the
 * edge), so their relative order is free — they are listed only to keep the
 * whole dependency story in one place.
 */
const REGRAPH_TYPE_ORDER: readonly string[] = Object.freeze([
  "issue",
  "git_commit",
  "obsidian_note",
  "deployment",
  "incident",
  "pr",
  "message",
]);

function totalChanges(db: Database): number {
  return (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
}

/**
 * Graph one row inside its own nested transaction. This always runs nested
 * inside `regraphSlice`'s per-batch transaction, so `bun:sqlite` implements
 * it as a SAVEPOINT: if `syncItem` throws, only this row's writes roll back —
 * the enclosing batch (and any sibling rows already committed within it) is
 * unaffected. That is what keeps a bad row from ever leaving the graph
 * half-cleared: either every write the attempt made lands, or none of them
 * do.
 *
 * `graphed` is derived from the connection's cumulative `total_changes()`
 * rather than from `isItemLinkedGraphType` alone, because that predicate is
 * broader than `syncGraphFromIndexedItem`'s actual dispatch — e.g.
 * `ci_run`/`alert`/`error_issue` satisfy it but have no dispatch branch, so
 * nothing is ever written for them. Measuring the row-change counter directly
 * can't drift out of sync with the populator the way a second hand-maintained
 * type list would.
 */
function graphOneRow(
  db: Database,
  r: ItemRow,
  syncItem: typeof syncGraphFromIndexedItem,
  resolveServiceId: ResolveServiceId | undefined,
): boolean {
  if (!isItemLinkedGraphType(r.type)) return false;
  let graphed = false;
  db.transaction(() => {
    const before = totalChanges(db);
    syncItem(
      db,
      {
        id: r.id,
        service: r.service,
        type: r.type,
        title: r.title,
        bodyPreview: r.body_preview,
        authorId: r.author_id,
        metadata: parseMetadata(r.metadata),
      },
      resolveServiceId,
    );
    graphed = totalChanges(db) > before;
  })();
  return graphed;
}

type RegraphRunConfig = {
  batchSize: number;
  syncItem: typeof syncGraphFromIndexedItem;
  logger: Logger | undefined;
  resolveServiceId: ResolveServiceId | undefined;
};

/**
 * Page through one slice of the item table by keyset (`id > lastId`) rather
 * than OFFSET. OFFSET makes SQLite re-walk every skipped row on each page,
 * which turns a large backfill quadratic.
 *
 * Each page is applied in a single `db.transaction`, so a page either fully
 * commits or fully rolls back — an interruption (kill, crash, or an
 * unguarded throw) leaves the graph consistent at a page boundary instead of
 * mid-item, and batching removes most of the per-statement autocommit
 * overhead that dominates a large backfill.
 *
 * A single row's sync failure is caught per-item (see `graphOneRow`'s
 * savepoint) so it never aborts the rest of the page or the pass; it is
 * counted in `skipped` and logged rather than swallowed silently.
 */
function regraphSlice(
  db: Database,
  where: string,
  params: readonly string[],
  cfg: RegraphRunConfig,
  counters: { scanned: number; graphed: number; skipped: number },
): void {
  let lastId = "";
  for (;;) {
    const rows = db
      .query(
        `SELECT id, service, type, title, body_preview, author_id, metadata
           FROM item
          WHERE ${where} AND id > ?
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(...params, lastId, cfg.batchSize) as ItemRow[];
    if (rows.length === 0) return;

    const runBatch = db.transaction((batchRows: ItemRow[]) => {
      for (const r of batchRows) {
        counters.scanned += 1;
        try {
          if (graphOneRow(db, r, cfg.syncItem, cfg.resolveServiceId)) counters.graphed += 1;
        } catch (err) {
          counters.skipped += 1;
          cfg.logger?.warn(
            { err, itemId: r.id, itemType: r.type },
            "regraph: skipped item after sync failure",
          );
        }
      }
    });
    runBatch(rows);

    const last = rows.at(-1);
    if (last === undefined) return;
    lastId = last.id;
  }
}

/**
 * Re-run the graph populator over every indexed item.
 *
 * Needed because a populator change only reaches existing rows when they next
 * re-sync — and historical items may never re-sync.
 *
 * Processed in `REGRAPH_TYPE_ORDER` so reference targets are graphed before
 * the items that reference them; every edge this plan emits therefore settles
 * in a single pass. Idempotent regardless — each sync function clears and
 * rebuilds the edges it owns — so re-running is always safe.
 *
 * A row whose sync throws is skipped (not fatal to the pass) and counted in
 * `skipped`; `graphed` counts only items that actually produced graph writes.
 */
export function regraphAllItems(db: Database, opts?: RegraphOptions): RegraphResult {
  const cfg: RegraphRunConfig = {
    batchSize: opts?.batchSize ?? 500,
    syncItem: opts?._syncItem ?? syncGraphFromIndexedItem,
    logger: opts?.logger,
    resolveServiceId: opts?.resolveServiceId,
  };
  const counters = { scanned: 0, graphed: 0, skipped: 0 };

  for (const type of REGRAPH_TYPE_ORDER) {
    regraphSlice(db, "type = ?", [type], cfg, counters);
  }

  // Everything else: graph-participating types with no ordering constraint,
  // plus non-participating types, which are counted as scanned but not
  // graphed.
  const placeholders = REGRAPH_TYPE_ORDER.map(() => "?").join(", ");
  regraphSlice(db, `type NOT IN (${placeholders})`, REGRAPH_TYPE_ORDER, cfg, counters);

  return counters;
}
