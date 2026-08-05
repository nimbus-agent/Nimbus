---
name: nimbus-implicit-knowledge-extraction
description: >
  The two implicit-knowledge extraction pipelines behind `nimbus glossary` and
  `nimbus decisions` (Spine S1 "Local Brain") — `packages/gateway/src/glossary/` and
  `packages/gateway/src/decisions/`. Covers the shared four-stage pass shape
  (discover → score/prioritize → LLM consolidate/extract → reconcile), the
  `<service>:<type>` source-type SSoTs, the V45/V46 `glossary_term` +
  `glossary_pass_state` and V47 `decision_record` + `decision_evidence` +
  `decision_pass_state` tables, the single-flight debounced post-connector-sync seam
  in `platform/assemble.ts`, the `ERR_*_PASS_RUNNING` contract, the local-LLM
  adapters and their snippet fallback, and the honesty rules the briefs enforce
  (confidence ceiling 0.86, per-brief truncation counts, veto durability). Use when
  touching either directory, adding a source item type to a pass, changing scoring /
  confidence / corroboration, wiring a new extraction stage, or asking why a term or
  decision is missing, `pending` forever, or keeps failing with
  `ERR_DECISIONS_PASS_RUNNING`. Pairs with `nimbus-agent-patterns` (the read path)
  and `nimbus-db-migrations` (the tables).
---

# Implicit-Knowledge Extraction — Glossary & Decisions

Two subsystems, one shape. `glossary/` mines **terminology** the team uses but never wrote
down; `decisions/` mines **decisions** ("we decided X because Y, alternatives were Z") the
team made but never turned into an ADR. Both read only content already in the local index,
both materialize a table the agent reads, and both are read-only from the user's point of
view — no HITL, no `connectors.dispatch`, zero `egress_ledger` rows.

**This skill covers the write half.** The read half — brief shape, gap notes, CLI output — is
`nimbus-agent-patterns`, which scopes itself to `packages/gateway/src/agents/`. Nothing in
`glossary/` or `decisions/` lives there.

---

## The one rule

> **The agent reads a materialized table. It never mines, and it never calls a model.**

`agents/glossary.ts` and `agents/decisions.ts` are pure SQLite reads over `glossary_term` /
`decision_record`. All mining happens in a background pass. If you find yourself wanting to
extract something on the read path because "the table is empty", the answer is a gap note
naming why (no pass has run yet / candidates still pending / everything fell below the
frequency floor), not an inline model call. An empty brief that explains itself is the
product; a slow brief that silently invokes a model is not.

---

## The four-stage pass

Both pipelines run the same stages. The names differ; the shape does not.

| Stage | glossary | decisions |
|---|---|---|
| 1. Discover | `term-mining.ts` — 5 deterministic surface-form families (acronyms, backticked tokens, PascalCase, hyphenated compounds, capitalized phrases), `stopwords.ts` filtered, `term-normalize.ts` keyed | `cue-mining.ts` — cue sentences tiered `heading` / `explicit` / `weak` |
| 2. Rank | `term-scoring.ts` — `log1p(doc_freq) * 1.6^(service_spread-1) * formBoost`; `min_doc_freq` (default 3) is a hard floor | `decision-confidence.ts` `priority` — cue strength + source authority **only** |
| 3. Model | `glossary-consolidate.ts` + `glossary-llm-adapter.ts` — consolidate or **veto** each candidate | `decision-extract.ts` + `decision-llm-adapter.ts` — extract statement / rationale / alternatives |
| 4. Reconcile | `glossary-reconcile.ts` — round-robin re-verify + demote | `decision-corroborate.ts` — link PRs / commits / ADRs, then score `confidence` |

**`priority` and `confidence` are two different numbers on purpose** (V47's own comment says
so). `priority` is knowable *before* the model runs and orders the extraction queue;
`confidence` needs corroboration and completeness, so it is `0` for every `pending` row and
must **never** be used to order that queue. Same trap on the glossary side: `score` orders
the consolidation batch, and it is not a quality claim about the definition.

### Stage 4 is not optional garnish

The incremental scan can never revisit a term whose sources were deleted — deletion bumps no
`modified_at`, and an edit removing the last mention leaves no item to re-discover from. The
FTS index is correct throughout; only the trigger to re-read it is missing. That is the whole
reason `glossary-reconcile.ts` exists, and why `stats_verified_at` drives a round-robin sweep
rather than a full re-scan. Decisions has the analogous demote-on-missing-source sweep.

---

## Source types — a service-qualified SSoT, never a bare `type`

`glossary/glossary-source-types.ts` `GLOSSARY_SOURCE_TYPES` and
`decisions/decision-source-types.ts` `DECISION_SOURCE_TYPES` are `ReadonlySet<string>` of
**`service:type`** keys, and the SQL filter matches `(i.service || ':' || i.type)`.

**Filtering on the bare `type` half silently widens scope.** `message`, `page` and `issue` are
generic names shared across services — `type IN ('issue', …)` also admits `wiz:issue` (cloud
security posture findings) today, and any user-installed extension emitting `message`
tomorrow. Add the qualified key or nothing.

Two standing decisions, both deliberate:

- **Email and calendar are absent from both sets.** Mining a personal inbox into a *team*
  artifact is not a posture to adopt silently. This is a product decision, not an oversight —
  do not "fix" it as part of an unrelated change.
- **A dead allowlist row fails safe.** `github:commit` / `gitlab:commit` are listed in
  `GLOSSARY_SOURCE_TYPES` because the roadmap names commit messages as a source, but no
  connector writes `item.type = 'commit'` today, so they match nothing until one lands. That
  is the safe direction; the opposite (a bare-type filter that matches early) is not.

---

## The tables

| Table | Migration | Role |
|---|---|---|
| `glossary_term` | V45, rebuilt by **V46** | The SSoT. `status IN ('pending','consolidated','vetoed')`, `definition_source IN ('llm','snippet','manual')` |
| `glossary_pass_state` | V45 | Single-row (`CHECK(id = 1)`) watermark: `(watermark_ms, watermark_id)` |
| `decision_record` | V47 | `status IN ('pending','extracted','vetoed')`; `id` is **content-derived** — `hash(source_item_id, normalized cue sentence)` |
| `decision_evidence` | V47 | `kind IN ('source','pr','commit','migration','iac','adr')`, cascades from `decision_record` |
| `decision_pass_state` | V47 | Single-row watermark, same shape as glossary's |

Four schema decisions you must not undo:

1. **The watermark cursor is `(modified_at, id)`, not `modified_at` alone.** A batch truncated
   inside a group of rows sharing one `modified_at` must resume, not skip the rest.
2. **`decision_record.id` is content-derived, deliberately not positional.** Keying on a cue's
   character offset would mean a typo fix earlier in a document re-hashes every later cue —
   re-queueing extracted rows *and resurrecting `vetoed` ones under new ids*.
3. **`decision_record.source_item_id` carries no foreign key, on purpose.** `vetoed` rows are
   the durable record of model calls already spent; cascading them away on an index reset
   would re-burn the extraction budget on candidates already rejected. `decision_evidence`
   *does* cascade — it is derived, cheap to recompute, and meaningless without its parent.
4. **`first_seen_at` / `last_seen_at` / `decided_at` are CONTENT dates**, taken from the source
   item's `modified_at`. Never a row timestamp. A pass re-running must not move them.

V46 was a **full-table rebuild** of `glossary_term` (build `glossary_term_v46`, populate, swap)
because SQLite cannot alter a `CHECK` in place and V45 had already shipped in `v1.13.0`.
Columns are copied by name, not position. See `nimbus-db-migrations`.

---

## The trigger seam — debounced, single-flight, shared

Both refreshers are constructed in `platform/assemble.ts` and fired from one place:

```typescript
onConnectorSyncSuccess: (serviceId, result, durationMs) => {
  …
  glossaryRefresher.trigger();
  decisionsRefresher?.trigger();
},
```

Note the `?.` — the asymmetry is real and load-bearing:

| | `glossaryRefresher` | `decisionsRefresher` |
|---|---|---|
| Construction | **Always** constructed, gates internally on `[glossary].enabled` | Constructed **only** when `[decisions].enabled` |
| Disabled surface | `ERR_GLOSSARY_DISABLED` from the RPC | Method simply not found — there is no `ERR_DECISIONS_DISABLED` to throw |
| `run()` options | `{ rebuild, onProgress }` | `{ rebuild }` — **no `onProgress`** |
| Progress notification | `glossary.passProgress` carries real progress | `decisions.passProgress` has nothing to relay |
| "Already running" | Checked **synchronously** via `refresher.status()` before `registry.start()` — caller never gets a jobId | Enforced **inside** the async `run()` — caller gets `{ jobId }`, then an immediate `decisions.passError` |

**Debounce is coalescing, not queueing.** A trigger arriving while a pass is running sets a
DIRTY flag; exactly one follow-up pass runs afterwards, no matter how many syncs landed
meanwhile. Defaults: glossary `debounce_ms = 60000`, decisions `debounce_ms = 30000`.

The on-demand path (`glossary.refresh` / `decisions.refresh` and their `rebuild` twins) shares
the *same* single-flight guard as the scheduled path — a scheduled pass and an on-demand pass
must never run concurrently, since both write the watermark and both spend local-model time.

---

## The LLM adapters and the snippet fallback

Both passes call a **local** model (Ollama / llama.cpp) when `use_llm` is true (default) and
one is available. `use_llm` is separable from `enabled` on purpose: turning it off keeps the
cheap deterministic pass while sparing a laptop up to `max_new_terms_per_pass` /
`max_llm_calls_per_pass` (25 each by default) **sequential** model calls per sync burst.

**Glossary degrades honestly, and the degradation is reversible.** With no model, a term gets
a `definition_source = 'snippet'` definition — the verbatim sentence containing the term.
Attributable, not synthesized. A later pass automatically re-consolidates it once a model
appears, using a *reserved share* of that pass's budget so a backlog of new terms cannot
starve upgrades indefinitely.

**Enabling the LLM can therefore remove terms the user has already seen.** Snippet mode has no
veto path, so a model-less glossary accumulates terms nothing ever judged; the upgrade puts
them in front of a real model for the first time and a vetoed term leaves the glossary. That
is correct behaviour and it is surfaced (up to `VETOED_TERMS_REPORTED` names plus a remainder
count, on **stderr** so `--json` stdout stays JSON-only) — do not silence it.

**Neither pass can be cancelled mid-model-call.** `run()` awaits the local model one candidate
at a time and the LLM layer carries no abort signal, so a hung model leaves the pass marked
running for the life of the gateway process and every later on-demand pass is refused with
`ERR_*_PASS_RUNNING`. A restart clears it and no work is lost — extraction resumes from the
persisted watermark. This is documented in `decision-llm-adapter.ts` rather than papered over;
if you fix it, fix it in the LLM layer, not with a timeout race around a sync call.

---

## Two honesty rules that are requirements, not polish

1. **Never present a full-marks scale the user cannot reach.** `decision_evidence.kind` admits
   `migration` and `iac` for forward-compatibility, but nothing emits them — both need
   changed-file paths no connector indexes. With `corroboration` weighted `0.35` and the
   artifact arm unreachable, the confidence **ceiling is 0.86, not 1.0**, and the brief says
   so. If you add a connector that supplies changed-file paths, the ceiling moves and the
   brief's statement must move with it.
2. **State the recall limit in the brief, not just the docs.** `decisions` reports a per-brief
   truncated-source count keyed on `body_complete = 0` ("N of M source(s) … indexed with a
   truncated body") and stays **silent when nothing is truncated** — a standing disclaimer is
   one readers learn to ignore. Body depth is `nimbus-index-body-depth`'s domain; the count
   must be derived from the same source filter the mining path uses, never hand-listed.

Related asymmetry worth knowing: `decision-corroborate.ts` uses a deliberately **asymmetric**
window — 14 days backward, 90 days forward — because teams routinely ship first and formalise
after. A forward-only window would dock every post-hoc retro 0.35 confidence, exactly
backwards. Corroboration is never purely temporal: a real `mentions` / `merged_as` graph edge
must also exist.

---

## Manual authoring (glossary only)

`[glossary.terms]` / `[glossary.synonyms]` in `nimbus.toml` upsert a human-written definition
with `definition_source = 'manual'`. It wins on collision, sorts first, and is exempt from the
sweep's demotion and veto — **but not** from its statistics refresh. Removing the config entry
**demotes** rather than deletes. `display_term` preserves the exact key the user wrote, so
`node.js` and `CDR` print verbatim even though the internal `term_key` normalizes differently
(`term-normalize.ts` casefolds and de-pluralizes; `"kubernetes"` → `"kubernete"` is a known,
documented limitation of the shared normalizer, exempted only for dotted identifiers).

Decisions has no manual-authoring equivalent. Do not add one by analogy without a spec — a
hand-written decision is an ADR, and the point of this pass is the ones nobody wrote.

---

## Projection into the index

`glossary-project.ts` writes each consolidated term into the item index as
`nimbus:glossary_term`, so `nimbus search` / `nimbus ask` find it. Two constraints:

- **Synonyms must live in the body text.** `item_fts` indexes only `title` and the body —
  metadata JSON is invisible to both FTS and the embedding pipeline. Without the
  `Also known as: …` line, `ask "what does Change Data Record mean?"` finds nothing while the
  acronym query succeeds, which is exactly backwards for the user who needs a glossary.
- The projection body mirrors the 512-char preview budget (`BODY_LIMIT`), and `unprojectTerm`
  is the demotion counterpart — a demoted or vetoed term must not linger in search.

`--rebuild` deletes every projected item along with the store rows. That is why the CLI
previews the delete count and requires `--yes`.

---

## Checklist — adding a source item type to either pass

1. Add the **`<service>:<type>`** key to `GLOSSARY_SOURCE_TYPES` / `DECISION_SOURCE_TYPES`.
   Never a bare type.
2. Confirm the connector actually writes a body for that type, and at what cap — a type with
   only a 512-char `body_preview` will surface almost nothing. Derive it; see
   `nimbus-index-body-depth`.
3. If it is paragraph-shaped, check whether it belongs in `PROSE_HEAVY_TYPES`
   (`nimbus-embedding-routing`) — that raises the body cap, which is usually the real
   blocker.
4. For decisions, set `sourceAuthority` deliberately (`decision-confidence.ts`: long-form docs
   `1`, `*:issue` `0.6`, chat `0.3`). A new type falls through to `0.3`.
5. Existing rows are **not** re-scanned by adding a type — the watermark has already passed
   them. Say so, and point the user at `--rebuild`.
6. Update the honesty statements if the change moves a ceiling or a coverage claim.

## See also

- `nimbus-agent-patterns` — the read path: brief shape, gap notes, the `briefReady` contract
- `nimbus-db-migrations` — authoring V45/V46/V47-shaped migrations
- `nimbus-index-body-depth` — why a source is truncated or invisible
- `nimbus-ipc` — the `glossary.*` / `decisions.*` write-class namespaces (LAN-forbidden, not Tauri-exposed)
- `docs/cli-reference.md` § `nimbus glossary` / `nimbus decisions` — the user-facing contract
