/**
 * rest-tool-kit — shared REST fetch wrapper for Bearer-auth connectors.
 *
 * Covers: github, github-actions, gmail, outlook (all use Bearer token + fetchBearerAuthorizedJson).
 * Deferred: gitlab (PRIVATE-TOKEN header), onedrive (arrayBuffer/bytes graphRequest).
 */

import { fetchBearerAuthorizedJson, resolveUrlWithBase } from "./fetch-bearer-json.ts";

export type RestFetchResult = {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
};

export type RestFetcherConfig = {
  /** Base URL, e.g. "https://api.github.com" or "https://graph.microsoft.com/v1.0". */
  apiBase: string;
  /** Bearer token injected as Authorization header. */
  token: string;
  /** Additional headers merged on every request (e.g. GH_HEADERS). */
  defaultHeaders?: Record<string, string>;
};

/**
 * Returns a fetcher function bound to `cfg.apiBase` + `cfg.token`.
 *
 * Relative paths are prefixed with `apiBase`; absolute URLs pass through unchanged.
 * The returned function mirrors the `BearerJsonFetchResult` shape used throughout the
 * connector tree: `{ ok, status, json, text }`.
 */
export function makeRestFetcher(
  cfg: RestFetcherConfig,
): (pathOrUrl: string, init?: RequestInit) => Promise<RestFetchResult> {
  return async (pathOrUrl: string, init?: RequestInit): Promise<RestFetchResult> => {
    const url = resolveUrlWithBase(cfg.apiBase, pathOrUrl);
    return fetchBearerAuthorizedJson(url, cfg.token, init, cfg.defaultHeaders);
  };
}
