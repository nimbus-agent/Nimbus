// packages/gateway/src/egress/egress-coverage.ts

/**
 * How completely a binary observed one egress class.
 * Ordered weakest-first; `weakestCoverage` relies on this order.
 */
export const GRANULARITIES = ["none", "per-run", "per-call"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * The egress-BEARING source types. Marker classes carry no coverage claim.
 *
 * Kept in key-sorted order — `serializeCoverage` maps over this array to build the canonical
 * string stored in a boot marker's HASHED `source_id`, so the order IS the wire format. `browser`
 * sorts before `chatops`, which sorts before `http`, which sorts before `mcp`, which sorts before
 * `model`; that is why they head the list rather than trailing it. Appending a new class instead
 * of inserting it in sort order would still typecheck, still round-trip within one binary, and
 * produce a canonical string no other binary agrees with.
 *
 * That also means MEMBERSHIP, not just order, is part of the wire format, in both directions:
 * `parseCoverage` requires every member of this array to be present in a marker string with a
 * recognized `Granularity`, so ADDING a class here invalidates every marker written by a binary
 * built before the addition (it is missing the new key) just as surely as an OLDER binary's marker
 * is unreadable by code that no longer knows one of its keys. This break is fail-safe, not a
 * soundness bug: an unparseable marker returns `null`, which the caller folds into
 * `ALL_NONE_COVERAGE`, so `nimbus prove` reports the window as `indeterminate` rather than
 * silently under-counting it as a clean zero.
 */
export const COVERAGE_CLASSES = [
  "browser",
  "chatops",
  "http",
  "mcp",
  "model",
  "peer",
  "session",
  "sync",
  "task",
] as const;
export type CoverageClass = (typeof COVERAGE_CLASSES)[number];

export type CoverageVector = Readonly<Record<CoverageClass, Granularity>>;

/**
 * What THIS binary is built to observe. SEVEN classes are non-`none`: `task` (the executor's
 * gated-action append, `engine/executor.ts`); `mcp` and `http` — the two external transports an
 * agent brief can be served over, sharing ONE appender (`egress/agent-brief-egress.ts`, selected
 * per transport by the total `EGRESS_BEARING_CLIENT_KINDS` map); `sync` (a connector sync run, a
 * targeted fetch-on-miss call, a cloud media byte-URL RESOLVE round-trip, OR a cloud media
 * byte-fetch attempt, all four landing through
 * `egress/sync-egress.ts`'s `recordSyncEgress` — see the `sync` paragraph below); `model` (any
 * generate, embed, OR vision describe on a NON-LOCAL route, appended
 * by four cooperating wrappers — `egress/model-egress.ts`'s `wrapLedgeredProvider`,
 * `egress/mastra-model-egress.ts`'s `wrapLedgeredMastraModel`, `egress/embedding-egress.ts`'s
 * `wrapLedgeredEmbedder`, and `egress/vlm-egress.ts`'s `wrapLedgeredVlm` — see the `model`
 * paragraph below for exactly what each covers); and
 * `chatops` (every outbound Slack/Teams post, appended by ONE decorator over the shared `post`
 * closure — see the `chatops` paragraph below); and `browser` (every request a computer-use browser
 * lane makes, appended by a decorator over the CDP-backed context — see the `browser` paragraph
 * below). `peer` and `session` stay `none`: neither has an appender at all. Raising either from
 * `none` happens in the SAME commit as its production caller — which is exactly how `browser` was
 * raised, alongside `computer-use/cu-lanes/browser.ts`'s `openBrowserLane`.
 *
 * READ THE `mcp` ENTRY NARROWLY. It is `per-call` over exactly one thing: an `agents.*` brief
 * served to a client that declared `kind: "mcp"`. It is NOT "everything an MCP client does". The
 * same MCP server also exposes nine read-only index tools — `searchIndex`, `getConnectorStatus`,
 * `getRecentIncidents` / `getRecentPullRequests` / `getRecentDeployments`, `getDoraMetrics`, and
 * the three W6-B.2 negation tools `findPrsNotTouching` / `findDeploymentsWithoutIncident` /
 * `findPeopleWithoutReviews` — that hand raw index rows to the same editor model and append NO row
 * at all, and the same socket's `ask` / `search.query` / `glossary.*` calls append nothing either.
 *
 * That narrowing is recorded HERE, in the machine-readable claim, because this vector — not any
 * prose about it — is what gets serialized into a boot marker's HASHED `source_id` and read by
 * published `@nimbus-dev/client` consumers. The `nimbus prove` display label
 * (`COVERAGE_CLASS_LABELS` in `packages/cli/src/commands/prove.ts`) says the same thing for a human
 * reader and is a hand-maintained mirror, since the CLI cannot import this module. `source_type`
 * strings are permanent in the data, so a class whose appender covers less than its NAME suggests
 * must say so at the point the claim is made, not only at the point it is rendered.
 *
 * READ THE `http` ENTRY THE SAME WAY, and more narrowly still. It is `per-call` over exactly one
 * thing: an `agents.*` brief served to a caller verified on the local HTTP API. It is
 * NOT "everything on the HTTP API". `GET /v1/items`, `GET /v1/items/resolve`, `GET /v1/people`,
 * `GET /v1/audit` and the rest of the read surface hand index rows to a local process and append
 * NO row. `GET /v1/items/resolve` is called out by name because it is the newest of them and the
 * one most likely to be mistaken for egress: it takes a URL from an external caller and answers
 * from the LOCAL index without any outbound request. `POST /v1/items/fetch` on the same port DOES
 * make an outbound request and WILL append — but under `sync`, not `http`: the class tracks the
 * KIND of egress (a connector call), not the transport port it arrived on.
 *
 * `sync` is `per-run`, RAISED FROM `none`, and `per-run` — not `per-call` — is the honest
 * granularity for the class as a whole, not a hedge. FOUR appenders share ONE function
 * (`egress/sync-egress.ts`'s `recordSyncEgress` — D22(b) confines the raw `appendEgressEntry`
 * identifier to `egress/*`, so none of the four callers imports it directly): `sync/scheduler.ts`'s
 * `appendSyncEgress` appends ONE row per RUN, before `connector.sync(...)` — and a scheduled sync is
 * a paginated run that can make many upstream calls per row, which is a WEAKER claim than `per-call`
 * would assert; `sync/targeted-fetch.ts`'s `appendEgress` appends one row per its one call, which
 * alone would be `per-call`; `multimodal/cloud-url-resolver.ts`'s `appendEgress` appends one row
 * before the credentialed round-trip that asks Photos/OneDrive where an artifact's bytes live
 * (`method='media.resolveByteUrl'`; the Drive arm needs no round-trip and appends nothing); and
 * `multimodal/cloud-bytes.ts`'s `appendEgress` appends one row per cloud media byte-fetch ATTEMPT
 * (`method='media.fetchBytes'`; a retry appends again), each of which alone would also be
 * `per-call`. So ONE Photos/OneDrive candidate contributes TWO rows, because it makes two real
 * outbound requests — that is not double-counting, and collapsing them would have meant a candidate
 * failing at resolve left NO row for a request that had already gone out. The
 * first two closures are injected by `platform/assemble.ts` — the only production
 * `new SyncScheduler(...)` AND the sole builder of `targetedFetch`'s deps; the last two share one
 * closure injected by `multimodal/build-media-pass-deps.ts`'s `buildCloudBytesDeps`. The vector
 * reports the weakest of the four shapes it actually backs, exactly as `weakestCoverage` merges
 * markers from different binaries — asserting `per-call` here would overstate what the
 * scheduled-sync quarter of this class observes.
 *
 * `model` is `per-call` and covers every NON-LOCAL route in the router's table. The appender is
 * `egress/model-egress.ts`'s `wrapLedgeredProvider`, applied at `LlmRegistry.addRoute`, so it
 * covers `LlmRouter.generate()`, `generateMarkdown()`, and every `selectProvider()` caller
 * (`briefs/brief-llm-adapter.ts` among them) without any of them cooperating — a strictly wider
 * claim than the call-site appender it replaced, which saw only the synthesis path. The
 * local-vs-remote distinction is enforced INSIDE the wrapper, DERIVED from `provider.isLocal` —
 * a local provider is returned unwrapped and appends nothing, not even a blocked row. That is the
 * same choice `sync-egress.ts`'s `recordSyncEgress` makes for `LOCAL_ONLY_SYNC_SERVICES` and for
 * the same reason: a caller-supplied verdict is one wiring mistake away from a false zero.
 * Static rule D22(e) confines `registerRoute` to `llm/registry.ts` so nothing enters the route
 * table unwrapped, and invariant I34 pins the `isLocal` declaration the derivation reads.
 *
 * It is still not literally "all inference" over every model call this binary can make, but the
 * `model` class no longer carries a NAMED exclusion. THE MASTRA ENGINE AGENT is covered by a
 * SECOND `model` appender: `engine/agent.ts` resolves its model through `@mastra/core`, outside
 * the route table entirely, so `wrapLedgeredProvider` never sees it — `egress/mastra-model-
 * egress.ts`'s `wrapLedgeredMastraModel` decorates that model at the AI-SDK seam instead,
 * appending one row before every `doGenerate`/`doStream`. EMBEDDINGS are covered by a THIRD
 * `model` appender: `egress/embedding-egress.ts`'s `wrapLedgeredEmbedder`, applied at each of the
 * embedding pipeline's three construction sites (`embedding/create-routing-runtime.ts`,
 * `embedding/create-embedding-runtime.ts`, `ipc/index-reembed-rpc.ts` — confined there by static
 * rule D22(f)), appending one row per embed BATCH (`method='embedding.embed'`) before
 * `PROSE_HEAVY_TYPES` prose reaches OpenAI's 1536-dim table. So a zero `model` count now means no
 * non-local generate AND no non-local embed left the machine, across every reachable caller of
 * either. The bound that SURVIVES, and is not an exclusion: a LOCAL provider, a locally-run
 * Mastra model, or a LOCAL embedder (MiniLM) is each returned UNCHANGED by its own wrapper and
 * still appends nothing — that is the class working as designed, not a gap in it. Raising `model`
 * further (to cover a model call this vector does not yet know about) requires landing that
 * call's own appender first, the same as every other raise recorded here.
 *
 * `chatops` is `per-call` and, unlike `mcp`/`http`, is NOT narrower than its name. Its appender
 * (`egress/chatops-egress.ts`'s `buildLedgeredChatPosts`) decorates the single `post` closure
 * that every chat consumer shares, so one row is appended per outbound post regardless of which
 * consumer sent it. Before it landed the class did not exist at all — chat posts were neither
 * covered nor disclosed, which is why `nimbus prove` could report a zero over a window in which a
 * brief synthesized from the private index was posted to Slack.
 *
 * `browser` is `per-run`, RAISED FROM `none` in the same commit that gave its appender a production
 * caller. `egress/browser-egress.ts`'s `wrapLedgeredBrowserContext` is a DECORATOR over the
 * driver-neutral `LedgerableContext` shape (structurally typed, not a driver import — see
 * `browser-egress.ts`) rather than a call-site append, the same shape as `wrapLedgeredProvider` and
 * for the same reason: a call-site append covers the callers that exist today, a wrapped instance
 * covers the ones written later without their cooperation. The caller is
 * `computer-use/cu-lanes/browser.ts`'s `openBrowserLane`, which wraps the CDP-backed context it
 * builds and then enables `Fetch` interception THROUGH the wrapper — so every request the lane
 * makes is decided and ledgered before it is allowed to proceed, and an append failure aborts that
 * request (and tears the transport down, so no later request can proceed unrecorded either).
 *
 * `per-run`, not `per-call`, and the distinction is honest rather than a hedge: ONE row per
 * (destination origin, verdict) pair, so a single row can stand for many upstream requests to that
 * origin. Per-request would be thousands of rows for one page load; one row per navigation would
 * understate where data went, since a page pulls from origins the owner never named. The pair shape
 * is bounded at tens and lets `nimbus prove` NAME every host the browser contacted. A request
 * REFUSED by the § 3.5.1 policy appends a `blocked` row, exactly as a denied executor gate does — a
 * cluster of those naming an unapproved origin is the clearest signal that something is steering
 * the page toward exfiltration, retained even though nothing left the machine.
 *
 *
 * READ THE CLASS'S SCOPE NARROWLY, as `mcp`/`http` must be read: it covers requests made by the
 * lane's PAGE TARGET, which is where `Fetch.enable` is scoped. It does NOT cover Chrome's own
 * BROWSER-PROCESS traffic — variations, Safe Browsing, component and reliability beacons — which
 * originates outside any page target and therefore reaches neither `decideRequest` nor this
 * ledger. That is not a hypothesis: the macOS CI leg's harden-runner log recorded a
 * freshly-launched Chrome resolving and connecting to `www.google.com` and `accounts.google.com`
 * before any page had loaded, with `--disable-background-networking`, `--disable-component-update`,
 * `--disable-sync` and `--metrics-recording-only` all already set. `browser-launch.ts` adds
 * `--no-pings`, `--disable-breakpad` and `--disable-domain-reliability` to cut what can be cut
 * without disabling a safety feature, but the residue is real and is NOT ledgered. So a `browser`
 * count of zero means the lane's page made no request — never that the browser process made none.
 * Closing this would need browser-level interception (a proxy, or `Target.setAutoAttach` over the
 * browser target) and is not attempted here; stating it is what keeps the count honest.
 *
 * READ THE BOUND, which is § 3.5.1's and not this class's: `script` and `image` subresources are
 * allowed from ANY origin (blocking either breaks the real web), so a `<script src>` or `<img src>`
 * whose URL carries a payload is a working exfiltration channel. It appends an `authorized` row
 * naming the destination origin — that row IS the mitigation — but a `browser` count of N does not
 * mean at most N requests, and a non-zero count naming an unfamiliar origin deserves reading.
 *
 * `[computer_use]` is DEFAULT OFF with an empty `allowed_lanes`, so on a stock install this class's
 * appender is never constructed and its count is zero because nothing ran — which is exactly the
 * claim, and not a weaker one: `per-run` here says "if a browser lane made a request, there is a
 * row for its origin", and that holds whether or not any lane was ever opened.
 */
export const THIS_BINARY_COVERAGE: CoverageVector = {
  // RAISED from "none" in the same commit that gave `wrapLedgeredBrowserContext` its production
  // caller — `computer-use/cu-lanes/browser.ts`'s `openBrowserLane`, which wraps the CDP-backed
  // context it constructs before enabling request interception. Per this file's own rule, never
  // ahead of that landing (see the `browser` paragraph above and invariant I35).
  browser: "per-run",
  chatops: "per-call",
  task: "per-call",
  mcp: "per-call",
  http: "per-call",
  session: "none",
  sync: "per-run",
  model: "per-call",
  peer: "none",
};

/**
 * Claims nothing about any class. Used as the contribution of an UNPARSEABLE boot marker, so the
 * weakest-merge drives the whole window to `none` (→ `indeterminate`) rather than letting a
 * sibling marker's richer claim stand unchallenged.
 */
export const ALL_NONE_COVERAGE: CoverageVector = {
  browser: "none",
  chatops: "none",
  task: "none",
  mcp: "none",
  http: "none",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/** Stable, key-sorted serialization. Stored in the HASHED `source_id`, so it must be canonical. */
export function serializeCoverage(v: CoverageVector): string {
  return COVERAGE_CLASSES.map((c) => `${c}=${v[c]}`).join(";");
}

function isGranularity(s: string): s is Granularity {
  return (GRANULARITIES as readonly string[]).includes(s);
}

/**
 * Parse; returns null (never a guess, never a partial vector) unless the string is EXACTLY the
 * canonical `serializeCoverage` shape: every `;`-segment is a single `key=value` pair (no extra
 * `=`), every key is a known `CoverageClass`, every key appears at most once, and every class is
 * present with a recognized `Granularity`.
 *
 * This is deliberately strict — a marker written by a NEWER binary that adds an unknown coverage
 * class, or that is merely malformed, must be REJECTED (→ `null`, which the caller turns into
 * `ALL_NONE_COVERAGE`) rather than silently accepted with the unknown/duplicate/extra data
 * dropped. Accepting-and-ignoring would let that marker contribute real (understated but
 * plausible-looking) coverage instead of forcing the window to `indeterminate` — exactly the
 * forward-compatibility failure this function exists to prevent.
 */
export function parseCoverage(s: string): CoverageVector | null {
  const found = new Map<string, string>();
  for (const part of s.split(";")) {
    const eq = part.split("=");
    if (eq.length !== 2) return null; // not exactly one `key=value` pair (0 or ≥2 `=` signs)
    const [k, val] = eq as [string, string];
    if (!(COVERAGE_CLASSES as readonly string[]).includes(k)) return null; // unknown key
    if (found.has(k)) return null; // duplicate key
    found.set(k, val);
  }
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    const val = found.get(c);
    if (val === undefined || !isGranularity(val)) return null;
    out[c] = val;
  }
  return out as CoverageVector;
}

/**
 * The weakest granularity per class across every binary that wrote into a window.
 *
 * An EMPTY list yields all-`none`: with no boot marker there is no evidence of any coverage, and
 * the correct response is to claim nothing.
 */
export function weakestCoverage(vs: readonly CoverageVector[]): CoverageVector {
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    let weakest: Granularity = "none";
    if (vs.length > 0) {
      weakest = vs.reduce<Granularity>((acc, v) => {
        return GRANULARITIES.indexOf(v[c]) < GRANULARITIES.indexOf(acc) ? v[c] : acc;
      }, "per-call");
    }
    out[c] = weakest;
  }
  return out as CoverageVector;
}
