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

Parsed in `config/fleet-toml.ts`. `sweep`, `max_subjects` and `path_prefix` join `JOB_RESERVED`, so
they never reach an agent as parameters. `path_prefix` is the ONE narrowing key (§ 5.2 defines its
match for each kind that accepts it).

**Refused at load** (`FleetConfigError`, naming the job and the reason — never silently skipped).
Rules 3–5 are syntactic and live in the parser (`config/fleet-toml.ts`). Rules 1, 2 and 6 need the
agent map, which `config/` must not import, so they run in `fleet/fleet-sweep-support.ts`'s
`validateFleetSweepJobs`, called by `assembleFleetRuntime` inside the SAME try that parses — so a
refusal disables the fleet with the same loud log a parse error gets:

1. `sweep` names a kind the agent's enumerator-map entry does not accept (including every
   not-enumerable agent).
2. `sweep` set and the job ALSO sets the parameter that kind supplies (`path`, `service`, `file`,
   `term`) — two sources for one subject.
3. `sweep` set and `max_subjects` absent, non-integer, `< 1`, or `> 500` (refused, not clamped).
4. `max_subjects` or a narrowing key set without `sweep`.
5. `path_prefix` on a kind that does not accept it (`services`, `terms`), or an EMPTY `path_prefix`
   (every path starts with `""`, so it would silently mean "no narrowing"; whitespace is kept
   verbatim rather than trimmed, since a path may legally contain spaces).
6. `sweep` with `namespace`/`namespaces` on `ghost`/`conflicts`: those fan out to paired peers, and a
   sweep would multiply federated calls under the owner's identity — the peer-amplification
   concern the ChatOps agent-intent disclosure already names. A sweep stays local.

## 5. The enumerator map

### 5.1 Shape

```ts
type SweepKind = "paths" | "services" | "symbols" | "terms";

type SweepSubjectParam = "path" | "service" | "file" | "term";

// One interface, not a union: indexing a union of record shapes by `SweepKind` needs an assertion to
// read, and the exclusivity below is pinned by a runtime test over every entry instead.
interface SweepSupport {
  readonly accepts: Readonly<Partial<Record<SweepKind, SweepSubjectParam>>>;
  readonly reason: string | null;
}

export const FLEET_SWEEP_SUPPORT = Object.freeze({ … }) satisfies Readonly<
  Record<EligibleAgentMethod, SweepSupport>
>;
```

Flipping an agent to `eligible` fails typecheck until it has an entry. The kind → parameter binding
IS the entry (`accepts: { paths: "path", services: "service" }`), so a kind cannot be accepted
without naming the parameter it fills. The two arms are exclusive at runtime — a test pins that every
entry has either a non-empty `accepts` with `reason: null`, or an empty `accepts` with a non-empty
reason.

Each enumerator is a pure, synchronous, read-only function
`(db, options) => { subjects: SweepSubject[]; emptyReason: string | null }` where
`SweepSubject = { key: string; params: Record<string, string> }`. Sorted with `codeUnitCompare`.

### 5.2 Entries (verified against code on 2026-09-17)

| Kind | Source | Agents → param | Key |
|---|---|---|---|
| `paths` | the ownership pass's OWN nodes: `graph_entity` rows of type `source_file` (external id `file:<root>:<rel>`) and `directory` (`dir:<root>:<rel>`), restricted to the roots `ownershipRoots` currently resolves | `ownership` → `path` = `path.join(root, rel)` (absolute, OS-native; `rel = ""` → the root itself) | `paths:<external_id>` |
| `services` | the keys of `loadNimbusServiceConfigsFromConfigDir(configDir)` — `[ci.service.<id>]` ∪ `[metrics.dora.<id>]`, the SAME loader `ipc/agents-rpc.ts` resolves a `service` against | `oncall`, `changelog`, `ownership` → `service` | `services:<id>` |
| `symbols` | DISTINCT `graph_entity.label` where `type = 'symbol'`; label is `"<name> — <file>"`, `<file>` repo-relative (`graph-populator.ts` `syncCodeSymbolGraph`, fed by `filesystem-v2-sync.ts`) | `ghost`, `conflicts` → `file` (the exact label) | `symbols:<label>` |
| `terms` | `glossary_term` where `status = 'consolidated'` | `glossary` → `term` = `display_term` (the agent normalises its input, and `term_key` is `normalizeTerm(display_term)`) | `terms:<term_key>` |

`ownership` accepts two kinds; the job's `sweep` picks one.

**`paths` enumerates ownership nodes, not blame rows.** Deriving files from `git_blame_line` and
synthesising every parent directory would emit directories the ownership pass never wrote a node
for — each one a brief whose only content is `ownership.ts`'s "resolved to a configured root but has
no ownership node" gap. The pass's own `source_file`/`directory` entities are exactly what the agent
can answer, are distinct by construction (no parent-directory dedup step exists to get wrong), and
carry root and relative path in the external id. Passing the ABSOLUTE `path.join(root, rel)` lets
`resolveOwnershipPath` resolve against exactly one root even when two roots contain the same
relative path; the root node (`rel = ""`) reaches its `matchRootItself` arm.

**`path_prefix`** is a case-sensitive, plain-string prefix on the repo-relative POSIX path: `rel` for
`paths`, `<file>` (the label's suffix after ` — `, equivalently the `file` the symbol writer
recorded) for `symbols`. Refused on `services` and `terms` (§ 4 rule 5).

**Why symbols, not paths, for ghost/conflicts.** Their `file` parameter goes through
`agents/_lib/match-token.ts`'s `resolveMatchToken`: an exact `graph_entity` symbol-label match, then
`LIKE '%<basename>%'`. A path sweep would hand every `index.ts` the same fuzzy token and produce
hundreds of briefs about whichever symbol matched first. Passing the full label takes the
exact-match arm. **Labels are not unique per symbol**, correcting an earlier draft: the symbol's
external id includes its kind and root (`sym:<root>:<file>:<name>:<kind>`) but the label does not, so
a function and a type of the same name in the same file — or the same file in two roots — share one
label. The enumerator takes DISTINCT labels, so each collision is ONE subject, and the agent resolves
it to one of the colliding entities (`LIMIT 1`). Stated as a bound in § 10, not fixed here: changing
what the agent's `file` parameter can express is an agent change, not an enumeration one.

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
  Indexes recreated; `idx_fleet_brief_job` becomes `(job_id, subject_key, created_at DESC)`, and
  `idx_fleet_brief_subject (subject_key, created_at DESC)` is added so `nimbus fleet briefs
  --subject <key>` without `--job` — a legitimate cross-job question, since two jobs can sweep the
  same subject — is not a table scan.
- **`fleet_job_state` gains** nullable `sweep_kind TEXT`, `sweep_cursor TEXT` (the last PROCESSED
  subject key), `sweep_subjects_total INTEGER` (size at the last enumeration),
  `sweep_empty_reason TEXT` (the enumerator's reason when the last enumeration was empty, else NULL).
- **`fleet_run` gains** `subjects_in_scope`, `subjects_attempted`, `subjects_completed`
  (`INTEGER NOT NULL DEFAULT 0`), keeping the row self-describing: jobs and subjects are different
  units. **A config-named job counts as ONE subject** in all three, so
  `subjects_completed / subjects_attempted` means the same thing on every run whatever mix of job
  kinds it carried. `FleetRunSummary` gains the same three fields.
- `CURRENT_SCHEMA_VERSION` → 63, pinned by a test (PR 1's first defect was an unbumped version).

**Cursor semantics.** A key, not an ordinal: an ordinal shifts when a file is added or deleted and
silently skips or repeats subjects. Selection is "the first key strictly greater than
`sweep_cursor`, wrapping to the start", taking up to `max_subjects` distinct keys. A null cursor
starts at the first key. A list no longer than `max_subjects` is taken whole, once — never padded
by wrapping onto keys already in the window. If
`sweep_kind` differs from the job's configured kind, the cursor is treated as absent and
overwritten.

**Keys are machine-local and derived verbatim from their substrate** — correcting an earlier draft
that claimed a file yields the same key on Windows and Linux. A `nimbus.db` is never shared across
operating systems, so cross-platform key equality protects nothing; what must hold is that a key is
STABLE across runs on one machine. `paths` keys reuse the ownership pass's external id unchanged
(root as configured, relative path as git reports it); normalising here — e.g. lower-casing a
Windows drive letter — would make the key disagree with the node it names, and the pass already
relies on those ids being stable. `symbols` keys reuse the label, whose file part is repo-relative.

**Store methods.** Sweep state is written only by two new `FleetStore` methods —
`recordSweepEnumeration(jobId, kind, total)` and `advanceSweepCursor(jobId, kind, key)` — never by
`recordJobSuccess`/`recordJobFailure`. Those two already use `ON CONFLICT(job_id) DO UPDATE SET`
with an explicit column list, which leaves unlisted columns untouched, so they cannot clobber the
cursor today; a regression test pins that, because the next edit to either statement is where it
would break.

## 7. Scheduler

`execute`'s job loop and `isJobDue` are unchanged. The branch is at the call site: a config-named
job → `runOneJob` (unchanged); a sweep job → `runSweepJob(job, runId, expiresAt, tally)`.

`runSweepJob`:

1. Enumerate. A throw → `recordJobFailure` (existing backoff), subjects counted as 0.
2. Empty list → `recordJobSuccess`, persist `sweep_subjects_total = 0` and `sweep_empty_reason`,
   which `fleet.list` reports. An accurately empty sweep is not a failure and must not back off.
3. Select the window from the cursor (§ 6). `tally.subjectsInScope += window.length`.
4. For each subject: `stillAdmitted` before EVERY subject except the run's very first unit of work.
   The exemption keys on `tally.subjectsAttempted` — ONE counter across config-named jobs (one unit
   each) and sweep subjects — so admission is re-checked at every unit boundary regardless of job
   kind; on refusal `runSweepJob` returns a `yielded`
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
- `first observation` as a count plus the first 10 keys in `codeUnitCompare` order and
  `… and N more`. The truncation is Markdown-only; JSON carries every key.
- `not summarizable` and `agent changed` listed individually.
- `no brief in window` computed at JOB level only for sweeps; per subject it is expected under
  rotation and would present design as failure.
- All five outcomes still present per job, each as an explicit zero when empty.

Ordering: jobs then subjects, `codeUnitCompare`. The digest still makes no model call (outside I38
by construction).

**JSON shape.** Config-named jobs stay in `jobs: FleetJobDigest[]` with `notCompared` unchanged, so
every per-job object is byte-identical; the top-level result gains one key, `sweeps` (an empty array
when no job sweeps), so the WHOLE response is additive rather than identical. Sweep jobs go in that
new sibling array rather than widening `FleetJobDigest` — whose non-optional predecessor fields are
2a's deliberate "no holes" guarantee, which a sweep-level record cannot honour:

```ts
export type FleetSweepSubjectDigest = FleetJobDigest & { readonly subjectKey: string };

export interface FleetDigestSubjectRef {
  readonly subjectKey: string;
  readonly briefId: string;
  readonly reason: string;
}

export interface FleetSweepDigest {
  readonly jobId: string;
  readonly agentMethod: string;
  /** From config; for an unconfigured sweep, the key prefix — null only if that prefix is not a kind. */
  readonly sweepKind: SweepKind | null;
  readonly configured: boolean;
  /** At the last enumeration; null when the job has never enumerated. */
  readonly subjectsTotal: number | null;
  readonly subjectsSweptInWindow: number;
  /** ceil(total / max_subjects); null when total or max is unknown (e.g. unconfigured). */
  readonly rotationRunsEstimate: number | null;
  /** rotationRunsEstimate × interval; null under the same condition. */
  readonly rotationMsEstimate: number | null;
  readonly retentionMs: number;
  readonly rotationExceedsRetention: boolean;
  readonly moved: readonly FleetSweepSubjectDigest[];
  readonly unchangedCount: number;
  /** Unchanged ONLY because digest_min_delta withheld a metric — 2a § 6.3, not folded into unchanged. */
  readonly unchangedWithinThresholdCount: number;
  readonly firstObservationKeys: readonly string[]; // ALL keys, sorted
  readonly notSummarizable: readonly FleetDigestSubjectRef[];
  readonly agentChanged: readonly FleetDigestSubjectRef[];
  readonly noBriefInWindow: boolean; // job-level
}
// FleetDigestResult gains: readonly sweeps: readonly FleetSweepDigest[];
```

`FleetJobDigest` itself is NOT widened. A job is treated as a sweep when its config sets `sweep`, or —
for a job no longer in config — when any live brief in the window carries a `subject_key` other than
its `job_id`; its kind is then read from the key's prefix.

### 8.2 CLI / IPC (extend existing `fleet.*` only — no new methods)

- `nimbus fleet list` / `fleet.list`: each entry gains `sweep: null | { kind, maxSubjects, pathPrefix,
  subjectsTotal, cursor, emptyReason, rotationExceedsRetention }` — the last is § 10's run-surface
  disclosure (null before the first enumeration), printed as a WARNING in human output. Human output adds `sweep=<kind> max=<n> total=<t>` and the
  empty reason when present. Sweep progress lives HERE, not on `fleet.status`: `handleStatus` is
  documented as never touching the store, and `fleet.list` already reads `fleet_job_state`.
- `nimbus fleet briefs` / `fleet.briefs`: rows gain `subjectKey`; `--subject <key>` (RPC
  `subjectKey`) filters. `nimbus fleet show` prints the markdown body unchanged (pipeable);
  `subjectKey` is in `--json`.
- No new IPC method, so no routing change: `fleet.briefs`/`fleet.list` are already routed, and the
  new params are tested at `dispatchFleetRpc`.
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
- **`paths` covers what the ownership pass emitted** — git-aware roots only, and only the files and
  directories it wrote a node for (excluded files have none).
- **`symbols` collapses label collisions.** A same-named function and type in one file, or one file
  under two roots, is ONE subject; the agent briefs whichever entity its exact-label lookup returns.
- **`services` covers configured services only**, not services a connector merely mentions.
- **Subject churn between runs**: a subject deleted mid-rotation simply stops appearing; its old
  briefs age out under retention. A renamed file is a new subject.
- No new invariant, no static rule, no new egress class, no HITL action type. D28 and I38 unchanged.

## 11. Testing

Every test below targets a specific silent failure; key tests are red-proven by reverting the fix.

- **Migration:** V63 on the migrated template; backfill `subject_key = job_id`; both new indexes present;
  `CURRENT_SCHEMA_VERSION = 63`; deleting a `fleet_run` cascades to its briefs AFTER the rebuild.
- **Map totality:** compiler (`satisfies`), plus a test deriving the expected key set from
  `FLEET_ELIGIBILITY` at runtime — never a hand-written list with its own length assertion.
- **Enumerators against the real schema**, rows written by production writers (the ownership pass
  for `source_file`/`directory` nodes, `syncCodeSymbolGraph` for symbols, the glossary store,
  `loadNimbusServiceConfigsFromConfigDir`). For each emitted subject, run the
  AGENT'S OWN resolver: `resolveOwnershipPath` resolves the path; `resolveMatchToken` returns that
  exact entity; `normalizeTerm` round-trips the term key.
- **Cursor:** additions and removals between runs neither skip nor repeat; wrap; kind change resets;
  a key is identical across two enumerations of an unchanged index; `recordJobSuccess` and
  `recordJobFailure` leave `sweep_cursor`/`sweep_kind`/`sweep_subjects_total` untouched.
- **`paths` resolution:** two roots containing the same relative path each resolve to their OWN
  root via the absolute `path` param; the root node resolves through `matchRootItself`.
- **`symbols` collision:** two entities sharing a label enumerate as one subject.
- **Scheduler** (fake `HostActivity` + invoker): yield mid-sweep then resume from cursor; failed
  subject advances; all-fail → backoff; empty → success with reason; I38 budget reset once with
  spend accumulating across subjects; subject counters correct on every exit path.
- **Config refusals:** each of § 4's six.
- **Digest:** grouping; unchanged count; first-observation truncation at 10; job-level-only
  `no brief in window` for sweeps; config-named golden output unchanged; deterministic bytes.
- **RPC:** `fleet.briefs` with `subjectKey` and `fleet.list` sweep entries through `dispatchFleetRpc`;
  no new method exists, so there is no new routing entry to prove.

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
