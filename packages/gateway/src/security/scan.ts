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
}

export interface PureScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: 0;
  readonly findings_count: number;
  readonly findings: readonly SecurityFinding[];
}

export function scanItemsForSecrets(
  rows: Iterable<ScanItem>,
  patterns: readonly SecretPattern[],
  nowMs: number,
): PureScanResult {
  const findings: SecurityFinding[] = [];
  let items_scanned = 0;

  for (const row of rows) {
    items_scanned += 1;
    const body = row.body_preview;
    if (body === null || body.length === 0) continue;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (const match of body.matchAll(pattern.regex)) {
        const offset = match.index ?? 0;
        const raw = match[0];
        findings.push({
          item_id: row.id,
          service: row.service,
          type: row.type,
          title: row.title,
          pattern_name: pattern.name,
          pattern_category: pattern.category,
          match_redacted: redactSecret(raw),
          match_offset: offset,
          context_snippet: buildContextSnippet(body, offset, raw.length),
          modified_at_ms: row.modified_at,
          url: row.url,
        });
      }
    }
  }

  return {
    scanned_at_ms: nowMs,
    items_scanned,
    items_skipped_depth: 0,
    findings_count: findings.length,
    findings,
  };
}
