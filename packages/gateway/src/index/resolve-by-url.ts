import type { Database } from "bun:sqlite";

import { canonicalizeUrl } from "../util/url-canonical.ts";

/** Candidate lists are capped: rung 3 trims path segments and can match broadly, so an uncapped
 * list would turn a mis-trimmed URL into a bulk index read over a `resolve`-scoped token. */
export const RESOLVE_CANDIDATE_CAP = 5;
/** How many trailing path segments rung 3 may trim. Bounded so `/a/b/c/d/e` cannot walk to `/a`. */
export const RESOLVE_MAX_TRIMMED_SEGMENTS = 3;

export type ResolveMatchKind = "exact" | "query_stripped" | "path_trimmed";

export type ResolveCandidate = {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
};

export type ResolveResponse =
  | {
      readonly found: true;
      readonly item: ResolveCandidate & { readonly modified_at: number };
      readonly matchKind: ResolveMatchKind;
    }
  | {
      readonly found: false;
      readonly reason: "not_indexed" | "unresolvable_url";
      readonly service: string | null;
      readonly fetchable: boolean;
    }
  | {
      readonly found: false;
      readonly reason: "ambiguous";
      readonly service: string | null;
      readonly fetchable: boolean;
      readonly candidates: readonly ResolveCandidate[];
      readonly truncated: boolean;
    };

type Row = {
  id: string;
  service: string;
  type: string;
  title: string;
  url: string | null;
  modified_at: number;
};

/**
 * Reads one page of matches for a key, capped at CAP+1 so "more than the cap" is distinguishable
 * from "exactly the cap" without a second COUNT query.
 */
function matchesForKey(db: Database, key: string): Row[] {
  return db
    .query(
      `SELECT id, service, type, title, url, modified_at FROM item
       WHERE resolve_key = ? ORDER BY modified_at DESC, id ASC LIMIT ?`,
    )
    .all(key, RESOLVE_CANDIDATE_CAP + 1) as Row[];
}

function toCandidate(r: Row): ResolveCandidate {
  return { id: r.id, service: r.service, type: r.type, title: r.title, url: r.url };
}

/** Metadata only, NEVER a body — resolve is a resolver; reading is `GET /v1/items/{id}`. This also
 * deliberately avoids the `metadata_only` redaction path and its two unfixed privacy defects. */
function hit(r: Row, matchKind: ResolveMatchKind): ResolveResponse {
  return {
    found: true,
    item: { ...toCandidate(r), modified_at: r.modified_at },
    matchKind,
  };
}

function ambiguous(rows: Row[], service: string | null, fetchable: boolean): ResolveResponse {
  const truncated = rows.length > RESOLVE_CANDIDATE_CAP;
  return {
    found: false,
    reason: "ambiguous",
    service,
    fetchable,
    // Over the cap the list is EMPTY, not sliced: a truncated choice menu implies the right answer
    // is among those shown when it may not be.
    candidates: truncated ? [] : rows.map(toCandidate),
    truncated,
  };
}

/** The key with every query parameter dropped (rung 2). */
function withoutQuery(u: URL): string {
  const copy = new URL(u.toString());
  copy.search = "";
  return canonicalizeUrl(copy.toString());
}

/** Progressively shorter keys, one trailing path segment removed at a time (rung 3). */
function trimmedKeys(u: URL): string[] {
  const base = new URL(u.toString());
  base.search = "";
  const segments = base.pathname.split("/").filter((s) => s !== "");
  const out: string[] = [];
  for (let drop = 1; drop <= RESOLVE_MAX_TRIMMED_SEGMENTS; drop++) {
    if (segments.length - drop < 1) {
      break;
    }
    const copy = new URL(base.toString());
    copy.pathname = `/${segments.slice(0, segments.length - drop).join("/")}`;
    out.push(canonicalizeUrl(copy.toString()));
  }
  return out;
}

/**
 * Resolves a URL to an already-indexed item through a bounded ladder: exact key, then the key with
 * all query params dropped, then up to three progressively trimmed trailing path segments.
 *
 * A trimmed match must be UNIQUE or the answer is `ambiguous` — trimming can over-reach, and
 * guessing between candidates is worse than declining.
 */
export function resolveItemByUrl(
  db: Database,
  rawUrl: string,
  opts?: { readonly fetchable?: (host: string) => boolean },
): ResolveResponse {
  // Parse FIRST. `canonicalizeUrl` returns unparseable input verbatim, so canonicalizing before
  // this check would let a non-URL string match a row whose stored key is that same string.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { found: false, reason: "unresolvable_url", service: null, fetchable: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { found: false, reason: "unresolvable_url", service: null, fetchable: false };
  }
  const host = parsed.host.toLowerCase();
  const fetchable = opts?.fetchable?.(host) ?? false;

  const exact = matchesForKey(db, canonicalizeUrl(rawUrl));
  if (exact.length === 1) {
    return hit(exact[0] as Row, "exact");
  }
  if (exact.length > 1) {
    return ambiguous(exact, (exact[0] as Row).service, fetchable);
  }

  const stripped = withoutQuery(parsed);
  const queryStripped = matchesForKey(db, stripped);
  if (queryStripped.length === 1) {
    return hit(queryStripped[0] as Row, "query_stripped");
  }
  if (queryStripped.length > 1) {
    return ambiguous(queryStripped, (queryStripped[0] as Row).service, fetchable);
  }

  for (const key of trimmedKeys(parsed)) {
    const rows = matchesForKey(db, key);
    if (rows.length === 1) {
      return hit(rows[0] as Row, "path_trimmed");
    }
    if (rows.length > 1) {
      return ambiguous(rows, (rows[0] as Row).service, fetchable);
    }
  }

  return { found: false, reason: "not_indexed", service: null, fetchable };
}
