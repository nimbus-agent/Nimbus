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

### Bearing on F1b

This RESOLVES the bound recorded under F1b. Semantic search could not have rescued the
mid-token `"Fargate"` query, because the vector path has never run on this machine — not
because the model directory was deleted. The deletion was a red herring: `models/` is a
download-on-demand cacheDir, and the download never happens when the worker cannot start.

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
| F14 | `ask` truncates every enumeration at 8, undisclosed | high | yes | every `ask` list/count question |
| F13 | `sync succeeded` recorded with no credentials (F6's mechanism) | high | yes | every connector's health |
| F12 | Repo questions exclude PRs; `github_actions` swamps ranked search | medium | yes | `ask` on any repo |
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
