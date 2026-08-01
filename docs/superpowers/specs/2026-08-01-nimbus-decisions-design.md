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
  id                TEXT PRIMARY KEY,        -- stable hash(source_item_id, cue_offset); see below
  source_item_id    TEXT NOT NULL,           -- no FK, deliberately (see below)
  status            TEXT NOT NULL CHECK(status IN ('pending','extracted','vetoed')),
  statement         TEXT,
  rationale         TEXT,
  alternatives      TEXT NOT NULL DEFAULT '[]',
  extraction_source TEXT CHECK(extraction_source IN ('llm','snippet')),
  cue_tier          TEXT NOT NULL CHECK(cue_tier IN ('heading','explicit','weak')),
  cue_text          TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 0,
  decided_at        INTEGER NOT NULL,        -- CONTENT date, not row time
  has_adr           INTEGER NOT NULL DEFAULT 0,
  stats_verified_at INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_status_confidence
  ON decision_record(status, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_decision_pending_attempt
  ON decision_record(status, last_attempt_at);
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

`id` is a BLAKE3 hash of `source_item_id` plus `cue_offset`, where `cue_offset`
is the zero-based character index of the matched cue within the scanned text —
and the scanned text is exactly `title + ". " + body_preview`, the same
concatenation `glossary` mines (`glossary-extract.ts` `snippetsFor`).

This makes re-scanning the same item idempotent: an unchanged item re-mines to
the same ids and upserts rather than duplicating. It also means an edit that
shifts a cue's position produces a new row and orphans the old one — which the
reconciliation sweep demotes, the same way it handles a deleted source.

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

### Phase C — corroboration

Graph traversal from the source item to downstream actions, writing
`decision_evidence` rows:

- `pr` / `commit` — via existing `mentions` and `merged_as` edges, within a
  **90-day forward window** from `decided_at`. Forward-only: a PR that predates
  the thread did not implement its decision. The window is a named constant
  alongside `why`'s `DRIVER_WINDOW_MS`, not a magic number.
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
                 [--min-confidence <0..1>] [--explain] [--json] [--refresh]
```

`--refresh` runs a pass synchronously (`glossary` parity). `NO_COLOR` respected.

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

`--service` scopes by the repository a decision's corroborating PR or commit
touches, resolved through the existing graph (`pr → repository`). It does *not*
mean `service → team` ownership: the ownership graph is a separate, unbuilt S1
item.

A decision with no code evidence is therefore not matched by `--service`, and
the brief says how many were excluded for that reason. When the ownership graph
lands, this resolves through it instead — the flag's meaning narrows toward its
roadmap definition rather than changing.

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
| `--service` unresolvable | "N decision(s) have no linked repository and cannot be service-scoped until the ownership graph lands." |
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
5. `--service <name>` returns only decisions whose corroborating PR or commit
   touches a matching repository, and the brief reports how many decisions were
   excluded for having no code evidence.
6. With no local LLM running, a pass still produces `snippet`-sourced rows, the
   brief labels them, and a later pass with a model available upgrades them to
   `llm`-sourced without manual intervention.
7. The 512-character body cap is stated in every brief.
8. The e2e test proves zero HITL actions fire.
