import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import type { ObsidianNoteWrite } from "../index/obsidian-notes-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { isSameOrInside } from "../util/path-overlap.ts";

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

function buildNoteWrite(
  note: IndexedNote,
  resolvedWikilinkIds: readonly string[],
  syncedAt: number,
): ObsidianNoteWrite {
  return {
    // Routed through the depth chokepoint by the STORE (upsertIndexedItemForSync), not the raw
    // upsertIndexedItem — a `metadata_only`/`summary` vault must not keep getting full note bodies
    // indexed on every sync.
    item: {
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
    },
    note: {
      itemId: note.itemId,
      vaultId: note.vaultId,
      vaultName: note.vaultName,
      relPath: note.relPath,
      title: note.title,
      frontmatter: note.frontmatter,
      tags: note.tags,
      rawWikilinks: note.rawWikilinks,
      dailyNoteDate: note.dailyNoteDate,
      mtimeMs: note.mtimeMs,
    },
  };
}

/**
 * Read one note, refusing anything that is or passes through a link (B4b review finding 2). Since
 * the Obsidian connector's sandbox may WRITE today's note in a vault, a note can be swapped for a symlink
 * (or, on Windows, a reparse point) between the walk's `lstat` and this read, and the index would
 * then ingest a file outside the vault. So, in order:
 *  1. `lstat` the note: a link or a non-file is refused;
 *  2. the real path of its folder must still be inside the real path of the vault;
 *  3. it is opened without following a final link (`O_NOFOLLOW`, off win32; Windows has no such
 *     flag, and step 1 and 4 cover a reparse point there);
 *  4. the opened file (`fstat`) must be the same file (`dev`, `ino`) as a fresh `lstat` of the
 *     path, which must still not be a link.
 * Any failure, or a mismatch, skips the note. Stated bound: a link swapped in after step 4 is not
 * seen, but the open descriptor is already on the checked file.
 */
export function readNoteSource(
  abs: string,
  vaultRoot: string,
  platform: NodeJS.Platform = process.platform,
): { source: string; mtimeMs: number } | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(abs);
    if (before.isSymbolicLink() || !before.isFile()) return null;
    const realVault = realpathSync.native(vaultRoot);
    if (!isSameOrInside(platform, realpathSync.native(dirname(abs)), realVault)) return null;
    fd =
      platform === "win32"
        ? openSync(abs, "r")
        : openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const again = lstatSync(abs);
    if (again.isSymbolicLink() || opened.dev !== again.dev || opened.ino !== again.ino) {
      return null;
    }
    const source = readFileSync(fd, "utf8");
    return { source, mtimeMs: opened.mtimeMs };
  } catch {
    // file disappeared / unreadable / a link at open time (ELOOP) — skip to next entry
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
    const read = readNoteSource(join(vaultRoot, rel), vaultRoot);
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

  let nextTip = tip;
  const keepIds = new Set<string>();
  const writes: ObsidianNoteWrite[] = [];
  for (const n of parsedNotes) {
    keepIds.add(n.itemId);
    if (n.mtimeMs <= startTip) {
      continue;
    }
    const { resolved } = resolveWikilinks(n.rawWikilinks, byFilenameLower, byTitleLower);
    writes.push(buildNoteWrite(n, resolved, now));
    if (n.mtimeMs > nextTip) {
      nextTip = n.mtimeMs;
    }
  }
  const { upserted, deleted } = ctx.writeObsidianVault({
    vaultId,
    notes: writes,
    keepIds,
    syncedAt: now,
  });
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
