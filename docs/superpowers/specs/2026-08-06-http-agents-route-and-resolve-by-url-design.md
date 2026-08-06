# HTTP agent invocation + resolve-by-URL — design

**Status:** design, approved 2026-08-06. Implementation plan follows separately.
**Slot:** Spine S1 (Local Brain). **Successor to:**
[`2026-08-02-agents-as-mcp-tools-design.md`](./2026-08-02-agents-as-mcp-tools-design.md)
§ _Out of scope_, unblocked by #1059 (v1.22.0).

## The problem

Three surfaces are blocked on the same two missing gateway reads, and the roadmap
already says so ([`docs/roadmap.md`](../../roadmap.md) § Track 2 → Client
surfaces):

- The **browser-side gateway client** needs both and has neither.
- The **stdio MCP adapter** holds the only agent-invocation implementation, in
  `packages/cli`. An HTTP route lets it become a thin client rather than a
  parallel implementation.
- The **editor extension** gets the same treatment.

Verified in the tree rather than assumed:

- `packages/gateway/src/ipc/http-server.ts` has no agents route.
- `canonical_url` is a plain `TEXT` column (`index/unified-item-v3-sql.ts:24`)
  with no index — `item` carries only `idx_item_service`, `idx_item_type`,
  `idx_item_modified_at`. Nothing keys on it.
- `packages/cli/src/mcp/` holds `AGENT_TOOL_SPECS`, the brief router and the
  client-kind handshake from #1059. Its param contracts are correct and
  validator-mirrored, and this design deliberately does not copy them (§1).

## Relationship to the 2026-08-01 browser spec

`docs/superpowers/specs/2026-08-01-browser-gateway-client-design.md` is
**committed but unmerged**, on branch `dev/asafgolombek/spec-browser-client`
(`d8b4d93d`) — so it is deliberately *not* linked here: the path does not resolve
on this branch and a relative link to it would fail the link gate.
`docs/roadmap.md` calls it "planned, not yet written"; that is stale. It owns the **extension side** — recogniser, panel, notify-when-ready —
and this document owns the **gateway side**.

It ends on two open questions, which are this design's subject:

> Does `agents.*` need a new transport entry point for HTTP callers, or can the
> existing surface be reused as-is?
> What is the per-connector "fetch one item" contract, and how much of it can be
> shared rather than written five times?

Answered in §1 and §5 respectively.

**Three of its assumptions are wrong and are corrected here.** All three were
checked against source, not reasoned about — the failure mode recorded in the
#1059 retrospective, where a plan was confidently wrong in four places and every
test still passed.

| Assumption | Reality |
| --- | --- |
| Targeted fetch goes "through the connector, never a direct HTTP call", and "is a `connectors.dispatch`, so under I29/D22 it appends an `egress_ledger` row" | `connectors/bitbucket-sync.ts:280` calls `fetch(url, …)` directly against `api.bitbucket.org`. It calls `ensureBitbucketMcpRunning()` first, then does its own HTTP. A targeted fetch modelled on sync is **not** a dispatch and gets **no** ledger row for free. §2 lands the appender that makes the claim true. |
| Abort is free: `POST /v1/jobs/:id/cancel` → `registry.cancel(jobId)` | Agents use no `LongRunningJobRegistry` and contain no `AbortController`. Four subsystems use the registry — `identity-boot`, `glossary`, `index-reembed`, `security-scan` — and agents are not among them. Agent cancellation does not exist; §6 records it as out of scope rather than implying it ships. |
| Resolve is "No new table; a new query only" | `canonical_url` carries no index and stores raw provider URLs. Resolve needs a derived key, an index and a backfill (§4). The roadmap already corrected this. |

Non-negotiable #4 ("the engine never calls cloud APIs directly") is not violated
by the first row: it governs the **engine** — the executor's gated action path —
and sync handlers are a separate path that has always called provider APIs
directly.

## Decisions taken

Owner-decided during brainstorming. Recorded so they are re-decided rather than
re-discovered.

- **All three surfaces in scope**, including fetch-on-miss.
- **`fetchOne` as an optional `Syncable` method**, not a priority full-sync.
- **A new `http` source type and coverage class**, named for the verifiable
  transport rather than a caller-declared client kind.
- **The `sync` coverage class rises to `per-run`**, with a real appender.
- **Token scopes land in this slice**; a legacy token keeps exactly `clip` +
  `briefs` and gains nothing.
- **Fetch-on-miss is not HITL-gated**; it is bounded by scope, rate limit and a
  derived host allowlist.
- **Route-shaped agents endpoint, not a generic `POST /v1/rpc` bridge** (§1).

## §1 — Surfaces

Five routes. Writes go on `WRITE_ROUTE_ALLOWLIST` (`I13`); reads mount in the
`fetch` handler **before** the unauthenticated GET table, as `GET /v1/briefs/{id}`
does and for the reason stated there — that table is documented "no bearer gate",
so routing private output through it would expose it to any local process.

| Route | Side | Scope | Notes |
| --- | --- | --- | --- |
| `POST /v1/agents/{agent}` | write (`I13`) | `agents` | Body = IPC params **verbatim**. Returns `{runId}`. |
| `GET /v1/agents/runs/{id}` | bearer read | `agents` | Poll. 200 running/done, 404 unknown, 410 expired. |
| `GET /v1/agents` | bearer read | `agents` | Derived from `AGENTS_RPC_HANDLERS`; cannot drift. |
| `GET /v1/items/resolve?url=` | bearer read | `resolve` | §4. |
| `POST /v1/items/fetch` | write (`I13`) | `fetch` | §5. |

`{agent}` resolves against `AGENTS_RPC_HANDLERS` **minus `agents.preflight`**,
carried over unchanged from the MCP design: it is the `I24` federated-action path,
and a caller that can invoke it can queue consent prompts on the owner's machine.
`ghost` and `huddle` stay in, as they did for MCP.

`POST /v1/items/fetch` is a separate route rather than a resolve fallback, per the
recorded decision that it is allowlisted explicitly as an `I13` write rather than
reclassified as a read to slip past the allowlist.

### Delivery is dependency injection, not a bridge

`AgentsRpcContext.notify` is an injected `(method, params) => void`
(`ipc/agents-rpc.ts:46`), and `emitBriefWithSynthesis` calls it with
`{sessionId, brief, findings}` or `{sessionId, error}`
(`agents/_lib/emit-brief.ts:54`). The handler therefore builds an
`AgentsRpcContext` whose `notify` writes into an `AgentRunController` modelled on
`BriefRunController` — plain `Map`, injected clock, lazy expiry, tombstone set
driving 410-vs-404, concurrency cap. **No agent code changes.**

The gateway's `sessionId` (`<agent>_<ts>_<uuid8>`) becomes the `runId` rather than
minting a second identifier, so a ledger row, a brief and an HTTP poll all name
the same thing.

**Runs are in-memory and a restart drops them — deliberately.** `BriefRunController`
makes the same choice and says why: it "makes 'source text is ephemeral' a
structural property rather than a promise." The argument is stronger here.
Persisting agent runs would write **synthesised brief text** — derived from the
private index — into a new on-disk table, which is a privacy expansion, and it
would buy little: a brief is reproducible from the index by re-issuing the call,
unlike a research brief's captured source bodies.

The cost is that a client polling across a restart sees `404`, not `410`, because
the tombstone set dies with the process. That is a contract, so it is stated
rather than left to be discovered:

- `200` — run known; `status` is `running`, `done` or `failed`.
- `404` — unknown **or lost to a restart**. The client must treat this as
  terminal-unknown and re-issue the call, never as "still running."
- `410` — known and expired past TTL within this process lifetime.

A client cannot distinguish "never existed" from "lost to a restart," and does not
need to: the response to both is to re-issue.

### Why not a generic `POST /v1/rpc` bridge

The bridge is the more elegant answer to the recorded successor — the stdio
adapter's `client.call(method, params)` would be unchanged, a pure transport swap,
and the MCP server's six index tools would get a home. Two objections against it
do **not** survive checking and are recorded as rejected reasoning:

- *"Larger threat model."* `hostname: "127.0.0.1"` is a hardcoded literal in
  `Bun.serve` (`http-server.ts:738`), not config. The HTTP surface sits on the
  same trust boundary as the IPC socket.
- *"Method allowlists are weaker than route allowlists."* `I7`'s `ALLOWED_METHODS`
  is a method allowlist this codebase treats as load-bearing.

The objection that does survive is `I29`. Route-shaped, the only new
HTTP-reachable capability is agents, and `dispatchAgentsRpc` already owns the
append — coverage is total **by construction**, and the static rule is provable.
Bridge-shaped, egress coverage becomes a per-method obligation over an open-ended
surface, and the methods wanted first are the problem: `search.query` and the index
reads hand raw index rows to an external client and append nothing.
`egress-coverage.ts` already concedes exactly this for the MCP index tools. A
bridge would ship a general remote-read surface whose ledger coverage is decided
method by method, while `D22` is a regex over a string literal and can see none of
it.

Two secondary costs also survive: `WRITE_ROUTE_ALLOWLIST`'s per-route body caps
(8 KiB control-plane vs 1 MiB article) and the per-token rate limiter both key on
route, and a method allowlist over HTTP is one array edit from `vault.*` — `I7`
chain C1's shape.

**The bridge is sequenced, not rejected.** If the index tools need HTTP, the
decision reopens *with the coverage question answered first*.

Cost of the route-shaped choice, stated plainly: the index tools stay on the
socket, so an adapter migration would speak two transports, and that migration
rewrites its await mechanism. The param-building code — #1059's defect area — is
untouched either way, and polling would delete `AgentBriefRouter` rather than
complicate it.

## §2 — `I29`, and closing the `D22` reach limit

The whole-branch review of #1059 recorded the reach limit precisely: a second
entry point calling the `agents/*` emitters directly would append no egress row
and still pass `audit:invariants` green. **This slice is that second entry point.**

### The append site does not move

`dispatchAgentsRpc` already appends before dispatch (`ipc/agents-rpc.ts:584`), and
the HTTP route reaches agents *through it*. No second appender is built. The
condition generalises from an equality to a lookup:

```
EGRESS_BEARING_CLIENT_KINDS: mcp → "mcp", http → "http"
```

`cli` / `ui` / `unknown` map to nothing and append nothing — #1059's
false-positive guard survives verbatim and gains a second case.
`recordMcpBriefEgress` becomes `recordAgentBriefEgress`, no longer being
MCP-specific; `D22(c)`'s regex moves with it in the same commit.

### Attribution is stronger over HTTP than over stdio

There is no connection to hand-shake, so the handler builds
`caller: {clientId: <verified token label>, kind: "http"}` from the result of token
verification — **server-derived, never caller-supplied**, the `I23` property. Where
MCP's kind is ultimately a client's self-declaration, HTTP's is a fact the gateway
checked.

Row shape: `source_type='http'`; `destination` `"http"` or `"http+federation"`,
reusing the existing `FEDERATION_TOUCHING` set so outbound peer traffic stays
distinguishable; `source_id` the token label; `method` the `agents.*` method.
The append precedes run creation, so a failed append yields a 500 and **no run** —
no row, no brief.

### `D22(d)` — the tightening

`D22(c)` pins *one known caller*. That is not the property `I29` needs, and the
MCP design said so itself: "A test that only proves 'this file is allowed to
append' is not an enforcement test." So the rule becomes total:

> No file outside `packages/gateway/src/ipc/agents-rpc.ts` may import an agent
> **emitter** module — `agents/<name>.ts`, excluding `agents/_lib/`.

Verified to land green today: the only non-test importers of `agents/*` are
`agents-rpc.ts` (all eleven emitters), plus `federation/peer-fanout.ts` and
`ipc/index-demo-symbol-rpc.ts`, which import `_lib/findings.ts` and
`_lib/demo-symbol.ts` — types and a helper, not emitters.

`D22(d)` converts "one caller is pinned" into "the chokepoint is the only door."
A third entry point — the eventual `POST /v1/rpc`, a ChatOps path — then cannot
bypass the ledger without a static failure. This is the answer to *how the static
rule is tightened so the next entry point cannot repeat this*.

**Where and how it is enforced.** In `scripts/structure-audit/check-nimbus-invariants.ts`,
beside `D22(a)`–`(c)`, so it runs in `audit:invariants` — before the test suite,
failing first. Like its siblings it is a per-line regex, and it must match **both**
`import … from ".../agents/<name>.ts"` and a dynamic `import("…/agents/<name>.ts")`,
or the rule is trivially sidestepped by the one-character change from static to
dynamic import.

**What it cannot see, stated because `D22`'s existing weakness is exactly this.**
A regex over import specifiers does not follow re-export chains: were an emitter
re-exported through `agents/_lib/`, a file could import it from the excluded path
and the rule would miss. That is not a hypothetical class so much as the same shape
as the recorded `D22` limit — "wrapper/façade/raw-execute paths are out of its
reach and are addressed by capability removal." The mitigation is the same:
`agents/_lib/` must not re-export emitters, and the enforcement test asserts that
directly rather than trusting the import rule to cover it.

### The `sync` class

Rises `none` → `per-run`, appended at the scheduler's sync-run boundary and by
`fetchOne`, with `destination` the service id. `per-run` is the honest
granularity: a sync is a paginated run, not a call.

### Costs, stated rather than buried

- `COVERAGE_CLASSES` gains `http` and becomes seven. The array **is** the wire
  format (`serializeCoverage` maps over it into a hashed `source_id`), and it is
  key-sorted, so `http` sorts to the head.
- The pin at `security-invariants.test.ts:1375` goes from `["mcp","task"]` to
  `["http","mcp","sync","task"]`. Its comment calls widening it "a review moment,
  not a test to re-bank" — this is that moment.
- `COVERAGE_CLASS_LABELS` (`packages/cli/src/commands/prove.ts:46`) is the
  hand-maintained CLI mirror the coverage file warns about; it gains two entries
  in the same commit.
- **Every `nimbus prove` window spanning this upgrade reports `indeterminate` on
  every class**, because `parseCoverage` rejects unknown *and* missing keys. That
  is the intended fail-safe. Do not soften it.

## §3 — Token scopes, and the `I13` posture

`docs/ecosystem-roadmap.md` states the problem and the deadline: "a token minted
to clip a web page becomes: run any read-only agent over the whole index, resolve
any URL, and read the pending-approval queue. Add scopes before the second
consumer, not the fifth." This slice adds consumers five through eight.

**Shape.** The Vault map's value becomes `{token, scopes[]}`, with a bare string
still parsed as the legacy form. `CLIP_TOKENS_VAULT_KEY`
(`http_api.web_clipper_tokens`) **does not change** — renaming it would strand
every paired browser, and it sits on the statically-enforced vault-key allow-list.
The name becomes historical and is documented as such; the functions lose the
`Clip` prefix (`verifyClipToken` → `verifyApiToken`), which is also how the
compiler finds every existing call site.

Five scopes: `clip`, `briefs`, `agents`, `resolve`, `fetch`. A legacy bare-string
token resolves to exactly `["clip","briefs"]` — everything it can do today, none
of what this slice adds. No paired browser breaks; none silently gains agent
invocation over the whole index. New capability requires a re-pair.

**Scopes are owner-set, never requester-set.** `nimbus clip pair --scopes
agents,resolve` records them on the `PairingWindowController` window; `POST
/v1/clips/pair/confirm` mints with *the window's* scopes and ignores anything in
the request body. `I30` is unchanged, and the rule is the same server-derived one
as §2 — a caller that could name its own scopes would grant itself the set.

**Scopes are editable in place, without a re-pair.** `nimbus clip scopes <label>
--set clip,briefs,agents` rewrites one entry's scope list; it can narrow as well
as widen. This is not a convenience: if the only way to add a scope were to delete
and re-pair, the rational move at mint time becomes "grant everything, so I never
have to do this again" — which reproduces the exact over-granting the scope work
exists to end. Both paths are equally owner-controlled, since both require local
CLI access, so there is no security difference to trade for the ergonomics. The
change is Vault-side only; the token value never changes, so a paired client keeps
working.

**The structural guard matters more than the scopes.** A per-route check a new
route can forget to call is fail-open, which is the shape both recent invariant
reviews turned on. So the mapping is a table — route → required scope — and
`verifyApiToken` returns `{label, scopes}` rather than `{label}`, with a
completeness test asserting **every** `WRITE_ROUTE_ALLOWLIST` entry and every
bearer-gated read appears in it. Adding a route without a scope fails the suite
rather than defaulting to "any token works."

The table is **total over the surface, not just the gated part**: the
unauthenticated GET routes (`/v1/health`, `/v1/items`, `/v1/connectors`,
`/v1/people`, `/v1/audit`, `/v1/metrics/dora`, `/v1/openapi.json`) are listed
explicitly as `public`. Enumerating them costs nothing and buys the one thing a
gated-only table cannot give: a route that is public **by decision** becomes
distinguishable from a route that is public **by omission**. That distinction is
the whole failure mode here — today's GET table is ungated by convention, and a
convention is exactly what a new route silently joins.

`constantTimeStringEqual`'s no-short-circuit loop over every entry is preserved
verbatim (`I10`); the scope lookup happens only after a match is recorded, so it
cannot reintroduce a timing signal.

**`I13` posture.** `POST /v1/agents/{agent}` and `POST /v1/items/fetch` go on
`WRITE_ROUTE_ALLOWLIST` at `MAX_BODY_BYTES_DEFAULT` (8 KiB) — agent params and a
single URL are control-plane-sized, and the 1 MiB article cap stays the deliberate
outlier it is documented to be. `HttpWriteRateLimiter` (60/min/token) applies, but
it is not the real bound for agent runs: the `AgentRunController` concurrency cap
is, mirroring `MAX_CONCURRENT_RUNS`.

## §4 — Resolve-by-URL

**Storage.** A new `resolve_key TEXT` column on `item`, plus
`idx_item_resolve_key`. Value is `canonicalizeUrl(canonical_url ?? url)`, or NULL
when both are null. Written at exactly one site — `upsertIndexedItemForSync`, the
chokepoint V48/V49 established — so no connector can forget it and no connector
changes.

A derived column rather than an index on `canonical_url` directly, because the
stored values are raw provider URLs (`github-sync.ts:209`:
`canonicalUrl: htmlUrl ?? null`) while the incoming value is whatever is in the
address bar. Matching those requires normalisation on both sides, and SQLite
cannot run `canonicalizeUrl`.

`canonicalizeUrl` (`util/url-canonical.ts`) is **reused, never modified** — its
docstring records that `externalIdFor` hashes its output, so changing its rules
changes clip identity.

**Migration V50** adds column + index, then backfills as a bespoke step:
`canonicalizeUrl` is JS, so the backfill reads, computes and updates row-wise
rather than being expressible as one `UPDATE`. It backfills in the migration
rather than deferring to a CLI, because a resolve read that silently misses the
entire pre-existing index until someone runs a command is a wrong answer, not a
pending one.

Three properties of the runner constrain how that step is written, and all three
were checked in `index/migrations/runner.ts` rather than assumed:

- **Arbitrary JS is the native shape, not an exception.** A step is
  `apply: (db: Database, now: number) => void`, and `simpleStep` is a declarative
  *convenience* wrapper over it. The runner's own docstring names "a custom data
  backfill alongside the schema change" as the reason to write a bespoke
  `migrateIndexedV*` function; `backfillAuditChain` and `backfillMigrationsLedger`
  are existing precedents. No two-phase schema-then-startup-backfill is needed.
- **`apply` is synchronous.** An `async` backfill cannot be awaited by the runner.
  Both `canonicalizeUrl` and `bun:sqlite` are synchronous, so this costs nothing —
  but it forecloses a batching design built on promises.
- **The whole step runs inside one `db.transaction`.** So "batched" means *chunked
  reads to bound memory*, *never a commit per batch*. Committing per batch would
  break the step's atomicity and could leave `resolve_key` half-populated with
  `PRAGMA user_version` already advanced — a silently partial index that resolves
  some URLs and not others, which is worse than not shipping the column.

**Matching is a bounded ladder, not a rule set.** `canonicalizeUrl` strips
fragment, `utm_*`/click-ids and a non-root trailing slash — nothing else — so
browser view-state survives it. Resolve tries, in order:

1. the canonical key;
2. the key with **all** query params dropped;
3. up to three progressively trimmed trailing path segments.

That covers `?tab=files` and `/pull-requests/42/diff` with no per-service rule to
drift. A trimmed match must be **unique** or the answer is `ambiguous` — trimming
can over-reach, and guessing between candidates is worse than declining.

**`ambiguous` carries its candidates.** Declining to guess is right; declining to
*say what the choices were* would push the client into a dead end, and the panel
is the one place a human can resolve the ambiguity in one click. So the response
carries the matches as metadata — the same shape and the same privacy class a
successful resolve already returns to the same bearer-scoped caller, so it
discloses nothing new.

The list is **capped at five**, because rung 3 trims path segments and can match
broadly; an uncapped list would turn a mis-trimmed URL into a bulk index read.
Over the cap the answer stays `ambiguous` with `truncated: true` and no candidates,
since a truncated choice menu is a misleading one.

```
{found:true, item:{id,service,type,title,url,modified_at},
 matchKind:"exact"|"query_stripped"|"path_trimmed"}
{found:false, reason:"not_indexed"|"unresolvable_url", service, fetchable}
{found:false, reason:"ambiguous", service, fetchable,
 candidates:[{id,service,type,title,url}], truncated:boolean}
```

`fetchable` is the seam to §5: it tells the panel whether `POST /v1/items/fetch`
would help instead of making it guess.

**Resolve returns metadata only, never a body.** It is a resolver; reading is
`GET /v1/items/{id}`, which already exists. That is also a deliberate avoidance —
body responses would drag in the `metadata_only` redaction path, which currently
carries two unfixed privacy defects, and this slice has no business re-deciding
that.

**One honesty point, recorded rather than buried.** Resolve appends **no** egress
row, exactly as the six MCP index tools append none. So the `http` coverage class,
like `mcp` before it, covers less than its name suggests: it is `per-call` over
`agents.*` briefs served on the HTTP API, not over "everything on the HTTP API" —
even though `POST /v1/items/fetch` on the same surface *does* append, under `sync`.
`egress-coverage.ts` requires this to be said where the claim is made, not only
where it is rendered, so the narrowing goes in the `THIS_BINARY_COVERAGE` comment
and in `COVERAGE_CLASS_LABELS`. The alternative is a narrower class name; `http`
with documented narrowing is chosen for consistency with the `mcp` precedent, and
is recorded here as a named risk rather than a settled nicety.

## §5 — `fetchOne`, and the host boundary

**Contract.** `Syncable` gains an optional method:

```ts
fetchOne?(ctx: SyncContext, url: string):
  Promise<{status:"indexed", itemId: string}
        | {status:"not_found"}
        | {status:"unsupported_url"}>
```

Optional does real work: 62 connectors do not move, and a service that omits it
makes the route answer `no_targeted_fetch` rather than pretending. Starter set:
`github`, `gitlab`, `bitbucket`, `jenkins`, `jira`. Each reuses its existing
mapping function (`upsertFromPullRequest` and siblings) and writes through
`upsertIndexedItemForSync`, so index depth is enforced centrally and `resolve_key`
is populated by the same write — the item is resolvable the instant it lands.

**The host boundary is the security property, and it is derived, not declared.**
A URL is fetchable only when its host maps to a **configured** connector: the
static SaaS hosts for `github`/`gitlab`/`bitbucket`, union the host of each
`<service>.base_url` read from the Vault for the self-hosted ones. Absent
credentials, a service is not in the map at all.

Self-hosted base URLs live in the **Vault**, not config —
`readConnectorSecret(ctx.vault, "jenkins", "base_url")`
(`jenkins-sync.ts:263`); eleven connectors carry a `base_url` secret. GitLab is
not among them, so self-hosted GitLab is unreachable today either way.

This lives in a shared module with its own tests, explicitly **not**
`agents/impact.ts`'s `HOST_TO_SERVICE` (`impact.ts:130`) — a three-entry SaaS-only
map with a `hostFirstSegment` guessing fallback that would resolve an arbitrary
host to a plausible-looking service name. That is the difference between a hint
inside a brief and a gate on an outbound request.

Adopting the 2026-08-01 spec's stronger formulation, which is right and is kept:
the gateway re-derives `{service, kind, externalId}` **server-side**, never trusts
the caller's classification, and fetches **via that connector's API using its
stored credential — never by dereferencing the supplied URL**.

Beyond the host gate: `ProviderRateLimiter.acquire(service)` on the same bucket the
scheduler uses (so this can neither starve nor bypass it), and the existing
pagination-SSRF hardening from #694 rather than a second fetch path.

**Egress.** One `sync` row appended before the outbound call — `destination` the
service id, fail-closed, no row means no fetch. This is the appender that raises
`sync` to `per-run` in §2, alongside the scheduler's.

**Shape.** Synchronous with a bounded timeout, not a run. A brief does LLM
synthesis and deserves polling; this is one upstream API call, and a second
run-store lifecycle to poll a single fetch would be ceremony. On timeout it
returns a miss and the caller may retry; the scheduler picks the item up
regardless.

`indexed` / `not_found` / `unsupported_url` / `no_targeted_fetch` /
`not_configured` / `rate_limited` are all distinct, because collapsing them is how
a panel ends up telling a user to check credentials that are fine.

**Consent posture.** Not HITL-gated. The owner already authorised continuous sync
of that service with those credentials; fetching one already-in-scope item is
strictly less than what runs on a timer. It is bounded instead by the `fetch`
scope (never granted to legacy tokens), the provider rate limiter, and the derived
host allowlist. HITL was rejected on the same ground the MCP design rejected
`agents.preflight`: an external caller should not originate a consent prompt on
the owner's machine.

## §6 — Testing

Each guard is **red-proved** before it counts — a guard that has never failed is a
guard nobody has checked.

| Test | Proves |
| --- | --- |
| Ledger totality | an HTTP brief appends exactly one `source_type='http'` row |
| Attribution | a **CLI** call still appends none — #1059's false-positive guard extended, not replaced |
| Fail-closed | a throwing append yields 500, **no run created**, no brief |
| `D22(d)` red-prove | an emitter import planted outside `agents-rpc.ts` fails `audit:invariants` — planted **twice**, once static and once dynamic; passing green today is not evidence |
| `_lib` no-re-export | `agents/_lib/` re-exports no emitter, closing the one gap the import regex cannot see |
| Coverage skew | a pre-`http` boot marker parsed by this binary → `indeterminate`, asserted as the accepted cost rather than discovered later |
| Scope completeness | every `WRITE_ROUTE_ALLOWLIST` entry, every bearer read **and every public GET** appears in the route→scope table |
| Legacy token | a bare-string token gets exactly `clip+briefs` and is **rejected** on `/v1/agents` |
| Scope provenance | scopes in the pair-confirm body are ignored; the window's win |
| Scope edit | `nimbus clip scopes` narrows and widens in place; the token value is unchanged, so a paired client keeps working |
| Resolve ladder | each rung matches; an ambiguous trim returns `ambiguous`, never a guess |
| Ambiguity cap | >5 candidates yields `truncated:true` and **no** candidate list, never a partial menu |
| Migration | the V50 backfill makes pre-existing rows resolvable |
| Migration atomicity | a backfill that throws mid-way leaves `user_version` **unadvanced** and `resolve_key` unpopulated — no half-migrated index |
| Host boundary | an arbitrary host, an unconfigured service, and a configured Vault `base_url` host each get their own outcome |
| Run lifecycle | 404 unknown, 410 expired, concurrency cap, TTL expiry without polling |

### On the #1059 param trap

The HTTP route passes the body **verbatim** to the gateway's own validator. Unlike
the MCP adapter it builds no params and mirrors no schema, so there is no second
contract to drift — the structural fix for the failure that cost the most last
time, when four invented param shapes passed every test because the fakes echoed
params back.

What it does **not** fix: those validators ignore unrecognised keys, which is how
`{topic}` looked like it worked. That laxity is pre-existing gateway behaviour and
tightening it would change IPC semantics for every existing caller, so it is
recorded as a known gap and left out of scope — not quietly inherited as though
solved.

## Sequencing

Four PRs. Each carries wiring + docs + tests in one commit per the triple rule.

1. **Token scopes** — map shape, `verifyApiToken`, route→scope table +
   completeness guard, `--scopes` on the pairing window. No new capability; it
   only makes the next three expressible.
2. **Agents over HTTP** — `http` client kind, source type and coverage class; the
   generalised append; `recordAgentBriefEgress` rename; **`D22(d)`**; the agent
   routes; `AgentRunController`. Updates `SECURITY-INVARIANTS.md` (`I29`, `D22`).
3. **Resolve** — V50 `resolve_key` + index + batched backfill, the ladder,
   `GET /v1/items/resolve`. Updates the schema reference.
4. **Fetch-on-miss** — the scheduler's `sync` appender (raising `sync` to
   `per-run`), `fetchOne` on five connectors, the host-boundary module,
   `POST /v1/items/fetch`. Updates `SECURITY-INVARIANTS.md` (`I29`).

**One sequencing property, load-bearing and non-obvious: there is exactly one
`prove` blackout, in PR 2.** `parseCoverage` returns null on an unknown *or*
missing key, so adding `http` breaks marker parsing in both directions. But
raising `sync` from `none` to `per-run` in PR 4 changes only a *value*, and
`weakestCoverage` degrades that gracefully to `sync=none` across a mixed window.
So splitting the appenders across PRs costs nothing extra, and PR 4 need not ride
with PR 2.

All four update [`docs/CHANGELOG.md`](../../CHANGELOG.md).

## Out of scope

- **Agent cancellation.** No `AbortController` exists on the agent path, so a
  cancel route would be a lie. Recorded against the 2026-08-01 spec's assumption
  that it was free.
- **Persisting agent runs to SQLite.** Considered and rejected in review: it would
  write synthesised brief text derived from the private index into a new on-disk
  table — a privacy expansion — to buy resumption of something reproducible by
  re-issuing the call. The `404`-on-restart contract in §1 is the answer instead.
- **A generic `POST /v1/rpc` bridge.** Sequenced behind the per-method egress
  coverage question it depends on (§1), not rejected.
- **Migrating the stdio MCP adapter to HTTP.** The route makes it possible; doing
  it is its own change, and the six index tools have no HTTP home yet.
- **Tightening the `agents.*` validators to reject unknown keys.** Pre-existing
  IPC semantics; changing them affects every caller.
- **Write-capable agent tools, and `agents.preflight`.** Unchanged from the MCP
  design and for the same `I24` reason.
- **The extension side** — recogniser, panel, progressive rendering,
  notify-when-ready. Owned by the 2026-08-01 spec and the satellite repo.
- **Body responses from resolve**, which would reach the `metadata_only`
  redaction path and its two unfixed defects.

## Open questions

- Whether `GET /v1/agents` should also publish each agent's parameter schema.
  Doing so means deriving it from the validators, which are hand-written
  imperative checks — deriving is not currently possible and hand-mirroring is
  the exact #1059 defect. Resolve by measurement of what the browser client
  actually needs, not up front.
- Whether the `http` class name should be narrowed (§4's named risk) if a second
  non-appending HTTP capability lands. Re-decide then, with the data.
- Whether `fetchOne`'s starter set should include Jira on the first PR, given its
  URL shapes vary most across Cloud and Server.
