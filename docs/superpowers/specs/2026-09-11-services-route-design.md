# `GET /v1/services` — the configured services, and the repos they claim

> **Status: ANSWERED — the resolve form of §5 shipped 2026-09-11.** This
> document is kept as the argument, not as a description of the surface; where
> it and the code disagree, the code is right and `docs/CHANGELOG.md` records
> why. What landed: `GET /v1/services/resolve`, bearer-authed under the existing
> `resolve` scope, returning a total `{ service, ambiguous, candidates }`. The
> answers to every question in §11, and the one place this document turned out
> to be wrong (§5.1's guess about the entry point), are recorded inline below.
>
> **The list form of §7 did NOT ship** and stays compatible and unbuilt, so §7
> and §11's list-form questions — Q2, Q6, and Q3 as it applies to that form —
> remain live proposals rather than closed ones.
>
> Originally filed as: proposal, no code in the branch — the contract argued
> before it is built, per the satellite-repo convention that the gateway owns
> the wire and consumers propose against it (#1464 established the shape).
>
> **Proposed by:** the browser client (`nimbus-web-clipper`), which shipped its
> deploy-readiness surface without it and carries a per-repository hand-binding
> in its place.
>
> **Not a blocker.** The consumer is in production today. This proposal removes
> a gesture and a drift risk; it does not unblock anything.

## 1. What this is

One read that answers "which Nimbus services are configured, and which
repositories does each one claim":

```text
GET /v1/services
```

```json
{
  "services": [
    {
      "id": "payment-service",
      "repos": ["github:acme/payments-api", "jenkins:platform/payments"]
    },
    { "id": "web", "repos": ["github:acme/web"] }
  ]
}
```

A **service** here is a `[metrics.dora.<id>]` or `[ci.service.<id>]` block in
the owner's `nimbus.toml`, carrying `repos = [...]` as provider URNs. It is the
unit `GET /v1/metrics/dora` and `GET /v1/preflight/deploy` are both scoped by —
both take `service` as a required query parameter — and it is the one input to
those routes that a browser has no way to obtain.

## 2. The concrete gap

The gateway holds the repo → service map internally and builds it on demand:

- `buildServiceIdentityResolver` (`packages/gateway/src/metrics/service-identity.ts`)
  resolves an indexed item to its service id, matching `metadata.repo` /
  `metadata.project` / `metadata.jobName` against each `ServiceConfig`'s parsed
  repo URNs.
- `resolveKnownServices` (`packages/gateway/src/ipc/http-server.ts`) already
  assembles the plain id list —
  `Array.from(loadNimbusServiceConfigsFromConfigDir(cfgDir).keys())`.

Neither reaches HTTP. `resolveKnownServices` is passed into
`resolveWriteRouteDeps` and consumed at exactly one call site,
`checkServiceAllowlist` in `http-write-routes.ts`, which uses it to refuse an
unknown `service` on `POST /v1/deployments` — and returns
`known_services: known.slice(0, 25)` in that 400 body. So the list is already
**enumerable over HTTP**, but only to a holder of the deployment token, and only
by deliberately failing a write.

A browser sitting on `github.com/acme/payments-api` knows the repository. It
cannot learn that the repository is `payment-service`, so it cannot call either
of the two routes that would tell the reader anything.

## 3. What the client does today, and will keep doing

The consumer ships a **locally-stored binding**. The user types a service id
once per repository; the client stores `{ product, scope, serviceId }` keyed by
`product:scope`, and validates the typed id by asking
`GET /v1/preflight/deploy` — an id no config claims comes back as a normal
envelope with `gap: "unknown_service"` on all three checks
(`unconfiguredEnvelope`, `packages/gateway/src/ipc/preflight-rpc.ts`), so the
client refuses to save it. That path needed no new route and no new scope, and
it works.

Two things are wrong with it, and neither is fatal:

- **It is a gesture per repository.** A reader who works across fifteen repos
  binds fifteen times, and a colleague who installs the extension binds them
  all again.
- **It can drift.** The binding is a copy of a fact the gateway owns. Rename a
  service in `nimbus.toml` and every browser that bound the old id keeps sending
  it; the reader sees `unknown_service` and has to work out that the config
  moved under them.

With this route, repo → service resolves with no gesture, and the local binding
survives as an **override** — still needed for a repository the config does not
claim, and for Jenkins, where the client's own scope key is a job path rather
than anything URN-shaped. So the fallback is not wasted work either way.

## 4. What this discloses, honestly

This is the part worth arguing, because the answer is not "nothing".

**Service ids are already reachable, unauthenticated, one at a time.** Both
`GET /v1/metrics/dora` and `GET /v1/preflight/deploy` are `{ kind: "public" }`
in `HTTP_ROUTE_AUTH`, and both answer an unconfigured service *softly* rather
than refusing — a fixed envelope whose gap is `unknown_service`. Any local
process can therefore already confirm whether a guessed service id exists, and
`known_services` in the deployment-write 400 already enumerates them for one
credential.

**Repository names are also already public**, via a wider route than this one.
`GET /v1/items` is `{ kind: "public" }` and its projection includes `metadata`
— thirteen columns, `body_preview` rather than `body` (`buildItemListSql`,
`packages/gateway/src/index/item-list-query.ts`) — so `metadata.repo` for every
indexed forge item is readable by any local process today.

**What is genuinely new is the grouping.** Neither of the above exposes *which
repositories the owner filed under which service name*. That map is a curated
statement about how the owner's estate is organised — closer to configuration
than to index content — and it is the thing a reviewer should weigh.

**And the difference between an oracle and an enumeration is not a footnote.**
The probe that exists today costs one request per *guessed* id, against an id
space the caller has to invent. This route costs one request for the whole list.
That distinction is presumably why `checkServiceAllowlist` caps its own
disclosure at `known_services: known.slice(0, 25)` rather than returning the
list whole — in a body that already requires the deployment token. A reviewer
inclined to object will object here, so it is stated as its own point rather
than as a trailing clause.

**There is a fourth channel, and it is the error path.** A malformed
`nimbus.toml` throws out of `loadNimbusServiceConfigsFromConfigDir`, and those
messages embed the service id *and* the offending value — verbatim from
`packages/gateway/src/config/service-config-toml.ts`:

```text
[metrics.dora.payments].deploy_environments entry 'staging-eu' is invalid: must match /^[a-z0-9][a-z0-9._-]*$/
```

Under a public mount that string is readable by any local process. So the
disclosure question is not only about the success body, and this route must
decide deliberately what it says when the config does not parse — see §7's
error table, which raises it rather than answering it.

## 5. An alternative shape worth weighing first

Placed before the mount question, because it may dissolve it.

A narrower route answers the client's actual question without enumerating
anything:

```text
GET /v1/services/resolve?repo=github:acme/payments-api
→ { "service": "payment-service" }   // or { "service": null }
```

*This is the sketch as proposed. What shipped carries a third key as well —
`{ service, ambiguous, candidates }`, per §5.1's second consequence, which was
answered in favour of disclosing the contest.*

This is strictly less disclosure — one answer about one repository the caller
already named — and it has a second advantage that is independent of the
disclosure debate and is the stronger of the two: **the matching rules stay on
the gateway side.**

There is no single matcher for a client to copy. There are **two**, and they
already disagree about one provider:

- `repoLikeMatchesUrn` (`packages/gateway/src/metrics/dora.ts`) takes an
  `externalId` alongside the metadata, and its `circleci` arm is
  `externalId.includes(urn.providerId)`.
- `repoMetadataMatchesUrn` (`packages/gateway/src/metrics/service-identity.ts`)
  has no external id in its item shape, so its `circleci` arm returns `false` —
  it never matches. Its own comment says so: it "Mirrors `repoLikeMatchesUrn` in
  `metrics/dora.ts`, minus its `circleci` external-id branch".

Both also treat GitLab specially (`metadata.project` *or* `metadata.repo`). A
client doing string equality against a URN list would be a **third** matcher,
written by someone who can see neither of the first two. A resolve form cannot
drift from the gateway's own matching, because it *is* the gateway's own
matching.

What it loses: a service picker. The consumer's DORA page wants to offer the
reader a list of services to look at, not only to identify the one repository
in front of them.

Both shapes are compatible — the resolve form could land first and the list form
later, or the list form could carry enough for the client to do its own
matching. Named here so the reviewer sees that "list every service" is a choice
and not the only way to close the gap, and placed first because a mount decision
for the list form is wasted attention if the resolve form is the one that lands.

### 5.1 One repo can be claimed by several services, and the gateway already decided what happens

Raised in PR review: the resolve form returns a single `service`, and the client
feeds that id straight into `preflight/deploy` — so "which service" is not a
cosmetic question, and this document did not answer it.

**Nothing rejects an overlapping claim at config load.** Two `[metrics.dora.<id>]`
blocks may both list `github:acme/payments-api`, and no validation refuses it.
So the ambiguity is reachable, not theoretical.

**But the behaviour is not undefined — it is already decided, implemented and
shipped**, at `packages/gateway/src/metrics/service-identity.ts:36-44`:

> M-2: reported when two `ServiceConfig`s both claim the same binding key — the
> resolver still picks deterministically (first by config-map iteration order,
> same as before), this only makes the ambiguity observable.

`indexAmbiguousBindings` precomputes, from the configs alone, every binding key
claimed by more than one service. For such a key it takes `claimants[0]` —
**first claimant wins** — and records an `AmbiguousBindingWarning` carrying both
`chosenServiceId` and the full `candidateServiceIds`. `reportAmbiguityIfBound`
then emits it at most once, and only for a resolution that actually bound,
precisely so a warning never asserts a `chosenServiceId` for a resolve that
returned nothing.

That has two consequences for this proposal, and the second is the open one:

1. **This route must not invent a precedence rule.** A route that picked, say,
   the alphabetically-first service would disagree with the binding the rest of
   the DORA pipeline already made for the same repo, and the client would gate a
   deploy against one service while the metrics behind it belong to another. The
   resolve form's whole argument in §5 is that the matching rules stay on the
   gateway side; a second precedence rule here would be the third matcher that
   argument exists to prevent. Reuse the gateway's own binding rather than
   inventing a second one.

   **Which entry point that is, this proposal deliberately leaves to Q1 — but
   it is not a free choice, because neither existing matcher takes the shape a
   resolve route is handed.** `buildServiceIdentityResolver` resolves a
   `ServiceIdentityItem` — `{ service, type, metadata }`, an *indexed item* —
   whereas `GET /v1/services/resolve?repo=…` is handed a bare URN and has no
   item to match. Answering it means either synthesising a metadata record to
   feed the item-shaped matcher, or adding a URN-to-URN entry point beside it,
   and both have consequences worth naming before either is picked:

   - **Synthesising** inherits `repoMetadataMatchesUrn`'s
     `case "circleci": return false`, so `repo=circleci:…` answers `null` for a
     service that `repoLikeMatchesUrn` *would* have matched on its
     `externalId`. It also forces a choice of `type`, which is load-bearing:
     the resolver returns `bound` outright for a non-`deployment` item but runs
     the `deployEnvironments` gate for a `deployment` one, so the synthesised
     type decides the answer. Its three-way `bound` / `excluded` / `unknown`
     result has no natural projection onto `service | null` either — `excluded`
     means a config *did* claim the repo, which is not `null` in any useful
     sense.
   - **A URN-to-URN entry point** sidesteps all of that, and is the third
     matcher §5 warns about unless it becomes the one the other two are
     refactored onto.

   So the CircleCI answer is a decision, not a default, and the resolve form's
   viability partly rests on it.

   > **ANSWERED 2026-09-11: the URN-to-URN entry point
   > (`resolveServicesByRepoUrn`), and the second bullet above is WRONG about
   > it.** It is not a third matcher and needed no refactor of the other two.
   > The three do not answer the same question: `repoMetadataMatchesUrn` and
   > `repoLikeMatchesUrn` ask *does this **indexed item** belong to this
   > service*, matching heterogeneous item metadata — `repo` / `project` /
   > `jobName` / an external id — against a config URN, which is why they need
   > provider-specific arms at all. The new one asks *does this **config URN**
   > name this service*, where both sides are config vocabulary produced by the
   > same `parseDoraRepoUrn`, so the comparison is exact and no provider rule
   > enters. That is also the real reason `circleci` resolves here while the
   > item-shaped matcher returns `false` for it: that arm is `false` because an
   > indexed item carries no external id — a fact about **items**, not about
   > URNs — so there was never a gap for this route to inherit. The
   > synthesised-item alternative is rejected on all three counts in the first
   > bullet, which stand.

2. **Whether the route DISCLOSES the ambiguity is still open, and is a real
   choice.** Returning a bare `{ "service": "payment-service" }` is honest about
   the binding and silent about its being contested — the caller cannot tell a
   sole claim from a coin-toss among three, and it is about to gate a deployment
   on the answer. Adding the candidates the warning already carries costs one
   field:

   ```text
   GET /v1/services/resolve?repo=github:acme/payments-api
   → { "service": "payment-service", "ambiguous": false }
   → { "service": "payment-service", "ambiguous": true,
       "candidates": ["payment-service", "billing-service"] }
   ```

   The gateway already computes every value in that second shape; not returning
   them is a decision to withhold, not an absence of data.

   **Recommended: return them — and this is a consumer need rather than a
   preference.** The whole design of the client feature behind this proposal is
   that it must never silently answer about the wrong service. Its deploy
   verdict is a claim about *this* repository; answering it from a service the
   user never chose, with nothing on the wire to say a second service also
   claimed the repo, is exactly the defect that cost a fix round during the
   client's own implementation. Being handed one arbitrary id with no ambiguity
   signal would reintroduce it at the contract level, where the client cannot
   detect it at all.

   Worth saying plainly, because it bounds the ask: **the client's fallback does
   not have this problem.** Its local binding is per repository and the user
   typed the service id explicitly, so there is no ambiguity to disclose. The
   candidates matter precisely when the gateway resolves *for* the client —
   which is the case this route exists to create. The gateway may reasonably
   decide a warning on stderr is disclosure enough; the consumer's position is
   only that a browser never sees stderr.

**For the list form**, the same question appears as: does a repo URN appear under
every service that claims it, or only under the winner? It should appear under
each — the list form's purpose is for the client to see the configuration, and a
list that silently drops the losing claimant hides exactly the misconfiguration a
reader would want to find.

**Whichever shape lands needs a test for the contract chosen**, including the
multi-claimant case. There is no such test today because there is no such route;
this paragraph exists so that "no test" is a known cost rather than an oversight.

## 6. Where it mounts, and under what scope — the gateway's call

**This document does not decide this.** It states the two coherent options and
the constraint that rules out a third, and leaves the choice to the repo that
owns the contract.

### The constraint

`dispatchReadOnlyDataGet`'s table is **public by construction** — its own
comment says "no bearer gate, never fall through" — and the three `resolve`
reads plus the four egress reads are mounted inline in `tryBearerAuthedGet`
*precisely because* routing scoped output through that table would serve it to
any local process on the machine. `handleItemsResolveFile` states it directly:

> the "/v1/items/\*" entry in dispatchReadOnlyDataGet's table is PUBLIC, so
> routing this through it would serve the reader's indexed-file set to any local
> process on the machine.

So the mount point is not a detail that follows the decision — it **is** the
decision. There is no "mount it in the read-only table but scope it" option.

### Option A — public, in `dispatchReadOnlyDataGet`

Beside `/v1/connectors` and the two routes it exists to feed. Consistent with
them: a client that can already call `preflight/deploy` unauthenticated would
otherwise need a token to learn what to pass it, which is an odd seam.

Costs: an `HTTP_ROUTE_AUTH` entry — `"GET /v1/services": { kind: "public" }` —
because that table is **total over the surface** by its own header and a route
with no entry fails the completeness test rather than inheriting whatever the
surrounding code does; plus `HTTP_ROUTES` and a `paths:` entry in
`packages/gateway/openapi/v1.yaml`, which `audit:openapi-drift` enforces as a
pair. Both options cost an auth entry; only its *value* differs.

And one cost that is easy to miss because it is not a code change: **Option A
bundles "public" with "documented forever".** `HTTP_ROUTES` is the OpenAPI
source of truth, so the public mount publishes this route in
`openapi/v1.yaml` — a schema other tools generate clients from. Un-publishing it
later is a different kind of change from deleting a handler. The scoped reads
stay off that list precisely because they are not part of the published surface.

Plus the grouping from §4, and §4's error-path channel, become readable by any
local process.

### Option B — bearer-authed, inline in `tryBearerAuthedGet`

A `ROUTE_KEY_SERVICES_LIST` constant, an `HTTP_ROUTE_AUTH` entry, a member on
the `ClipReadRouteKey` union, and the same `404 { "error": "..._disabled" }`
before the auth check that every other inline read uses as its capability
signal. Stays off `HTTP_ROUTES` like every other clip-scoped read.

**Name the gate, because the inline reads do not.** What that 404 actually
tests is `opts.clipsVault === undefined` — the *clips surface*, not this route.
So a gateway new enough to have the route but with no paired-client surface
mounted answers `404 services_disabled`, and a client reads it as "this gateway
is older than the route". Every existing inline read carries that ambiguity and
none of them says so out loud. The consequence is benign here — both readings
lead the client to the same fallback — but it should be written in the route's
comment rather than rediscovered.

Then: which scope?

- **Reuse `resolve`.** It reads, it runs nothing, it appends no egress row —
  the same three sentences `resolve-file` and `resolve-ids` are mounted on. It
  is also a *resolution*: repo coordinate in, identity out. No re-pairing for
  any token that already holds `resolve`.
- **A new `services` scope.** Cleanest separation, and a token in the wild gains
  nothing. Costs an `API_SCOPES` entry, deliberate absence from `LEGACY_SCOPES`,
  and an owner gesture — `nimbus clip scopes <label> --set <scopes>`, in place,
  no re-pairing.

The consumer has no preference and will read whichever it is given. It does ask
that the choice be **stated in the route's own comment**, because the next
proposal will copy it.

## 7. Proposed contract, if the list form is chosen

### Request

`GET /v1/services`. No parameters.

### Response

```json
{
  "services": [
    { "id": "payment-service", "repos": ["github:acme/payments-api"] }
  ]
}
```

Field by field, never a spread of `ServiceConfig`. That type also carries
`pagerdutyServices`, `deployWorkflowPattern`, `incidentWindowMinutes`,
`excludePrLabels`, `deployEnvironments` and `severityP1Aliases` — **none of
which any consumer needs**, and two of which (the PagerDuty service ids and the
deploy-environment names) are materially more sensitive than the repo list.

A spread would also *look* clean while leaking: `deployWorkflowPattern` is a
`RegExp`, which `JSON.stringify` renders as `{}`, so a test fixture eyeballed by
a human would show a harmless empty object sitting beside the two fields that
actually matter. That is exactly the failure a key-pinning test exists to catch.

A test should therefore pin `Object.keys()` on a service entry to exactly
`["id", "repos"]`. Note this pins the **wire** key set, not `ServiceConfig`'s:
`id` is a rename of `serviceId`, so the two are deliberately not the same
vocabulary and nobody should read the assertion as a claim about the internal
type. `resolve-ids` and `resolve-file` both set this precedent and both have
such a test.

`repos` is each `ParsedDoraRepoUrn` rendered back to its wire form,
`` `${provider}:${providerId}` `` — the same rendering
`indexAmbiguousBindings` already uses internally for its binding keys, and the
same string the owner wrote in `nimbus.toml`.

**A service with no repos is present with `"repos": []`.** It is a configured
service; `no_repos` is a real and separately-reported state in `DoraGap`, and
collapsing it into absence would make a mis-configured service look like a
missing one.

**Order is `ORDER BY id`-equivalent** (sort the ids). The underlying `Map` has
`[metrics.dora.*]` insertion order followed by `[ci.service.*]`, which is
incidental; a stable order makes a response reproducible in tests across
platforms.

### Errors

| condition | status | body |
| --- | --- | --- |
| no config dir wired | 200 | `{ "services": [] }` |
| `nimbus.toml` absent | 200 | `{ "services": [] }` |
| **`nimbus.toml` malformed** | **the gateway's call — see below** | |
| (Option B only) surface unmounted | 404 | `{ "error": "services_disabled" }` |
| (Option B only) token lacks the scope | 403 | the standard scope-gap body |

The empty-list cases are deliberately **200, not 404**: `resolveKnownServices`
already returns `[]` for an unwired config dir, and
`loadNimbusServiceConfigsFromConfigDir` returns an empty `Map` when
`nimbus.toml` does not exist. "No services are configured" is an answer, and the
client renders it as one — a prompt to configure a service, not an error. Under
Option B the 404 keeps its distinct meaning: *this gateway is older than the
route*, which is the capability signal.

#### The malformed-config row is a real decision, not an omission

`loadNimbusServiceConfigsFromConfigDir` **throws** on a config that does not
parse. `materializeOneServiceConfig` and its helpers
(`packages/gateway/src/config/service-config-toml.ts`) throw on a missing
`repos`, an `incident_window_minutes` outside 1..1440, an invalid
`deploy_environments` entry, an unparseable `deploy_workflow_pattern`, an
unknown key, or an empty table id.

The existing callers know this and disagree about what to do:

- `packages/gateway/src/ipc/agents-rpc.ts` degrades rather than throwing.
- `packages/gateway/src/platform/assemble.ts` try/catches at startup for
  precisely this reason.
- `handleMetricsDora` does **not** wrap it — it catches only `MetricsRpcError` —
  so a malformed `nimbus.toml` already turns `GET /v1/metrics/dora` into a 500
  today. Pre-existing, and not this proposal's to fix; named because a new route
  must choose rather than inherit a behaviour by accident.

Two sub-questions, raised and deliberately not answered:

1. **Degrade to an empty list, or surface the parse error?** Degrading matches
   `agents-rpc.ts` and keeps the route's contract simple; surfacing it is the
   only way a reader learns their config is broken from the surface they are
   actually looking at.
2. **If it surfaces, what may the body say?** Under Option A the message is
   public, and these messages embed the service id and the offending value (§4).
   A body that names only *that* parsing failed, with the detail going to stderr
   where the owner already reads it, is the shape that keeps the disclosure
   analysis in §4 true.

### Caching and cost

`loadNimbusServiceConfigsFromConfigDir` reads and parses `nimbus.toml` on every
call; the existing callers accept that, and this route can too. Worth noting
because it is a file read on a public route under Option A — a reviewer may want
a cheap guard there that the internal callers do not need.

## 8. What this is not

- **Not a version floor.** Route presence is the capability signal, as with
  `resolve-file` and `resolve-ids`. The consumer probes, reads a 404 as "this
  gateway does not have it", and falls back to §3's local binding silently.
- **Not egress.** It reads a local file. No provider request, no ledger row —
  the same narrowing `packages/gateway/src/egress/egress-coverage.ts` already
  applies to the three `resolve` reads. Under Option B that file's
  local-index-read list should gain this route, as it did for `resolve-file`
  and `resolve-ids`.
- **Not a write.** I13 governs HTTP *write* routes via
  `WRITE_ROUTE_ALLOWLIST`; this stays off it. Named because "new HTTP route" is
  the trigger a reviewer reaches for I13 on, and it is the wrong invariant here.
- **Not a schema change.** No table, no migration — the source is `nimbus.toml`.
- **Not a config *write* surface.** The client never proposes a service. Editing
  `nimbus.toml` stays an owner gesture on the machine.

## 9. What the client does with it

For the record, so the shape is judged against a real consumer.

On a recognised pull-request or build page the extension derives a repo-level
scope from its recognition registry (`owner/repo` on the three forges, a job
path on Jenkins). With this route it reads the service list once, matches its
scope against the URN list, and calls `preflight/deploy` with the id it found —
no bind form, no gesture. Where nothing matches, the existing bind form appears
exactly as it does today, and a stored binding continues to win over the
gateway's answer, because a reader who typed an id meant it.

It is one call per session, cached; the browser's only network destination
remains the gateway on loopback.

## 10. Alternatives considered

**Let the client call `POST /v1/deployments` with a junk service and read
`known_services` out of the 400.** It is the only path that exists today.
Rejected without hesitation: it requires the deployment token, which a browser
must never hold, it is a write on the I13 surface, and it obtains data by
deliberately failing a request that records a rejection. Named only because it
demonstrates the list is already considered disclosable to *some* credential.

**Have the client infer the service from `GET /v1/items`.** The public item rows
carry `metadata.repo`, and deployment rows carry `nimbus_service_id`. A client
could in principle mine the correlation. Rejected: it reconstructs a config fact
from data by inference, it is wrong whenever a service has no recent deployment,
and it reads far more of the index than a direct answer would.

**Keep the local binding and do nothing.** The honest baseline, and the reason
this is a proposal rather than a bug report. It costs a gesture per repository
and carries a drift the user has to diagnose. If the grouping in §4 is judged
too sensitive for either mount, this is the outcome and the consumer is fine.

## 11. Open questions for the gateway

> **Answered 2026-09-11.** Q1, Q4 and Q5 are settled and shipped; Q2, Q3 and Q6
> applied only to the list form, which did not ship, so they stay open against
> it. Each answer is marked in place below rather than summarised here, so a
> reader following a cross-reference lands on the decision itself.

1. **ANSWERED: the resolve form, and only it.** List form, resolve form, or
   both? §5 — the resolve form keeps the
   provider-specific matching on the gateway side, and there is no single
   matcher for a client to copy even if it wanted to. This is the question to
   answer first, because the next two only apply to the list form.

   **If the resolve form is chosen, it carries a second decision that is not
   optional** (§5.1): which entry point answers a repository-only query, given
   that neither existing matcher takes a bare URN. Choosing to synthesise an
   item for `buildServiceIdentityResolver` settles two things by side effect
   that should be settled deliberately — whether `repo=circleci:…` answers
   `null` (it would, via `repoMetadataMatchesUrn`'s `circleci` arm, for a
   service `repoLikeMatchesUrn` would have matched), and how the resolver's
   three-way `bound` / `excluded` / `unknown` projects onto `service | null`
   (`excluded` is not `null` in any useful sense). Choosing a URN-to-URN entry
   point avoids both but is a third matcher unless the other two are refactored
   onto it. The consumer has no preference here and could not implement either;
   it is named so that the choice is made rather than fallen into.
2. **STILL OPEN, and now list-form-only** — the resolve form shipped scoped,
   inline in `tryBearerAuthedGet`, for a reason particular to it: it is the one
   argued at its `HTTP_ROUTE_AUTH` entry, that a public mount would not preserve
   the narrowing the resolve form claims, since `GET /v1/items` already makes
   repo names enumerable unauthenticated. Public (Option A) or scoped (Option B)? §6 — and note Option A publishes the
   route in `openapi/v1.yaml`, which is a longer-lived commitment than the
   handler.
3. **ANSWERED for the resolve form: reuse `resolve`.** It is a resolution —
   coordinate in, identity out — and a fourth scope naming the same capability
   would split `resolve` on no principle a caller can see. Still open for the
   list form, which is not a resolution. If scoped: reuse `resolve`, or a new `services` scope? §6. Reusing `resolve`
   widens the reach of every token that already holds it, including tokens
   paired for `resolve-file` alone; a new scope grants nothing retroactively.
4. **ANSWERED: surface it**, as `500 config_unreadable`, with a body that names
   only that parsing failed. Degrading would answer `service: null`, which the
   caller cannot distinguish from "no service claims this repo" — a confident
   wrong answer about the owner's own configuration. What does the route do when `nimbus.toml` does not parse — degrade to an
   empty list, or surface the error? §7. Under Option A the message is public
   and embeds config values.
5. **ANSWERED: the second option — resolve as the gateway already does, and
   disclose the candidates.** Config validation was not tightened, so a config
   that loads today still loads. Repository-to-service cardinality — what should one repo claimed by two
   services do? §5.1. Three answers, and the third is the gateway's to prefer
   if it wants it:
   - **Resolve as the gateway already does** (first claimant wins,
     `packages/gateway/src/metrics/service-identity.ts:36-44`) and stay silent
     about the contest.
   - **Resolve the same way and disclose the candidates.** The consumer's
     recommendation, for the reason §5.1 gives.
   - **Reject duplicate claims at config-validation time**, as the PR review
     offered as its first option. This is a legitimate answer and it is not the
     consumer's call: it makes the ambiguity unrepresentable rather than
     disclosed, at the cost of turning a config that loads today into one that
     does not. If it is chosen, the route needs no ambiguity field at all and
     `indexAmbiguousBindings` becomes dead code — which is a reason to prefer
     it, not an objection to it.

   Whichever is chosen needs a test for the multi-claimant case; there is none
   today because there is no route.
6. **STILL OPEN — list-form-only.** The resolve form returns service ids, which
   carry no provenance either way. Should `[ci.service.<id>]` and `[metrics.dora.<id>]` services be
   distinguishable in the response? They are merged into one `Map` today, with a
   stderr warning on collision, and the consumer does not care — but a future
   one might.
