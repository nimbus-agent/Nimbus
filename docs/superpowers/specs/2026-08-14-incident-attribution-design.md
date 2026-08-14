# Incident attribution — design (Spec B)

**Date:** 2026-08-14
**Substrate:** sub-project C of the `nimbus negotiate` substrate (Spine S1)
**Continues:** [`2026-08-12-sentry-issue-indexing-design.md`](./2026-08-12-sentry-issue-indexing-design.md) (Spec A, shipped in #1172 / `ea37e0d0`)
**Repo facts pinned to:** `origin/main` @ `a68945e5`

---

## 1. Goal

Make `person -> incident` and `person -> error_issue` attribution real, so that
`nimbus negotiate` can cite incident work instead of declaring it permanently
unavailable, and so the three agent lanes already written against these edges stop
returning nothing.

This is the second and final spec of the incident-attribution substrate. Spec A
indexed Sentry issues and built `error_issue` entities but deliberately attributed
nobody. Spec B attributes.

## 2. Scope

Three edges, across two connectors:

| Edge | Source | Emitted by |
| --- | --- | --- |
| `person --assigned--> incident` | PagerDuty `assignments[].assignee` | `syncTimelineEventGraph` (incident arm) |
| `person --resolves--> incident` | PagerDuty `last_status_change_by` when `status = "resolved"` | same |
| `person --assigned--> error_issue` | Sentry `assignedTo` (already stored raw by Spec A) | `syncErrorIssueGraph` |

Sentry gets **no** "resolved by" edge. Spec A already declined it and this spec keeps
that refusal: Sentry cannot honestly say who resolved an issue without a per-issue
activity-feed request, which is a request-per-issue cost for a claim nobody is waiting
on. The brief states the absence rather than guessing.

## 3. Two divergences from the Spec B decisions recorded in Spec A

Spec A (§ "Attribution decisions already agreed for Spec B") recorded two decisions
that this spec changes. Both changes are deliberate and are called out here so the
divergence is visible rather than silent.

### 3.1 No `responded` edge; assignee and resolver are separate edges

Spec A recorded "assignee ∪ acknowledger → a `responded` edge". This spec emits
`assigned` from assignees only, and emits **no acknowledger edge at all**.

Reason: acknowledgement is noisier evidence than assignment — an incident can carry
several acknowledgers, and acknowledgement is the act of silencing a page, not of
owning the work. Merging assignee and acknowledger into one `responded` edge would
make the resulting count undefendable in exactly the conversation `negotiate` exists
to support. Two narrow, separately-defensible claims beat one broad one.

### 3.2 Acknowledgers are still fetched — as an identity source only

Spec A's resolver rule was: attribute `last_status_change_by` **only** when it is a
`user_reference` present in the expanded assignee/acknowledger set. That rule exists
because `last_status_change_by` is a bare reference — the cross-reference is how it
acquires an email.

Dropping the acknowledger edge (§ 3.1) would shrink that cross-reference set to
assignees alone and silently reduce resolver coverage: a responder who acknowledged
and resolved but was never assigned would become unattributable.

So `include[]=acknowledgers` is still requested, and expanded acknowledgers still feed
the email map — they just never produce an edge. Fetching a field for identity while
declining to make a claim from it is the honest combination.

## 4. Verified facts

Checked against the tree or primary-source documentation during design. Repo facts are
`file:line` at `a68945e5`.

### 4.1 Repo — three readers are already written and waiting

| Fact | Evidence |
| --- | --- |
| **`catchup` already queries `person --resolves--> incident`** and returns nothing | `agents/catchup.ts:318-331` — joins `pe.type='person'`, `ie.type='incident'`, `r.type='resolves'` |
| **`expert` has a `subIncidentResolved` lane** gated on the same edge | `agents/expert.ts:396-413` — probes `detectMissingRelationToEntityType(db, "resolves", "incident", …)` |
| `negotiate` declares the evidence permanently unavailable | `agents/negotiate.ts:53-57` — `UNAVAILABLE_EVIDENCE` contains `"incidents resolved"` |
| `decision-corroborate` already defends against this edge existing | `decisions/decision-corroborate.ts:135-152` — comment at :137-138 reads "`resolves` is polysemous (also emitted person -> incident elsewhere in the graph)"; both endpoints type-scoped |
| No agent reads `error_issue` at all | `grep error_issue packages/gateway/src/agents/` → no non-test hits |
| No populator emits `assigned`, and no reader consumes it | `grep "'assigned'"` → only the v7 seed row |

### 4.2 Repo — the graph layer

| Fact | Evidence |
| --- | --- |
| **`graph_relation.type` is FK-constrained** to `graph_relation_type(name)` | `index/graph-v7-sql.ts:21` |
| The FK is enforced on the production path | `index/local-index.ts:279` — `PRAGMA foreign_keys = ON` |
| **`resolves` and `assigned` are both already registered** | `index/graph-v7-sql.ts:35,37` |
| Latest schema version is V53 | `index/migrations/runner.ts:548` |
| `clearRelationsTouchingEntity` deletes every edge touching an entity except four cross-item types | `graph/graph-populator.ts:89-105` |
| `resolves` is one of those four protected types | `graph/graph-populator.ts:90` |
| `error_issue`'s populator already warns that person edges must be re-emitted inside it | `graph/graph-populator.ts:794-803` |
| `regraph` replays `incident` **and** `error_issue` through the populator | `graph/regraph.ts:226-234` — `REGRAPH_TYPE_ORDER` is an *ordering* hint (`incident` is listed, `error_issue` is not), followed by a catch-all `type NOT IN (…)` slice that covers everything else. `error_issue` is replayed by that second slice, not the first |
| Person resolution from an email needs no migration | `people/linker.ts:28` — `resolvePersonForSync` resolves-or-creates from `canonicalEmail` |
| Only `notion-sync.ts` currently calls it | `connectors/notion-sync.ts:171-181` |

**Consequence: this spec needs no migration.** Both relation types already exist. An
earlier draft proposed `resolved` (past tense, for symmetry with `authored`/`reviewed`)
and a V54 migration to register it; the tree overrules that — `catchup.ts:328` and
`expert.ts:408` both already spell it `resolves`, and renaming would leave both lanes
permanently dead.

### 4.3 Repo — the connectors

| Fact | Evidence |
| --- | --- |
| PagerDuty writes no author and requests no `include[]` | `connectors/pagerduty-sync.ts:96` (`authorId: null`), `:163-167` (URL build) |
| PagerDuty's cold-start window is 30 days and is not operator-widenable | `connectors/pagerduty-sync.ts:136` — `initialSyncDepthDays = 30`; does not read `SyncContext.historyFloorMs` |
| **Sentry already stores `assignedTo` raw**, explicitly for this spec | `connectors/sentry-issue-mapping.ts:73-88` |
| `historyFloorMs` is opt-in per connector | read today by `jira-sync.ts`, `linear-sync.ts`, and (per Spec A) `sentry-issue-sync.ts` |
| `REBODY_REQUIRED_META_VERSION` is the seam for re-fetching stale connector metadata | `ipc/index-rebody-rpc.ts:127-137` — "A later depth PR adds a row here; it does not add a mechanism" |

### 4.4 External APIs — confidence labelled

`developer.pagerduty.com` and parts of Sentry's reference are JS-rendered and return
empty to a direct fetch, so some of this is search-summary evidence, not primary source.
**Every parser below must tolerate every field being absent.**

| Fact | Confidence | Consequence |
| --- | --- | --- |
| List Incidents accepts `include[]` of `acknowledgers`, `agents`, `assignees`, `conference_bridge`, `escalation_policies`, `first_trigger_log_entries`, `priorities`, `services`, `teams`, `users` | **High** — stated in the API reference | The parameter exists and is safe to send |
| `include[]=assignees` returns full user definitions in place of user references | **High** — "full user definitions will be returned if the `include[]=assignees` query parameter is provided" | Assignee emails cost **zero** extra requests |
| `include[]=acknowledgers` likewise returns full user *or service* definitions | **High** — same source | Acknowledger emails are free too |
| Full PagerDuty User objects carry `email` | **High** | The identity hint is available |
| Whether any `include[]` value expands `last_status_change_by` | **UNVERIFIED** | Design must not depend on it — see § 5.3 |
| `last_status_change_by` may be a `service_reference` on auto-resolve | **High** — inherited from Spec A's research | Auto-resolved incidents attribute to nobody |
| Sentry `assignedTo` is a nullable actor; whether a user actor carries `email` | **UNVERIFIED** — the docs example is `null` | Design must fail closed — see § 5.5 |

## 5. Design

### 5.1 Where identity resolution happens

**The connector stores actor emails in item metadata. The populator resolves email to
person and emits the edge.**

This split is not stylistic. `nimbus index regraph` replays stored item rows through the
populator with no network access (`graph/regraph.ts:197-237`). If the connector resolved
the person and only the edge carried the result, every replay would silently drop
attribution for every incident. Storing the email keeps replay correct, keeps identity logic in one
place, and is the same shape Spec A already chose for Sentry.

The populator calls `resolvePersonForSync(db, { canonicalEmail, displayName })`
(`people/linker.ts:28`), which matches an existing person by canonical email — merging
with the git/GitHub-derived identity — or creates one. Synchronous and DB-only, so it is
safe to call from a populator.

### 5.2 PagerDuty connector changes

Add to the List Incidents request (`pagerduty-sync.ts:163-167`):

```
include[]=assignees
include[]=acknowledgers
include[]=users
```

`buildPagerdutyMetadata` gains three keys:

```text
assignee_emails        string[]      normalized, deduped, capped at 10
resolved_by_email      string | null
unattributed_actors    number        actors seen but not resolvable to an email
meta_v                 number        PAGERDUTY_INCIDENT_META_VERSION = 1
```

`authorId` stays `null`. Confirmed rationale: six lanes across `negotiate.ts`,
`expert.ts` and `catchup.ts` query `item.author_id` directly, and an incident has no
author — setting it would reclassify incidents as authored work in briefs that never
asked for it.

`assignee_emails` is capped at 10 because `assignments[]` is caller-controlled and
unbounded. Overflow increments `unattributed_actors` rather than being dropped silently.

### 5.3 Resolving `last_status_change_by` without depending on expansion

Three-step ladder, fail-closed at every rung:

1. If `last_status_change_by` is already a full user object with an `email`, use it.
2. Otherwise cross-reference its `id` against the expanded assignee ∪ acknowledger
   email map built from the same response. (Spec A's rule; free.)
3. Otherwise `GET /users/{id}`, memoized in a `Map` for the sync run, **hard-capped at
   25 lookups per run**. Lookups beyond the cap are skipped and counted.

If all three fail, no `resolves` edge is emitted and `unattributed_actors` increments.

A `service_reference` (auto-resolve) short-circuits at step 0: attribute to nobody, and
do **not** spend a lookup on it.

Only incidents whose `status = "resolved"` produce a `resolves` edge. A triggered or
acknowledged incident's `last_status_change_by` is whoever last touched it, which is not
a resolver.

### 5.4 Graph population — incidents

Inside `syncTimelineEventGraph`'s incident arm, after the existing
`clearRelationsTouchingEntity(db, entityId)` call:

- for each `assignee_emails` entry → resolve → `upsertGraphRelation(person, incident, "assigned", now)`
- if `resolved_by_email` → resolve → `upsertGraphRelation(person, incident, "resolves", now)`

**`assigned` is not in `CROSS_ITEM_RELATION_TYPES`, and that is the point.** Because the
edge is re-emitted by the same populator that just cleared, a reassigned incident
automatically drops its stale assignee. This is strictly better than `reviewed`'s
disclosed-staleness compromise (`graph-populator.ts:298-308`), and it works only because
the incident's own populator is the sole writer of the edge.

**`resolves` *is* in that protected set** (`graph-populator.ts:90`), so
`clearRelationsTouchingEntity` will not retire it. Retirement therefore has to be
explicit: call `clearIncomingRelationsOfType(db, entityId, "resolves")` before
re-emitting, mirroring how the incident arm already owns its incoming `correlates_with`
direction (`graph-populator.ts:759-761`).

That blanket incoming clear is safe only because no other populator emits a `resolves`
edge *into* an `incident`: `syncPrGraph`'s `resolves` edges target `issue` entities
exclusively, via `findIssueEntityIds` (`graph-populator.ts:291-295`). Checked at
`a68945e5`; if a second emitter ever targets incidents, this clear would destroy its
edges and must become endpoint-scoped.

That asymmetry — one edge type self-heals via the generic clear, the other needs an
explicit incoming clear — is the single most error-prone part of this design and is
called out in § 8 as a required red-proven test.

The `person` entity is created with `upsertGraphEntity({ type: "person", externalId:
<person.id>, label: personDisplayName(db, id) ?? email })`, matching `syncPrGraph`
(`graph-populator.ts:266-276`).

### 5.5 Graph population — Sentry error issues

Inside `syncErrorIssueGraph`, after its existing `clearRelationsTouchingEntity` call —
which is exactly where the code comment at `graph-populator.ts:800-803` says this edge
must live:

- read `metadata.assignedTo` (stored raw by Spec A)
- accept only `type === "user"` with a non-empty `email`; a team actor, a bare id, or a
  missing email emits nothing
- resolve → `upsertGraphRelation(person, error_issue, "assigned", now)`

**No connector change, and no re-sync.** `assignedTo` is already in every indexed row.
`nimbus index regraph` backfills attribution for every Sentry issue already in the index.

### 5.6 Backfill

The two connectors are in genuinely different positions, and the brief must not blur
them.

**Sentry:** fully recoverable. `nimbus index regraph` replays existing rows; no network.

**PagerDuty:** not recoverable from stored rows — the assignee data was never fetched.
Recovery requires a re-fetch, wired the way the mechanism intends:

- add `["pagerduty", PAGERDUTY_INCIDENT_META_VERSION]` to `REBODY_REQUIRED_META_VERSION`
  (`ipc/index-rebody-rpc.ts:134`), so `nimbus index rebody --service pagerduty` treats
  rows below `meta_v = 1` as needing recovery
- opt `pagerduty-sync.ts` into `SyncContext.historyFloorMs`, as Spec A did for Sentry

Without that second change the re-walk is silently capped at the connector's own
`initialSyncDepthDays = 30` and `--since` is accepted-then-ignored — the exact
"accepted a flag and quietly narrowed it" failure `index-rebody-rpc.ts:104-108` was
written to prevent.

`nimbus index rebody` and `nimbus index regraph` both already exist. No gap note in this
spec may cite a command that does not.

### 5.7 Readers

Three of the four come alive without new reader code:

| Reader | Change |
| --- | --- |
| `catchup.ts:318` `subIncidentServices` | **None.** Starts returning rows. |
| `expert.ts:396` `subIncidentResolved` | Its gap-note remediation string becomes false and must be rewritten in the same commit. |
| `decision-corroborate.ts:145` | **None.** Already type-scoped defensively. |
| `negotiate.ts` | **New lane** — see below. |

`negotiate` gains a 7th lane, `laneIncidents(db, personId, sinceMs)`, returning:

```ts
type NegotiateIncidents = {
  resolved: number;          // person --resolves--> incident
  assigned: number;          // person --assigned--> incident
  errorIssuesAssigned: number; // person --assigned--> error_issue
  unattributable: number;    // in-window incidents with no attributable actor
  refs: NegotiateEvidenceRef[];
};
```

Windowed on the incident item's `modified_at`, consistent with `laneAuthoredPrs`, and
capped by the same evidence-ref limit (`negotiate.ts:351`). Wiring is the established
pattern: a name in `laneNames`, a `laneTask` in `tasks`, a decode branch, a type in
`_lib/negotiate-types.ts`, a render section in `_lib/render.ts`.

**This settles Spec A's deferred open question** ("does `error_issue` count in the brief
the way `incident` does?"). It does **not**. `errorIssuesAssigned` is counted and
rendered as a separate line from incident work. Spec A chose `error_issue` over
`incident` precisely so that an error group which never paged anyone could not inflate
incident counts; collapsing them in the reader would discard that decision at the last
step.

Note that `negotiate`'s lane is the **only** reader of the Sentry half — nothing else in
the codebase reads `error_issue`. If the Sentry work ships without it, that half has no
observable effect at all.

### 5.8 Honesty contract

- Remove `"incidents resolved"` from `UNAVAILABLE_EVIDENCE` (`negotiate.ts:53-57`).
  `"on-call shifts"` and `"deploys triggered"` **stay** — those are sub-projects D and E
  and remain genuinely unavailable.
- Rewrite `gap-notes.ts:8`'s `incident` remediation ("Tracked as a graph-populator
  follow-up on existing PagerDuty / Sentry connectors") — false once this ships.
- Rewrite the same string where it is duplicated inline at `expert.ts:410`.
- Correct the comment at `gap-notes.ts:70-79`, which describes
  `person -> incident "resolves"` as "a future" edge.
- The new lane must distinguish **four** different zeros, never collapsing them:
  1. no PagerDuty connector at all → `detectMissingConnector(db, "pagerduty")`
  2. connector present, no edges → `detectMissingRelationToEntityType(db, "resolves", "incident")`
  3. incidents measured, nobody attributable → the counted `unattributable` field
  4. subject unresolved / `graph-only` → the existing structural-zero disclosure
     (`negotiate.ts:106-120`)
- The brief must state the **coverage bound**: PagerDuty attribution exists only for
  incidents synced after this shipped, plus whatever `nimbus index rebody --service
  pagerduty` has recovered. Verify the exact recovery window by running the command
  before writing the sentence.

## 6. What this spec does NOT do

- No `acknowledged` / `responded` edge (§ 3.1).
- No Sentry "resolved by" (§ 2).
- No on-call shifts (sub-project D) and no deploy actor (sub-project E).
- No `author_id` writes.
- No migration.
- No changes to `why`, `impact`, `ghost`, or `huddle`. `why.ts:433` also probes
  `resolves`, but scoped to `issue`, and is unaffected.

## 7. Failure behaviour

| Situation | Behaviour |
| --- | --- |
| `include[]` rejected by the API | Request fails → existing `!res.ok` path logs and returns the cursor unchanged; no partial attribution |
| Assignee present, no email | No edge; `unattributed_actors` increments |
| `last_status_change_by` is a `service_reference` | No edge, no lookup spent; not counted as a failure |
| `/users/{id}` lookup cap hit | Remaining actors skipped and counted; sync succeeds |
| Sentry `assignedTo` is a team actor | No edge; counted |
| Person resolves to a brand-new person row | Correct and intended — `resolvePersonForSync` creates it and later syncs merge on email |
| An incident is reassigned upstream | Old `assigned` edge retired by the generic clear; old `resolves` edge retired by the explicit incoming clear (§ 5.4) |

## 8. Testing

Non-negotiable, in addition to ordinary unit coverage:

1. **Red-proven retirement, both edge types.** Re-sync an incident with a *different*
   assignee and a *different* resolver; assert the old edges are **gone**, not merely
   that the new ones exist. Must be shown to fail without the clears — the `assigned`
   and `resolves` clears take different paths (§ 5.4) and a test that only asserts
   presence passes with both clears deleted.
2. **At least one test driven by a recorded real payload**, not a hand-built fixture.
   Two of the three edges depend on payload shapes that could not be verified from
   documentation (§ 4.4), and "fails closed" and "emits zero rows in production while
   every test is green" are the same observable. A fixture written from the same
   assumption as the parser cannot catch a wrong assumption.
3. **Populator-level `regraph` test** proving Sentry attribution is rebuilt from stored
   rows with no network.
4. **A test that the `/users/{id}` fallback cap is enforced** and that exceeding it
   increments the counter rather than silently truncating.
5. **A gap-note test per zero** in § 5.8 — four distinct cases, four distinct notes.
6. Per-file coverage floor ≥85% line / ≥80% branch, Docker-Linux-authoritative.

## 9. Delivery

Two PRs. This spans two connectors and two entity types, and the repeated lesson in this
repo is that cross-connector seams are where the blocking findings hide.

**PR 1 — PagerDuty.** `include[]` fetch, metadata keys, both incident edges, the
explicit `resolves` clear, `historyFloorMs` opt-in, the `REBODY_REQUIRED_META_VERSION`
row, `negotiate`'s new lane, and every § 5.8 honesty change. `catchup` and `expert` come
alive on merge day.

**PR 2 — Sentry.** `syncErrorIssueGraph`'s `assigned` edge and the lane's
`errorIssuesAssigned` field. Populator-only; no connector change.

A whole-branch review across both before PR 2 merges — per-task reviews have repeatedly
missed findings that live in files no individual task touched.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| `last_status_change_by` never resolves in practice → `resolves` edges silently zero, and that edge is the one `negotiate` actually promises | The three-step ladder (§ 5.3) plus the real-payload test (§ 8.2); the counted `unattributable` field makes a zero visible instead of ambiguous |
| Sentry `assignedTo` has no `email` key → the whole Sentry half is inert | Fails closed and counted; PR 2 is populator-only so the cost of being wrong is low. Verify against one real payload before writing PR 2's brief copy |
| Overloading `resolves` across two endpoint shapes corrupts an existing reader | All 10 non-test read sites across 8 files were audited at `a68945e5` (`catchup`, `expert`, `negotiate`, `premortem`, `epic-services` ×2, `why` ×2, `why-peek`, `decision-corroborate`); every one is endpoint-type-scoped or bound to a specific `from_id`. Re-audit if an 11th appears |
| The 30-day recovery bound is stated wrongly in the brief | Run `nimbus index rebody --service pagerduty` and observe the real window before writing the sentence (§ 5.8) |
