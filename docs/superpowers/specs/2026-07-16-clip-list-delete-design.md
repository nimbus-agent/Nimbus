# Design — `nimbus clip list` + `nimbus clip delete` + clip-scoped tags

**Date:** 2026-07-16
**Status:** Approved (brainstorm) → ready for implementation plan
**Repo:** Nimbus (gateway + CLI)
**Branch:** `dev/asafgolombek/clip-list-delete`

## Problem

A user who clips web pages with the browser extension has no way to **see** their
clips or **remove** one. Today:

- `nimbus clip status` lists *paired browsers* (token fingerprints), not clip content.
- `nimbus search <q>` requires a query — it can't enumerate all clips.
- The only delete is `nimbus data delete --service nimbus`, which is **service-wide**
  (wipes every `service:"nimbus"` item at once) — far too blunt for "remove this one clip."
- **Tags** captured at clip time are stored in each clip's `metadata` JSON but are
  **inert**: the FTS index covers only `title` + `body_preview` (not `metadata`), and
  nothing reads tags back for search, filter, or display.

This design adds the missing read + delete surface for clips, and makes tags do
something useful (clip-scoped display + filter).

## Goals

- `nimbus clip list [--tag <t>] [--limit N] [--json]` — enumerate clips.
- `nimbus clip delete <id|url>` / `nimbus clip delete --all [--yes]` — remove clips.
- Show tags in the list and filter by them (`--tag`).

## Non-goals (YAGNI)

- **Global tag search.** Tags stay clip-scoped; we do NOT fold tags into the shared
  `item_fts` index (that would need an item-FTS schema change + V45 migration + backfill
  affecting every connector's items). `nimbus search` behavior is unchanged.
- No edit/rename of clips or tags. No pagination beyond `--limit`. No interactive
  stdin prompts (see confirmation model below).

## Command surface

### `nimbus clip list [--tag <t>] [--limit N] [--json]`

```
$ nimbus clip list
CLIPPED           TITLE                        TAGS          URL
2026-07-16 14:02  Understanding Rust Async…    rust, async   https://blog.ex.com/rust-async
2026-07-15 09:11  The Rust Programming Lang…   rust          https://doc.rust-lang.org/book
```

- Sorted **newest-first** (by `modified_at`, which clip ingest sets to `capturedAt`).
- `--tag rust` filters to clips whose stored metadata tags include `rust`
  (case-sensitive exact match on a tag entry). Filtering happens **in SQL** so `--limit`
  stays correct (see Architecture — an in-memory filter after `LIMIT` would drop matches).
- `--limit` defaults to 50; a non-positive / non-numeric value falls back to the default
  (validated CLI-side, mirroring `nimbus search`).
- `--json` emits the structured rows (array of
  `{ id, title, url, clippedAt, tags, mode, wordCount }`) for scripting.
- Empty state: `No clips saved yet.` (or `No clips match tag "<t>".` when filtered).

### `nimbus clip delete <id|url>` / `--all [--yes]`

```
$ nimbus clip delete https://blog.ex.com/rust-async
Deleted 1 clip.
$ nimbus clip delete nimbus:clip:c5b7e9…
Deleted 1 clip.
$ nimbus clip delete --all
12 clips would be deleted. Re-run with --yes to confirm.
$ nimbus clip delete --all --yes
Deleted 12 clips.
```

- **Auto-detect target:** a string that **starts with `nimbus:`** (the exact ID form
  `clip list` prints — the primary key is `nimbus:clip:<hash>`) deletes that single item;
  otherwise the argument is treated as a **URL**, canonicalized, and **every** clip from
  that page is deleted (the article clip and any text-selection clips share the page's
  canonical URL). Reports the count. (A non-`nimbus:` string that isn't a real URL simply
  canonicalizes to something that matches nothing → `Deleted 0 clips.`.)
- **`--all`** is guarded: without `--yes` it reports only the count and deletes nothing;
  with `--yes` it deletes all clips. **No interactive stdin prompt** — matches
  `nimbus data delete`'s `--yes` pattern and keeps the command script-friendly + testable.
- Deleting a missing id/url is idempotent → `Deleted 0 clips.` (not an error).

## Architecture

### Gateway — two new `clip.*` IPC methods (`packages/gateway/src/ipc/clip-rpc.ts`)

`ClipRpcDeps` gains an optional DB handle:

```ts
export interface ClipRpcDeps {
  readonly pairing: PairingWindowController;
  readonly vault: NimbusVault;
  readonly httpBaseUrl?: string;   // (added by the clip-pair-print-url change)
  readonly db?: Database;          // NEW — for list/delete; absent → those degrade
}
```

`dispatchers.ts` `tryDispatchClipRpc` threads it in when the index is present:

```ts
...(ctx.options.localIndex === undefined
  ? {}
  : { db: ctx.options.localIndex.getDatabase() }),
```

This mirrors the existing agents dispatcher (`db: ctx.options.localIndex.getDatabase()`).
`pair`/`status`/`revoke` keep working without a DB; `list`/`delete` fail-soft when the
index is absent (`list` → empty result; `delete` → a clear error).

- **`clip.list`** → project `{ id, title, url, clippedAt, tags, mode, wordCount }` where
  `clippedAt = modified_at`, and `tags`/`mode`/`wordCount` parsed from the `metadata` JSON.
  Returns `{ clips: [...] }`, **newest-first** (`ORDER BY modified_at DESC`, since clip
  ingest sets `modified_at = synced_at = capturedAt`).
  - **No `--tag`:** `buildItemListSql({ services: [], types: ["web_clip"], limit })`
    (`index/item-list-query.ts`, already `SELECT * … ORDER BY modified_at DESC LIMIT ?`).
  - **With `--tag`:** filter in **SQL**, not in memory — applying `LIMIT` before an
    in-memory tag filter is a real bug (the last N rows might contain no matches while a
    match sits at row N+1, yielding a false "no matches"). Use a JSON-array match with a
    bound param (`json_each` verified available in `bun:sqlite`):
    ```sql
    SELECT item.* FROM item, json_each(item.metadata, '$.tags')
    WHERE item.type = 'web_clip' AND json_each.value = ?
    ORDER BY item.modified_at DESC LIMIT ?
    ```
    Safe here because clip ingest always writes valid `metadata` JSON with a `$.tags`
    array (`{tags, mode, wordCount, clippedAt}`), so `json_each` never sees a malformed
    path. The tag value is bound (I9). `wordCount` is included in the `--json` projection;
    the table view stays lean (clipped-at / title / tags / url).
- **`clip.delete`** → resolve the target to a **list of primary keys**, then delete each
  key with `deleteItemByPrimaryKey(db, id)`. **Never a raw `DELETE FROM item`** — the
  helper also calls `deleteGraphEntitiesForItemKeys` (item-store.ts:165), so raw deletes
  would orphan graph-relationship rows.
  - Empty / blank target → return `{ deleted: 0 }` **before** any query (guard, see Error
    handling).
  - Starts with `nimbus:` → that single id.
  - Else URL → reuse `canonicalizeUrl` from `clips/clip-ingest.ts`, then
    `SELECT id FROM item WHERE type='web_clip' AND canonical_url = ?` (bound, I9) → the
    resolved ids (article + any selections).
  - `{ all: true }` → `SELECT id FROM item WHERE type='web_clip'` → all clip ids. **Not**
    `deleteAllItemsForService` (that is service-wide and would also wipe non-clip
    `nimbus:` items).
  - Returns `{ deleted: N }`. Deletion cleanup is fully cascade-driven — no manual
    bookkeeping: `item_fts_delete` trigger drops the FTS row; the `embedding_chunk`
    `ON DELETE CASCADE` FK fires (`PRAGMA foreign_keys = ON` is set in local-index.ts:283)
    and its `AFTER DELETE` trigger clears the `vec_items_384` row.

### CLI (`packages/cli/src/commands/clip.ts`)

- Add `list` and `delete` subcommands to `runClip`'s switch; extend `CLIP_USAGE`.
- `runClipList(client, opts)` → call `clip.list`, format a fixed-width table (or JSON with
  `--json`); handle empty/filtered-empty states.
- `runClipDelete(client, target, opts)` → for `--all` without `--yes`, call `clip.list`
  to get the count and print the guard message; with `--yes` (or a single id/url target),
  call `clip.delete` and print `Deleted N clip(s).`.

### Data flow

```
CLI (clip list/delete)
  → IPC clip.list / clip.delete
    → clip-rpc handler
      → local-index DB (buildItemListSql / canonicalizeUrl+SELECT / deleteItemByPrimaryKey)
    ← { clips } / { deleted }
  ← formatted table | "Deleted N clips."
```

All loopback IPC; read + local delete only.

## Error handling / edge cases

- **Index absent** (no `localIndex` at boot — abnormal): `list` returns an empty list;
  `delete` returns an error the CLI surfaces as `Clip index unavailable.`.
- **Empty / blank delete target** (`nimbus clip delete ""` or `"   "`): the handler
  returns `{ deleted: 0 }` before running any query — never `SELECT … canonical_url = ''`
  (which could match a malformed row). The CLI also rejects a missing target with usage.
- **`--limit` invalid** (`--limit foo`, `--limit -3`, `--limit 0`): CLI clamps to the
  default (50), never forwards `NaN`/negative to the IPC call.
- **`<target>` combined with `--all`** (`clip delete https://… --all`): CLI rejects with a
  usage error before any IPC call — `--all` must not silently override a named target and
  wipe everything.
- **Malformed metadata under `--tag`**: the `json_each` tag query is wrapped in
  `CASE WHEN json_valid(item.metadata) …` so a single invalid-JSON row can't raise
  `malformed JSON` and abort the whole listing.
- **Unknown id / URL:** `Deleted 0 clips.` (idempotent, not an error).
- **`--all` with no clips:** `No clips to delete.`.
- **`--tag` with no matches:** `No clips match tag "<t>".`.
- **Malformed metadata JSON** on a row: treat tags as empty, mode as unknown; never throw.
- **Confirmation lives in the CLI**, not the gateway. The gateway `clip.delete` just deletes
  what it's told; the `--yes` guard is a CLI concern.

## Security / invariants

**No new invariant, no migration, no new security surface.**

- Deleting a local-index item is **not outbound egress** — consistent with connector sync
  deletes (`deleteItemByServiceExternal`), which are not HITL-gated or egress-ledgered.
- Clip ingest is inbound and already non-HITL / non-egress (I30 note); read + local delete
  are likewise local-only.
- No change to `WRITE_ROUTE_ALLOWLIST` (this is IPC, not the HTTP write surface), no change
  to the Tauri allowlist (`clip.*` is not renderer-exposed), no vault-key change.

## Testing

- **`clip-rpc.test.ts`** — seed a real in-memory V44 SQLite (same harness style as
  `clip-ingest.test.ts` / `clip-e2e.test.ts`) with a few `web_clip` items (incl. one
  article + two selections sharing a URL, and varied tags):
  - `clip.list`: all; `--tag` filter; `--limit`; newest-first ordering; tags/mode/wordCount
    projected.
  - **`--tag` past the `LIMIT` boundary (regression for the pagination bug):** seed >`limit`
    clips where the only tag-matching clip is *older* than the `limit` newest untagged
    clips; assert `list --tag X --limit N` still returns it (proves SQL-level filtering).
  - `clip.delete`: by id (one); by URL (article + 2 selections → deleted 3); `--all`
    (deletes only `web_clip`, leaves a seeded non-clip `nimbus:` item intact); empty/blank
    target → deleted 0 with no query; non-existent id/url → deleted 0; verify the row is
    gone, FTS no longer matches it, and (if embeddings seeded) the `embedding_chunk` /
    `vec_items_384` rows cascaded away.
  - `list`/`delete` with `db` absent → fail-soft (empty / error), `pair` still works.
- **`clip.test.ts`** — CLI: `list` table format, empty state, `--json` shape (incl.
  `wordCount`), `--limit foo`/`-3` → clamps to default; `delete` output, missing target →
  usage error; the `--all` needs-`--yes` guard (count-only vs. actual delete).
- Coverage ≥80% on new lines (gateway + cli floors).

## Docs

- `docs/cli-reference.md` — document `nimbus clip list` and `nimbus clip delete` under the
  existing `## Web clipper` / `nimbus clip …` section.
- `docs/CHANGELOG.md` — one dated entry under post-Phase-6 deliveries.

## Review resolution

Design review ([2026-07-16-clip-list-delete-design-review.md](./2026-07-16-clip-list-delete-design-review.md)) — all six points accepted after verification against the code:

1. **Tag filter + `LIMIT` bug** — FIXED. In-memory filtering after SQL `LIMIT` could hide
   matches; moved to a `json_each` SQL filter (verified available in `bun:sqlite`).
2. **Graph cleanup on delete** — FIXED (clarified). All delete paths resolve to ids and go
   through `deleteItemByPrimaryKey` (which calls `deleteGraphEntitiesForItemKeys`); never a
   raw `DELETE FROM item`.
3. **Embedding/vec cascade** — CONFIRMED. Verified `PRAGMA foreign_keys = ON`
   (local-index.ts:283), so the `embedding_chunk` `ON DELETE CASCADE` + `vec_items_384`
   trigger fire. No code needed; documented in the delete cleanup note.
4. **Empty/blank delete target** — FIXED. Guarded to `{ deleted: 0 }` before any query.
5. **`--limit` validation** — FIXED. CLI clamps invalid values to the default.
6. **`--json` `wordCount`** — ACCEPTED. Added to the projection (already parsed from
   metadata; near-zero cost).

## Out-of-scope follow-ups (noted, not built)

- Global tag search (fold tags into `item_fts`) — a separate, migration-bearing change.
- A matching UI in the browser extension (a "my clips" view) — extension-repo work.
