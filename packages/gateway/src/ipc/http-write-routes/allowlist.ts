// Canonical allowlist keys ("<METHOD> <PATH>", exact-match for deployment; the `{id}` item routes
// are matched by the SCIM regex below, never by string templating). Plain string literals (no
// backtick templating of `{id}`) so the Opengrep missing-template-string rule can't false-fire.
export const ROUTE_DEPLOY = "POST /v1/deployments";

export const ROUTE_SCIM_CREATE = "POST /scim/v2/Users";

export const ROUTE_SCIM_PATCH = "PATCH /scim/v2/Users/{id}";

export const ROUTE_SCIM_DELETE = "DELETE /scim/v2/Users/{id}";

export const ROUTE_ADMIN_POLICY = "PUT /v1/admin/policy";

export const ROUTE_TEAMS_EVENTS = "POST /v1/messaging/teams/events";

export const ROUTE_CLIPS = "POST /v1/clips";

export const ROUTE_CLIPS_PAIR_CONFIRM = "POST /v1/clips/pair/confirm";

export const ROUTE_AGENT_INVOKE = "POST /v1/agents/{agent}";

export const ROUTE_BRIEFS = "POST /v1/briefs";

export const ROUTE_BRIEF_SOURCES = "POST /v1/briefs/{id}/sources";

export const ROUTE_BRIEF_RUN = "POST /v1/briefs/{id}/run";

export const ROUTE_BRIEF_SAVE = "POST /v1/briefs/{id}/save";

/**
 * Targeted single-item fetch. An explicit I13 WRITE: it causes an OUTBOUND request to a configured
 * provider and a row in the local index. It is deliberately NOT modelled as a read that happens to
 * have side effects — that reclassification is exactly how a write slips past the allowlist.
 */
export const ROUTE_ITEMS_FETCH = "POST /v1/items/fetch";

/**
 * The complete HTTP write surface (I13). Every entry flows through `dispatchWriteRoute` — bearer
 * auth, per-token rate-limit, body cap, and audit-on-rejection. `POST /v1/deployments` is the CI
 * deploy-annotation route; the three `/scim/v2/Users` routes are the SCIM provisioning surface
 * (own bearer = `identity.scim.bearer`); `PUT /v1/admin/policy` is the admin-console anchor policy
 * write surface (own bearer = the admin token; signs the org policy with the Vault-only anchor key);
 * `POST /v1/messaging/teams/events` is the ChatOps Teams inbound surface (auth = a Bot Framework
 * JWT validated in-route, not a static bearer). `POST /v1/clips` is the web-clipper ingest surface
 * (auth = a labeled clip token validated in-route); `POST /v1/clips/pair/confirm` is the pairing
 * confirm surface (gated by a short-lived pairing code). `POST /v1/briefs` creates a research-brief
 * run, `POST /v1/briefs/{id}/sources` feeds it a captured source, `POST /v1/briefs/{id}/run`
 * triggers synthesis, and `POST /v1/briefs/{id}/save` persists the finished report (auth = the same
 * labeled clipper token, verified in-route). `POST /v1/agents/{agent}` invokes a read-only agent
 * (auth = the same labeled clipper token, under the `agents` scope). `POST /v1/items/fetch` is the
 * targeted fetch-on-miss route (auth = the same labeled clipper token, under its own `fetch` scope
 * — distinct from `resolve`'s read-only local-index lookup, since this one makes an outbound
 * request). No other HTTP method may write.
 */
export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([
  ROUTE_DEPLOY,
  ROUTE_SCIM_CREATE,
  ROUTE_SCIM_PATCH,
  ROUTE_SCIM_DELETE,
  ROUTE_ADMIN_POLICY,
  ROUTE_TEAMS_EVENTS,
  ROUTE_CLIPS,
  ROUTE_CLIPS_PAIR_CONFIRM,
  ROUTE_BRIEFS,
  ROUTE_BRIEF_SOURCES,
  ROUTE_BRIEF_RUN,
  ROUTE_BRIEF_SAVE,
  ROUTE_AGENT_INVOKE,
  ROUTE_ITEMS_FETCH,
]);
