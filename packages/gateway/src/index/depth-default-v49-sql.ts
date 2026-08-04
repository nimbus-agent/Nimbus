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
 * when the two code sites that insert rows fully determine the value.
 */
export const DEPTH_DEFAULT_V49_SQL: readonly string[] = [
  "UPDATE sync_state SET depth = 'full' WHERE depth = 'summary'",
];
