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
  observed_status TEXT NOT NULL,      -- 'ok' | 'dead' | 'unknown'
  observed_via    TEXT NOT NULL,      -- 'sync' | 'probe'
  last_checked_at INTEGER,
  last_ok_at      INTEGER,
  detail          TEXT,               -- redacted, capped at 256 bytes
  expires_at      INTEGER,
  expiry_source   TEXT                -- 'provider' | 'declared' | NULL
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
| Transient (network, 429, 5xx) | **status untouched**; only `last_checked_at` moves |

The third row is the load-bearing behaviour. **A network blip must never mark a
credential dead.** False positives in this direction train users to ignore the
feature.

### Writer 2 — declared expiry

`nimbus creds expires <vault_key> <ISO-date>` sets `expires_at` and
`expiry_source='declared'`. Pure metadata; touches no secret; idempotent.

This is the *only* mechanism that makes a known deadline on an opaque token
visible — the class of credential that today is guarded by nothing but human
memory.

### Writer 3 — active probe

`nimbus creds check [connector]` calls each configured connector's mandatory
`<name>_list` at `limit=1`, through the same classifier.

Constraints: explicitly invoked only (never implicit), capped concurrency, and
routed **through** each connector's existing rate limiter rather than around it.
A connector whose MCP server fails to spawn yields `unknown`, not `dead` — "I
could not ask" is not "the answer was no".

### The classifier

One shared function beside `FetchOutcome`, so all 97 connectors classify
identically rather than each inventing its own notion of authentication failure.

```text
auth-failure : HTTP 401 | 403, or a provider body matching the known
               auth-rejection set (invalid_grant, invalid_client,
               Unknown JWT iss, Error decoding signature)
transient    : network error | HTTP 408 | 429 | 5xx
ok           : anything else that returned data
```

### Readers — status derived fresh on every read

```text
dead                              → DEAD      "since <last_ok_at>"
expires_at < now                  → EXPIRED
expires_at within warn window     → EXPIRING  "in N days"
last_checked_at older than stale  → UNKNOWN   "(stale — last checked <when>)"
ok                                → OK
never observed                    → UNKNOWN   "not checked yet"
```

Warn window defaults to **30 days**, configurable. Thirty rather than seven
because the credentials that hurt require a console trip, and a week is not
enough notice to be useful.

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
5. **Probe blast radius** — up to 97 live APIs. Explicit invocation, capped
   concurrency, `limit=1`, existing rate limiters.

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

The two transient rows are **red-proved** per the repo convention: break the
guard deliberately, watch it fail, restore it. A guard that has never failed is
a guard nobody has verified.

**Redaction as a Vault-class assertion.** Feed the classifier an error body
containing a token-shaped string; assert it appears nowhere in the stored row.
Vault tests already prove no secret escapes through *any* interface; `detail` is
a new interface and inherits that bar.

**Behavioural tests**, one per failure mode: transient does not mark dead; stale
`ok` degrades to `UNKNOWN`; newer `last_ok_at` overrides a bogus `expires_at`;
un-spawnable connector reports `unknown`. Plus the V45 migration test and an
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
