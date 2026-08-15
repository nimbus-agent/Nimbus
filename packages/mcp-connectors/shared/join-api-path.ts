/**
 * Join `path` onto `baseUrl`, passing an already-absolute URL straight through
 * (pagination cursors commonly arrive absolute).
 *
 * The absolute test is the full `http://` / `https://` scheme, not a bare
 * `http` prefix: a RELATIVE path that merely starts with those four letters —
 * `httpbin/status`, or an `http-headers` endpoint — was returned unjoined,
 * silently dropping the base URL and issuing the request against a relative
 * path. Narrow enough that it would have surfaced in production rather than in
 * review.
 */
export function joinApiPath(baseUrl: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${suffix}`;
}
