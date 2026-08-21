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

### 1b — FTS is PREFIX-only, so a mid-token term silently returns nothing

`ftsTitleMatchQuery` emits `(title : "<tok>"* OR body : "<tok>"*)`. SQLite FTS5 prefix
matching anchors at a token START, so a term appearing mid-token never matches:

```
nimbus search "Fargate"              -> []
nimbus search "RequiemNexusFargate"  -> hits
```

The indexed token is `RequiemNexusFargateServiceTaskDefwebLogGroupECA0B21D-HMttfm0DVr5z`. This
hits hardest exactly where names are machine-generated — CDK/CloudFormation resources, ARNs,
Kubernetes objects — i.e. the infrastructure a user is least able to spell from memory.

The quoting workaround for 1a does NOT rescue this: a quoted mid-token term routes through the
same prefix matcher and returns the same zero rows.

> ⚠️ **UNVERIFIED BOUND.** Every measurement above was taken on a machine where semantic search
> was inert — `embedding_chunk` held ZERO rows for every service, and every `nimbus search`
> result carried `vectorRank: null`. The data dir's `models/` directory (holding the MiniLM
> model) was found deleted the same afternoon, so "embeddings never worked here" and "the model
> was removed minutes earlier" cannot be separated from the evidence available.
>
> `buildLocalIndexedContext` DOES request `{ semantic: true, contextChunks: 2 }`, so a working
> vector index might partially rescue a mid-token term that FTS cannot reach. Until this is
> re-measured with embeddings present, 1b is confirmed only for the BM25 path — NOT as a claim
> that a mid-token term is unreachable by every retrieval path. Re-run
> `nimbus search "Fargate"` after `nimbus index reembed` before relying on it.

### The most damaging observed instance

`nimbus ask 'In prose, list my "Fargate" log groups by name and what service each belongs to.'`
answered:

> Here are your Fargate log groups listed by name and the service each belongs to:
> Manifest Validation Diagnosis — skipped (GitHub Actions)
> Wingetbot PR Triage — skipped (GitHub Actions)
> Missing Dependency Assist — skipped (GitHub Actions)
> …

Every row is a `microsoft/winget-pkgs` CI run. The user has 8 real Fargate log groups indexed.
The chain: `"Fargate"` matches nothing (1b) -> `byId.size === 0` -> the no-name fallback
returns arbitrary recent items (1a) -> `github_actions`, the highest-volume service, fills the
context -> the model answers the question it was asked using the only data it was given.

Note the model even TAGGED each row `(GitHub Actions)`. It reported its source honestly; the
system had told it these were the answer. No prompt change fixes this — the retrieval layer
asserted relevance it did not have.

This is why 1a's second fix (return `undefined` instead of arbitrary items) matters more than
its severity rating suggests: the failure mode is not an unhelpful answer, it is a confident,
specific, false claim about the user's own production infrastructure.

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

> **Incomplete on its own — see F28.** A later run caught the model reproducing the reserved
> section as a plain-text `Gaps:` label with no heading at all. That is not in `heads`, so neither
> `=== 2` nor `> 2` sees it. This fix is still correct and still needed; it is not the whole guard,
> and the "one-line fix, smallest diff" framing below should be read with F28 attached.

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

## F10 — a Google token response with no `refresh_token` is stored as `""` and reported as success

**Severity: medium-high.** Fail-silent. Model-independent. Found while debugging a live gmail re-auth.

### Symptom

`nimbus connector auth gmail` reports success and writes fresh vault blobs, but every
subsequent sync fails permanently:

```
$ nimbus connector sync gmail --force
Token exchange failed (invalid_grant: Bad Request)
```

### Established facts

- Re-auth **did** write fresh tokens: `google.oauth.enc` + `google_gmail.oauth.enc` rewritten
  `2026-08-21 12:12:32`; `google_drive.oauth.enc` / `google_photos.oauth.enc` untouched since
  `2026-05-10`.
- The error **changed** with the re-auth: `invalid_grant: Token has been expired or revoked.`
  → `invalid_grant: Bad Request`. `google_drive`, never re-authed, still reports the *old*
  string. Two different failures, distinguishable by message.
- `connector_health_history` records the new failure at `occurredAtMs: 1787303532428` — the
  same second the vault blob was written. The failure is the *fresh* credential, not a stale row.
- **Not** an in-memory cache: gateway stopped, restarted, synced again — identical error.

### The Nimbus defect

`auth/oauth-registry.ts:95-99`, `parseStandardTokenResponse`:

```ts
const refresh = o.refresh_token;
…
return {
  accessToken: access,
  refreshToken: typeof refresh === "string" ? refresh : "",   // ← silent coercion
  …
};
```

A token response carrying **no** `refresh_token` is accepted as a successful exchange and
persisted with an empty refresh token. `access_token` and `expires_in` both throw when absent
(lines 88-94); `refresh_token` alone degrades silently.

The consequence is a credential that can never work: every later refresh sends an empty
`refresh_token` and Google answers `invalid_grant: Bad Request` — the exact string observed —
forever, with the user having been told auth succeeded.

Google *should* return a refresh token here: the descriptor sets `access_type: "offline"` and
`prompt: "consent"` (`oauth-registry.ts:241-242`). Whether the empty-token path is what fired
in this specific case is **NOT established** — the stored blob was not decrypted, and its size
(992 bytes, unchanged from the previously-working May 10 blob) is weak evidence *against* an
absent refresh token. The fail-silent coercion is a real defect either way.

### Secondary: the failure logs nothing

`grep -i "gmail\|oauth\|token\|refresh"` over the gateway log for the whole day returns
**zero lines**. A permanent credential failure produces no log record beyond the
`sync_state.last_error` string — no client id used, no scopes requested, no response body.

### Suggested fix

1. Throw at exchange time when `refresh_token` is absent on a provider whose descriptor
   requested offline access, with a remedy in the message (*"revoke access at
   myaccount.google.com/permissions and re-run `nimbus connector auth gmail`"*). Never persist
   an empty refresh token.
2. Log the OAuth exchange outcome — provider, client-id **prefix**, scopes granted, error body.
   No secrets.

### Open question for the user

Whether `google_gmail.oauth` currently holds a non-empty `refresh_token` decides if F10's
coercion is the live cause or a latent bug alongside a different one. `nimbus vault get
google_gmail.oauth` answers it — **run privately; it prints a live credential.**

---

## F11 — one dead Google credential disables ALL four Google connectors

**Severity: high.** Model-independent. **Root cause of the live gmail failure.** Confirmed end-to-end.

### Symptom

`nimbus connector auth gmail` reports `Verified: gmail`. Every sync then fails:

```
$ nimbus connector sync gmail --force
Token exchange failed (invalid_grant: Bad Request)
```

Re-authing gmail — repeatedly — never helps, because gmail's credential was never the problem.

### Measured

`scripts/diagnostics/test-google-oauth-refresh.ps1 -All` presents each stored refresh token to
Google directly, outside Nimbus:

| vault key | refresh token | `expiresAt` | Google's verdict |
|---|---|---|---|
| `google.oauth` | `2e74c5…` | valid (+43 min) | **ACCEPTS** (`expires_in 3599`) |
| `google_gmail.oauth` | `2e74c5…` | valid (+43 min) | **ACCEPTS** (`expires_in 3599`) |
| `google_drive.oauth` | `5b4502…` | 2026-05-10 (−148,181 min) | **REJECTS — `invalid_grant: Bad Request`** |
| `google_photos.oauth` | `f4adfe…` | 2026-05-10 (−148,181 min) | **REJECTS — `invalid_grant: Bad Request`** |
| `google_meet.oauth` | — | not set | — |

Gmail's own credential is valid and Google accepts it. Drive's and Photos' are dead and
produce **the exact error string the user sees**.

### Root cause

`connectors/gmail-sync.ts:42-44` — the first thing gmail's `sync()` does, before touching its
own token:

```ts
async sync(ctx, cursor) {
  await ensure();                                              // ← runs first
  const accessToken = await getValidGoogleAccessToken(ctx.vault, "gmail");
```

`platform/assemble-sync-registrations.ts:117-127` wires that `ensure` for **gmail, photos and
meet** to Drive's mesh boot:

```ts
createGmailSyncable({        ensureGoogleMcpRunning: () => connectorMesh.ensureGoogleDriveRunning() })
createGooglePhotosSyncable({ ensureGoogleMcpRunning: () => connectorMesh.ensureGoogleDriveRunning() })
createGoogleMeetSyncable({   ensureGoogleMcpRunning: () => connectorMesh.ensureGoogleDriveRunning() })
```

And `connectors/lazy-mesh/connector-spawns.ts:74-86` resolves a token for **every** Google
service in one unguarded loop:

```ts
const ids: GoogleConnectorOAuthServiceId[] = ["google_drive", "gmail", "google_photos", "google_meet"];
for (const id of ids) {
  const resolved = await resolveGoogleOAuthVaultKey(ctx.vault, id);
  if (resolved === null) continue;                    // absent  -> skipped
  const token = await getValidGoogleAccessToken(ctx.vault, id);   // present-but-dead -> THROWS
```

An **absent** credential is skipped. A **present-but-expired** one throws and aborts the whole
mesh boot — and with it every Google connector's sync. `google_drive` is first in the list.

This also resolves the puzzle that blocked diagnosis for an hour: a refresh fired despite
gmail's `expiresAt` being an hour in the future, because the expiry being checked was never
gmail's — it was Drive's, 148,181 minutes in the past.

### Why the surface misleads

- **`Verified: gmail` is meaningless here.** It validates the freshly-exchanged *access* token
  in memory; it never boots the mesh and never touches Drive.
- **The error is attributed to `gmail`** in `sync_state.last_error` and
  `connector_health_history`, naming the one Google connector whose credential is fine.
- **`nimbus connector pause google_drive` does not help** — pause gates the *scheduler*, not
  this direct mesh call. Verified: paused Drive, gmail still failed.
- Nothing is logged (see F10), so none of the above is visible from the outside.

### A PAUSED connector's dead credential still breaks the others

The loop in `connector-spawns.ts:74-86` iterates a hardcoded `ids` array and never consults
scheduler state. Measured: `google_photos` was `"status": "paused", "healthState": "paused"`
throughout, and its dead credential still aborted the mesh boot for gmail.

So the obvious user remedy — disable the broken connector — **does not work**. Neither does
`nimbus connector pause google_drive` (verified separately: paused Drive, gmail still failed).
There is no way to route around a dead Google credential short of re-authing it or clearing
the vault key. Note the asymmetry that makes this avoidable: an ABSENT key is skipped by the
`resolved === null` guard, so `vault delete <key>` would work where `pause` does not — a
non-obvious workaround that no surface hints at.

### Fix for the user

Re-auth EVERY Google service whose key Google rejects — not just the first one, and not the
connector that reported the error. In this instance that was two:

```
nimbus connector auth google_drive     # fp 5b4502… (2026-05-10) -> a1b0d6… valid
nimbus connector auth google_photos    # fp f4adfe… (2026-05-10) -> still dead
```

Re-authing only `google_drive` left gmail failing with the identical message, because
`google_photos` was still dead and sits in the same loop. `google_meet.oauth` is unset, so
`resolveGoogleOAuthVaultKey` falls back to the shared `google.oauth` and needs nothing.

### Suggested fix

1. Make the loop fault-isolating: catch per `id`, register the servers whose credential
   resolves, and skip the ones that don't. One dead credential must not disable three healthy
   connectors.
2. Attribute the failure to the service that actually owns the credential. `gmail` should
   never report an error caused by `google_drive.oauth`.
3. Treat a **present-but-unrefreshable** credential the same way as an absent one at boot
   (skip + report), rather than as a fatal error for the whole provider.

### Reproduction

`scripts/diagnostics/test-google-oauth-refresh.ps1` (added on this branch). Presents each
stored refresh token to Google directly and prints which key Google rejects. Prints no secret —
only lengths, SHA-256 fingerprint prefixes, and Google's verdict.

```powershell
./scripts/diagnostics/test-google-oauth-refresh.ps1 -All
```

A same-fingerprint pair across two keys (as with `google.oauth` / `google_gmail.oauth` above)
shows they hold the same credential; differing fingerprints localise which one is dead.

---

## F12 — a repo question silently excludes PRs, and `github_actions` swamps ranked search

**Severity: medium.** Model-independent. Two separate defects that compound.

### 12a — the repo path is issues-only

`extractGithubRepoSlugs` (`run-ask.ts:329`) matches an `owner/repo` slug in the question and
routes it to `githubIssueContextItemsForRepo`, whose SQL is hardcoded:

```sql
WHERE service = 'github' AND type = 'issue' AND (lower(external_id) LIKE ? OR lower(url) LIKE ?)
```

So a repo-scoped question can never see pull requests. Measured on `nimbus-agent/Nimbus`:

| type | most recent in index |
|---|---|
| **PR** | **2026-08-21 10:42** — five merged that morning |
| issue | 2026-08-13; three of the seven returned dated **2026-05-10** |

`nimbus ask 'summarise recent activity in nimbus-agent/Nimbus'` answered with months-old docs
issues and omitted every PR merged that morning. Nothing in the reply signals the type filter,
so an incomplete answer reads as a complete one — the same honesty shape as F3.

### 12b — `github_actions` volume swamps the generic ranked path

Falling back to a quoted term does not reliably reach PRs either, because run items dominate
the index by two orders of magnitude:

| service | items |
|---|---|
| `github_actions` | 11,979 |
| `github` | 214 |

`nimbus ask 'In prose, summarise the recent "release" pull requests and what shipped.'`
returned **workflow runs** ("run 32461836739 … was skipped"), not pull requests.

A *distinctive* quoted term still works — `'what is the pull request about "clip source
metadata"?'` correctly summarised PR #1288. So the failure is ranking under volume, not
retrieval: a generic term matches thousands of near-identical run titles that crowd out the
handful of real hits.

### The sharpest instance: `microsoft/winget-pkgs`

`nimbus ask 'What is happening in microsoft/winget-pkgs?'` answered:

> GitHub Actions runs are being executed.
> - Wingetbot PR Triage: skipped (2 runs)
> - Manifest Validation Diagnosis: skipped (3 runs)

What the index actually holds for that repo:

| service / type | rows |
|---|---|
| `github` / `issue` | **0** — so 12a contributes nothing at all |
| `github` / `pr` | **16**, incl. three Nimbus release PRs updated minutes earlier |
| `github_actions` / `ci_run` mentioning winget | **10,671** |

Both defects fire together and compound: the issues-only path returns zero rows, execution
falls through to the generic ranked path, and 10,671 near-identical CI runs bury 16 PRs. The
user's actual interest in that repo — are my release PRs merged? — is the one thing the answer
cannot reach.

### 12c — the internal `rank` field leaks and is misread as data

`formatContextItem` attaches `{...item, rank: idx + 1}` (`run-ask.ts:161`) and the whole object
is serialised into the `<tool_output>` envelope. Asked about PR status, the model answered:

> - PR #414691 is ranked 1st.
> - PR #422039 is ranked 6th.

`rank` is relevance ordering, an internal artifact with no meaning to the user, and nothing in
the envelope says so. The model presented it as if it were the answer — and because ranking is
by relevance rather than recency, three-month-old PRs outranked the open ones. Either strip
`rank` before serialising, or label the fields.

**Confirmed twice, on unrelated data.** Asked about AWS CloudWatch log groups, the same field
resurfaced as invented infrastructure semantics:

> *"The log groups also contain a 'rank' value, which suggests that they may be related to a
> specific ordering or priority within the RequiemNexus infrastructure. However, the exact
> meaning of this rank value is not clear without further context."*

Two independent datasets (GitHub PRs, CloudWatch log groups), two different misreadings, same
cause. The model is behaving reasonably — it is handed a field named `rank` inside a
`<tool_output>` envelope with no schema, so it explains it. Stripping the field is a smaller
and more reliable fix than any prompt instruction, and unlike prompt guidance it works for
every model.

### Suggested fix

1. Widen the repo path beyond `type = 'issue'` — at minimum include `pr`, ordered by
   `modified_at` across both, or disclose the filter in the reply.
2. Weight or cap per-service representation in `buildLocalIndexedContext` so one high-volume
   service cannot consume the whole `LOCAL_CONTEXT_ITEM_LIMIT` budget. A per-service cap is
   the smaller change; relevance-weighting by service is the better one.
3. Both are worth doing regardless of model — a frontier model receives the same crowded-out
   context.

### Workaround today

Use the structured surface for PRs, which is unaffected: `nimbus query --service github --type pr`.

---

## F13 — `connector_health_history` records `sync succeeded` for a connector with no credentials

**Severity: high.** Model-independent. The unfixed half of a defect whose sibling I29 already closed.

### Measured

The three AWS connectors, queried BEFORE any AWS credential existed on this machine:

```
== cloudwatch: 4 history rows
   2026-06-21 13:51:56  null    -> healthy | sync succeeded
   2026-06-21 14:01:56  healthy -> healthy | sync succeeded
   2026-06-21 14:11:56  healthy -> healthy | sync succeeded
   2026-06-21 14:21:56  healthy -> healthy | sync succeeded
```

Identical rows for `athena` and `sagemaker`. The reason string is not "skipped" or "not
configured" — it is **`sync succeeded`**, recorded four times each on the 10-minute schedule.

No AWS credential existed at that date. The vault held exactly eight blobs
(`github.pat`, four Google OAuth, `http_api.web_clipper_tokens`, and the policy keypair);
`aws.profile` was first written on 2026-08-21 by `nimbus connector auth aws`. The AWS CLI
spawn could not have authenticated, and no outbound call was made.

### Why this is the sibling of a known bug

`sync/connector-configured.ts:70-76` documents the egress half in its own words:

> *"before this map existed the function below fell through to 'no signal, no gate' and returned
> `true` unconditionally — `sync/scheduler.ts`'s `runJob` then ledgered an 'authorized' `sync`
> egress row for every run even though each connector's own `sync()` made ZERO outbound network
> calls. Proven against a real `assemblePlatformServices` boot with an empty Vault: 0 network
> attempts, 15 fabricated rows."*

`DERIVED_CONFIGURED_CHECKS` fixed that for the **egress ledger**. It did not fix it for
**connector health**: `isConnectorConfigured` gates the ledger append only, so the same
zero-work run still writes a `sync succeeded` health-history row and a `healthy` state.

The fabricated-success problem was diagnosed, fixed in one consumer, and left standing in the
other. That is why `nimbus doctor` shows `[ok] gitlab: healthy`, `[ok] slack: healthy`,
`[ok] jira: healthy` for connectors that have never held a credential — F6's symptom, with
F13 as its mechanism.

### Related: `sync_state.last_sync_at` is never populated

After a real, successful CloudWatch sync that indexed 20 log groups:

```
sync_state row : {"connector_id":"cloudwatch","last_sync_at":null, ... ,"health_state":"healthy"}
nimbus connector status : "lastSyncAt": 1787314151713, "itemCount": 20
```

The CLI's `lastSyncAt` is derived elsewhere; the `sync_state` column stays `null` even on
success. Same for `gmail` and every other connector inspected. Harmless today because nothing
reads it, but it is a column whose name promises something it never holds — and a future
"when did this last sync?" check that reaches for the obvious field would silently read `null`.

### Suggested fix

1. Gate the health-history write on the same `isConnectorConfigured` signal the egress append
   already uses. A run that makes no outbound call must not record `sync succeeded`.
2. Add an `unconfigured` / `never-attempted` state distinct from `healthy` (F6's fix; F13 is
   the mechanism that makes it necessary).
3. Either populate `sync_state.last_sync_at` or delete the column.

### Precedent worth copying: `Stored: aws (not verified)`

`nimbus connector auth aws --aws-profile default` prints:

```
Stored: aws (not verified)
Credential: stored in the OS vault (no OAuth scopes).
```

That is the honest wording. It stores, says it stored, and explicitly declines to claim
verification. Compare `Verified: gmail`, which claims a validation that never exercised the
refresh path and misdirected the entire F11 investigation. The AWS message is the in-repo
model for how F11's should read.

---

## F14 — `ask` silently truncates every enumeration at 8 items

**Severity: high.** Model-independent. The most likely of all findings to mislead a careful user.

### Symptom

`nimbus ask 'In prose, list my "RequiemNexusFargate" log groups by name.'` returned a clean
numbered list, 1 through 8, no ellipsis, no caveat:

```
1. RequiemNexus-Compute-Stack-…-HMttfm0DVr5z
…
8. RequiemNexus-Compute-Stack-…-dABA3PUbIW4G
```

The user has **16**. Exactly half were dropped, and nothing in the answer says so.

```
total cloudwatch log groups : 20
matching RequiemNexusFargate: 16
returned by `ask`           :  8
```

### Root cause

`engine/run-ask.ts:287`:

```ts
const LOCAL_CONTEXT_ITEM_LIMIT = 8;
```

`buildLocalIndexedContext` slices to that limit before serialising, so the model never sees
items 9-16 and cannot know they exist. It is not the model omitting them — it is answering
completely over the half it was handed.

8 is a defensible context budget. Serving it as a complete answer to "list my X" is not.

### Why this is worse than F3 and F12a

The same undisclosed-incompleteness family, but the earlier two are detectable in principle —
a stale `catchup` looks stale; a repo summary missing PRs looks thin. Here the answer is
**indistinguishable from a correct one**: a well-formed, numbered, confident enumeration
answering exactly the question asked. A careful reader has no signal. The only way to discover
it is to already know the true count, which is precisely what the user asked the tool for.

It also silently invalidates any counting or completeness question — "how many X do I have",
"list all Y", "which Z are missing" — across every connector. With `github_actions` at 11,979
items, an enumeration question there returns 0.07% of the data, presented as an answer.

### The precedent is already in this codebase

I31 requires `negotiate` to carry an explicit **list-truncation clause**, defined once in
`agents/_lib/brief-disclosures.ts` and enforced by anchor phrase. The briefs already treat
"the list you are reading is not the whole list" as a disclosure that must survive a rewrite.
`ask` has no equivalent, and its truncation is far more aggressive.

### Suggested fix

1. When `byId.size` exceeds `LOCAL_CONTEXT_ITEM_LIMIT`, append the true count to the context
   and require its disclosure — reuse the `brief-disclosures.ts` pattern rather than inventing
   a second one. "Showing 8 of 16" is the whole fix.
2. Consider raising the limit for short-title item types; 8 titles of ~70 chars is a trivial
   token cost next to 8 full email bodies. A per-type budget beats one global constant.
3. Until fixed, treat every `ask` enumeration as a sample, never a list. `nimbus query` and
   `nimbus search` are unaffected and return the full set.

---

## F15 — semantic search is DEAD in every compiled release: the embedding worker is not bundled

**Severity: critical.** Model-independent. Works in dev, broken in every shipped binary —
which is exactly why it survived.

### Symptom

Every gateway heartbeat, once per minute, since boot:

```json
{"event":"heartbeat","uptimeSec":480,"embeddings":"unavailable","msg":"gateway alive"}
```

And at startup:

```
[gateway] starting embedding runtime (background)
embedding worker error: BuildMessage: ModuleNotFound resolving "B:\~BUN\root\embedding-worker.ts" (entry point)
embedding worker failed to initialize; semantic search disabled until the next gateway restart
[gateway] embeddings: unavailable
```

### Root cause

`embedding/worker-bridge.ts:46`:

```ts
worker = new Worker(new URL("./embedding-worker.ts", import.meta.url).href);
```

`grep -rn "embedding-worker" scripts/build-release.ts scripts/build-debug.ts` returns
**nothing** — the worker is never passed to `bun build --compile` as an additional entry point.

Inside a compiled binary `import.meta.url` resolves to Bun's virtual filesystem root,
`B:\~BUN\root\`, where no `.ts` source exists. The URL is resolved at RUNTIME, so the bundler
never sees the dependency and never includes it. Running from source works — the `.ts` file is
really there — so dev, CI and every test pass while every packaged build ships a dead worker.

### Measured consequences

| observation | value |
|---|---|
| `embedding_chunk` rows, ALL services | **0** |
| `vectorRank` on every `nimbus search` result | **`null`** |
| heartbeat `embeddings` | `"unavailable"`, every 60 s |
| `<dataDir>/models/` (the embedder cacheDir) | never created |

The whole hybrid-retrieval subsystem is inert in shipped builds: `PROSE_HEAVY_TYPES` routing,
the 384/1536 dual-table design, the V30 migration, `vectorSearchChunksDual`. `nimbus search`
silently degrades to BM25-only. `buildLocalIndexedContext` requests
`{ semantic: true, contextChunks: 2 }` and gets nothing.

### No user-facing surface reports it

The gateway KNOWS — it logs the failure at startup and republishes `embeddings: "unavailable"`
in every heartbeat. But:

- `nimbus doctor` prints `[ok] Index: 14630 items.` and says nothing about embeddings.
- `nimbus status --verbose` carries an `embeddingBackfill` field that is `null` and prints
  nothing when null.
- `nimbus search` returns results with `vectorRank: null` and no note that the vector half
  never ran.

A user has no way to learn that half of the retrieval system is switched off. The degradation
is graceful in code (`new Worker` is try/caught, returns `null`) and silent in product.

### Recovery is also broken

`nimbus index reembed --model local --service cloudwatch --yes` fails, twice over:

```
ERROR: Cannot find module ... sharp (missing win32-x64 platform binary)
ERROR: undefined is not an object (evaluating 'TASK_ALIASES[task]')
```

So the documented repair path cannot rebuild what the worker failure left empty.

Minor papercut found alongside: `reembed` accepts only `Xenova/all-MiniLM-L6-v2` or `local`
(`ipc/index-reembed-rpc.ts:103`), while `[embedding] model`'s default value is
`all-MiniLM-L6-v2` — copying the configured model name into `--model` is rejected as
`Unsupported model`.

### Suggested fix

1. Add `embedding/embedding-worker.ts` as an explicit entry point in `build-release.ts` /
   `build-debug.ts`, or replace the runtime-resolved `new URL(..., import.meta.url)` with a
   statically analysable specifier the bundler can follow.
2. **Add a smoke test that runs against the COMPILED artifact**, not the source tree. Every
   existing test passes here; only the packaged binary is broken. Assert
   `embeddings !== "unavailable"` after boot.
3. Surface the state: `nimbus doctor` should report embeddings unavailable as a `[warn]`/`[fail]`
   line, and `nimbus search` should disclose when the vector half did not run.
4. Fix the `sharp` platform dependency so `reembed` can repair an empty index.
5. Accept `all-MiniLM-L6-v2` as a `--model` alias.

### Scope is wider than this section's title — see F22

The same runtime-resolved-`new Worker` pattern breaks `db/query-guard-worker.ts` too, so
`nimbus query --sql` is dead in every release as well. Both of the codebase's two `new Worker()`
sites are affected — 2 of 2 — and neither build script mentions a worker at all. Fix the class,
not this instance.

### Bearing on F1b

This RESOLVES the bound recorded under F1b. Semantic search could not have rescued the
mid-token `"Fargate"` query, because the vector path has never run on this machine — not
because the model directory was deleted. The deletion was a red herring: `models/` is a
download-on-demand cacheDir, and the download never happens when the worker cannot start.

---

## F16 — `nimbus vault set` and `vault delete` can NEVER succeed: the HITL prompt is never registered

**Severity: critical.** Model-independent. Two documented commands that always time out.

### Symptom

```
$ nimbus vault set azure.tenant_id "6875a760-…"
IPC request timed out after 30000ms: vault.set

real 0m30.198s
```

Reproducible every time, exactly 30 s, against a healthy responsive gateway
(`nimbus status` returns instantly, uptime 1746 s). Nothing is stored —
`nimbus vault list azure` stays empty afterwards.

### Root cause — an IPC seam wired on one side only

`vault.set` and `vault.delete` are both in the HITL frozen set
(`engine/executor.ts:107-108`, invariant I2), so the gateway emits a `consent.request`
notification and blocks until it is answered.

The handler for that notification exists — `lib/interactive-ipc-handlers.ts:22`:

```ts
client.onNotification("consent.request", async (params: unknown) => { … })
```

`agent-cli-dispatcher.ts` registers it correctly:

```ts
await client.connect();
registerInteractiveCliIpcHandlers(client);
```

`commands/vault.ts` does not — all four subcommands go through bare `withGatewayIpc`:

```ts
await withGatewayIpc((c) => runVaultSet(c, key, value));      // :47
await withGatewayIpc((c) => runVaultGet(c, key));             // :55
await withGatewayIpc((c) => runVaultDelete(c, key));          // :63
await withGatewayIpc((c) => runVaultList(c, prefix));         // :68
```

and `withGatewayIpc` registers a handler only when the caller supplies one
(`opts.onConnect?.(client)`). So the gateway asks for consent, nobody is listening, and the
request dies at the client's 30 s timeout.

`vault get` and `vault list` work because they are NOT HITL-gated. Exactly the two mutating
subcommands are dead.

### The docs actively route users into it

- `ipc/index-reembed-rpc.ts:97` — *"openai.api_key missing in vault. Run `nimbus vault set
  openai.api_key <key>`."*
- `ipc/http-write-routes.ts:148` — *"set http_api.deployment_token via 'nimbus vault set
  http_api.deployment_token <value>'"*
- `nimbus help` lists `nimbus vault set <k> <v>   Store a secret`

Every one of those instructions leads to a 30-second hang. Note this also means F15's
suggested OpenAI-embedding workaround (`nimbus vault set openai.api_key`) is unreachable —
two criticals compounding.

### The failure mode is DOCUMENTED, beside the helper that prevents it

`lib/interactive-ipc-handlers.ts:43-45`, the doc comment on
`registerAutoApproveConsentHandler`:

> *"Registering this handler on a client is what turns an otherwise-hanging HITL call into a
> completed one — without a `consent.request` handler the Gateway's gate never receives
> `consent.respond` and the request dies on the client's 30s timeout."*

That is F16, described exactly, in the repo, as a warning. TWO working patterns exist beside it:

| pattern | helper | used by |
|---|---|---|
| interactive prompt | `registerInteractiveCliIpcHandlers` | `agent-cli-dispatcher.ts` (all agent commands) |
| flag-driven auto-approve | `registerAutoApproveConsentHandler` | `connector remove --yes` |

Verified live: `nimbus connector remove azure --yes` prints
`[--yes] auto-approving HITL request: Action requires your approval / Type: connector.remove`
and completes — same gate, same gateway, same second. `commands/vault.ts` uses NEITHER helper.

So this is not an unknown hazard. It is a known hazard with two shipped mitigations, and the
two vault mutation commands are wired to neither.

### Why it survived review

This is the shape the repo's own notes call out: both sides of an IPC seam exist and are
individually tested, so a per-side test proves the ENDS and never the WIRE.
`commands/vault.test.ts` injects `confirm` as a dependency and asserts
*"prints the value when confirm returns true"* — testing the CLI half against a fake, while
the gateway half is tested separately. No test connects a real CLI vault command to a real
gateway and observes that consent is never requested of anyone.

### Workaround

`nimbus connector auth` writes vault keys through a different, non-gated RPC and works:

```
nimbus connector auth azure --azure-tenant-id <t> --azure-client-id <id> --azure-client-secret <secret>
nimbus connector auth aws   --aws-profile default
```

(`commands/connector.ts:237-239`, `:233-236`.) Verified working for `aws.profile` on this
machine while `vault.set` timed out.

### Suggested fix

1. Pass `onConnect: registerInteractiveCliIpcHandlers` from `commands/vault.ts` — one argument,
   all four subcommands.
2. Better: make `withGatewayIpc` register the interactive handlers by DEFAULT and require
   opting out, so a new command cannot forget. A CLI connection that cannot answer
   `consent.request` should be the exception, not the default.
3. Add an e2e test that runs a real `nimbus vault set` against a real gateway subprocess and
   asserts the key is stored — the layer the repo's own testing philosophy already prescribes
   ("E2E CLI tests use a real Gateway subprocess").
4. Fail fast rather than hanging: if a HITL-gated request gets no consent handler on the
   connection, the gateway should reject immediately with an actionable error instead of
   letting the caller burn 30 s.

---

## F17 — interactive OAuth runs on the default 30 s IPC timeout

**Severity: high.** Model-independent.

### Symptom

```
$ nimbus connector auth onedrive --port 8765
IPC request timed out after 30000ms: connector.auth
```

The browser had opened and the user was still on Microsoft's sign-in page when the CLI gave up.

### Root cause

`commands/connector.ts:908-915`:

```ts
const res = await withIpc((c) =>
  c.call<{ ok: boolean; serviceId: string; scopesGranted: string[]; verified?: ... }>(
    "connector.auth", params),
);
```

No `requestTimeoutMs` — so the call inherits the client default of 30 000 ms. `withIpc` accepts
the parameter (`connector.ts:84-92`) and forwards it to `withGatewayIpc`; the auth path just
never supplies one.

Every other IPC call is a local request that returns in milliseconds. `connector.auth` is the
one method whose duration is bounded by **a human using a web browser** — locating the window,
signing in, MFA, reading and granting a consent screen. 30 s is routinely too short.

### Why this is worse than a slow command

The gateway owns the PKCE callback server and continues the flow after the client gives up.
So a completed sign-in AFTER the timeout can still store a credential while the user has been
told the command timed out. The CLI's report and the vault's state can disagree, with no way
for the user to tell which happened short of `nimbus vault list`.

This compounds F11's diagnostic difficulty: a user who sees `timed out`, retries, and
half-completes several flows has no way to know which attempt produced the stored token.

### Suggested fix

1. Pass an explicit, generous `requestTimeoutMs` for `connector.auth` — the flow is bounded by
   the gateway's own PKCE server lifetime, which should be the real deadline.
2. Better: make the OAuth flow a long-running job with progress notifications (the pattern
   `index.reembedProgress` already uses), so the CLI can wait indefinitely, print "waiting for
   browser sign-in…", and be cancellable.
3. Until then the timeout message should say the flow may still complete in the background and
   name `nimbus vault list` / `nimbus connector status <svc>` as the way to check.

### Adjacent, observed the same session

The app registration itself must be created with the right audience, or the browser fails
before Nimbus is involved at all:

```
unauthorized_client: The client does not exist or is not enabled for consumers.
```

`az ad app create` defaults to `signInAudience: "AzureADMyOrg"` (single tenant), while Nimbus
authorizes against `https://login.microsoftonline.com/common/`, which admits personal Microsoft
accounts. A personal account against a `AzureADMyOrg` app is rejected by Microsoft. The app
needs `--sign-in-audience AzureADandPersonalMicrosoftAccount`. Not a Nimbus defect, but
`nimbus connector auth onedrive --help` documents the registration steps and omits this, which
is where a user will get stuck. Worth adding to that help text.

---

## F18 — the OAuth provider's error code is captured, then discarded at every layer

**Severity: high.** Model-independent. Makes every OAuth failure undiagnosable.

### Symptom

A OneDrive sign-in fails. The user is told, in full:

| layer | message |
|---|---|
| browser | `Authorization was denied. You can close this window.` |
| gateway log | *(nothing — no OAuth line is ever written)* |
| CLI | `OAuth authorization did not complete` |

Microsoft returned a specific machine-readable reason. None of the three surfaces carries it,
so the user cannot tell "you clicked Deny" from "admin consent required" from "invalid scope".

### The code is captured and then dropped, twice

`auth/pkce.ts:125-131` — the callback stores the real code, then renders a message that
asserts one specific cause for ALL of them:

```ts
const err = u.searchParams.get("error");
if (err !== null && err !== "") {
  sink.value = { error: err };                                  // captured
  return new Response("Authorization was denied. You can close this window.", { … });
}
```

`access_denied`, `consent_required`, `interaction_required`, `invalid_scope`,
`unauthorized_client` and `server_error` all render as "denied". Only the first is actually a
denial; the message is wrong for the rest.

`auth/pkce.ts:183-185` — the value survives all the way to the throw and is dropped there:

```ts
const done = completion.value;
if ("error" in done) {
  throw new Error("OAuth authorization did not complete");      // `done.error` in scope, unused
}
```

`error_description`, which providers populate with a human-readable sentence, is never read at
all — not even into `sink.value`.

### Why it matters beyond tidiness

This is the third consecutive OAuth defect on one flow (F11 misattribution, F17 timeout, F18
opacity) and it is the one that makes the other two expensive. F11 took roughly an hour of
black-box probing — vault-blob timestamps, health-history rows, a bespoke PowerShell prober —
to establish a fact the provider had already stated in a field Nimbus had in hand.

Contrast the SAME session: `unauthorized_client: The client does not exist or is not enabled
for consumers` reached the user verbatim, because Microsoft rendered it on its own page before
redirecting. That error was diagnosed and fixed in one round trip. Every error that arrives
through Nimbus's callback instead is flattened to "denied".

### Suggested fix

1. `throw new Error(\`OAuth authorization did not complete: ${done.error}\`)` — one line,
   restores the code to the CLI.
2. Capture `error_description` alongside `error` in `sink.value` and include it.
3. Make the browser page state the actual code rather than asserting denial; reserve
   "Authorization was denied" for `error=access_denied`.
4. Log the failure server-side — `auth/*` currently writes no OAuth line at any level, which is
   also F10's secondary finding. One `logger.warn({ provider, error, description })` closes both.

---

## F19 — `nimbus help` omits 27 of the 65 dispatchable commands, including 9 of the 14 agents

**Severity: medium-high.** Model-independent. Pure discoverability, but it is the reason a user
routes everything through `ask` — the one surface carrying F1, F12 and F14.

### Measured

`nimbus help` is what a user gets on `nimbus`, `nimbus --help`, and on **every unknown command**
(`dispatchCommand` prints it before exiting 1). It names 38 of them (plus `version`, which is an
alias, not a handler). `COMMAND_HANDLERS` in `packages/cli/src/index.ts` dispatches 65. The 27
absent from the help text:

```
admin  bench  chatops  conflicts  data  decisions  egress  ghost  huddle  identity
janitor  lan  mcp-server  negotiate  owners  policy  pre-mortem  preflight  prove
scim  security  share  team  tribal  update  verify-share  why
```

Every one of the 27 is documented in `docs/cli-reference.md` — none is deliberately hidden.
Among them:

| omitted | what it is |
|---|---|
| `why` `ghost` `conflicts` `huddle` `janitor` `decisions` `pre-mortem` `negotiate` `owners` | **9 of the 14 built-in read-only agents** |
| `prove` | the S1 flagship primitive — the whole point of the egress ledger |
| `mcp-server` | the ecosystem entry point (`@nimbus-dev/mcp` execs it) |
| `update` | self-update — a user cannot discover how to upgrade |
| `share` `team` `identity` `scim` `policy` `tribal` `chatops` | the entire Phase 6 Team surface |

Verified on the 2.10.0 binary command-by-command (each of the 27 runs and prints its own usage),
and re-derived from `origin/main` (`9b905f16`, post-2.12) source — the gap is unchanged.

### Root cause

Nothing checks help-text coverage against the dispatch map. `COMMAND_NAMES` in
`commands/registry.ts` is now in sync with `COMMAND_HANDLERS` (65 = 65, zero diff both ways —
the drift recorded on 2026-07-19 has been paid off), but the only gate that reads it,
`audit:readme-cli`, runs in the direction that cannot catch this:

```ts
// scripts/audit/readme-cli-commands.ts
const missing = readmeCommands.filter((c) => !registered.has(c));
```

README → registry. A command that exists and is documented but never mentioned in
`docs/README.md` is invisible to the gate — and `docs/README.md` names **none** of the 27.

The gap is already known, and was patched pointwise rather than closed. From
`commands/help.test.ts:50`:

> *"`audit:readme-cli` only validates README→registry, so nothing else catches a command that is
> registered and documented but missing from `nimbus help`. `nimbus stats` was."*

So one command was noticed, hard-coded into an assertion, and the other 27 left in place.

### Why a frontier model does not fix this

No model is involved. It is worth filing in a local-LLM audit for one reason: a user who cannot
see `nimbus why`, `nimbus ghost` or `nimbus decisions` asks `nimbus ask` instead, and `ask` is
where F1 (raw-sentence FTS), F12 (`github_actions` swamping), F14 (silent truncation at 8) and
F21/F23 live. The discoverability defect *feeds* the retrieval defects.

### Suggested fix

1. Add the missing commands to `help.ts`, grouped — the list is long enough that flat is unusable.
   A `nimbus help <topic>` split (`agents`, `team`, `index`, …) is the better shape if the top-level
   list is to stay readable.
2. Replace the per-command `expect(out.stdout).toContain(...)` assertions in `help.test.ts` with a
   **set-difference test over `COMMAND_HANDLERS`**, with an explicit, justified `HIDDEN` allow-list
   for anything genuinely internal (`bench`, `admin`, `data` are the plausible candidates). Written
   as what cannot pass, not as a sample of what may.
3. Add the reverse direction to `audit:readme-cli` — or accept that README coverage is a product
   decision and put the enforcement solely in (2).

> Do not fix this by adding 27 lines and no test. The `nimbus stats` precedent is exactly that fix,
> applied once, and the list drifted 27 wide behind it.

---

## F20 — `--not-touching` accepts any string as a glob, and a non-matching pattern returns EVERY PR as satisfying the negation

**Severity: high.** Model-independent — no LLM is involved anywhere in this path. This is the
failure mode the whole negation feature exists to prevent: for a negation, a row the filter fails
to exclude is not a *missing* answer, it is a *wrong* one.

### Symptom

Measured against the live index (`github`, 173 PRs, all 173 with indexed file coverage):

| `--not-touching <pattern>` | rows returned | excluded |
|---|---|---|
| *(no predicate — baseline)* | 173 | — |
| `packages/gateway/**` | 124 | 49 ✅ |
| `packages/gateway/*` | 124 | 49 |
| `packages/gateway` | **173** | **0** ❌ |
| `Packages/Gateway/**` | **173** | **0** ❌ |
| `packages\gateway\**` | **173** | **0** ❌ |
| `/packages/gateway/**` | **173** | **0** ❌ |
| `./packages/gateway/**` | **173** | **0** ❌ |
| `**/*.ts` | 77 | 96 |
| `*.ts` | 77 | 96 |

Five of the most natural ways to write that path return every single PR — including all 49 that
do touch `packages/gateway/` — as an answer to *"which PRs did not touch packages/gateway?"*.

On Windows, where this was measured, the backslash form is what a user gets from Explorer,
from `Copy as path`, and from `path.join`. It silently disables the filter.

### The disclosure line reports nothing wrong

```
Gaps: 0 excluded (no file coverage indexed); 0 excluded (file coverage truncated)
```

Identical output for a correct pattern that legitimately excludes nothing and for a pattern that
is simply wrong. The Gaps accounting — which exists specifically to make a negation honest, and
which is described in `nimbus query --help` as *"part of the answer, not debug output"* — covers
**unverifiable rows only**. It has no notion of *"your pattern matched zero indexed paths"*, which
is the case where the answer is not merely incomplete but inverted.

### Root cause

`index/negation-predicates.ts:182` `buildNotTouchingSql` binds the caller's string straight into
SQLite `GLOB` with no validation:

```ts
AND NOT EXISTS (
      SELECT 1 FROM pr_changed_file f
       WHERE f.item_id = i.id AND f.path GLOB ?1
    )
```

Two properties of SQLite `GLOB` the surface never states:

- **It is case-sensitive.** This is *deliberate* and correct — the doc comment says so
  (*"GLOB, never LIKE: LIKE is case-insensitive and treats `_` as a wildcard, both measured, both
  wrong for paths"*). The defect is not the choice; it is that a case mismatch fails **open** and
  silently, on the two platforms whose filesystems are case-insensitive.
- **`*` crosses `/`.** So `**` and `*` are the same pattern (124 = 124, and 77 = 77 above), and a
  user's minimatch/gitignore intuition — `*` is one segment, `**` is recursive — does not hold in
  either direction. `--not-touching 'src/*'` excludes `src/a/b/c.ts` too.

And a pattern with no wildcard at all is not a prefix — `GLOB 'packages/gateway'` requires the
whole path to equal that string, so it matches no file, excludes no PR, and the negation degrades
to "return everything".

### Why the substrate probe does not catch it

The feature already refuses when it has nothing to answer from — `--explain` shows
`substrate probe: SELECT COUNT(*) AS n FROM pr_files_state / passed=true rowCount=173`, and on an
empty substrate the query refuses with exit 1 (verified: `--no-downstream-incident` on this index,
which has no `correlates_with` edges, exits **1** with *"cannot be verified"* and a remediation
line). So the design plainly accepts the principle *"do not answer a negation you cannot verify"*.
It just probes the wrong thing: whether the **table** has rows, never whether the **pattern** does.

### The precedent is already in this codebase

`nimbus people list --not-reviewed` gets this right, on the same feature, in the same release:

```
Window: ALL TIME — no --since given, so this reports "never reviewed, ever", not a recent window
Gaps: 80 excluded (no graph entity of the required type)
```

It states the window it actually used, and it reports a non-zero exclusion count. `--not-touching`
should be held to that.

### Suggested fix

1. **Probe the pattern, not just the table.** Before composing the answer, run
   `SELECT COUNT(*) FROM pr_changed_file WHERE path GLOB ?`. Zero is the interesting case, and it
   has exactly two readings — "genuinely nothing touches this" and "your pattern is wrong" — which
   is why it must be *disclosed*, not silently resolved either way. A line on the order of
   `Gaps: pattern matched 0 of N indexed paths — every PR below is unfiltered` is enough; a
   refusal is defensible too, and is consistent with the empty-substrate behaviour.
2. **Reject the forms that cannot be right.** A pattern containing `\` is not a repo path
   (`pr_changed_file.path` is always POSIX-separated); a leading `/` or `./` likewise. Fail these
   with a message naming the corrected form, rather than accepting them into a silent no-match.
3. **State the semantics in `--help`**: case-sensitive, and `*` crosses `/` so `**` adds nothing.
   Users will read `<glob>` as minimatch otherwise — that is what `**` means everywhere else.
4. Red-prove each with a test that a wrong-case / backslash / no-wildcard pattern does **not**
   return a PR that touches the path.

> `nimbus query --help` promises *"an empty substrate refuses with exit 1"*. That promise is kept.
> The gap is that a pattern matching nothing is not an empty substrate, and produces a confident
> wrong answer where an empty substrate produces an honest refusal.

---

## F21 — under `prefer_local`, `ask` answers a negation question with no predicate, no disclosure, and no refusal — turning a fail-closed refusal into a confident assertion

**Severity: high.** The *inertness* is a known, documented bound. The **silence** is the finding.

### Symptom — the same question, two Nimbus surfaces, opposite answers

| question | `nimbus query` / `nimbus people` | `nimbus ask` |
|---|---|---|
| people who have never reviewed anything | 3 rows (`Asaf Golombek`, `nimbus-release-bot[bot]`, …) + `Gaps: 80 excluded (no graph entity of the required type)` | **"No one."** |
| deployments with no downstream incident | **refuses, exit 1** — *"no `correlates_with` edges are indexed, so which deployments have no downstream incident cannot be verified"* + a remediation line | **"No downstream incidents found for any deployment."** |
| PRs that did not touch `packages/gateway` | 124 of 173, with a Gaps line | `Missing Dependency Assist — skipped (rank 2, 6, 7)` / `Wingetbot PR Triage — skipped (rank 3, 8)` |

Row 2 is the sharpest. The structured surface **refuses to answer** because the substrate to
answer it does not exist. The model surface answers anyway, in the affirmative, in a sentence a
user would reasonably read as *"I checked; there were none."* Nothing in the output says a
predicate was unavailable.

Row 3 is F12c recurring — the internal `rank` field leaking into prose — on top of a
non-responsive answer.

### The bound is documented; the silence is not

`CLAUDE.md` records W6-B.2 accurately:

> *"…plus the MCP server, with exclusion-count disclosure guaranteed only on the engine surface
> and — the local-router (`[llm].prefer_local = true`) path having no tool-calling support at all
> — inert there."*

So "the predicates do not run under `prefer_local`" is known and written down. What is neither
recorded nor implemented is that **the user is never told**. A documented limitation that the
product does not surface is, from the user's chair, a wrong answer.

### Root cause

`engine/run-conversational-agent.ts` `runTurn` forks:

```ts
if (llmRouter !== undefined && shouldUseLocalRouter(p)) {
  try { return await runViaLocalRouter(llmRouter, promptArg, p); }   // ← no tools, ever
  catch (e) { … fall back to agent … }
}
return await runViaAgent(p.agent, promptArg, p, maxSteps);           // ← the only path with tools
```

`runViaLocalRouter` calls `llmRouter.generate({ task, prompt, systemPrompt, maxTokens, … })`.
There is no `tools` argument in the shape at all. The three negation tools
(`engine/negation-tools.ts`) are registered on the Mastra agent only.

The disclosure machinery is downstream of the tools, so it fails silently with them:

- `negation-disclosure.ts` `recordNegationDisclosure` is called **by a tool**. No tool call, no
  record.
- `drainNegationDisclosures()` returns `[]`.
- `appendNegationDisclosures` is documented as *"Identity when nothing was recorded"* — and that
  is exactly right for its own contract. It cannot distinguish "nothing to disclose" from "the
  disclosing component never ran".

The design is careful about the adjacent case and gets it right: `negationDisclosureLine` returns
`undefined` for an all-zero exclusion set, reasoning that *"a line claiming '0 excluded' would
imply a shortfall that did not happen."* The same care was not applied one level up, where the
absent line means the predicate never existed.

Note the fail-closed refusal is genuinely built and genuinely works — `missingSubstrateRefusal`
carries a message, a remediation, and an `explain` block, and the CLI honours it with exit 1. Under
`prefer_local` that refusal is simply never reached, because nothing consults the substrate.

### Why a frontier model does not fix this

It does not — and that is the point. Route the same question to a tool-capable provider and the
predicate runs, so the defect *appears* to be about model capability. It is not: the gap is that
the engine silently degrades from "verified answer or honest refusal" to "unconstrained
generation over F1's context", with no marker at either end. A weaker model makes it visible
sooner; a stronger one would produce a more plausible wrong answer.

### Suggested fix

1. **Detect the question, not the answer.** When a turn takes the local-router branch, the tools
   are known to be unavailable — that fact is available *before* generation, from
   `shouldUseLocalRouter(p)` alone. Append a disclosure whenever the branch is taken and the
   prompt is negation-shaped, on the order of:
   `Negation predicates were not consulted — the local model has no tool access. Run the same
   question through nimbus query/people for a verified answer.`
2. **Or give the local router tools.** `llama3.2` advertises `"capabilities": ["completion",
   "tools"]` and Ollama supports tool calling; `runViaLocalRouter` simply never passes any. This is
   the larger fix and the better one, and it would make the whole W6-B.2 apparatus real on the
   local path rather than nominal.
3. Either way, **red-prove it**: a test that asks a negation question with `preferLocal: true` and
   asserts the reply is not a bare confident negative. Today's suite cannot fail here — the
   disclosure tests exercise the tool path, which this branch never enters.

> Sequencing note: (1) is honest and small; (2) makes the feature work. (1) should not be treated
> as closing the finding if (2) is the intent — a disclosure that permanently explains why a
> shipped feature does nothing is a worse resting place than either end state.

---

## F22 — the SECOND unbundled worker: `nimbus query --sql` is dead in every compiled release

**Severity: high.** Same root cause as F15, different subsystem. Both of the codebase's two
`new Worker()` sites are broken in shipped binaries — **2 of 2**.

### Symptom

```
$ nimbus query --sql "SELECT COUNT(*) AS prs FROM item WHERE type='pr'"
BuildMessage: ModuleNotFound resolving "B:\~BUN\root\query-guard-worker.ts" (entry point)
$ echo $?
1
```

`--sql` is documented in `nimbus help` (*"read-only guard"*), in `nimbus query --help`, and in
`docs/cli-reference.md`. `git log -S worker -- scripts/build-release.ts scripts/build-debug.ts`
returns no commits — the string has never appeared in either script — so this has been broken in
every packaged build there has ever been, not merely since some regression.

As with F16, the docs actively route users into it. `docs/cli-reference.md:213`, on `nimbus
search`'s hard-rejected flags:

> *"Time, state and assignee filtering are not available here; use `nimbus query` for `--since`,
> or raw SQL via `nimbus query --sql`."*

### Root cause — F15's, verbatim

`db/query-guard.ts:54`:

```ts
const workerUrl = new URL("./query-guard-worker.ts", import.meta.url);
const worker = new Worker(workerUrl);
```

Resolved at runtime, so the bundler never sees the dependency; inside the compiled binary
`import.meta.url` is Bun's virtual root `B:\~BUN\root\`, where no `.ts` exists. Identical to
`embedding/worker-bridge.ts:46`.

`grep -rn "new Worker(" packages/*/src --include=*.ts` (excluding tests) returns exactly two
sites. Neither appears in `scripts/build-release.ts` or `scripts/build-debug.ts` — `grep -rn "worker"`
over both build scripts returns **nothing**. So the correct statement of F15's scope is not "the
embedding worker was forgotten" but **"no worker is ever passed to `bun build --compile`, and every
worker-backed feature is dead in every release."**

### Why this one is worse than it looks

`--sql` is the documented escape hatch for exactly the situations the rest of this audit is about:
when `ask` gives a wrong count (F23), when `search` misses (F1), when a Gaps line is
uninterpretable (F20), `--sql` is what a user reaches for to establish ground truth. It is the
first thing that fails.

It also fails *loudly and legibly* where F15 fails silently — the error names the missing module —
which is the only reason both are now attributable to one cause.

### Suggested fix

Fold into F15's fix rather than fixing separately:

1. A single list of worker entry points consumed by both build scripts, with
   `db/query-guard-worker.ts` and `embedding/embedding-worker.ts` in it.
2. A **static guard**: a `new Worker(` site whose entry file is not in that list fails the
   structure audit. Written as what cannot pass — two sites out of two were wrong, so the sample
   is not the exception.
3. F15's compiled-artifact smoke test should assert `nimbus query --sql "SELECT 1"` exits 0, in
   the same run that asserts `embeddings !== "unavailable"`. Both defects are invisible to every
   source-tree test and to CI.

---

## F23 — `ask` answers an index-wide COUNT from its retrieved context, and the number is not even an integer

**Severity: high.** F14's sibling: F14 truncates enumerations at 8, this miscounts by two orders of
magnitude. Model-independent guard gap — no surface asserts that a count must come from the index.

### Measured

`nimbus ask "how many PRs are in the index?"`, three runs on an unchanged index:

| run | answer |
|---|---|
| 1 | `There are 3 PRs in the index.` |
| 2 | `2.2 PRs: Wingetbot PR Triage (queued) and Wingetbot PR Triage (pending).` |
| 3 | *(empty)* |

Ground truth, from `nimbus query --service github --type pr --limit 1000`: **173**.

Two things beyond the wrong number:

- **`2.2 PRs`.** A count that is not an integer is proof the model is not counting anything — it is
  producing a plausible-looking token. No arithmetic over any set yields 2.2.
- **The two named "PRs" are not PRs.** `Wingetbot PR Triage` is a `github_actions` workflow run —
  F12b's swamping (11,361 `github_actions` items against 213 `github`) delivering non-PR items into
  the context of a question explicitly about PRs, where the model then counted them *as* PRs.

### Root cause

The same shape as F1 and F14: `buildLocalIndexedContext` retrieves a handful of ranked items,
those items become the prompt, and the model answers about **the context** while the user asked
about **the index**. Nothing distinguishes the two. For an enumeration this shows up as F14's
silent truncation; for a count it shows up as a fabricated integer — or here, a fabricated
non-integer.

A count is the worst case of the family: a truncated list at least *looks* partial, and F14's fix
is a disclosure line. A bare number carries no signal that it was derived from 3 items out of 173,
and users trust numbers more than lists.

### Why a frontier model does not fix this

A frontier model would say "based on the 3 items I can see" or decline — which is better, but it
is still an answer about the context. The index count is a `SELECT COUNT(*)`, available exactly and
instantly, and no model should be asked to estimate it. The guard is missing on Nimbus's side.

### Suggested fix

1. **Route count questions to the index, not the model.** A count/"how many" question over an
   indexed type is a structured query; answer it from `item` and let the model phrase the result.
2. Failing that, apply F14's disclosure at minimum — every answer built from a retrieved context
   must state the retrieved-item count and that it is not the index total. F14's fix, applied to
   counts as well as enumerations, closes the worst of this.
3. Fix the F12b type filter first: a question naming `PRs` should not retrieve `github_actions`
   items at all. That alone would have made run 2 impossible.

---

## F24 — an unknown `--service` gets a soft all-null envelope, so `deploy preflight --mode block` returns `ok` for a service that does not exist

**Severity: critical (24a).** Model-independent — no LLM anywhere on this path. A CI deploy gate
that fails **open** on the single most likely misconfiguration, with a test pinning the behaviour.

### 24a — the pre-deploy gate

```
$ nimbus deploy preflight --service totally-made-up --target-ref main --mode block
Deploy preflight — totally-made-up @ main  [ok]

  Active P1 incidents             0  [no_pagerduty_mapping]
  Failing CI runs                 0  [no_repos]
  Open PR merge conflicts         0  [no_repos]
$ echo $?
0
```

`totally-made-up` appears nowhere in `nimbus.toml`. The gate passes.

`--mode block` exists to stop a deploy, and the mechanism is the exit code
(`commands/deploy.ts:167`):

```ts
if (parsed.mode === "block" && result.verdict === "warn") process.exit(1);
```

The verdict vocabulary is `"ok" | "warn"` — there is no third value for *"I could not evaluate
this"*. `ipc/preflight-rpc.ts` answers an unknown service from `unconfiguredEnvelope()`, which
hard-codes `verdict: "ok"` and three zero-count checks. So:

- a service that is healthy, and
- a service that **does not exist**

are byte-identical apart from the gap labels, and both exit 0.

The same dispatcher serves `GET /v1/preflight/deploy`, which is the route the first-party
`packages/github-actions/preflight-query` action calls. Its `service` input is documented as
*"matches `[metrics.dora.<id>]` or `[ci.service.<id>]` in nimbus.toml"* — so a stale or typo'd id
is precisely the expected failure — and `render.ts:71` emits **no annotations at all** when the
verdict is `ok`. A workflow whose service id drifts out of `nimbus.toml` goes green and silent.

The contrast that makes this a defect rather than a choice: the same action has
`allow-gateway-failure: "false"` by default, so an **unreachable gateway** fails the workflow. The
transport is fail-closed. The configuration is fail-open.

### The behaviour is tested in, not merely untested

`packages/gateway/test/unit/ipc/preflight-rpc.test.ts:49`:

```ts
it("returns an unconfigured envelope (all checks gapped) when service has no config", …)
  expect(out.value.verdict).toBe("ok");
  expect(out.value.checks.failing_ci_runs.gap).toBe("no_repos");
```

So this is not a coverage hole — the fail-open verdict is asserted as the contract. Any fix has to
change that test deliberately, which is the right place for the decision to be visible.

### 24b — `metrics dora` reports the wrong reason, while `stats` refuses

**Severity: medium.** Same envelope, different consequence.

```
$ nimbus metrics dora --service github          # 'github' is NOT a configured service
DORA metrics — github (since 30d)
  Deployment Frequency  — deploys_per_day  n=0  [no_repos]        ← exit 0
$ nimbus stats pr-merges --service github
unknown service 'github' — add [metrics.dora.github] or [ci.service.github] to nimbus.toml
                                                                   ← exit 1
```

`no_repos` states that the service exists and has no repositories bound — a different, and much
more fixable-looking, problem than *"this service key was never defined"*. `DoraGap`
(`metrics/dora.ts:5`) has six members and no `unknown_service`.

The divergence is **deliberate and recorded** in `ipc/metrics-rpc.ts:145`:

> *"Deliberate asymmetry with `metrics.dora` below… `dora` returns a FIXED set of four metric
> slots that can be filled with `no_repos` placeholders, while `stats` returns a series whose
> shape depends on config it does not have — so there is nothing honest to place-hold, and a
> typo'd `--service` must say so rather than render 13 empty buckets that look like real thin
> data. Behaviour kept as-is; recorded, not fixed."*

The reasoning is about **shape**, and it holds: `dora` can place-hold, `stats` cannot. But the
sentence that justifies `stats`' refusal — *"a typo'd `--service` must say so rather than render
… data"* — applies to `dora` word for word. Four `no_repos` nulls under a header naming the
service also look like real thin data. The defect is not that `dora` answers softly; it is that it
answers with the **wrong reason**, and the gap vocabulary that exists to carry exactly this
information has no member for it.

### Suggested fix

1. **24a: add a third verdict.** `"unknown_service"` (or reuse `"warn"`) must make
   `--mode block` exit non-zero. A gate cannot have a pass-by-default branch for *"I do not know
   what you asked me about"*. Update `preflight-rpc.test.ts:49` in the same commit, and say in the
   message that the assertion is being inverted on purpose.
2. **24a: make the action loud.** `render.ts` should annotate an unknown service even in `warn`
   mode — a silent green is worse than a warning nobody reads.
3. **24b: add `unknown_service` to `DoraGap`** and use it in `unconfiguredEnvelope`. One enum
   member; the render already prints whatever gap it is handed. This keeps the recorded
   shape-based asymmetry intact while removing the misattribution — the decision the comment
   defends is not the one this changes.
4. Red-prove (1) with a test that `--mode block` on an unconfigured service exits 1. That test
   cannot pass today.

> The `stats` refusal is the in-codebase precedent and it is the right one — same as F13's
> `Stored: aws (not verified)` and F20's `people list --not-reviewed`. This is the third finding in
> this audit where one surface gets the honesty right and its sibling, over the same config, does
> not.

---

## F25 — a brief's standing disclosure is perfectly protected by I31 and factually false

**Severity: medium-high.** Model-independent. I31 guarantees a disclosure *survives*; nothing
guarantees it is still *true*.

### Symptom

`nimbus decisions --since 90d`, verbatim, on a 13,183-item index:

```
## Gaps

- Confidence tops out at 0.86, not 1.0. The corroboration term reserves its full score for
  migration/iac evidence — derived from a corroborating change's file paths — and **no connector
  indexes changed-file paths**, so that evidence is specified but never emitted. …
  (Read scores against a 0.86 ceiling, not a full-marks scale.)
```

The same gateway, in the same session, reports:

```
$ nimbus status
PR file coverage: 173 / 173
```

Changed-file paths are indexed — `pr_changed_file` / `pr_files_state` shipped at **V55**, 100%
covered for every indexed PR on this machine, and `nimbus query --not-touching` queries those very
rows (F20). The premise of the disclosure was true when written and is not true now.

### What is still true, and what is not

Both halves have to be stated separately, because only one is stale:

| claim | status |
|---|---|
| confidence cannot exceed 0.86 | **true** |
| `migration`/`iac` evidence is never emitted | **true** |
| *the reason* is that no connector indexes changed-file paths | **false since V55** |
| therefore: read 0.86 as full marks | **misleading** — it presents a closable gap as a permanent scale |

Verified by grep: the literals `"migration"` and `"iac"` as an `EvidenceKind` appear in exactly
three places — the union (`decisions/decision-types.ts:3`), the scoring read
(`decision-confidence.ts:33`) and the V47 `CHECK` constraint. **No site writes either kind.** The
kinds emitted by `decision-corroborate.ts` are `source`, `pr`, `commit` and `adr`. And
`packages/gateway/src/decisions/` contains no reference to `pr_changed_file` at all.

So the ceiling is real, but its cause is now *"the extraction pass was never wired to the
changed-file substrate"*, not *"the substrate does not exist"*. Those call for opposite actions:
the first is a small wiring task, the second is a permanent fact a reader should stop expecting to
change. The brief tells the user the second.

Sharpening it: an **`iac` connector also exists** (`connectors/iac-sync.ts`, registered in
`connector-catalog.ts`). The disclosure's premise is stale twice over.

### Why this is worth a finding rather than a typo fix

This is the complement of I31 and it is the reason to file it here. I31 does its job perfectly on
this exact sentence — the `## Gaps` section is constructed by the renderer, withheld from the
model, re-attached verbatim, and anchor-checked through `brief-disclosures.ts`. Every one of those
mechanisms operated correctly on a false statement, and each one made it *more* durable: it cannot
be paraphrased away, cannot be dropped by a rewrite, and reads with the authority of a
machine-generated disclosure.

A disclosure is load-bearing precisely because users cannot check it. Its correctness therefore has
to be maintained like a wiring site, not like prose — which is what the invariant triple rule
already says about every other defense in this codebase.

### Related, not claimed as a defect

`adr` evidence **is** emitted, but `corroboration()` counts only `pr`/`commit` (as `hasCode`) and
`migration`/`iac` (as `hasArtifact`). ADR presence is stored separately as `has_adr` and rendered
as a `⚠ no ADR found` marker. So the one artifact kind that is actually produced does not feed the
term that reserves its top score for artifacts. That may well be intended — recorded here so the
next reader does not have to re-derive it.

### Suggested fix

1. **Decide which way to close it, then say so.** Either wire `decision-corroborate.ts` to
   `pr_changed_file` so `migration`/`iac` become reachable and 1.0 is a real score, or drop the two
   kinds from `corroboration()` and rescale so the ceiling is 1.0. Leaving the ceiling with a
   corrected explanation is the worst of the three.
2. **Correct the sentence wherever it is restated** — `agents/decisions.ts:151` is the definition,
   and the `0.86` figure should be derived from `corroboration()`'s reachable maximum rather than
   written as a literal in prose, so the two cannot drift again.
3. **Give standing disclosures an expiry check.** A disclosure whose premise is a capability
   statement ("no connector indexes X") should have a test that fails when X becomes true — the
   same shape as the invariant tests. `pr_files_state` existing is a one-line assertion.

> Precedent for the mechanism, not the content: `brief-disclosures.ts` exists because two copies of
> a disclosure sentence drifted. This is the same failure one level up — the sentence and the
> world drifted instead.

---

## F26 — `negotiate` reports 0 PRs authored for the person who authored 160 of the 173 indexed PRs, because "you" resolves to the wrong half of a split identity

**Severity: high.** Model-independent. The brief's own source comment names this exact outcome as
the thing it most wants to avoid — and the disclosure built to prevent it cannot fire here.

### Symptom

```
$ nimbus negotiate --since 90d
# Negotiation brief
**Subject:** you
## PRs authored
- 0 PR(s), 0 merged
## PRs reviewed
- 0 review(s): 0 approved, 0 changes requested, 0 other/unknown
## Tickets      → 0 opened, 0 closed
## Decisions    → 0 attributed to you
## Writing      → 0 doc(s), 0 note(s), 0 message(s)
```

Ground truth on the same index: of the 173 indexed PRs, **160 carry `user: asafgolombek`** — the
subject. Only `## Ownership` comes back populated, with ~40 directories.

`--person <the person id>` gives the identical result, so this is not a `you`-only path.

### Root cause — two person records for one human, and the resolver picks the empty one

```
$ nimbus people search asafgolombek
5a5851f1-…  linked    Asaf Golombek  asafgolombek@gmail.com  items=36
fa7d1753-…  unlinked  asafgolombek   —                       items=203
   github=asafgolombek
```

`agents/_lib/self-person.ts` `resolveSelfPerson` tries, in order: an explicit override, then
**`git config user.email`**, then the OS username. Here `git config user.email` is
`asafgolombek@gmail.com`, which matches the 36-item Gmail/Drive record. The 203-item GitHub
identity is a separate, **unlinked** record that the resolver never reaches — `authored` edges hang
off it, and every graph-traversing lane in the brief walks from the person the resolver returned.

So the counts are *true of the record measured* and wildly false about the human. `nimbus people
link <a> <b>` exists and would fix it. Nothing anywhere tells the user that.

### The disclosure that exists cannot fire here

`agents/negotiate.ts` is unusually careful about exactly this class. Its own comment:

> *"an explicit `--person <id>` that resolves to nothing is NOT `personId === null` … Six lanes
> then each honestly return `0` and the document reads as a person who shipped nothing, **which in
> a compensation conversation is the worst possible failure**. A structural zero is not a
> measurement, so it must be labelled as one."*

`explicitSubjectGap()` implements that with two carefully distinguished arms — `none` and
`graph-only`. But its first line is:

```ts
if (match === "person") return null;   // "the ordinary case, which needs no disclosure"
```

`5a5851f1-…` **is** a `person` row. The id resolves. So the guard returns `null`, and the brief
renders six zeros with no note at all. The anticipated failure was *"the id matched nothing"*; the
one that happened is *"the id matched a real person who is only half of this human"* — which is
strictly more likely, because identity splitting is the normal state of a fresh index (email from
one connector, login from another) and is precisely what `nimbus people link` exists to repair.

### It is not confined to `negotiate`

`agents/catchup.ts` calls the same `resolveSelfPerson`. This is the upstream cause of **F3** —
`catchup`'s all-empty involvement block was recorded there as an honesty defect (it claims
personalisation it has no signal for), and this is *why* it has no signal. F3's fix (declare the
gap) stays correct; this finding is the defect underneath it, and fixing this one makes F3's
disclosure rare instead of universal.

### Why a frontier model does not fix this

Nothing here reaches a model. Six SQL lanes return 0 because the `from` id has no edges.

### Suggested fix

1. **Disclose a zero-edge subject.** Before rendering, count the subject's outgoing
   `authored`/`opened`/`reviewed` edges. Zero across all of them, for a person who *does* exist, is
   the same "structural zero, not a measurement" case the two existing arms handle — add a third
   arm rather than a new mechanism.
2. **Name the likely cause and the repair**, since both are knowable: if another `person` row or
   an unlinked identity shares this person's display name or a normalized handle, say so and point
   at `nimbus people link`. The remediation string already has the right shape — it tells users to
   run `nimbus people search <name>`; that is the command that surfaces the duplicate.
3. **Widen `resolveSelfPerson`.** Git email is one identity among several. Consider resolving to a
   *set* — git email, OS username, and any identity linked to either — and either union the lanes
   or refuse with the ambiguity named. Silently picking the first match is what produced this.
4. Red-prove: a fixture with two unlinked person rows for one human, one holding the `authored`
   edges, asserting the brief does not render a bare zero.

---

## F27 — an I31 anchor guards only the first sentence of a two-sentence disclosure, and the second was observed being dropped

**Severity: medium-high.** A real, narrow hole in a defense that otherwise works. Observed live,
not reasoned about.

### Symptom

Two consecutive `nimbus negotiate --person <id>` runs on an unchanged index. The synthesis is
non-deterministic, so one was discarded and one was accepted.

**Discarded run** (deterministic render — I31 worked):

```
_window: last 90d — items authored by the subject that were ACTIVE in this window; the index
records last-modified, not created. Two lanes sit outside it: decisions windows on its recorded
decision date, and ownership is not windowed at all (it is an all-time snapshot) · generated …_

_Rendered deterministically — a synthesis was attempted and discarded (the rewrite dropped a
required disclosure)._
```

**Accepted run** (`_Synthesized by llama3.2 (local)._`):

```
_window: last 90d — items authored by the subject that were ACTIVE in this window; the index
records last-modified, not created._
```

The second sentence is gone, and the brief shipped.

### Root cause

`agents/_lib/brief-disclosures.ts:119`:

```ts
line:
  `_window: last ${negotiateWindowLabel(sinceMs)} — items authored by the subject that ` +
  "were ACTIVE in this window; the index records last-modified, not created. Two lanes " +
  "sit outside it: decisions windows on its recorded decision date, and ownership is not " +
  `windowed at all (it is an all-time snapshot) · generated ${…}`,
anchor: "last-modified, not created",
```

One `line`, **two independent disclosures**, one `anchor` — and the anchor is a fragment of the
first sentence only. A rewrite that keeps sentence 1 and drops sentence 2 satisfies
`contractViolations` and ships.

Sentence 2 is not decorative. It says two of the brief's own sections — `## Decisions` and
`## Ownership` — are **not filtered by the window in the header above them**. Without it, a reader
applies "last 90d" to an all-time ownership snapshot. That is the same class of overstatement the
comment above the entry says the window clause exists to prevent.

`nimbus-security-invariants`' triple rule is satisfied here — wiring, docs and test all exist. The
gap is in the granularity of the check, not its presence.

### It is not the only entry with this shape

Of the nine anchors in the module, a second guards two sentences too —
`negotiateOwnershipDisclosure` (`:159`):

- sentence 1: *"this is authorship-derived ownership — who wrote the lines, not who is formally accountable."* → anchored on `"authorship-derived"`
- sentence 2: *"There is no CODEOWNERS and no on-call rotation in the index, and reviewer data (`reviewed` edges from GitHub PR reviews) is not factored into this ranking."* → **unanchored**

Sentence 2 again carries the substantive facts. The remaining seven anchors are single-sentence and
are fine.

`CLAUDE.md`'s own I31 text describes the anchor as *"the sentence's factual fragment"* — singular.
The design assumption is one sentence per entry; two entries break it.

### Suggested fix

1. **Make the unit of the contract a disclosure, not a `line`.** Split a two-sentence entry into
   two `Disclosure` records with their own anchors, or let one record carry `anchors: string[]`
   and require all of them. The former is cleaner and matches how the other seven already read.
2. Add an audit that fails when a `Disclosure.line` contains more than one sentence and only one
   anchor. This is checkable statically and is exactly the class of guard the module already
   exists to provide — `brief-disclosures.ts` was created because two *copies* drifted; this is
   two *halves* of one copy being unequally protected.
3. Red-prove by feeding `contractViolations` a rewrite with sentence 2 removed; it must fail.
   Today it passes.

> Scope note, stated because the doc's I31 entry already concedes a weaker version of it: the
> recorded bound is *"a phrase check proves a fragment survived, not that its sentence still means
> the same thing."* This is sharper — the surviving fragment is not in the dropped sentence at all,
> so no reading of "the same sentence" covers it.

---

## F28 — a reserved section reproduced WITHOUT a heading evades every heading-based strip, so F2's proposed one-line fix does not close the observed case

**Severity: high.** A correction to a recommendation made earlier in this document.

### Symptom

The same accepted `negotiate` synthesis as F27 carried this, ahead of the canonical sections:

```
 deploys triggered
Gaps:
category: missing_relation_emit
detail: No PagerDuty incident in the index is attributed to a person — either none carry an
        assignee or resolver, or their actor payloads carry no usable email.
remediation: Run `nimbus connector sync pagerduty`. …
category: missing_relation_emit
detail: No Sentry issue in the index is assigned to a resolvable person — …

## Sources                                    ← canonical, re-attached verbatim ✅
## Evidence not available from the index      ← canonical ✅
## Gaps                                       ← canonical ✅
```

Same leak as F2 — raw `category:` / `detail:` / `remediation:` field names in user-facing output,
duplicating a reserved section — with one difference that matters: **`Gaps:` here is not a
heading.** It is a plain paragraph line. So is the duplicated "deploys triggered" above it.

### Why this breaks F2's fix

F2 diagnosed `stripSections` correctly (`if (h.level !== 2) continue;` misses a *promoted* `# Gaps`)
and proposed `if (h.level > 2) continue;` — strip level ≤ 2 rather than exactly 2. That fix is
right for what it targets and should still land.

But it operates over `heads`, the parsed heading list. A model that writes `Gaps:` as body text
produces **no heading at all**, so it is not in `heads` under either the current rule or the
proposed one. The observed leak survives the proposed fix untouched.

This is worth stating plainly because F2 is described in this document's own priority section as a
*"one-line guard fix"* with the *"smallest diff"*. That framing is now wrong: it is a correct
one-line fix for one of at least two shapes, and shipping it alone would close the finding on paper
while the leak stays reproducible.

### The general form

The reserved-section defense is structured as *"the model never sees the canonical section, and any
section it invents under that heading is stripped."* The first half is airtight — it is
construction, not checking, which is exactly why I31 is strong. The second half assumes fabrication
arrives **as a heading**. It does not have to. A model reproducing remembered structure will
happily emit a label, a bolded line, a list item, or a fenced block.

### Suggested fix

1. Land F2's `h.level > 2` change — it is correct and independently needed.
2. Add a **content-shaped** strip alongside the heading-shaped one: the raw envelope field names
   (`category:`, `detail:`, `remediation:`) are internal and have no legitimate reason to appear in
   any rendered brief. A line matching them at the start of a line is fabrication by construction,
   whatever heading it sits under. That is a guard written as *what cannot pass*, which is the
   shape this codebase already prefers.
3. Better still, **keep them out of the model's reach.** The leak is of field names from the gap
   objects; if the synthesis prompt never contains the serialized envelope — only the rendered
   prose — the model cannot reproduce a field name it never saw. Check what the prompt actually
   carries before adding a stripper; F4 (the synthesis prompt leaking into output) suggests the
   prompt is the more productive place to look.
4. Red-prove with a fixture whose model output contains a non-heading `Gaps:` block. F2's test as
   proposed would pass this case while the leak ships.

---

## Not a Nimbus bug — genuine local-model weakness

Recorded so the fix list does not absorb them. **No action proposed.**

- **`catchup` prose confabulation.** Given 50 items all scored `0.1`, llama3.2 invented an
  analysis of workflow reliability. The *input* defect is F3; the invention is the model.
  A frontier model would summarise the same empty signal more gracefully.
- **Terse non-answers** (`"Missing context: egressRowToItem."`). Correct behaviour under the
  system prompt + `[persona] tone = "terse"` — given bad context (F1), this is the *desired*
  failure mode.
- **Numeric relationships inverted in an otherwise correct answer.** Asked
  `'In prose, what is the pull request about "clip source metadata"?'`, retrieval was
  CORRECT (PRs #1287 + #1288) and the model got `RAW_META_MAX_BYTES = 65,536` right, then
  reported: *"previously specified a 60 KB unknown member… this was incorrect… and the actual
  value is 60 KB."* Ground truth is the inverse — 60 KB was the OLD value that never crossed
  the ceiling; the test needs **70 KB** (70,112 bytes serialised). The correction was stated
  backwards, and the same sentence calls 60 KB both "incorrect" and "the actual value".
  Everything needed was in context; a frontier model would carry the relationship. Filed here
  rather than as a finding because no Nimbus surface could have prevented it — but it is worth
  knowing that a fluent, well-sourced brief can still invert a number.

- **Environment classification invented from identical names.** Asked which `RequiemNexus` log
  groups are staging versus dev, the model answered with two specific names — which are
  byte-identical apart from their random CDK suffix (`…ECA0B21D-HTHw8WdmK1J4` vs
  `…ECA0B21D-NquUSV4XQclj`) and contain neither `dev` nor `stag`. The real markers sit only on
  the Lambda groups (3 `-dev-`, 1 `-stagi-`). Retrieval was correct and the names were present
  verbatim; the model manufactured a distinction to satisfy the question's premise. Nimbus
  cannot prevent this — but it is the reason a brief's confident specificity is not evidence.

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
| F11 | One dead Google credential disables all 4 Google connectors | high | yes | gmail, drive, photos, meet |
| F10 | Google refresh token coerced to `""`; OAuth path logs nothing | med-high | yes | every OAuth connector |
| **F15** | **Embedding worker unbundled — semantic search dead in every release** | **critical** | yes | all hybrid retrieval |
| **F16** | **`vault set`/`vault delete` always time out — consent handler never registered** | **critical** | yes | every secret write via CLI |
| F18 | OAuth provider error code captured then discarded at all 3 layers | high | yes | every OAuth failure |
| F17 | Interactive OAuth on a 30 s IPC timeout | high | yes | every browser-based connector auth |
| F14 | `ask` truncates every enumeration at 8, undisclosed | high | yes | every `ask` list/count question |
| F13 | `sync succeeded` recorded with no credentials (F6's mechanism) | high | yes | every connector's health |
| F12 | Repo questions exclude PRs; `github_actions` swamps ranked search | medium | yes | `ask` on any repo |
| F7 | `people list` automated senders | low | yes | `people`, `expert` |
| F8 | `min_reasoning_params` dead config | low | yes | `[llm]` config surface |
| **F22** | **`query --sql` dead in every release — the SECOND unbundled worker (2 of 2)** | **high** | yes | `--sql`, and every ground-truth check |
| F21 | Under `prefer_local`, `ask` runs no negation predicate and discloses nothing — a fail-closed refusal becomes a confident assertion | high | yes | `ask`, desktop, VS Code |
| F20 | `--not-touching` glob unvalidated — 5 natural path forms return EVERY PR as "not touching" | high | yes | `nimbus query`, MCP `query` tool |
| F23 | `ask` counts its retrieved context, not the index (`3`, then `2.2`, vs 173) | high | yes | every `ask` count question |
| F19 | `nimbus help` omits 27 of 65 commands, incl. 9 of 14 agents, `prove`, `mcp-server`, `update` | med-high | yes | discovery of the whole product |
| **F24a** | **`deploy preflight --mode block` returns `ok` + exit 0 for a service that is not in config — a CI gate failing open, with a test pinning it** | **critical** | yes | every gated deploy, the first-party GitHub Action |
| F25 | A standing brief disclosure is I31-protected and false since V55 ("no connector indexes changed-file paths") | med-high | yes | `decisions`, and the disclosure contract generally |
| F24b | `metrics dora` reports `no_repos` for a service that does not exist, while `stats` refuses | medium | yes | `metrics dora` |
| F26 | `negotiate` (and `catchup`) resolve "you" by git email to the empty half of a split identity — six lanes render 0, no disclosure fires | high | yes | `negotiate`, `catchup` |
| F28 | A reserved section reproduced as plain text evades every heading-based strip — **F2's fix is incomplete** | high | yes | all 14 brief kinds |
| F27 | An I31 anchor guards only the first of two sentences; the second was observed dropped (2 of 9 entries) | med-high | yes | `negotiate` disclosures |

**Suggested first PR** (superseded by F24a — see below)**:** F2 — one-line guard fix (`h.level > 2`), a red-prove test, smallest
diff, closes a live output defect on all fourteen brief kinds.

**Suggested second PR:** F1 steps 1–2 (term extraction + honest empty context). Highest user
impact. F1 step 3 (`ftsTitleMatchQuery`) is deliberately deferred to its own PR — it changes
`nimbus search` semantics for every caller.

F3 and F6 are the same shape as each other (a surface asserting more confidence than its data
supports) and could reasonably land together.

**F22 does not get its own PR** — it is F15's fix with a second entry point and a static guard.
Landing F15 without it would fix one of two broken workers and leave the guard unwritten.

**F20 and F21 belong together** if only one is done: they are the two halves of the negation
feature's honesty story — the structured surface answering a wrong pattern confidently, and the
model surface answering with no predicate at all. Both are cheap relative to their severity.

**F19 is the one to do while waiting on a review.** Zero risk, no runtime behaviour, and it is
what stops a user from routing every question into `ask` — which is where five of these findings
live.

**F24a now displaces F2 as the first PR.** It is a CI deploy gate that passes on a typo, it is the
only finding here with a *security-gate* shape rather than an honesty shape, and its fix is one
enum member plus an inverted assertion in an existing test. F2 remains the best *second* PR on the
same "smallest correct diff" reasoning.

**F25 should be closed by deciding, not by rewording.** Correcting the sentence and leaving the
0.86 ceiling in place is the one outcome that makes the brief less useful than it is today: it
would swap a stale explanation for an accurate description of a gap nobody is on the hook to
close.

**F2 and F28 are one PR, not two.** F28 is the reason F2's diff is not one line. Landing F2 alone
closes the finding on paper and leaves the observed leak reproducible; the pair is still small.

**F26 should land before F3.** F3 is `catchup` declaring no gap beside an empty involvement block;
F26 is why the block is empty. Fixing F26 turns F3's disclosure from a permanent fixture into a
rare one, which is the difference between an honest product and an apologetic one.

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

# F19
nimbus help                               # names 38 of the 65 dispatched by COMMAND_HANDLERS
nimbus why ; nimbus prove ; nimbus ghost  # all run and print usage; none appear in the help above

# F20  (baseline 173 PRs, 49 of which touch packages/gateway)
nimbus query --service github --type pr --not-touching 'packages/gateway/**' --limit 500  # 124
nimbus query --service github --type pr --not-touching 'packages/gateway'    --limit 500  # 173 ❌
nimbus query --service github --type pr --not-touching 'Packages/Gateway/**' --limit 500  # 173 ❌
nimbus query --service github --type pr --not-touching 'packages\gateway\**' --limit 500  # 173 ❌
# every one of them prints: Gaps: 0 excluded ...; 0 excluded ...

# F21
nimbus people list --not-reviewed                  # 3 rows + "Gaps: 80 excluded"
nimbus ask "which people have not reviewed anything?"        # "No one."
nimbus query --service github --type deployment --no-downstream-incident ; $LASTEXITCODE  # refuses, 1
nimbus ask "which deployments had no downstream incident?"   # asserts none, exit 0

# F22
nimbus query --sql "SELECT 1"             # ModuleNotFound B:\~BUN\root\query-guard-worker.ts

# F23
nimbus ask "how many PRs are in the index?"                        # "3", then "2.2 PRs", then empty
nimbus query --service github --type pr --limit 1000               # 173

# F24a  (a CI deploy gate passing on a service that does not exist)
nimbus deploy preflight --service totally-made-up --target-ref main --mode block
$LASTEXITCODE                             # 0, verdict [ok], zero annotations

# F24b
nimbus metrics dora  --service github     # header + 4 nulls, gap "no_repos", exit 0
nimbus stats pr-merges --service github    # "unknown service 'github' — add [metrics.dora...]", exit 1

# F25
nimbus status                             # "PR file coverage: 173 / 173"
nimbus decisions --since 90d              # "...no connector indexes changed-file paths..."

# F26
nimbus people search asafgolombek   # TWO records: gmail (items=36) + github (items=203, unlinked)
git config user.email               # asafgolombek@gmail.com → resolveSelfPerson picks the 36
nimbus negotiate --since 90d        # 0 PRs authored, 0 reviewed, 0 tickets, 0 decisions, no gap note
nimbus query --service github --type pr --limit 500   # 160 of 173 have user: asafgolombek

# F27 / F28  (synthesis is non-deterministic — run until one is ACCEPTED)
nimbus negotiate --person <person-id> --since 90d
#  discarded run → preamble keeps "Two lanes sit outside it…", footer says
#                  "a synthesis was attempted and discarded"
#  accepted run  → that sentence is GONE (anchor is only "last-modified, not created"),
#                  and a plain-text "Gaps:" block with raw category:/detail:/remediation:
#                  rides above the canonical sections
```
