# S2 — Multimodal I/O (local-first media understanding)

> **Status:** PR 1 of 4 SHIPPED 2026-09-02 (PR #1429); PRs 2-4 remain design-only. Schema **V58**
> is live. Invariant **I37**, static rule **D27**, the new **D22(g)** in I29's existing rule family,
> and schema **V59** are all still RESERVED — they govern the remote arm, which lands in PR 4 and
> does not exist yet. Read § 13 for the per-PR split; anything outside PR 1's row there is a plan,
> not a description of the code.
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

**Amended 2026-09-05 (§ 19, finding 2.3).** The block below was speculative when written and three
PRs have landed since. It now states what is actually on disk, with the PR 4 arrivals marked.

```text
packages/gateway/src/multimodal/
  media-gate.ts            THE chokepoint: the only path from bytes to a model
  media-discovery.ts       which indexed items are understandable candidates
  media-pass.ts            the budgeted, resumable understanding pass
  media-pass-state.ts      cursor + resume
  media-types.ts           MediaCandidate / MediaSource / SkipReason / UnderstandOutcome
  media-source-registry.ts (service, type) -> modality; the SSoT
  build-media-pass-deps.ts THE wiring site: constructs providers, injects understanderFor
  understanding-item.ts    pure mapper: understanding -> derived item row
  orphan-prune.ts          deletes derived rows whose source item left the index      (PR 3)
  multimodal-config.ts     [multimodal] loader; REFUSES a non-loopback vlm_base_url
  cloud-bytes.ts           budgeted cloud byte-fetch, per-chunk caps                  (PR 3)
  cloud-url-resolver.ts    ledgered re-resolve of a provider byte URL                 (PR 3)
  cloud-renditions.ts      per-service rendition suffixes; originals by default       (PR 3)
  stt/{ffmpeg-bin,whisper-bin,transcribe-file}.ts   local STT plumbing
  frames/{frame-extract,av-understander}.ts         transcript + sampled captions
  vlm/vlm-types.ts         VlmProvider: isLocal + describe()
  vlm/ollama-vlm.ts        local VLM; isLocal DERIVED via base-url-locality.ts
  vlm/image-understander.ts   still-image captioning over VlmProvider
  vlm/caption-prompts.ts   the two prompts, as constants
  media-grant-store.ts     durable grants, V59; the ONLY module naming media_grant     (PR 4)
  vlm/image-mime.ts        magic-byte sniff -> the wire media_type                     (PR 4)
  vlm/remote/*.ts          remote VlmProvider adapters, one per vendor                 (PR 4)
packages/gateway/src/egress/
  vlm-egress.ts            wrapLedgeredVlm - the fourth model-class decorator
packages/gateway/src/index/
  media-grant-v59-sql.ts   the V59 table + partial unique index                        (PR 4)
```

There is no `media-bytes.ts` and no `media-consent-broker.ts`. Byte acquisition split by arm
(`cloud-bytes.ts` + a local read inside the pass) rather than landing as one module, and PR 4's
consent lives in the CLI, not a gateway-side broker, because § 6.3 forbids prompting from inside a
pass — a broker with no in-pass caller would be a module that only ever answers "no".

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
| `externalId` | `<source_item_id>:understanding` — **stable, no version in the id** (§ 4.1) |
| `title` | `Caption — <source title>` / `Transcript — <source title>`, matching `zoom:transcript`'s existing house style |
| `url` / `canonicalUrl` | inherited from the source item, so a citation navigates to the media itself |
| `body` | caption + OCR text, or the transcript (declared-full, capped by `bodyCapForItemType`) |
| `metadata` | `derivedFrom` (source item id), `model`, `modelDerived: true`, `understandingVersion`, `isLocal`, `sourceMime`, `sourceBytes` |

Both types join **`LOCAL_ONLY_PROSE_TYPES`**, not `PROSE_HEAVY_TYPES`. This was wrong in the first
draft of this spec and the correction is the most important one in it.

`routing.ts` answers two independent questions with two sets: *is this body paragraph-shaped* (it
is, so it gets the 16 KiB store via `body-caps.ts`) and *should its embedding be computed
remotely*. Putting the understanding types in `PROSE_HEAVY_TYPES` would answer YES to the second,
and the embedding worker would then send **the full OCR text and captions to OpenAI** the moment
`openai.api_key` is set. The raw pixels would never have left the machine — I37 fully satisfied —
while the entire semantic content extracted from them left anyway, with no grant, by a completely
different door. A private scanned document is materially just as exposed by its OCR text as by its
image.

Conflating those two questions is exactly what caused #1006, which is why `routing.ts` carries the
warning that *"membership here is the whole enforcement"* and why `routing.test.ts` pins the two
sets disjoint. `nimbus:web_clip` is already in the local-only set for the same class of reason —
a public claim that clipped content stays on the machine. Understanding output has a stronger claim
than that behind it, so it goes in the same set. Retrieval quality on long transcripts is the
deliberate price, as it already is for web clips.

**Rejected alternative: routing conditioned on `metadata.isLocal`.** It fails on both mechanism and
meaning. Mechanically it replaces a static, testable set-membership check — the thing
`routing.test.ts` can pin — with a per-item runtime decision, which is the shape #1006 was.
Semantically it is worse: it would make a remote *understanding* grant silently authorize a remote
*embedding* send, to a different vendor, for a different purpose. Consent to show one image to a
VLM is not consent to ship its extracted text to OpenAI. The sets stay static and both types stay
local-only unconditionally.

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

### 4.0 The write path is `upsertIndexedItem`, not the sync wrapper

`understanding-item.ts` calls `upsertIndexedItem(db, row)` **directly**. It does *not* call
`upsertIndexedItemForSync`, which exists to apply a **connector's** configured index depth
(`metadata_only` / `summary` / `full`) — and a Nimbus-derived item has no connector, so it has no
depth to apply. Every existing derived-item writer does the same:
`glossary/glossary-project.ts`, `briefs/brief-save.ts` and `clips/clip-ingest.ts` all call
`upsertIndexedItem`. That function is the real SQL chokepoint regardless, so the derived
`resolve_key` and the `bodyCapForItemType` clamp still apply.

One consequence to wire explicitly: `scheduleItemEmbedding` is called by the sync wrapper, not by
`upsertIndexedItem`. A derived item that is never scheduled is never embedded and never found by
semantic search, so the pass schedules it by id after the upsert.

### 4.1 Re-understanding: the version must NOT be in the id

The first draft put `understandingVersion` in the `externalId` and claimed old rows would be
"replaced rather than accumulated." That is backwards. `item` is keyed `UNIQUE(service,
external_id)` and upserts `ON CONFLICT(id)`, so `…:understanding:v1` and `…:understanding:v2` are
two *different* rows. Bumping the version would have accumulated a stale copy per artifact per
version — duplicate FTS hits, duplicate context injected into every agent, and a search result set
that silently degrades with each model upgrade.

So the id is **stable** (`<source_item_id>:understanding`) and `understandingVersion` lives only in
`metadata`. Re-understanding is then a genuine upsert: one row per artifact, forever, whose content
and version advance in place. Discovery selects candidates by comparing
`metadata.understandingVersion` against the current version rather than by testing for the row's
existence.

### 4.2 Orphan pruning

A derived row outlives its source unless something deletes it — a local file removed from disk, or
a cloud item that leaves the index, would otherwise leave a permanent understanding row citing an
item that no longer exists. Deleting a source item deletes its derived understanding row. Because
`derivedFrom` holds the source item id, this is a single indexed delete, not a scan.

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

A per-artifact byte cap **refuses** rather than truncates. Half an image is not a smaller image;
this is I32's split (prose truncates, structured values drop) applied to media. The caps are
per-modality, because the distributions are nothing alike:

| Config key | Default | Applies to |
| --- | --- | --- |
| `[multimodal] max_image_bytes` | 25 MB | images, and each extracted video frame |
| `[multimodal] max_media_bytes` | 250 MB | audio and video artifacts |

There is no cache of fetched media, deliberately: a cache is a second copy of the thing the privacy
contract is about, with its own lifetime and its own deletion story.

### 5.4 "Never written to disk" was not implementable — the narrowed rule

The first draft asserted that bytes are *never* written to disk, borrowed wholesale from I35's
screenshot rule. That assertion is false against this codebase's own STT interface, and shipping an
unimplementable rule in a spec is how a defense ends up documented but inert.

`WhisperSttProvider.transcribe(audioPath: string)` takes a **path**: it calls
`Bun.file(audioPath).exists()` and spawns `whisper-cli -f <path>`. It has no byte-array entry point.
Worse, `whisper-cli` wants 16 kHz 16-bit PCM WAV, so any compressed or containerised media needs an
ffmpeg transcode first. The rule and the interface cannot both hold.

The resolution is to narrow the rule to what is true, per arm:

- **Images — the rule holds completely.** Bytes go to an Ollama-served VLM as base64 over HTTP.
  Nothing is written, on either the local or the cloud arm.
- **Sampled video frames (PR 2, § 15 decision 2) — the rule holds completely too.** Each frame is
  its own `ffmpeg -ss <t> -frames:v 1 -f image2 -vcodec mjpeg pipe:1` invocation; the single JPEG is
  read off stdout and handed straight to the VLM. This strengthens the rule rather than merely
  extending it: "nothing is written on the image path" now covers video frames as well, and the one
  0600 scratch WAV described below remains the ONLY file this subsystem writes, on any arm.
- **Local audio/video — no *new* bytes are written beyond that one scratch WAV.** The
  already-validated path (§ 5.1) is passed to ffmpeg directly, which also keeps the file seekable
  (see below). Only the transcoded WAV is new; frame extraction (above) adds none.
- **Cloud audio/video, and every transcode — one gateway-owned ephemeral scratch file**, created
  mode 0600 under a Nimbus-owned directory, deleted in a `finally`, never indexed, never in a
  user-visible location, and never reused as a cache.

**The `finally` does not cover process death**, and saying it did would overstate the guarantee. A
SIGINT, a crash, or — on Windows, where a SIGTERM is `TerminateProcess` — any termination at all
kills the gateway without unwinding, leaving decoded audio of the user's recording on disk
indefinitely. So the pass also **sweeps stale scratch files at start**, deleting only files it
named and only those older than an hour, so a concurrent pass's file is never pulled out from under
it. The rule is therefore "deleted promptly, and swept if a process died mid-write" — not "never
persists", which the implementation cannot honour.

**Why not the in-memory pipe.** Piping through `ffmpeg` on stdin and into `whisper-cli` on stdin
would preserve the stronger rule, but it makes a cross-platform correctness property depend on an
unverified claim about a third-party binary's Windows build — and non-negotiable #5 means Windows
is not the leg allowed to be the weak one. The scratch file works identically on all three
platforms. If `whisper-cli` stdin support is later *verified* on all three, the pipe is a strict
improvement and can replace the scratch file without touching the gate.

**A side benefit worth naming:** a seekable file dissolves the MP4 `moov`-atom problem entirely.
Many MP4s carry their index at the end, so a non-seekable pipe forces ffmpeg to buffer the whole
file before it can decode anything — exactly the memory blow-up the in-memory design was meant to
avoid. The scratch file is both simpler and less memory-hungry than the alternative it replaces.

---

## 6. The two consent surfaces

### 6.1 Inbound needs no new consent

The user authorized the connector; the item is already in their index; fetching its bytes is a read
of something they connected, exactly as `targeted-fetch.ts` fetches an item body today. It is
**ledgered, not gated**.

### 6.2 Outbound gets a durable, revocable, artifact-scoped grant

Surfaced by `nimbus media grants list|revoke`. **Two migrations, not one**, because the pass is
resumable from PR 1 while grants do not exist until PR 4, and schema is forward-only — creating a
table three PRs before anything reads it is drift waiting to happen.

**V59** (PR 4), `index/media-grant-v59-sql.ts`:

```sql
CREATE TABLE IF NOT EXISTS media_grant (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL,
  modality      TEXT NOT NULL CHECK (modality IN ('image', 'av')),
  model_vendor  TEXT NOT NULL,
  granted_at    INTEGER NOT NULL,
  revoked_at    INTEGER
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_grant_active
  ON media_grant (item_id, modality, model_vendor)
  WHERE revoked_at IS NULL;

```

**V58** (PR 1), `index/media-pass-v58-sql.ts`:

```sql
CREATE TABLE IF NOT EXISTS media_pass_cursor (
  pass_id          TEXT PRIMARY KEY,
  service          TEXT,
  modality         TEXT,
  last_item_id     TEXT NOT NULL,
  processed_count  INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
) WITHOUT ROWID;
```

Two deliberate departures from the shape a reviewer proposed:

- **There is no `'all'` vendor.** A wildcard grant is broader than anyone means when they approve
  one, and it would silently extend to a vendor added after the grant was given. `model_vendor` is
  always a concrete vendor; authorizing two means two grants.
- **Uniqueness is a partial index on active rows, not a table constraint.** A plain
  `UNIQUE(item_id, modality)` makes revocation terminal — the revoked row occupies the slot, so the
  same artifact can never be granted again without mutating history. Scoping uniqueness to
  `revoked_at IS NULL` keeps revocations as an append-only audit trail while still permitting
  exactly one active grant per (item, modality, vendor).

`media_pass_cursor` is SQLite-backed rather than in-memory, so an interrupted pass resumes across a
gateway restart. That is the whole point of a budgeted pass over a large library.

### 6.3 The pass never prompts

The load-bearing decision. A batch over 500 photos that prompts 500 times does not produce 500
decisions — it produces one decision followed by 499 reflexes, and the gate stays *technically*
satisfied while having stopped meaning anything. That is the same failure I33's docs guard against
when they insist the owner sees the verbatim body rather than a digest ("a rubber stamp with extra
steps").

So: **granting is a separate deliberate act** (`nimbus media allow-remote <item>`), and the pass
reads existing grants and silently declines remote for everything not covered — reporting the
declines in its summary (§ 8). Consent stays scarce enough to mean something.

### 6.4 Batch granting, and why it does not reopen § 6.3

Granting one item at a time does not scale to an album, and a rule that is unusable gets worked
around. So a selector form exists:

```text
nimbus media allow-remote --service google_photos --since 2026-08-01 --limit 20
```

It renders **one preview that enumerates the matching items** — titles, dates, sizes, count — and
takes **one confirmation** that writes the grants in a single transaction. `--limit` is mandatory
and capped, so an unbounded "grant everything" is not expressible.

This is not the thing § 6.3 rules out, and the distinction is the same one the computer-use session
envelope draws: a **budgeted, enumerated set approved once, up front, out of band** is a real
decision, because the owner sees the whole extent of what they are authorizing at the moment they
authorize it. Five hundred interruptions *during* a batch is not, because each one arrives with no
view of the whole and with the work already in flight. The preview must enumerate rather than
summarize — "20 items" is a count, not consent.

---

## 7. Egress accounting — no new coverage class

| Direction | Class | Appender |
| --- | --- | --- |
| Inbound cloud byte-fetch | `sync` (already `per-run`, per-item via targeted fetch) | reuse `egress/sync-egress.ts` |
| Outbound to a remote **VLM** | `model` (already `per-call`) | new `wrapLedgeredVlm` |
| Outbound STT | **does not exist** — STT is local-only in all four PRs (§ 9.1) | none, by construction |

The first draft's table said "ledgered STT wrapper" while § 9.1 said STT needs no decorator. Those
could not both be true. **Resolved: speech-to-text is pinned local across this entire slice.** There
is no remote STT provider, no `SttProvider` routing, and no `wrapLedgeredStt` — a transcription
therefore appends zero `model` rows the way `LOCAL_ONLY_SYNC_SERVICES` appends zero `sync` rows: by
construction, not by check. Only the VLM has a remote arm, which correspondingly narrows I37 to
images. Recorded as a bound in § 12.7.

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
- **GPU contention**: `GpuArbiter` (`llm/gpu-arbiter.ts`, already shipped) is acquired **once per
  ARTIFACT** — one `understandArtifact` call, covering the transcript AND every sampled frame
  caption on that artifact — never per pass, and, per the amendment below, never re-acquired per
  frame either. § 8.1 explains why a heartbeat, not the lease's narrowness, is what makes that safe.
- **Frame sampling is capped.** A 30-minute video holds tens of thousands of frames; understanding
  samples a small fixed maximum (default 8) of uniformly spaced keyframes. The cap is a config
  value, and the brief discloses that a video was sampled rather than watched.
- **Per-artifact failure never aborts the pass.** Each failure is recorded with a reason so a
  re-run retries exactly it.
- **The summary discloses what it skipped and why** — "understood 42 of 108" broken out by reason
  (over byte cap, no local model, remote declined for want of a grant, unresolvable modality, fetch
  miss), never a bare success line. I31's honesty principle applied to a pass rather than a brief.

### 8.1 Why the arbiter lease is per model call

`GpuArbiter`'s `timeoutMs` (30 s) is **not** a background watchdog — it is an idle timer over
`lastActivityAt`, reset by `touch()`, and it is only evaluated when some *other* caller reaches
`acquire()`. So a long hold is not spontaneously killed. The hazard is worse and quieter than a
timeout: when eviction does fire, `forceRelease()` executes `this.queue.length = 0`, **discarding
every queued waiter** — and those waiters are unresolved promises, so they do not error, they simply
never settle.

A pass that held the lease across an entire video would therefore be a hang generator: hold for
minutes, let an interactive `nimbus ask` arrive and evict it, and any other queued caller is
stranded permanently.

**Per-call leasing is necessary but NOT sufficient, and the first draft of this section wrongly
said it was.** It claimed a per-call lease "is never held long enough for the idle timer to be
reachable." That is true for image captioning, where a call is seconds and frames release between
each other. It is false for audio and video, where **one call IS the whole file** — a thirty-minute
recording is a single `transcribeFile` that runs for minutes, and there is no natural release point
inside it to interleave at.

So the lease is accompanied by a **heartbeat**: while a model call is in flight, the gate ticks
`GpuArbiter.touch()` on an interval well inside the 30 s bound. That is not a workaround dressed as
a design — `touch()` means "still working", which is precisely and honestly true while the
subprocess runs. The idle timer exists to reclaim a lease from a holder that has *died*, and a
heartbeat is exactly what distinguishes that case from a slow one.

The interval must be cleared in a `finally`. A live interval outlives the call, and in `bun test`
that presents as a suite that hangs rather than one that fails.

**Amended by PR 2 (§ 15, decision 3): the lease is per ARTIFACT, not per model call.** The
reasoning above (per-call leasing needs a heartbeat because one call can be the whole file) is
still correct, but PR 2 went one step further than this section originally proposed: rather than
re-acquiring the lease before every frame caption and releasing it after, `understandArtifact`
takes **one lease with one heartbeat for the whole artifact** — the transcript call AND every
sampled frame caption share it. Re-acquiring per frame would add a queue round-trip per frame and
let another caller take the GPU mid-artifact, leaving a half-captioned video whose partial state
nothing records. The heartbeat is what defuses the idle-eviction hazard either way, so nothing
about the safety argument above changes — only the granularity at which the lease is held.

### 8.2 Scheduling

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
a subprocess, not a provider, and it is **pinned local** (§ 7): there is no remote STT in this
slice, so there is nothing for a decorator to ledger.

### 9.1.1 Resolving the external binaries

Transcoding needs ffmpeg. `resolveFfmpegBin` follows `resolveWhisperBin`'s existing shape exactly —
explicit config path, then a `NIMBUS_FFMPEG_PATH` env override, then `Bun.which`, with injectable
`which` / `spawn` for tests.

**It does not go in `platform/`.** The PAL rule covers OS-*specific* logic reached through
`PlatformServices`; resolving an external binary is not that, and both existing precedents keep the
resolver next to its consumer — `resolveWhisperBin` lives in `voice/stt.ts`, and the browser lane's
`chromium-path.ts` lives in `computer-use/cu-lanes/`. `resolveFfmpegBin` lives in `multimodal/stt/`
for the same reason.

A missing dependency must produce an actionable failure, not a bare non-zero exit: the pass reports
which binary was missing and the platform-appropriate install line
(`winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`).

### 9.2 Image — a new seam, because the existing one is text-only

`LlmGenerateOptions` is `{ task, prompt: string, ... }` with no image field. Widening it would push
bytes through `wrapLedgeredProvider` and every text caller. This is the same fork the Mastra engine
agent hit — `LlmGenerateOptions` has no `tools` field either, which is why
`wrapLedgeredMastraModel` exists as a *separate* decorator rather than a widening. Vision takes the
same answer: a distinct `VlmProvider` with its own decorator. Four decorators for four seams is the
established shape, not a proliferation.

`ollama-vlm.ts`'s `isAvailable()` checks that a **vision-capable model is actually pulled** — not
merely that an Ollama server is answering. A running Ollama with no VLM would otherwise pass an
availability check and then fail per artifact across a whole pass, and "local model unavailable" is
a *refusal* condition under § 3.4 step 4, so it must be detected directly, per artifact — not once
for the whole pass (which would miss a daemon that goes down mid-pass) and not once per sampled
frame (which would be a few hundred redundant probes across one long video).

**Amended by PR 2 (§ 15, decision 1): the probe is `POST /api/show`, not `/api/tags`.** `/api/tags`
returns names and `details.families`; inferring vision from name fragments (`llava`, `qwen2-vl`,
`gemma3`) breaks on every new model and on any custom tag. `/api/show` returns an explicit
`capabilities` array and answers the real question directly — once per artifact, as above — rather
than guessing from a string. A legacy daemon that predates the `capabilities` field falls back to a
`families` check for
`clip`/`mllama`; when neither says vision, this reports UNAVAILABLE — a refusal, never a guess.

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
> an append failure aborts it (fail-closed). Media bytes never appear in `payload_summary`, and
> the DISK rule is the narrowed one stated in § 5.4 **as amended by § 16.3** rather than an
> absolute: nothing is written on the image path, no new bytes are written for local audio, and an
> AV artifact writes **at most two** 0600 gateway-owned scratch files — the downloaded media (cloud
> AV only) and the transcode WAV — each deleted in a `finally` and swept by prefix at pass start.
> ("Exactly one" was true only for local AV, and PR 3 made the cloud arm real; corrected 2026-09-05,
> § 19 finding 2.2.) An
> earlier draft of this line said bytes are never written to disk at all, which § 5.4 contradicts
> and which the implementation cannot honour -- `whisper-cli` takes a path.

**Scope note.** Because STT is local-only in this slice (§ 7, § 12.7), the only modality that can
reach a non-local model today is images — the invariant is written generally and holds vacuously
for audio. It is deliberately *not* narrowed to images in its wording: a remote STT tier added later
should inherit this invariant rather than need a new one.

Split across two rule families on purpose:

- **D22(g)** — confines `wrapLedgeredVlm` to `egress/vlm-egress.ts` plus its registration site.
  That is egress *completeness*, so it belongs to I29's family, not this invariant's.
- **D27** — two rules: (a) the model-contact primitives (`describeBytes` / `transcribeBytes`) are
  confined to `media-gate.ts` plus their own definitions, no aliased import anywhere else; (b) a
  grant is readable only through `media-grant-store.ts`, so no caller can synthesize one.

  **Amended by PR 2 (§ 15, decision 6): rule (a) as worded above does not match what shipped, and
  PR 4 must write it against the real shape or it will enforce nothing.** There are no
  `describeBytes` / `transcribeBytes` free functions. Model contact for vision is a **provider
  method**, `VlmProvider.describe`, reached through the D22(g)-confined decorator
  `wrapLedgeredVlm` — egress completeness, not a fresh confinement target. When PR 4 adds the
  remote arm and I37 becomes reachable, rule (a) needs to confine whatever the ACTUAL remote-contact
  call site is by then (most likely `VlmProvider.describe` and the STT equivalent, if PR 4 adds
  one), not the two free-function names this section originally guessed at.

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

### 11.4 The embedding-routing set membership

`routing.test.ts` already asserts `PROSE_HEAVY_TYPES` and `LOCAL_ONLY_PROSE_TYPES` are disjoint, so
putting a derived type in both fails an **existing** test rather than shipping. What that test does
not do is prove the types were registered at all, so add the positive assertion: both
`nimbus:image_understanding` and `nimbus:video_understanding` are in `LOCAL_ONLY_PROSE_TYPES` and in
neither case in `PROSE_HEAVY_TYPES`. Membership is the whole enforcement (§ 4), so it is the thing
to pin.

### 11.5 The scratch file is deleted on every exit path

§ 5.4's ephemeral file is only acceptable if it always goes away. Test deletion on success, on a
transcode failure, on a whisper non-zero exit, on cancellation, and on an exception thrown between
creation and use — the `finally` is the contract, not the happy path. Assert the directory is empty
afterwards rather than asserting the one known filename is gone, or a second leaked temp file passes
unnoticed.

### 11.6 Fakes prove the ends, never the wire

A `VlmProvider` fake cannot catch a contract mismatch with Ollama's real response shape. One
contract test against a recorded real response, and no `?? DEFAULT` on an injected dependency —
that is what makes an injected fake silently stand in for a broken wire.

---

## 12. Known bounds — documented, not glossed

### 12.1 PR 1 alone does not satisfy Phase 14's Core acceptance criterion — PR 2 does

That criterion requires a `video_understanding` row with a non-empty transcript **and at least one
frame caption**. Frame captions need the VLM (PR 2) *plus* frame extraction via ffmpeg and a
duration probe via ffprobe — a third external binary with its own platform-availability story. The
criterion is met at **PR 2**, not PR 1, and PR 2 shipped 2026-09-03. Recorded here so the roadmap
does not claim it a PR early.

**Amended by PR 2: the criterion is now MET, with a stated bound.** Frame captions are present only
when a vision model AND a working duration probe are both available on the machine — either one
missing degrades the artifact to transcript-only, with the absence stated in the row's body rather
than silently thinner. A machine with neither still gets a `video_understanding` row with a
non-empty transcript; it simply carries no frame captions, and would not by itself satisfy the
criterion. The criterion is met when both dependencies are present, which is the common case on a
machine that opted into `[multimodal] enabled` and pulled a vision model, not universally.

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

### 12.6 Understanding output is embedded LOCALLY, always

Because both derived types are in `LOCAL_ONLY_PROSE_TYPES` (§ 4), their embeddings are MiniLM-384
even when a remote embedder is configured and even for an artifact that had a remote understanding
grant. Retrieval quality on a long transcript is measurably worse than the 1536-dim remote
embedder would give. That is the deliberate price, and it is the same price `nimbus:web_clip`
already pays.

### 12.7 There is no remote STT, at any tier

Transcription is local-only across all four PRs (§ 7, § 9.1). A user with a frontier key and no
usable local whisper cannot transcribe at all — the pass refuses rather than reaching for the
cloud. Deliberate: it keeps I37 scoped to images, avoids a second provider interface and a fifth
decorator, and keeps the strongest version of the privacy claim true for the modality where
recordings of real conversations live. A remote STT tier is additive later and would need its own
`wrapLedgeredStt` plus a D22 confinement rule.

### 12.8 A sampled video is not a watched video

Frame understanding samples a small fixed number of keyframes (§ 8). Anything that happens only
between sampled frames is invisible, and no amount of transcript covers a silent visual change. The
brief must say the video was sampled; presenting a sampled caption set as a description of the
video would be the same class of overclaim § 12.3 guards against.

### 12.9 Optimized cloud renditions are deferred to PR 3

Several providers can serve an audio-only track or a low-resolution proxy instead of the original
4K file, which would cut the fetched bytes by an order of magnitude. Every one of those is a
per-connector change in `nimbus-mcp-servers` (§ 12.5), so PR 3 fetches whatever the connector
offers and the rendition negotiation lands per connector afterwards. Until then `max_media_bytes`
is what stands between a pass and a 2 GB download.

### 12.10 OCR quality is the VLM's

No dedicated OCR engine ships here. A VLM's text extraction on a dense screenshot is materially
worse than a purpose-built OCR pass. Stated rather than implied; a tesseract-class pass is additive
later.

---

## 13. Sequencing

**Amended 2026-09-05 (§ 19, finding 2.1).** The PR 3 row described a design that was superseded
before it shipped, and the table still called shipped work droppable.

| PR | Status | Ships | New egress | New consent |
| --- | --- | --- | --- | --- |
| 1 | **SHIPPED** #1429 | Local media discovery, long-form STT, `video_understanding` items, `nimbus media understand`, **V58** pass cursor, **the gate with only its local arm** | none | none |
| 2 | **SHIPPED** #1438 | `VlmProvider`, `wrapLedgeredVlm`, D22(g), local Ollama VLM, `image_understanding`, frame captions | none (local) | none |
| 3 | **SHIPPED** #1448 | Cloud byte-fetch for `google_photos` / `google_drive` / `onedrive` via `cloud-url-resolver.ts` + `cloud-bytes.ts`, manual redirect validation, per-run and per-artifact byte budgets. **No `fetchBytes` capability, no D24 exemption, and `fetch-host-boundary.ts` is not on this path** (§ 16.2, § 16.4, § 17.10) | inbound, `sync` class — appenders 2 → 4 | none |
| 4 | designed (§ 18, § 19) | Remote VLM arm (images only), **V59** grants, batch granting CLI, **I37 + D27** | outbound, `model` class | per-artifact grant |

Each PR was independently shippable and independently valuable. PR 4 remains droppable: nothing
shipped depends on it, which is the property that let the screen lane be deferred cleanly. PRs 1–3
are no longer droppable in any useful sense — they are on `main`.

---

## 14. Docs to update on landing

- `docs/SECURITY-INVARIANTS.md` — I37 section, D27, D22(g).
- `packages/gateway/src/security-invariants.test.ts` — I37 enforcement test.
- `scripts/structure-audit/check-nimbus-invariants.ts` — D27 rules, D22(g).
- `CLAUDE.md` + `GEMINI.md` — invariant ceiling, schema version, S2 row status. The `model`-class
  "no named exclusions" sentence must be re-read against PR 4, not assumed to survive it.
- `docs/roadmap.md` — the S2 multimodal row, with §§ 12.1, 12.2 and 12.7 stated in it.
- `packages/gateway/src/embedding/routing.ts` — both derived types into `LOCAL_ONLY_PROSE_TYPES`
  (NOT `PROSE_HEAVY_TYPES`; § 4). `routing.test.ts` already pins the two sets disjoint, so a
  mistake here fails an existing test rather than shipping.
- `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`.

---

## 15. Amendments (PR 2, 2026-09-03)

PR 2's implementation plan made six deliberate, recorded deviations from this spec's first draft.
Each is a considered choice, not an oversight — this section records what changed and why, and the
sections above have been corrected in place to match rather than left to disagree with this one.

1. **Vision capability is detected via `POST /api/show`, not by matching model names in
   `/api/tags`.** § 9.2 said `isAvailable()` probes `/api/tags` and confirms a vision-capable model
   is pulled by name. `/api/tags` returns names and `details.families` only; inferring vision from
   name fragments (`llava`, `qwen2-vl`, `gemma3`) breaks on every new model and on any custom tag.
   `/api/show` returns an explicit `capabilities` array and answers the real question once, up
   front, instead of guessing from a string. A legacy Ollama with no `capabilities` field falls back
   to a `families` check for `clip`/`mllama`; when neither is present the provider reports
   unavailable, which the gate turns into a `no_local_model` refusal rather than a guess.

2. **Frame bytes never touch disk.** § 5.4 anticipated frame extraction writing scratch files.
   Instead each frame is a separate `ffmpeg -ss <t> -i <in> -frames:v 1 -f image2 -vcodec mjpeg
   pipe:1` invocation whose single JPEG is read off stdout. One spawn per frame (8 by default)
   against a fast input seek is cheap next to the VLM call that follows. This **strengthens**
   § 5.4's disk rule rather than amending it: "nothing is written on the image path" now also
   covers video frames, and the one 0600 scratch WAV for audio transcode remains the only file the
   subsystem writes.

3. **One GPU lease per artifact, not per frame.** § 8 worded the lease as "per frame and per audio
   chunk". PR 1 already ships one `acquire()` + heartbeat per `understandArtifact` call, and the
   heartbeat — not the lease's narrowness — is what defuses `GpuArbiter`'s idle-eviction hazard
   (§ 8.1). Re-acquiring per frame would add N queue round-trips per video and let another caller
   take the GPU mid-artifact, leaving a half-captioned video whose partial state nothing records.
   The existing shape is kept and § 8's wording is corrected to match.

4. **`UNDERSTANDING_VERSION` goes to `2`.** `media-discovery.ts` re-offers any row whose
   `metadata.understandingVersion` is below the current constant, so the bump makes every
   already-transcribed video re-run and gain captions. Correct per § 4.1 (one stable row per
   artifact, version advances in place) and cheap in practice: PR 1 is default-off and one day old
   at PR 2's ship date.

5. **Frame captions are composed BEFORE the transcript in the body.** `bodyCapForItemType` clamps
   `video_understanding` at `BODY_MAX_PROSE` (16,384) and `item-store.ts` sets `body_complete = 0`
   automatically when the clamp bites. Captions-first means a long transcript loses its tail rather
   than the captions vanishing, and the truncation is already disclosed by `body_complete`.

6. **PR 4's static rule D27(a) must be re-derived, not copied.** § 10 wrote D27(a) as confining
   free functions named `describeBytes` / `transcribeBytes` to `media-gate.ts`. PR 2's model
   contact is a **provider method** (`VlmProvider.describe`) reached through a confined decorator
   (`wrapLedgeredVlm`, D22(g)), so a rule scanning for those two free-function identifiers would
   pass over the real shape and enforce nothing. Recorded here so PR 4 writes D27(a) against what
   actually exists by then.

---

## 16. PR 3 — the cloud arm (design, 2026-09-04)

PR 3 gives the pass access to media that lives in a connected service rather than under
`[[filesystem.roots]]`. Until it lands, multimodal understanding is structurally cut off from the
~90 connectors that are the rest of the product: the recorded call in Drive, the screenshot in a
OneDrive folder and the photo library are all invisible to it.

**Scope: `google_photos`, `google_drive`, `onedrive`.** Zoom is dropped from this PR — see § 16.7.

### 16.1 § 12.5 is wrong: this is a single-repo change

§ 12.5 states that "every connector that gains `fetchBytes` is a change in `nimbus-mcp-servers`,
not in this repo". That is false for all three target services. Their sync logic lives **here** and
calls the provider's HTTPS API directly from the gateway process — none of them reaches the MCP
subprocess mesh:

| Service | Where it fetches | What it already indexes |
| --- | --- | --- |
| `google_photos` | `photoslibrary.googleapis.com` (`google-photos-sync.ts`) | `metadata.mimeType`, `metadata.baseUrl` |
| `google_drive` | `googleapis.com/drive/v3` (`google-drive-sync.ts`) | `size`, `mimeType`, `type: "file"` |
| `onedrive` | Microsoft Graph (`onedrive-sync.ts`) | size, mime, `type: "file"` |

The gateway-side capability is still service-agnostic, so a connector whose sync genuinely lives in
`nimbus-mcp-servers` remains additive later. But PR 3 itself coordinates no second repo.

### 16.2 Placement

**Amended on landing — what shipped differs from what this section originally proposed. See § 17.10.**

- `multimodal/cloud-bytes.ts` — **new.** Owns dispatch, the byte caps, the scratch-file lifecycle
  and the byte-fetch egress append (`method='media.fetchBytes'`). The cloud analogue of
  `media-bytes.ts`'s local arm.
- `multimodal/cloud-url-resolver.ts` — **new**, and NOT in the original plan. Per-service byte-URL
  resolution lives here, in the multimodal directory, not next to each connector's sync: the three
  services differ only in one URL template and one response field, so the logic is a few lines per
  service and splitting it across three connector packages would have bought nothing but distance.
  It takes its collaborators as injected functions (`bearerFor`, `fetchFn`, `appendEgress`), which
  is what lets the credential rule of § 16.4 be tested with no network and no vault. It appends its
  OWN `sync` row (`method='media.resolveByteUrl'`) before the credentialed round-trip.
- `multimodal/cloud-renditions.ts` — **new.** The pure half of URL construction (§ 16.8's rendition
  suffixes), split out precisely so it can be tested without a transport.
- `media-bytes.ts` — **unchanged.** It keeps only `resolveLocalMediaPath`; the gate branches on
  `candidate.sourcePath === null` in `media-pass.ts` instead. The "ONE byte-acquisition
  collaborator" idea was not built.
- There is **no `fetchBytes` capability** and **no D24 exemption**. `sync/sync-capabilities.ts`
  mints nothing of the sort, and D24's SyncContext capability boundary was never opened. The cloud
  arm reaches providers through its own injected `fetchFn` (`util/safe-fetch.ts`'s
  `safeFetchFollowing`), wired in `multimodal/build-media-pass-deps.ts`.

`MediaCandidate` needs no change: `sourcePath: string | null` already carries "null for a cloud
artifact (PR 3)", and `sourceMime` / `sourceBytes` are already there.

### 16.3 The return type becomes a union, and § 5.4's disk rule must be restated

Images want bytes in memory (base64 to the VLM, nothing written). AV wants a seekable file, because
`whisper-cli` takes a path and ffmpeg needs to seek an MP4 whose `moov` atom is at the end (§ 5.4).
So byte acquisition returns `{ kind: "path" } | { kind: "bytes" }`, and the cloud AV arm streams its
download to a 0600 gateway-owned scratch file.

**This falsifies a claim that currently appears in this spec, in `CLAUDE.md` and in
`docs/roadmap.md`:** that the one transcode WAV is "the ONLY file this subsystem writes, on any
arm". Cloud AV writes two — the downloaded artifact and its transcode. Restated rather than shaved:

> The image path writes nothing, on either arm. The AV path writes at most **two** 0600
> gateway-owned scratch files — the downloaded artifact (cloud arm only) and its transcode — both
> deleted in a `finally` and both swept at pass start.

The start-of-pass sweep (§ 5.4) must learn the second filename pattern. Without that, a crash
mid-download leaves decoded media of the user's recording on disk indefinitely, which is precisely
the hazard the sweep exists for.

### 16.4 Credential rule: a credential is attached only to a URL we constructed ourselves

§ 5.2 routes the cloud arm through `sync/fetch-host-boundary.ts`. **It should not**, for two
independent reasons.

*Mechanically it does not fit.* The host boundary is exact-match with no guessing fallback, and
these download hosts rotate: Photos serves bytes from `lh3.googleusercontent.com`, OneDrive from a
per-item `@microsoft.graph.downloadUrl` on a rotating SharePoint/1drv host. Neither is derivable
from configured connector credentials, so both would miss the map and be refused.

*Conceptually it is the wrong instrument.* The host boundary answers "a **caller** handed me a URL
— is it fetchable, and for which service?" That is the untrusted-URL problem, and it is why
`targeted-fetch.ts` must consult it before any connector is reached. Here the URL is not
caller-supplied: it is produced by an authenticated API response, in our own session, for an item
already in the index. The threat that remains is different — a hostile or compromised provider
response naming a host we then hand a bearer token to. So the rule that replaces it is narrower and
checkable:

> **A credential is attached only to a URL this codebase constructed itself.**
>
> - `google_drive` — we build `drive/v3/files/{id}?alt=media` against the fixed
>   `www.googleapis.com` host. Bearer attached.
> - `google_photos` — `baseUrl` is provider-returned and **pre-signed**. Fetched with **no**
>   `Authorization` header.
> - `onedrive` — `@microsoft.graph.downloadUrl` is provider-returned and **pre-signed**. Fetched
>   with **no** `Authorization` header.
>
> A provider-returned URL is additionally pinned to `https:`. A response naming any host it likes
> therefore learns nothing: there is no credential on the request.

This is a stronger property than a host allow-list would give, and it does not rot when a provider
changes CDN hosts.

### 16.5 Modality resolution gains a mime-keyed arm

`google_drive` and `onedrive` index everything as `type: "file"` (`google-drive-sync.ts:170`,
`onedrive-sync.ts:97`), so `modalityForItem(service, type)` cannot resolve them. Modality for those
two comes from `metadata.mimeType`.

That does not weaken the registry's "never defaulted — guessing the modality means handing bytes to
the wrong model" rule: a mime type is the **provider's own declaration**, not our inference. An item
with no mime, or a mime outside the registry, is still skipped as `unresolvable_modality`.
`google_photos:photo` keeps the type-keyed lookup and reads mime only to split image from video.

**The mime filter MUST run in SQL, not in the JS loop** — see § 17.1. Filtering it in JS would
silently terminate the pass after one page on exactly the two connectors this section exists to
support.

### 16.6 Photos re-resolves rather than trusting the indexed URL

A Google Photos `baseUrl` expires roughly an hour after issue, so the indexed one is dead in almost
every case. The fetch re-resolves it via `mediaItems/{id}` in the same authenticated call that
would have been needed anyway.

Worth naming because it is the same rule as § 5.1's — never trust the URL or path stored on the
item — arrived at from the opposite direction. Locally the reason is security (roots may have
narrowed); here it is plain correctness. One rule, two justifications, no exceptions.

### 16.7 Zoom is dropped from PR 3, and the reason is not cost

`zoom-sync.ts` indexes `zoom:meeting` and `zoom:transcript` and **explicitly skips every recording
file whose `file_type` is not `TRANSCRIPT`** (line 181). Two consequences:

1. There is **no indexed item** for a Zoom recording's video or audio, so the pass has nothing to
   discover. PR 3 would first have to add a `zoom:recording` item type — a connector sync change, a
   new item type and its embedding-routing decision, inside a PR whose subject is byte-fetch.
2. Zoom **already supplies the transcript**, converted from VTT to plain text and indexed. The
   thing this slice adds for AV already exists for Zoom, produced by the provider, and more
   accurately than local `whisper-cli` would produce it.

So Zoom's remaining value here is frame captions of a recording, plus meetings where Zoom's own
transcription was disabled. Real, but a different job — recorded as a follow-up scoped honestly as
"index Zoom recording files and caption their frames", not as part of the cloud byte-fetch arm.

### 16.8 Renditions: originals by default, with the choice made discoverable

§ 12.9 deferred rendition choice to a per-connector cadence on the assumption that it was a
cross-repo negotiation. It is not (§ 16.1): for two of the three services a cheaper representation
is a different URL, not a negotiation.

| Service | Cheap rendition | Mechanism |
| --- | --- | --- |
| `google_photos` | bounded long edge; transcoded video | `baseUrl` suffix `=w2048-h2048` / `=dv` |
| `onedrive` | **none in PR 3** — deferred | Graph `/thumbnails` is a SECOND request per item |
| `google_drive` | none | `alt=media` or nothing |

**OneDrive renditions are deferred, and the earlier draft of this table overstated by listing them
as available.** Photos' rendition is a suffix on a URL already being fetched — free. OneDrive's is a
separate `/thumbnails` call per item, so it doubles the request count against a provider that is
already the most likely to rate-limit a bulk pass (§ 17.5). That is a different trade from Photos'
and it deserves its own decision rather than riding in on the same row. PR 3 fetches OneDrive
originals; `--renditions` is a no-op for that service and the summary says so rather than implying a
saving it did not make.

**The default is originals.** A downscale is a real quality loss on the one workload where this
subsystem is already weakest — § 12.10 concedes VLM OCR on a dense screenshot is materially worse
than a purpose-built pass, and downscaling makes that worse still. So the owner chooses, and the
design's job is to make sure they are actually offered the choice rather than nominally given a
config key. Three mechanisms:

1. **A flag, not only a key.** `nimbus media understand --renditions | --originals`, so it appears
   in `--help` and in `docs/cli-reference.md`. `[multimodal] prefer_renditions` (default `false`)
   persists the choice; the flag wins for a single run.
2. **The decision arrives before the bytes move** (§ 16.9).
3. **The run summary reports the counterfactual** — bytes fetched, and what the other choice would
   have cost — so the option stays visible to a user who never trips the budget.

**Disclosure.** The derived item's body states which rendition it was understood from. "Captioned
from a 2048px render" and "captioned from the original" are different claims, and § 12.3 / § 12.8
already hold this subsystem to saying which one it is making.

### 16.9 The budget: priced up front where possible, enforced on the running total always

A pre-flight total alone would be dishonest, because the sizes are not uniformly available: Drive
and OneDrive index a byte size, **Google Photos does not** — its `mediaMetadata` carries width and
height and no byte count. Printing an inferred total for a photo library would present an estimate
as a measurement, which is the failure mode this document's honesty rules exist to prevent.

**And the two sizes that do exist are not currently readable — see § 17.7.** `media-discovery.ts`
populates `sourceBytes` from `metadata.sizeBytes`, a key neither connector writes: Drive writes
`size` as a **string** (the Drive API returns int64 as a string) and OneDrive writes `size` as a
number. So `sourceBytes` is `null` for every cloud candidate today, on two independent counts. PR 3
must resolve the size through a per-service accessor before the pre-flight layer means anything.

Two layers instead:

- **Pre-flight prices what it knows and names what it does not:**

  ```text
  200 artifacts · 143 with known size ≈ 3.9 GB · 57 unknown (google_photos indexes no byte size)
  Refusing: known bytes exceed [multimodal] fetch_budget_bytes (2 GB).

    --renditions   fetch downscaled/audio-only where available
    --originals    fetch as-is, this run only
  ```

- **A running total aborts mid-pass** when actually-fetched bytes cross `fetch_budget_bytes`,
  reporting where it stopped. This is the layer that binds for Photos, and it is nearly free: the
  V58 cursor already makes the pass resumable, so stopping is a first-class outcome rather than a
  failure. The summary says the run was budget-stopped and is resumable — never a bare count.

The refusal is deliberate rather than a warning. This pass is non-interactive and about to move
gigabytes over someone's connection and quota; § 6.4's principle — a budgeted, enumerated set
approved once, up front — applies to bandwidth as much as to consent. The cost is that a first run
against a large library fails once before it works, which is the point.

The per-artifact cap still **refuses rather than truncates**; it bounds a single artifact,
`fetch_budget_bytes` bounds a run. **Amended on landing:** § 5.3's per-modality split
(`max_image_bytes` / `max_media_bytes`) was not built. What shipped is ONE hardcoded 250 MiB value
for both modalities — `DEFAULT_MAX_MEDIA_BYTES` in `multimodal/build-media-pass-deps.ts` — with no
config key and no flag. See § 17.10.

New config keys, both under `[multimodal]`:

| Key | Default | Meaning |
| --- | --- | --- |
| `fetch_budget_bytes` | `2_147_483_648` (2 GiB) | Per-run ceiling on cloud bytes fetched. Refuses pre-flight on known sizes; aborts mid-run on the actual running total. |
| `prefer_renditions` | `false` | Fetch a cheaper representation where the service offers one. `--renditions` / `--originals` override for one run. |

### 16.10 Skip reasons

Two joins to the `SkipReason` union, reusing `targeted-fetch.ts`'s vocabulary rather than a parallel
one (§ 5.2): `not_configured` and `rate_limited`. `fetch_miss` already covers a deleted or
unreadable artifact. `budget_exhausted` is **not** a skip reason — a budget stop ends the run, and
recording it per-item would misreport artifacts that were never attempted as artifacts that failed.

### 16.11 Egress: no new class, but I29's enumeration widens

Each outbound request appends one `sync`-class row **before** it fires, through
`egress/sync-egress.ts`'s existing appender, fail-closed — an append failure aborts the request.
`nimbus prove` needs no new vocabulary.

**Amended on landing — `payload_summary` carries the METHOD ONLY.** This section originally said it
records byte length, mime and modality. It does not, and cannot: `recordSyncEgress` builds
`payload_summary` as `redactEgressSummary({ method })`, and the append happens BEFORE the request,
where the byte length is genuinely unknown — a `content-length` header has not been seen yet and
may never arrive. Recording a size there would mean either appending after the transfer (which
breaks the fail-closed ordering that is the whole point) or writing a number the gateway guessed.
Mime and modality are known at append time, but were not added: they describe the artifact, not the
egress, and `method` plus `destination` already answer "what left, to whom". Pixels and transcript
text were never in scope and are not recorded.

**Amended on landing — the enumeration goes to FOUR, not three.** I29 documented the `sync` class as
*"`sync/scheduler.ts` appends one row per scheduled sync RUN and `sync/targeted-fetch.ts` appends
one row per targeted single-item fetch"*. The cloud arm adds TWO appenders, not one: a Photos or
OneDrive candidate makes two real outbound requests — the credentialed byte-URL RESOLVE round-trip
(`multimodal/cloud-url-resolver.ts`, `method='media.resolveByteUrl'`) and the byte fetch itself
(`multimodal/cloud-bytes.ts`, `method='media.fetchBytes'`) — and each appends its own row. Google
Drive constructs its byte URL with no round-trip and so appends only the second. Per the
sweep-enumerations rule the fix is to re-derive the list, not bump a count, in every place that
carries it: `CLAUDE.md`, `GEMINI.md`, `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md`, the
`nimbus-egress` skill, `egress/sync-egress.ts`, `egress/egress-coverage.ts` (+ its test),
`platform/assemble.ts`, `security-invariants.test.ts`, and `cli/src/commands/prove.ts`'s
user-facing `sync` scope label (+ its assertion in `prove-format.test.ts`).

**No `I37` in this PR.** I37 governs a media body reaching a non-local model; PR 3 adds no remote
model, so the invariant would have nothing to bite on and shipping it here would leave it documented
and inert — the exact failure § 5.4 was written to avoid. I37 and D27 stay with PR 4.

### 16.12 Testing

- **Per-service URL resolvers are tested against recorded real API response shapes**, not
  hand-written fakes. A fake proves the ends and never the wire, and this repo has been bitten by
  that repeatedly; the shapes here (`mediaItems.baseUrl`, `@microsoft.graph.downloadUrl`,
  `files.get?alt=media`) are exactly where a fake would agree with itself and disagree with Google.
- **The credential rule is red-provable and written as what cannot pass:** a test asserts that a
  request to a provider-returned URL carries **no** `Authorization` header, and that a
  provider-returned `http:` URL is refused. An allow-list-shaped assertion ("the bearer went to the
  right host") would pass a request that also leaked the token elsewhere.
- **The scratch-file sweep is tested for the second pattern**, including the crash case: a file left
  by a dead process is swept, and a concurrent pass's file younger than the sweep age is not.
- **The budget abort is tested on the running total**, with Photos-shaped candidates that have no
  indexed size — the case pre-flight cannot see.
- **One end-to-end acceptance run** against a real cloud artifact, producing an observed
  `video_understanding` row carrying a non-empty transcript AND at least one frame caption. This is
  the run that closes § 12.1's still-open claim: Phase 14 Core acceptance is currently recorded in
  `CLAUDE.md` as "structurally satisfiable, not verified end-to-end", and it stays that way until a
  real recording has been through the pass. Manual and machine-dependent (local `whisper-cli` + a
  vision-capable Ollama model), so it is recorded as performed with its output, not automated.

### 16.13 Docs to update on landing

Beyond § 14's list: `CLAUDE.md`, `GEMINI.md` (which mirrors it) and `docs/roadmap.md` all carry the
"only file this subsystem writes" sentence (§ 16.3) and the I29 `sync`-appender enumeration
(§ 16.11). Each is a restatement of a fact changed here, and a correction that lands at only one of
them is the drift this project has hit repeatedly. `docs/SECURITY-INVARIANTS.md` and the
`nimbus-egress` skill carry the appender enumeration too.

---

## 17. Review disposition (PR 3 design review, 2026-09-04)

External review: [`2026-09-04-s2-multimodal-io-design-review.md`](./2026-09-04-s2-multimodal-io-design-review.md)
(Antigravity). Every finding was checked against the shipped code before being accepted; the
verdicts below record what was verified, what was rejected, and one defect the review did not
find.

| # | Finding | Verdict |
| --- | --- | --- |
| 2.1 | Cursor starvation on `type: "file"` connectors | **Accepted** — § 17.1 |
| 2.2 | Modality split for `google_photos:photo` | **Accepted**, same fix — § 17.1 |
| 2.3 | Redirect handling, bearer leakage, SSRF | **Partly accepted** — § 17.2 |
| 2.4 | Stream-level budget, abort, summary fields | **Accepted** — § 17.3 |
| 2.5 | Scratch sweeper patterns | **Finding accepted, fix rejected** — § 17.4 |
| 2.6 | 429 backoff | **Accepted** — § 17.5 |
| 3.1 | I29 appender enumeration | Already § 16.11; `GEMINI.md` added to § 16.13 |
| 3.2 | I37 / D27(a)(b) formulation | **Deferred to PR 4** — § 17.6 |
| 3.3 | Embedding isolation audit | No action — verified sound, no change |
| 3.4 | Orphan pruning of derived rows | **Accepted, and it is a PR 1 gap** — § 17.6 |
| 4.1 | CLI mutual exclusivity, `--budget` | **Accepted** — § 17.8 |
| 4.2 | Summary formatting | **Accepted** — § 17.3 |
| — | `sourceBytes` is unreadable for both cloud services | **Found during review, not by it** — § 17.7 |

### 17.1 Discovery must filter mime in SQL, or the pass terminates after one page

**Verified.** `media-discovery.ts` applies `LIMIT` in SQL and then filters in JS
(`modalityForItem(...) === undefined → continue`). Today that JS filter can never drop a row,
because the type list it pages by comes from the same registry map — it is a no-op safety net.
§ 16.5's mime-keyed arm breaks that equivalence: `google_drive:file` enters the type list, and a
page of 50 PDFs yields zero candidates. `runMediaPass`'s short-page guard (`media-pass.ts`,
`stopReason === "completed" && candidates.length < deps.limit`) then reads that as "discovery
reached the end of the queue" and calls `clearCursor`.

The consequence is not a slow pass but a **silently truncated** one: a Drive with 40,000 files and
6 videos deep in the id ordering would report a clean, complete run having understood nothing. The
same shape applies to `google_photos:photo` under `--modality av`, since stills and videos share
one item type (finding 2.2).

**Fix — the predicate moves into SQL,** so the page and the JS result agree again and the existing
safety net stays a no-op:

```sql
AND (
  ((src.service = ? AND src.type = ?) OR (src.service = ? AND src.type = ?))
  OR (
    src.service IN (?, ?, ?)
    AND json_extract(src.metadata, '$.mimeType') LIKE ?
  )
)
```

**Amended on landing — arm 1 is pair-keyed, not type-keyed.** This snippet originally read
`src.type IN ('media_av', 'media_image')`. A later fix round ruled against that and replaced it
with OR'd `(service, type)` equalities, because a bare type match admits that type across every
OTHER service too — a future `zoom:recording` pair would catch an unrelated service's
`type: "recording"`, which the JS loop then drops for lacking a registered pair, under-filling the
page and re-creating the very truncation § 17.1 exists to fix. `buildModalityPredicate`
(`media-discovery.ts`) builds both arms and drops an EMPTY arm from the clause entirely rather than
emitting `src.type IN ()` or `AND ()`, both of which are SQLite syntax errors. Every literal above
is a bound parameter (I9); none is concatenated.

`:mimePrefix` is derived from the requested modality (`image/%`, or the video/audio pair for `av`),
never string-concatenated — I9. A row whose metadata carries no `mimeType` is excluded by the
predicate rather than fetched and dropped.

**The review's second recommendation — make `findCandidates` loop until `limit` candidates
accumulate — is rejected.** It changes `limit` from "rows examined" to "rows returned", which makes
a bounded pass unbounded in work: a `--limit 50` against a 40,000-file Drive with no media would
scan the whole table before returning. The budget and the resumable cursor both assume one page is
one bounded unit of work. Fixing the predicate keeps that true; looping breaks it.

**`json_extract` guard.** `json_extract` raises on malformed JSON rather than returning NULL. The
existing query already relies on `metadata` being connector-written and therefore well-formed
(`upsertIndexedItem` serialises it), and the same argument covers `src.metadata` — but the
predicate must tolerate a NULL `metadata` column, which `json_extract` handles and a bare
`LIKE` on the raw column would not.

### 17.2 Transport: manual redirects and the existing SSRF helper

The review's two risks are not equally live, and the difference was settled empirically rather than
assumed.

**Bearer leakage across a redirect — not reproducible on the shipped runtime.** A probe against
Bun 1.3.14 (a 302 from one loopback port to another, which is an origin crossing) shows the
`Authorization` header is **stripped** by `fetch` itself. So the review's first risk does not exist
today.

It is still designed against, for a reason unrelated to the risk being real: relying on it makes a
security property depend on undocumented third-party runtime behaviour that a Bun upgrade could
change without anyone noticing. **The cloud arm uses `redirect: "manual"` and follows hops itself**
(bounded at 5), which removes the dependency entirely and is what makes the next paragraph possible.

**SSRF — real, and only half-covered by what exists.** `share/safe-fetch.ts` already ships
`assertSafeUrl` / `isPrivateAddress` / `safeFetch`, covering IPv4 and IPv6 private ranges, IPv4-mapped
IPv6, and a DNS resolution check. PR 3 **reuses it rather than writing a second one** — a duplicate
private-range table is exactly the kind of thing that drifts.

But `safeFetch` validates only the URL it is handed: it passes `init` to `fetch`, which follows
redirects on its own, so a 302 to `127.0.0.1` is followed unchecked. Manual redirect handling closes
that: **every hop is re-validated through `assertSafeUrl`, not just the first.** This matters more
here than in `share/`, whose sink host is config-pinned, because a provider-returned download URL is
not pinned to anything — and the most interesting loopback target on this machine is the gateway's
own HTTP API (the I13 write surface), the same target I33's scope note names.

`safe-fetch.ts` moves from `share/` to `util/` in this PR. It is a general helper with no static
rule confining it, and a `multimodal/ → share/` import would read as a subsystem dependency that
does not exist.

**Known limitation, inherited and restated:** `safeFetch`'s own doc records a DNS-rebind TOCTOU it
does not close (resolution happens twice, and pinning the IP would break TLS verification in Bun).
That bound applies here too and is not re-litigated by this PR.

### 17.3 Budget enforcement is stream-level, and the summary must say so

Three sub-points, all accepted.

1. **Check during the stream, not after it.** Bytes are counted as they arrive and the budget is
   evaluated per chunk. Downloading 300 MB to discover 50 MB of budget remained wastes the exact
   resource the budget exists to conserve.
2. **An overrun aborts through `AbortController`**, severing the connection, and the partial scratch
   file is removed in a `finally` — the same unwinding the transcode path already uses.
3. **`MediaPassSummary` gains two fields.** It currently carries `understood` / `skipped` /
   `skippedByReason` / `lastItemId` and has no way to express "stopped early but healthy":

   ```ts
   readonly stopReason: "completed" | "budget_exhausted" | "rate_limited";
   readonly cloudBytesFetched: number;
   ```

   Without `stopReason` a budget stop is indistinguishable from a completed run, which would make the
   CLI's resume guidance unprintable and — worse — would let a truncated pass report as a finished
   one. That is the same disclosure failure § 8 forbids for skip counts.

`budget_exhausted` deliberately does **not** join `SkipReason` (§ 16.10): a budget stop ends the run,
and recording it per-item would report artifacts that were never attempted as artifacts that failed.

### 17.4 Scratch sweeper — finding accepted, proposed fix rejected

**Verified:** `sweepStaleScratchFiles` (`stt/ffmpeg-bin.ts:181`) matches only
`nimbus-stt-*.wav` (line 194), so a cloud download scratch file left by a killed process is never
reclaimed.

The review's fix enumerates extensions — `.tmp`, `.wav`, `.mp4`. **Rejected:** a cloud download's
extension is whatever the artifact happens to be (`.mov`, `.mkv`, `.m4a`, `.webm`, …), so that list
is guaranteed to drift and will fail exactly on the formats nobody thought of. Extension is the
wrong key.

**Instead the prefix is the key, and it is the only key.** Cloud downloads are named
`nimbus-media-<uuid>` with **no extension at all** — nothing downstream needs one, since ffmpeg
probes content rather than trusting a suffix. The sweeper matches `nimbus-stt-` (existing, extension
retained for compatibility with in-flight files) or `nimbus-media-` (new), both age-bounded exactly
as today. A pattern that cannot be extended by a new media format cannot rot.

### 17.5 429 handling stops the run rather than burning the candidate list

**Accepted.** Treating a 429 as a per-item skip means a quota-limited album produces one 429 per
candidate and risks account-level throttling — the pass would do maximum damage precisely when the
provider is asking it to stop.

Bounded retry with jitter, honouring `Retry-After` where present; on persistent limiting the run
**stops** with `stopReason: "rate_limited"` and a resumable cursor. This matches the existing
precedent in `zoom-sync.ts`, which calls a 429 a "graceful break" rather than a skip.

### 17.6 Two items that are not PR 3's, and are recorded rather than absorbed

**I37 / D27 (finding 3.2) stay with PR 4.** The review's formulation — D27(a) confines the
grant check to `media-gate.ts`, D27(b) confines `media_grant` writes to `media-grant-store.ts` — is
sharper than § 10's original and supersedes it, which § 15 decision 6 already anticipated. It is
recorded here and written in PR 4, when a remote provider exists for it to bite on. Shipping it now
would produce a rule guarding nothing.

**Orphan pruning (finding 3.4) is a PR 1 gap, and § 4.2 currently overstates.** Verified:
`understanding-item.ts:64` writes `derivedFrom`, and **nothing in the codebase reads it** — there is
no cascade in `deleteItemByServiceExternal`, no orphan query, nothing. So § 4.2's "Deleting a source
item deletes its derived understanding row" describes behaviour that does not exist. That is the
documented-but-inert failure this document elsewhere goes out of its way to avoid, and leaving it
stated as fact is worse than the missing feature.

PR 3 closes it, because it is small and it is this PR that makes orphans common (a cloud item can
leave the index without any local file being touched): one age-independent orphan `DELETE` at pass
start, alongside the scratch sweep that already runs there. Keyed on `derivedFrom` having no
surviving source row. Cheaper than a cascade in every delete path, and it self-heals rows orphaned
before it shipped.

### 17.7 The defect the review did not find: `sourceBytes` is null for every cloud candidate

`media-discovery.ts` populates `sourceBytes` from `metadata.sizeBytes` via `numberOrNull`. Neither
target connector writes that key:

| Service | Key written | Type written | Read as `sizeBytes: number` |
| --- | --- | --- | --- |
| `google_drive` | `size` (line 180) | **string** — the Drive API returns int64 as a string | `null` — wrong key *and* wrong type |
| `onedrive` | `size` (line 72) | number | `null` — wrong key |
| `google_photos` | — | — | `null` — genuinely absent |

`sizeBytes` belongs to a different subsystem entirely (`data-profile-sync.ts`), which is how the
mismatch survived: the key exists, so nothing looked wrong.

This matters because § 16.9's pre-flight layer is built on knowing sizes. Uncorrected, **every**
cloud candidate reports unknown size, the pre-flight price is always `0 known / N unknown`, the
budget refusal never fires, and the whole first layer is decoration — leaving only the running-total
abort, which was designed as the backstop rather than the whole mechanism.

**Fix:** resolve size through a per-service accessor in `media-source-registry.ts` that names the
metadata key and coerces, with the Drive string case handled explicitly and commented — a numeric
read of a string field returning `null` is silent, and a silent `null` here degrades a safety
mechanism rather than breaking anything visibly. Read at discovery rather than normalised at index
time, so already-indexed rows are covered without a re-sync.

### 17.8 CLI

- `--renditions` and `--originals` are **mutually exclusive**, rejected at parse with a message
  naming both, never resolved by precedence. A silent override on a flag pair that controls
  bandwidth is the kind of thing a user discovers from their data cap.
- **`--budget <size>`** (accepting `4GB` / `500MB` / a raw byte count) overrides
  `fetch_budget_bytes` for one run. Not scope creep: § 16.9 makes refusal the default, and without
  this the only way past a refusal while keeping originals is editing `nimbus.toml` — which
  re-creates the discoverability problem § 16.8 exists to solve.
- The run summary reports understood/skipped-by-reason (existing), plus bytes fetched, the rendition
  mode in force, the counterfactual for the other mode, and `stopReason` with resume guidance when
  the run stopped early.

### 17.9 Testing additions

Folded into § 16.12: redirect-hop re-validation (a 302 to `127.0.0.1` is refused), a private-IP
target refused at hop 0 and at hop N, the paging test the review specifies (100 `google_drive`
`type: "file"` rows of which only #70–#75 are media, asserting the pass does not clear its cursor at
page 1), and a size-resolution test covering Drive's string-typed `size`.

### 17.10 Deviations ratified on landing, recorded here because § 16 was written before the code

Task 8 ratified each of these when the code landed, but the sections that describe them were never
updated — so a reader following § 16 alone would look for files and mechanisms that do not exist.
Each is a deliberate choice, not an omission:

| § | What the section said | What shipped | Why |
| --- | --- | --- | --- |
| 16.2 | Byte acquisition lands in `media-bytes.ts` | `media-bytes.ts` is **unchanged**; the cloud arm is `multimodal/cloud-bytes.ts` and `media-pass.ts` branches on `candidate.sourcePath === null` | One collaborator with two unrelated failure vocabularies is harder to read than two collaborators with one each |
| 16.2 | Per-service URL resolution lives next to each connector's sync, reached through a `fetchBytes` capability minted in `sync/sync-capabilities.ts` — "the sole D24 exemption" | `multimodal/cloud-url-resolver.ts`, with injected `bearerFor`/`fetchFn`/`appendEgress`. **No such capability exists and D24 was never opened** | The per-service difference is one URL template and one response field; splitting a few lines across three connector packages would have bought distance, not cohesion — and opening D24's capability boundary for it would have been a real security-surface change bought for nothing |
| 16.9 | Per-modality caps `max_image_bytes` / `max_media_bytes` (§ 5.3) | ONE hardcoded 250 MiB `DEFAULT_MAX_MEDIA_BYTES`, no config key, no flag | Neither key was built; the split bought nothing while `fetch_budget_bytes` (which IS configurable) is the bound that actually binds a run |
| 16.11 | `payload_summary` records byte length, mime and modality | `method` only | The append precedes the request, where the byte length is unknowable without either breaking the fail-closed ordering or guessing |
| 16.11 | The `sync` enumeration becomes **three** appenders | **Four** | The resolve round-trip is a second real credentialed request per Photos/OneDrive candidate and appends its own row — see § 16.11 |
| 17.1 | Arm 1 of the discovery predicate is `src.type IN (...)` | OR'd `(service, type)` equalities | A bare type match crosses service boundaries — see § 17.1 |

---

## 18. PR 4 — the remote arm (design, 2026-09-05)

PR 4 is the last of the four and the one the sequencing put last on purpose: it is the first time a
media body leaves the machine for a model. Everything before it kept understanding local and only
changed where the bytes came from.

**Scope: images only.** § 12.7 pins speech-to-text local-only across all four PRs, and that does not
move here. I37 below is worded generally so a later remote STT tier inherits it rather than needing
a new invariant, but today it holds vacuously for audio.

**Prerequisite already shipped, deliberately ahead of its caller.** `egress/vlm-egress.ts`'s
`wrapLedgeredVlm` (static rule D22(g)) landed in PR 2, before any remote `VlmProvider` existed —
the same gate-before-the-thing-it-gates posture PR 1 used. PR 4 is the first time it decorates a
real remote call. Worth stating rather than assuming: **a decorator that has never decorated a
remote request is untested in the way that matters**, so its first exercise is part of this PR's
acceptance rather than a foregone conclusion.

Likewise `media-gate.ts` step 3 already refuses every non-local provider with `no_remote_grant`.
**PR 4 adds an ARM to an existing gate; it does not introduce a gate.**

### 18.1 Four independent gates, in order

An image reaches a remote model only if all four hold:

1. **Org policy** — `EnforcedPolicy.capabilitiesDisabled` does not list `multimodal_input` (I22).
   Already live since PR 2 and fail-closed when the accessor itself is absent.
2. **`[multimodal] enabled`** — default false, unchanged.
3. **`[multimodal] remote_vlm = "<vendor>"`** — NEW, default unset. Enabling a vendor for text must
   not silently widen it to a photo library (§ 18.2).
4. **A durable, artifact-scoped grant** for that exact artifact and vendor (§ 18.3).

Each is checked before the one after it, and each refuses rather than degrading. The order matters
for the same reason it does in I33 and I35: a capability that is off must never announce itself by
prompting.

### 18.2 Credentials are REUSED; the capability is NOT

The vendor key comes from the existing `[llm.remote.<vendor>]` Vault entry that slice 2b
established — **not** a second credential surface.

That inheritance is the point. Slice 2b's property is that a key is read from the Vault and NEVER
from the environment, so a credential that merely exists cannot enable anything. Minting a parallel
`[multimodal.remote]` secret would duplicate that surface and give a future bug a second place to
leak from, for no gain: it is the same vendor, the same account, the same key.

But the **capability** is not inherited. `[multimodal] remote_vlm` is its own default-off switch,
because "I gave you my OpenAI key so `nimbus ask` works" is not the statement "you may send my
photos to OpenAI". Reusing the key while requiring a separate opt-in is the split that matches what
the user actually consented to.

`remote_vlm` names a vendor that must already be enabled under `[llm.remote.<vendor>]`; naming a
disabled or unknown vendor is a config error that fails the section off, matching this file's
existing fail-off contract for `enabled` and `max_frames`.

### 18.3 The grant (schema V59)

`index/media-grant-v59-sql.ts`, exactly as § 6.2 specified:

```sql
CREATE TABLE IF NOT EXISTS media_grant (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL,
  modality      TEXT NOT NULL CHECK (modality IN ('image', 'av')),
  model_vendor  TEXT NOT NULL,
  granted_at    INTEGER NOT NULL,
  revoked_at    INTEGER
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_grant_active
  ON media_grant (item_id, modality, model_vendor)
  WHERE revoked_at IS NULL;
```

Two properties that are not incidental:

- **No `'all'` vendor.** A wildcard grant is broader than anyone means when they approve one, and it
  would silently extend to a vendor added after the grant was given. Authorising two vendors means
  two grants.
- **Uniqueness is a partial index over ACTIVE rows.** A plain `UNIQUE(item_id, modality)` makes
  revocation terminal — the revoked row occupies the slot forever — so the same artifact could never
  be re-granted without mutating history. Scoping to `revoked_at IS NULL` keeps revocation an
  append-only audit trail while still permitting exactly one live grant per (item, modality, vendor).

`modality` retains `'av'` even though PR 4 grants only images, because the column outlives the
scope: a later remote STT tier writes `'av'` rows into the same table rather than migrating it.

### 18.4 The pass never prompts

The load-bearing consent decision, unchanged from § 6.3 and restated because PR 4 is where it
becomes real: **granting is a separate, deliberate act.** The pass reads existing grants and
silently declines remote for everything not covered, reporting the declines by reason in its
summary.

A batch over 500 photos that prompts 500 times does not produce 500 decisions. It produces one
decision followed by 499 reflexes, and the gate stays technically satisfied while having stopped
meaning anything — the same failure I33's docs guard against when they insist the owner sees the
verbatim body rather than a digest.

Surfaces: `nimbus media allow-remote <item>`, `nimbus media grants list`, `nimbus media grants revoke`.

### 18.5 Batch granting, and the preview names BOTH ends

Granting one artifact at a time does not scale to an album, and a rule that is unusable gets worked
around. So a selector form exists, with a **mandatory, capped** `--limit` so an unbounded "grant
everything" is not expressible:

```text
nimbus media allow-remote --service google_photos --since 2026-08-01 --limit 20
```

It renders ONE preview that **enumerates** the matching artifacts — titles, dates, sizes, count —
and takes ONE confirmation, writing the grants in a single transaction. The preview must enumerate
rather than summarise: "20 items" is a count, not consent.

**New in PR 4, because PR 3 changed what a grant can authorise.** When § 6.4 was written every
artifact was a local file. Since the cloud arm shipped, a granted artifact may be one whose bytes
live in Google Photos, Drive or OneDrive — so approving it authorises a **cross-vendor transfer**:
bytes the owner stored with one provider being sent to a different one. The preview states both
ends explicitly:

```text
20 photos · source google_photos · destination openai
```

A local artifact reads `source local`. This is not a schema change and not a second grant kind — one
grant concept, one revocation story — but the owner sees the actual path before approving, which is
the whole purpose of an enumerated preview.

### 18.6 Invariant I37

> **I37** — a media body reaches a NON-LOCAL model only through `multimodal/media-gate.ts`, and only
> when a durable, artifact-scoped remote grant exists for **that** artifact and that vendor. Absent a
> grant the gate REFUSES rather than degrading to remote; a local provider that is unavailable
> likewise refuses rather than falling back — the same fail-closed posture as `enforce_air_gap`.
> Locality is DERIVED from `provider.isLocal` (I34) and never supplied by a caller. Every remote send
> appends one `model`-class row BEFORE the request and an append failure aborts it (fail-closed,
> `egress/vlm-egress.ts`'s `wrapLedgeredVlm`, D22(g)). Media bytes never appear in `payload_summary`,
> which carries the model name and the image's byte COUNT. The DISK rule is § 5.4's narrowed one as
> amended by § 16.3, not an absolute.

**Scope note.** Because STT is local-only in this slice (§ 7, § 12.7), images are the only modality
that can reach a non-local model today. The invariant is deliberately NOT narrowed to images in its
wording: a remote STT tier added later should inherit it rather than need a new one.

### 18.7 Static rule D27 — re-derived against what actually shipped

§ 10 wrote D27(a) as confining free functions named `describeBytes` / `transcribeBytes`. **Those
functions have never existed**, as § 15 decision 6 already recorded. A rule scanning for those two
identifiers would pass over the real shape and enforce nothing — a guard that is documented and
inert, which is the failure § 5.4 was rewritten to avoid.

The real shape: model contact for vision is a provider METHOD, `VlmProvider.describe`, reached
through the D22(g)-confined decorator `wrapLedgeredVlm`.

**The gap that leaves.** `wrapLedgeredVlm` guarantees a remote describe is LEDGERED. It does not
guarantee it was GATED. A ledgered-but-ungated describe satisfies I29 and still violates I37: the
bytes go, the row is written, no grant was ever checked. D27 exists to close exactly that.

- **D27(a)** — a NON-LOCAL `VlmProvider` may be CONSTRUCTED in only one factory, and that factory is
  nameable only by `build-media-pass-deps.ts` (plus its own definition). A remote describe is
  therefore unreachable from anywhere else by construction rather than by convention.

  **Corrected 2026-09-05 (§ 19, finding 3.5): this line first said `media-gate.ts`, and that was
  wrong.** `media-gate.ts` constructs nothing — it receives an understander through
  `understanderFor` and never names a provider factory. The site that builds providers is
  `build-media-pass-deps.ts:232`, which already carries the comment "THE ONLY production site that
  may name `createOllamaVlm` or `wrapLedgeredVlm`" under D22(g). Confining the remote factory
  anywhere else would have split one wiring site into two and left D22(g) and D27(a) pointing at
  different files for the same class of object.

  Confining the constructor rather than the `.describe(` call is deliberate, and follows two
  precedents in this codebase. D22(g) already confines `createOllamaVlm` to its wrap site for the
  same reason. And D26(c) confines the computer-use LANE CONSTRUCTORS specifically because "the
  capability travels as a function VALUE that neither (a) nor (b) can see" — a method-name regex
  cannot follow a provider held in a variable and invoked through an alias, which is the same
  weakness that let a raw CDP socket pass D26(b) silently before that rule was widened. A
  value-creation site is source-scannable in a way a method call on an aliased object is not.

- **D27(b)** — a grant is readable only through `multimodal/media-grant-store.ts`, so no caller can
  synthesise one or read around the store's active-row filter.

Wiring, docs entry and enforcement test land in the SAME commit — the triple rule. Retiring any of
it means deleting the row, never leaving drift.

### 18.8 Egress: no new coverage class, but a first real exercise

The `model` class is already `per-call` and already names `wrapLedgeredVlm` as its fourth appender
(D22(g)). PR 4 adds no class, no appender and no `nimbus prove` vocabulary.

What it does add is the first remote `VlmProvider` in production, so it is the first time that
appender decorates a call that actually leaves the machine. `THIS_BINARY_COVERAGE` does not change;
the claim it makes simply becomes load-bearing for vision.

### 18.9 Bounds

- **No remote STT, at any tier.** A user with a frontier key and no usable local whisper still cannot
  transcribe — the pass refuses rather than reaching for the cloud. Deliberate: it keeps I37's
  practical scope to images, avoids a second provider interface and a fifth decorator, and keeps the
  strongest version of the privacy claim true for the modality where recordings of real
  conversations live.
- **OCR quality is unchanged** (§ 12.10). A remote VLM may read a dense screenshot better than the
  local one, but no dedicated OCR engine ships here either.
- **A caption is still a guess** (§ 12.3). `modelDerived: true` is not weakened by the model being
  larger or remote.
- **The disclosure must say which model.** A remote-understood artifact records its vendor and model,
  so a reader can tell a local caption from one a third party produced.
- **PARTLY SUPERSEDED 2026-09-05 — see § 20.** The Google DRIVE leg has now been run against a real
  provider and passed; the PHOTOS and ONEDRIVE legs have not, so the paragraph below still holds for
  them and the Photos rendition question it names is still open.
- **PR 3's acceptance run remains unperformed.** No leg of the cloud arm has contacted a real
  provider. PR 4 therefore builds a consent surface on top of a fetch path proven only against
  fakes: whether Drive's 302 to `googleusercontent.com` still serves bytes after the bearer is
  stripped, and whether Photos' rendition suffixes behave as assumed, are still unverified. Both
  fail closed as `fetch_miss` rather than dangerously, but the composition of PR 3 and PR 4 —
  cloud-fetched bytes forwarded to a third-party model — is the path with the least real-world
  evidence behind it in the whole slice, and its own acceptance run should exercise exactly that.

### 18.10 Docs to update on landing

`CLAUDE.md` and `GEMINI.md` (the I37 row and the invariant range, which becomes I1–I37),
`docs/SECURITY-INVARIANTS.md` (the I37 section and D27's two rules),
`docs/architecture.md` (schema V59), `docs/roadmap.md` (the multimodal row closes as 4 of 4),
`docs/cli-reference.md` (`allow-remote`, `grants list`, `grants revoke`, and `[multimodal] remote_vlm`),
and `.claude/commands/nimbus-egress.md` only if the `model` class wording changes — it should not.

---

## 19. Review disposition (PR 4 design review, 2026-09-05)

Review: [`2026-09-05-s2-multimodal-io-design-review.md`](./2026-09-05-s2-multimodal-io-design-review.md)
(Antigravity), against § 18 plus the three shipped PRs. Twelve findings. **Ten accepted, one
accepted with its central rule rejected, one answered rather than built** — plus one finding of my
own that the review circled without naming (§ 19.A) and one correction to § 18 itself (3.5).

Findings 2.1, 2.2, 2.3 and the § 18.7 confinement site were fixed **in place** above rather than
described here, because they are drift: leaving the wrong text and a note saying it is wrong is how
a document acquires two answers to the same question.

### 19.1 Finding 3.1 — a grant on an already-understood item does nothing · **ACCEPTED (critical)**

Verified. `media-discovery.ts:119` re-offers a candidate only when

```sql
(u.id IS NULL OR COALESCE(json_extract(u.metadata, '$.understandingVersion'), -1) < ?)
```

so an image already captioned by the local VLM sits at the current `UNDERSTANDING_VERSION` and is
skipped. `nimbus media allow-remote` on a library that has already been indexed would therefore
report `Understood 0 items` and change nothing.

This is the **ships-inert** class, and it is the third time in this slice: § 4.2's `derivedFrom` was
written and never read for two PRs, and § 16.11's ledger claim covered a call path the
implementation had split in two. The pattern is the same each time — a new writer with no
corresponding change to the reader.

**Ruling: recommendation 2 (a discovery predicate), and recommendation 1 (grant-driven row
invalidation) is REJECTED.** Invalidation writes `understandingVersion = 0` at grant time, which
re-offers the item on every pass *until something understands it*. The moment the remote arm cannot
run — vendor disabled, key rotated out of the Vault, rate limit, org policy flipping
`multimodal_input` off — the item is re-offered, refused, and re-offered again, forever. That is
exactly the livelock PR 3 hit with the pass cursor (§ 17), where a correct fix generated the next
defect: the state that says "do this again" must never be written by anything other than the thing
that can also clear it.

The predicate keeps the decision derived rather than stored, so it self-corrects the instant
`remote_vlm` changes:

```sql
OR EXISTS (
  SELECT 1 FROM media_grant AS g
   WHERE g.item_id = src.id
     AND g.revoked_at IS NULL
     AND g.model_vendor = ?              -- the CONFIGURED vendor, or no row is bound at all
     AND json_extract(u.metadata, '$.isLocal') = 1
)
```

Three properties are load-bearing and each is an enforcement test:

- **The bound vendor is the configured one.** With `remote_vlm` unset the arm binds nothing and the
  clause is omitted entirely, so an unconfigured install re-offers **zero** items and the query
  costs what it costs today. A grant for a vendor the user is no longer using is inert, not a
  standing re-offer.
- **`isLocal = 1` on the existing row.** Without it, an item understood remotely is re-offered on
  every subsequent pass and re-sent to the vendor each time — a consent surface that bills the user
  forever off one approval. This clause is what makes the upgrade one-directional.
- **`json_extract` on a row that may have no metadata.** `sqlite json_extract` RAISES on malformed
  JSON; the existing predicate already guards with `COALESCE(..., -1)` and the new clause must be
  written to the same standard rather than assuming every derived row round-trips.

### 19.2 Finding 3.2 — `VlmDescribeInput` carries no mime type · **ACCEPTED, and made stricter**

Verified: `vlm/vlm-types.ts` declares `{ bytes, prompt, egressMethod? }` and nothing more, and
`vlm/image-understander.ts` never mentions mime at all — the value exists upstream
(`MediaCandidate.sourceMime`, and `MediaSource`'s bytes arm carries `mime: string | null`) and is
dropped at the seam. Ollama tolerates that; Anthropic returns HTTP 400 without a `media_type`, and
Gemini and OpenAI both need one on the wire.

Accepted, with one inversion. The review proposes a magic-byte sniffer as a **fallback** when the
declared mime is missing or generic. **The sniffer is the authority and the declared value is the
fallback**, because on the cloud arm the declared value is a remote provider's `Content-Type`
header — `media-types.ts` already says in so many words that it is "not something an understander
should trust further than that" — and a wrong `media_type` is not a soft failure: Anthropic rejects
`image/png` over JPEG bytes outright, so trusting the header converts a provider quirk into a
per-artifact failure the user cannot diagnose.

- `vlm/image-mime.ts` sniffs JPEG / PNG / WebP / GIF from the leading bytes.
- Sniff resolves → that is the wire `media_type`, whatever the header claimed.
- Sniff inconclusive **and** the declared value names one of the four → use it.
- Neither → **refuse this artifact**, with a new `unsupported_image_format` skip reason. Bytes of an
  unknown type are not sent to a vendor on the theory that it might cope. HEIC straight off an
  iPhone lands here, which is a real and reportable outcome rather than a 400 with no explanation.

`mimeType` is added to `VlmDescribeInput` as **required at the remote adapters and optional on the
interface**, so the local Ollama path is unchanged and no existing caller breaks.

### 19.3 Finding 3.3 — the provider-selection matrix · **ACCEPTED, with row 3 REJECTED**

The matrix is the right artifact and mostly right. Two corrections.

**(a) `describe_failed` does not exist.** The shipped `SkipReason` union is `over_byte_cap |
no_local_model | no_remote_grant | unresolvable_modality | fetch_miss | path_outside_roots |
transcode_failed | transcribe_failed | not_configured | rate_limited`, and `media-gate.ts`'s catch
arm returns `transcribe_failed` for every modality including images. Reusing it for a failed remote
*describe* prints "transcribe failed" for a photograph, which is a lie in the one line the user
actually reads. **`describe_failed` is added to the union**, and the gate's catch arm branches on
modality. The CLI's hand-mirrored `SkipReasonKey` must be extended in the same commit — that mirror
has already crashed the summary once (§ 17).

**(b) Row 3 — "grant active, `remote_vlm` unset → refuse `no_remote_grant`" — is wrong and is
rejected.** A grant is a **permission, not a mandate**. Under that row, a user who grants remote and
then disables the vendor loses local captioning on those items too: a capability that worked before
they granted anything stops working *because* they granted something. Consent that can only widen
behaviour must not be able to remove it.

**Ruling: a grant with no configured remote arm resolves exactly as if no grant existed — use the
local VLM.** This also keeps § 19.1 coherent: with `remote_vlm` unset nothing is re-offered, so the
item is never re-visited to be refused in the first place. The two rulings have to agree, and
under the review's version they do not.

The corrected table, which is the specification for `understandArtifact`'s remote arm:

| Active grant? | `remote_vlm` set **and** `[llm.remote.<vendor>] enabled`? | Local VLM available? | Resolution | Outcome |
| :-- | :-- | :-- | :-- | :-- |
| No | *any* | Yes | Local VLM | `ok: true` (`isLocal: true`) |
| No | *any* | No | Refuse | `ok: false, reason: "no_local_model"` |
| Yes | **No** | Yes | **Local VLM** (a grant never removes a capability) | `ok: true` (`isLocal: true`) |
| Yes | **No** | No | Refuse | `ok: false, reason: "no_local_model"` |
| Yes | Yes | *any* | Remote VLM via `wrapLedgeredVlm` | `ok: true` (`isLocal: false`) |
| Yes | Yes, and the remote call fails | *any* | Refuse — **never degrade to local** | `ok: false, reason: "describe_failed"` |

The last row is the review's key rule and it is accepted without change. A silent fall-back to local
on a rate limit means the same command produces a frontier caption on Tuesday and a 7B caption on
Wednesday, with nothing in the output saying which — and § 12.3's "a caption is still a guess" only
holds as a bound if the reader can tell which guesser made it.

Note that the "non-local, no grant" row has no entry here because it is unreachable by construction
once § 19.A lands: a remote provider is only ever resolved *for* a granted artifact. The gate's
existing step-3 refusal stays anyway, as the structural backstop it has been since PR 1.

### 19.4 Finding 3.4 — remote frames + local transcript on one video · **ANSWERED, not built**

The hybrid the review asks about is **already structurally impossible**, and PR 4 keeps it that way.
`frames/av-understander.ts:146` declares the composite's locality as a conjunction:

```ts
isLocal: deps.stt.isLocal && deps.vlm.isLocal
```

Inject a remote VLM into the AV understander and the whole composite reports `isLocal: false`, so
`media-gate.ts` step 3 refuses the entire video — transcript included — with `no_remote_grant`. The
conjunction is right and stays: a composite is exactly as local as its least local half, and the
alternative (a per-half locality flag) would put a caller-shaped boolean back into the one place I34
exists to keep derived.

**Ruling: `understanderFor("av")` resolves the all-local composite unconditionally in PR 4.** Video
frames are captioned locally or not at all. Building the hybrid would mean a second `UnderstandOutcome`
shape (`model: "gpt-4o + whisper-cli"`, a split disclosure, a per-half `isLocal`) for a modality
§ 12.7 and § 18 both put out of scope — an interface widened for a feature that is not shipping.

That leaves the question the review's framing exposes: what should `nimbus media allow-remote`
do when handed a **video**? Writing an `'av'` grant that nothing will ever read is the ships-inert
pattern again, one layer up. **The store REFUSES to write a `modality = 'av'` row in PR 4**, with the
message naming the bound ("remote understanding is images-only in this release"). The CHECK
constraint keeps `'av'` because the column outlives this scope (§ 18.3) — the *column* is
forward-looking, the *writer* is not.

### 19.5 Finding 3.5 — D27 confinement mechanics · **ACCEPTED; and it corrects § 18.7**

The review is right and § 18.7 was wrong: the confinement site is `build-media-pass-deps.ts`, not
`media-gate.ts`. Corrected in place above. `grep -c createOllamaVlm packages/gateway/src/multimodal/media-gate.ts`
returns `0`; `build-media-pass-deps.ts:232` already carries the D22(g) comment naming itself "THE
ONLY production site". A rule pointing at the gate would have enforced nothing while reading as
though it enforced everything — the same defect § 10's own D27(a) already had, twice over now.

Accepted with two widenings:

- **Scan repo-wide with an explicit allow-list, not "files outside `multimodal/`".** D22(g)'s
  precedent scans every file and allows two named ones, which is what keeps the rule alert *inside*
  the directory that legitimately contains the construction. A directory-level exemption makes every
  future file in `multimodal/` a permitted construction site.
- **Paren-matched per occurrence, as D22(g) does for `createOllamaVlm`.** The check is that each
  remote-factory call sits inside a `wrapLedgeredVlm(...)` argument list — not that the file
  contains both identifiers somewhere. File-level co-occurrence passes an unwrapped second
  construction in a file whose first construction is wrapped.

D27(b) accepted as written, with one addition: the scan keys on the **table name** `media_grant` in
any string literal, allowing `multimodal/media-grant-store.ts` and `index/media-grant-v59-sql.ts`
only. That is weaker than a symbol-confinement rule — a dynamically assembled identifier evades it,
as it evades every source scanner here — and the residual is closed the way the others are, by
capability: only the store is handed a `Database`.

The red-prove requirement is accepted and is the part most likely to be skipped. A structure-audit
rule that has never been shown to fail is a rule nobody has tested.

### 19.6 Finding 4.1 — grant idempotency and batch dedup · **ACCEPTED**

All three, cheaply:

- `createGrant` on an already-active `(item_id, modality, model_vendor)` returns the existing row's
  id rather than raising `SQLITE_CONSTRAINT_UNIQUE`. **Not `INSERT OR IGNORE`** — that succeeds
  silently while returning no id, so the caller cannot tell "already granted" from "just granted",
  which is precisely the distinction the preview has to print.
- Re-granting after revocation is already correct by the partial index and needs a test, not code.
- The batch preview separates new from already-granted and reports `Granted 16 new items (4 already
  granted)`. § 18.5's rule is that a preview enumerates rather than summarises; a count that
  silently includes rows the run did not write is the same failure in miniature.

### 19.7 Finding 4.2 — orphaned grants · **ACCEPTED, with the bound stated**

Real gap. `orphan-prune.ts` deletes derived understanding rows whose `derivedFrom` no longer
resolves, and PR 4 adds a table it does not know about. The sweep runs in the same place, at pass
start, and **revokes rather than deletes** — § 18.3's whole argument for the partial index is that
revocation is an append-only audit trail, and a pruner that deletes rows would be the one caller
allowed to rewrite history.

Two bounds, both accepted rather than engineered around:

- A prune-revocation and an owner revocation are indistinguishable in the table. Adding a
  `revoked_reason` column to tell them apart serves no reader: the item the row points at is gone,
  so nothing can render the distinction anyway.
- **An item that leaves the index transiently — a reindex that drops and re-adds — loses its
  grant, and the owner must grant again.** This is the safe direction of the failure, and it is the
  same premise `pruneOrphanedUnderstandings` has already been running on since PR 3. Stated here
  because re-granting is a real cost to a user who batch-granted an album, and a surprise is worse
  than a documented rule.

### 19.8 Finding 5.1 — `remote_vlm` validation · **ACCEPTED, with the vendor set corrected**

All three sub-points accepted; the parent-enabled check (5.1.2) already matches § 18.2, and the
no-environment-key rule (5.1.3) is slice 2b's property and needs an enforcement test here rather
than an assumption.

**The allow-list is corrected.** The review lists `"openai" | "anthropic" | "gemini" | "xai"` in
5.1.1 while its own § 6 checklist ships only three adapters. There is also nothing to derive the set
from: `nimbus-toml.ts` parses `[llm.remote.*]` into `ReadonlyMap<string, NimbusLlmRemoteVendor>`,
open-keyed by design. So `remote_vlm` validates against **the set of vendors with a shipped VLM
adapter** — a PR-4-local constant, deliberately narrower than the text-vendor set — and *then*
requires that vendor to be enabled in the map. A vendor with a text adapter and no vision adapter
must be rejected at config load naming the reason, not accepted and failed at describe time.

This preserves `multimodal-config.ts`'s established shape: the loader fails the section OFF for a
malformed value, with the single documented exception of a non-loopback `vlm_base_url`, which throws
loudly. An unknown `remote_vlm` follows the exception, not the rule: silently disabling a section
because the user misspelled `anthropic` would be indistinguishable from the feature not existing.
`vlm_base_url`'s loopback refusal is unaffected — the remote arm is selected by vendor, never by
pointing the local base URL somewhere else, and that must stay true or the refusal becomes bypassable.

### 19.A My own finding — `understanderFor` is keyed by modality, and remote is per artifact

Not in the review, and it is the thing that makes PR 4 more than an adapter. The gate's seam is

```ts
readonly understanderFor: (modality: MediaModality) => LocalUnderstander | undefined;
```

— one understander per **modality**, resolved before the candidate is consulted. Every gate decision
in PR 4 is per **artifact**: this image has a grant, that one does not. The current seam cannot
express it.

**Ruling: the gate takes the grant store and both understanders, and resolves per candidate**, in
the fixed order § 3.4 already mandates. `understanderFor` becomes
`(modality, candidate) => LocalUnderstander | undefined` — the candidate is already the gate's first
argument, so nothing new is threaded through the pass — and `build-media-pass-deps.ts` closes over
the grant store when constructing it. The alternatives were both worse: resolving remote-vs-local in
`media-pass.ts` moves a gate decision outside the gate, and constructing a per-artifact understander
at the wiring site puts a `Database` read on a hot path in the one file D22(g) and D27(a) both pin.

The name `LocalUnderstander` becomes a lie the moment a remote provider is returned through it, and
renaming it touches every implementer. It is renamed to `Understander` in the same commit, because a
type whose name asserts a security property it no longer carries is worse than the churn — this
codebase has already shipped one `browserLanePolicy` that was asserted and never used.

### 19.B What was NOT accepted, in one place

| Item | Ruling |
| --- | --- |
| 3.1 rec. 1 — grant-driven row invalidation | Rejected: re-offers forever when the remote arm cannot run (the § 17 livelock class). Rec. 2's predicate is derived and self-corrects. |
| 3.2 — sniffer as *fallback* | Inverted: the sniffer is authoritative; a provider's declared `Content-Type` is the fallback, and neither resolving is a refusal, not a guess. |
| 3.3 row 3 — grant + remote unset ⇒ refuse | Rejected: a grant is a permission, not a mandate, and must never remove the local capability the user already had. |
| 3.4 — hybrid remote frames + local transcript | Not built: `av-understander.ts`'s conjunction already forbids it, and PR 4 keeps AV all-local. `allow-remote` refuses an `'av'` grant outright rather than writing an inert row. |
| 3.5 — scan "files outside `multimodal/`" | Widened: repo-wide with a named allow-list, paren-matched per occurrence, as D22(g) does. |
| 5.1.1 — four-vendor allow-list | Corrected: the set is vendors with a shipped VLM adapter, which is narrower than the text-vendor set and not derivable from `nimbus-toml.ts`'s open-keyed map. |
| § 3.1's `media-consent-broker.ts` | Dropped from the placement map. § 6.3 forbids prompting inside a pass, so a broker would have no in-pass caller; consent is a CLI act writing a durable row. |

### 19.C Two things this review did not reach

Recorded because their absence is not evidence of their being fine.

- **The § 6 verification checklist asserts `wrapLedgeredVlm` appends before firing.** It does — that
  is D22(g), shipped in PR 2. What has never happened is that decorator wrapping a call that
  actually leaves the machine (§ 18). The checklist's positive control uses a mock remote provider,
  which proves the wiring and not the wire.
- **PR 3's acceptance run is still unperformed** (§ 18.9). PR 4 composes on top of it: cloud-fetched
  bytes forwarded to a third-party model is the path with the least real-world evidence behind it in
  the entire slice, and no amount of design review moves that number.

---

## 20. PR 3 acceptance run — Drive leg PASSED, Photos and OneDrive legs still open (2026-09-05)

The first time any leg of the cloud arm contacted a real provider. Run against a real Google
account with a throwaway index (see § 20.4), on `main` at v7.9.0 built from source — the *installed*
binary was v7.1.0 and did not contain PR 3 at all, which is worth stating because "I ran
`nimbus media understand`" is not evidence about this code unless the binary is checked.

### 20.1 What passed

One `image/png` in Google Drive, 390,842 bytes.

| Property | Where claimed | Result |
| --- | --- | --- |
| A credentialed `files/{id}?alt=media` fetch returns real bytes | § 16.5 | **390,842 bytes fetched** |
| A Drive candidate yields exactly ONE ledger row | I29 (`CLAUDE.md`), § 16.11 | **1 × `media.fetchBytes`, 0 × `media.resolveByteUrl`** — the constructed-URL claim holds |
| The row is BLAKE3-chained into the existing ledger | I29 | `prev_hash` links the sync chain |
| The image path writes NOTHING to disk | § 5.4 | **zero scratch files** after the run |
| A LOCAL VLM describe appends no `model`-class row | D22(g), I34 | **no `model` row** — `wrapLedgeredVlm` passthrough confirmed on a real describe |
| The derived row records provenance | § 4, § 12.3 | `model: qwen2.5vl:7b`, `modelDerived: true`, `isLocal: true`, `sourceMime`, `sourceBytes`, `rendition: "original"` |
| The body opens with the rendition disclosure | § 17 | "Understood from the original file." |
| `nimbus prove`'s scope label names the new coverage | § 16.11 | includes "cloud media byte-URL resolves and byte-fetches" |

The caption was substantive rather than generic — the model read a knife diagram and named the
scarf joint, copper wire, owner's mark band and a registration number off the pledge tag. Cloud
bytes → local VLM → derived item works end to end.

### 20.2 What is STILL unverified, and one of them is the question § 18.9 named

- **The Google PHOTOS leg, entirely.** `google_photos` authenticates and syncs `healthy`, and
  returns an EMPTY library: zero items. The granted scopes are `photoslibrary.readonly` +
  `photoslibrary.readonly.appcreateddata`, and `google-photos-sync.ts:113` calls
  `POST /v1/mediaItems:search` — which since Google's March 2025 restriction no longer returns a
  user's library under `photoslibrary.readonly`, only app-created media. Nimbus has never uploaded
  anything, so that set is empty by construction. **Strong hypothesis, not proven** — a 200-with-
  empty-list is indistinguishable from an empty account without a raw API call.
  **Consequence:** the two Photos-specific properties § 18.9 called out remain untested — that a
  pre-signed `baseUrl` is fetched with NO `Authorization` header, and that the `=w2048-h2048` / `=dv`
  rendition suffixes behave as assumed. `prefer_renditions = true` was set for this run and Drive
  correctly ignored it (`rendition: "original"`), because renditions are a Photos/OneDrive concept —
  so the rendition CODE PATH was never entered at all. **If the Photos API restriction is real, this
  connector cannot be acceptance-tested on any ordinary account, and § 12 should say so.**
- **The OneDrive leg, entirely** — Microsoft OAuth is not configured on this machine.
- **The AV path and its two scratch files** (§ 16.3) — no `ffmpeg`/`ffprobe`/`whisper-cli` present,
  and no video artifact.
- **Budget and per-artifact cap enforcement at a real boundary.** 390 KB against a 50 MiB budget
  never approached either bound, so the cap-then-budget ordering is still fixture-only.

### 20.3 Three findings the run surfaced

1. **The ledger records that a fetch happened, not how much crossed.** `payload_summary` is
   `{"method":"media.fetchBytes"}` — no byte count, though the CLI printed `390842` from the same
   run. For a BYTE-TRANSFER class that is the interesting number, and its absence is sharpened by
   contrast: the `model` class deliberately carries the image's byte count. Not a PR 3 regression —
   `sync.run` rows have the identical shape because both share `recordSyncEgress` — but § 16.11
   reads stronger than what the row actually proves. Worth closing before PR 4 adds a second
   byte-bearing path.
2. **A refusal still spends the byte budget.** `fetchCloudBytes` (`media-pass.ts:261`) runs BEFORE
   `understandArtifact` (`:431`), so an artifact refused for `no_local_model` has already been
   downloaded. Observed directly: two `media.fetchBytes` rows for one caption, because the first
   pass ran with no VLM installed, refused, wrote no understanding row, and the second pass
   re-offered and re-fetched the same bytes. Harmless at 390 KB; over a photo library with a
   misconfigured VLM it spends the whole budget on bytes that are discarded. The ordering also has a
   virtue worth keeping — it is what let the fetch path be verified with no model present at all —
   so the fix is a cheap availability pre-check before the fetch, not a reordering.
3. **`source_id` disagrees with itself.** The media row carries the string `"unknown"`; `sync.run`
   rows carry SQL `NULL`. Two spellings of "no id" in one column is a future query bug.

### 20.4 The harness, because it is reusable and the obvious knob is the wrong one

`NIMBUS_CONFIG_DIR` is NOT the isolation knob. `platform/paths.ts` moves only `configDir`, and
`dataDir` deliberately does not ("this cannot silently repoint a live gateway's database") — and the
Vault lives under `configDir`. So it yields a throwaway config with NO credentials while still
writing the live index: exactly backwards.

On Windows the right knob is **`LOCALAPPDATA`**, since `createWindowsPaths()` derives `dataDir` from
it and `configDir` from `APPDATA`. Overriding `LOCALAPPDATA` alone gives real Vault + real
credentials + real outbound traffic against a throwaway database. Set it on BOTH the gateway and the
CLI: the CLI locates the gateway through `gateway.json` in its own resolved `dataDir`
(`admin.ts`'s `readGatewayState`), not by dialling a pipe, so a CLI with the real `LOCALAPPDATA`
reports "Gateway is not running" against a perfectly healthy sandbox gateway.

Proof the isolation held: the live index stayed at `user_version = 56` throughout, while the
sandbox migrated 1 → 58 from empty. A v7.9.0 gateway opening the live file would have migrated it.
