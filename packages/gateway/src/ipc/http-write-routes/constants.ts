export const SCIM_ITEM_RE = /^\/scim\/v2\/Users\/([^/]+)$/;

/**
 * `/v1/agents/<name>` — path-param routing by regex, as the brief and SCIM item routes do.
 *
 * `[A-Za-z]` only: an agent name is a bare identifier, and narrowing the charset here means the
 * caller-supplied segment cannot carry separators or escapes before it reaches the resolver.
 */
export const AGENT_INVOKE_RE = /^\/v1\/agents\/([A-Za-z]{1,32})$/;

/** `/v1/briefs/<id>/<action>` — there is no path-param router here; SCIM sets the precedent. */
export const BRIEF_ITEM_RE = /^\/v1\/briefs\/(\w{1,64})\/(sources|run|save)$/;

/**
 * Per-route request-body cap (enforced in `parseBody`, twice: on the `content-length` header
 * before the body is read, and again on the actual byte length).
 *
 * `MAX_BODY_BYTES_DEFAULT` (8 KiB) is the anti-abuse bound for the control-plane routes this
 * dispatcher was built for — deploy annotations, SCIM user records, the admin policy TOML, Teams
 * activities, and the clip pairing confirm (a `{code}` body of a few dozen bytes). Keep it.
 *
 * `MAX_BODY_BYTES_ARTICLE` (1 MiB) applies to every route that carries a whole extracted article:
 * `POST /v1/clips` (a whole web page — real articles routinely exceed 8 KiB, so the shared cap
 * made the web clipper unusable, 413 payload_too_large on every non-trivial page; issue #771) and
 * `POST /v1/briefs/{id}/sources` (the exact same shape of payload, fed one at a time into a brief
 * run). Do NOT unify these back into the control-plane constant: both routes are the outlier, and
 * widening the control-plane routes to 1 MiB would give away a cheap abuse bound for nothing.
 */
export const MAX_BODY_BYTES_DEFAULT = 8 * 1024;

export const MAX_BODY_BYTES_ARTICLE = 1024 * 1024;

/**
 * A brief CREATE body carries the question plus up to MAX_SOURCES_PER_RUN {url,title} pairs. The
 * 8 KiB control-plane default does NOT fit that: a 4000-char brief leaves ~4 KiB for 20 pairs
 * (~200 bytes each), and real URLs plus real tab titles exceed that routinely — a fully conforming
 * client would 413. 64 KiB is generous and still trivial next to the 1 MiB source cap.
 */
export const MAX_BODY_BYTES_BRIEF_CREATE = 64 * 1024;

/**
 * Per-route request rate cap (per token fingerprint, per rate-limiter window; it may only tighten
 * the server-configured limit, never loosen it — see `HttpWriteRateLimiter.check`).
 *
 * `MAX_REQUESTS_PER_WINDOW_DEFAULT` (60/min) is the shared control-plane limit.
 *
 * `MAX_REQUESTS_PER_WINDOW_CLIP` (20/min) is the tightening that pays for `MAX_BODY_BYTES_ARTICLE`
 * on `POST /v1/clips`:
 * raising a body cap without tightening the matching rate limit is exactly what the write-surface
 * playbook forbids, because the abuse bound is cap × rate. 60 × 1 MiB/min would have been a ~60
 * MiB/min burst; 20 × 1 MiB/min holds it to ~20 MiB/min while staying generous for a human
 * clipping pages. Keep these two constants moving together.
 *
 * This matters more than for the other routes: `checkAuth` returns a constant fingerprint for
 * `clipIngest` WITHOUT verifying the token — the clip token is checked inside `runClipIngestRoute`,
 * i.e. after `parseBody` has already buffered, UTF-8 decoded, and JSON-parsed the body. So for this
 * route the body cap and this rate limit are the only bounds on pre-auth work. That is acceptable
 * on a loopback-only surface at 1 MiB; it is the reason the pair is deliberately conservative.
 */
export const MAX_REQUESTS_PER_WINDOW_DEFAULT = 60;

export const MAX_REQUESTS_PER_WINDOW_CLIP = 20;

/**
 * Bounds the `"brief-src"` bucket ONLY — the source-feed calls of a brief sweep, up to
 * MAX_SOURCES_PER_RUN (20) feeds. This is a SEPARATE bucket from `"brief"` (create/run/save,
 * see MAX_REQUESTS_PER_WINDOW_DEFAULT): a sweep feeding up to 20 sources back-to-back cannot
 * starve ordinary clipping/control calls on the `"brief"` bucket, and vice versa.
 */
export const MAX_REQUESTS_PER_WINDOW_BRIEF_SOURCE = 60;

export const DEPLOY_DISABLED_HINT =
  "set http_api.deployment_token via 'nimbus vault set http_api.deployment_token'";

export const SCIM_DISABLED_HINT =
  "set identity.scim.bearer via 'nimbus identity scim set-token <value>'";

export const DEPLOY_REJECT_ACTION = "deployment.annotation_rejected";

export const SCIM_REJECT_ACTION = "scim.provision_rejected";

export const POLICY_DISABLED_HINT =
  "policy write surface disabled — set the bearer via 'nimbus vault set http_api.deployment_token'";

export const POLICY_REJECT_ACTION = "policy.applied_rejected";

export const TEAMS_EVENTS_DISABLED_HINT =
  "ChatOps Teams surface disabled — enable [chatops].teams_enabled";

export const TEAMS_EVENTS_REJECT_ACTION = "messaging.teams.inbound_rejected";

export const CLIP_DISABLED_HINT = "web clipper disabled — pair a browser with 'nimbus clip pair'";

export const CLIP_REJECT_ACTION = "clip.ingest_rejected";

export const CLIP_PAIR_REJECT_ACTION = "clip.pair_rejected";

export const BRIEF_DISABLED_HINT = "research briefs disabled — enable [briefs] in nimbus.toml";

export const BRIEF_CREATE_REJECT_ACTION = "brief.create_rejected";

export const BRIEF_SOURCE_REJECT_ACTION = "brief.source_rejected";

export const BRIEF_RUN_REJECT_ACTION = "brief.run_rejected";

export const BRIEF_SAVE_REJECT_ACTION = "brief.save_rejected";

export const AGENTS_DISABLED_HINT = "agent invocation over HTTP disabled — no local index is wired";

export const AGENT_INVOKE_REJECT_ACTION = "agents.invoke_rejected";

export const ITEMS_FETCH_DISABLED_HINT =
  "targeted fetch disabled — no fetch-on-miss surface is wired";

export const ITEMS_FETCH_REJECT_ACTION = "items.fetch_rejected";
