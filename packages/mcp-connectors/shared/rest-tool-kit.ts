/**
 * rest-tool-kit — shared REST fetch wrapper for Bearer-auth connectors.
 *
 * Covers: github, github-actions, gmail, outlook (all use Bearer token + fetchBearerAuthorizedJson).
 * Deferred: gitlab (PRIVATE-TOKEN header), onedrive (arrayBuffer/bytes graphRequest).
 */

import { fetchBearerAuthorizedJson, resolveUrlWithBase } from "./fetch-bearer-json.ts";
import {
  type HttpJsonBodyResponse,
  type McpListResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
  type ZodObjectSchema,
} from "./mcp-tool-kit.ts";

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

/** A connector's Zod tool registrar (the `reg` from `createZodToolRegistrar`). */
export type RestToolRegistrar = <T>(
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
) => void;

/**
 * Build a per-connector "register a standard REST tool" helper. Collapses the
 * repeated tool body shared by the hand-rolled REST connectors:
 * `const token = requireProcessEnv(<env>); const res = await <fetch>(token,
 * buildPath(p)[, buildInit(p)]); return mcpJsonResultIfOk(<label>, res)`. The
 * connector supplies its registrar, token env, service label, and token-bearing
 * fetcher once; each tool then provides only its name/description/schema +
 * `buildPath` (and optional `buildInit` for method/body). Tools with a
 * non-standard tail (custom error text, 204 tolerance, raw text) stay
 * hand-written on the connector's own `reg`.
 */
export function makeRestToolRegistrar(cfg: {
  registrar: RestToolRegistrar;
  tokenEnv: string;
  serviceLabel: string;
  fetch: (token: string, pathOrUrl: string, init?: RequestInit) => Promise<HttpJsonBodyResponse>;
  /** Body-snippet length for the `<label> <status>: <snippet>` error (mcpJsonResultIfOk default 300). */
  snippetMax?: number;
}): <T>(
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  buildPath: (args: T) => string,
  buildInit?: (args: T) => RequestInit,
) => void {
  return (name, description, schema, buildPath, buildInit) => {
    cfg.registrar(name, description, schema, async (args) => {
      const token = requireProcessEnv(cfg.tokenEnv);
      const res = await cfg.fetch(token, buildPath(args), buildInit?.(args));
      return mcpJsonResultIfOk(cfg.serviceLabel, res, cfg.snippetMax);
    });
  };
}
