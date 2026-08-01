# `nimbus decisions` — implicit ADR extractor

**Date:** 2026-08-01
**Slot:** Spine S1 (Local Brain) — third of the implicit-knowledge triad
**Roadmap:** [Phase 7 Wave 5](../../roadmap.md#wave-5--implicit-knowledge-surfaces)
**Status:** design approved, not yet implemented

## Summary

`nimbus decisions` recovers decisions buried in Slack, Notion, Confluence, Linear
and Jira threads — statements of the form "we decided X because Y, alternatives
were Z" — corroborates them against downstream actions in the relationship
graph, and returns a chronological list with a confidence score and evidence
links.

It is the third member of a triad whose first two members already ship:
`nimbus why` (2026-07-24) and `nimbus glossary` (2026-07-30). It reuses
`glossary`'s architecture rather than inventing a third pattern.

No new connectors. No new security invariant. One migration (**V47**).

## Motivation

The decisions a team actually operates by are rarely written down as ADRs. They
are settled in a thread, implemented in a PR, and then forgotten — so six months
later nobody can say why the service talks to Postgres instead of MySQL, and the
reasoning has to be reconstructed from scratch or, worse, re-litigated.

The data is already in the local index. What is missing is a queryable shape.
That is the same leverage `glossary` exploits, and it is why this needs no new
connector.

A cloud agent structurally cannot do this: the threads are private, and the
corroborating PRs and migrations are in a graph that never leaves the machine.

## Architecture

Two phases, following `glossary` exactly.

```
connector sync ──▶ decisionRefresher.trigger()   (debounced, platform/assemble.ts)
                        │
   Phase A discover ────┤  Pure SQL + regex. Commits `pending` rows and advances
                        │  the watermark BEFORE any model call.
                        │
   Phase B extract  ────┤  Local LLM, capped per pass. Veto → 'vetoed'.
                        │  Structure → 'extracted' + statement/rationale/alternatives.
                        │
   Phase C corroborate ─┘  Graph joins → decision_evidence; sets has_adr;
                           computes confidence deterministically.

nimbus decisions ──▶ agents.decisions ──▶ 3 parallel lanes, pure SELECT ──▶ brief
                     (no model call on the read path)
```

The read path never calls a model. Extraction cost is amortised into the pass,
so `nimbus decisions --since 1y` is a `SELECT`, not a fan-out.

### Why the watermark advances in Phase A

Candidates are durable `pending` rows the moment Phase A returns. An interrupted
Phase B therefore costs at most one in-flight call rather than a full re-scan.
This is `glossary`'s ordering and the reason for it is identical.

## Components

New subsystem at `packages/gateway/src/decisions/`, mirroring `glossary/`:

| File | Responsibility |
| --- | --- |
| `decision-types.ts` | `DecisionRecord`, `DecisionEvidence`, status union |
| `decision-source-types.ts` | `DECISION_SOURCE_TYPES` + service-qualified `decisionSourceFilter()` |
| `cue-mining.ts` | Deterministic cue-phrase detection → candidates + cue tier |
| `decision-store.ts` | CRUD over the three V47 tables |
| `decision-extract.ts` | The pass: discover → extract → corroborate |
| `decision-llm-adapter.ts` | Prompt construction + response parsing |
| `decision-confidence.ts` | The deterministic composite scorer |
| `decision-corroborate.ts` | Graph traversal to PR / commit / migration / IaC / ADR evidence |
| `decision-refresh.ts` | Debounced post-sync refresher |

Elsewhere:

- `packages/gateway/src/agents/decisions.ts` — the read-only agent
- `packages/gateway/src/agents/_lib/decisions-types.ts` — `DecisionsBrief` / `DecisionsInput`
- `packages/gateway/src/index/decisions-v47-sql.ts` — the migration
- `packages/gateway/src/config/nimbus-toml-decisions.ts` — `[decisions]` parsing
- `packages/cli/src/commands/decisions.ts` — the CLI command
- `packages/cli/src/lib/parse-duration.ts` — extended with `d` and `w` units
- `packages/gateway/src/ipc/agents-rpc.ts` — the `agents.decisions` method

## Schema (V47)

```sql
CREATE TABLE IF NOT EXISTS decision_record (
  id                TEXT PRIMARY KEY,        -- hash(source_item_id, normalized cue sentence)
  source_item_id    TEXT NOT NULL,           -- no FK, deliberately (see below)
  status            TEXT NOT NULL CHECK(status IN ('pending','extracted','vetoed')),
  statement         TEXT,
  rationale         TEXT,
  alternatives      TEXT NOT NULL DEFAULT '[]',
  extraction_source TEXT CHECK(extraction_source IN ('llm','snippet')),
  cue_tier          TEXT NOT NULL CHECK(cue_tier IN ('heading','explicit','weak')),
  cue_text          TEXT NOT NULL,
  priority          REAL NOT NULL DEFAULT 0,  -- extraction order, known pre-LLM
  confidence        REAL NOT NULL DEFAULT 0,  -- final score, known post-LLM
  decided_at        INTEGER NOT NULL,        -- CONTENT date, not row time
  has_adr           INTEGER NOT NULL DEFAULT 0,
  stats_verified_at INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_status_confidence
  ON decision_record(status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_decision_pending_priority
  ON decision_record(status, priority DESC, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_decision_decided_at
  ON decision_record(status, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_verified
  ON decision_record(status, stats_verified_at);

CREATE TABLE IF NOT EXISTS decision_evidence (
  decision_id  TEXT NOT NULL REFERENCES decision_record(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK(kind IN ('source','pr','commit','migration','iac','adr')),
  entity_id    TEXT,
  item_id      TEXT,
  label        TEXT NOT NULL,
  url          TEXT,
  occurred_at  INTEGER,
  PRIMARY KEY (decision_id, kind, label)
);

CREATE INDEX IF NOT EXISTS idx_decision_evidence_decision
  ON decision_evidence(decision_id);

CREATE TABLE IF NOT EXISTS decision_pass_state (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  watermark_ms  INTEGER NOT NULL DEFAULT 0,
  watermark_id  TEXT    NOT NULL DEFAULT '',
  last_pass_at  INTEGER,
  last_pass_new INTEGER NOT NULL DEFAULT 0,
  scanned_items INTEGER NOT NULL DEFAULT 0
);
```

### Row identity

`id` is a BLAKE3 hash of `source_item_id` plus the **normalized cue sentence** —
the sentence containing the matched cue, lowercased, whitespace-collapsed and
stripped of trailing punctuation, reusing `glossary`'s `normalizeTerm`
normalisation. The scanned text is exactly `title + ". " + body_preview`, the
same concatenation `glossary` mines (`glossary-extract.ts` `snippetsFor`).

**Identity is content-derived, never positional.** An earlier draft keyed on the
character offset of the cue, which was wrong in a way that defeated the feature's
own guarantees: fixing a typo in the first paragraph of an RFC shifts every
subsequent offset, so every cue in the document re-hashes to a new id. That
would re-queue candidates already extracted — burning the 25-call budget on
unchanged text — and, far worse, would resurrect `vetoed` rows under new ids and
re-ask the model about candidates it had already rejected. The durability of
`vetoed` is the entire justification for this table having no foreign key, so
positional identity would have quietly dismantled it.

Hashing the sentence means an edit *outside* the sentence changes nothing, and an
edit *inside* it produces a new row — correct, because the decision text itself
changed. Two identical normalized sentences within one item collapse to one row
deliberately: they are the same decision stated twice, not two decisions.

### Three schema decisions worth stating

**No foreign key on `source_item_id`.** `glossary_term` rows deliberately
survive an index reset, and decisions need that property more: `status='vetoed'`
rows are the durable record of model calls already spent. A cascade would delete
them on any re-index and re-burn the entire extraction budget on candidates
already rejected. Instead, the reconciliation sweep demotes decisions whose
source item is gone. `decision_evidence` *does* cascade — it is derived data,
cheap to recompute, and worthless without its parent.

**Composite watermark** (`watermark_ms` + `watermark_id`). `watermark_ms` alone
cannot express "resume inside a group of items sharing one `modified_at`". A
bulk import stamping thousands of rows with one job-level timestamp is ordinary,
and a batch truncated inside such a group would advance past it and skip the
remainder permanently. `item.id` is a primary key and therefore breaks the tie
totally.

**`attempts` / `last_attempt_at` backoff.** The extraction queue is ordered by
score. Some failures are permanent — a candidate the local model cannot parse
into a statement fails every time. Without backoff those high-scoring permanent
failures are re-selected every pass and no lower-scoring candidate ever
extracts. This is starvation by construction, not a rare race.

## Extraction

### Phase A — cue mining (deterministic)

High recall, low precision by design; Phase B supplies precision. Cues are
tiered, and the tier feeds the confidence score:

| Tier | Examples |
| --- | --- |
| `heading` | `Decision:`, `## Decision`, `Outcome:`, `RFC accepted` |
| `explicit` | "we decided", "we agreed to", "we've settled on", "the decision was" |
| `weak` | "we'll use", "going with", "instead of", "let's go with" |

Source scope is service-qualified, matching `glossarySourceFilter()`:

```
slack:message · discord:message · teams:message
notion:page · confluence:page · obsidian:obsidian_note
linear:issue · jira:issue · github:issue · gitlab:issue
```

Filtering on the bare `type` half would silently widen scope — `message`,
`page` and `issue` are generic names shared across services, so `type IN (...)`
also admits `wiz:issue` today and any user-installed extension emitting
`message` tomorrow. Email and calendar are deliberately absent, matching
`glossary`: mining a personal inbox into a team artifact is not a posture to
adopt silently.

### Phase B — LLM as veto and structurer

One call per candidate, asking a single question: is this a decision, and if so
what are the statement, the rationale and the alternatives?

- **Not a decision** → `status='vetoed'`. Never re-asked. This is what keeps
  "we decided to grab lunch" out of the brief, and it is the same mechanism
  `glossary` uses for rejected terms.
- **A decision** → `status='extracted'` with `statement`, `rationale`,
  `alternatives[]`, `extraction_source='llm'`.

Capped at `max_llm_calls_per_pass` (default 25), matching `glossary`.

#### Queue order

Extraction is ordered by `priority`, **not** by `confidence` — confidence cannot
exist yet, because two of its four terms (`corroboration`, `completeness`) are
only knowable after extraction. Ordering the queue by a column that is still 0
for every pending row would have made the order arbitrary, and a burst of `weak`
cues would then saturate the 25-call budget while `heading` cues waited.

`priority` is computed in Phase A from the two terms that *are* known without a
model, on the same scale they carry in the final score:

```
priority = 0.25 * cue_strength + 0.20 * source_authority
```

so a `Decision:` heading on a Confluence page sorts above "going with" in a chat
message. Ties break by `decided_at DESC` — fresh decisions first. The
`attempts` / `last_attempt_at` backoff still applies on top, so a permanently
unparseable high-priority candidate yields its slot rather than blocking the
queue forever.

Storing `priority` rather than recomputing it in the `ORDER BY` keeps the query
indexable (`idx_decision_pending_priority`) and makes the ordering directly
assertable in tests.

#### Upgrading snippet-sourced rows

A `snippet` row is already past the watermark, so the delta scan will never
revisit it — "upgraded on a later pass" needs an explicit mechanism, not an
assumption.

Each pass therefore **reserves** slots from its budget for upgrades, selecting
`status='extracted' AND extraction_source='snippet'` oldest-`last_attempt_at`
first. This mirrors `glossary`'s `UPGRADE_RESERVE = 5`
(`glossary-extract.ts:127`) and copies its reasoning: a reserve, not leftover
capacity. Spending only what new candidates leave behind means a busy index —
exactly the case where the snippet backlog grows — upgrades nothing, ever.
Pending candidates still take precedence within the pass; the reserve only
guarantees the upgrade queue is never starved to zero.

### Phase C — corroboration

Graph traversal from the source item to downstream actions, writing
`decision_evidence` rows:

- `pr` / `commit` — via existing `mentions` and `merged_as` edges, within an
  **asymmetric window: `decided_at - 14d` to `decided_at + 90d`**. Named
  constants alongside `why`'s `DRIVER_WINDOW_MS`, not magic numbers.

  The backward half is not slack, it is the common case. Teams routinely ship
  first and formalise after — a retro, a post-mortem write-up, a wiki page
  updated the week following the merge. A forward-only window would treat every
  one of those as an uncorroborated decision and dock it 0.35 confidence, which
  is precisely backwards: the write-up-after-the-fact decision is *better*
  evidenced than average, not worse.

  The cost, stated plainly: a thread that references a recent PR as
  contrast ("unlike #380, this time we'll…") can corroborate against it and gain
  confidence it has not earned. That is bounded by the 14-day reach and by the
  requirement that a real `mentions`/`merged_as` edge exist — corroboration is
  never purely temporal — and it is a much smaller error than silently dropping
  every post-hoc decision.
- `migration` — a corroborating commit touching a path segment `migrations/` or
  matching `V<n>__` / `V<n>-` (Flyway and this repo's own `V<n>` convention)
- `iac` — a corroborating commit touching `*.tf`, `*.tfvars`, `Pulumi.yaml`, or
  a path segment `cloudformation/`
- `adr` — an indexed `obsidian:obsidian_note`, `notion:page` or
  `confluence:page` whose title both matches `/\bADR\b|^\d+[-.]|decision/i` and
  shares at least half its significant tokens with the decision statement, using
  the same normalisation `glossary`'s `normalizeTerm` applies. Absence sets
  `has_adr = 0`.

Corroboration is temporal and referential, never causal, and the brief says so
rather than implying the PR was caused by the thread.

## Confidence

Computed in code from observable signals. Reproducible across passes and
testable with fixtures — which a model's self-reported number is not, and small
local models are badly calibrated besides.

```
confidence = clamp(0..1,
    0.25 * cue_strength
  + 0.35 * corroboration
  + 0.20 * source_authority
  + 0.20 * completeness )
```

| Term | Basis |
| --- | --- |
| `cue_strength` | `heading` 1.0 · `explicit` 0.6 · `weak` 0.25 |
| `corroboration` | PR or commit 0.6 · plus migration or IaC 1.0 · none 0.0 |
| `source_authority` | ADR / page 1.0 · ticket 0.6 · chat 0.3 |
| `completeness` | rationale present 0.5 + alternatives named 0.5 |

`--explain` prints exactly these four lines per decision, with the matched
`cue_text` — which is why `cue_text` and `cue_tier` are stored rather than
recomputed.

## The agent

`packages/gateway/src/agents/decisions.ts`. Read-only, HITL-free, emits
`decisions.briefReady`, three parallel lanes via `AgentCoordinator`:

1. **Listing** — `SELECT` filtered by `--since` / `--service` / `--min-confidence`
2. **Stats** — counts by status plus pass state, for the gap notes
3. **ADR coverage** — count of `extracted` decisions with `has_adr = 0`

Three lanes, not six: `glossary` uses two, and the read is pure SQL, so a wider
fan-out would add coordinator overhead without adding parallelism.

## CLI

```
nimbus decisions [--since <duration>] [--service <name>]
                 [--min-confidence <0..1>] [--explain] [--json]
                 [--refresh] [--rebuild]
```

`--refresh` runs a pass synchronously (`glossary` parity). `NO_COLOR` respected.

`--rebuild` clears the store — including `vetoed` rows — resets the watermark
and re-mines from scratch, mirroring `rebuildGlossary`
(`glossary-extract.ts:495`). This is the escape hatch for the case `vetoed`
durability otherwise creates: a veto is a judgement made by whatever local model
was running at the time, and without a reset path an early or misconfigured
model would poison the store permanently, with no way back short of deleting the
database. Reusing `glossary`'s rebuild verb rather than inventing a narrower
`--reset-vetoed` keeps one recovery concept across both agents.

*Deferred, deliberately:* stamping each row with the model and prompt version so
drift could be detected and re-extraction triggered automatically. It is the
right long-term answer, it belongs to both agents rather than this one, and
`--rebuild` covers the case manually in the meantime.

`--since` uses the shared `parseDurationToMs`
(`packages/cli/src/lib/parse-duration.ts`), which today accepts only
`ms|s|m|h`. Decision horizons are measured in months, so this slice **extends
that helper with `d` and `w`**. The change is purely additive — input that was
previously an error becomes valid, so the existing `connector` and `share`
callers are unaffected — and it ships with its own unit tests in
`parse-duration.test.ts`. `--since` defaults to `90d` when omitted.

```
## Decisions · 90d · 7 found

0.78  Move billing to Postgres                        2026-05-14
      ⚠ no ADR found
      rationale     connection-pool exhaustion under sustained load
      alternatives  stay on MySQL · shard by tenant
      evidence      notion:page "Billing RFC" · PR #412 · migration V12

0.41  Adopt trunk-based development                   2026-04-02
      rationale     release branches kept drifting
      alternatives  (none named)
      evidence      slack:message #eng-process
```

### `--service` in this slice

`--service` matches on **either** of two routes, and `--explain` labels which
one fired:

1. **`repo`** — the repository a corroborating PR or commit touches, via the
   existing graph (`pr → repository`).
2. **`ticket-key`** — the project/team key of the source item, when the source
   is a ticket: `metadata.key` on Jira items and `metadata.identifier` on Linear
   items both carry `BILL-123`, whose prefix is the project key.

Route 2 exists because route 1 alone silently drops process decisions. "Adopt
trunk-based development" has no PR and never will, so a repo-only filter would
exclude exactly the class of decision that is hardest to recover by other
means — and the sample brief in this spec contains such a row, which a repo-only
`--service` would have contradicted.

Matching is on normalized tokens, not substrings, so `--service bill` does not
match `billing`. This keeps the flag predictable rather than fuzzy.

**Not buildable in this slice, and why.** The natural third route — matching a
Slack channel name, Notion database or Confluence space — cannot be built today,
because those connectors persist only opaque identifiers: `slack-sync.ts` stores
`metadata.channel` as the channel *ID* (`state.ids`, never the name),
`notion-sync.ts` stores `{ notionPageId }` and `confluence-sync.ts` stores
`{ confluencePageId }`. Nothing human-readable is in the index to match against.
Adding it means changing what those connectors persist and re-syncing — a
connector-side slice, not an agent-side one. Until then a decision living only
in `#billing-alerts` is reachable by `--since` but not by `--service`, and the
brief says so.

None of this is `service → team` ownership: the ownership graph is a separate,
unbuilt S1 item. When it lands it becomes the primary route and these two become
fallbacks — the flag's meaning narrows toward its roadmap definition rather than
changing.

## Configuration

`[decisions]` in `nimbus.toml`, mirroring `[glossary]`:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Run the pass at all |
| `use_llm` | `true` | Phase B; `false` forces snippet mode |
| `min_confidence` | `0.3` | Display floor for the brief |
| `max_llm_calls_per_pass` | `25` | Extraction budget per pass |

## Degradation

Every failure is a named gap note in the brief, never silence.

| State | Behaviour |
| --- | --- |
| No LLM available | Snippet mode: the matched sentence becomes `statement`, `extraction_source='snippet'`, no alternatives, `completeness` scores 0. Re-queued and upgraded automatically on a later pass once a local model is running. `glossary` parity. |
| Pass never ran | "Run `nimbus decisions --refresh`, or wait for the next connector sync." |
| LLM call failed | Row stays `pending`, `attempts++`, backoff applies. Never head-of-line blocks. |
| Empty index | Reported **only** when also returning nothing — the brief must never claim an empty index while displaying rows. |
| `--service` unresolvable | "N decision(s) match neither a repository nor a ticket project key. Decisions recorded only in a chat channel or wiki page cannot be service-scoped until those connectors index a human-readable channel/space name." |
| 512-char body cap | Permanent standing note (see Known Limits). |

## Known limits

**Item bodies are indexed to 512 characters.** `upsertIndexedItem` applies
`clipPreview` (`packages/gateway/src/index/item-store.ts:38`) on every write,
universally, and there is no fuller copy anywhere: the embedding pipeline chunks
`itemTextForEmbedding(title + body_preview)`
(`packages/gateway/src/embedding/chunker.ts:162`), so `embedding_chunk.chunk_text`
derives from the same clipped text.

This caps recall more than it caps `glossary`. A term recurs, so it appears
early in *some* item; a decision is stated once, and "we're going with Postgres
because the connection pool keeps exhausting" often lands past character 512 of
an RFC or deep in a thread. Those are structurally invisible to this pass.

The cap is reported in every brief rather than absorbed silently. Widening it is
its own slice — it needs an item-store migration, storage growth across ~90
connectors and a re-embed, and it shares a root cause with web-clipper issue
**#1005**. When it lands, this pass picks the new material up on its next
re-scan with no rework here.

## Out of scope

- **ADR drafting.** The roadmap's "offers to draft one" composes with the Wave 4
  ADR auto-drafter, which does not exist. Drafting is a write; adding it would
  need a HITL action type in the `I2` frozen set and would break the read-only
  agent shape invariant. This slice detects and reports `has_adr = 0`; the
  auto-drafter consumes that signal for free when it lands.
- **`service → team` resolution.** Belongs to the ownership-graph slice.
- **Widening the 512-char body cap.** Its own slice, per Known Limits.
- **Indexing human-readable channel / space names** so `--service` can match a
  Slack channel or Notion database. Requires changing what `slack-sync`,
  `notion-sync` and `confluence-sync` persist, plus a re-sync — connector-side
  work, not agent-side.
- **Model/prompt versioning on extracted rows** for automatic drift detection.
  Belongs to `glossary` and `decisions` jointly; `--rebuild` covers it manually.

## Security posture

No new invariant. The agent performs no `connectors.dispatch`, adds no HTTP
write route, declares no HITL action type, and reads no vault key.

The one invariant touched is **I7**: `agents.decisions` joins the Tauri
`ALLOWED_METHODS` list, 102 → 103. The `assert_eq!(ALLOWED_METHODS.len(), 102)`
count assertion at `packages/ui/src-tauri/src/gateway_bridge.rs:519` is updated
in the same commit.

Because the agent never dispatches, it appends nothing to the `egress_ledger`
(`I29`/`D22`), which is correct: nothing leaves the machine.

## Testing

**Unit**

- `cue-mining` fixtures including explicit negatives ("we decided to grab
  lunch", "I decided to skip standup") — a cue miner tested only on positives
  proves nothing about precision
- `decision-confidence` table-driven across all four terms and the clamp
- `decision-store` CRUD, including that a `vetoed` row is never re-selected
- **Identity stability:** editing text *before* a cue leaves its id unchanged;
  editing the cue sentence itself produces a new id; the same normalized
  sentence twice in one item yields one row
- **Queue order:** a pool of `weak` candidates does not starve a `heading`
  candidate out of the budget; ties break by `decided_at DESC`
- **Upgrade reserve:** with the budget saturated by new pending candidates,
  at least one `snippet` row is still upgraded
- `decisionSourceFilter()` rejects `wiz:issue` and admits `jira:issue`
- `parseDurationToMs` accepts `d` and `w`, still rejects `90x`, and every
  pre-existing `ms|s|m|h` case still returns the same value

**Integration**

- A full pass over a seeded in-memory DB with an **injected fake LLM**.
  Dependency injection, not `mock.module` — the latter leaks process-globally
  and is a known CI-Linux-only failure mode in this repo.
- Interrupted-pass resume: truncate Phase B mid-batch, assert the watermark did
  not skip candidates and no duplicate rows appear.

**E2E** — `packages/gateway/test/e2e/scenarios/decisions.e2e.test.ts`

- Brief contains the expected sections
- `decisions.briefReady` fires with non-empty `brief` and `findings`
- Zero HITL: a source-scanning assert that `agents/decisions.ts` imports no
  `ToolExecutor` and references no `HITL_REQUIRED`

**Coverage** — `agents/` stays ≥80%; the new `decisions/` directory must clear
the ≥80%/file coverage-floor ratchet, which is Docker-Linux-authoritative.

## Acceptance criteria

1. `nimbus decisions --since 90d` returns a chronological list of decisions from
   the local index with no live API call, each carrying a confidence score,
   rationale, alternatives and at least one evidence link.
2. A seeded thread stating "we decided to move billing to Postgres because the
   connection pool kept exhausting; we considered sharding" produces one
   `extracted` row whose `statement`, `rationale` and `alternatives` are all
   populated, corroborated by the seeded PR and migration.
3. A seeded thread stating "we decided to grab lunch at noon" produces a
   `vetoed` row and does not appear in the brief; a second pass does not re-ask
   the model about it.
4. `--explain` prints the four confidence terms with the matched cue text.
5. `--service <name>` returns decisions matched by either route — corroborating
   repository, or source ticket project key — `--explain` labels which route
   fired, and the brief reports how many decisions matched neither.
6. With no local LLM running, a pass still produces `snippet`-sourced rows, the
   brief labels them, and a later pass with a model available upgrades them to
   `llm`-sourced without manual intervention — including when new pending
   candidates would otherwise consume the whole budget.
7. The 512-character body cap is stated in every brief.
8. The e2e test proves zero HITL actions fire.
9. Editing an item's text *before* a decision's cue does not change that
   decision's id, does not re-spend an LLM call on it, and does not resurrect
   any `vetoed` row in the same item.
10. A decision thread posted a week *after* the PR that implemented it is still
    corroborated by that PR.
11. A pool of `weak` candidates does not prevent a `heading` candidate from
    being extracted in the same pass.
12. `--rebuild` clears `vetoed` rows and re-mines; a candidate vetoed before the
    rebuild is re-evaluated after it.
