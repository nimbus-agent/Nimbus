import type { Database } from "bun:sqlite";

export function listGithubReposFromIndex(db: Database): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT json_extract(metadata, '$.repo') AS repo
       FROM item
       WHERE service = 'github'
         AND json_extract(metadata, '$.repo') IS NOT NULL
         AND length(trim(json_extract(metadata, '$.repo'))) > 0`,
    )
    .all() as { repo: string | null }[];
  const out: string[] = [];
  for (const r of rows) {
    const repo = typeof r.repo === "string" ? r.repo.trim() : "";
    if (repo !== "" && !out.includes(repo)) {
      out.push(repo);
    }
  }
  return out;
}
