# `nimbus pre-mortem` — Design

**Status:** approved design, not yet planned or built.
**Slot:** Spine S1 (Local Brain) — the fourth of the implicit-knowledge agents, after `why`,
`glossary` and `decisions`, and alongside `ownership`.
**Depends on:** #1128 (ticket depth for Jira + Linear), merged 2026-08-09. The metadata contract it
shipped — `parent_key`, `status_category`, `issue_type`, `project_id`, `created_at_ms`,
`resolved_at_ms` — is the substrate this agent reads. This is that PR's first consumer.

## Goal

Given an epic, tell the user what historically went wrong with comparable work, grounded in their
own index rather than generic estimates — and leave behind inert watchers for the risks that are
actually watchable.

## What "comparable" means, and what it does not

The cohort is selected by **service overlap**: past epics that touched some of the same services as
the target. It is *not* semantic similarity — the agent does not know that "Billing v2" resembles
"Billing v1" beyond their shared services.

This distinction is the single misreading the agent exists to prevent, so it is stated
unconditionally in every brief (see *Honesty rules*). It is the direct analogue of `ownership`'s
authorship-is-not-accountability note.

## Architecture

The split is by **refresh rate**. Expensive prose work runs in the background over service-scoped
history; the interactive command does only fast SQL and never calls a model.

```text
┌─ BACKGROUND (debounced post-sync, like glossary/decisions) ────────┐
│  premortem/theme-pass.ts                                           │
│    discover  → closed epics + their children's ticket bodies and   │
│                mentioning threads, grouped by service              │
│    extract   → local LLM names recurring blocker themes            │
│                (NO fallback: no model ⇒ no themes, stated in brief)│
│    reconcile → pure-SQL sweep; demote themes whose sources vanish  │
│  writes: premortem_theme, premortem_theme_evidence,                │
│          premortem_pass_state (watermark)                          │
└────────────────────────────────────────────────────────────────────┘
┌─ REQUEST PATH (nimbus pre-mortem <epic>) — no model call ──────────┐
│  agents/premortem.ts — 4 parallel lanes via AgentCoordinator       │
│    1. target      → resolve epic, derive services (children→PRs)   │
│    2. cohort      → past epics by service overlap, ranked, capped  │
│    3. structural  → cycle time, size, review drag, incidents, …    │
│    4. themes      → stored themes matching the cohort's services   │
│  → emitBriefWithSynthesis → premortem.briefReady                   │
└────────────────────────────────────────────────────────────────────┘
```

Why not compute the narrative inline: the interactive latency budget for a built-in agent is 15 s,
and the run that matters is the *first* run on a given epic — a per-request cache would only help
re-runs, which are the rare case. Moving the model call off the request path makes the command fast
by construction rather than by luck. Per-service themes are also the more reusable artifact: the
recurring blockers for `billing-api` serve every epic that touches it.

**Acknowledged duplication.** This makes pre-mortem the fourth persisted-pass subsystem, and the
four passes are structurally near-identical (discover → extract → reconcile + watermark). Extracting
a shared harness is *not* in scope here — refactoring three shipped subsystems mid-feature is a
worse trade than copying the pattern a fourth time. Worth revisiting once this lands.

## Data model — schema V53

Current schema is **V52**; #1128 added no migration, so V53 is the next free version.

| Table | Purpose |
|---|---|
| `premortem_theme` | one recurring blocker theme per `(service, theme)`. Id is **content-derived** = hash(service, normalized theme label), where normalization is lowercase + collapsed whitespace + stripped surrounding punctuation — enough that "Rate limits." and "rate  limits" converge, deliberately not stemming or synonym-folding, which would silently merge distinct blockers |
| `premortem_theme_evidence` | cohort epics/threads attesting a theme; drives the deterministic corroboration count |
| `premortem_pass_state` | single-row **composite** watermark (`watermark_ms` + `watermark_id`) |
| `premortem_watcher_proposal` | every watcher id pre-mortem has ever proposed, so a user-deleted watcher is never re-created (see *Watchers*, rule 3) |

Two decisions inherited deliberately from `decision_record` (V47):

- **The theme id is content-derived, not positional.** Keying on a character offset would mean a
  typo fix earlier in a document re-hashes every later theme, orphaning its accumulated evidence
  rows and re-spending the extraction budget on a theme already mined. (`decision_record` states
  this rule partly to protect its `vetoed` rows; pre-mortem has no veto concept — see
  *IPC and exposure* — so the reason here is evidence continuity and budget, not veto durability.)
- **The watermark is composite.** `watermark_ms` alone cannot express "resume inside a group of
  items sharing one `modified_at`", and a bulk import stamping thousands of rows with a single
  job-level timestamp makes that ordinary. `watermark_id` breaks the tie on `item.id`, a primary key
  and therefore total.

**Confidence is computed from the evidence count, never from the model's self-report** — the rule
`decisions` established and the reason its scoring is deterministic.

**Read bounds on the pass.** `max_llm_calls_per_pass` bounds model calls but not rows read, and
ticket bodies run to 16 KiB since V48, so the discover stage selects only the columns it needs
(`id`, `service`, `title`, `body`, the depth metadata) — never `SELECT *` — and processes candidates
in bounded batches, checkpointing the watermark per batch. A pass that reads a whole epic corpus
into memory at once would be a background job that degrades the interactive gateway, which is the
opposite of why the work was moved off the request path.

## Configuration

A `[premortem]` block mirroring `[decisions]`: `enabled`, `debounce_ms`, `use_llm`,
`max_llm_calls_per_pass`, plus two bounds specific to this agent — `max_cohort_size` (default 10)
and `max_candidate_scan` (default 200, the ceiling on how many closed epics the cohort lane will
derive a service set for before it stops looking). There is deliberately no `retry_cooldown_ms`:
retry needs per-candidate attempt state, which V53 has no column for, and the pass's actual retry
behaviour (a no-model batch is retried on the very next pass, unconditionally) needs no cooldown to
express.

Construction is **gated on `enabled`**, so a disabled pass leaves the refresher unset rather than
idling — the `decisionsRefresher` pattern in `platform/assemble.ts`, not the always-constructed
`glossaryRefresher` one.

## Terms used in this document

- **Indexed window** — the span of time actually represented in the local index for the service in
  question, i.e. from the oldest indexed `resolved_at_ms` to now. It is a property of what has been
  synced, not a configured range, which is precisely why the *history span* honesty rule reports it.
- **Repo median (review drag)** — the median PR open→merge for that repo over the same indexed
  window as the cohort, so the comparison is like-for-like rather than lifetime-vs-window.

## IPC and exposure

| Method | Purpose | Exposure |
|---|---|---|
| `agents.premortem` | run the brief; params `{ epicRef, service? }` | renderer-exposed (Tauri `ALLOWED_METHODS` **104 → 105**, I7) and LAN-readable |
| `premortem.refresh` | trigger the theme pass out of band; no params | **LAN-forbidden**, absent from `ALLOWED_METHODS` |

Notification: `premortem.briefReady { sessionId, brief, findings }`, per the `<agentName>.briefReady`
contract.

`premortem.refresh` takes **no parameters and has no `rebuild` counterpart** — but NOT for the
`ownership.refresh` reason. The pass does not re-derive its tables wholesale each run; it RESUMES
from a persisted `(watermark_ms, watermark_id)` cursor (`premortem_pass_state`), so `refresh` mines
only epics newer than the watermark, the same as `glossary`/`decisions`. The actual reason there is
no `rebuild` verb in PR A is narrower: PR A ships no reader (`agents.premortem` does not exist yet),
so there is nothing yet a reset would visibly fix, and there are no vetoes to recover either. A
reset verb can land with PR B if a real need shows up once a reader exists.

## Request path

**CLI:** `nimbus pre-mortem <epic-ref> [--service <name>] [--json] [--refresh]`

Unknown flags are **hard-rejected**, matching `glossary` / `decisions` / `owners`. `<epic-ref>`
accepts either `PROJ-120` or `jira:PROJ-120`. `--service` is **repeatable** — an epic may span
several services, and a single-valued flag would force the brand-new-epic case into an artificially
narrow cohort. `--refresh` triggers `premortem.refresh` and waits for it before building the brief.
The `USAGE` constant in `packages/cli/src/commands/pre-mortem.ts` is canonical.

### Lane 1 — target resolution

Resolve the epic, then collect its children via `metadata.parent_key = <key>` (#1128). Walk each
child's **incoming** `resolves` edges to its PRs (the graph stores `PR --resolves--> issue`), then
`in_repo` to repo/service.

`--service` overrides the derivation entirely. This flag exists because the roadmap's trigger is
"when a new Epic is created" — and a brand-new epic has no children, therefore no PRs, therefore no
services, therefore no cohort. Nothing in the index carries a Jira component or label today, so the
user supplies the one fact the index cannot. With neither children nor flag, the brief is a single
named gap, never an empty cohort presented as a result.

### Lane 2 — cohort

**CORRECTION (found during PR A implementation): pre-mortem is JIRA-ONLY today.** This paragraph
originally said candidates are `issue_type = 'Epic'` (Jira) *or* a non-null `project_id` (Linear).
The Linear half does not work and cannot, as written: `linear-sync.ts` never writes `issue_type`,
and — the deeper problem — **no `linear:project` items are indexed at all**. #1128 added
`project_id` as a FIELD on Linear *issues*; it did not create project items. So there is no
Linear epic-shaped ROW to discover, and keying on a non-null `project_id` would wrongly treat every
Linear issue in a project as an epic. Supporting Linear needs a connector change (index projects as
items) and is out of scope for PR A. Every brief must say Jira-only until then.

**Narrower still, within Jira: `parent_key` is team-managed-project-only.** `connectors/jira-sync.ts`
populates `metadata.parent_key` only on team-managed Jira projects; classic company-managed projects
express epic membership through a per-instance `customfield_100xx` this connector deliberately does
not chase, so `parent_key` is simply absent there. The discover stage still finds a closed
company-managed epic (it keys on `issue_type`, not `parent_key`), but `epic-services.ts` has no
children to walk and resolves it to zero affected services — so the pass silently yields no theme
for it, not an error.

Candidates are epics — `issue_type = 'Epic'` (Jira only, see the correction above) — with
`status_category ∈ {done, canceled}` and a `resolved_at_ms` inside the indexed window. Each
candidate's service set is derived exactly as the target's was.

**Candidates are scanned in `resolved_at_ms DESC` order**, so `max_candidate_scan` truncates the
*oldest* history rather than an arbitrary slice of it. Without an explicit order the cap would take
whatever SQLite returned first, which is neither recent nor stable.

**Ranking is IDF-weighted overlap, not overlap count.** A raw count makes a monolithic or ubiquitous
service (`api-gateway`, `shared-utils`) match nearly every closed epic, drowning the signal from the
specific service that actually characterises the work. Each service is therefore weighted by
`log(N / epics_touching_service)` over the scanned candidates, and a candidate's score is the sum of
weights of the services it shares with the target. An overlap on a rare service outranks an overlap
on a ubiquitous one.

This is deliberately **derived rather than configured**: a service present in every epic earns a
weight near zero automatically, so no exclusion list is needed. A hand-maintained blacklist would be
one more table to drift out of date — the failure mode the body-depth connector list hit three
times.

**Both bounds are explicit and configurable**, because the per-candidate traversal is otherwise
unbounded: the candidate scan is capped at `max_candidate_scan`, and the resulting cohort at
`max_cohort_size`.

### Lane 3 — structural risks

Five dimensions. Every figure traces to rows the brief can cite.

| Risk | Computation |
|---|---|
| Cycle time | cohort median `resolved_at_ms − created_at_ms`; **framing depends on the target's age** (below) |
| Size overrun | cohort median cycle time split by child-count band, vs the target's child count |
| Review drag | median PR open→merge across cohort children's PRs, vs the repo median over the same indexed window |
| Incident coupling | share of cohort epics with an incident `correlates_with` a deploy in-window |
| Abandonment | share of cohort epics ending `canceled` |

**Cycle time is an expectation on a young epic, a comparison on an old one.** Running pre-mortem
minutes after creating an epic makes elapsed-so-far ≈ 0, and "47d vs 0d" reads as an alarming
overrun when it means nothing at all. Below a threshold (target age < 1 day) the risk is phrased as
an expectation — *"comparable epics took a median 24 days"* — and only above it does it become a
comparison against elapsed time. Since the roadmap's whole trigger is "when a new Epic is created",
the young case is the common one, not the edge case.

**Incident coupling inherits `correlates_with`'s existing semantics, which are looser than they
sound.** `graph/graph-populator.ts` already pairs a deployment with an incident on the **same
affected service** within `CORRELATION_WINDOW_MS` (2 hours), directed deployment→incident. It is
keyed on service and time — **not** on any link between the deploy and a child PR of the epic. So
this risk reads "incidents correlated with deploys of the cohort's services during each epic's
window", and a busy shared service will attract correlations from work unrelated to the epic. The
brief must not imply the epic caused them; this is the sharpest instance of the unconditional
correlation-not-causation note. Do not invent a second correlation rule here — reuse the edge.

**Abandonment is Jira-blind, and the brief says so.** #1128 established that Jira folds "Won't Do"
into `done` — `canceled` is unreachable there by construction, since the distinction lives only in
`fields.resolution`, which the sync does not fetch. The risk is therefore computable for Linear and
structurally absent for Jira, and a **mixed cohort must never present a blended rate as comparable**.
This is the first consumer to feel that asymmetry, and the drift-tripwire test in
`connectors/ticket-depth.test.ts` is what should fail first if it ever changes.

### Lane 4 — themes

Read `premortem_theme` rows whose service matches the cohort's services, with their evidence counts.
No model call on this path.

## Watchers

pre-mortem **creates watcher rows**, and they are created **paused** (`enabled = 0`).

`listEnabledWatchers` filters on `enabled === 1`, so a paused watcher genuinely never fires; no new
mechanism is needed. The brief prints the arming command with the watcher's real UUID.

**Why paused rather than armed.** A fired watcher invokes a `notify(title, body)` callback, and the
ChatOps variant routes to a namespace's notify channels via `ReplyDispatcher.send`. Armed
auto-creation would therefore let a *read* command produce an outbound team post with no further
human step. Invariant `I23` contains **where** such a post can go (server-derived channel, never
caller-supplied), so this was never a hole — but pausing keeps the outbound step behind a human
action while still delivering auto-creation's real benefit: the rows exist, correctly configured,
with nothing to retype.

Only risks with a genuine watchable condition produce a watcher — incident coupling and deploy
failure. Review drag and cycle time produce none, rather than a contrived condition.

**Three rules make re-runs safe:**

1. **Content-derived watcher id** = hash(epic id, risk kind, service). Running `pre-mortem PROJ-120`
   twice creates nothing the second time. Same technique as `decision_record.id`.
2. **Insert-if-absent; never update `enabled`.** If the user armed a watcher yesterday, today's
   re-run must not quietly re-pause it. This is the one place a naive upsert would silently undo a
   deliberate user action.
3. **A deleted watcher stays deleted.** `watcher.delete` exists, so "user deletes a proposal they
   don't want" is a real flow, and rules 1–2 alone would resurrect it on the next run — inert, but
   still the tool overriding an explicit "no". pre-mortem therefore records every watcher id it has
   proposed in a fourth V53 table, `premortem_watcher_proposal`. An id that is **in that table but
   absent from `watcher`** was deleted deliberately and is never re-created; the brief lists it as
   suppressed, with the command to un-suppress.

Rule 3 is the reason the proposal table exists rather than deriving proposals on the fly: without a
record of what was proposed, "absent" and "deleted" are indistinguishable. It is pre-mortem-owned,
so no tombstone semantics leak into the shared `watcher` table that other subsystems read.

## Honesty rules

**Conditional — history span.** This agent's value collapses on a thin corpus. #1128 shipped
`nimbus index rebody --since` to widen the 30-day cold-start floor, but nothing guarantees the user
ran it. Every brief reports the observed span of closed epics for the cohort's services ("6 epics,
oldest closed 2025-11-03") and, when that span is short, points at
`nimbus index rebody --service jira --since <days>`. Counted per brief and silent when history is
deep — `decisions`' pattern, not a standing disclaimer readers learn to skip.

**Conditional — truncated bodies.** Themes are mined from ticket bodies; rows with
`body_complete = 0` are truncated. Reported as the same `N of M source(s)` count `decisions` uses.

**Unconditional — the note that never turns off.** *"Comparable" means these epics touched some of
the same services. It does not mean they were architecturally or organisationally similar, and these
are correlations, not causes.* This one never switches off, for the same reason `ownership`'s does:
getting it wrong is the specific failure the agent exists to prevent.

**Confidence ceiling.** Themes cap below 1.0, with a stated reason: **no connector indexes ticket
comments.** #1128 fetches `summary` / `description` / `status` / dates — not comments — so a blocker
argued out entirely in a Jira comment thread is invisible to the theme pass. Presenting a full-marks
scale the user cannot reach is the anti-pattern `decisions`' 0.86 ceiling exists to avoid.

## Failure modes

Each is a **named gap**, never silence and never a weaker substitute presented as a result.

| Condition | Behaviour |
|---|---|
| Epic ref not found | hard error |
| No children, no `--service` | gap: cannot determine services; pass `--service`, or re-run once PRs land |
| Services known, cohort empty | gap: no past epics touching these services closed in the indexed window |
| Cohort exists, no themes | structural-only brief + note (pass disabled / never run / no local LLM) |
| Mixed Jira+Linear cohort | abandonment risk suppressed, with the Jira-blindness note |

Notably there is **no project-based fallback cohort**. If service overlap yields nothing, the agent
says so rather than silently substituting "other epics in the same project", which would look like
an answer while comparing unrelated work.

## Testing

- **Unit** — each structural calculator as a pure function over fixture rows; cohort selection and
  ranking; theme matching; and the two watcher rules: id determinism across re-runs, and that an
  armed watcher survives a re-run **un-paused**.
- **Pass** — discover / extract / reconcile against a fake LLM, plus the no-model path asserting
  that it writes **zero** themes and leaves the watermark **UNCHANGED** for the affected batch (so
  a later pass, once a model is available, still mines those same epics rather than finding the
  corpus already marked as examined). A separate case covers a model that DID respond with
  empty/unparseable output: that batch's watermark DOES advance, since a persistently bad model
  must not loop the same batch forever.
- **E2E** — `packages/gateway/test/e2e/scenarios/premortem.e2e.test.ts`: brief sections, the
  `premortem.briefReady` notification, and zero HITL fires. The structural HITL check still holds —
  pre-mortem writes through `insertWatcher`, not `ToolExecutor`, so it neither imports the executor
  nor references `HITL_REQUIRED`.
- **Coverage** — `packages/gateway/src/agents/` stays ≥ 80% line; the repo-wide per-file floor is
  ≥ 85% line / ≥ 80% branch.

## Documentation deliverables

These are not optional extras — the repo's triple rule is that wiring, docs and test land together.

- **`.claude/commands/nimbus-agent-patterns.md`** — its Agent Shape Invariant currently states that
  every built-in agent is read-only with no write tools in scope. pre-mortem writes paused watcher
  rows. The invariant is amended **deliberately, in the same commit as the wiring**, rather than
  left as drift for the next author to trip over.
- **`docs/roadmap.md`** — the S1 row and the Phase 7 Wave 5 entry, which currently describe
  pre-mortem as both read-only *and* scheduling watchers. Record what was actually built and why.
- **`docs/cli-reference.md`** — the `nimbus pre-mortem` entry.
- **`docs/CHANGELOG.md`** — a dated delivery entry (the canonical log; not the CLAUDE.md status
  line).
- **`docs/architecture.md`** — the V53 tables and the `agents.premortem` / `premortem.refresh` IPC
  methods.
- **`packages/ui/src-tauri/src/gateway_bridge.rs`** — `ALLOWED_METHODS` 104 → 105 for
  `agents.premortem` only, plus the count assertion in its test (I7). `premortem.refresh` stays out.

## Expected shape of the work

Comparable to `decisions` (#1019: 62 files, ~2,850 src lines) rather than to `ownership`'s read
surface. It is plausible as a single PR, but the natural split — if it wants one — mirrors
`ownership`: **PR A** the V53 migration plus the theme pass and its config wiring, **PR B** the
agent, CLI, IPC and Tauri exposure. Splitting that way keeps each PR's tests coherent and means the
migration lands before anything reads it. The planning step decides.

## Explicitly out of scope

- **Semantic cohort selection.** Service overlap only, by decision.
- **A project-based fallback cohort.** See *Failure modes*.
- **Indexing Jira components/labels.** Would remove the need for `--service` on a brand-new epic,
  but it is a separate connector change and depends on teams populating those fields.
- **Indexing ticket comments.** The stated reason for the confidence ceiling; a much larger change.
- **Armed watchers, and any ChatOps routing.** Paused-only, by decision.
- **Federated cross-team cohorts.** The roadmap mentions composing with the Phase 6 consent-scoped
  federated query for cross-team history. Local-only here.
- **A shared harness for the four extraction passes.** See *Acknowledged duplication*.
- **A deterministic (no-LLM) theme-discovery fallback.** Deferred, with the reasoning recorded
  because it was actively considered. `glossary`'s snippet fallback works only because glossary
  already knows the term and needs its definition; pre-mortem has no candidate theme, since
  discovery *is* the task, so there is nothing to look up. A keyword list (`"blocked"`, `"waiting"`,
  `"rate limit"`…) would be a hand-maintained, English-only table that drifts and, worse, fabricates
  themes from a single mention. A recurring-n-gram pass across the cohort would be a legitimate
  deterministic alternative — language-agnostic and frequency-grounded — but it is a distinct
  discovery algorithm, not a fallback, and belongs in its own change. Until then: **no model, no
  themes**, said plainly in the brief, with the structural risks still fully computed.
