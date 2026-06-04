export const V32_GIT_BLAME_LINE_SQL = `
CREATE TABLE IF NOT EXISTS git_blame_line (
  repo_root        TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  line_no          INTEGER NOT NULL,
  commit_sha       TEXT NOT NULL,
  author_name      TEXT,
  author_email     TEXT,
  author_time_ms   INTEGER,
  PRIMARY KEY (repo_root, file_path, line_no)
) WITHOUT ROWID;
`.trim();
