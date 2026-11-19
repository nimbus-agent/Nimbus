import type { Database } from "bun:sqlite";

import type { GapNote } from "@nimbus-dev/sdk";

import type {
  PrereviewBrief,
  PrereviewCoChange,
  PrereviewCounts,
  PrereviewPrRef,
  PrereviewReviewNote,
  PrereviewSize,
  PrereviewTarget,
  PrereviewTerm,
} from "../agents/_lib/prreview-types.ts";
import { resolveItemByUrl } from "../index/resolve-by-url.ts";

/**
 * The deterministic core of `nimbus pre-review` (Phase 10 "Automated PR pre-review"). READS the local index
 * only: no network, no connector, no executor, no model, no write, no clock of its own (the caller passes
 * `nowMs`). Every statement it makes is grounded in two real substrates, and says which:
 *
 *   - co-change: the paths the team's MERGED PRs of the same repository touched beside the areas this PR
 *     touches (`pr_changed_file`, V55, written by `prfiles/pr-changed-file-store.ts` for GitHub, GitLab and
 *     Bitbucket), counting only PRs whose file list is complete (`pr_files_state.truncated = 0`);
 *   - the OWNER's own past review text on those PRs (GitHub `review` items, written by
 *     `connectors/github-sync.ts` `upsertReview` from the authenticated user's events feed: no other person's
 *     review and no inline comment is indexed).
 *
 * Co-change is correlation in merged history, never a rule; the wording the renderer uses says so.
 */

export const HISTORY_MAX = 400;
export const HISTORY_DAYS = 365;
export const AREAS_MAX = 20;
export const MIN_COHORT = 4;
export const MIN_SUPPORT = 0.6;
export const FINDINGS_MAX = 10;
export const EXAMPLES_MAX = 3;
export const REVIEWS_SCANNED = 200;
export const REVIEWS_SHOWN = 6;
export const REVIEWS_PER_PR = 2;
export const TERMS_MAX = 8;
export const MIN_REVIEWS_FOR_TERM = 2;

const DAY_MS = 86_400_000;
const REVIEW_STATES = new Set(["CHANGES_REQUESTED", "COMMENTED"]);
const PR_SERVICES = new Set(["github", "gitlab", "bitbucket"]);

export type PrereviewMissReason = "not_indexed" | "ambiguous" | "not_a_pr" | "unresolvable_url";

export class PrereviewError extends Error {
  readonly code: "ERR_PREREVIEW_UNRESOLVED";
  readonly reason: PrereviewMissReason;
  constructor(reason: PrereviewMissReason, message: string) {
    super(`ERR_PREREVIEW_UNRESOLVED: ${message}`);
    this.name = "PrereviewError";
    this.code = "ERR_PREREVIEW_UNRESOLVED";
    this.reason = reason;
  }
}

const MISS_TEXT: Readonly<Record<PrereviewMissReason, string>> = {
  not_indexed:
    "that pull request is not in the local index (run `nimbus connector sync <service>`)",
  ambiguous: "that URL matches more than one indexed item; pass the pull request's own URL",
  not_a_pr: "that URL resolves to an indexed item that is not a pull request or merge request",
  unresolvable_url: "that is not an http or https URL",
};

/** Code-unit order: deterministic and locale-free. */
function byString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The parent directory of a POSIX repo-relative path; a root file's area is `.`. */
export function areaOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "." : path.slice(0, i);
}

/** True when `path` is `dir` itself or lies under it. `.` contains every path. */
export function isUnder(path: string, dir: string): boolean {
  if (dir === ".") return true;
  return path === dir || path.startsWith(`${dir}/`);
}

type ItemRow = {
  id: string;
  service: string;
  title: string;
  url: string | null;
  metadata: string | null;
};

function parseMeta(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * The indexed PR a URL names. One ambiguity is resolved rather than refused: a GitHub review is stored with its
 * `html_url` (`.../pull/7#pullrequestreview-1`), whose canonical form drops the fragment, so EVERY pull request
 * the owner reviewed shares its resolve key with that review. When the candidates are exactly one PR plus
 * reviews of the same service (and the list is not cut), the PR is the answer; anything else stays ambiguous.
 */
function pickPrId(db: Database, url: string): string {
  const res = resolveItemByUrl(db, url);
  if (res.found) {
    if (res.item.type !== "pr" || !PR_SERVICES.has(res.item.service)) {
      throw new PrereviewError("not_a_pr", MISS_TEXT.not_a_pr);
    }
    return res.item.id;
  }
  if (res.reason === "ambiguous" && !res.truncated) {
    const prs = res.candidates.filter((c) => c.type === "pr" && PR_SERVICES.has(c.service));
    const onlyReviews = res.candidates.every(
      (c) => c.type === "pr" || (c.type === "review" && c.service === prs[0]?.service),
    );
    if (prs.length === 1 && onlyReviews) return (prs[0] as { id: string }).id;
  }
  throw new PrereviewError(res.reason, MISS_TEXT[res.reason]);
}

function resolveTarget(db: Database, url: string): ItemRow {
  const id = pickPrId(db, url);
  const row = db
    .query("SELECT id, service, title, url, metadata FROM item WHERE id = ?")
    .get(id) as ItemRow | null;
  // The resolver read this row a moment ago in the same synchronous call, so it exists.
  return row as ItemRow;
}

type CoverageRow = { truncated: number; api_file_count: number };

function filesOf(db: Database, itemId: string): string[] {
  const rows = db.query("SELECT path FROM pr_changed_file WHERE item_id = ?").all(itemId) as Array<{
    path: string;
  }>;
  return rows.map((r) => r.path).sort(byString);
}

function coverageOf(db: Database, itemId: string): CoverageRow | null {
  return db
    .query("SELECT truncated, api_file_count FROM pr_files_state WHERE item_id = ?")
    .get(itemId) as CoverageRow | null;
}

type HistoryPr = {
  readonly ref: PrereviewPrRef;
  readonly number: number | null;
  readonly files: readonly string[];
  readonly size: number | null;
};

type HistoryRow = ItemRow & { merged_at: number | null; truncated: number | null };

function loadHistory(
  db: Database,
  target: ItemRow,
  repo: string,
  nowMs: number,
): { history: HistoryPr[]; noCoverage: number; truncated: number } {
  const since = nowMs - HISTORY_DAYS * DAY_MS;
  const rows = db
    .query(
      `SELECT i.id, i.service, i.title, i.url, i.metadata,
              CAST(json_extract(i.metadata, '$.merged_at') AS INTEGER) AS merged_at,
              COALESCE(CAST(json_extract(i.metadata, '$.merged_at') AS INTEGER), i.modified_at) AS recency,
              s.truncated AS truncated
         FROM item i
         LEFT JOIN pr_files_state s ON s.item_id = i.id
        WHERE i.service = ? AND i.type = 'pr' AND i.id <> ?
          AND json_extract(i.metadata, '$.repo') = ?
          AND json_extract(i.metadata, '$.state') = 'merged'
          AND COALESCE(CAST(json_extract(i.metadata, '$.merged_at') AS INTEGER), i.modified_at) >= ?
        ORDER BY recency DESC, i.id ASC
        LIMIT ?`,
    )
    .all(target.service, target.id, repo, since, HISTORY_MAX) as HistoryRow[];
  const history: HistoryPr[] = [];
  let noCoverage = 0;
  let truncated = 0;
  for (const r of rows) {
    if (r.truncated === null) {
      noCoverage++;
      continue;
    }
    if (r.truncated !== 0) {
      truncated++;
      continue;
    }
    const meta = parseMeta(r.metadata);
    const add = numOrNull(meta["additions"]);
    const del = numOrNull(meta["deletions"]);
    history.push({
      ref: { itemId: r.id, title: r.title, url: r.url, mergedAtMs: r.merged_at },
      number: numOrNull(meta["number"]),
      files: filesOf(db, r.id),
      size: add !== null && del !== null ? add + del : null,
    });
  }
  return { history, noCoverage, truncated };
}

/** The areas of `files`, most files first then path ascending, capped at {@link AREAS_MAX}. */
export function areasOf(files: readonly string[]): { areas: string[]; total: number } {
  const counts = new Map<string, number>();
  for (const f of files) {
    const a = areaOf(f);
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const ordered = [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || byString(x[0], y[0]))
    .map(([a]) => a);
  return { areas: ordered.slice(0, AREAS_MAX), total: ordered.length };
}

function touchesKey(files: readonly string[], key: string, kind: "file" | "directory"): boolean {
  return kind === "file" ? files.includes(key) : files.some((f) => isUnder(f, key));
}

type Candidate = { key: string; kind: "file" | "directory"; prs: HistoryPr[] };

/** Drops a directory finding when another finding of the same area lies strictly under it (the more specific wins). */
function mostSpecific(kept: readonly Candidate[]): Candidate[] {
  return kept.filter(
    (c) =>
      c.kind === "file" || !kept.some((o) => o !== c && o.key !== c.key && isUnder(o.key, c.key)),
  );
}

/**
 * The co-change findings for ONE area (spec § 3.3). Pure over its inputs, exported for the threshold tests.
 * Returns null when the area has too little history to judge.
 */
export function coChangesForArea(
  area: string,
  targetFiles: readonly string[],
  history: readonly HistoryPr[],
): PrereviewCoChange[] | null {
  const cohort = history.filter((pr) => pr.files.some((f) => isUnder(areaOf(f), area)));
  if (cohort.length < MIN_COHORT) return null;
  const candidates = new Map<string, Candidate>();
  const add = (key: string, kind: "file" | "directory", pr: HistoryPr): void => {
    const id = `${kind}\u0000${key}`;
    const c = candidates.get(id) ?? { key, kind, prs: [] };
    if (!c.prs.includes(pr)) c.prs.push(pr);
    candidates.set(id, c);
  };
  for (const pr of cohort) {
    for (const f of pr.files) {
      add(f, "file", pr);
      add(areaOf(f), "directory", pr);
    }
  }
  const kept: Candidate[] = [];
  for (const c of candidates.values()) {
    const count = c.prs.length;
    if (count < MIN_COHORT || count / cohort.length < MIN_SUPPORT) continue;
    // A directory the PR already touches (its own area, any ancestor of a touched path) is "touched", so it
    // can never be reported: `touchesKey` treats a directory as touched when any path lies under it.
    if (touchesKey(targetFiles, c.key, c.kind)) continue;
    kept.push(c);
  }
  return mostSpecific(kept).map(
    (c): PrereviewCoChange => ({
      area,
      companion: c.key,
      companionKind: c.kind,
      count: c.prs.length,
      cohort: cohort.length,
      examples: c.prs.slice(0, EXAMPLES_MAX).map((p) => p.ref),
    }),
  );
}

function rankCoChanges(a: PrereviewCoChange, b: PrereviewCoChange): number {
  return (
    b.count / b.cohort - a.count / a.cohort ||
    b.cohort - a.cohort ||
    byString(a.companion, b.companion) ||
    byString(a.area, b.area)
  );
}

type ReviewRow = { body: string | null; modified_at: number; metadata: string | null };

function reviewsFor(
  db: Database,
  repo: string,
  prs: ReadonlyMap<number, PrereviewPrRef>,
): PrereviewReviewNote[] {
  if (prs.size === 0) return [];
  const rows = db
    .query(
      `SELECT body, modified_at, metadata FROM item
        WHERE service = 'github' AND type = 'review'
          AND json_extract(metadata, '$.repo') = ?
          AND upper(json_extract(metadata, '$.state')) IN ('CHANGES_REQUESTED', 'COMMENTED')
          AND body IS NOT NULL AND trim(body) <> ''
        ORDER BY modified_at DESC, id ASC
        LIMIT ?`,
    )
    .all(repo, REVIEWS_SCANNED) as ReviewRow[];
  const out: PrereviewReviewNote[] = [];
  for (const r of rows) {
    const meta = parseMeta(r.metadata);
    const num = numOrNull(meta["pr_number"]);
    const state = strOrNull(meta["state"])?.toUpperCase() ?? "";
    const pr = num === null ? undefined : prs.get(num);
    if (pr === undefined || !REVIEW_STATES.has(state) || r.body === null) continue;
    out.push({ pr, state, reviewedAtMs: r.modified_at, body: r.body });
  }
  return out;
}

const STOPWORDS = new Set(
  (
    "this that with from have will would could should there their they them then than what when where which " +
    "while also just like here into only some more most such very your yours about after before again being " +
    "does done each every make made need needs please thanks thank maybe still think looks look good great " +
    "nice small minor nits nit change changes changed code file files line lines test tests pull request"
  ).split(" "),
);

/** Words in at least {@link MIN_REVIEWS_FOR_TERM} distinct reviews, top {@link TERMS_MAX}. A count, not a summary. */
export function recurringTerms(bodies: readonly string[]): PrereviewTerm[] {
  const seen = new Map<string, number>();
  for (const body of bodies) {
    const words = new Set(body.toLowerCase().match(/[a-z0-9_-]{4,32}/g) ?? []);
    for (const w of words) {
      if (STOPWORDS.has(w) || /^[0-9_-]+$/.test(w)) continue;
      seen.set(w, (seen.get(w) ?? 0) + 1);
    }
  }
  return [...seen.entries()]
    .filter(([, n]) => n >= MIN_REVIEWS_FOR_TERM)
    .sort((a, b) => b[1] - a[1] || byString(a[0], b[0]))
    .slice(0, TERMS_MAX)
    .map(([term, reviews]) => ({ term, reviews }));
}

function sizeOf(
  targetMeta: Record<string, unknown>,
  cohort: readonly HistoryPr[],
): PrereviewSize | null {
  const add = numOrNull(targetMeta["additions"]);
  const del = numOrNull(targetMeta["deletions"]);
  if (add === null || del === null) return null;
  const sizes = cohort
    .map((p) => p.size)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (sizes.length < MIN_COHORT) return null;
  const total = add + del;
  const mid = Math.floor(sizes.length / 2);
  const median =
    sizes.length % 2 === 1
      ? (sizes[mid] as number)
      : Math.round(((sizes[mid - 1] as number) + (sizes[mid] as number)) / 2);
  const smaller = sizes.filter((s) => s < total).length;
  return {
    total,
    cohortMedian: median,
    percentile: Math.floor((smaller * 100) / sizes.length),
    comparable: sizes.length,
  };
}

const ALWAYS_GAP: GapNote = {
  category: "missing_relation_emit",
  detail:
    "These checks come from co-change in this repository's merged pull requests and from your own past reviews; the index holds no other reviewer's comments and no inline review comments.",
};
const OWNERS_GAP: GapNote = {
  category: "missing_relation_emit",
  detail:
    "Owners of the touched paths are not shown: the index does not link a pull request's paths to local files.",
  remediation: "run `nimbus owners <path>` in a local checkout",
};

/** Builds the pre-review brief for `url`. Throws {@link PrereviewError} when the URL is not an indexed PR. */
export function buildPrereviewBrief(db: Database, url: string, nowMs: number): PrereviewBrief {
  const row = resolveTarget(db, url);
  const meta = parseMeta(row.metadata);
  const repo = strOrNull(meta["repo"]) ?? "";
  const coverage = coverageOf(db, row.id);
  const files = filesOf(db, row.id);
  const target: PrereviewTarget = {
    itemId: row.id,
    service: row.service,
    repo,
    number: numOrNull(meta["number"]),
    title: row.title,
    url: row.url,
    state: strOrNull(meta["state"]),
    files,
    filesCovered: coverage !== null,
    filesTruncated: coverage !== null && coverage.truncated !== 0,
    apiFileCount: coverage === null ? null : coverage.api_file_count,
  };
  const gaps: GapNote[] = [ALWAYS_GAP];
  const { history, noCoverage, truncated } =
    repo === "" ? { history: [], noCoverage: 0, truncated: 0 } : loadHistory(db, row, repo, nowMs);
  const { areas, total } = areasOf(files);
  const all: PrereviewCoChange[] = [];
  let thin = 0;
  const cohortIds = new Set<string>();
  // A truncated file list proves what the PR touches, never what it does not, so it gets no co-change finding.
  const canJudgeAbsence = coverage !== null && coverage.truncated === 0;
  for (const area of areas) {
    const found = coChangesForArea(area, files, history);
    if (found === null) {
      thin++;
      continue;
    }
    if (canJudgeAbsence) all.push(...found);
    for (const pr of history) {
      if (pr.files.some((f) => isUnder(areaOf(f), area))) cohortIds.add(pr.ref.itemId);
    }
  }
  const seenCompanion = new Set<string>();
  const ranked = [...all].sort(rankCoChanges).filter((c) => {
    const k = `${c.companionKind}\u0000${c.companion}`;
    if (seenCompanion.has(k)) return false;
    seenCompanion.add(k);
    return true;
  });
  const coChanges = ranked.slice(0, FINDINGS_MAX);
  const cohort = history.filter((p) => cohortIds.has(p.ref.itemId));

  let reviewNotes: PrereviewReviewNote[] | null = null;
  let reviewTerms: PrereviewTerm[] = [];
  let matched = 0;
  if (row.service === "github") {
    const byNumber = new Map<number, PrereviewPrRef>();
    for (const p of cohort) if (p.number !== null) byNumber.set(p.number, p.ref);
    const notes = reviewsFor(db, repo, byNumber);
    matched = notes.length;
    const perPr = new Map<string, number>();
    reviewNotes = notes
      .filter((n) => {
        const k = perPr.get(n.pr.itemId) ?? 0;
        perPr.set(n.pr.itemId, k + 1);
        return k < REVIEWS_PER_PR;
      })
      .slice(0, REVIEWS_SHOWN);
    reviewTerms = recurringTerms(notes.map((n) => n.body));
  } else {
    gaps.push({
      category: "missing_connector",
      detail: `No review data is indexed for ${row.service}: only your own GitHub reviews are indexed, so the review lane and the size comparison are empty.`,
    });
  }
  const size = sizeOf(meta, cohort);
  if (row.service === "bitbucket") {
    gaps.push({
      category: "missing_entity_type",
      detail:
        "Bitbucket records no merge time, so the history window uses each pull request's last update time instead.",
    });
  }

  if (coverage === null) {
    gaps.push({
      category: "missing_entity_type",
      detail:
        "This pull request's changed files are not in the index, so no area-based check could run.",
      remediation: `run \`nimbus connector sync ${row.service}\``,
    });
  } else if (coverage.truncated !== 0) {
    gaps.push({
      category: "missing_entity_type",
      detail: `This pull request's file list is incomplete in the index (${String(files.length)} of ${String(coverage.api_file_count)} files stored), so no co-change check is shown: a missing file might be among the unstored ones.`,
    });
  }
  if (noCoverage > 0 || truncated > 0) {
    gaps.push({
      category: "missing_entity_type",
      detail: `${String(noCoverage)} merged pull request(s) with no indexed file list and ${String(truncated)} with an incomplete one were left out of the history.`,
    });
  }
  if (thin > 0) {
    gaps.push({
      category: "empty_index",
      detail: `${String(thin)} area(s) had fewer than ${String(MIN_COHORT)} comparable merged pull requests and were not judged.`,
    });
  }
  if (total > areas.length) {
    gaps.push({
      category: "empty_index",
      detail: `Only the ${String(areas.length)} largest of ${String(total)} touched areas were checked.`,
    });
  }
  if (ranked.length > coChanges.length) {
    gaps.push({
      category: "empty_index",
      detail: `${String(ranked.length - coChanges.length)} further co-change finding(s) are not shown.`,
    });
  }
  if (row.service === "github" && size === null) {
    gaps.push({
      category: "missing_entity_type",
      detail: `No size comparison: it needs this pull request's line counts and at least ${String(MIN_COHORT)} comparable merged pull requests with theirs.`,
    });
  }
  gaps.push(OWNERS_GAP);

  const counts: PrereviewCounts = {
    historyUsed: history.length,
    historyNoCoverage: noCoverage,
    historyTruncated: truncated,
    areasTotal: total,
    areasCut: total - areas.length,
    areasThinHistory: thin,
    findingsCut: ranked.length - coChanges.length,
    reviewsMatched: matched,
  };
  return {
    kind: "pr_prereview",
    agentVersion: 1,
    generatedAt: nowMs,
    latencyMs: 0,
    gaps,
    target,
    coChanges,
    reviewNotes,
    reviewTerms,
    size,
    counts,
  };
}
