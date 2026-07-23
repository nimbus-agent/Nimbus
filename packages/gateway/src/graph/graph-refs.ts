/**
 * Pure reference extraction from indexed text. No DB, no I/O — every
 * function here is a total function of its input string, which is what
 * makes the branch-heavy parsing cheap to test exhaustively.
 */

const NUMERIC_REF_RE = /#(\d+)/g;
// Ticket keys: 2-10 uppercase alphanumerics, a hyphen, then digits.
// The bounded length is what keeps SHOUTING-1 style prose out.
const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;

/**
 * Prefixes that look like ticket keys but are overwhelmingly standards
 * references in prose (deferred from 1a as a real precision issue: each false
 * positive costs an unindexed LIKE scan, and a tracker project literally
 * named e.g. SHA would emit a WRONG edge — worse than a missing one).
 * A real tracker whose project key collides with this list cannot be
 * resolved; that trade is deliberate and mirrors 1a's short-SHA reasoning
 * in reverse: there the cost of filtering was silent misses, here the cost
 * of NOT filtering is wrong edges.
 */
const NON_TICKET_KEY_PREFIXES: ReadonlySet<string> = new Set([
  "RFC",
  "UTF",
  "SHA",
  "ISO",
  "CVE",
  "IEEE",
  "ECMA",
  "ANSI",
  "CWE",
  "CVSS",
  "PEP",
  "MD",
  "AES",
  "TLS",
]);

export type IssueRefs = {
  numeric: number[];
  ticketKeys: string[];
};

export function extractIssueRefs(text: string): IssueRefs {
  const numeric: number[] = [];
  const seenNumeric = new Set<number>();
  for (const m of text.matchAll(NUMERIC_REF_RE)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || seenNumeric.has(n)) continue;
    seenNumeric.add(n);
    numeric.push(n);
  }

  const ticketKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const m of text.matchAll(TICKET_KEY_RE)) {
    const prefix = m[1];
    if (prefix !== undefined && NON_TICKET_KEY_PREFIXES.has(prefix)) continue;
    const key = m[0];
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    ticketKeys.push(key);
  }

  return { numeric, ticketKeys };
}

const COMMIT_SHA_RE = /\b([0-9a-f]{7,40})\b/g;

export function extractCommitShas(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(COMMIT_SHA_RE)) {
    const sha = m[1];
    if (sha === undefined || seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
  }
  return out;
}
