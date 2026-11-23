import type { Database } from "bun:sqlite";
import { type RelatedHit, type RelatedInput, runClipRelated } from "../../clips/clip-related.ts";
import { ftsMatchQuery } from "../../search/hybrid-internal.ts";
import { ROUTE_KEY_CLIPS_RELATED } from "../http-route-auth.ts";
import { json, notFound, requireScopedSurface } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

/** The FTS-only `search` behind `POST /v1/clips/related` (synchronous: bun:sqlite). */
function searchClipRelatedFts(db: Database, query: string, limit: number): RelatedHit[] {
  const fts = ftsMatchQuery(query);
  if (fts === "") return [];
  const rows = db
    .query(
      // Column 1 is `body`. V48 re-pointed item_fts from (title, body_preview)
      // to (title, body); index 0 is the TITLE, which this asked for until
      // 2026-08 and which made every snippet an echo of the line above it.
      // COALESCE is load-bearing: snippet() over a NULL body returns NULL,
      // and the browser client's isRelatedHit requires a string — a null
      // would drop the hit from the panel entirely rather than blank a line.
      `SELECT i.id, i.title, i.service, i.type, i.url, i.modified_at,
              COALESCE(snippet(item_fts, 1, '', '', '…', 24), '') AS snippet
       FROM item i
       INNER JOIN item_fts ON i.rowid = item_fts.rowid
       WHERE item_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(fts, limit) as Array<{
    id: string;
    title: string;
    service: string;
    type: string;
    url: string | null;
    modified_at: number;
    snippet: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    service: r.service,
    type: r.type,
    snippet: r.snippet,
    url: r.url,
    modified_at: r.modified_at,
  }));
}

// POST /v1/clips/related — bearer-authed read route (no DB mutation). Uses FTS-only search over
// the read-only DB so no embedding pipeline is required. The query is sanitized via ftsMatchQuery
// (the same escaping used by the hybrid-search BM25 path) to prevent FTS5 syntax injection.
export async function handleClipRelated(
  req: Request,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_CLIPS_RELATED, notFound);
  if (!gate.ok) return gate.response;
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "invalid_request", detail: "body must be a JSON object" }, 400);
  }
  const body = parsed as RelatedInput;
  const out = await runClipRelated(
    {
      // The dep contract is Promise-shaped (a hybrid-search adapter may be async); `Promise.try`
      // keeps a query failure a rejection, as the former `async` arrow did.
      search: (query: string, limit: number): Promise<RelatedHit[]> =>
        Promise.try(() => searchClipRelatedFts(db, query, limit)),
      lookupItem: (id: string): { title: string } | null => {
        // Inline single-row read, the house pattern — see decisions.ts:33 and
        // decision-corroborate.ts:49. Metadata only; never a body.
        const row = db.query("SELECT title FROM item WHERE id = ?").get(id) as {
          title: string;
        } | null;
        return row === null ? null : { title: row.title };
      },
    },
    body,
  );
  return json(out);
}
