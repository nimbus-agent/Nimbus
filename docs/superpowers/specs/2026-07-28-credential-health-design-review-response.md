# Design Review Response: Credential Health

Response to [`2026-07-28-credential-health-design-review.md`](./2026-07-28-credential-health-design-review.md).

**All six points accepted and applied.** Three were accepted with an additional
constraint the review did not raise; one exposed a false-green defect in the
original classifier. Applying the review surfaced a seventh issue, recorded
below. Nothing was deferred.

---

## 1.1 — HTTP 400 / 404 classification · **FIXED**

**The review was right, and this was the most serious finding in the set.**

The original classifier ended with `ok : anything else that returned data`. A
`400 Bad Request` from a changed request schema returns data, is not 401/403,
and is not transient — so it would have been classified **`ok`**. A connector
whose probe was structurally broken would have reported a healthy credential.

That is a false green: the exact defect this design exists to prevent, written
into the design itself. The irony is worth recording rather than quietly fixing.

Applied:

```text
auth-failure  : 401 | 403 | known auth-rejection bodies
transient     : network | timeout | 408 | 429 | 5xx
indeterminate : any other non-2xx (400, 404, 409, 422, …)
ok            : HTTP 2xx
```

`ok` now means **2xx**, not "everything left over". `indeterminate` writes
`unknown` with the redacted detail — never `ok`, never `dead`. A 404 on a
renamed endpoint says nothing about the credential; asserting either answer
would be a lie in a different direction.

Both cases are added to the classifier test table and **red-proved**. They are
the regression test for a defect caught before implementation.

## 1.2 — Attributing a failure to a specific `vault_key` · **FIXED**

Real gap: the design keyed health by `vault_key` but never said how a bare 401
maps to one of a connector's nine credentials.

The review offered "all three, or only the primary token". Applied a two-rule
version, which differs slightly from both:

1. **Attribute precisely when the failure identifies the credential** — an OAuth
   refresh rejection belongs to that connector's `*.oauth` key alone.
2. **Otherwise mark the credential *set*** — every *secret* key the connector
   declares, excluding non-secret config (hosts, regions, usernames), sharing
   one `detail`.

Rule 2 is deliberately blunt, and the reasoning matters: **a 401 proves the set
failed to authenticate; it does not prove which member is at fault.** Guessing a
"primary" key would manufacture a precise-looking claim the evidence cannot
support, and guessing wrong is the worse failure — the real culprit would keep
reading `ok`. Excluding config keys matters too: a wrong `jira.host` should not
mark `jira.api_token` dead.

Readers group by connector, so a nine-key connector renders one line.

## 1.3 — Staleness threshold undefined · **FIXED**

Correct — the spec referenced a staleness threshold it never defined. Both
thresholds are now explicit and configurable under `[credentials]`:

| Threshold | Default |
| --- | --- |
| `warn_before_expiry` | 30 days |
| `stale_after` | 7 days |

The review suggested 7 days, which is adopted. Worth stating why the two differ
rather than sharing one value: they measure different things. One asks "how long
until this dies?", the other "how long since anyone checked?". Seven days
without observation means there is no current evidence; thirty days of warning
is what a console-trip credential needs to be actionable.

## 2.1 — HTML error body sanitisation · **FIXED, plus an ordering constraint**

Accepted, and it is not an edge case here: the self-hosted connectors
(GitLab, Jenkins, ArgoCD, Grafana, Jira) are exactly the ones sitting behind
proxies that answer with HTML.

Applied: when the body is HTML — by `Content-Type` or a leading `<` — extract
the `<title>` text, else the first text node, falling back to
`"HTML error page (HTTP <status>)"`.

**Added beyond the review:** the pipeline order is now specified as
**extract → strip → redact → cap**, with redaction explicitly last. The review
proposed stripping before capping but did not address where redaction sits, and
the order is load-bearing — redacting *first* and extracting *after* could lift
a secret out of an HTML attribute or comment the redactor had already
neutralised, re-introducing it into the stored string. A test asserts this: a
proxy page whose title is `502 Bad Gateway` and whose body hides a token-shaped
string in a comment must store the title and not the token.

## 2.2 — Prompt for expiry during `connector auth` · **FIXED, with constraints**

Accepted, and it is more than convenience: relying on the user to remember a
second command reproduces precisely the human-memory failure this design
criticises. The moment of entry is the only moment the expiry is known.

Applied as a skippable prompt after an opaque credential is stored.

**Added beyond the review:** the prompt is suppressed entirely when stdin is not
a TTY or `--json` is passed. `nimbus connector auth` is scripted in CI, and an
unconditional prompt would hang non-interactive callers — turning a health
feature into an outage. Skipping leaves `expires_at` NULL, which reads as
`UNKNOWN`, never as `ok`.

Sequencing note: this touches a different subsystem's UX and the feature is
complete without it, so it is sequenced **last** in implementation. It must
never block the core.

## 2.3 — Active probe timeouts · **FIXED**

Accepted. Applied as a hard per-probe deadline, default **10 s**, configurable.

**Added beyond the review:** the classification of a timeout is specified — it
is `transient`, therefore `unknown`, **never `dead`**. A host that did not
answer has told us nothing about the credential. Without this the timeout
safeguard would have introduced the very false-positive the classifier exists to
prevent. A timeout row is added to the classifier test table.

---

## Found while applying the review · **FIXED**

**Orphaned health rows on connector removal.** `nimbus connector remove` deletes
a connector's Vault entries and index rows atomically. Nothing in the original
design removed its `credential_health` rows, so a removed connector would keep
reporting health for credentials that no longer exist — stale state that looks
authoritative. Health rows are now deleted in the same transaction, with a test.

---

## Summary

| Point | Verdict | Note |
| --- | --- | --- |
| 1.1 400/404 classification | **Fixed** | Was a false green in the spec itself |
| 1.2 Multi-key attribution | **Fixed** | Mark the set, never guess a primary |
| 1.3 Staleness threshold | **Fixed** | 7 days, distinct from the 30-day warn window |
| 2.1 HTML sanitisation | **Fixed** | + redaction ordering constraint |
| 2.2 Prompt at auth time | **Fixed** | + TTY/`--json` suppression; sequenced last |
| 2.3 Probe timeout | **Fixed** | + timeout classifies as transient, not dead |
| Orphaned rows | **Fixed** | Found while applying the review |

Four of the seven changes are guards against **false greens** — a broken probe
reading `ok`, a timeout reading `dead`, a stale row reading current, a removed
connector still reporting. That is the correct centre of gravity for this
design, and the review moved it there.
