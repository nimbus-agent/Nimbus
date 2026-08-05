/**
 * V49 — make the per-connector `depth` setting real.
 *
 * V21 added `depth TEXT NOT NULL DEFAULT 'summary'`, so every existing row
 * holds `'summary'` MATERIALISED rather than NULL. Depth was never enforced
 * for body content, so that stored `'summary'` expresses no intent about
 * bodies — it is indistinguishable from the column default and has always
 * behaved as `'full'`. Backfilling it preserves exactly the behaviour those
 * installs have observed; without it, the enforcement added alongside this
 * migration would silently truncate every existing index to 512 characters.
 *
 * `metadata_only` is deliberately NOT touched: its reindex really did strip
 * bodies, so it IS expressed intent, and it is the setting that finally
 * starts being honoured on every sync.
 *
 * The column's `DEFAULT 'summary'` is left in place — SQLite cannot alter a
 * column default in place, and rebuilding `sync_state` is disproportionate
 * when the code sites that insert rows all name the column explicitly. There
 * are THREE of them, and the last is the one that actually runs on a fresh
 * install: `local-index.ts` `setConnectorDepth()` (writes the user's chosen
 * value), `local-index.ts` `recordSync()` (no production callers today), and
 * `connectors/health.ts` `upsertHealthRow()` — reached from
 * `transitionHealth()` on every sync success, pause/resume and error path,
 * and therefore the only path that creates a row for a connector whose depth
 * was never explicitly set. All three write `'full'` for an unchosen depth;
 * a site that omits the column would silently reintroduce the stale
 * `'summary'` default for every connector added AFTER this migration ran,
 * which this backfill cannot reach.
 */
export const DEPTH_DEFAULT_V49_SQL: readonly string[] = [
  "UPDATE sync_state SET depth = 'full' WHERE depth = 'summary'",
];
