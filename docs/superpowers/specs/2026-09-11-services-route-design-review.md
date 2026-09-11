# Design Review: `GET /v1/services` — the configured services, and the repos they claim

**Date:** 2026-09-11  
**Reviewer:** Claude Opus 5 (AI Coding Assistant)  
**Status:** Review Complete — sound as a proposal. All four corrections are applied: C3.1–C3.4, plus R4.1 (the alternative-shape section promoted ahead of the mount question — it was §6 when this review was written and is **§5** in the spec now, with the mount decision at §6), R4.2, R4.3, R4.4 and §2's bulk-vs-probe promotion. A later PR review added a fifth, **C5 — repository-to-service cardinality**, now answered in the spec at §5.1.  
**Target Spec:** [`2026-09-11-services-route-design.md`](./2026-09-11-services-route-design.md)  
**Slot:** HTTP Client Surfaces / Web Clipper (`nimbus-web-clipper` integration)  
**Related Routes:** `GET /v1/metrics/dora`, `GET /v1/preflight/deploy`, `POST /v1/deployments`, `GET /v1/items/resolve-file`, `GET /v1/items/resolve-ids`  
**Precedent:** [`2026-09-07-items-resolve-ids-design.md`](./2026-09-07-items-resolve-ids-design.md) — spec-only proposal, no implementation

---

> **This is a review note, not guidance. Where it disagrees with the design
> spec, the spec wins.**
>
> **Section numbers below are the spec's numbering AS REVIEWED**, before R4.1 was
> applied. The alternative-shape section was **§6** then and is **§5** now; the
> mount decision moved from §5 to §6. They are deliberately not renumbered: R4.1
> is the correction "move §6 ahead of §5", which becomes incoherent if rewritten
> to the numbering it produced. Read a `§` here as "in the spec as it stood on
> 2026-09-11", and follow the status line above for where a section lives now.
>
> It is committed because this repo keeps review notes beside their specs, and
> it is pruned when the feature ships — or when the proposal is declined.

## 1. Executive Summary

The spec proposes one read — the configured `[metrics.dora.<id>]` / `[ci.service.<id>]`
services and the repo URNs each claims — so a browser that knows it is looking at
`github:acme/payments-api` can call the two routes that are scoped by service id.

**Verdict: ready to open with the four corrections in §3 applied.** It argues a real gap,
it declines to decide the question it does not own (mount point and scope), it names the
cheaper alternative shape against its own ask (§6), and it states the do-nothing baseline
as an acceptable outcome (§10). The disclosure analysis in §4 is the strongest part of the
document and is, as far as this review can establish, correct.

Every code claim in the spec was checked against the branch point. The load-bearing ones
hold:

| Claim | Verified |
| --- | --- |
| `resolveKnownServices` is `Array.from(loadNimbusServiceConfigsFromConfigDir(cfgDir).keys())`, `[]` when no config dir | `packages/gateway/src/ipc/http-server.ts` |
| Passed into `resolveWriteRouteDeps` as `knownServices`; exactly one non-test consumer | `http-server.ts`, `packages/gateway/src/ipc/http-write-routes.ts` |
| `checkServiceAllowlist` returns `known_services: known.slice(0, 25)` in a 400, after `recordRejection` | `packages/gateway/src/ipc/http-write-routes.ts` |
| `buildServiceIdentityResolver` matches `metadata.repo` / `.project` / `.jobName` against parsed URNs | `packages/gateway/src/metrics/service-identity.ts` |
| `dispatchReadOnlyDataGet` is "no bearer gate, never fall through"; `/v1/connectors`, `/v1/metrics/dora`, `/v1/preflight/deploy` live in it | `packages/gateway/src/ipc/http-server.ts` |
| `handleItemsResolveFile`'s comment, quoted in §5, is verbatim | `packages/gateway/src/ipc/http-server.ts` |
| Three `resolve` reads + four `egress` reads mounted inline in `tryBearerAuthedGet`, which runs before the public dispatcher | `packages/gateway/src/ipc/http-server.ts` |
| `unconfiguredEnvelope` answers an unknown service with `gap: "unknown_service"` on all three checks | `packages/gateway/src/ipc/preflight-rpc.ts` |
| `GET /v1/items` is `{ kind: "public" }` and its projection includes `metadata` | `packages/gateway/src/ipc/http-route-auth.ts`, `packages/gateway/src/index/item-list-query.ts` |
| `ServiceConfig`'s six extra fields, named in §7, exist exactly as listed | `packages/gateway/src/metrics/dora-config.ts` |
| `LEGACY_SCOPES = ["clip", "briefs"]`; scopes changed in place by `nimbus clip scopes <label> --set <scopes>` | `packages/gateway/src/clips/api-scopes.ts` |
| `[ci.service.*]` and `[metrics.dora.*]` merge into one `Map`, stderr warning on collision, CI wins | `packages/gateway/src/config/nimbus-toml.ts` |
| `resolve-file` and `resolve-ids` both pin their wire key set in a test | `packages/gateway/test/integration/http/items-resolve-file-route.test.ts`, `packages/gateway/test/integration/http/items-resolve-ids-route.test.ts` |
| Inline reads signal absence with `404 { "error": "<surface>_disabled" }` | `packages/gateway/src/ipc/http-server.ts` |

## 2. Is the disclosure reasoning sound, and is the question properly left open?

**Sound, with one qualification the spec already half-states.**

The three-part argument in §4 checks out. Service ids are probe-confirmable without a
bearer, because both `metrics/dora` and `preflight/deploy` are public and answer an
unconfigured id *softly* rather than with a refusal. Repo names are readable without a
bearer, because `GET /v1/items` projects `metadata`. Neither discloses the grouping, and
the spec says so plainly instead of arguing that the new route discloses nothing.

The qualification: the spec calls bulk-vs-probe "a second, smaller point". It is smaller,
but it is the difference between an oracle that costs one request per guessed id and an
enumeration that costs one request total — and the same distinction is why
`known_services` is capped at 25 in a 400 body rather than returned whole. Recommend
promoting it from a trailing sentence to its own short paragraph, because a reviewer who
is going to object will object there.

**The question is properly left open.** §5 states the constraint that kills the third
option, lays out two coherent ones, declines to pick, and §11 asks. That is the right
register for a consumer proposing against a contract it does not own. §5's one request —
that whichever choice is made be stated in the route's own comment — is the correct thing
to ask for, and the only thing asked for.

## 3. Corrections Before This Opens

### C3.1 — Option A also needs an `HTTP_ROUTE_AUTH` entry (factual)

§5's Option A costs list names `HTTP_ROUTES` and a `paths:` entry in
`packages/gateway/openapi/v1.yaml`, and names `HTTP_ROUTE_AUTH` only under Option B. That
is wrong. The table's own header states it is **total over the surface**:

> TOTAL over the surface, including the routes that are deliberately unauthenticated. See
> the completeness test: a new route with no entry here fails the suite rather than
> inheriting whatever the surrounding code happens to do.

A public `/v1/services` needs `"GET /v1/services": { kind: "public" }` or the suite goes
red. Both options cost an entry; only the *value* differs. Fix the sentence — a costs list
that undercounts the option the author did not pick reads as a thumb on the scale.

### C3.2 — The error table omits the throw (material)

§7's error table covers "no config dir wired" and "`nimbus.toml` absent", both 200 with an
empty list, and that matches `loadNimbusServiceConfigsFromConfigDir`. It omits the third
case: **a malformed `nimbus.toml` throws.** `materializeOneServiceConfig`
(`packages/gateway/src/config/service-config-toml.ts`) throws on a missing `repos`, an
out-of-range `incident_window_minutes`, an invalid `deploy_environments` entry, or an empty
table id. Existing consumers know this and wrap it — `packages/gateway/src/ipc/agents-rpc.ts`
degrades rather than throws, and `packages/gateway/src/platform/assemble.ts` try/catches for
exactly this reason.

`handleMetricsDora` does **not** wrap it, so a malformed config already 500s
`GET /v1/metrics/dora` today. That is a pre-existing condition, not this proposal's fault,
but a new route must state which behaviour it chooses rather than inherit one by accident.
Two sub-questions the spec should raise, not answer:

- Degrade to an empty list (matching `agents-rpc.ts`), or surface the parse error?
- If the error surfaces, **under Option A the message is public.** The throw strings embed
  the service id and the offending value — `[metrics.dora.payments].deploy_environments
  entry 'staging-eu' is invalid` — which discloses config content to an unauthenticated
  caller through a channel the disclosure analysis in §4 never considers.

This belongs in §4 as well as §7: the honest-disclosure section currently reasons only
about the success body.

### C3.3 — §6 names the wrong matcher for the CircleCI behaviour (factual)

§6 says `repoMetadataMatchesUrn` is provider-specific and that "CircleCI matches on an
external id the resolver's item shape does not even carry". `repoMetadataMatchesUrn`
returns `false` for `circleci` — it never matches. The external-id branch lives in
`repoLikeMatchesUrn` in `packages/gateway/src/metrics/dora.ts`, and
`service-identity.ts`'s own comment says so: it "Mirrors `repoLikeMatchesUrn` in
`metrics/dora.ts`, minus its `circleci` external-id branch".

The correction **strengthens** the argument it was making. There are two matchers, they
already disagree with each other about one provider, and a client doing string equality
against a URN list would be a third. "A client cannot see the matcher" becomes "there is
no single matcher to see" — which is the best reason in the document to prefer the resolve
form of §6 over the list form.

### C3.4 — "whole item rows" overstates `GET /v1/items` (precision)

§4 says `GET /v1/items` "returns whole item rows including `metadata`". It returns a
thirteen-column projection (`buildItemListSql`): `body_preview`, not `body`. The
load-bearing claim — `metadata.repo` is readable unauthenticated — survives intact. Say
"projects `metadata`" and the sentence is both shorter and true.

## 4. Recommendations (non-blocking)

### R4.1 — Move §6 ahead of §5

The resolve form is argued on two grounds, and the second one (the matching rules stay on
the gateway side) is independent of the disclosure debate and, after C3.3, stronger than
the spec realises. A reviewer who reads §5 first spends their attention on a mount decision
for a shape §6 may talk them out of. §11's Q3 already ranks the questions in the better
order; the body should match it.

### R4.2 — Name the mount gate under Option B

Option B inherits the inline reads' capability signal, and with it their ambiguity: the
gate is the **clips vault**, so a gateway that has the route but no paired-client surface
answers `404 services_disabled`, which the client reads as "this gateway is older than the
route". Every inline read carries this and none of them says so. One sentence closes it.

### R4.3 — `deployWorkflowPattern` is a `RegExp`, which sharpens §7

§7 argues against spreading `ServiceConfig` because two of its fields are more sensitive
than the repo list. There is a second, quieter reason: `deployWorkflowPattern` is a
`RegExp`, which `JSON.stringify` renders as `{}`. A spread would therefore *look* harmless
in a test fixture while shipping `pagerdutyServices` and `deployEnvironments` beside it.
Worth one clause — it is exactly the kind of thing a key-pinning test exists to catch.

### R4.4 — `id` is a rename, not a projection

The proposed wire entry is `{ id, repos }`; the type's field is `serviceId`. The spec's
"field by field, never a spread" already forces the handler to do this correctly, but the
pinning test should be described as pinning the **wire** key set, so nobody reads
`["id", "repos"]` as a claim about `ServiceConfig`.

## 5. Security & Invariants Audit

1. **I13 (write-route allowlist).** Correctly identified as the wrong invariant, and
   correctly named anyway because "new HTTP route" is the trigger a reviewer reaches for it
   on. A GET stays off `WRITE_ROUTE_ALLOWLIST`.
2. **Egress.** No provider request, no ledger row — the same narrowing
   `packages/gateway/src/egress/egress-coverage.ts` already applies to the three `resolve`
   reads. If Option B lands, that file's local-index-read list should gain this route, as it
   did for `resolve-file` and `resolve-ids`.
3. **I6 (loopback).** Untouched. The route reads a local file and answers on `127.0.0.1`.
4. **Scope escalation.** Reusing `resolve` grants the route to every token that already
   holds it — including tokens paired for `resolve-file` alone. That is the spec's own
   framing ("no re-pairing"), and it is a cost as well as a convenience: a reviewer choosing
   `resolve` is choosing to widen three existing tokens' reach. A new `services` scope is
   absent from `LEGACY_SCOPES` by construction and grants nothing retroactively.
5. **Error-path disclosure.** See C3.2. Under Option A this is the only unexamined channel.

## 6. Read as a Proposal

A maintainer reading cold gets the problem (a browser cannot learn the one parameter both
service-scoped routes require), the shape (one read, two fields, built field by field), and
what happens on a no (§10: the client keeps its local binding, which already works).
Nothing is asked for that the client does not use: the response carries `id` and `repos`
and the consumer needs both — `repos` to match its recognised scope, `id` to pass on.
`repos: []` for a configured-but-empty service is justified by `DoraGap`'s existing
`no_repos` member rather than by consumer preference, which is the right way to justify a
wire decision in someone else's repo.

Tone is peer, not demand: the ask is bounded, the alternative that would replace it is
argued for rather than against, and the do-nothing outcome is stated as acceptable in the
first three lines and again in §10. The one place it slips is the costs list in C3.1, where
the option the author did not pick is undercounted — which is why that correction matters
more than its size suggests.

## 7. Testing Strategy, If It Is Built

- **Wire-shape pinning.** `Object.keys(body.services[0]).sort()` equals `["id", "repos"]`,
  as the resolve-ids route test does for its own projection. This is the test that keeps a
  later `ServiceConfig` field from leaking.
- **Ordering.** Sorted by `id`, asserted against a fixture whose `nimbus.toml` declares
  `[ci.service.*]` before `[metrics.dora.*]`, so insertion order and sorted order differ.
- **Empty vs absent.** A configured service with `repos = []` appears with `"repos": []`; a
  gateway with no `nimbus.toml` answers 200 with an empty list, not 404.
- **Malformed config.** Whatever C3.2 resolves, assert it — and under Option A assert the
  response body does not echo the offending config value.
- **Collision.** `[ci.service.web]` and `[metrics.dora.web]` both present: one entry, the CI
  one, matching `loadNimbusServiceConfigsFromConfigDir`'s documented precedence.
- **Auth.** Option A: reachable with no bearer, and present in `HTTP_ROUTE_AUTH` (C3.1).
  Option B: 403 for a `LEGACY_SCOPES` token, `404 services_disabled` with no clips vault.
