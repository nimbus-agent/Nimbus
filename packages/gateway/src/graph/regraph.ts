import type { Database } from "bun:sqlite";

import { syncGraphFromIndexedItem } from "./graph-populator.ts";
import { isItemLinkedGraphType } from "./relationship-graph.ts";

export type RegraphResult = {
  scanned: number;
  graphed: number;
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
 * `deployment` / `incident` correlate symmetrically (either side emits the
 * edge), so their relative order is free — they are listed only to keep the
 * whole dependency story in one place.
 */
const REGRAPH_TYPE_ORDER: readonly string[] = Object.freeze([
  "issue",
  "git_commit",
  "deployment",
  "incident",
  "pr",
  "message",
]);

function graphOneRow(db: Database, r: ItemRow): boolean {
  if (!isItemLinkedGraphType(r.type)) return false;
  syncGraphFromIndexedItem(db, {
    id: r.id,
    service: r.service,
    type: r.type,
    title: r.title,
    bodyPreview: r.body_preview,
    authorId: r.author_id,
    metadata: parseMetadata(r.metadata),
  });
  return true;
}

/**
 * Page through one slice of the item table by keyset (`id > lastId`) rather
 * than OFFSET. OFFSET makes SQLite re-walk every skipped row on each page,
 * which turns a large backfill quadratic.
 */
function regraphSlice(
  db: Database,
  where: string,
  params: readonly string[],
  batchSize: number,
  counters: { scanned: number; graphed: number },
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
      .all(...params, lastId, batchSize) as ItemRow[];
    if (rows.length === 0) return;

    for (const r of rows) {
      counters.scanned += 1;
      if (graphOneRow(db, r)) counters.graphed += 1;
    }

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
 */
export function regraphAllItems(db: Database, opts?: { batchSize?: number }): RegraphResult {
  const batchSize = opts?.batchSize ?? 500;
  const counters = { scanned: 0, graphed: 0 };

  for (const type of REGRAPH_TYPE_ORDER) {
    regraphSlice(db, "type = ?", [type], batchSize, counters);
  }

  // Everything else: graph-participating types with no ordering constraint,
  // plus non-participating types, which are counted as scanned but skipped.
  const placeholders = REGRAPH_TYPE_ORDER.map(() => "?").join(", ");
  regraphSlice(db, `type NOT IN (${placeholders})`, REGRAPH_TYPE_ORDER, batchSize, counters);

  return counters;
}
