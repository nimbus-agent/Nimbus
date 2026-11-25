import type { Database } from "bun:sqlite";
import { resolve } from "node:path";

import { fileExternalId } from "../ownership/ownership-pass.ts";
import { byCodeUnit } from "../util/canonical-json.ts";
import {
  type Evidence,
  type EvidenceRow,
  graphRootsForRepo,
  readEvidence,
} from "./debt-evidence.ts";
import type {
  ConfiguredRoot,
  DebtGap,
  DebtIncident,
  DebtInput,
  DebtResult,
  DebtSymbol,
} from "./debt-types.ts";
import type { GitHistory, GitHistoryFailure, GitHistoryReader } from "./git-history.ts";

/**
 * `nimbus incident debt` (Phase 10 IC7b, incident-engine spec 5.7): code symbols that sit in a file at least
 * `minIncidents` distinct incident records pointed at (through their change-lane PR) in the window, and whose
 * file has not been committed to for `untouchedDays` in the owner's local checkout.
 *
 * Pure over the local index plus an injected git reader; the only child process is that reader
 * (`git-history.ts`). A root is scanned only if the owner configured it as a git-aware
 * `[[filesystem.roots]]`; a repo no such root tracks is a Gap, never a guess.
 */

const DAY_MS = 86_400_000;
const SYMBOLS_PER_FILE_CAP = 200;
const INCIDENTS_SHOWN = 10;
const REPOS_NAMED = 5;

function normRoot(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

type FileEvidence = Map<string, Map<string, DebtIncident>>;
type RootEvidence = { readonly gitRoot: string; readonly files: FileEvidence };
type RootRef = { readonly graphRoot: string; readonly gitRoot: string };

type Judgement =
  | { readonly kind: "debt"; readonly lastTouchMs: number | null }
  | { readonly kind: "recent" }
  | { readonly kind: "unknown" }
  | { readonly kind: "truncated" }
  | { readonly kind: "skip" };

/** The relative path inside the root, or null when the path is outside the root's prefix. */
function relativeTo(prefix: string, path: string): string | null {
  if (prefix === "") return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function judge(h: GitHistory, rel: string, thresholdMs: number): Judgement {
  if (!h.tracked.has(rel)) return { kind: "skip" };
  const seen = h.lastTouchMs.get(rel);
  if (seen !== undefined) {
    return seen < thresholdMs ? { kind: "debt", lastTouchMs: seen } : { kind: "recent" };
  }
  if (h.complete) return { kind: "unknown" };
  if (h.oldestCommitMs !== null && h.oldestCommitMs <= thresholdMs) {
    return { kind: "debt", lastTouchMs: null };
  }
  return { kind: "truncated" };
}

type SymbolRow = { metadata: string; label: string };

function symbolsInFile(db: Database, root: string, rel: string): string[] {
  const rows = db
    .query(
      `SELECT s.metadata AS metadata, s.label AS label
         FROM graph_entity f
         JOIN graph_relation r ON r.to_id = f.id AND r.type = 'defined_in'
         JOIN graph_entity s ON s.id = r.from_id AND s.type = 'symbol'
        WHERE f.type = 'source_file' AND f.external_id = ?
        ORDER BY s.label ASC LIMIT ?`,
    )
    .all(fileExternalId(root, rel), SYMBOLS_PER_FILE_CAP) as SymbolRow[];
  const names: string[] = [];
  for (const row of rows) {
    let name: string | undefined;
    try {
      const m = JSON.parse(row.metadata) as { name?: unknown };
      if (typeof m.name === "string" && m.name !== "") name = m.name;
    } catch {
      // a malformed metadata column falls back to the label
    }
    names.push(name ?? row.label.split(" \u2014 ")[0] ?? row.label);
  }
  return names;
}

const FAILURE_CATEGORY: Readonly<Record<GitHistoryFailure, string>> = {
  not_a_repo: "not_a_repo",
  shallow: "history_shallow",
  git_failed: "git_failed",
  too_large: "history_too_large",
};

const FAILURE_TEXT: Readonly<Record<GitHistoryFailure, string>> = {
  not_a_repo: "is not a git repository (or has no commits)",
  shallow: "is a shallow clone, so its file dates cannot be trusted",
  git_failed: "could not be read (git failed, timed out or is not installed)",
  too_large: "has more tracked files than the scan reads",
};

function gap(category: string, detail: string, remediation?: string): DebtGap {
  return remediation === undefined ? { category, detail } : { category, detail, remediation };
}

function compareSymbols(a: DebtSymbol, b: DebtSymbol): number {
  if (a.incidentCount !== b.incidentCount) return b.incidentCount - a.incidentCount;
  const at = a.lastTouchMs ?? Number.NEGATIVE_INFINITY;
  const bt = b.lastTouchMs ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return at - bt;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return byCodeUnit(a.root, b.root);
}

/** The gaps the incident evidence itself discloses (records cut, unreadable, or pointing at no file). */
function evidenceGaps(ev: Evidence): DebtGap[] {
  const gaps: DebtGap[] = [];
  if (ev.recordCapHit) {
    gaps.push(gap("record_cap", "Only the newest incident records in the window were read."));
  }
  if (ev.noPr > 0) {
    gaps.push(
      gap(
        "no_pr_evidence",
        `${String(ev.noPr)} incident record(s) name no pull request, so they point at no file.`,
      ),
    );
  }
  if (ev.malformed > 0) {
    gaps.push(
      gap("record_unreadable", `${String(ev.malformed)} incident record(s) could not be read.`),
    );
  }
  if (ev.prFilesUnknown > 0) {
    gaps.push(
      gap(
        "pr_files_unknown",
        `${String(ev.prFilesUnknown)} incident record(s) name a pull request whose changed files are not indexed.`,
      ),
    );
  }
  if (ev.prFilesTruncated > 0) {
    gaps.push(
      gap(
        "pr_files_truncated",
        `${String(ev.prFilesTruncated)} incident record(s) name a pull request with more files than the index keeps.`,
      ),
    );
  }
  return gaps;
}

/** The configured, git-aware roots that track one repo (looked up once per repo). */
function rootsForRepo(
  db: Database,
  repoKey: string,
  allowed: ReadonlyMap<string, string>,
): RootRef[] {
  const roots: RootRef[] = [];
  for (const graphRoot of graphRootsForRepo(db, repoKey)) {
    const gitRoot = allowed.get(normRoot(graphRoot));
    if (gitRoot !== undefined) roots.push({ graphRoot, gitRoot });
  }
  return roots;
}

function addEvidence(byRoot: Map<string, RootEvidence>, ref: RootRef, row: EvidenceRow): void {
  let entry = byRoot.get(ref.graphRoot);
  if (entry === undefined) {
    entry = { gitRoot: ref.gitRoot, files: new Map() };
    byRoot.set(ref.graphRoot, entry);
  }
  let incidents = entry.files.get(row.path);
  if (incidents === undefined) {
    incidents = new Map();
    entry.files.set(row.path, incidents);
  }
  incidents.set(row.incident.id, row.incident);
}

/** Evidence grouped by (graph root, path), and the repos no configured root tracks. */
function groupByRoot(
  db: Database,
  rows: readonly EvidenceRow[],
  allowed: ReadonlyMap<string, string>,
): { byRoot: Map<string, RootEvidence>; notLocal: Set<string> } {
  const byRoot = new Map<string, RootEvidence>();
  const notLocal = new Set<string>();
  const rootsByRepo = new Map<string, RootRef[]>();
  for (const row of rows) {
    let roots = rootsByRepo.get(row.repoKey);
    if (roots === undefined) {
      roots = rootsForRepo(db, row.repoKey, allowed);
      rootsByRepo.set(row.repoKey, roots);
      if (roots.length === 0) notLocal.add(row.repoKey);
    }
    for (const ref of roots) addEvidence(byRoot, ref, row);
  }
  return { byRoot, notLocal };
}

function notLocalGap(notLocal: ReadonlySet<string>): DebtGap {
  const names = [...notLocal]
    .sort((a, b) => Number(a > b) - Number(a < b))
    .slice(0, REPOS_NAMED)
    .join(", ");
  const one = notLocal.size === 1;
  const noun = one ? "repository" : "repositories";
  const verb = one ? "is" : "are";
  const more = notLocal.size > REPOS_NAMED ? ", ..." : "";
  return gap(
    "repo_not_local",
    `${String(notLocal.size)} ${noun} named by incident evidence ${verb} not tracked by a git-aware filesystem root (${names}${more}).`,
    "Add the checkout as a [[filesystem.roots]] entry.",
  );
}

/** What the per-root pass counted, beside the symbols it found. */
type ScanTally = {
  readonly found: Map<string, DebtSymbol>;
  rootsScanned: number;
  filesJudged: number;
  unknown: number;
  noSymbols: number;
  truncated: number;
};

/** Records the symbols of one file judged to be debt (the newest incidents shown first). */
function recordDebtSymbols(
  db: Database,
  root: string,
  rel: string,
  incidents: ReadonlyMap<string, DebtIncident>,
  lastTouchMs: number | null,
  t: ScanTally,
): void {
  const shown = [...incidents.values()]
    .sort((a, b) => b.openedAtMs - a.openedAtMs || (a.id < b.id ? -1 : 1))
    .slice(0, INCIDENTS_SHOWN);
  const names = symbolsInFile(db, root, rel);
  if (names.length === 0) t.noSymbols += 1;
  for (const name of names) {
    t.found.set(`${root}\u0000${rel}\u0000${name}`, {
      name,
      file: rel,
      root,
      incidentCount: incidents.size,
      lastTouchMs,
      incidents: shown,
    });
  }
}

/** Judges each qualifying file of one scanned root and records its symbols when it is debt. */
function judgeRootFiles(
  db: Database,
  root: string,
  files: FileEvidence,
  history: GitHistory,
  p: { readonly minIncidents: number; readonly thresholdMs: number },
  t: ScanTally,
): void {
  for (const [path, incidents] of files) {
    if (incidents.size < p.minIncidents) continue;
    const rel = relativeTo(history.prefix, path);
    if (rel === null) continue;
    const verdict = judge(history, rel, p.thresholdMs);
    if (verdict.kind === "skip") continue;
    t.filesJudged += 1;
    if (verdict.kind === "unknown") t.unknown += 1;
    else if (verdict.kind === "truncated") t.truncated += 1;
    if (verdict.kind === "debt")
      recordDebtSymbols(db, root, rel, incidents, verdict.lastTouchMs, t);
  }
}

/** Reads each root's history (one root at a time) and judges its files; a failed read is a gap. */
async function scanRoots(
  db: Database,
  byRoot: ReadonlyMap<string, RootEvidence>,
  git: GitHistoryReader,
  p: { readonly minIncidents: number; readonly thresholdMs: number },
  gaps: DebtGap[],
): Promise<ScanTally> {
  const t: ScanTally = {
    found: new Map(),
    rootsScanned: 0,
    filesJudged: 0,
    unknown: 0,
    noSymbols: 0,
    truncated: 0,
  };
  for (const [root, { gitRoot, files }] of [...byRoot].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const result = await git(gitRoot);
    if (!result.ok) {
      gaps.push(
        gap(
          FAILURE_CATEGORY[result.reason],
          `The checkout at ${gitRoot} ${FAILURE_TEXT[result.reason]}.`,
        ),
      );
      continue;
    }
    t.rootsScanned += 1;
    judgeRootFiles(db, root, files, result.history, p, t);
  }
  return t;
}

/** The gaps the scan's own counts disclose, in a fixed order. */
function scanGaps(input: DebtInput, t: ScanTally): DebtGap[] {
  const gaps: DebtGap[] = [];
  if (t.noSymbols > 0) {
    gaps.push(
      gap(
        "no_symbols_indexed",
        `${String(t.noSymbols)} qualifying file(s) have no indexed symbol (not code, or the root's code index is off), so they are not listed.`,
        "Set code_index = true on the root.",
      ),
    );
  }
  if (input.sinceDays <= input.untouchedDays) {
    gaps.push(
      gap(
        "window_too_short",
        "No incident in the window is old enough to qualify: the change an incident points at touched the file after the untouched period began.",
        "Use a --since longer than --untouched.",
      ),
    );
  }
  if (t.unknown > 0) {
    gaps.push(
      gap(
        "last_touch_unknown",
        `${String(t.unknown)} file(s) have no commit in the history read (merge-only changes), so they were not judged.`,
      ),
    );
  }
  if (t.truncated > 0) {
    gaps.push(
      gap(
        "history_truncated",
        `${String(t.truncated)} file(s) were not judged: the history read is capped and its oldest commit is newer than the untouched period.`,
        "Raise --untouched or clone the full history.",
      ),
    );
  }
  return gaps;
}

export async function scanDebt(
  db: Database,
  input: DebtInput,
  configured: readonly ConfiguredRoot[],
  git: GitHistoryReader,
): Promise<DebtResult> {
  const base = {
    windowDays: input.sinceDays,
    untouchedDays: input.untouchedDays,
    minIncidents: input.minIncidents,
  };
  const empty = {
    symbols: [] as DebtSymbol[],
    omitted: 0,
    counts: { incidentsScanned: 0, rootsScanned: 0, filesJudged: 0 },
  };
  // normalised spelling -> the owner's configured spelling: ONLY the latter ever reaches git's argv.
  const allowed = new Map(
    configured.filter((c) => c.gitAware).map((c) => [normRoot(c.path), c.path]),
  );
  if (allowed.size === 0) {
    return {
      ...base,
      ...empty,
      status: "no_roots",
      gaps: [
        gap(
          "no_git_roots",
          "No git-aware [[filesystem.roots]] is configured, so there is no local history to read.",
          "Add a root with git_aware = true to nimbus.toml.",
        ),
      ],
    };
  }

  const ev = readEvidence(db, input.nowMs, input.sinceDays);
  if (ev.incidentsScanned === 0) {
    return {
      ...base,
      ...empty,
      status: "no_incidents",
      gaps: [gap("no_incidents", "No incident record was opened in the window.")],
    };
  }
  const gaps = evidenceGaps(ev);
  // repo -> the configured, git-aware roots that track it; evidence grouped by (graph root, path).
  const { byRoot, notLocal } = groupByRoot(db, ev.rows, allowed);
  if (notLocal.size > 0) gaps.push(notLocalGap(notLocal));

  const thresholdMs = input.nowMs - input.untouchedDays * DAY_MS;
  const tally = await scanRoots(
    db,
    byRoot,
    git,
    { minIncidents: input.minIncidents, thresholdMs },
    gaps,
  );
  gaps.push(...scanGaps(input, tally));

  const all = [...tally.found.values()].sort(compareSymbols);
  const symbols = all.slice(0, input.limit);
  return {
    ...base,
    status: symbols.length > 0 ? "ok" : "none",
    symbols,
    omitted: all.length - symbols.length,
    gaps,
    counts: {
      incidentsScanned: ev.incidentsScanned,
      rootsScanned: tally.rootsScanned,
      filesJudged: tally.filesJudged,
    },
  };
}
