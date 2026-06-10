import { computeFindingFingerprint } from "./finding-fingerprint.ts";
import { buildContextSnippet, redactSecret, type SecretPattern } from "./secret-patterns.ts";

export interface ScanItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly body_preview: string | null;
  readonly metadata: string | null;
  readonly modified_at: number;
  readonly url: string | null;
  /** The item's connector-stable external id (falls back to `id` when absent). */
  readonly external_id?: string;
}

export interface FindingBlame {
  readonly commit_sha: string;
  readonly author_name: string | null;
  readonly author_email: string | null;
  readonly author_time_ms: number | null;
}

export interface SecurityFinding {
  readonly item_id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly pattern_name: string;
  readonly pattern_category: "api_key" | "private_key" | "token";
  readonly match_redacted: string;
  readonly match_offset: number;
  readonly context_snippet: string;
  readonly modified_at_ms: number;
  readonly url: string | null;
  readonly fingerprint: string;
  readonly external_id: string;
  readonly blame: FindingBlame | null;
}

export interface PureScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: 0;
  readonly findings_count: number;
  readonly muted_count: number;
  readonly findings: readonly SecurityFinding[];
}

export interface BlameResolution {
  readonly commitSha: string;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
  readonly authorTimeMs: number | null;
}

export interface ScanOptions {
  /** Finding fingerprints to mute (known false positives). */
  readonly allowlist: ReadonlySet<string>;
  /** Resolve indexed blame for a `code_symbol` finding at an absolute file line. */
  readonly resolveBlame?: (item: ScanItem, absLine: number) => BlameResolution | null;
}

/**
 * Map a `body_preview` match offset to its absolute file line for a `code_symbol`
 * item. body_preview is "<relPath>\n<excerpt>"; the first line is the path header,
 * so the real file line = excerptStartLine + (bodyLine - 1). Returns null unless
 * the item carries an `excerptStartLine` and the offset is past the header line.
 */
function absoluteLineFor(item: ScanItem, body: string, offset: number): number | null {
  if (item.type !== "code_symbol" || item.metadata === null) return null;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(item.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
  const start = meta["excerptStartLine"];
  if (typeof start !== "number") return null;
  // Count newlines up to offset (allocation-free) → 0-based body line.
  let linesBefore = 0;
  const end = Math.min(offset, body.length);
  for (let i = 0; i < end; i++) {
    if (body.codePointAt(i) === 10) linesBefore++;
  }
  if (linesBefore < 1) return null; // offset is in the path header line
  return start + (linesBefore - 1); // subtract the header line
}

const NO_OPTIONS: ScanOptions = { allowlist: new Set<string>() };

/** Resolve indexed blame for a match (code_symbol items only), in snake_case finding shape. */
function resolveFindingBlame(
  row: ScanItem,
  body: string,
  offset: number,
  options: ScanOptions,
): FindingBlame | null {
  const absLine = absoluteLineFor(row, body, offset);
  if (absLine === null || options.resolveBlame === undefined) return null;
  const b = options.resolveBlame(row, absLine);
  if (b === null) return null;
  return {
    commit_sha: b.commitSha,
    author_name: b.authorName,
    author_email: b.authorEmail,
    author_time_ms: b.authorTimeMs,
  };
}

/** Build the finding for one regex match, or null when its fingerprint is allowlisted (muted). */
function buildFindingForMatch(
  row: ScanItem,
  body: string,
  externalId: string,
  pattern: SecretPattern,
  match: RegExpExecArray,
  options: ScanOptions,
): SecurityFinding | null {
  const offset = match.index ?? 0;
  const raw = match[0];
  const matchRedacted = redactSecret(raw);
  const contextSnippet = buildContextSnippet(body, offset, raw.length);
  const fingerprint = computeFindingFingerprint({
    service: row.service,
    externalId,
    patternName: pattern.name,
    matchRedacted,
    contextSnippet,
  });
  if (options.allowlist.has(fingerprint)) return null;
  return {
    item_id: row.id,
    service: row.service,
    type: row.type,
    title: row.title,
    pattern_name: pattern.name,
    pattern_category: pattern.category,
    match_redacted: matchRedacted,
    match_offset: offset,
    context_snippet: contextSnippet,
    modified_at_ms: row.modified_at,
    url: row.url,
    fingerprint,
    external_id: externalId,
    blame: resolveFindingBlame(row, body, offset, options),
  };
}

/** Scan one row against all patterns, pushing findings into `sink`; returns the muted count. */
function scanRowForSecrets(
  row: ScanItem,
  patterns: readonly SecretPattern[],
  options: ScanOptions,
  sink: SecurityFinding[],
): number {
  const body = row.body_preview;
  if (body === null || body.length === 0) return 0;
  const externalId = row.external_id ?? row.id;
  let muted = 0;
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of body.matchAll(pattern.regex)) {
      const finding = buildFindingForMatch(row, body, externalId, pattern, match, options);
      if (finding === null) muted += 1;
      else sink.push(finding);
    }
  }
  return muted;
}

export function scanItemsForSecrets(
  rows: Iterable<ScanItem>,
  patterns: readonly SecretPattern[],
  nowMs: number,
  options: ScanOptions = NO_OPTIONS,
): PureScanResult {
  const findings: SecurityFinding[] = [];
  let items_scanned = 0;
  let muted_count = 0;

  for (const row of rows) {
    items_scanned += 1;
    muted_count += scanRowForSecrets(row, patterns, options, findings);
  }

  return {
    scanned_at_ms: nowMs,
    items_scanned,
    items_skipped_depth: 0,
    findings_count: findings.length,
    muted_count,
    findings,
  };
}
