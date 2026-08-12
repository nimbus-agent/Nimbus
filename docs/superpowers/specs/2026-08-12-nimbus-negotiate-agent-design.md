# `nimbus negotiate` — Agent Design

**Date:** 2026-08-12
**Spine slot:** S1 (Local Brain)
**Position:** sub-project **F** of the `nimbus negotiate` workstream — the reader, built on the
substrate that now exists. Substrate A/B shipped as #1159 (`fb8a0c7a`).
**Ships as:** one PR. No migration, no new invariant, no new table, no background pass.

---

## 1. What this is, and what it is not

The roadmap (`docs/roadmap.md`, Phase 7 Wave 5) frames `nimbus negotiate` as a
compensation-conversation prep brief drawing on nine evidence sources. **Four of those nine do not
exist**, and the four missing ones are precisely the compensation-specific ones — peer benchmark
ranges, on-call shifts, incidents resolved with attribution, and deploys triggered. See § 6.

**Decision (2026-08-12): this ships as a contribution brief, with a compensation conversation as one
use among several** — self-eval, promo packet, 1:1 prep. The agent does not presume which. Every
claim it makes rests on evidence that exists today, and nothing in the output depends on data the
index cannot supply.

The name stays `negotiate`: the roadmap row, the docs and the CLI reference all use it, and renaming
would abandon a deliberate product bet for a naming preference.

---

## 2. Verified evidence inventory

Checked against `main` at `fb8a0c7a`, not from memory.

**Available.** Relation types actually emitted by `graph/graph-populator.ts` are `authored`,
`belongs_to`, `defined_in`, `depends_on`, `derived_from`, `in_repo`, `mentions`, `merged_as`,
`monitors`, `opened`, `posted`, `resolves`, `reviewed`, `targets`, `upstream_refs`; `owns` is
emitted separately by `ownership/ownership-pass.ts`.

| Evidence | Source |
| --- | --- |
| PRs authored | `person --authored--> pr`, plus PR metadata (state, merged, merged_at, labels) |
| PR size | `additions` / `deletions` / `changed_files` / `commits` in PR metadata — **new in #1159**, present only where the enrichment pass has run |
| PRs reviewed | `person --reviewed--> pr` — **new in #1159** — plus the `review` item's own state and body |
| Tickets opened | `person --opened--> issue` |
| Tickets closed by your work | `pr --resolves--> issue` traversed from an authored PR |
| Code and services owned | `person --owns--> source_file \| directory \| service`, weighted by share |
| Decisions authored | `decision_record.source_item_id → item.author_id` — **derivable, but not an existing join**; nothing in `decisions/` reads `author_id` today |
| Docs, notes, messages authored | `item.author_id`, populated by ~12 connectors |

**Not available.**

- **Commits authored.** `connectors/filesystem-v2-sync.ts:205` writes `git_commit` items with
  `authorId: null`, and `gitLogRecords(root, 40)` caps it at the last 40 commits per root. There is
  no commit-level attribution anywhere. `git_blame_line` carries `author_name` / `author_email`, but
  that measures **surviving lines**, which is a different claim (§ 5).
- **Incidents resolved, attributed.** `pagerduty-sync.ts` writes `authorId: null` and no assignee or
  resolver; `_lib/gap-notes.ts` still describes `person -> incident "resolves"` as a future edge.
- **On-call shifts.** The connector calls `/incidents` only.
- **Deploys triggered.** `deployment/types.ts` `DeploymentAnnotateInput` has no actor field.
- **Peer compensation ranges.** No federated primitive exists, and
  `connectors/workday-field-allowlist.ts` deliberately excludes compensation.
- **Reviews *of* your PRs.** `/users/{login}/events` reports only the authenticated user's own
  activity, so the index holds reviews you gave, never reviews you received.

---

## 3. Architecture

**Request-scoped, read-only, HITL-free**, following `why` / `expert` / `catchup`. No persisted pass
and no new table: the four S1 agents that own a pass (`glossary`, `decisions`, `ownership`,
`pre-mortem`) each need one for LLM extraction or expensive derivation. This agent performs pure
aggregation over rows that already exist, so a table would only denormalise the index and create a
second place for the numbers to drift.

**Subject resolution.** `agents/_lib/self-person.ts` `resolveSelfPerson` (override → git email → OS
username), overridable by `--person <id>`. An unresolved subject produces a
`missing_user_identity` gap note, matching `catchup`.

**Six lanes**, fanned out through `AgentCoordinator`, each an independently testable bounded query:

1. **Authored PRs** — count, merged share, size distribution where stats exist.
2. **Reviewed PRs** — count, and the approve / changes-requested split from the review item's state.
3. **Tickets** — opened directly, and closed via an authored PR's `resolves` edge.
4. **Ownership** — services and directories carried, weighted by blame share.
5. **Decisions** — authored, via the new `source_item_id → author_id` join.
6. **Writing** — docs, notes and messages authored.

**Determinism boundary — load-bearing.** Every number is computed in SQL. `emitBriefWithSynthesis`
is used only for the surrounding narrative, exactly as the other agents use it. **No figure in the
brief originates from the model.** This matters more here than in any other agent, because the
output may be handed to a manager: a number in this brief has to survive being questioned.

**Registration.** IPC `agents.negotiate`; notification `negotiate.briefReady`; CLI
`nimbus negotiate [--since <duration>] [--person <id>] [--json]` honouring `NO_COLOR`; Tauri
`ALLOWED_METHODS` **105 → 106**, including the count assertion at `gateway_bridge.rs:569`.

**No SDK change.** The SDK's `AGENT_NAMES` lists nine agents and has not included `glossary`,
`decisions`, `ownership` or `pre-mortem`; the gateway and CLI reference neither `AgentName` nor
`BriefFor`. Negotiate is added exactly as the last four were.

### 3.1 HTTP exposure — excluded, deliberately

`HTTP_AGENT_NAMES` (`ipc/agents-rpc.ts:812`) is **derived** from `AGENTS_RPC_HANDLERS` so the two
cannot drift. Adding a handler therefore auto-exposes it at `POST /v1/agents/{agent}` unless it is
named in `HTTP_EXCLUDED_AGENT_METHODS`.

`agents.negotiate` **is added to that exclusion set.** The three existing exclusions are there for
side effects (`preflight`, `premortem`) or shape (`whyPeek`), and by that criterion a pure read
would not qualify. The reason here is different and is recorded so a later reader does not "correct"
it: combined with `--person`, HTTP exposure would let any holder of the `agents` token assemble a
contribution dossier on any indexed person without the owner initiating it. CLI and Tauri are both
same-machine and owner-initiated; the local HTTP API is not.

### 3.2 `--person` — in scope, with the tradeoff stated

The brief defaults to the local user and accepts `--person <id>`. This was decided explicitly
(2026-08-12) with the profiling concern raised and weighed: every lane query is person-parameterised,
so the capability is nearly free to build, and a manager writing reviews or a lead preparing
calibration is a real use.

Two bounds keep it honest: the brief **names its subject** in the output rather than silently
retargeting, and it is reachable only from the same machine (§ 3.1). It reads only what is already
locally indexed — it opens no connector and fetches nothing.

### 3.3 Personal documents — off unless configured

The roadmap specifies reading 1:1 notes "with consent — the agent asks before reading 1:1 docs".
**A built-in agent cannot ask**: the shape invariant is HITL-free, and `AgentCoordinator` skips any
HITL-required tool rather than waiting on it. So the roadmap's mechanism is unbuildable as written.

Instead the brief mines work artifacts only. Personal sources are included only when named in a
`[negotiate]` block in `nimbus.toml`, following the `[glossary.terms]` precedent: **configuration is
the consent, expressed once and reviewable**, and the invariant is untouched. The brief states which
sources it drew on.

---

## 4. Error handling

- **A failed lane degrades to a gap note**, never an error, and never a silent zero — the
  `why` six-lane pattern. A brief with five working lanes is still useful; a brief that renders `0`
  for a lane that threw is a lie.
- **An unresolved subject** yields `missing_user_identity` with the `[user] me_person_id`
  remediation, matching `catchup`.
- **An empty index** yields `empty_index` via `detectEmptyIndex` before any lane runs.
- **A `--person` id matching no person row** is reported as such — distinct from "this person has no
  contributions", which is a different and much stronger claim.

---

## 5. Honesty surfaces

The output may be shown to someone with authority over the reader's compensation. Each rule exists
because the alternative reads as a stronger claim than the data supports.

**A. Blame is not commits.** There is no commit attribution (§ 2). The ownership lane reports
*surviving lines you wrote in files you own*, labelled that way — never "commits authored". A line
count is not a productivity measure and the brief does not present it as one.

**B. Stats coverage is conditional.** PR size stats exist only where enrichment has run, so any
aggregate over them carries `over M of K PRs with stats available`, and is silent when coverage is
complete — the `decisions` conditional-note pattern, not a standing disclaimer.

**C. The window is stated.** The brief is recomputed per invocation, so two runs a week apart
legitimately differ. It prints its window and generation time and never reads as a fixed record.

**D. Absent evidence is named once, unconditionally.** Incidents resolved, on-call shifts and
deploys triggered are unavailable. The brief says so plainly — like `ownership`'s standing
accountability note — so silence is never read as zero. This one does not turn off: a reader
inferring "no incidents handled" from an empty section is the failure this agent most needs to
prevent.

**E. The subject is named.** With `--person`, the brief states whose evidence it contains and that it
is built only from locally indexed data.

**F. Sources are listed**, including whether personal documents were configured in.

---

## 6. Relationship to the rest of the workstream

Agreed order was **A/B → C → F → D → E**, so F ships ahead of the on-call (D) and deploy-actor (E)
substrate. Those two are named as gaps (§ 5.D) rather than blocking, and each can later light up a
section without changing this agent's shape.

**C (incident attribution) is not a prerequisite** but is the highest-value follow-up: it would
convert one named gap into a real lane, and it already has two readers returning empty today
(`catchup.ts`'s incident lane, `expert.ts`'s scoped `resolves`/`incident` probe). Its own premise —
whether PagerDuty's `/incidents` response carries assignee and resolver — is **unverified**; the
repo's fixtures are hand-authored and prove nothing. Verify against the live API before planning it.

---

## 7. Testing

- **Per-lane unit tests** against `createMemoryIndexDb`, seeded through the real writers
  (`upsertIndexedItem`, `upsertGraphEntity`) — never hand-rolled `INSERT`s. Fixtures that invent
  their own row shape hid three defects in the pre-mortem work, including a query that returned
  nothing in production while six tests passed.
- **An e2e scenario** asserting brief sections, the `briefReady` notification, and **zero HITL
  fires** (structurally: the agent source imports neither `ToolExecutor` nor `HITL_REQUIRED`).
- **Empty index yields gap notes, not zeros** — one test per lane.
- **The stats-coverage note is silent at full coverage** and present below it.
- **`agents.negotiate` is absent from `HTTP_AGENT_NAMES`** — red-proved by removing the exclusion
  and confirming the test fails. `HTTP_AGENT_NAMES` is derived, so without this test the exclusion
  could be dropped in a refactor and the method would be exposed silently.
- **Gates:** `preflight:fast` per change; the Linux-authoritative coverage floor via the full
  `build-lcov.sh` before pushing — **not** a scoped per-directory istanbul run, which under-reports
  badly; and `typecheck:tests`, reading its "N new" line.

---

## 8. To confirm at plan time

1. The exact `review` item field carrying approve / changes-requested, and whether it is populated on
   every review event or only some — the lane's split depends on it.
2. Whether `decision_record.source_item_id` always resolves to an `item` row with a non-null
   `author_id`, or whether some extraction sources leave it null — this determines whether the
   decisions lane needs its own gap note.
3. Whether `ownership_pass_state` exposes a last-run timestamp the brief can cite, so a stale
   ownership lane can say so rather than silently reporting old shares.
