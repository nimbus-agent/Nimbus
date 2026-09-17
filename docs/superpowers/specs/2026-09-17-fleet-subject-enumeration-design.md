# Fleet subject enumeration (S2 fleets, PR 2b) — design

> **Status:** approved in brainstorming 2026-09-17, pending written-spec review. Branch
> `dev/asafgolombek/fleet-subject-enumeration`. This file and its plan are stripped before the
> implementation PR (specs do not land on `main`); durable content moves to
> `docs/architecture.md` § Spine S2 → fleet.
>
> **Predecessors:** `2026-09-06-s2-overnight-agent-fleets-design.md` (PR 1: `FLEET_ELIGIBILITY`, V60,
> I38) and `2026-09-07-fleet-change-digest-design.md` (PR 2a: the digest, whose § 9 sketched this PR).
> Both are pruned from `HEAD`; read them with `git show d47d52e2:…` and `git show 4c54be81:…`.

## 1. Problem

A `[[fleet.job]]` names exactly one subject in config (`path = "src/auth"`, `service = "checkout"`).
Nothing sweeps a corpus, so the roadmap's motivating use — bus-factor coverage across an org — stays
manual: an owner must write one job per file or service they already suspect.

PR 2b lets a job name an **enumerator** instead of a subject. The fleet then rotates through every
subject the index can list, a bounded slice per run, and the digest reports what moved.

## 2. Settled inputs (from 2a § 9 — not relitigated)

- An enumerator map TOTAL over the eligible agents, the same compiler-enforced shape as
  `FLEET_DIGEST_EXTRACTORS`.
- `subject_key` on `fleet_brief` plus a per-job cursor, in this PR's own migration, backfilled to
  `job_id` (for a config-named job the subject IS the job — true history, not a placeholder).
- A hard per-run cap with no default, refused rather than clamped (the `media allow-remote --limit`
  posture).
- **No enumerator returns person-shaped subjects.** `negotiate` stays `deferred`; its
  `FLEET_ELIGIBILITY` comment is rewritten from "revisit in PR 2" to a settled reason: enumeration
  turns "the owner built one dossier" into "the machine builds a dossier on every indexed person,
  nightly, unattended", which no current consent surface covers.
- Many subjects per run make I38 budget exhaustion the normal case, so the per-brief
  `fleetRemoteWithheld` disclosure (#1462) is load-bearing.

## 3. Decisions taken in brainstorming

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| D1 | Which sweeps ship | paths, services, symbols, terms | — (janitor dropped, § 5.3) |
| D2 | More subjects than the cap | **Rotate with full coverage**: stable order, per-job cursor, next N each run, wrap | directories-only (drops ghost/conflicts); rank by a cheap signal (long tail never covered) |
| D3 | Config shape | **`sweep` key on `[[fleet.job]]`** | a separate `[[fleet.sweep]]` table (duplicates interval/backoff/digest plumbing) |
| D4 | Architecture | **Fan out at execute time inside `FleetScheduler`** | virtual jobs expanded at config load; a separate sweep runner (§ 9) |
| D5 | ghost/conflicts | **`symbols` enumerator** (their real subject) | enumerate file paths (unsound, § 5.2) |
| D6 | janitor | **Not enumerable, reason recorded** | an owner-supplied `subjects = [...]` list |

## 4. Configuration

```toml
[[fleet.job]]
name = "bus-factor"
agent = "ownership"
interval_seconds = 86400
sweep = "paths"            # enumerator kind
max_subjects = 200         # REQUIRED when sweep is set; 1..500
path_prefix = "packages/"  # optional narrowing, kind-specific

[[fleet.job]]
name = "nightly-oncall"
agent = "oncall"
interval_seconds = 86400
sweep = "services"
max_subjects = 50
```

Parsed in `config/fleet-toml.ts`. `sweep`, `max_subjects`, `path_prefix` and `symbol_prefix` join
`JOB_RESERVED`, so they never reach an agent as parameters.

**Refused at load** (`FleetConfigError`, naming the job and the reason — never silently skipped):

1. `sweep` names a kind the agent's enumerator-map entry does not accept (including every
   not-enumerable agent).
2. `sweep` set and the job ALSO sets the parameter that kind supplies (`path`, `service`, `file`,
   `term`) — two sources for one subject.
3. `sweep` set and `max_subjects` absent, non-integer, `< 1`, or `> 500` (refused, not clamped).
4. `max_subjects` or a narrowing key set without `sweep`.
5. A narrowing key belonging to another kind (`path_prefix` on `sweep = "symbols"`).
6. `sweep` with `namespace`/`namespaces` on `ghost`/`conflicts`: those fan out to paired peers, and a
   sweep would multiply federated calls under the owner's identity — the peer-amplification
   concern the ChatOps agent-intent disclosure already names. A sweep stays local.

## 5. The enumerator map

### 5.1 Shape

```ts
type SweepKind = "paths" | "services" | "symbols" | "terms";

type SweepSupport =
  | { readonly kinds: readonly [SweepKind, ...SweepKind[]] }
  | { readonly kinds: readonly []; readonly reason: string };

export const FLEET_SWEEP_SUPPORT = Object.freeze({ … }) satisfies Readonly<
  Record<EligibleAgentMethod, SweepSupport>
>;
```

Flipping an agent to `eligible` fails typecheck until it has an entry. A non-empty `kinds` without a
matching per-`(agent, kind)` parameter binding is also a compile error (the binding table is keyed
by the same union).

Each enumerator is a pure, synchronous, read-only function
`(db, options) => { subjects: SweepSubject[]; emptyReason: string | null }` where
`SweepSubject = { key: string; params: Record<string, string> }`. Sorted with `codeUnitCompare`.

### 5.2 Entries (verified against code on 2026-09-17)

| Kind | Source | Agents → param | Key |
|---|---|---|---|
| `paths` | distinct `(repo_root, file_path)` from `git_blame_line`, plus each file's parent directories, restricted to the git-aware roots `ownershipRoots` resolves | `ownership` → `path` | `paths:<repo_root posix>/<file_path posix>` |
| `services` | configured `[ci.service.<id>]` ids (`parseNimbusCiServiceToml`) | `oncall`, `changelog`, `ownership` → `service` | `services:<id>` |
| `symbols` | `graph_entity` where `type = 'symbol'`; label is `"<name> — <file>"` (unique per symbol, `graph-populator.ts`) | `ghost`, `conflicts` → `file` (the exact label) | `symbols:<label>` |
| `terms` | `glossary_term` where `status = 'consolidated'` | `glossary` → `term` | `terms:<term_key>` |

`ownership` accepts two kinds; the job's `sweep` picks one.

**Why symbols, not paths, for ghost/conflicts.** Their `file` parameter goes through
`agents/_lib/match-token.ts`'s `resolveMatchToken`: an exact `graph_entity` symbol-label match, then
`LIKE '%<basename>%'`. A path sweep would hand every `index.ts` the same fuzzy token and produce
hundreds of briefs about whichever symbol matched first. Passing the full unique label takes the
exact-match arm.

### 5.3 Not enumerable — reasons recorded in the map

| Agent | Reason |
|---|---|
| `why` | needs a line; a file-level sweep is not what the agent answers |
| `expert` | subject is a free-text topic; no corpus of topics exists |
| `impact`, `catchup` | their `service` is a CONNECTOR id (`github`), not a `ServiceConfig` id |
| `decisions` | `--service` is a normalised repo / ticket-key NAME match (`decision-service-scope.ts`), not a `ServiceConfig` id |
| `standup`, `huddle` | no subject parameter |
| `janitor` | `resourceRef` is free text probed by `probeResourceRecency` ("does anything mention this string"); the index holds no resource inventory, so a list would be invented, not enumerated |

## 6. Data model — migration V63

- **`fleet_brief` gains `subject_key TEXT NOT NULL`.** SQLite cannot add a `NOT NULL` column without
  a default, and a default would write a placeholder into history, so V63 REBUILDS the table in the
  migration transaction: create `fleet_brief_v63` with the column, `INSERT … SELECT` with
  `subject_key = job_id`, drop, rename. The rebuilt table keeps
  `run_id … REFERENCES fleet_run(id) ON DELETE CASCADE` (a rebuild is where that silently disappears).
  Indexes recreated; `idx_fleet_brief_job` becomes `(job_id, subject_key, created_at DESC)`.
- **`fleet_job_state` gains** nullable `sweep_kind TEXT`, `sweep_cursor TEXT` (the last PROCESSED
  subject key), `sweep_subjects_total INTEGER` (size at the last enumeration).
- **`fleet_run` gains** `subjects_in_scope`, `subjects_attempted`, `subjects_completed`
  (`INTEGER NOT NULL DEFAULT 0`), keeping the row self-describing: jobs and subjects are different
  units.
- `CURRENT_SCHEMA_VERSION` → 63, pinned by a test (PR 1's first defect was an unbumped version).

**Cursor semantics.** A key, not an ordinal: an ordinal shifts when a file is added or deleted and
silently skips or repeats subjects. Selection is "the first key strictly greater than
`sweep_cursor`, wrapping to the start", taking up to `max_subjects` distinct keys. A null cursor
starts at the first key. A list no longer than `max_subjects` is taken whole, once — never padded
by wrapping onto keys already in the window. If
`sweep_kind` differs from the job's configured kind, the cursor is treated as absent and
overwritten.

**Keys are platform-independent.** Paths use POSIX separators, so the same file yields the same key
on Windows and Linux.

## 7. Scheduler

`execute`'s job loop and `isJobDue` are unchanged. The branch is at the call site: a config-named
job → `runOneJob` (unchanged); a sweep job → `runSweepJob(job, runId, expiresAt, tally)`.

`runSweepJob`:

1. Enumerate. A throw → `recordJobFailure` (existing backoff), subjects counted as 0.
2. Empty list → `recordJobSuccess`, persist `sweep_subjects_total = 0`, carry `emptyReason` to the
   status surface. An accurately empty sweep is not a failure and must not back off.
3. Select the window from the cursor (§ 6). `tally.subjectsInScope += window.length`.
4. For each subject: `stillAdmitted` before EVERY subject except the run's very first unit of work
   (the existing exemption, now counted in subjects); on refusal `runSweepJob` returns a `yielded`
   signal WITHOUT recording job success, and `execute` then returns `close("yielded")` exactly as it
   does between jobs — so the job is still due on the next tick and resumes from the cursor.
   `--force` skips the check as today.
5. Invoke through the existing `deps.invoke` with `{ ...job.params, ...subject.params }`.
6. On `done`: `recordBrief({ …, subjectKey })`. On failure: count it, record nothing.
7. Advance `sweep_cursor` to the subject's key after EACH subject, success or failure, so one broken
   subject cannot pin the rotation.
8. Window finished: ≥ 1 success → `recordJobSuccess`; zero successes → `recordJobFailure` (backoff).

Subject counters live in the SAME `tally` record `close()` reads, so every exit (`deferred`,
`yielded`, `failed`, thrown, `completed`) reports consistent numbers by construction.

**Unchanged:** the I38 budget is `reset()` once per run and consumed across all subjects; the
`inFlight` single-flight guard serialises runs, so a `nimbus fleet run` during a long sweep waits;
`nimbus fleet run <job>` runs that job's NEXT window from the cursor. No `--subject` flag.

## 8. Digest, CLI, IPC

### 8.1 Digest

Config-named jobs render byte-identically to today (a golden test on 2a's fixtures). The pairing
query becomes `briefPairForSubject({ jobId, subjectKey, … })` with 2a's rule unchanged (newest in
window vs. newest before it, falling back to oldest-in-window by id); the union becomes
`(job_id, subject_key)` pairs. A config-named job is a job with one subject — one code path.

Sweep jobs render ONE section:

- A coverage line: `swept <n> of <total> subjects this window · full rotation ≈ <k> runs ≈ <d> days ·
  retention <r> days`, plus — when `d > r` — the explicit bound: "a rotation longer than retention
  means a subject's predecessor expires before it is revisited, so this sweep cannot report
  movement."
- Moved subjects in full (existing extractors, `digest_min_delta` per subject).
- Unchanged subjects as a count.
- `first observation` as a count plus the first 10 keys and `… and N more`.
- `not summarizable` and `agent changed` listed individually.
- `no brief in window` computed at JOB level only for sweeps; per subject it is expected under
  rotation and would present design as failure.
- All five outcomes still present per job, each as an explicit zero when empty.

Ordering: jobs then subjects, `codeUnitCompare`. The digest still makes no model call (outside I38
by construction).

### 8.2 CLI / IPC (extend existing `fleet.*` only — no new methods)

- `nimbus fleet list`: sweep jobs show `sweep=<kind> max=<n>`.
- `nimbus fleet status`: per sweep job — subjects at last enumeration, cursor progress in the current
  rotation, estimated rotation length vs. retention, `emptyReason`.
- `nimbus fleet briefs` / `show`: a `subject` field; `briefs --subject <key>` filters.
- `--json` shapes are additive. `fleet.*` stays LAN-forbidden and absent from the Tauri allowlist.

## 9. Rejected architectures

- **Virtual jobs at config load** (`bus-factor#src/auth.ts` per subject). Config stops being the SSoT
  for what a job is, `fleet_job_state` rows multiply into the thousands, subject churn needs
  reconciliation, and each subject gets its own interval — which makes "rotate through all" a
  non-concept.
- **A separate sweep runner beside the scheduler.** Duplicates admission, the I38 budget reset, run
  accounting and single-flight — two components doing one job is how PR 1's budget defect happened
  (the invoker spent against a different instance than the row read).

## 10. Stated bounds

- **Rotation vs. retention** (§ 8.1): cannot be refused at load because the subject total is unknown
  until enumeration; disclosed on the run surface and the digest instead.
- **Coverage is eventual, not prioritised.** A risky file waits its turn in a rotation (D2).
- **`paths` covers git-aware roots only** — the substrate `git_blame_line` holds.
- **`services` covers configured services only**, not services a connector merely mentions.
- **Subject churn between runs**: a subject deleted mid-rotation simply stops appearing; its old
  briefs age out under retention. A renamed file is a new subject.
- No new invariant, no static rule, no new egress class, no HITL action type. D28 and I38 unchanged.

## 11. Testing

Every test below targets a specific silent failure; key tests are red-proven by reverting the fix.

- **Migration:** V63 on the migrated template; backfill `subject_key = job_id`; new index present;
  `CURRENT_SCHEMA_VERSION = 63`; deleting a `fleet_run` cascades to its briefs AFTER the rebuild.
- **Map totality:** compiler (`satisfies`), plus a test deriving the expected key set from
  `FLEET_ELIGIBILITY` at runtime — never a hand-written list with its own length assertion.
- **Enumerators against the real schema**, rows written by production writers (blame pass,
  `upsertGraphEntity`, glossary store, `parseNimbusCiServiceToml`). For each emitted subject, run the
  AGENT'S OWN resolver: `resolveOwnershipPath` resolves the path; `resolveMatchToken` returns that
  exact entity; `normalizeTerm` round-trips the term key.
- **Cursor:** additions and removals between runs neither skip nor repeat; wrap; kind change resets;
  Windows and POSIX produce equal keys.
- **Scheduler** (fake `HostActivity` + invoker): yield mid-sweep then resume from cursor; failed
  subject advances; all-fail → backoff; empty → success with reason; I38 budget reset once with
  spend accumulating across subjects; subject counters correct on every exit path.
- **Config refusals:** each of § 4's six.
- **Digest:** grouping; unchanged count; first-observation truncation at 10; job-level-only
  `no brief in window` for sweeps; config-named golden output unchanged; deterministic bytes.
- **Routing:** `fleet.briefs` with `subject` through the real dispatcher, not only the
  sub-dispatcher.

## 12. Docs

`docs/architecture.md` § Spine S2 → fleet (design record incl. § 9 and the § 5.2/5.3 findings);
`docs/roadmap.md` fleet row at every restatement of "PR 2b NOT shipped" plus § 10's bounds;
`docs/cli-reference.md` (keys, flags); `docs/CHANGELOG.md`; the status paragraph in `CLAUDE.md` and
`GEMINI.md`; the `negotiate` comment in `FLEET_ELIGIBILITY`. Grep the I38 row for any "per job"
wording sweeps would falsify.

## 13. Delivery

One implementation PR (2a § 1: enumeration without digest grouping is strictly worse than today),
as a commit series. Pre-PR: `bun run preflight:fast`, scoped fleet/index/config tests,
`bun run typecheck:tests`. Spec and plan stripped before the PR opens.
