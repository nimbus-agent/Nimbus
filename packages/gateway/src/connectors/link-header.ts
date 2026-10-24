/**
 * One RFC 8288 link-value: the URL inside angle brackets plus its parameters,
 * keyed lower-case.
 */
export type LinkValue = {
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
};

/**
 * Split on the commas that separate link-values, NOT on commas inside a URL.
 * A separating comma is always followed by the next value's `<`.
 */
const LINK_SEPARATOR_RE = /,\s*(?=<)/;

/**
 * `<uri>` followed by the remaining parameter text (leading whitespace dropped), or null when the
 * value does not start with `<` or the uri is not closed by `>` before any further `<`. A linear
 * scan rather than a regex; a folded header (newlines anywhere) still matches.
 */
function splitLinkValue(value: string): { readonly uri: string; readonly rest: string } | null {
  if (!value.startsWith("<")) return null;
  const close = value.indexOf(">", 1);
  if (close === -1) return null;
  const uri = value.slice(1, close);
  if (uri.includes("<")) return null;
  return { uri, rest: value.slice(close + 1).trimStart() };
}

function parseParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const segment = part.trim();
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    if (key === "") continue;
    let value = segment.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Parse an RFC 8288 `Link` header into its link-values.
 *
 * Parameter ORDER is not significant — which is the whole point of this module.
 * The regex it replaces (`connectors/mendeley-link-header.ts`, and the unused
 * `_lib/pagination.ts` `LinkHeaderPagination`) required `rel` to be the first
 * parameter, so a server emitting `results="false"; rel="next"` looked like a
 * header with no next link at all.
 */
export function parseLinkHeader(header: string | null): LinkValue[] {
  if (header === null || header.trim() === "") return [];
  const out: LinkValue[] = [];
  for (const raw of header.split(LINK_SEPARATOR_RE)) {
    const match = splitLinkValue(raw.trim());
    if (match === null) continue;
    const url = match.uri.trim();
    const rest = match.rest;
    out.push({
      url,
      params: Object.freeze(parseParams(rest.startsWith(";") ? rest.slice(1) : rest)),
    });
  }
  return out;
}

/**
 * The URL of the `rel="next"` link, or null when there is no further page.
 *
 * `results="false"` means "a next cursor exists but has nothing behind it" —
 * Sentry emits a next link on EVERY response, including the last, so this
 * attribute is the only termination signal. An ABSENT `results` is treated as
 * `true`, which is what keeps plain RFC-5988 servers (Mendeley) working.
 */
export function nextPageUrl(header: string | null): string | null {
  for (const link of parseLinkHeader(header)) {
    if ((link.params["rel"] ?? "").toLowerCase() !== "next") continue;
    if ((link.params["results"] ?? "true").toLowerCase() === "false") return null;
    return link.url === "" ? null : link.url;
  }
  return null;
}
