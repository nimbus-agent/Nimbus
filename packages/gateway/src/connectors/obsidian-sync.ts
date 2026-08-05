import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { dbRun } from "../db/write.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";

import { discoverNotesInVault, discoverVaults } from "./obsidian-discovery.ts";
import { parseNote, resolveWikilinks } from "./obsidian-parsing.ts";
import { formatVaultName, vaultIdFromAbsolutePath } from "./obsidian-vault-id.ts";

// connectorFetch opt-out: indexes filesystem vault notes, not paginated HTTP.
const SERVICE_ID = "obsidian";
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_SYNC_DEPTH_DAYS = 365;

export type ObsidianSyncableOptions = {
  roots: readonly NimbusFilesystemRootToml[];
};

type CursorState = { tip: number };

function decodeCursor(cursor: string | null): CursorState {
  if (cursor === null) {
    return { tip: 0 };
  }
  try {
    const parsed = JSON.parse(cursor) as { tip?: number };
    return { tip: typeof parsed.tip === "number" ? parsed.tip : 0 };
  } catch {
    return { tip: 0 };
  }
}

function encodeCursor(state: CursorState): string {
  return JSON.stringify(state);
}

function externalIdFor(vaultId: string, relPath: string): string {
  return `${vaultId}#${relPath}`;
}

function itemIdFor(vaultId: string, relPath: string): string {
  return `${SERVICE_ID}:${externalIdFor(vaultId, relPath)}`;
}

type IndexedNote = {
  itemId: string;
  vaultId: string;
  vaultName: string;
  vaultRoot: string;
  relPath: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: readonly string[];
  aliases: readonly string[];
  rawWikilinks: readonly string[];
  dailyNoteDate: string | undefined;
  mtimeMs: number;
};

function upsertNote(
  ctx: SyncContext,
  note: IndexedNote,
  resolvedWikilinkIds: readonly string[],
  syncedAt: number,
): void {
  // Routed through the depth chokepoint (upsertIndexedItemForSync), not the raw
  // upsertIndexedItem — a `metadata_only`/`summary` vault must not keep getting
  // full note bodies indexed on every sync.
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "obsidian_note",
    externalId: externalIdFor(note.vaultId, note.relPath),
    title: note.title,
    body: note.body,
    modifiedAt: note.mtimeMs,
    metadata: {
      vault_id: note.vaultId,
      vault_name: note.vaultName,
      path: note.relPath,
      tags: note.tags,
      aliases: note.aliases,
      frontmatter: note.frontmatter,
      daily_note_date: note.dailyNoteDate ?? null,
      resolved_wikilink_ids: resolvedWikilinkIds,
    },
    syncedAt,
  });
  const db = ctx.db;
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

function readNoteSource(abs: string): { source: string; mtimeMs: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const mtimeMs = fstatSync(fd).mtimeMs;
    const source = readFileSync(fd, "utf8");
    return { source, mtimeMs };
  } catch {
    // file disappeared / unreadable — skip to next entry
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function parseNotesForVault(
  vaultRoot: string,
  vaultId: string,
  vaultName: string,
  noteRelPaths: readonly string[],
): IndexedNote[] {
  const parsedNotes: IndexedNote[] = [];
  for (const rel of noteRelPaths) {
    const read = readNoteSource(join(vaultRoot, rel));
    if (read === null) {
      continue;
    }
    const parsed = parseNote(rel, read.source);
    parsedNotes.push({
      itemId: itemIdFor(vaultId, parsed.relPath),
      vaultId,
      vaultName,
      vaultRoot,
      relPath: parsed.relPath,
      title: parsed.title,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      aliases: parsed.aliases,
      rawWikilinks: parsed.wikilinks,
      dailyNoteDate: parsed.dailyNoteDate,
      mtimeMs: read.mtimeMs,
    });
  }
  return parsedNotes;
}

function buildWikilinkIndexes(parsedNotes: readonly IndexedNote[]): {
  byFilenameLower: Map<string, { id: string; title: string }>;
  byTitleLower: Map<string, string>;
} {
  const byFilenameLower = new Map<string, { id: string; title: string }>();
  const byTitleLower = new Map<string, string>();
  for (const n of parsedNotes) {
    byFilenameLower.set(basename(n.relPath).toLowerCase(), { id: n.itemId, title: n.title });
    byTitleLower.set(n.title.toLowerCase(), n.itemId);
  }
  return { byFilenameLower, byTitleLower };
}

type VaultIngestResult = { upserted: number; deleted: number; nextTip: number };

function ingestVault(
  ctx: SyncContext,
  vaultRoot: string,
  tip: number,
  startTip: number,
  now: number,
): VaultIngestResult {
  const vaultId = vaultIdFromAbsolutePath(vaultRoot);
  const vaultName = formatVaultName(vaultRoot);
  const parsedNotes = parseNotesForVault(
    vaultRoot,
    vaultId,
    vaultName,
    discoverNotesInVault(vaultRoot),
  );
  const { byFilenameLower, byTitleLower } = buildWikilinkIndexes(parsedNotes);

  let upserted = 0;
  let nextTip = tip;
  const keepIds = new Set<string>();
  let deleted = 0;
  ctx.db.transaction(() => {
    for (const n of parsedNotes) {
      keepIds.add(n.itemId);
      if (n.mtimeMs <= startTip) {
        continue;
      }
      const { resolved } = resolveWikilinks(n.rawWikilinks, byFilenameLower, byTitleLower);
      upsertNote(ctx, n, resolved, now);
      upserted++;
      if (n.mtimeMs > nextTip) {
        nextTip = n.mtimeMs;
      }
    }
    deleted = deleteNotesAbsentFromVault(ctx.db, vaultId, keepIds);
  })();
  return { upserted, deleted, nextTip };
}

export function createObsidianSyncable(options: ObsidianSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: DEFAULT_INTERVAL_MS,
    initialSyncDepthDays: INITIAL_SYNC_DEPTH_DAYS,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      if (options.roots.length === 0) {
        return syncNoopResult(cursor, t0);
      }
      await ctx.rateLimiter.acquire("filesystem");
      const state = decodeCursor(cursor);
      const now = Date.now();
      let upserted = 0;
      let deleted = 0;
      let nextTip = state.tip;

      const rootPaths = options.roots.map((r) => r.path);
      const vaults = discoverVaults(rootPaths);

      for (const vaultRoot of vaults) {
        const result = ingestVault(ctx, vaultRoot, nextTip, state.tip, now);
        upserted += result.upserted;
        deleted += result.deleted;
        nextTip = result.nextTip;
      }

      return {
        cursor: encodeCursor({ tip: nextTip }),
        itemsUpserted: upserted,
        itemsDeleted: deleted,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
