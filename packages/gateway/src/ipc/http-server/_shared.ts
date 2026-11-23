import type { ApiScope } from "../../clips/api-scopes.ts";
import { verifyApiToken } from "../../clips/clip-token-store.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../../config/nimbus-toml.ts";
import type { ServiceConfig } from "../../metrics/dora-config.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { bearerToken } from "../http-auth.ts";
import { type ClipReadRouteKey, enforceClipScope } from "../http-route-auth.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The plain-text twin of `json`, for the admin routes that answer in text (`/metrics`, `/admin`). */
export function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** The bare 404: no JSON body and no named cause, exactly what an unmatched path answers. */
export function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/**
 * The token phase of `requireScopedSurface`: 401 when the token is unknown, 403 when it is
 * known but out of scope, 500 when the route's `HTTP_ROUTE_AUTH` entry is itself misconfigured
 * (see `enforceClipScope`'s fail-closed contract). Returns the verified principal on success.
 *
 * `routeKey` must be the STATIC route constant (`ROUTE_KEY_BRIEF_GET`, `ROUTE_KEY_EGRESS_LIST`, …),
 * never the raw request path — `clipScopeFor` looks the requirement up by that literal key. The
 * parameter type is narrowed to exactly the `ClipReadRouteKey` constants, one per inline read:
 * this function is never called any other way, and the narrowing is what makes
 * `enforceClipScope` returning "misconfigured" for this routeKey a genuine table bug rather than a
 * legitimately-unscoped route.
 */
async function requireScopedClipToken(
  req: Request,
  clipsVault: NimbusVault,
  routeKey: ClipReadRouteKey,
): Promise<{ ok: true; scopes: readonly ApiScope[] } | { ok: false; response: Response }> {
  const presented = bearerToken(req);
  const verified = presented === undefined ? null : await verifyApiToken(clipsVault, presented);
  if (verified === null) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  const verdict = enforceClipScope(routeKey, verified.scopes);
  if (!verdict.ok) {
    return { ok: false, response: json(verdict.body, verdict.status) };
  }
  return { ok: true, scopes: verified.scopes };
}

/** A scoped read's gate outcome: the vault the token was verified against, or the final answer. */
export type ScopedSurfaceGate =
  | { readonly ok: true; readonly clipsVault: NimbusVault }
  | { readonly ok: false; readonly response: Response };

/**
 * The gate in front of every bearer-scoped inline read: the surface must be mounted, then the
 * token must carry `routeKey`'s scope (`requireScopedClipToken`). Every one of these reads
 * authenticates against `opts.clipsVault`, the one labeled client-token map.
 *
 * ORDER IS THE CONTRACT: `disabled` is answered BEFORE the token is read, so an unmounted surface
 * gives every caller the same 404, with a token or without one. Clients depend on that 404 — the
 * browser client reads a resolve 404 as "gateway older than the route" and withholds those lanes
 * silently, where a 401 or a 500 would be a visible error on every gateway that does not mount the
 * surface. A route whose surface needs more than the vault (briefs, agents) refuses on that half
 * FIRST, with the same `disabled` answer, so the whole "not mounted" check still precedes auth.
 *
 * NAMING THE GATE: what it tests is that the SURFACE is mounted, not that the route exists — so a
 * gateway new enough to carry a route but with no clips surface answers the same 404 as one too
 * old to have it, and a client cannot tell those apart.
 *
 * Each route passes its OWN `disabled` answer, because the bodies differ on purpose: each names the
 * absent surface (`resolve_disabled`, `services_disabled`, `egress_disabled`, `briefs_disabled` /
 * `agents_disabled` with hints), and `POST /v1/clips/related` answers the bare `notFound()`.
 */
export async function requireScopedSurface(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
  routeKey: ClipReadRouteKey,
  disabled: () => Response,
): Promise<ScopedSurfaceGate> {
  const clipsVault = opts.clipsVault;
  if (clipsVault === undefined) {
    return { ok: false, response: disabled() };
  }
  const auth = await requireScopedClipToken(req, clipsVault, routeKey);
  if (!auth.ok) {
    return { ok: false, response: auth.response };
  }
  return { ok: true, clipsVault };
}

export function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(Number.parseInt(raw, 10))));
}

/**
 * A required `?name=`, or `null` when it is absent OR EMPTY. Whitespace is a VALUE here, unlike
 * `coordinateParam`'s blankness rule: `?service=%20` reaches the dispatcher's own validation. And
 * `metrics.stats`' `window_ms` / `bucket_ms` refuse only absence — see `handleMetricsStats`.
 */
export function requiredQueryParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  return raw === null || raw === "" ? null : raw;
}

/** The 400 for a missing required query param — naming that one param, never a group of them. */
export function missingQueryParam(name: string): Response {
  return json({ error: `missing required query param: ${name}` }, 400);
}

/**
 * The owner's service configs, or an empty map when no config dir is wired. THROWS on a malformed
 * `nimbus.toml`: what that means is each caller's decision, and they decide differently on purpose
 * — `handleMetricsStats` answers `config_unreadable`, while `metrics.dora` and `deploy.preflight`
 * load lazily inside their dispatcher, so theirs is the generic 500.
 */
export function loadServiceConfigs(opts: ReadOnlyHttpServerOptions): Map<string, ServiceConfig> {
  return opts.configDir === undefined
    ? new Map<string, ServiceConfig>()
    : loadNimbusServiceConfigsFromConfigDir(opts.configDir);
}

/**
 * `?name=` as a non-negative integer, or undefined.
 *
 * Undefined on anything unparseable rather than a 400: these are all optional window/paging
 * refinements, so a junk value should fall back to the route's default instead of failing a read
 * the caller is entitled to make.
 */
export function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * A REQUIRED `?name=` coordinate, or `null` when absent or blank.
 *
 * Blank is refused rather than passed through. `resolveFileByRemote` builds `":acme/web"` from an
 * empty `service`, matches no workspace, and answers `remote_not_tracked` — telling the caller
 * they have no local checkout of a repository they never named. A confident wrong answer is worse
 * than a refusal, and that one is the panel's most permanent-sounding miss sentence.
 *
 * Returns the value UNTRIMMED, matching `handleItemsResolve`'s treatment of `?url=`: the blankness
 * test is a guard, not a normalisation, and a path segment's own whitespace is not ours to edit.
 */
export function coordinateParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  return raw === null || raw.trim() === "" ? null : raw;
}
