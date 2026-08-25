import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { type BodyRow, type UpsertSyncDeps, upsertIndexedItemForSync } from "./item-store.ts";

/** The `obsidian_notes` row a connector has parsed out of a vault file. */
export interface ObsidianNoteRow {
  readonly itemId: string;
  readonly vaultId: string;
  readonly vaultName: string;
  readonly relPath: string;
  readonly title: string;
  readonly frontmatter: unknown;
  readonly tags: readonly string[];
  readonly rawWikilinks: readonly string[];
  readonly dailyNoteDate: string | undefined;
  readonly mtimeMs: number;
}

/** One note: the indexed item it becomes, plus its `obsidian_notes` row. */
export interface ObsidianNoteWrite {
  readonly item: BodyRow;
  readonly note: ObsidianNoteRow;
}

function upsertObsidianNoteRow(db: Database, note: ObsidianNoteRow, syncedAt: number): void {
  dbRun(
    db,
    `INSERT INTO obsidian_notes (
      id, vault_id, vault_name, path, title, frontmatter_json, tags_json, wikilinks_json, daily_note_date, last_modified, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      vault_id = excluded.vault_id,
      vault_name = excluded.vault_name,
      path = excluded.path,
      title = excluded.title,
      frontmatter_json = excluded.frontmatter_json,
      tags_json = excluded.tags_json,
      wikilinks_json = excluded.wikilinks_json,
      daily_note_date = excluded.daily_note_date,
      last_modified = excluded.last_modified`,
    [
      note.itemId,
      note.vaultId,
      note.vaultName,
      note.relPath,
      note.title,
      JSON.stringify(note.frontmatter),
      JSON.stringify(note.tags),
      JSON.stringify(note.rawWikilinks),
      note.dailyNoteDate ?? null,
      note.mtimeMs,
      syncedAt,
    ],
  );
}

function deleteNotesAbsentFromVault(
  db: Database,
  vaultId: string,
  keepIds: ReadonlySet<string>,
): number {
  const existing = db
    .query("SELECT id FROM obsidian_notes WHERE vault_id = ?")
    .all(vaultId) as Array<{ id: string }>;
  let deleted = 0;
  for (const row of existing) {
    if (keepIds.has(row.id)) {
      continue;
    }
    dbRun(db, "DELETE FROM item WHERE id = ?", [row.id]);
    dbRun(db, "DELETE FROM obsidian_notes WHERE id = ?", [row.id]);
    dbRun(
      db,
      `DELETE FROM graph_relation
       WHERE from_id IN (SELECT id FROM graph_entity WHERE type = 'obsidian_note' AND external_id = ?)
          OR to_id   IN (SELECT id FROM graph_entity WHERE type = 'obsidian_note' AND external_id = ?)`,
      [row.id, row.id],
    );
    dbRun(db, "DELETE FROM graph_entity WHERE type = 'obsidian_note' AND external_id = ?", [
      row.id,
    ]);
    deleted++;
  }
  return deleted;
}

/**
 * Writes one vault's notes and prunes the ones that are gone, in a SINGLE transaction.
 *
 * The batch is the unit deliberately. `obsidian-sync.ts` wrapped its per-note loop and its prune in
 * one `db.transaction(...)`, and a per-note capability would have issued N autocommitted writes
 * instead — a partial sync would leave `obsidian_notes` half-updated and still report success. The
 * connector parses; the gateway decides what reaches SQLite and when it commits.
 *
 * Items go through `upsertIndexedItemForSync`, not the raw upsert, so a `metadata_only`/`summary`
 * vault does not keep getting full note bodies indexed (V48/V49).
 */
export function writeObsidianVault(
  deps: UpsertSyncDeps,
  input: {
    readonly vaultId: string;
    readonly notes: readonly ObsidianNoteWrite[];
    readonly keepIds: ReadonlySet<string>;
    readonly syncedAt: number;
  },
): { upserted: number; deleted: number } {
  let upserted = 0;
  let deleted = 0;
  deps.db.transaction(() => {
    for (const write of input.notes) {
      upsertIndexedItemForSync(deps, write.item);
      upsertObsidianNoteRow(deps.db, write.note, input.syncedAt);
      upserted++;
    }
    deleted = deleteNotesAbsentFromVault(deps.db, input.vaultId, input.keepIds);
  })();
  return { upserted, deleted };
}
