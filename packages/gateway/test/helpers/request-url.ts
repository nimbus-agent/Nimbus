/**
 * Resolve the URL string from a `fetch` first argument.
 *
 * Handles every `RequestInfo` form explicitly so the `Request` branch reads
 * `.url` instead of falling back to `Object.prototype.toString()` (which would
 * yield `"[object Request]"`). Shared by the connector fake-server fetch stubs
 * and {@link MockFetch} to keep that resolution consistent and lint-clean.
 */
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
