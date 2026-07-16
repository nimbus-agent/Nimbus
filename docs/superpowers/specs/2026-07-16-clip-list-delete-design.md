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
  (case-sensitive exact match on a tag entry).
- `--limit` defaults to 50.
- `--json` emits the structured rows (array of `{ id, title, url, clippedAt, tags, mode }`)
  for scripting.
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

- **`clip.list`** → `buildItemListSql({ services: [], types: ["web_clip"], limit })`
  (`index/item-list-query.ts`, which returns `SELECT * … ORDER BY modified_at DESC LIMIT ?`
  — i.e. **newest-first for free**, since clip ingest sets `modified_at = synced_at =
  capturedAt`). Read rows, project `{ id, title, url, clippedAt, tags, mode }` where
  `clippedAt = modified_at`, `tags`/`mode` parsed from the `metadata` JSON; optional
  in-memory `tag` filter (applied after the SQL). Returns `{ clips: [...] }`.
- **`clip.delete`** → resolve the target to primary key(s):
  - Starts with `nimbus:` → `deleteItemByPrimaryKey(db, id)` (one item).
  - Else URL → reuse `canonicalizeUrl` from `clips/clip-ingest.ts`, then
    `SELECT id FROM item WHERE type='web_clip' AND canonical_url = ?`, delete each.
  - `{ all: true }` → `SELECT id FROM item WHERE type='web_clip'`, delete each.
  - Returns `{ deleted: N }`. FTS rows drop automatically via the existing
    `item_fts_delete` trigger — no extra FTS bookkeeping.

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
  - `clip.list`: all; `--tag` filter; `--limit`; newest-first ordering; tags/mode projected.
  - `clip.delete`: by id (one); by URL (article + 2 selections → deleted 3); `--all`;
    non-existent id/url → deleted 0; verify the row is gone and FTS no longer matches it.
  - `list`/`delete` with `db` absent → fail-soft (empty / error), `pair` still works.
- **`clip.test.ts`** — CLI: `list` table format, empty state, `--json` shape; `delete`
  output; the `--all` needs-`--yes` guard (count-only vs. actual delete).
- Coverage ≥80% on new lines (gateway + cli floors).

## Docs

- `docs/cli-reference.md` — document `nimbus clip list` and `nimbus clip delete` under the
  existing `## Web clipper` / `nimbus clip …` section.
- `docs/CHANGELOG.md` — one dated entry under post-Phase-6 deliveries.

## Out-of-scope follow-ups (noted, not built)

- Global tag search (fold tags into `item_fts`) — a separate, migration-bearing change.
- A matching UI in the browser extension (a "my clips" view) — extension-repo work.
