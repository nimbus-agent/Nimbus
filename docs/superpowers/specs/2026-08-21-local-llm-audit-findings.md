# Local-LLM audit — findings

**Date:** 2026-08-21
**Branch:** `dev/asaf/local-llm-audit`
**Substrate:** installed `nimbus` **2.10.0** (winget MSI) · Ollama `llama3.2:latest` (3.2B, Q4_K_M) on `127.0.0.1:11434`
**Index:** 13,183 items — `github_actions` 11,361 · `filesystem` 1,360 (`C:\gitrep\nimbus-vscode`) · `gmail` 228 · `github` 213 · `google_drive` 18 · `nimbus` 3
**Config:** `[llm] prefer_local = true`, `local_model = "llama3.2"` · `[agents] synthesis = "local"` · `[persona] tone = "terse"`

## Framing

The question this audit exists to answer: **when a brief or an answer comes back wrong, is that Nimbus or the model?**

The rule applied throughout: a defect counts as a **Nimbus** defect if a frontier model
(Claude / GPT / Gemini) would receive the same bad input, or would be permitted the same
bad output by the same guard. Nimbus's job is to build good context and to constrain any
model's output. Where a finding is genuinely just "3B is weak", it is filed under
§ Not-a-Nimbus-bug and no fix is proposed.

The local model turned out to be a **good instrument** rather than a confound: it fails
loudly and literally, which surfaced guard gaps that a more fluent model would have
papered over.

### Methodological caveat

The binary under test is **2.10.0**; source was read at `origin/main` (`9b905f16`, post-2.12).
Where a root cause is cited, the shipped v2.10.0 source was diffed to confirm the code is
identical (done for F1 and F2). Anything not so confirmed is marked ⚠️.

---

## F1 — `ask` passes the raw user sentence to FTS, then fabricates relevance on the miss

**Severity: high.** Model-independent. This is the finding that started the audit.

### Symptom

```
$ nimbus ask "what does egressRowToItem do?"
Missing context for egressRowToItem.

$ nimbus ask "From the local indexed context, what does egressRowToItem do?"
Missing context: egressRowToItem.
```

The symbol is indexed and trivially findable.

### Evidence it is not the model

Same model, same system prompt, same question — only the context builder differs:

| Context built by | Result |
|---|---|
| Hand-fetched correct rows → Ollama directly | Correct, grounded answer describing `EgressRow → SidebarItem` |
| `buildLocalIndexedContext` via `nimbus ask` | `"Missing context for egressRowToItem."` |

llama3.2 was instructed *"If the context is insufficient, say what is missing instead of
inventing details"* and did exactly that. The model behaved correctly on bad input.

### Root cause

`engine/run-ask.ts:406` `buildLocalIndexedContext` passes the **whole user sentence** as the
search term:

```ts
await localIndex.searchRankedAsync({ name: query, limit: LOCAL_CONTEXT_ITEM_LIMIT },
                                   { semantic: true, contextChunks: 2 })
// query === "From the local indexed context, what does egressRowToItem do?"
```

`index/local-index.ts:112-117` `ftsTitleMatchQuery` splits on `\s+` only and joins every
token with **`AND`**:

```sql
(title : "From"* OR body : "From"*) AND … AND (title : "do?"* OR body : "do?"*)
```

Punctuation is never stripped, so `"context,"*` and `"do?"*` are literal prefix terms that
match nothing. No document can satisfy the conjunction.

Measured:

```
nimbus search "egressRowToItem"                                              → hit
nimbus search "egressRowToItem function"                                     → hit
nimbus search "From the local indexed context, what does egressRowToItem do?" → []
```

### The part that makes it worse than a miss

On empty, `buildLocalIndexedContext` falls through to:

```ts
if (byId.size === 0) { addRankedResults(localIndex.searchRanked({ limit: LOCAL_CONTEXT_ITEM_LIMIT })); }
```

No `name`. In `searchRanked` that sets `useFts = false` and runs `searchWithoutFtsOrdered` —
**arbitrary recent items**. The model is then handed ten unrelated items under the header
`Indexed Nimbus context:` inside an authoritative `<tool_output service="nimbus">` envelope.

Corroborated independently on a second surface — `nimbus ask --devil "should we index full
email bodies by default?"` returned:

> *"The absence of 'Manifest Validation Diagnosis — skipped' … in the indexed data suggests…"*

It is reasoning about arbitrary GitHub Actions rows, because that is what the fallback fed it.

### Why a frontier model does not fix this

Claude / GPT / Gemini receive the **same** wrong context. Being more fluent, they are
*likelier* to synthesise something plausible from whatever arbitrary items appear — a
confident wrong answer instead of an honest refusal. Swapping the model **hides** F1.

### Suggested fix

1. Extract search terms from the question before hitting FTS (strip stopwords + punctuation;
   prefer identifier-shaped tokens). — highest value, smallest blast radius.
2. Make the no-name fallback return `undefined` rather than arbitrary items. Presenting
   unrelated rows as "Indexed Nimbus context" is worse than admitting no context.
3. Separately: `ftsTitleMatchQuery`'s `AND`-join + punctuation retention. Affects
   `nimbus search` and every other caller — **own PR**.

> `shouldAnswerFromLocalIndexedContext`'s phrase gate (`run-ask.ts:195`, matching
> `/\b(local indexed|indexed nimbus|nimbus github context|indexed github context)\b/i`) is a
> **red herring** for F1 — both phrasings reached the same broken retrieval. The longer
> phrasing was *worse*, because it added five more `AND` terms.

---

## F2 — a model-fabricated `# Gaps` survives the anti-fabrication strip (heading promotion)

**Severity: high.** Model-independent guard gap. I31-adjacent.

### Symptom

`nimbus impact src/sidebar/egress.ts` ships **two** Gaps sections:

```markdown
# Impact: src/sidebar/egress.ts
No downstream impact resolved, generated in 0.0 s

# Gaps                                          ← FABRICATED by the model
- category: missing_relation_emit
  detail: No reverse `depends_on` edges to the start entity.
  remediation: graph-populator currently emits `depends_on` only at workspace→package …
- category: missing_entity_type
  …

## Gaps                                         ← canonical, re-attached verbatim ✅
- No reverse `depends_on` edges to the start entity. (graph-populator currently emits …)
- 2 categories blocked: `pipeline_run` / `dashboard` (Tracked as a graph-populator …)

_Synthesized by llama3.2 (local)._
```

The fabricated block leaks **raw internal field names** (`category:`, `detail:`,
`remediation:`) into user-facing output.

### I31 itself held

The canonical `## Gaps` was withheld from the model and re-attached verbatim, exactly as
designed. **No disclosure was lost.** This is not an I31 violation.

### Root cause

`agents/_lib/markdown-sections.ts:198` `stripSections`:

```ts
for (const h of heads) {
  if (h.level !== 2) continue;      // ← only level-2 headings are stripped
  …
}
```

The doc comment above it justifies excluding **demoted** headings:

> *"DEMOTED headings are deliberately NOT stripped. … a `### Gaps` the model nested under
> some other section is fabrication of the general kind … whereas widening the strip to
> deeper levels would start deleting the sub-structure the end-of-section rule exists to permit."*

That reasoning is sound for `###`/`####`. It **does not extend to `#`** — a level-1 heading
cannot be legitimate sub-structure of anything, since level 1 is the document-title level.
But `h.level !== 2` treats promotion and demotion identically, and promotion was never
considered.

Confirmed identical in shipped `v2.10.0` (`git show v2.10.0:…/render.ts`, `renderImpact`
uses `reserved(renderGaps(...))` → `## Gaps`; the H1 came from the model).

### Why a frontier model does not fix this

Any model can promote a heading. A stronger model does it less often — but the guard exists
precisely so frequency does not matter. Today the guard is one keystroke wide.

### Suggested fix

Strip level **≤ 2** rather than `=== 2`, i.e. `if (h.level > 2) continue;`. Preserves the
demotion rationale verbatim while closing promotion. Add a red-prove test that a `# Gaps`
emitted by the model is removed and the canonical `## Gaps` survives.

> `sectionBody`'s `h.level === 2` rule is **correct as-is** and should not change — it locates
> the *canonical* section, which the renderer always writes at level 2.

---

## F3 — `catchup` claims personalisation it has no signal for, and declares no gap

**Severity: high.** Honesty defect. Model-independent.

`nimbus catchup` is documented as a *"personalised retrospective digest weighted by your
involvement"*. The JSON says otherwise:

```json
"gaps": [],
"involvement": { "ownedServices": [], "activeRepos": [],
                 "incidentServices": [], "collaboratorPersonIds": [] },
"sections": [ { "items": [
  { "relevanceScore": 0.1, "relevanceReasons": ["default"] },
  { "relevanceScore": 0.1, "relevanceReasons": ["default"] }, … ] } ]
```

Every involvement axis is empty. Every item scored the identical default `0.1` with reason
`"default"`. There is **no personalisation and no weighting** — and `gaps: []` explicitly
asserts nothing is missing.

A brief that cannot personalise must **say so**. This is the same class the codebase already
polices elsewhere (I31 disclosure integrity; "egress claims must match real outbound").

### Suggested fix

Emit a gap note when `involvement` is empty on all axes, or when every item carries
`relevanceReasons: ["default"]` — e.g. *"No involvement signal: results are recency-ordered,
not weighted by your activity."*

### Downstream effect

Fed 50 items all scored `0.1`, llama3.2 confabulated an entire analysis:

> *"scores ranging from 0.10 to 0.10 … suggests that they may not have been very reliable or
> accurate … the `winget-pkgs` repository is experiencing some issues with its workflows"*

None of that is in the data. But note the input genuinely contained no signal — F3 is the
Nimbus half; the confabulation is the model half (see § Not-a-Nimbus-bug).

---

## F4 — the synthesis prompt leaks into user-facing output

**Severity: medium.** Partly model-dependent; the strip is Nimbus's job.

`nimbus glossary --refresh` opened with:

> *"Based on the provided tool output, I will provide a deterministic fallback rendering of
> the glossary terms as a structural template, without copying verbatim."*

The model narrated its **own instructions** back to the user. The phrases "deterministic
fallback rendering", "structural template" and "without copying verbatim" are synthesis-prompt
vocabulary, not glossary content.

A frontier model does this less — but a leading meta-preamble is cheap for Nimbus to strip
unconditionally, and it is the kind of thing that should not depend on model politeness.

### Suggested fix

Strip a leading meta-preamble in the synthesis post-processing (the same place the fabricated
reserved sections are stripped), or add an explicit prompt directive. Prefer the strip —
prompt directives are advisory, strips are structural.

---

## F5 — glossary extraction has no stopword or dedup filter

**Severity: medium.** Nimbus-side (discovery stage, not the LLM).

`nimbus glossary --refresh` → `Pass complete: 10 new, 0 upgraded.` The ten terms:

| Term | Mentions | Assessment |
|---|---|---|
| **Main** | 21 | common word / branch name |
| **Nimbus** | 13 | the product |
| **Built-in** | 7 | common adjective |
| **Why Peek** | 6 | plausible UI label |
| **Key** | 4 | common word |
| **Nimbus-dev** | 4 | npm scope |
| **Quick Ask** | 3 | plausible UI label |
| **Quick Ask** | 3 | **duplicate — case variant, not deduped** |
| **Read-only** | 3 | common adjective |
| **Start** | 3 | common word |

Two distinct defects:

1. **No stopword/quality gate.** "Main", "Key", "Start", "Built-in", "Read-only" are not team
   terminology. They appear to be harvested from markdown headings.
2. **Case-variant duplicates survive reconciliation.** "Quick Ask" appears twice; the model
   even annotated the second *"(same as above, but with capitalization)"* — the model noticed
   what the pipeline did not.

Definitions are also mismatched — *"Start: headless machine that cannot create a login
keyring"* attaches an unrelated sentence to a word.

Filed against `gateway/src/glossary/` (discover → score → consolidate → reconcile).
Dedup belongs in **reconcile**, stopwording in **discover/score** — neither is the LLM's job.

---

## F6 — connectors report `healthy` when they have never been configured or synced

**Severity: medium.** UX/honesty. Model-independent.

```
$ nimbus doctor
  [ok] gitlab: healthy     [ok] bitbucket: healthy   [ok] slack: healthy
  [ok] linear: healthy     [ok] notion: healthy      [ok] jira: healthy
  [ok] jenkins: healthy    [ok] kubernetes: healthy  …
```

None of these have credentials in the vault (which holds only `github.pat`, four Google OAuth
blobs, the web-clipper tokens and the policy keypair). `sync_state` shows
`last_sync_at: null` for every one. They have never run.

`healthy` for "never attempted" is indistinguishable from `healthy` for "synced fine five
minutes ago". Contrast the connectors that *did* try, which report honestly:

```
gmail: error err=Token exchange failed (invalid_grant: Token has been expired or revoked.)
outlook: error err=Microsoft OAuth not configured; run: nimbus connector auth onedrive
```

This is adjacent to the known I29 bound already recorded in `CLAUDE.md` — a multi-key manifest
service counts as "configured" the moment any one key is set. Here the reverse: zero keys set
still reports `healthy`.

### Suggested fix

A distinct `unconfigured` / `never-synced` state, separate from `healthy`.

---

## F7 — `people list` is polluted with automated senders

**Severity: low.** Data quality.

```
First Backer            newsletter@first-backer.com     items=1
—                       egovpayments@ecom.gov.il        items=1
LinkedIn                jobs-listings@linkedin.com      items=2
LinkedIn Job Alerts     jobalerts-noreply@linkedin.com  items=5
```

The people graph treats every gmail `From:` as a person. `noreply@` / `jobalerts-` /
`newsletter@` patterns should not become graph entities — they dilute `nimbus expert` and any
involvement weighting that reads the person graph (see F3).

---

## F8 — `min_reasoning_params` is dead config

**Severity: low.** Documented knob that cannot fire. ⚠️ *source-read at main; not diffed against v2.10.0*

`[llm] min_reasoning_params` (default `7`) is parsed and validated, and `llm/router.ts:234`
uses it:

```ts
private meetsCapabilityFloor(id: LlmProviderKind, task: LlmTaskType): boolean {
  if (task !== "reasoning" && task !== "agent_step") return true;
  const meta = this.providerMeta.get(id);
  if (meta?.parameterCount === undefined) return true;     // ← always taken
  return meta.parameterCount >= this.config.minReasoningParams;
}
```

But `llm/registry.ts:20`:

```ts
addProvider(provider: LlmProvider): void {
  this.router.registerProvider(provider);   // ← no meta argument
}
```

`registerProvider(provider, meta = {})` therefore always stores `{}`, `parameterCount` is
always `undefined`, and the floor **fail-opens for every provider on the only production
wiring path**.

**Red-proved:** set `min_reasoning_params = 7` against a 3.2B model, restarted, and
`nimbus llm status` still reported `reasoning → ollama / prefer-local`. It never reports
`local-below-reasoning-floor`.

`OllamaProvider.parseOllamaModel` *does* parse `parameter_size: "3.2B"` → `3.2` correctly — it
just feeds `listModels()`, not `providerMeta`.

### Suggested fix

Either wire `addProvider` to pass real meta, or delete the knob. A documented control that
cannot fire is worse than no control.

---

## F9 — `nimbus prove` reads as "nothing left the machine" when things did

**Severity: low-medium.** Scope-labelling, not a ledger bug.

`ANTHROPIC_API_KEY` is set in the environment. Every `nimbus ask` attempts the **remote intent
classifier** first:

```
run-ask: "remote intent classifier unavailable; falling back to local indexed-context answer"
         reason=invalid_api_key provider=anthropic
```

Four such outbound attempts to `api.anthropic.com` were made during this audit.
`nimbus prove` afterwards:

```
outbound egress events during this query: 0
  (scope: agents.* briefs served over the local HTTP API, agents.* briefs served to MCP
   clients, remotely-synthesized agent briefs, configured connector sync runs and targeted
   fetch-on-miss calls, gated connector actions)
```

The scope label is **honest** — it enumerates exactly what is covered, and the intent
classifier is not among them. `nimbus egress verify` independently reports
`4007 rows verified`, chain intact. Nothing is broken.

The problem is the headline. *"outbound egress events during this query: 0"* is the line a
user reads; the scope parenthetical is the line they skip. Per the existing
`egress-claim-must-match-real-outbound` precedent, this is the shape worth pre-empting.

### Suggested fix

Either bring the intent classifier under the ledger (a `model`-class append, matching
synthesis), or make the headline name its own narrowness — *"0 events in the covered classes"*
rather than a bare `0`.

---

## Not a Nimbus bug — genuine local-model weakness

Recorded so the fix list does not absorb them. **No action proposed.**

- **`catchup` prose confabulation.** Given 50 items all scored `0.1`, llama3.2 invented an
  analysis of workflow reliability. The *input* defect is F3; the invention is the model.
  A frontier model would summarise the same empty signal more gracefully.
- **Terse non-answers** (`"Missing context: egressRowToItem."`). Correct behaviour under the
  system prompt + `[persona] tone = "terse"` — given bad context (F1), this is the *desired*
  failure mode.
- **Glossary definition mismatches.** The consolidation LLM attached wrong definitions to
  terms. Stopwording/dedup (F5) is Nimbus's; definition quality is the model's.

---

## Priority proposal

| # | Finding | Severity | Model-independent | Blast radius |
|---|---|---|---|---|
| F1 | Raw sentence → FTS; arbitrary-item fallback | high | yes | `ask`, `--devil`, every local-context surface |
| F2 | Promoted `# Gaps` evades `stripSections` | high | yes | all 14 brief kinds |
| F3 | `catchup` claims unearned personalisation | high | yes | `catchup` |
| F4 | Synthesis prompt leaks into output | medium | partly | all synthesized briefs |
| F5 | Glossary stopwords + case-variant dupes | medium | yes | `glossary` |
| F6 | `healthy` for never-configured connectors | medium | yes | `doctor`, `status` |
| F9 | `prove` headline vs scope | low-med | yes | `prove` |
| F7 | `people list` automated senders | low | yes | `people`, `expert` |
| F8 | `min_reasoning_params` dead config | low | yes | `[llm]` config surface |

**Suggested first PR:** F2 — one-line guard fix (`h.level > 2`), a red-prove test, smallest
diff, closes a live output defect on all fourteen brief kinds.

**Suggested second PR:** F1 steps 1–2 (term extraction + honest empty context). Highest user
impact. F1 step 3 (`ftsTitleMatchQuery`) is deliberately deferred to its own PR — it changes
`nimbus search` semantics for every caller.

F3 and F6 are the same shape as each other (a surface asserting more confidence than its data
supports) and could reasonably land together.

---

## Reproduction

```powershell
# substrate
ollama serve ; ollama pull llama3.2
# %APPDATA%\Nimbus\nimbus.toml → [llm] prefer_local=true, local_model="llama3.2"
#                                [agents] synthesis="local"
nimbus start --no-wizard ; nimbus llm status    # expect: 4 rows, ollama, prefer-local

# F1
nimbus search "egressRowToItem"                                              # hit
nimbus search "From the local indexed context, what does egressRowToItem do?" # []
nimbus ask "what does egressRowToItem do?"                                   # non-answer

# F2
nimbus impact src/sidebar/egress.ts        # two Gaps sections, one H1 with raw field names

# F3
nimbus catchup --since 30d --json          # gaps:[] beside an all-empty involvement block

# F5
nimbus glossary --refresh                  # "Main", "Key", "Start"; "Quick Ask" twice

# F6
nimbus doctor                              # healthy for connectors with no credentials

# F8
# set min_reasoning_params = 7, restart, nimbus llm status → still prefer-local

# F9
nimbus prove ; nimbus egress verify        # 0 during-query vs 4007 rows in chain
```
