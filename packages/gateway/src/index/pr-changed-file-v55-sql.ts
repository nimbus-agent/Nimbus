/**
 * V55 — PR changed-file paths plus their coverage record.
 *
 * Keyed on `item.id` (already `itemPrimaryKey(service, externalId)`) rather than on
 * `(service, pr_external_id)`: the pair is redundant, and the cascade gives pruning for free.
 * Same shape as `deployment-v28-sql.ts` and `embedding-v6-sql.ts`, and the cascade actually
 * fires — `index/local-index.ts` runs `PRAGMA foreign_keys = ON`.
 *
 * ONE ROW PER TOUCHED PATH. A rename writes two rows (old and new), a deletion writes one, so a
 * single index on `path` answers "did this PR touch X" with no special cases. `counterpart_path`
 * records a rename's other half for display; nothing correctness-bearing reads it.
 *
 * `pr_files_state` is the coverage record. Its cascade matters in the opposite direction from
 * storage hygiene: a coverage row outliving its PR would claim "we know this PR's files" after the
 * file rows were cascaded away — asserting verification the index no longer holds.
 *
 * Both enum-like columns carry a `CHECK`, per the new-table checklist in the `nimbus-db-migrations`
 * skill. Neither is decorative: `status` is the full domain of `ChangedFileStatus`, and all three
 * forge mappers in `prfiles/pr-file-mapping.ts` are TOTAL onto it (each normalises the forge's own
 * vocabulary — GitHub's six statuses, GitLab's three booleans, Bitbucket's strings — into exactly
 * these four), so the constraint is the schema-level restatement of a type the write path already
 * guarantees. `truncated` is written as `1`/`0` by `recordPrChangedFiles`, and it is the column the
 * negation query filters on — a value outside `{0,1}` would silently drop a PR out of BOTH
 * `truncated = 0` and `truncated = 1`, making it invisible to the negation AND to the exclusion
 * count that is supposed to disclose it.
 */
export const PR_CHANGED_FILE_V55_SQL = `
CREATE TABLE IF NOT EXISTS pr_changed_file (
  item_id          TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  repo_full        TEXT NOT NULL,
  path             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('added','modified','removed','renamed')),
  counterpart_path TEXT,
  local_file_id    TEXT REFERENCES graph_entity(id) ON DELETE SET NULL,
  PRIMARY KEY (item_id, path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_pr_changed_file_path ON pr_changed_file(path);
CREATE INDEX IF NOT EXISTS idx_pr_changed_file_local ON pr_changed_file(local_file_id);

CREATE TABLE IF NOT EXISTS pr_files_state (
  item_id        TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  fetched_at_ms  INTEGER NOT NULL,
  api_file_count INTEGER NOT NULL,
  stored_count   INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1))
) WITHOUT ROWID;
`;
