import type { Database } from "bun:sqlite";
import { loadNimbusServiceConfigsFromConfigDir } from "../../config/nimbus-toml.ts";
import { resolveItemByUrl } from "../../index/resolve-by-url.ts";
import { resolveFileByRemote } from "../../index/resolve-file-by-remote.ts";
import { RESOLVE_IDS_MAX_BATCH, resolveItemsByIds } from "../../index/resolve-ids.ts";
import {
  type ParsedDoraRepoUrn,
  parseDoraRepoUrn,
  type ServiceConfig,
} from "../../metrics/dora-config.ts";
import { resolveServicesByRepoUrn } from "../../metrics/service-identity.ts";
import {
  ROUTE_KEY_ITEMS_RESOLVE,
  ROUTE_KEY_ITEMS_RESOLVE_FILE,
  ROUTE_KEY_ITEMS_RESOLVE_IDS,
  ROUTE_KEY_SERVICES_RESOLVE,
} from "../http-route-auth.ts";
import { coordinateParam, json, requireScopedSurface } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

/** The named 404 of the three `/v1/items/resolve*` reads, which share one surface. */
function resolveDisabled(): Response {
  return json({ error: "resolve_disabled" }, 404);
}

// GET /v1/items/resolve?url= — bearer-authed read under the `resolve` scope. Mounted in the fetch
// handler, NOT reachable via dispatchReadOnlyDataGet: that table's "/v1/items/*" entry is PUBLIC
// (handleItemByPath, no bearer gate at all), so routing resolve through it would serve scoped
// output — including which URLs are indexed — to any local process on the machine.
//
// Returns resolveItemByUrl's result unchanged (metadata only) and appends NO egress row.
export async function handleItemsResolve(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  // Same "surface not mounted" shape as handleAgentsList/agentsDisabled(): a named 404, never a
  // fall-through to the public /v1/items/* table.
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_ITEMS_RESOLVE, resolveDisabled);
  if (!gate.ok) return gate.response;
  const raw = url.searchParams.get("url");
  if (raw === null || raw.trim() === "") {
    return json({ error: "missing_url" }, 400);
  }
  // IMPORTANT 1: derived FRESH on every call (never cached), same as `fetchItem`'s own host map —
  // a revoked credential must stop advertising `fetchable` on the very next request.
  //
  // IMPORTANT 2 (availability): `resolveFetchable()` calls `deriveFetchHostMap(vault)` in
  // production, which reads several Vault keys. A locked keychain or a transient backend error
  // must degrade this route to the documented default (`fetchable: false`) rather than fail the
  // whole resolve answer — before `fetchable` was wired in, this route could not fail for a Vault
  // reason at all, so a Vault outage regressing resolve availability would be new breakage. The
  // rejection reason is deliberately NOT logged: a Vault error message can embed a base URL, which
  // is a secret.
  const fetchable =
    opts.resolveFetchable === undefined
      ? undefined
      : await opts.resolveFetchable().catch(() => undefined);
  return json(resolveItemByUrl(db, raw, fetchable === undefined ? undefined : { fetchable }));
}

// GET /v1/items/resolve-file?service=&repo=&refAndPath= — bearer-authed read under the `resolve`
// scope, mounted inline for exactly the reason handleItemsResolve is: the "/v1/items/*" entry in
// dispatchReadOnlyDataGet's table is PUBLIC, so routing this through it would serve the reader's
// indexed-file set to any local process on the machine.
//
// Appends NO egress row. Nothing leaves the machine — it reads the local graph and answers.
export async function handleItemsResolveFile(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  // Load-bearing beyond tidiness: the shipped browser client reads this route's 404 as "gateway
  // older than the route" and withholds its file lanes silently (see requireScopedSurface).
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_ITEMS_RESOLVE_FILE, resolveDisabled);
  if (!gate.ok) return gate.response;

  const service = coordinateParam(url, "service");
  const repo = coordinateParam(url, "repo");
  const refAndPath = coordinateParam(url, "refAndPath");
  if (service === null || repo === null || refAndPath === null) {
    return json({ error: "missing_coordinate" }, 400);
  }

  const result = resolveFileByRemote(db, { service, repo, refAndPath });
  return json(
    result.ok
      ? // Field by field, naming `path` alone. NOT a spread and NOT a destructured rest:
        // `ResolveFileResult` also carries `repoRoot` — the reader's local filesystem path — and
        // `fileEntityId`, and this route is reachable by any holder of a clip token over HTTP. A
        // field added to that type later cannot leak here unnamed.
        { ok: true, path: result.path }
      : { ok: false, reason: result.reason, repo: result.repo },
  );
}

// GET /v1/items/resolve-ids?id=&id=… — bearer-authed read under the `resolve` scope, mounted
// inline for exactly the reason handleItemsResolve and handleItemsResolveFile are: the
// "/v1/items/*" entry in dispatchReadOnlyDataGet's table is PUBLIC, so routing this through it
// would serve scoped output to any local process on the machine.
//
// Appends NO egress row. Nothing leaves the machine — it reads the local index and answers.
export async function handleItemsResolveIds(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  // Before the auth check, and load-bearing: a client reads this 404 as "gateway older than
  // the route" and withholds its links silently (see requireScopedSurface).
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_ITEMS_RESOLVE_IDS, resolveDisabled);
  if (!gate.ok) return gate.response;

  // RAW count first, before trimming and before de-duplicating: checking after the set is built
  // would let a caller send fifty thousand copies of one id and pay only the parse cost.
  const raw = url.searchParams.getAll("id");
  if (raw.length > RESOLVE_IDS_MAX_BATCH) {
    return json({ error: "too_many_ids" }, 400);
  }
  const ids = raw.map((id) => id.trim()).filter((id) => id !== "");
  if (ids.length === 0) {
    return json({ error: "missing_id" }, 400);
  }

  // Field by field, never a spread and never a destructured rest: `item` carries `body`,
  // `metadata` and `author_id`, and this route is reachable by any holder of a clip token. A
  // column added to the row type later cannot leak here unnamed.
  const items = resolveItemsByIds(db, ids).map((row) => ({
    id: row.id,
    service: row.service,
    type: row.type,
    title: row.title,
    url: row.url,
    modified_at: row.modified_at,
  }));
  return json({ items });
}

/** `GET /v1/services/resolve`'s named 404. */
function servicesDisabled(): Response {
  return json({ error: "services_disabled" }, 404);
}

// GET /v1/services/resolve?repo=github:acme/web — bearer-authed read under the `resolve` scope,
// mounted inline for exactly the reason the three reads above are: the "/v1/items/*" entry in
// dispatchReadOnlyDataGet's table is PUBLIC, so routing this through it would serve scoped output
// to any local process on the machine. Why this route is scoped at all — rather than public beside
// the two routes it feeds — is argued in full at its HTTP_ROUTE_AUTH entry.
//
// Appends NO egress row. Nothing leaves the machine: it parses one URN and reads local config.
export async function handleServicesResolve(
  req: Request,
  url: URL,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  // An unmounted gateway answers like one too old to carry this route (see requireScopedSurface).
  // Benign here: both readings lead the client to the same per-repo fallback.
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_SERVICES_RESOLVE, servicesDisabled);
  if (!gate.ok) return gate.response;

  const raw = coordinateParam(url, "repo");
  if (raw === null) return json({ error: "missing_repo" }, 400);

  // Parsed with the SAME parser that produced the config's own URNs. That is what makes this an
  // exact config-vocabulary comparison rather than a third item-matcher (see
  // `resolveServicesByRepoUrn`), and it is why a malformed URN is refused here rather than
  // resolving to a confident null — "no service claims `githu:acme/web`" would be true and useless.
  //
  // TRIMMED, unlike `handleItemsResolveFile`'s use of the same helper, and the divergence is
  // deliberate: that route's `refAndPath` is a path whose own whitespace is real and not ours to
  // edit, whereas a URN has no meaningful leading or trailing space in either the query or the
  // TOML it is compared against. `coordinateParam` still decides blankness, so " " is a
  // `missing_repo` 400 rather than an empty URN reaching the parser.
  let query: ParsedDoraRepoUrn;
  try {
    query = parseDoraRepoUrn(raw.trim());
  } catch {
    // The parser's own message names the offending value; this one deliberately does not echo it
    // back. The caller supplied it and already has it.
    return json({ error: "invalid_repo_urn" }, 400);
  }

  if (opts.configDir === undefined) {
    // No config dir wired: nothing is configured, which is an ANSWER, not a failure. Matches
    // resolveKnownServices, which returns [] for the same condition.
    return json({ service: null, ambiguous: false, candidates: [] });
  }

  // Reads and parses nimbus.toml on EVERY call, like every other caller of this loader. Left
  // uncached deliberately: the design flagged a per-call file read as something a reviewer might
  // want a cheap guard around, but that was argued for the PUBLIC mount, where any local process
  // could spin it. Behind a token the cost is the same one `handleMetricsDora` already pays per
  // request, and a cache here would answer from a config the owner had since fixed — which is the
  // worse failure for a route whose whole job is to not be stale.
  let configs: ReadonlyMap<string, ServiceConfig>;
  try {
    configs = loadNimbusServiceConfigsFromConfigDir(opts.configDir);
  } catch {
    // SURFACED, not degraded — and this is a decision, since the existing callers disagree:
    // agents-rpc.ts degrades, assemble.ts try/catches at startup, and handleMetricsDora does
    // neither and 500s. Degrading here would answer `service: null`, which the client cannot
    // distinguish from "no service claims this repo" — a confident wrong answer about the owner's
    // configuration, on the one surface where they might have noticed it was broken.
    //
    // The body names only THAT parsing failed. These messages embed the service id and the
    // offending config value verbatim (config/service-config-toml.ts), and while this route is
    // scoped, a client token is not the owner and has no business reading their config.
    return json({ error: "config_unreadable" }, 500);
  }

  const res = resolveServicesByRepoUrn(configs, query);
  // Field by field, and a TOTAL key set: `ambiguous` and `candidates` are present on every answer,
  // including the null one, so a client cannot mistake "this gateway does not disclose ambiguity"
  // for "this binding is uncontested". `ambiguous` is derived from the candidate count rather than
  // passed in, so the two can never disagree.
  return json({
    service: res.serviceId,
    ambiguous: res.candidateServiceIds.length > 1,
    candidates: res.candidateServiceIds,
  });
}
