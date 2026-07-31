# `nimbus glossary` — LLM wiring, snippet upgrades, and manual refresh

> **Status:** approved 2026-07-31. Follow-up to
> [`2026-07-30-nimbus-glossary-design.md`](./2026-07-30-nimbus-glossary-design.md), which shipped as
> PR #981 (`bb0069c0`) and released in `v1.13.0`. Slice of **Spine S1 (Local Brain)**.
>
> This document covers three deferred follow-ups from that spec. It does **not** restate the base
> design — read §5 and §12 of the original first. Where the two disagree, this one is newer and the
> original is amended on landing (§6 below lists every claim that becomes false).

## 1. Why these three, together

The base slice shipped a complete extraction pipeline whose consolidation step never runs
unattended. `platform/assemble.ts` calls `runGlossaryPass` with no `llm`, so every definition the
user ever sees on a real machine is a verbatim snippet. The roadmap sells the feature on
"uses local LLM for the consolidation step"; today that is true only of a code path nothing
invokes.

Three follow-ups close that, and they are one unit rather than three because each is inert without
the ones before it:

1. **Wire an LLM into the scheduled pass.** Without this, nothing else matters.
2. **Upgrade existing snippet definitions.** Without this, (1) helps only terms discovered *after*
   the upgrade — `selectPendingBatch` reads `status='pending'` only, and a consolidated row never
   returns to `pending` on its own. A user who has been running the glossary for a week keeps a
   glossary of snippets forever.
3. **Wire `--refresh` / `--rebuild`.** Without this there is no way to see (1) and (2) take effect
   except by waiting for a connector sync, and no way to reset a wrong veto — the base spec names
   `--rebuild` as the only escape hatch for a sticky veto while leaving it unimplemented.

Deferred deliberately, unchanged from the base spec's §12: manual `[glossary.terms]` authoring
(needs a V46 migration — see §7) and `agents.*` unknown-parameter rejection (a namespace-wide
change to ten handlers, not a glossary change).

## 2. Local-only LLM selection

### 2.1 The posture problem

`[glossary]` is **default-on**, and §7 of the base spec justifies that with "local-only, no egress
— it reads the local index and writes local rows". Wiring in an LLM puts indexed third-party
content in front of a model. Whether that content leaves the machine now depends entirely on which
provider gets selected.

`LlmRouter.selectProvider(task, { preferLocal: true })` does **not** guarantee local. It walks
`providerPriority` — `["ollama", "llamacpp", "remote"]` under `preferLocal` — and returns the first
provider whose `isAvailable()` resolves true. With both local providers down it returns the remote
one. `createBriefLlm` accepts that, correctly: `[briefs]` is default-off and its docstring names
source-text egress as the most privacy-sensitive thing it does. A default-on background pass cannot
make the same trade.

**Measured scope of the risk, stated rather than overstated:** no `remote` provider is registered
anywhere in the gateway today. `buildLlmRegistryFromToml` adds exactly two providers, Ollama and
llama.cpp, and `addProvider` / `registerProvider` have no other production call site. So the two
options below are behaviourally identical on every machine that exists right now. The difference is
whether "no egress" is a property of the code or a property of the current registration list.

### 2.2 The adapter

New file `packages/gateway/src/glossary/glossary-llm-adapter.ts`:

```ts
export function createGlossaryLlm(router: LlmRouter): ConsolidatorLlm
```

Modelled on `briefs/brief-llm-adapter.ts`, with three deliberate differences.

**No `preferLocal` parameter.** There is no remote arm to prefer against. The adapter selects a
provider and rejects it if `isLocalProviderKind(provider.providerId)` is false, returning `null` so
consolidation falls through to the snippet path. The check is on `providerId` **before**
`generate()` — checking `LlmGenerateResult.isLocal` afterwards would be a report of egress that
already happened, not a guard against it.

This requires exporting a helper from `llm/router.ts`, where `LOCAL_PROVIDER_IDS` is currently
module-private:

```ts
export function isLocalProviderKind(id: LlmProviderKind): boolean {
  return LOCAL_PROVIDER_IDS.has(id);
}
```

Export-only; the set itself stays private so it keeps its single definition.

**Task type `"summarisation"`, not `"reasoning"`.** `meetsCapabilityFloor` applies the
`minReasoningParams` floor only to `reasoning` and `agent_step`. Consolidation reads a handful of
snippets and emits a small fixed JSON object — it is closer to summarisation than to reasoning, and
routing it through the reasoning floor would silently exclude exactly the small local models that
make a local-only guarantee viable on a laptop. `providerPriority` ignores its `task` argument, so
this choice affects the capability floor and nothing else.

**Returns the raw text.** `ConsolidatorLlm.generateJson` is
`(prompt, signal?) => Promise<string | null>`, where `BriefSynthesizerLlm` returns
`{ text, model, remote }`. The glossary stores `definition_source` as a two-value enum and has no
per-definition model disclosure, so the extra fields have no consumer.

### 2.3 The `signal` parameter

`ConsolidatorLlm.generateJson` takes an optional `AbortSignal`, and `GlossaryRefresher.stop()`
aborts in-flight passes. The adapter accepts the signal and returns `null` immediately if it is
already aborted, but **cannot propagate it to the provider**: `LlmGenerateOptions` has no `signal`
field, and both providers hardcode their own `AbortSignal.timeout(120_000)` on the underlying
`fetch`.

Not widening `LlmGenerateOptions` is a deliberate call, and the cost is small enough to state
exactly rather than hand-wave: one optional field in `llm/types.ts`, three `fetch` call sites
(`ollama-provider.ts` `generateBatch` + `generateStream`, `llamacpp-provider.ts` `generate`, each
currently `signal: AbortSignal.timeout(120_000)` and each becoming an `AbortSignal.any([...])`),
plus both provider test suites. Roughly fifteen lines.

It is deferred anyway because **the failure it would prevent is not reachable**. The worry is
cancelled passes stacking orphaned model runs, which requires repeated cancellation. The refresher
constructs exactly one `AbortController` for its lifetime (`glossary-refresh.ts:37`), `stop()`
aborts it and sets `stopped = true`, and `fire()` returns early forever after. So there is at most
**one abort per process, at shutdown, immediately before exit** — at which point the socket closes
and the provider's generation is torn down anyway. `withTimeout` in `glossary-consolidate.ts`
already races the abort, so the *wait* is bounded and shutdown is already responsive.

This is coupled to the `--force` cancellation deferred in §4.2: adding a way to cancel a running
pass mid-life is precisely what would make repeated aborts reachable, so the two must land
together or not at all.

### 2.4 Wiring

`SchedulerWithMeshOpts` gains one optional field:

```ts
glossaryLlm?: ConsolidatorLlm;
```

`assemblePlatformServices` builds the adapter from `llmRegistry` and passes it into
`createSchedulerWithMesh`, which threads it into the `runGlossaryPass` call inside
`createGlossaryRefresher`.

**On the Task 12 ruling.** That ruling declined to widen `SchedulerWithMeshOpts`, and it stands —
but it was about getting the refresher *out* for shutdown registration, where the alternative was a
`sidecarStops` out-parameter, a lifecycle smell. This is an *input* dependency, and the interface
already carries eight of them (`paths`, `vault`, `db`, `syncContext`, `localIndex`,
`notifications`, `syncLogger`, `isConnectorAllowed`). A ninth is squarely in pattern.

**Ordering is not a constraint.** A previous PR description claimed this was blocked because the
router is constructed after `createSchedulerWithMesh`. That is false: `buildLlmRegistryFromToml`
runs at `assemble.ts:1645` and `createSchedulerWithMesh` at `:1758`. The registry exists first, and
no late-binding holder (the `identityBootRefHolder` pattern at `:1669`) is needed.

### 2.5 The `use_llm` knob

`[glossary]` gains `use_llm` (default `true`). When false, `assemblePlatformServices` passes no
adapter and the pass keeps its current snippet behaviour.

This is one config knob against a YAGNI default, and it is here for a specific reason: the change
turns a pure-SQL background pass into up to 25 sequential local-model calls per sync burst, on a
default-on feature, on every machine with Ollama installed. §5.6 of the base spec already reasons
at length about local model memory pressure — it refuses to offer a concurrency knob precisely
because a laptop can be made to swap. `enabled = false` disables the whole feature; `use_llm` is
the narrower escape hatch that keeps the cheap snippet glossary.

Updated block:

```toml
[glossary]
enabled = true                 # local-only, no egress
use_llm = true                 # consolidate via a LOCAL model; false keeps the snippet path
max_new_terms_per_pass = 25    # shared budget; up to 5 slots reserved for snippet upgrades (§3.2)
stats_recheck_per_pass = 50
min_doc_freq = 3
debounce_ms = 60000
consolidate_timeout_ms = 30000
```

### 2.6 Making the snippet fallback visible

`use_llm = true` is the default, so the common failure is silent: Ollama is not running, or its
model was never pulled, and the user gets a glossary of raw snippets while believing a model
consolidated them.

Per-term labelling already exists — `agents/_lib/render.ts:295` marks a `definitionSource ===
"snippet"` entry in the brief. What is missing is the aggregate signal. Two additions:

- **A gap note in the brief** when consolidated terms are predominantly snippet-sourced. This is
  computed from the table (`COUNT(*) GROUP BY definition_source`), not from probing a provider, so
  it reports what actually produced the definitions the user is looking at rather than what is
  available right now. It reuses `category: "missing_connector"` because `GapCategory` is a closed
  union in the published `@nimbus-dev/sdk` and a new value would need an SDK release — the same
  slightly-off-label reuse the three existing glossary gap notes already make.
- **A `--refresh` warning.** `GlossaryPassSummary` gains `llmAvailable: boolean`, and the CLI prints
  `Warning: no local LLM provider was available — terms were consolidated from raw snippets.` when
  a pass consolidated anything with no model.

## 3. Snippet → LLM upgrade path

### 3.1 Selection

New `selectSnippetUpgradeBatch()` in `glossary-store.ts`:

```sql
SELECT * FROM glossary_term
WHERE status = 'consolidated' AND definition_source = 'snippet'
  AND (
    attempts = 0
    OR last_attempt_at + MIN(86400000, ? * (1 << (attempts - 1))) <= ?
  )
ORDER BY last_attempt_at ASC, score DESC
LIMIT ?
```

Called from `consolidatePhase` only when an `llm` is present — with no LLM, an "upgrade" would
re-derive the same snippet from the same sources and is pure waste.

### 3.2 Five decisions inside that query

**Shared budget, new terms first, with a reserved floor for upgrades.** The pass budget stays
`maxNewTermsPerPass` — worst-case latency is unchanged at 25 calls — but it is not allocated purely
first-come. The upgrade batch is queried first with `LIMIT UPGRADE_RESERVE` (a module constant, 5,
following the `NEAR_MISS_POOL` / `MAX_SYNONYMS` precedent rather than adding a config knob); if it
returns `k` rows, the pending batch takes `maxNewTermsPerPass - k`. With no upgrades outstanding,
`k = 0` and new terms get the entire budget. Execution order is still pending-then-upgrades.

This is a **change from the originally approved design**, which gave upgrades only the leftover
`maxNewTermsPerPass - pendingBatch.length` and accepted indefinite starvation as a recorded limit.
The pushback was right: "never, for as long as the queue stays full" is a bad property to design
in when four lines remove it. The original reasoning still holds for the *majority* of the budget —
a saturated queue means a large index being mined for the first time, where new terminology is the
better spend — so 20 of 25 slots still go to new terms first. What changes is that the starvation
is now bounded rather than unbounded, and §7 loses a limit instead of documenting one.

**No new column, no migration.** V45 shipped in `v1.13.0`, so the base spec's precedent of editing
it in place is gone; any column would now need a V46. Round-robin fairness comes from
`last_attempt_at ASC` and failure backoff from the existing `retryCooldownMs` shape, both already
on the table. A side effect worth a test: stamping `last_attempt_at` on a `consolidated` row means
that if the reconciliation sweep later demotes it to `pending`, it carries a backoff into
`selectPendingBatch`. That is bounded by the same 24 h cap and is arguably correct — the term did
just fail a consolidation attempt.

This also makes an existing schema comment true. `last_attempt_at` is documented as "last
consolidation attempt, success or failure", but `markConsolidated` never stamps it today.

**A failed upgrade never loses the existing definition.** `retry` and timeout outcomes leave the
row exactly as it was — same `definition`, same `definition_source='snippet'`, same projected item.
Only `attempts` and `last_attempt_at` move. The user's glossary never gets worse for having tried.

**A veto on upgrade is honoured** — `unprojectTerm` + `markVetoed`, the same as any other veto.
Snippet mode has no veto path at all (base spec §5.7), so a glossary built without an LLM
accumulates terms no model has ever judged. Letting the upgrade veto them is the point.

The consequence must be stated plainly in user-facing docs, because it is surprising: **turning the
LLM on can remove terms that were previously in the glossary.** It is not data loss — the term
returns to the searchable index if a later rebuild re-derives it, and the row survives as `vetoed`.

Documentation is not enough on its own, though: a term silently vanishing between two runs reads as
a bug regardless of what a doc says. So the veto is **reported at the moment it happens**.
`GlossaryPassSummary` gains `upgradesVetoed: number` and `vetoedTerms: string[]` (capped at 10 —
this is a notification, not an audit trail), and `--refresh` prints e.g.
`Vetoed 3 previously snippet-defined terms: shard_key, backfill, retry (no longer in the glossary).`
Without this the only way to discover what disappeared is to diff two listings by hand.

**No terminal give-up after N failed upgrades** — considered and declined. A permanently-failing
upgrade retries at most once per 24 h (the backoff cap), and `ORDER BY last_attempt_at ASC` sorts a
just-failed term behind every other candidate, so it cannot monopolise the reserve. Against that,
`selectPendingBatch` has no attempt ceiling either, so adding one here would be an inconsistency
between two sibling queries; and the common cause of repeated failure is a missing or misconfigured
model — machine-wide and transient — where permanently marking terms unupgradable is the worse
error. `--rebuild` remains the reset.

### 3.3 Ordering within the pass

`consolidatePhase` runs the pending batch first, then the upgrade batch, both inside the same
sequential loop discipline and both honouring `opts.signal` between terms. An upgrade that runs is
indistinguishable from a first consolidation from `consolidateTerm`'s point of view — it takes the
same snippets, the same guards (including the empty-snippets guard that Task 11's integration
review added) and the same `MAX_SYNONYMS` cap.

`GlossaryPassSummary` gains four fields, all of them feeding user-visible output rather than
telemetry for its own sake:

| Field | Why |
| --- | --- |
| `upgraded: number` | Distinct from `consolidated` — do not conflate "learned a new term" with "improved an old one" |
| `upgradesVetoed: number` | §3.2 — the disappearing-terms signal |
| `vetoedTerms: string[]` | §3.2 — *which* terms disappeared, capped at 10 |
| `llmAvailable: boolean` | §2.6 — drives the silent-snippet-fallback warning |

## 4. `--refresh` and `--rebuild`

### 4.1 A new namespace, not new agent parameters

The flags get `glossary.refresh` and `glossary.rebuild` in a new `ipc/glossary-rpc.ts`, **not**
extra parameters on `agents.glossary`.

Every built-in agent is read-only, HITL-free and side-effect-free; that shape is what let Task 14's
review clear `agents.glossary` for renderer exposure under **I7** by tracing the whole call graph
to "no SQL write, no `connectors.dispatch`, no HITL action, no Vault access". Making the agent RPC
able to run a write pass — or truncate two tables — would invalidate that trace and the invariant
argument built on it.

### 4.2 Single-flight

The scheduled pass and an on-demand pass must never run concurrently: both write the watermark,
both write `glossary_term`, and both spend LLM time. `GlossaryRefresher` therefore owns on-demand
execution too, gaining one method:

```ts
runNow(opts: { rebuild: boolean }): Promise<GlossaryPassSummary>
```

It reuses the existing `running` guard and the existing `controller.signal`, so an on-demand pass
is aborted by shutdown exactly like a scheduled one.

- **A pass is already running** → fail fast with `-32000`,
  `ERR_GLOSSARY_PASS_RUNNING: a glossary pass is already running`. Not "await the in-flight pass and
  report its summary": that pass is not the one the user asked for, and for `--rebuild` it would
  report success for work that never happened.
- **`[glossary].enabled = false`** → `-32000`, `ERR_GLOSSARY_DISABLED: …`, naming the config key. An
  explicit user command must not silently no-op the way `trigger()` does.

`-32000` is the repo's generic application-error code with an `ERR_*`-prefixed message — the
`policy-rpc.ts` and `lan-rpc.ts` convention. Codes in the `-32001…-32009` band are unused here and
inventing one would be drift.

**No `--force` to cancel a running pass, and no progress readout for someone else's pass.**
Deferred for a structural reason, not just scope: the refresher's `AbortController` is created once
and `stop()` is terminal (`stopped = true`, and `fire()` returns early forever after). Cancelling a
scheduled pass with today's object would permanently disable the refresher for the process
lifetime. Supporting `--force` means moving to a per-pass controller — and doing so is exactly what
makes the repeated-abort scenario in §2.3 reachable, which would then require the provider signal
propagation deferred there. The two are one change, not two. Meanwhile a rejected `--refresh` costs
the user a retry, and the scheduled pass it collided with is doing the same work anyway.

`runPass` in `GlossaryRefresherDeps` changes shape to
`(signal, opts: { rebuild: boolean }) => Promise<GlossaryPassSummary>`, so the refresher stays
Database-free and testable without SQLite.

### 4.3 Long-running job, not a blocking call

A pass is bounded by `max_new_terms_per_pass × consolidate_timeout_ms` — 12.5 minutes at defaults.
That is far past any reasonable synchronous RPC, so the methods use the existing
`LongRunningJobRegistry` (`ipc/_lib/long-running.ts`, the `index.reembed` precedent): they return
`{ jobId }` and emit `glossary.passProgress` / `glossary.passDone` / `glossary.passError`.

`GlossaryPassOptions` gains an optional `onProgress` callback, invoked after each term with the
running counts. Without it a `--refresh` is a silent multi-minute hang.

### 4.4 CLI

`runAgentBriefCli` gains one optional field:

```ts
beforeCall?: (client: IPCClient) => Promise<void>;
```

invoked after `connect()` and **before** `awaitBrief` arms its 30 s timer, so the pass wait and the
brief wait do not share a budget. The alternative — a second `IPCClient` connection inside
`runGlossaryCommand` — would duplicate the gateway-not-running and exit-code handling that helper
exists to own.

`UNWIRED_FLAGS` in `commands/glossary.ts` is deleted; `--refresh`, `--rebuild` and `--yes` are
parsed normally. Flow:

```text
nimbus glossary --refresh            # run a pass now, then print the (updated) listing
nimbus glossary --rebuild            # preview only: prints what would be deleted, exits 0
nimbus glossary --rebuild --yes      # wipe, re-mine from watermark zero, then print
```

**`--rebuild` without `--yes` touches nothing.** It calls the existing `countByStatus()` and
`listConsolidated()` reads and prints a count *plus a sample*:

```text
47 consolidated terms and 12 pending candidates would be deleted.
  CDR, shard_key, write-behind, Shadow Traffic, RetryBudget,
  backfill, SLO, blue-green, RetryBudget, hot partition
  ... and 37 more
Re-run with --yes to confirm.
```

This follows `nimbus clip delete --all`, which previews and requires `--yes`, rather than
`nimbus db repair --yes`, which rejects outright. The sample matters more here than the count: a
bare number tells the user how much they are about to lose but nothing about *what*, and rebuilding
costs a full LLM pass, so an accidental invocation is expensive rather than merely annoying.
`listConsolidated` orders by score descending, so the sample is the terms the user is most likely
to recognise — which is exactly what makes the preview a real check rather than a formality.

### 4.5 Two security surfaces this opens

**LAN (I5).** `checkLanMethodAllowed` is a **denylist** — a new namespace is callable over LAN by
default. `"glossary"` is added to `FORBIDDEN_OVER_LAN` in `ipc/lan-rpc.ts`, alongside the
`index.reembed` / `index.reembedCancel` precedent for write-class methods. Without it a paired peer
could wipe the local glossary or spend the owner's GPU. `agents.glossary` is unaffected: the
`agents` namespace stays LAN-readable, consistent with the other nine agents.

**Tauri (I7).** Neither method is exposed to the renderer; `ALLOWED_METHODS` stays at 102. The
desktop UI has no glossary surface, and I7's rule is to expose what is needed rather than what is
harmless. This also avoids touching the count assertion in two places — `gateway_bridge.rs` and its
TypeScript mirror in `security-invariants.test.ts`, whose drift already broke this branch's
predecessor once (Task 17 gate results, `f1244d94`).

## 5. Testing

Every new test is red-proved: break the code, confirm the test fails **for the right reason**,
restore, confirm green. A mutation that fails everything proves nothing — the base slice recorded
one that desynced SQL parameter binding and failed all 19 tests.

| Layer | File | Covers |
| --- | --- | --- |
| Unit | `glossary-llm-adapter.test.ts` | local provider selected; **remote-only → `null`** (the §2.1 guarantee); no provider → `null`; already-aborted signal → `null`; raw text returned |
| Unit | `llm/router.test.ts` | `isLocalProviderKind` for all three kinds |
| Unit | `glossary-store.test.ts` | `selectSnippetUpgradeBatch`: excludes `llm`-sourced and non-consolidated rows; backoff withholds a recent failure; `last_attempt_at ASC` round-robin |
| Integration | `glossary-extract.test.ts` | upgrade batch runs only with an LLM; **reserved floor** — a saturated pending queue still yields exactly `UPGRADE_RESERVE` upgrade slots, and zero upgrades outstanding gives pending the full budget; `upgraded` counted separately; a retried upgrade leaves definition + source + projected item untouched; a vetoed upgrade unprojects and lands in `vetoedTerms` |
| Unit | `glossary-refresh.test.ts` | `runNow` bypasses the debounce; **concurrent call rejects** rather than awaiting; disabled config rejects; `stop()` aborts an on-demand pass |
| Unit | `agents/glossary.test.ts` | the snippet-fallback gap note fires on a predominantly-snippet glossary and is **absent** on an LLM-sourced one |
| Unit | `ipc/glossary-rpc.test.ts` | both methods return `{ jobId }`; `passDone` / `passError` emitted; param validation |
| Unit | `ipc/lan-rpc.test.ts` | `glossary.refresh` and `glossary.rebuild` forbidden over LAN |
| Unit | `commands/glossary.test.ts` | flags parse; `--rebuild` without `--yes` calls **no** mutating method; `--yes` does; the no-LLM warning and the vetoed-terms line render — **DI, not `mock.module`** |
| E2E | `cli/test/e2e/glossary.smoke.e2e.test.ts` | `--rebuild` preview path against a real subprocess (replacing the current rejection assertion) |
| Invariant | `security-invariants.test.ts` | `ALLOWED_METHODS` count unchanged at 102 |

**On the static audit (review Q4.1).** `scripts/structure-audit/check-nimbus-invariants.ts` was
checked directly: it carries no rule keyed on the `glossary/` directory or on `ipc/*-rpc.ts` as a
pattern — the only `ipc/` entries are D21's explicit confinement of `share-rpc.ts` and
`federation-rpc.ts`. A new `ipc/glossary-rpc.ts` therefore trips nothing, and **that is the
problem**: nothing static would notice if the LAN denylist entry were dropped. The
`ipc/lan-rpc.test.ts` row above is the only thing standing behind that guarantee, so it is a
required test rather than a nice-to-have. D12 (I14) does apply and is satisfied: the new store
function is a `SELECT`, and every write still goes through the existing `dbRun` helpers.

Two traps this branch must not re-trip, both from the base slice's ledger:

- **Count-only assertions on ordered collections are false greens.** The upgrade-ordering test
  asserts *which* terms are selected and in what order, not how many.
- **`tsc --noEmit -p packages/gateway/tsconfig.json` does not typecheck `test/`** (`include` is
  `src/**/*`). It is not evidence about the e2e file. Adding `onProgress` and `upgraded` to types
  that e2e fixtures construct is exactly the shape that bit Task 16.

Coverage: new source files carry the ≥80% line **and** branch floor, verified through
`bash scripts/coverage-floor/reseed-docker.sh` — local `bunfig.toml` sets `coverage = false`, so
local numbers are not evidence. Prefer shapes without unreachable branches: the base slice had to
exclude `near-miss.ts` because `noUncheckedIndexedAccess` forces `??` fallbacks that cannot
execute.

## 6. Claims that become false on landing

Documentation must describe what the code does. Five false doc claims were corrected during the
base slice, one of them in a PR description that would have become the permanent commit message.
Each item below is a specific claim this change invalidates.

**Code comments and shipped strings:**

- `agents/glossary.ts` (~`:112-115`) — the gap-note comment reads *"Deliberately does NOT name
  `--refresh`: that flag is not wired"*, and the remediation string it drove says the pass "runs
  automatically after the next connector sync." With `--refresh` wired, the note should offer it.
- `commands/glossary.ts` — the whole `UNWIRED_FLAGS` block and its docstring.
- `glossary-consolidate.ts` (~`:171-174`) — "this is the path the scheduler actually takes (no
  `llm` is supplied from `platform/assemble.ts`)" becomes conditional on `use_llm`.

**Base spec `2026-07-30-nimbus-glossary-design.md`:**

- §1 usage block — the parenthetical that both flags are parsed but not honoured.
- §5.7 — "**No automatic upgrade path exists**" and the sentence that every unattended pass
  produces snippet definitions. Replace with the local-only rule and the `use_llm` gate; the
  no-LLM-configured degradation itself is unchanged and still correct.
- §7 — the config block and the two paragraphs on flag behaviour.
- §12 Known Limits — the `--refresh`/`--rebuild` entry and the veto-stickiness entry that depends
  on it. **Add** the un-propagated abort signal (§2.3).
- §14 — both scoped acceptance criteria. The LLM criterion is no longer scoped away from the
  scheduler path.

**Other docs:** `roadmap.md:1072` and `:1106`; `docs/CHANGELOG.md`; `docs/cli-reference.md` (the
flags, and the surprising veto-on-upgrade consequence from §3.2); `docs/architecture.md` IPC
catalogue for the new `glossary.*` namespace. No schema change, so `schema-reference.md` is
untouched.

Before finishing, grep for citations of every surface changed here rather than trusting this list —
that discipline is what turned up the `agents/glossary.ts` gap note above.

## 7. Known limits

- **Upgrades are slowed, not starved, by a saturated pending queue.** `UPGRADE_RESERVE` guarantees
  5 of 25 slots, so the worst case is upgrading at 5 terms per pass instead of 25 while initial
  mining runs. The unbounded-starvation version of this limit was removed by the §3.2 reserve.
- **The abort signal does not reach the provider.** Shutdown stops waiting on an in-flight model
  call but cannot cancel the HTTP request, which runs until the provider's own 120 s timeout or
  process exit. Bounded by there being at most one abort per process, at shutdown — see §2.3, and
  note it becomes materially worse if `--force` (§4.2) is ever added without also propagating the
  signal.
- **A permanently-failing upgrade retries forever**, once per 24 h, occupying one reserved slot.
  Declined a terminal give-up state for the consistency and transient-cause reasons in §3.2.
- **Local-only is enforced at selection, not at the provider.** A provider registered under a local
  `LlmProviderKind` that internally proxies to a cloud endpoint would pass the check. Not reachable
  today — `OllamaProvider` and `LlamaCppProvider` are the only two, both pointed at loopback by
  default — but the guarantee is "the router picked a local-kind provider", not "no packet left the
  host".
- **`llamacpp_server_path` can point off-box.** Same shape as above, one level more concrete:
  `[llm].llamacpp_server_path` accepts any base URL, so a user who points it at a remote llama.cpp
  server gets remote inference from a provider the router classifies as local. Pre-existing and
  not glossary-specific, but it is the honest bound on §2's claim.
- **No per-term model disclosure.** `definition_source` stays a two-value enum (`llm` / `snippet`);
  the brief says a definition was LLM-generated but not by which model. Adding it needs a V46
  column.
- **Manual authoring still deferred.** Unchanged from base spec §12: `[glossary.terms]` needs a V46
  migration rebuilding `glossary_term` to widen
  `CHECK(definition_source IN ('llm','snippet'))`. Now strictly a V46 rather than a V45 edit,
  because V45 shipped in `v1.13.0`.
- **`agents.*` unknown-parameter handling unchanged.** `requireGlossaryParams` ignores unknown keys,
  matching all nine siblings. Tightening one handler would be an inconsistency rather than a fix.

## 8. Acceptance

- [ ] With a local model available and `use_llm = true`, a scheduler-triggered pass produces
      `definition_source='llm'` definitions — no user command, zero live API calls.
- [ ] With no local provider available, the pass still completes and produces snippet definitions;
      no remote provider is ever selected.
- [ ] An existing `definition_source='snippet'` term is upgraded in place on a later pass, and a
      failed upgrade leaves its definition, source and projected item unchanged.
- [ ] A saturated pending queue still leaves `UPGRADE_RESERVE` upgrade slots — upgrades are never
      starved indefinitely.
- [ ] A pass that consolidates with no model available reports it: the brief carries the
      snippet-fallback gap note, and `--refresh` prints the warning.
- [ ] A term vetoed during an upgrade is named in the `--refresh` output, not silently dropped.
- [ ] `nimbus glossary --refresh` runs a pass and prints the updated listing; a concurrent request
      fails rather than double-running.
- [ ] `nimbus glossary --rebuild` without `--yes` deletes nothing and reports both the count and a
      sample of the terms it would delete.
- [ ] `glossary.refresh` and `glossary.rebuild` are rejected over LAN; `ALLOWED_METHODS` stays 102.
- [ ] Zero HITL actions fire; zero `egress_ledger` rows are appended.

## 9. Review dispositions

Reviewed against
[`2026-07-31-nimbus-glossary-llm-wiring-design-review.md`](./2026-07-31-nimbus-glossary-llm-wiring-design-review.md)
on 2026-07-31. Five items accepted, three deferred with reasons recorded above.

| Item | Disposition | Where |
| --- | --- | --- |
| Q1.1 snippet-fallback invisible | **Accepted** — gap note + `--refresh` warning | §2.6 |
| Q1.2 abort not propagated to providers | **Deferred** — cost measured (~15 lines); failure unreachable (one abort per process) | §2.3, §7 |
| Q2.1 upgrade starvation | **Accepted, design changed** — `UPGRADE_RESERVE` floor replaces pure leftover allocation | §3.2 |
| Q2.2 vetoed terms vanish silently | **Accepted** — `upgradesVetoed` + `vetoedTerms` reported by `--refresh` | §3.2, §3.3 |
| Q2.3 no max-attempts ceiling | **Deferred** — backoff + `last_attempt_at ASC` already bound it; a cap `selectPendingBatch` lacks would be drift | §3.2, §7 |
| Q3.1 rebuild preview is count-only | **Accepted** — sample of highest-scoring terms | §4.4 |
| Q3.2 `--force` cancel / live progress | **Deferred** — terminal `AbortController`; would make Q1.2 reachable, so the two are one change | §4.2 |
| Q4.1 verify static audit + LAN block | **Accepted as test coverage** — audit confirmed insensitive, which makes the LAN test load-bearing | §5 |
