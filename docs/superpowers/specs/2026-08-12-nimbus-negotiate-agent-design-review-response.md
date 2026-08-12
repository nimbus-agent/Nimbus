# `nimbus negotiate` Agent Design — Review Response

**Date:** 2026-08-12
**Responds to:** `2026-08-12-nimbus-negotiate-agent-design-review.md`
**Outcome:** 3 accepted (one of them the most consequential finding in the review), 1 accepted in
modified form after its premise turned out wrong, 1 deferred as an already-made decision, both
implementation suggestions accepted.

Every item was checked against the tree before deciding.

---

## 4. Git email / identity resolution — **ACCEPTED. This is the most important finding here.**

Confirmed at `ownership/owner-identity.ts:32-58`. `resolveOwner` maps a blame email to a `person`
row via `findPersonByCanonicalEmail`; an email that does **not** match yields a `git:<email>` entity
and — per the function's own docstring — is **never inserted into the `person` table**:

```text
matched   → entityExternalId = person.id      resolved: true
unmatched → entityExternalId = `git:<email>`  resolved: false, never a person row
```

So the `owns` graph mixes person-keyed and `git:`-keyed entities. A lane querying
`person --owns--> …` by the subject's person id therefore sees **only** the blame lines whose git
email already maps to that person. Work committed under a second machine, an old address, or a
GitHub `noreply` alias is attributed to a separate entity and disappears from the brief with no
indication.

**Why this outranks the rest of the review:** the failure is a silent undercount in a document whose
whole purpose is to argue that someone's contribution is larger than it appears. Being quietly
short is worse here than being empty.

**Fix (spec § 5.A0, new):** the ownership lane states that it counts only blame lines whose git email
maps to a known person. For the SELF case it is precise rather than generic — `resolveSelfPerson`
already resolves through `git config user.email`, so the lane checks whether a `git:<that email>`
entity exists in the graph and, if so, emits a named gap ("some of your ownership is recorded under
an unmapped git identity and is not counted here") pointing at the person record. For a `--person`
subject the alias set is unknowable, so only the general caveat applies. A test seeds blame under an
unmapped email and asserts the gap fires rather than an empty section.

---

## 3. Ownership lane performance — **ACCEPTED IN MODIFIED FORM; the stated premise is wrong**

The review asks for a timeout and index tuning on "traversal of ownership graphs and git blame
databases … extremely heavy on large repositories."

**The lane does not read blame at request time.** `ownership/ownership-pass.ts` precomputes
`person --owns--> …` edges in a debounced background pass; the lane reads those edges. The expensive
work is already off the request path, so a timeout would guard something that is not happening.

**But there is a real bound problem underneath it.** `maxOwnersPerPath` bounds owners *per path*,
not paths *per owner* — nothing caps how many `owns` edges one person accumulates, and a
long-tenured engineer can carry thousands. Materialising that per file would blow the latency
budget and produce an unreadable brief.

**Fix (spec § 3, lane 4):** the lane aggregates to directory and service level and applies an
explicit `LIMIT`, rather than listing files — and the spec now states outright that it reads
precomputed edges, so nobody adds a blame query here later.

---

## 2. Discoverability of personal-source identifiers — **ACCEPTED, reduced**

Real gap: config-as-consent only works if the identifiers are discoverable. A user who cannot work
out how to name their Obsidian root or Notion database has consent they cannot express.

**Not adopted as proposed** — a separate discovery command is its own feature, and this agent should
not grow one. **Fix (spec § 5.F):** when no personal sources are configured the brief says so once
and names the config key, so an empty personal-sources section reads as *"not enabled"* rather than
*"nothing found."* That is the same distinction rule as § 5.D, applied to configuration instead of
data. If discovery proves genuinely hard in use, a `nimbus negotiate --sources` listing is a cheap
follow-up on top of this.

---

## 1. HTTP exclusion vs client integrations — **DEFERRED: already decided, with the consequence recorded**

The review asks whether the threat model justifies permanently disabling HTTP access, and proposes
allowing the method while restricting `--person` to self on that transport.

**That exact option was offered and declined.** The choice between full exclusion, full exposure, and
transport-conditional `--person` was put to the human partner on 2026-08-12; they chose full
exclusion. This is their decision, not an oversight, and I am not reopening it on a reviewer's
suggestion.

**The consequence the review correctly identifies is real and is now recorded**: a browser-side
gateway client cannot render this brief. That matters because the roadmap's stated direction for
that client is an ambient panel running the existing `agents.*` briefs. Tauri is unaffected — it
speaks JSON-RPC over IPC, not HTTP.

The transport-conditional design remains available if that client work makes it necessary: expose
the method and reject a non-self `--person` on the HTTP transport. It would need its own review,
because "which transport asked" becomes a security-relevant input to a handler, which is a shape
this codebase currently keeps out of agent handlers.

---

## Implementation suggestions — both **ACCEPTED**

**Red-prove the HTTP exclusion at the route level.** Accepted and added alongside the existing test
rather than replacing it. The spec already asserted `agents.negotiate` is absent from
`HTTP_AGENT_NAMES`; the review is right that this only proves a name is missing from a derived
array. An HTTP-level test driving `POST /v1/agents/negotiate` proves the route actually refuses.
**Keep both — they fail for different reasons**, and the derived-list test is the one that catches a
refactor dropping the exclusion.

**Granular gap note for unattributable decisions.** Accepted, and strengthened from a plan-time
question into a requirement: § 8.2 previously asked *whether* the decisions lane needs its own gap
note. It now states that the lane emits a specific note ("N decisions could not be attributed to an
author") either way, rather than folding those rows into a general failure or silently dropping them
from the count — which would be the same silent-undercount defect as § 5.A0, one lane over.

---

## Spec changes made

| Section | Change |
| --- | --- |
| § 5.A0 (new) | Unmapped-git-identity undercount: general caveat, plus a precise self-case gap note |
| § 3, lane 4 | States the lane reads precomputed edges, not blame; adds directory/service aggregation + `LIMIT` |
| § 5.F | Names the config key when no personal sources are configured |
| § 7 | Adds the HTTP-route rejection test and the unmapped-identity gap test |
| § 8.2 | Upgraded from an open question to a required gap note |
