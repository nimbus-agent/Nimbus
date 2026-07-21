const TRACKING_PREFIXES = ["utm_"];
const TRACKING_EXACT = new Set(["fbclid", "gclid", "mc_eid", "igshid"]);

/**
 * Canonicalizes a URL for dedupe: drops the fragment, strips tracking params
 * (`utm_*` plus a fixed list of click ids), and removes a trailing slash on
 * non-root paths only. Unparseable input is returned unchanged.
 *
 * Shared by web clips (`clips/clip-ingest.ts`) and research briefs
 * (`briefs/*`) so both dedupe a URL to the same key. Changing the rules here
 * changes clip identity — `externalIdFor` hashes this output.
 */
export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.hash = "";
  // Collect first, delete after — mutating searchParams while iterating its live keys()
  // iterator would skip entries (and lets us iterate the iterable directly, no array spread).
  const trackingKeys: string[] = [];
  for (const key of u.searchParams.keys()) {
    if (TRACKING_EXACT.has(key) || TRACKING_PREFIXES.some((p) => key.startsWith(p))) {
      trackingKeys.push(key);
    }
  }
  for (const key of trackingKeys) u.searchParams.delete(key);
  // Strip a trailing slash on NON-root paths only — keep the root "https://host/" intact
  // (truncating it to "https://host" trips some URL parsers and risks dedup mismatch).
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}
