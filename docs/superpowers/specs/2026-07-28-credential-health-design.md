# Credential Health — design

> **Status:** design of record, 2026-07-28. Scope is the *product* capability —
> health for a user's connector credentials. The release pipeline's own
> publishing secrets are out of scope; they are served by the separate
> `store-credential-check` workflow (nimbus-web-clipper#26).

## The problem

Nothing in Nimbus notices that a credential has died until something tries to
use it and fails.

That is not hypothetical. On 2026-07-28 a public release failed at both
store-upload steps on credentials recorded as "configured" since 2026-07-19 and
never once exercised. Three independent defects, none visible to any control:

1. **Silent expiry.** An OAuth refresh token minted while the provider's consent
   screen was in *Testing* mode. The provider expires those after 7 days. It
   died on 07-26; nothing noticed until 07-28.
2. **Partial rotation.** The client secret was rotated and stored while the
   freshly minted refresh token was not. A credential set was half-updated with
   no signal whatsoever.
3. **Shape damage.** An issuer stored with one trailing whitespace character —
   valid-looking, and rejected by the provider.

Four rounds of hypothesis failed to locate the cause. What found all three, on
its first run, was instrumenting the real environment and printing what was
actually stored.

The generalisable failure is **presence treated as validity**. Every credential
control in the codebase today answers "is a secret set?" None answers "does it
work?"

### Why this is the product's own thesis

Nimbus ships a Vault across three platforms and manages credentials for 97
connectors. It is a tool whose purpose is to remove exactly this class of toil
for its users. The project falling to it is either an embarrassment or a product
insight; this design takes the second reading.

## Measured ground truth

| Fact | Value | Measured from |
| --- | --- | --- |
| Connectors declaring secrets | 97 | `connector-secrets-manifest.ts` |
| Distinct keys in that manifest | 174 | ditto (includes non-secret config: hosts, regions, usernames) |
| Opaque token / key / secret keys | 53 | ditto, matching `.api_key`/`.token`/`.secret`/`.pat`/… |
| `OAuthProvider` union members | 12 | `auth/oauth-registry.ts` |
| Distinct `*.oauth` vault keys | 22 | gateway-wide; Google and Microsoft fan out to per-service keys (`google_drive.oauth`, `outlook.oauth`, …) in `connector-vault.ts` |

The two families are counted from different files and must not be divided into
one another. The load-bearing fact is qualitative and holds regardless:

**Opaque credentials substantially outnumber refreshable ones, and only OAuth
credentials can self-heal or report their own expiry.** The design is therefore
built for the opaque majority; OAuth support is the easy case that comes free.

Existing substrate this design reuses rather than reinvents:

- **`sync_state`** (`connector_id`, `last_sync_at`, …) — precedent for
  per-connector state.
- **Mandatory `list`/`get`/`search`** — asserted by the connector contract test,
  which turns an active probe into *one* generic implementation, not 97.
- **`_lib/fetch-outcome.ts`** — `FetchOutcome` already carries
  `{ kind: "http_error"; status: number }`, the signal the classifier needs.
- **`StoredOAuthTokens.expiresAt`** — expiry already stored for the 12 OAuth
  providers; this design only surfaces it.
- **`nimbus doctor` / `nimbus security scan`** — the established read-only,
  HITL-free diagnostic family this belongs to.
- **`redactAuditPayload`** — the hardened redaction path the egress ledger uses.

## Non-goals

- **Unattended rotation.** `vault.set` and `vault.delete` are in the HITL frozen
  set (`engine/executor.ts:107-108`, invariant I2/I4). Any agent-initiated
  credential write requires the owner's consent and cannot be configured away.
  This design honours that: **it never writes a credential.** The only operation
  touching a secret is the existing `nimbus connector auth` flow, which passes
  through the gate exactly as it does today.
- **A migration of connectors to OAuth.** Researched and rejected as a program;
  see the appendix.
- **A background scheduler or daemon.** Sync is the heartbeat.
- **Push notifications.** Deliberately deferred; adding IPC notification surface
  later is additive.

## Architecture

One record, three writers, two readers, one pre-existing fix path.

```text
WRITERS                              RECORD                 READERS
1. sync observer (free)   ─┐
2. declared expiry        ─┼──►  credential_health  ──┬──►  nimbus creds
3. active probe           ─┘        (V45)             └──►  nimbus doctor

FIX PATH (existing, unchanged — only made discoverable)
nimbus creds fix <connector>
   └─► nimbus connector auth  ─► vault.set ─► HITL gate (I2)
```

### Data model — `credential_health` (V45)

```sql
CREATE TABLE credential_health (
  vault_key       TEXT PRIMARY KEY,   -- "zoom.oauth" — a NAME, never a value
  connector_id    TEXT NOT NULL,
  observed_status TEXT NOT NULL CHECK (observed_status IN ('ok','dead','unknown')),
  observed_via    TEXT NOT NULL CHECK (observed_via IN ('sync','probe')),
  last_checked_at INTEGER,   -- last CONCLUSIVE observation (ok / dead / indeterminate)
  last_attempt_at INTEGER,   -- last attempt of any kind, including transient
  last_ok_at      INTEGER,
  detail          TEXT,               -- redacted, capped at 256 bytes
  expires_at      INTEGER,
  expiry_source   TEXT CHECK (expiry_source IN ('provider','declared'))
);
```

Decisions:

- **Keyed by vault key, not connector.** ProtonMail alone holds nine
  credentials. Rolling them up would hide the half-updated case that caused
  defect 2 above.
- **`expiring` is never stored.** Only `ok`/`dead`/`unknown` are observed facts;
  "expires in 6 days" is a function of `expires_at` and *now*. Storing it would
  go stale the moment nothing runs — the exact failure this design exists to
  prevent.
- **Rows exist only for configured connectors** — ~10–30 on a real machine.

### Writer 1 — sync observer

Every sync already authenticates, so health is a free by-product.

| Sync outcome | Written |
| --- | --- |
| Success | `ok`, `last_ok_at = now`; if OAuth also `expires_at` from `StoredOAuthTokens.expiresAt`, `expiry_source='provider'` |
| Auth failure (401/403, `invalid_grant`) | `dead` + redacted `detail` |
| Transient (network, 429, 5xx) | **status untouched**; only `last_attempt_at` moves — **`last_checked_at` must NOT advance** |

The third row is the load-bearing behaviour, and it has **two** halves that are
easy to get half-right:

1. **A network blip must never mark a credential dead.** False positives in this
   direction train users to ignore the feature.
2. **A network blip must never make a stale credential look freshly verified.**
   This is why `last_checked_at` and `last_attempt_at` are separate columns.
   `last_checked_at` means *"when did we last actually learn something"*; a
   transient teaches nothing, so it may not advance it.

Collapsing those into one timestamp produces a false green: a credential that is
unreachable for weeks — every attempt transient — would keep reporting a fresh
`OK`, because the clock advanced while the status never changed. The staleness
degradation in the reader is the safeguard, and a shared timestamp silently
disarms it. Caught in review; it is the third instance of this failure class in
this document's history, which is itself the argument for the design.

#### Which key does a failure belong to?

A connector may hold many credentials — ProtonMail holds nine — and a bare 401
does not say which one was rejected. Two rules:

1. **Attribute precisely where the failure identifies the credential.** An OAuth
   refresh rejection is attributable to that connector's `*.oauth` key; only
   that row changes.
2. **Otherwise mark the credential *set*.** Every *secret* key the connector
   declares (excluding non-secret config — hosts, regions, usernames) takes the
   status and shares one `detail`.

Rule 2 is deliberately blunt. A 401 proves the set failed to authenticate; it
does not prove which member is at fault. Marking the set is honest and
actionable — the fix is the same either way — whereas guessing a single key
would manufacture a precise-looking claim the evidence does not support. The
alternative failure is worse: attributing to the wrong key leaves the real
culprit reading `ok`.

`detail` therefore carries the connector-level error, and the reader groups by
connector so a nine-key connector renders one line, not nine.

### Writer 2 — declared expiry

`nimbus creds expires <vault_key> <ISO-date>` sets `expires_at` and
`expiry_source='declared'`. Pure metadata; touches no secret; idempotent.

This is the *only* mechanism that makes a known deadline on an opaque token
visible — the class of credential that today is guarded by nothing but human
memory.

**Captured at the moment the user knows it.** Relying on someone remembering to
run a second command later reproduces the failure this design criticises, so
`nimbus connector auth` prompts once after storing an opaque credential:

```text
Does this credential expire? [YYYY-MM-DD, Enter to skip]:
```

Constraints: the prompt is skippable, never blocks the auth flow, and is
suppressed entirely when stdin is not a TTY or `--json` is passed — the flow is
scripted in CI and must stay non-interactive there. Skipping leaves
`expires_at` NULL, which reads as `UNKNOWN`, not as `ok`.

### Writer 3 — active probe

`nimbus creds check [connector]` calls each configured connector's mandatory
`<name>_list` at `limit=1`, through the same classifier.

Constraints: explicitly invoked only (never implicit), capped concurrency, and
routed **through** each connector's existing rate limiter rather than around it.
A connector whose MCP server fails to spawn yields `unknown`, not `dead` — "I
could not ask" is not "the answer was no".

**Every probe carries a hard timeout, default 10 s, configurable.** Many
connectors point at self-hosted instances — Jira, GitLab, Jenkins, ArgoCD,
Grafana — where an unreachable or wedged host does not refuse the connection, it
simply never answers. Without a deadline, one such host occupies a concurrency
slot indefinitely and `nimbus creds check` hangs. A timeout classifies as
`transient` (hence `unknown`), never `dead`: a host that did not answer has told
us nothing about the credential.

### The classifier

One shared function beside `FetchOutcome`, so all 97 connectors classify
identically rather than each inventing its own notion of authentication failure.

```text
auth-failure  : HTTP 401 | 403, or a provider body matching the known
                auth-rejection set (invalid_grant, invalid_client,
                Unknown JWT iss, Error decoding signature)
transient     : network error | timeout | HTTP 408 | 429 | 5xx
indeterminate : any other non-2xx (400, 404, 409, 422, …)
ok            : HTTP 2xx
```

`ok` means **2xx**, never "anything that wasn't one of the above". An earlier
draft of this spec defined it as "anything else that returned data", which would
have classified a `400 Bad Request` from a changed request schema as a healthy
credential — a false green, the precise defect this whole design exists to
prevent. The catch came from design review.

`indeterminate` writes `unknown` with the redacted `detail`, never `ok` and
never `dead`. A 404 on a renamed endpoint or a 400 from a schema change says
nothing about the credential; claiming either answer would be a lie in a
different direction. `unknown` with a stored reason is the honest result, and it
still surfaces in `nimbus creds` so the user can see something is wrong.

### Readers — status derived fresh on every read

Evaluated strictly in this order; the first match wins. The ordering **is** the
precedence rule — an earlier draft stated the expiry rows and the
observation-beats-metadata rule separately, which let the same row yield two
contradictory answers:

```text
1. observed_status = dead                     → DEAD      "since <last_ok_at>"
2. expires_at set AND last_ok_at > expires_at → (fall through — see below)
3. expires_at <= now                          → EXPIRED
4. expires_at - now <= warn window            → EXPIRING  "in N days"
5. last_checked_at is null                    → UNKNOWN   "not checked yet"
6. now - last_checked_at > stale window       → UNKNOWN   "stale — last checked <when>"
7. observed_status = ok                       → OK
8. otherwise                                  → UNKNOWN   <detail>
```

**Rule 2 is the precedence statement**: a successful observation *more recent
than* the recorded expiry proves the expiry metadata wrong, so rows 3 and 4 are
skipped entirely. Salesforce omits `expires_in`, so Nimbus synthesises a
30-minute expiry — without rule 2 every working Salesforce credential would
render `EXPIRED`. Observation is evidence; metadata is a claim.

Two thresholds, both configurable under `[credentials]` in `nimbus.toml`:

| Threshold | Default | Why |
| --- | --- | --- |
| `warn_before_expiry_days` | **30 days** | The credentials that hurt require a console trip; a week is not enough notice to act on. |
| `stale_after_days` | **7 days** | A credential unobserved for longer than a week has no current evidence behind it. |

`stale_after_days` is shorter than `warn_before_expiry_days` on purpose — they measure
different things. One asks "how long before this dies?", the other "how long
since anyone checked?". A stale `ok` is not a reassuring `ok`; it is an absence
of evidence, and rendering it as `UNKNOWN (stale — last checked 12 days ago)`
says so.

`nimbus creds` prints the roll-up (and `--json`, matching
`nimbus security scan`). `nimbus doctor` gains one summary line.

## Error handling

1. **Transient misread as death** — mitigated by the classifier, plus always
   rendering `last_ok_at`. "Dead 3 minutes ago" and "dead 3 weeks ago" demand
   different reactions; a bare red dot discards that.
2. **Stale health read as current health** — an `ok` from three weeks ago must
   not render like one from five minutes ago. Beyond the staleness threshold the
   status degrades to `UNKNOWN (stale)` rather than continuing to claim `ok`.
   This is defect 1 re-encoded, and the single most important safeguard here.
3. **Provider expiry metadata that lies** — Salesforce omits `expires_in`, so
   Nimbus *synthesises* a 30-minute expiry. Rule: **a more recent observation
   beats older metadata.** If `last_ok_at > expires_at`, report `ok`.
   Observation is evidence; metadata is a claim.
4. **Secret leakage via `detail`** — the one place a credential could escape.
   Provider auth errors echo credentials routinely. `redactAuditPayload` at a
   256-byte cap, the same path the egress ledger uses.
5. **HTML error bodies** — providers behind SSO, a CDN or a misconfigured
   reverse proxy answer with an HTML page, not JSON. Capping that at 256 bytes
   stores `<!DOCTYPE html><html><head><title>` and nothing useful. This is not
   an edge case here: self-hosted connectors (GitLab, Jenkins, ArgoCD, Grafana,
   Jira) sit behind exactly such proxies. When the body is HTML — by
   `Content-Type` or a leading `<`— extract the `<title>` text, else the first
   text node, and fall back to `"HTML error page (HTTP <status>)"` when neither
   yields anything.

   **Ordering is load-bearing: extract → strip → redact → cap, in that order.**
   Redaction must be the last transformation before storage. Redacting first and
   then extracting could lift a secret out of an attribute or comment that the
   redactor had already neutralised, re-introducing it into the stored string.
6. **Probe blast radius** — up to 97 live APIs. Explicit invocation, capped
   concurrency, `limit=1`, per-probe timeout, existing rate limiters.
7. **Orphaned rows on connector removal** — `nimbus connector remove` deletes a
   connector's Vault entries and index rows atomically. `credential_health` rows
   must be removed in that same transaction, or a removed connector keeps
   reporting health for credentials that no longer exist. (Not raised in review;
   found while applying it.)

## Testing

**The classifier, table-driven, using the real 2026-07-28 error bodies** — not
invented fixtures. These are the exact strings that defeated four rounds of
human hypothesis:

| Fixture | Expected |
| --- | --- |
| `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}` | auth-failure |
| `{"error":"invalid_client","error_description":"The provided client secret is invalid."}` | auth-failure |
| `{"detail":"Unknown JWT iss (issuer)."}` | auth-failure |
| `{"detail":"Error decoding signature."}` | auth-failure |
| HTTP 429 + `Retry-After` | transient |
| HTTP 502 / `ECONNRESET` | transient |
| probe exceeds the 10 s deadline | transient |
| HTTP 400, body `{"message":"unknown field 'limit'"}` | **indeterminate** |
| HTTP 404, empty body | **indeterminate** |
| HTTP 200 with a valid payload | ok |

The two transient rows and **both indeterminate rows** are **red-proved** per
the repo convention: break the guard deliberately, watch it fail, restore it. A
guard that has never failed is a guard nobody has verified.

The indeterminate rows exist because the first draft of this spec would have
classified them `ok`. They are the regression test for a false green that design
review caught before implementation — the highest-value tests in the file.

**Redaction as a Vault-class assertion.** Feed the classifier an error body
containing a token-shaped string; assert it appears nowhere in the stored row.
Vault tests already prove no secret escapes through *any* interface; `detail` is
a new interface and inherits that bar.

**HTML extraction, with the ordering asserted.** Feed a proxy error page whose
`<title>` is `502 Bad Gateway` and whose body embeds a token-shaped string in an
HTML comment; assert `detail` contains the title text and **not** the token.
This proves extract → strip → redact → cap runs in that order — redaction last.

**Behavioural tests**, one per failure mode: transient does not mark dead; a
400/404 marks `unknown` rather than `ok`; stale `ok` degrades to `UNKNOWN`;
newer `last_ok_at` overrides a bogus `expires_at`; un-spawnable connector
reports `unknown`; a timed-out probe reports `unknown`; an unattributable 401 on
a multi-key connector marks every *secret* key and no config key; and
`connector remove` leaves no orphaned health rows. Plus the V45 migration and an
E2E run — real gateway subprocess, mock MCP server returning 401, asserting
`nimbus creds` shows `DEAD`.

### Testing principle earned on 2026-07-28

> **The test harness must never be more forgiving than production.**

The local verification scripts written during the incident called `.Trim()` on
pasted input where `gh secret set` does not. They therefore returned green on
the precise defect breaking CI. A diagnostic more lenient than the real path
does not merely fail to help — it converts an unknown into a confident wrong
answer.

Concretely: no normalising in test helpers that production does not perform, and
the E2E path exercises the *same* classifier the sync path uses, never a double.

## Appendix — why not migrate connectors to OAuth

Considered, because OAuth credentials self-heal and carry expiry. Rejected as a
program; retained as a per-connector judgement.

1. **Users supply their own OAuth client credentials.** There is no shipped
   Nimbus OAuth app — `oauth-env-help-messages.ts` instructs the user to create
   their own Desktop client in the provider's console. Migration therefore
   *multiplies* the console ritual it was meant to remove.
2. **~14 of the 53 cannot move at all** — argocd, jenkins, flux, imap,
   protonmail, elasticsearch, superset, metabase, airflow, dagster, prefect,
   sonarqube, dependencytrack, grafana are self-hosted or protocol-level. There
   is no central authority to register with; the user *is* the provider.
3. **OAuth credentials die silently too.** Defect 1 above *was* an OAuth
   credential with a refresh token, and OAuth supplied the
   client-id/secret/token triple that then half-updated. A static key has one
   part and cannot fail that way.
4. **Cost:** a 6-file exhaustive-`never`-switch co-edit per provider
   (`oauth-registry.ts`, `pkce.ts`, `connector-catalog.ts`,
   `connector-vault.ts`, `lazy-mesh/credential-orchestration.ts`, help text).

OAuth reduces how often a credential dies. It does nothing about noticing when
one does. The two are orthogonal, and this design addresses the second.
