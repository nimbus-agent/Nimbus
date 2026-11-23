import { formatPrometheus } from "../../status/prometheus-format.ts";
import { contentTypeFor, resolveConsoleAsset, safeAssetPath } from "../admin-console-assets.ts";
import { buildStatus, type StatusReaders } from "../admin-status-rpc.ts";
import { requireBearer } from "../http-auth.ts";
import { json, notFound, text } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

/**
 * The admin bearer check shared by `/v1/admin/status`, `/metrics` and `/admin/*`: the EXACT I13
 * mechanism (requireBearer → constantTimeStringEqual), so a missing/empty resolved token fails
 * closed (surfaceDisabled). The token is resolved on every request, never cached.
 */
async function adminBearerOk(
  req: Request,
  resolveAdminToken: () => Promise<string>,
): Promise<boolean> {
  const expectedToken = await resolveAdminToken();
  return requireBearer(req, { expectedToken }).ok;
}

/** The plain-text 401 of `/metrics` and `/admin/*` — `/v1/admin/status` answers JSON instead. */
function textUnauthorized(): Response {
  return text("unauthorized\n", 401);
}

/** The observability gate's outcome: the readers to snapshot, or the final answer (`null` = 404). */
type StatusSurfaceGate =
  | { readonly ok: true; readonly readers: StatusReaders }
  | { readonly ok: false; readonly response: Response | null };

// Observability (Task 15). The admin snapshot + Prometheus metrics share one bearer-gated surface:
// both require statusReaders + a resolveAdminToken, and absent either the answer is `null` (the
// surface is not mounted, so the route 404s). Each route passes its own 401.
async function requireStatusSurface(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
  unauthorized: () => Response,
): Promise<StatusSurfaceGate> {
  const readers = opts.statusReaders;
  if (readers === undefined || opts.resolveAdminToken === undefined) {
    return { ok: false, response: null };
  }
  if (!(await adminBearerOk(req, opts.resolveAdminToken))) {
    return { ok: false, response: unauthorized() };
  }
  return { ok: true, readers };
}

export async function handleAdminStatus(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  const gate = await requireStatusSurface(req, opts, () => json({ error: "unauthorized" }, 401));
  if (!gate.ok) return gate.response;
  return json({ data: buildStatus(gate.readers) });
}

export async function handleMetrics(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  const gate = await requireStatusSurface(req, opts, textUnauthorized);
  if (!gate.ok) return gate.response;
  return new Response(formatPrometheus(buildStatus(gate.readers)), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

// Admin console static assets (Task 17). Bearer-gated by the SAME resolveAdminToken used by
// /v1/admin/status: absent surface (no resolveAdminToken) → null (404, surface not mounted);
// invalid bearer → 401; console not built → 503; traversal → 400. GET-only, path-traversal-safe.
export async function handleAdminConsole(
  req: Request,
  url: URL,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response | null> {
  if (opts.resolveAdminToken === undefined) return null;
  if (!(await adminBearerOk(req, opts.resolveAdminToken))) return textUnauthorized();
  const rel = safeAssetPath(url.pathname);
  if (rel === undefined) return text("bad request\n", 400);
  const asset = resolveConsoleAsset(rel);
  if (asset.kind === "not-built") {
    return text(
      "admin console not built — run: bun --filter @nimbus-dev/admin-console build\n",
      503,
    );
  }
  if (asset.kind === "not-found") return notFound();
  return new Response(Bun.file(asset.path), { headers: { "content-type": contentTypeFor(rel) } });
}
