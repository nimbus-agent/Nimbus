# S2 — Multimodal I/O (local-first media understanding)

> **Status:** design, 2026-09-02. Not implemented. Reserves invariant **I37**, static rule **D27**
> (plus a new **D22(g)** in I29's existing rule family), and schema **V58**.
>
> **Slot:** [Spine S2 — Local Compute Fleet](../../roadmap.md#active). Detail source:
> [Phase 14 § Core — Multimodal I/O](../../roadmap.md#phase-14--agent-evolution--ai-v2). It is the
> S2 row with **nothing** shipped against it: sandboxed code execution landed (I33), computer-use
> landed for two of its three lanes (browser + terminal; `screen` deferred), and BYO-frontier-model
> routing landed. Runtime tool generation and overnight sub-agent fleets are likewise unstarted.
>
> Note that Phase 14's own checkboxes are **not** the status source — the code-execution section
> there still reads unchecked although I33 shipped, because S2 tracks delivery in
> [§ Active](../../roadmap.md#active) instead. Read § Active, not the checkboxes.
>
> **Predecessors this document leans on, by name:**
> [S2 slice 1 — Sandboxed Code Execution](./2026-08-22-s2-sandboxed-code-execution-design.md) (I33,
> the gate-order discipline), [S2 — Computer Use](./2026-08-30-s2-computer-use-design.md) (I35, the
> gate-before-driver sequencing and the never-write-bytes-to-disk rule), and
> [LLM model routes slice 2](./2026-08-28-llm-model-routes-slice-2-design.md) (I34 + the
> `wrapLedgeredProvider` decorator shape this spec copies for vision).

---

## 1. Goal

Make the media already sitting in the index answerable. Today a Loom recording, a Google Photo, a
Figma board and a screenshot on disk are all in the index as a **title and nothing else** — an
empty `bodyPreview` and some dimensions. This slice fills those bodies with locally-derived
understanding, so `nimbus ask "what did I demo in yesterday's recording?"` has something to read.

Two modalities, delivered in sequence:

- **Audio / video** — long-form transcription over local recordings and fetched cloud recordings.
- **Image** — caption, OCR and entity extraction over local images and fetched cloud photos and
  design thumbnails.

### 1.1 Non-goals for this slice

- **Image *output*.** Phase 14's `nimbus diagram` (local SD/Flux) is not in scope.
- **Speaker diarization.** Listed in Phase 14, and `whisper-cli` does not do it. See § 12.2 — it is
  scoped out explicitly rather than left to survive into a shipped claim.
- **Local fine-tuning** and the tool-use trace dataset builder — Phase 14 stretch rows the spine
  table does not name in S2.
- **An agent-callable understanding path.** The pass is owner-invoked, exactly as `nimbus exec` is
  (I33's scope bound). Nothing here lets the LLM decide to understand an artifact.

---

## 2. The question this slice exists to answer

> *Can the index answer questions about media without the media leaving the machine?*

The honest answer has to survive two separate boundaries that the roadmap's one-line privacy
contract ("no image / video / audio body leaves the machine without explicit user opt-in for that
artifact") collapses into one:

1. **Inbound** — fetching an artifact's bytes *from* a cloud service the user has already
   connected. This is an outbound API request, so it is ledgered, but it is not a new trust
   decision: the user connected that account and the item is already in their index.
2. **Outbound** — sending those bytes *to a model*. This is the one the privacy sentence is
   actually about, and it is the only one that gets a consent gate.

Conflating them produces one of two bad designs: a prompt on the inbound path that trains people to
click through, or a silent outbound send because "the user already opted into the connector."
§ 6 keeps them apart.

---

## 3. Architecture

### 3.1 Placement

```
packages/gateway/src/multimodal/
  media-gate.ts            THE chokepoint: the only path from bytes to a model
  media-bytes.ts           byte acquisition (local read | cloud fetch); touches no model
  media-discovery.ts       which indexed items are understandable candidates
  media-pass.ts            the budgeted, resumable understanding pass
  media-pass-state.ts      cursor + resume
  understanding-item.ts    pure mapper: understanding -> derived item row
  media-consent-broker.ts  per-artifact remote grant prompt          (PR 4)
  media-grant-store.ts     durable grants, V58                        (PR 4)
  media-source-registry.ts (service, type) -> modality; the SSoT
  vlm/vlm-types.ts         VlmProvider: isLocal + describeBytes
  vlm/ollama-vlm.ts        local VLM; isLocal DERIVED via base-url-locality.ts
  stt/long-form-stt.ts     wraps the existing WhisperSttProvider for file-length audio
packages/gateway/src/egress/
  vlm-egress.ts            wrapLedgeredVlm - the fourth model-class decorator
```

Each unit answers the three questions independently: `media-bytes.ts` gets bytes and never contacts
a model; `media-gate.ts` is the only thing that hands bytes to a model; `understanding-item.ts` is
pure and testable without either.

### 3.2 Why a dedicated gate rather than an executor action type

The same reasoning I33 and I35 both reached. The executor's HITL gate (I2) is for **connector
actions** dispatched to `connectors.dispatch`; understanding is neither — it is a local model call
over local bytes. Routing it through the executor would mean inventing a connector action that does
not dispatch to a connector, which is precisely the shape I29's `NULL_EGRESS_SINK` executors exist
to accommodate and which has already proven confusing. A dedicated gate with its own consent broker
follows `exec-consent-broker.ts` and `cu-consent-broker.ts`.

### 3.3 The gate ships before the thing it gates

`media-gate.ts` lands in **PR 1**, carrying only its local arm, when there is not yet a remote path
to gate. This is the browser lane's lesson stated as a rule: the gate came first and the driver
second, and retrofitting a chokepoint onto code that already reaches the resource is how a bypass
gets built. PR 4 adds an *arm* to an existing gate rather than introducing a gate.

### 3.4 Order inside the gate

Fixed, and the order is itself the invariant (as in I33 and I35):

1. Resolve modality from the registry + mime + extension. An unresolvable artifact is **skipped
   with a reason**, never guessed at.
2. Resolve the provider for that modality. Locality is **derived** from `provider.isLocal`
   (reusing I34), never passed in.
3. If the provider is non-local: require a durable grant for **this artifact**. No grant means
   **refuse** — never fall back to remote, and never prompt from inside the pass (§ 6.3).
4. If the provider is local and unavailable: **refuse**, do not degrade to remote. Fail-closed, the
   same posture as `enforce_air_gap`.
5. Only then hand bytes to the model.

---

## 4. Storage: derived items, not a new table

Understanding lands as its own indexed item:

| Field | Value |
| --- | --- |
| `service` | `nimbus` |
| `type` | `image_understanding` / `video_understanding` |
| `externalId` | `<source_item_id>:understanding:v<understandingVersion>` |
| `body` | caption + OCR text, or the transcript (declared-full, capped by `bodyCapForItemType`) |
| `metadata` | `derivedFrom`, `model`, `modelDerived: true`, `understandingVersion`, `isLocal`, `sourceMime`, `sourceBytes` |

Both types join `PROSE_HEAVY_TYPES`.

**Why this and not a dedicated table.** `zoom:transcript` is already exactly this shape — a
separate derived row with its own stable `externalId`, a declared-full body, and metadata pointing
back at `zoom:meeting`. Because it is an ordinary indexed item, embedding routing, FTS,
`nimbus ask` and all fourteen agents work on day one with **no new search code**. The
`glossary_term` / `decision_record` alternative is cleaner on provenance but nothing *finds* the
content until embedding, query and brief integration are each built — a second slice of work to
reach parity with what this gets for free.

**Why not fill the source item's body.** It would conflate what a model guessed with what the
connector reported, in a column nothing can distinguish — and the next sync would overwrite it. The
`modelDerived: true` flag on a separate row is what lets a brief say "model-derived caption"
instead of citing it as authoritative. That is I31's concern applied to storage.

**Re-understanding** is an idempotent upsert. Bumping `understandingVersion` when a better model
lands re-understands a library with no migration, and the old rows are replaced rather than
accumulated because the id is derived from the version.

---

## 5. Byte acquisition

`media-bytes.ts` returns bytes or a typed miss. It never contacts a model, which is what makes the
gate's chokepoint claim checkable.

### 5.1 Local arm

The path is **re-validated against the live `[[filesystem.roots]]` at read time**, never trusted
from the item's stored metadata — roots may have narrowed since indexing, and an item indexed under
a root that no longer exists must not still be readable. Symlinks are resolved before the check and
`..` segments are refused outright: `isAbsolute` is not sufficient, which the terminal lane learned
when `/a/b/../../etc` passed it and the consent prompt showed the unresolved string while the
sandbox bound the resolved one.

### 5.2 Cloud arm

A new `fetchBytes` capability, minted in `sync/sync-capabilities.ts` (the sole D24 exemption, where
capabilities are minted so nothing else holds raw handles). It rides machinery that already exists
in `sync/targeted-fetch.ts`: the derived host boundary (`fetch-host-boundary.ts`, exact-match, no
guessing fallback), the per-provider rate limiter, and an egress row appended **before** the
request. Misses reuse that module's outcome union — `not_found` / `not_configured` /
`rate_limited` / `unsupported_url` — rather than a parallel vocabulary.

### 5.3 Bounds

- A per-artifact byte cap **refuses** rather than truncates. Half an image is not a smaller image;
  this is I32's split (prose truncates, structured values drop) applied to media.
- Bytes are held in memory and **never written to disk**, matching I35's screenshot rule. There is
  no cache of fetched media, deliberately: a cache is a second copy of the thing the privacy
  contract is about, with its own lifetime and its own deletion story.

---

## 6. The two consent surfaces

### 6.1 Inbound needs no new consent

The user authorized the connector; the item is already in their index; fetching its bytes is a read
of something they connected, exactly as `targeted-fetch.ts` fetches an item body today. It is
**ledgered, not gated**.

### 6.2 Outbound gets a durable, revocable, artifact-scoped grant

Stored in V58, revocable, and surfaced by `nimbus media grants list|revoke`.

### 6.3 The pass never prompts

The load-bearing decision. A batch over 500 photos that prompts 500 times does not produce 500
decisions — it produces one decision followed by 499 reflexes, and the gate stays *technically*
satisfied while having stopped meaning anything. That is the same failure I33's docs guard against
when they insist the owner sees the verbatim body rather than a digest ("a rubber stamp with extra
steps").

So: **granting is a separate deliberate act** (`nimbus media allow-remote <item>`), and the pass
reads existing grants and silently declines remote for everything not covered — reporting the
declines in its summary (§ 8). Consent stays scarce enough to mean something.

---

## 7. Egress accounting — no new coverage class

| Direction | Class | Appender |
| --- | --- | --- |
| Inbound cloud byte-fetch | `sync` (already `per-run`, per-item via targeted fetch) | reuse `egress/sync-egress.ts` |
| Outbound to a remote model | `model` (already `per-call`) | new `wrapLedgeredVlm`; ledgered STT wrapper |

`payload_summary` records byte length, mime and modality — **never pixels, never transcript text**.
`nimbus prove` needs no new vocabulary and no new scope label.

**`wrapLedgeredVlm` is a decorator applied at registration, not a call-site append.** This is
copied deliberately from `wrapLedgeredProvider`, which moved to `LlmRegistry.addRoute` precisely
because `LlmRouter.generate()` was never a chokepoint — `selectProvider()` callers went around it.
Wrapping the provider instance covers every caller including ones written later, without their
cooperation. It appends **before** delegating and an append failure aborts the call, so a zero-row
window means no body left the machine, never that one left unrecorded. A **local** provider is
returned unchanged and appends nothing — locality derived from `isLocal`, per I34.

**Why this is not optional polish.** `CLAUDE.md` currently states that the `model` class "carries
no more NAMED exclusions." An unledgered remote VLM send would silently falsify a published claim.

---

## 8. The pass

`nimbus media understand [--service <id>] [--since <date>] [--limit <n>] [--modality image|av]`

Owner-invoked, budgeted, resumable — shaped after `nimbus index rebody`, which solved the same
problem (a large recovery pass over an existing index that must survive interruption).

- **Discovery**: an item whose `(service, type)` is in `media-source-registry.ts` and which has no
  derived understanding item at the current `understandingVersion`.
- **GPU contention**: each artifact acquires `GpuArbiter` (`llm/gpu-arbiter.ts`, already shipped)
  around the model call — per artifact, not per pass, so a long pass does not starve interactive
  `nimbus ask`.
- **Per-artifact failure never aborts the pass.** Each failure is recorded with a reason so a
  re-run retries exactly it.
- **The summary discloses what it skipped and why** — "understood 42 of 108" broken out by reason
  (over byte cap, no local model, remote declined for want of a grant, unresolvable modality, fetch
  miss), never a bare success line. I31's honesty principle applied to a pass rather than a brief.

Scheduling is **not** in this slice. Automatic understanding on every sync is unbounded on first
run — a photo library is tens of thousands of items at GPU-seconds each, unlike the
millisecond-per-item text passes the glossary/decisions debounce seam was built for. A
`[multimodal] auto` opt-in is additive once real per-artifact cost has been *measured* rather than
guessed.

---

## 9. Models

### 9.1 Audio / video — reuse what ships

`WhisperSttProvider` (`voice/stt.ts`) already resolves `whisper-cli`, spawns it, and takes
`spawn` / `which` overrides for tests. `stt/long-form-stt.ts` wraps it for file-length input
(chunking, progress, wall-clock budget). **No new provider interface and no new decorator** — it is
a subprocess, not a provider.

### 9.2 Image — a new seam, because the existing one is text-only

`LlmGenerateOptions` is `{ task, prompt: string, ... }` with no image field. Widening it would push
bytes through `wrapLedgeredProvider` and every text caller. This is the same fork the Mastra engine
agent hit — `LlmGenerateOptions` has no `tools` field either, which is why
`wrapLedgeredMastraModel` exists as a *separate* decorator rather than a widening. Vision takes the
same answer: a distinct `VlmProvider` with its own decorator. Four decorators for four seams is the
established shape, not a proliferation.

### 9.3 Do not reintroduce `sharp`

`workers/sharp-stub.ts` exists because `@xenova/transformers` statically imports the native `sharp`
for image preprocessing, which killed the whole embedding runtime at load (#1396) and reported only
`err: {}` until the logging fix. Its doc-comment says: *"If an image or audio model is ever added to
this worker, this stub is the first thing to revisit."*

This spec revisits it and the answer is **do not**: raw bytes go to an Ollama-served VLM over HTTP,
which does its own preprocessing. Nothing in this design decodes an image in-process, so the stub
stays exactly as it is and the native-module-in-a-compiled-binary problem never arises. The same
reasoning rules out a linked dependency for frame extraction: ffmpeg (§ 12.1) is *spawned*, like
`whisper-cli`, not linked.

---

## 10. Invariant I37 and static rule D27

> **I37** — a media body reaches a NON-LOCAL model only through `multimodal/media-gate.ts`, and
> only when a durable, artifact-scoped remote grant exists for **that** artifact. Absent a grant the
> gate **refuses** rather than degrading to remote; a local provider that is unavailable likewise
> refuses rather than falling back. Locality is DERIVED from `provider.isLocal` (I34) and never
> supplied by a caller. Every remote send appends one `model`-class row **before** the request and
> an append failure aborts it (fail-closed). Bytes are never written to disk and never appear in
> `payload_summary`.

Split across two rule families on purpose:

- **D22(g)** — confines `wrapLedgeredVlm` to `egress/vlm-egress.ts` plus its registration site.
  That is egress *completeness*, so it belongs to I29's family, not this invariant's.
- **D27** — two rules: (a) the model-contact primitives (`describeBytes` / `transcribeBytes`) are
  confined to `media-gate.ts` plus their own definitions, no aliased import anywhere else; (b) a
  grant is readable only through `media-grant-store.ts`, so no caller can synthesize one.

Wiring, docs entry and enforcement test land in the **same commit** — the triple rule. Retiring any
of it means deleting the row, never leaving drift.

---

## 11. Testing

### 11.1 The zero-egress claim needs a positive control

"Zero `model` rows on the local path" passes for any reason, including a test that never reached a
model at all. So the test **registers a remote provider first and asserts a row appears**, then
runs local and asserts zero. This is the shape
`packages/gateway/test/integration/computer-use/terminal-loopback.test.ts` used — without its unconfined positive
control, "zero server hits" would have passed for any reason — and it is the only version of this
test that can fail.

### 11.2 Red-prove the D27 source guard by reverting

The terminal lane shipped a source guard that sliced to the first newline-brace after the
declaration, which turned out to be the closing brace of a multi-line **return type** — so the
scanned region ended before the body began and the guard could not fail. Anchor on the body
opening, with a positive control asserting the slice contains what it is meant to catch, and
red-prove by reintroducing a violation.

### 11.3 Neither `whisper-cli` nor an Ollama VLM is on a CI runner

Logic tests are DI-driven (`WhisperSttProvider` already takes `spawn` / `which`). But a suite where
every real-binary test skips is a suite that cannot fail, so the skip-guarded tests need a leg that
actually runs them — check what is *on* the runner images rather than assuming nothing is, the way
the macOS runner turned out to have Chrome preinstalled and caught a real `close()`/SingletonLock
race.

### 11.4 Fakes prove the ends, never the wire

A `VlmProvider` fake cannot catch a contract mismatch with Ollama's real response shape. One
contract test against a recorded real response, and no `?? DEFAULT` on an injected dependency —
that is what makes an injected fake silently stand in for a broken wire.

---

## 12. Known bounds — documented, not glossed

### 12.1 PR 1 alone does not satisfy Phase 14's Core acceptance criterion

That criterion requires a `video_understanding` row with a non-empty transcript **and at least one
frame caption**. Frame captions need the VLM (PR 2) *plus* frame extraction via ffmpeg — a third
external binary with its own platform-availability story. The criterion is met at **PR 2**, not
PR 1. Recorded here so the roadmap does not claim it a PR early.

### 12.2 Diarization is scoped out, not deferred quietly

Phase 14 lists "speaker diarization" and `whisper-cli` does not do it; it needs a separate model.
This slice ships transcription **without** diarization and the roadmap row must say so. The
alternative — letting "with diarization" survive into a shipped claim — is the exact failure shape
of the fabricated hero demo and the air-gap feature that was inert while the docs promised it.

### 12.3 A caption is a guess

`modelDerived: true` exists because an image caption is a model's assertion, not an observation. A
brief citing one must present it as such. Nothing in this design measures caption accuracy, and no
confidence number is stored — a fabricated confidence score would be worse than none.

### 12.4 The filesystem media walk is unbounded without a cap

Pointing `[[filesystem.roots]]` at a photo library is the easy way to make discovery take hours.
The walk needs an extension allow-list and a file cap, mirroring the existing `maxFiles` / `depth`
bounds in `filesystem-v2-sync.ts`.

### 12.5 Cross-repo cost of the cloud arm

Every connector that gains `fetchBytes` is a change in
[`nimbus-mcp-servers`](https://github.com/nimbus-agent/nimbus-mcp-servers), not in this repo. PR 3
starts with `google_photos`, `google_drive`, `onedrive` and `zoom`; the rest follow on their own
cadence. The gateway-side capability is service-agnostic, so adding one later is a connector change
alone.

### 12.6 OCR quality is the VLM's

No dedicated OCR engine ships here. A VLM's text extraction on a dense screenshot is materially
worse than a purpose-built OCR pass. Stated rather than implied; a tesseract-class pass is additive
later.

---

## 13. Sequencing

| PR | Ships | New egress | New consent | Droppable |
| --- | --- | --- | --- | --- |
| 1 | Local media discovery, long-form STT, `video_understanding` items, `nimbus media understand`, **the gate with only its local arm** | none | none | — |
| 2 | `VlmProvider`, `wrapLedgeredVlm`, D22(g), local Ollama VLM, `image_understanding`, frame captions | none (local) | none | yes |
| 3 | `fetchBytes` capability (D24), cloud byte-fetch over the existing host boundary | inbound, `sync` class | none | yes |
| 4 | Remote arm, consent broker, V58 grants, **I37 + D27** | outbound, `model` class | per-artifact grant | yes |

Each PR is independently shippable and independently valuable. The riskiest is last and can be
dropped without unpicking anything — the property that let the screen lane be deferred cleanly.

---

## 14. Docs to update on landing

- `docs/SECURITY-INVARIANTS.md` — I37 section, D27, D22(g).
- `packages/gateway/src/security-invariants.test.ts` — I37 enforcement test.
- `scripts/structure-audit/check-nimbus-invariants.ts` — D27 rules, D22(g).
- `CLAUDE.md` + `GEMINI.md` — invariant ceiling, schema version, S2 row status. The `model`-class
  "no named exclusions" sentence must be re-read against PR 4, not assumed to survive it.
- `docs/roadmap.md` — the S2 multimodal row, with § 12.1 and § 12.2 stated in it.
- `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`.
