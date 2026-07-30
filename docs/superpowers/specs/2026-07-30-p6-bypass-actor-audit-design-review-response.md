# Design Review Response: Bypass-actor audit

Response to
[2026-07-30-p6-bypass-actor-audit-design-review.md](./2026-07-30-p6-bypass-actor-audit-design-review.md),
against
[2026-07-30-p6-bypass-actor-audit-design.md](./2026-07-30-p6-bypass-actor-audit-design.md).

**Disposition: 4 fixed, 1 partially fixed with the mechanism rejected, 1 declined
on evidence.**

| # | Item | Disposition |
| --- | --- | --- |
| 1.1 | Actor-id portability | **Fixed differently** — premise doesn't apply; real issue is reviewability. Wildcard suggestion rejected. |
| 1.2 | Partial reads under `--attest` | **Fixed** — genuine hole, the most valuable finding in the review |
| 1.3 | Clock skew / timezone | **Partially fixed** — UTC half already held; the future-date fail-open did not |
| 2.1 | `attested_by` fallback | **Goal adopted, mechanism rejected** |
| 2.2 | Directory autocreation | **Declined** — directory is git-tracked, cannot be absent |
| 2.3 | `bypass_mode` enum validation | **Fixed**, with the rationale corrected |

---

## 1.2 — Partial reads under `--attest` — FIXED

The strongest finding, and a real hole rather than a hardening suggestion.

The draft said `--attest` writes "only when the diff is green" and stopped there.
Checking `decideExit` in `check-ruleset-drift.ts` — which this gate mirrors —
confirms the gap:

```ts
if (errors.length > 0) { ...code 1 }
if (unreachable.length > 0) {
  return { code: 0, message: `OK (${queried} repos) — WARNING: could not query ...` };
}
```

A 4-of-5 read with no drift **exits 0**. That is correct for a reporting gate and
wrong for an attesting one: `--attest` keyed off exit code would write an
attestation whose `repos` field claims five repos on four repos' evidence. Gate
2's check 3 compares that field against declared `repos`, sees five, and passes.
The partial read launders itself into a green sweep for the whole grace window —
in the sub-program whose entire premise is that controls silently stop covering
things.

**Fix.** `--attest` now requires two conditions: green diff **and**
`queried === repos.length` with `unreachable` empty. Any unreachable repo exits 1
and writes nothing. Additionally the written `repos` field is **derived from the
observed set rather than copied from config**, so even a future refactor that
loses the first guard cannot claim uncovered repos.

Attesting is interactive and re-runnable, so refusing on partial data costs
nothing.

## 1.1 — Actor-id portability — FIXED DIFFERENTLY, suggestion rejected

**The stated premise does not apply.** The review posits a fork or a
"test/staging GitHub organization" where ids differ. Verified: `nimbus-agent` has
19 repos and no staging or test org exists, and every gate in this sweep —
`ruleset-drift`, `org-settings-drift`, `cla-coverage`, `review-coverage` —
hard-codes `nimbus-agent` in its `gh api` paths. A fork could not run this gate
regardless: it is sweep-only and needs org-owner credentials. There is no
environment in which these ids vary.

**But there is a real problem underneath, and it is not portability — it is
reviewability.** Every bypass actor in the org today is `OrganizationAdmin` with
`actor_id: null`. `Team`, `Integration` and `RepositoryRole` carry numeric ids,
and the entire control in this design is that the config and attestation are
PR-visible and diff-reviewed. `"actor_id": 4382579` is not something a human
reviewer can check. A numeric id would quietly downgrade the gate to a
shape-check while still reading as green.

**The suggested fix would make this worse, so it is rejected.** Wildcard
`actor_id` matching means *any* team's bypass satisfies a declared entry — which
erases exactly the distinction the gate exists to detect. "A team has admin
bypass here" and "*this specific* team has admin bypass here" are different
security properties, and the wildcard collapses them.

**What was done instead.** The design now states the supported scope explicitly —
null-id org-level actors — and makes an undeclared actor type a **hard error**
rather than a silent normalization, so a `Team` bypass added through the UI reds
the gate. If such an actor is ever genuinely wanted, the recorded follow-up is to
resolve ids to names at read time (`/orgs/{org}/teams/{id}`) and diff on the name,
keeping the config human-checkable. Deferred until one exists (YAGNI); the hard
error ensures it cannot be added unnoticed in the meantime.

## 1.3 — Clock skew and timezone — PARTIALLY FIXED

**The UTC half already held.** The suggestion is to "mandate ISO 8601 UTC strings
and enforce UTC-only arithmetic (e.g. comparing millisecond timestamps relative
to `Date.now()`)". That is what the design already produces: `toISOString()`
returns UTC with a `Z` suffix by JS spec, and `Date.now() - Date.parse(...)` is
epoch milliseconds on both sides. Epoch ms carry no offset, so there is no
timezone normalization step to add — a machine in UTC+13 and one in UTC-8 compute
the identical elapsed duration. No change needed here.

**Two genuine fail-opens were missing, both of which the item gestures at.**

1. **Unparseable `attested_at`** → `Date.parse` returns `NaN`, and every
   comparison with `NaN` is false — so a naive `elapsed > grace` staleness check
   *passes*. A corrupt timestamp read as fresh, indefinitely. Now handled as
   check 1's `unparseable` verdict.
2. **Future-dated `attested_at`** → negative elapsed time stays under any grace
   window until real time catches up. Clock skew or a hand edit both produce it.
   Now a hard error beyond a **1 hour** tolerance, which absorbs NTP drift without
   absorbing a meaningful backdate.

Both are the same failure shape the design already worries about elsewhere: the
check passes not because the property holds, but because the comparison is
vacuous.

## 2.1 — `attested_by` fallback — GOAL ADOPTED, MECHANISM REJECTED

The robustness goal is right: a diagnostic field must never sink an otherwise
complete audit. Adopted — on failure the field is written `"unknown"` and the
attestation still succeeds.

**The proposed fallback sources are rejected on correctness.** `git config
user.name`, `user.email` and `$USER` name whoever configured the checkout, not
the credential that performed the read. In an audit artifact whose purpose is
attributing an observation, asserting an identity the audit cannot support is
worse than recording nothing — it manufactures false provenance precisely where
provenance is the point.

The stated failure mode is also close to unreachable in isolation: `gh api user`
failing means `gh` auth is broken, in which case the five ruleset reads have
already failed and no attestation is written at all. There is no realistic path
where user-lookup fails alone.

## 2.2 — Directory autocreation — DECLINED

`docs/structure-audit/` is **git-tracked**: it contains a committed `.gitkeep`
plus `ci-latency-baseline.json`, `coverage-baseline.json`, `any-baseline.json`,
`baseline.md` and `sonarqube-rule-tuning.md`. It cannot be absent in any checkout
where this script can run, since the script itself lives in the same repo.

A recursive `mkdir` would be unreachable defensive code guarding an impossible
state. Declined as YAGNI. If the attestation ever moves to an untracked location,
this becomes correct and should be revisited then.

## 2.3 — `bypass_mode` enum validation — FIXED, rationale corrected

Adopted, but the stated impact is backwards and worth correcting so the reasoning
survives in the record. The review says a typo such as `"alway"` would pass
validation "but fail or drift at run time". It would not pass anything: declared
`"alway"` versus live `"always"` is a mismatch, and the gate goes **red** — loudly
and immediately.

So this is not a correctness fix. It is a **diagnosis** fix, which is still worth
having. Unvalidated, the finding reads:

```text
Nimbus: bypass_mode: expected alway, got always
```

which points the reader at the org setting when the defect is in the config file.
Validated:

```text
invalid bypass_mode "alway" in bypass.by_repo.Nimbus (expected always|pull_request)
```

Same red, correct target. On a gate expected to fire a few times a year,
misdiagnosis is the expensive failure — this is the same reasoning that made
`absent` and `unparseable` distinct verdicts in `review-coverage`.

`actor_type` is validated alongside it, which is also what enforces the 1.1 hard
error.

---

## Net effect

One real bug (1.2) and two real fail-opens (1.3) removed before any code was
written — the case for reviewing a spec rather than a diff. The two items
declined or redirected were declined on verified evidence, not preference: 2.2
guards a state that git makes impossible, and 1.1's suggested wildcard would have
weakened the exact property the gate protects.

No change to the design's shape, credential model, or the
[grace-window decision](./2026-07-30-p6-bypass-actor-audit-design.md). The
*"What this does not prove"* section stands unchanged and remains the item most
worth an explicit accept before implementation.
