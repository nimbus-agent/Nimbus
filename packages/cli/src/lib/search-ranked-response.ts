/**
 * Reads an `index.searchRanked` response in either shape.
 *
 * With `envelope: true` the gateway answers `{ items, retrieval, notes }`: the rows plus a
 * disclosure of what the search actually did (keyword-only because the embedding timed out or is
 * still loading, or taken while a background embedding pass is still running). `notes` is the
 * gateway's own plain-language wording for that disclosure, so this side prints it verbatim rather
 * than keeping a second copy that could drift.
 *
 * A gateway that predates the envelope ignores the flag and returns a bare array; that still parses,
 * with no notes. Anything else is treated as no rows — the payload crosses an IPC seam, so its shape
 * is checked rather than trusted.
 */
export type SearchRankedResponse = {
  readonly items: unknown[];
  readonly notes: string[];
  /** Present only when the gateway answered a point-in-time (`at`) request; absent from an older gateway. */
  readonly asOf?: Record<string, unknown>;
};

export function parseSearchRankedResponse(raw: unknown): SearchRankedResponse {
  if (Array.isArray(raw)) {
    return { items: raw, notes: [] };
  }
  if (typeof raw !== "object" || raw === null) {
    return { items: [], notes: [] };
  }
  const rec = raw as Record<string, unknown>;
  const items = Array.isArray(rec["items"]) ? rec["items"] : [];
  const notes = Array.isArray(rec["notes"])
    ? rec["notes"].filter((n): n is string => typeof n === "string" && n !== "")
    : [];
  const asOf = rec["asOf"];
  if (typeof asOf === "object" && asOf !== null && !Array.isArray(asOf)) {
    return { items, notes, asOf: asOf as Record<string, unknown> };
  }
  return { items, notes };
}
