# Actionable failures in targeted fetch and connector auth

**Date:** 2026-08-10
**Branch:** `dev/asaf/fetch-miss-reason`
**Status:** design approved, awaiting implementation plan

## Problem

Two surfaces answer a question with a fact the caller cannot act on, when an
actionable fact was available and discarded.

Both were found while verifying the `nimbus-web-clipper` browser client against
a live gateway on v1.26.0. They compounded: a GitHub PAT expired, `connector
auth` reported success, and targeted fetch reported `not_found`. Neither surface
named the credential, so the two failures presented identically. Diagnosis took
three fetch attempts and a log dive.

### Issue 1 — `not_found` conflates six causes

`fetchOnePullRequest` (`packages/gateway/src/connectors/github-sync.ts`) returns
a bare `{status:"not_found"}` for every miss: no PAT stored (:626), a DNS/TLS
failure (:644), any non-2xx — 401, 403, 404 alike (:647), unparseable JSON
(:653), a non-object body (:657), and a response missing its identity field
(:664).

The same shape repeats in four sibling connectors: `bitbucket-sync.ts`
(:302–:340), `gitlab-sync.ts` (:96–:134), `jenkins-sync.ts` (:436–:483),
`jira-sync.ts` (:556–:616).

The expired PAT therefore reached the browser panel as "Nimbus can't fetch this
page" — terminal, no action offered — when the actionable answer was
"re-authenticate GitHub".

`FetchOneResult`'s own doc comment (`sync/types.ts:84-86`) already states the
principle the type violates: *"Distinct arms because collapsing them is how a
panel ends up telling a user to check credentials that are fine."*

This is the class of defect fixed in `nimbus-web-clipper` #38 (403 reported as
`server_error`): an error the user could act on, reported as one they can't.

### Issue 2 — `connector auth` reports success without validating

`nimbus connector auth github` prints `Signed in: github`
(`packages/cli/src/commands/connector.ts:915`) unconditionally after
`connector.auth` returns. The gateway handler
(`ipc/connector-rpc-handlers/auth.ts`) writes the credential to the Vault and
returns `authSuccess()` — 19 PAT-style connectors, none validated.

Observed with a credential that did not authenticate: `connector status github`
reported `healthState: "unauthenticated"`, `github_actions` sync returned 401
every 60s, and `itemCount` stayed at 84. After storing a valid PAT: `healthy`,
84 → 99.

A setup command that says "signed in" when you are not is how a user concludes
the product is broken.

## Constraints

- `POST /v1/items/fetch` is on the I13 write allowlist. Route auth keys on the
  route string (`ipc/http-route-auth.ts:96`), not the response shape, and I29
  constrains only that an egress row is appended before dispatch. Neither is
  affected by adding a response field — to be re-verified during implementation,
  not assumed.
- `deriveFetchHostMap` stays the only source of "is this host fetchable". A miss
  stays `not_configured`, never a guess.
- No new value may carry provider text, a URL, or a credential. Every added
  value is a fixed enum derived from a status code. The deliberate catch-
  swallowing at `github-sync.ts:641-644` stays.
- Downstream consumer `nimbus-web-clipper` parses `status` against a closed set
  and maps anything unknown to `server_error`. **No new `status` arm may reach
  the wire** — a new arm would render every affected fetch as "Nimbus had an
  error", strictly worse than today.

## Existing state (verified 2026-08-10)

No credential-validation mechanism exists anywhere in the gateway.

- `healthState` is purely reactive. `nextState()` (`connectors/health.ts:49-66`)
  produces `"unauthenticated"` only from a `UnauthenticatedError` thrown during a
  real sync (`sync/scheduler.ts:740-741`).
- `connector.status` is a synchronous function over local SQLite
  (`ipc/connector-rpc-handlers/status.ts:29-46`) — structurally incapable of an
  outbound call.
- `isConnectorConfigured()` (`sync/connector-configured.ts`) checks Vault
  *presence* only, never whether a provider accepts the value.
- Only github and jira throw `UnauthenticatedError`. GitLab raises a generic
  `Error` (`_lib/gitlab/events.ts:226-228`); Jenkins logs a warning and returns a
  no-op (`jenkins-sync.ts:249-262`), so a revoked Jenkins token yields zero items
  silently and forever. Bitbucket has no reference to it.
- A never-synced connector reports `healthy` with no evidence
  (`health.ts:326-328`).

Of the five probe endpoints needed, only github's exists today
(`USER_URL`, `github-sync.ts:23`). All four others reuse header builders that
already exist.

## Design — Issue 1

### Types

`sync/types.ts`:

```ts
export type FetchMissReason =
  | "no_credential"   // vault secret missing or empty
  | "unauthorized"    // 401 / 403
  | "absent"          // 404; jenkins null-upsert
  | "unreachable"     // DNS / TLS / connect / timeout
  | "upstream_error"; // 5xx, unparseable JSON, missing identity field

export type FetchOneResult =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found"; readonly reason: FetchMissReason }
  | { readonly status: "rate_limited" }
  | { readonly status: "unsupported_url" };
```

`reason` is **required**, not optional. A future `not_found` site that omits a
cause becomes a compile error rather than a silent regression to today's
behaviour. This is the only part of the change that keeps working after nobody is
looking at it.

`rate_limited` is a new arm on `FetchOneResult` — internal only. It already
exists on `TargetedFetchOutcome`, so nothing new reaches the wire.

`sync/targeted-fetch.ts`:

```ts
export type TargetedFetchOutcome =
  | { readonly status: "indexed"; readonly itemId: string }
  | { readonly status: "not_found"; readonly reason: FetchMissReason }
  | { readonly status: "unsupported_url" }
  | { readonly status: "no_targeted_fetch"; readonly service: string }
  | { readonly status: "not_configured"; readonly service?: string }
  | { readonly status: "rate_limited" };
```

`reason` is required here too. Every `not_found` on this type originates from
`fetchOneWithRetry`, so it is always present in fact; typing it optional would
invite a client fallback branch that can never be exercised. The JSON wire is
identical either way — old clients ignore unknown fields regardless.

`not_configured` gains optional `service`, populated **only** at the
`syncableFor(service) === undefined` site (`targeted-fetch.ts:228`), where the
boundary already resolved a service. The host-miss site (:212) stays bare: there
is genuinely nothing to name, and naming something would be the guess the host
boundary exists to refuse. This resolves the asymmetry with `no_targeted_fetch`,
which already carries `service`.

### Shared status mapper

New `connectors/fetch-miss-reason.ts`:

```ts
export function fetchOneMissForResponse(httpStatus: number): FetchOneResult;
// 401, 403 -> { status: "not_found", reason: "unauthorized" }
// 404       -> { status: "not_found", reason: "absent" }
// 429       -> { status: "rate_limited" }
// otherwise -> { status: "not_found", reason: "upstream_error" }
```

One mapper, five callers — the five connectors cannot drift apart. Input is a
status code and nothing else, so no provider text can leak through it.

### Per-connector wiring

For each of github, gitlab, bitbucket, jenkins, jira:

| Site | Result |
| --- | --- |
| vault secret missing/empty | `not_found` / `no_credential` |
| `catch` around the outbound call | `not_found` / `unreachable` |
| `!res.ok` | `fetchOneMissForResponse(res.status)` |
| unparseable JSON | `not_found` / `upstream_error` |
| body not an object | `not_found` / `upstream_error` |
| missing identity field | `not_found` / `upstream_error` |
| jenkins `upserted === null` | `not_found` / `absent` |

`jenkins-sync.ts:456` currently fuses `!bRes.ok` with the JSON-shape check in one
condition; it splits into a status-mapped arm and an `upstream_error` arm.
`jenkinsGetJson` already returns `status` (`jenkins-sync.ts:91`), so no fetch
plumbing changes.

### Consequence to document

Routing a provider 429 to `rate_limited` gives that arm two provenances:

- the local token bucket timing out (`targeted-fetch.ts:249`) — **no** egress row
  appended, because `fetchOne` deterministically never runs;
- a provider 429 — egress row **already** appended, because the request did leave
  the machine.

Both are correct for I29: the ledger records real egress in both cases. But
`targeted-fetch.ts`'s doc comment at :176-182 currently implies `rate_limited` ⇒
no egress row. That comment must be updated in the same commit, or the next
reader inherits a false invariant. No behavioural change to the ledger itself.

### Known bound

GitHub returns 403 for secondary rate limits as well as for authorization
failures, so `unauthorized` will occasionally mean "throttled". Disambiguating
requires inspecting `x-ratelimit-remaining`. Left unsolved and documented at the
mapper rather than half-solved.

## Design — Issue 2

### Ordering: probe before write

The probe runs against the credentials **in the request**, never against the
Vault, and strictly before the first `writeConnectorSecret`.

This ordering is what makes "nothing was stored" true, and it closes a trap the
obvious implementation would open: a user re-running `connector auth github` with
a typo'd token must not clobber a working stored credential on the way to
discovering the new one is bad. Probing in-hand credentials first makes that
structurally impossible. The same protects `connectorAuthGitlab`'s
`deleteConnectorSecret(api_base)` (`auth.ts:135`).

### New module

`connectors/credential-probe.ts`:

```ts
export type ProbeVerdict =
  | { kind: "valid" }
  | { kind: "rejected"; httpStatus: number }
  | { kind: "unreachable" };

export const CREDENTIAL_PROBES:
  Partial<Record<ConnectorServiceId, CredentialProbe>>;
```

| Service | Endpoint | Header builder (existing) |
| --- | --- | --- |
| github | `https://api.github.com/user` (`USER_URL`) | `github-sync.ts:340` |
| gitlab | `{apiBase}/user` | `_lib/gitlab/events.ts:216` |
| bitbucket | `https://api.bitbucket.org/2.0/user` | `bitbucket-sync.ts:76` |
| jira | `{base}/rest/api/3/myself` | `atlassian-api-sync-helpers.ts:13` |
| jenkins | `{base}/api/json` | `jenkins-sync.ts:71` |

A `Partial<Record<...>>` keyed by service id: the 14 connectors without a probe
are **explicitly absent**, not silently unchecked, and adding one later is a
single entry.

#### Timeout, and no rate limiter

The probe is bounded by its own `AbortSignal.timeout(PROBE_TIMEOUT_MS)`,
mirroring `FETCH_ONE_TIMEOUT_MS`. Without it, `connector auth` can hang
indefinitely on a stalled provider — an interactive setup command must not.
A timeout is a transport failure, so it resolves to `unreachable`: stored,
reported unverified.

The probe deliberately does **not** acquire from the connector's shared rate
limiter, unlike `targetedFetch` (`targeted-fetch.ts:247`). The two are different
kinds of traffic. A targeted fetch is machine-driven and can be swept in a loop,
so it must share the scheduler's bucket to avoid starving it. A probe is one
request, issued once, because a human typed a command. Routing it through the
shared bucket would let a saturated background sync block interactive setup for
the full acquire timeout, and would consume a token the scheduler needs — paying
a real cost to solve a problem a single request cannot cause.

A 429 from the probe is not a rejection: it falls into "any other non-2xx" and
stores as unverified.

#### Clearing a stuck `unauthenticated` health state

A successful probe (`kind: "valid"`) transitions the connector's health via a new
`{ type: "reauthenticated" }` `HealthEvent` → `"healthy"`.

This is load-bearing, not a nicety. `SKIP_HEALTH_STATES`
(`sync/scheduler.ts:36-40`) contains `"unauthenticated"`, and
`healthGatePreventsDispatchSnapshot` returns an unconditional `true` for it
(`scheduler.ts:400`) — only `rate_limited` has a time-based escape. The sole exit
is `transitionHealth({type:"resumed"})`, called from exactly one place,
`SyncScheduler.resume()` (`scheduler.ts:262`), reachable only via `nimbus
connector resume` or `connector.setConfig enabled:true`. A **forced** sync
bypasses the gate (`scheduler.ts:482-487`); the **scheduled** path
(`scheduler.ts:451`) does not.

So without this, the sequence is: token expires → sync throws
`UnauthenticatedError` → state `unauthenticated` → scheduler skips the connector
permanently → user runs `nimbus connector auth github` with a valid token → probe
succeeds → CLI prints `Verified: github` → **the connector is still never
synced**. Issue 2 would have upgraded a weak false claim ("Signed in") into a
strong one ("Verified") while leaving the user exactly as broken.

It is worse than that: on `UnauthenticatedError` the gateway notifies the user
`"Run: nimbus connector auth <service>"` (`scheduler.ts:742-745`). The product's
own remediation advice names the command that, unfixed, does not remediate.

A new event rather than reusing `resumed`: `resumed` writes the history reason
`"connector resumed"` (`health.ts:222-226`), which would be false — nothing was
paused. `reauthenticated` records `"credential re-verified"`.

Only a `valid` verdict clears the state. `unverified` (403, 5xx, unreachable, or
no probe registered) leaves health untouched — there is no evidence to act on,
and inventing some is the defect this whole change exists to remove. The probe
registry is therefore exactly the set of services where the state can be cleared,
which is the correct coupling.

### Verdict policy

- **401 → rejected.** Nothing is written. The RPC fails; the CLI exits non-zero.
- **403 → stored, reported unverified.** A 403 means the provider *knows who you
  are* and declined that endpoint — the credential authenticated. A GitHub
  fine-grained PAT scoped to repositories but not account metadata can 403 on
  `/user` while working perfectly for everything Nimbus needs. Rejecting it would
  be a fresh instance of the bug being fixed, pointed the other way.
- **Any other non-2xx, or a transport failure → stored, reported unverified,
  exit 0.** Unreachable is not the same fact as "cannot authenticate". Refusing
  to store would make Nimbus unsetupable offline, behind a proxy, or through a
  transient DNS blip.

This deliberately diverges from Issue 1's mapping, where 403 → `unauthorized`.
Fetching a *specific item*, a 403 means the user cannot have it either way, so
`unauthorized` is the actionable answer. Verifying a *credential*, a 403 is proof
it authenticated. Different questions, different answers. The asymmetry is
documented at both sites so it does not read as an oversight.

**No `--no-verify` flag.** With unreachable already storing successfully, the only
thing such a flag could bypass is a genuine 401 — the precise hole being closed.

### Placement

Validation lives in the gateway's `connector.auth` handler, not the CLI. The CLI
is one client of three; validating at `connector.ts:915` would leave the hole
open for the Tauri desktop app and every other caller.

Each of the five PAT handlers gains one `await` between parsing and its first
`writeConnectorSecret`. That single call runs the probe, throws on `rejected`,
and on `valid` performs the `reauthenticated` health transition — so the ordering
guarantee (nothing written, nothing transitioned, on a rejection) lives in one
place rather than being re-derived five times. Explicit at five call sites rather
than a shared wrapper around the handlers: the guard against drift is behavioural
(a rejecting probe ⇒ zero Vault writes, asserted per service), not structural.

### Response and CLI output

`connector.auth` returns an added `verified: "verified" | "unverified" | null`
(`null` = no probe registered for this service). The CLI reports what was
actually checked:

```console
$ nimbus connector auth github            # probe returned 200
Verified: github
Credential: stored in the OS vault (no OAuth scopes).

$ nimbus connector auth github            # api.github.com unreachable
Stored: github (NOT verified — could not reach the provider)
Run `nimbus connector auth github` again when online to verify.

$ nimbus connector auth github            # provider returned 401
error: github rejected the credential (HTTP 401). Nothing was stored.
                                                          # exit 1

$ nimbus connector auth datadog           # no probe registered
Stored: datadog (not verified)
Credential: stored in the OS vault (no OAuth scopes).
```

The `Signed in:` wording is retired. It claims more than was ever checked, and
for the 14 unprobed connectors it would keep claiming it.

### Exit codes

The CLI already has a convention: **1 = user-actionable precondition**
(`agent-cli-dispatcher.ts:29`, "Gateway is not running"), **2 = operational
failure** (`agent-cli-dispatcher.ts:48`, an RPC or transport fault).

A rejected credential is a user-actionable precondition → **exit 1**. This needs
no new code: the handler throws a `ConnectorRpcError`, and the CLI's catch-all
sets `process.exitCode = 1` (`index.ts:197`).

Unreachable and unprobed both **exit 0** — the credential was stored and the
command did what it was asked to do. Reporting failure for a successful store
would be the same over-claim in the other direction.

No new exit code is introduced. Asserting this mapping is part of the test plan
so it cannot drift.

## Testing

Per `nimbus-testing`, unit layer for both, alongside the code under test.

**Issue 1** — in each of the five `*-sync.test.ts`:

- one test per cause, asserting the exact discriminator: absent credential →
  `no_credential`; a 401 and a 403 → `unauthorized`; a 404 → `absent`; a thrown
  transport error → `unreachable`; a 500, a malformed body, and a body missing
  its identity field → `upstream_error`; a 429 → `status:"rate_limited"`.
- jenkins additionally: `upserted === null` → `absent`.
- `fetch-miss-reason.test.ts` covering the mapper's boundaries directly.

In `targeted-fetch.test.ts`:

- `reason` propagates unchanged from `fetchOne` to the outcome;
- a provider 429 surfaces as `rate_limited` **with** its egress row appended,
  distinguishing it from the acquire-timeout path which appends none — this is
  the test that pins the two provenances apart;
- `not_configured` carries `service` at the not-wired site and omits it at the
  host-miss site.

The existing `toEqual({status:"not_found"})` assertions across all five connector
test files will fail once `reason` is defined. That is the correct signal, not
collateral damage: each must be updated to assert its specific cause. (Note
`toEqual` ignores `undefined` keys, so a *required* `reason` is what makes these
fail loudly rather than pass silently.)

**Issue 2** — new `credential-probe.test.ts` plus additions to the connector-rpc
auth tests:

- each verdict from each status: 200 → valid; 401 → rejected; 403 → unverified;
  500 → unverified; transport throw → unverified;
- **per service, a rejecting probe results in zero Vault writes** — the anti-drift
  guard, asserted against a recording fake vault;
- a rejected probe does not clobber a previously stored working credential;
- a rejected probe throws a `ConnectorRpcError` the CLI surfaces as exit 1;
  unreachable and unprobed both exit 0;
- a probe that never resolves is bounded by `PROBE_TIMEOUT_MS` and yields
  `unreachable` (injected clock/signal, not a real wait);
- a service with no probe entry returns `verified: null` and still stores.

Health-state clearing, the regression this set exists to prevent:

- `nextState({type:"reauthenticated"})` → `"healthy"` (unit, `health.test.ts`);
- **the end-to-end sequence**: seed health `unauthenticated`, assert the
  scheduler skips the connector, run `connector.auth` with a probe that returns
  `valid`, assert health is `healthy` and the scheduler now dispatches it. This
  test is the point — the individual pieces passing while the user stays stuck is
  the exact failure being fixed;
- a `rejected` verdict and an `unverified` verdict each leave an existing
  `unauthenticated` state **untouched**;
- a service with no probe entry never transitions health.

**Green bar:** `bun run preflight` (full CI parity), not `test:ci`. Coverage
floor is Linux-authoritative — new files under `packages/gateway/src` must clear
≥85% line / ≥80% branch, verified via the istanbul-preload lcov build rather than
assumed.

## Sequencing

Two PRs stacked on `dev/asaf/fetch-miss-reason`, Issue 2 first.

It is the smaller diff and the higher-value fix, and landing it first means Issue
1's per-connector work is done against a `connector auth` that no longer lies —
which is what made the two failures indistinguishable to begin with.

## Coordination

Issue 1 adds fields; it adds no `status` arm, so the shipped clipper keeps
working unchanged and unknown fields are ignored. The PR description must state
the added fields so `nimbus-web-clipper` can follow up to render them:
`not_found.reason`, `not_configured.service`, and the fact that a provider 429
now arrives as the already-handled `rate_limited`.

## Out of scope, recorded

- GitLab, Jenkins, and Bitbucket never throw `UnauthenticatedError`, so
  `healthState` can never reach `"unauthenticated"` for them — a revoked Jenkins
  token yields zero items silently. Real, adjacent, and a separate change: it
  touches the periodic sync path, not the targeted-fetch or auth path. Note the
  interaction with the health-clearing fix above: that fix can only clear a state
  a connector can actually reach, which today is github and jira (plus google).
  For the other three the fix is inert until this gap closes — inert, not wrong.
- A never-synced connector reporting `healthy` with no evidence
  (`health.ts:326-328`).
- **Vault write atomicity.** `writeConnectorSecret` is a thin `vault.set` per key
  (`connector-vault.ts:110-118`); there is no batch or transaction. Multi-key
  services write sequentially — jenkins does three (`base_url`, `username`,
  `api_token`), jira three, bitbucket two — so a mid-sequence failure leaves a
  partial credential set. Pre-existing and **unchanged** by this design; a fix
  means a batched/rollback API across three platform backends (DPAPI, Keychain,
  libsecret), which is Vault-layer work, not auth-handler work. Probe-before-write
  narrows the exposure rather than widening it: the most likely reason to abandon
  a write sequence — bad credentials — is now caught before the first write.

## Review items considered and deferred

From the 2026-08-10 design review (`…-design-review.md`). Recorded with reasons so
they are not silently dropped.

- **Report missing scopes from `X-OAuth-Scopes`.** Deferred. The header is
  GitHub-specific — none of gitlab, bitbucket, jira, or jenkins has an equivalent
  — and GitHub returns it **empty for fine-grained PATs**, i.e. blank in exactly
  the case that motivates the 403 rule. Acting on it would also require a
  per-connector *required-scopes* model to compare against; `defaultScopes` exists
  only on `oauthProfileForService`, covering OAuth connectors, none of which are
  in the probe set. That model would have to be invented first, and nothing yet
  needs it.
- **Route probes through a shared rate-limited HTTP client.** Rejected as posed;
  the named package (`science-skills-common`) does not exist in this repo. The
  underlying concern is answered above under *Timeout, and no rate limiter* — and
  it did surface a real omission, the missing probe timeout, which is now
  specified.
- **Update E2E mock servers to return the new reasons.** Deferred. The cited path
  `packages/gateway/test/e2e/mocks/` does not exist, and there is no `mocks`
  directory anywhere in the repo; `test/e2e/` holds scenario suites (chatops,
  share, tribal, ask). Covering each reason end-to-end would mean building a new
  mock provider server, while the unit layer already asserts every cause at the
  connector, the propagation through `targetedFetch`, and the verbatim
  serialization at the route. The one genuine end-to-end risk — auth succeeding
  while the connector stays skipped — is covered by the scheduler test above,
  which is cheaper and more targeted.
