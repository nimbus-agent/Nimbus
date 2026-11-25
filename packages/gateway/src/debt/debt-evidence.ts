import type { Database } from "bun:sqlite";

import type { DebtIncident } from "./debt-types.ts";

/**
 * What the incidents in the window point at (Phase 10 IC7b): for each assembled incident record, the files
 * of the PR its change lane named. Read-only SELECTs over `incident_record`, `pr_changed_file` and
 * `pr_files_state`; nothing here spawns or writes.
 *
 * Sentry is NOT evidence: `culprit` is free text joined into the issue body and no frame or file name is
 * stored, so there is no file to name (stated bound).
 */

const DAY_MS = 86_400_000;
/** Records read per scan; a hit is a Gap, never silent. */
export const DEBT_RECORD_CAP = 5_000;
/** Files read per PR; the changed-file store already caps what it keeps. */
const PR_FILE_CAP = 2_001;

export type EvidenceRow = {
  readonly incident: DebtIncident;
  /** `<service>:<owner>/<name>`, lower-cased (the graph `repo` entity id, compared case-insensitively). */
  readonly repoKey: string;
  /** Repo-root-relative, forward slashes (as the forge reports it). */
  readonly path: string;
};

export type Evidence = {
  readonly rows: readonly EvidenceRow[];
  readonly incidentsScanned: number;
  readonly noPr: number;
  readonly malformed: number;
  readonly prFilesUnknown: number;
  readonly prFilesTruncated: number;
  readonly recordCapHit: boolean;
};

type RecordRow = { id: string; title: string; opened_at_ms: number; record_json: string };
type FileRow = { repo_full: string; path: string };

type PrRef = { readonly id: string; readonly service: string };

/** The change lane's PR, read defensively from stored JSON (a hand-edited or older record never throws). */
export function prOf(recordJson: string): PrRef | "malformed" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordJson);
  } catch {
    return "malformed";
  }
  if (parsed === null || typeof parsed !== "object") return "malformed";
  const change = (parsed as { change?: unknown }).change;
  if (change === null || typeof change !== "object") return "malformed";
  const pr = (change as { pr?: unknown }).pr;
  if (pr === null || pr === undefined) return null;
  if (typeof pr !== "object") return "malformed";
  const { id, service } = pr as { id?: unknown; service?: unknown };
  if (typeof id !== "string" || id === "" || typeof service !== "string" || service === "") {
    return "malformed";
  }
  return { id, service };
}

/** Reads one PR's changed files (null when its file list was never fetched) and whether it was cut. */
function loadPrFiles(
  db: Database,
  prId: string,
  filesByPr: Map<string, readonly FileRow[] | null>,
  truncatedByPr: Map<string, boolean>,
): void {
  const state = db.query("SELECT truncated FROM pr_files_state WHERE item_id = ?").get(prId) as {
    truncated: number;
  } | null;
  truncatedByPr.set(prId, state?.truncated === 1);
  filesByPr.set(
    prId,
    state === null
      ? null
      : (db
          .query(
            "SELECT repo_full, path FROM pr_changed_file WHERE item_id = ? AND status <> 'removed' ORDER BY path ASC LIMIT ?",
          )
          .all(prId, PR_FILE_CAP) as FileRow[]),
  );
}

export function readEvidence(db: Database, nowMs: number, sinceDays: number): Evidence {
  const sinceMs = nowMs - sinceDays * DAY_MS;
  const records = db
    .query(
      `SELECT id, title, opened_at_ms, record_json FROM incident_record
        WHERE opened_at_ms IS NOT NULL AND opened_at_ms >= ?1 AND opened_at_ms <= ?2
        ORDER BY opened_at_ms DESC, id ASC LIMIT ?3`,
    )
    .all(sinceMs, nowMs, DEBT_RECORD_CAP) as RecordRow[];

  const rows: EvidenceRow[] = [];
  let noPr = 0;
  let malformed = 0;
  let prFilesUnknown = 0;
  let prFilesTruncated = 0;
  const filesByPr = new Map<string, readonly FileRow[] | null>();
  const truncatedByPr = new Map<string, boolean>();

  for (const rec of records) {
    const pr = prOf(rec.record_json);
    if (pr === "malformed") {
      malformed += 1;
      continue;
    }
    if (pr === null) {
      noPr += 1;
      continue;
    }
    if (!filesByPr.has(pr.id)) loadPrFiles(db, pr.id, filesByPr, truncatedByPr);
    const files = filesByPr.get(pr.id);
    if (files === null || files === undefined) {
      prFilesUnknown += 1;
      continue;
    }
    if (truncatedByPr.get(pr.id) === true) prFilesTruncated += 1;
    const incident: DebtIncident = { id: rec.id, title: rec.title, openedAtMs: rec.opened_at_ms };
    for (const f of files) {
      rows.push({
        incident,
        repoKey: `${pr.service}:${f.repo_full}`.toLowerCase(),
        path: f.path,
      });
    }
  }
  return {
    rows,
    incidentsScanned: records.length,
    noPr,
    malformed,
    prFilesUnknown,
    prFilesTruncated,
    recordCapHit: records.length >= DEBT_RECORD_CAP,
  };
}

type WorkspaceRow = { external_id: string };

/**
 * The local workspace roots tracking a repo (`workspace --tracks_remote--> repo`), the walk
 * `index/resolve-file-by-remote.ts` documents. Returns the root strings exactly as the graph spells them.
 */
export function graphRootsForRepo(db: Database, repoKey: string): string[] {
  const rows = db
    .query(
      `SELECT w.external_id AS external_id
         FROM graph_entity r
         JOIN graph_relation tr ON tr.to_id = r.id AND tr.type = 'tracks_remote'
         JOIN graph_entity w ON w.id = tr.from_id AND w.type = 'workspace'
        WHERE r.type = 'repo' AND LOWER(r.external_id) = LOWER(?)
          AND w.external_id LIKE 'filesystem:%'
        ORDER BY w.external_id ASC`,
    )
    .all(repoKey) as WorkspaceRow[];
  return rows.map((r) => r.external_id.slice("filesystem:".length));
}
