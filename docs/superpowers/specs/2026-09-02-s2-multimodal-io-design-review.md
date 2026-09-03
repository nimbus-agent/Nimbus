# Design Review: S2 — Multimodal I/O (Local-First Media Understanding)

> **HISTORICAL — superseded.** This review was written against an earlier draft of the design and is
> kept for the reasoning trail, not as a description of the current design. Every finding below was
> dispositioned in `2026-09-02-s2-multimodal-io-design.md`; where this document proposes an
> alternative, the design records which was chosen and why. Read the design first.

**Date:** 2026-09-02  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Under Review  
**Target Spec:** [`2026-09-02-s2-multimodal-io-design.md`](./2026-09-02-s2-multimodal-io-design.md)  
**Slot:** [Spine S2 — Local Compute Fleet](../../roadmap.md#active)  
**Reserves:** Invariant **I37**, Static Rule **D27**, Static Rule **D22(g)**, Schema **V58**

---

## 1. Summary of Review

The design specification presents a disciplined, privacy-first architecture for indexing and understanding media assets (images, audio, video) stored locally or in connected cloud services:

1. **Strict Inbound vs. Outbound Separation (§ 2):** Treating cloud byte acquisition as ledgered sync reads while reserving the consent gate exclusively for outbound model egress prevents prompt fatigue and aligns with Nimbus's core trust model.
2. **Dedicated Gate Chokepoint & Gate-First Sequencing (§ 3.2, § 3.3):** Placing `media-gate.ts` ahead of provider drivers and implementing the local arm in PR 1 before any remote path exists prevents architectural bypasses, following the precedent established in the sandboxed code execution (I33) and computer-use (I35) lanes.
3. **Decorator-Based Egress Accounting (§ 7):** Copying `wrapLedgeredProvider`'s decorator pattern (`wrapLedgeredVlm`) at registration time ensures that every remote VLM call is ledgered under the `model` class before dispatch, maintaining the published invariant claim that `model` egress carries no named exclusions.
4. **Resumable, Decoupled Indexing (§ 4, § 8):** Modeling understanding as derived items (`nimbus:image_understanding`, `nimbus:video_understanding`) allows immediate integration with existing FTS, agent synthesis, and embedding retrieval pipelines without duplicating search code.

Below are critical open questions, architectural ambiguities, security/privacy edge cases, and suggested technical improvements.

---

## 2. Open Questions & Architectural Ambiguities

### Q2.1: STT Egress Accounting & Remote STT Status

- **Context:**
  - § 7 table lists: `Outbound to a remote model` -> `new wrapLedgeredVlm; ledgered STT wrapper`.
  - § 9.1 states: *"WhisperSttProvider (voice/stt.ts) already resolves whisper-cli, spawns it... No new provider interface and no new decorator — it is a subprocess, not a provider."*
  - § 13 (PR 4) states: *"Remote arm, consent broker, V58 grants, I37 + D27: outbound, model class"*.
- **Ambiguity:** Is remote STT (e.g. OpenAI Whisper API, Groq Whisper) supported in PR 4, or is STT strictly local-only across all four PRs?
  - If STT is strictly local-only, it will never emit `model`-class egress rows (mirroring `LOCAL_ONLY_SYNC_SERVICES`), and no "ledgered STT wrapper" is needed.
  - If remote STT is planned, the spec must define the remote STT provider interface and its corresponding decorator (`wrapLedgeredStt`), as `WhisperSttProvider` currently only spawns local binaries.
- **Recommendation:** Clarify STT locality scope:
  - If STT is 100% local in S2, explicitly document that STT is pinned to `isLocal: true` and remove "ledgered STT wrapper" from the § 7 table to avoid ambiguity.
  - If remote STT is planned for PR 4, define `SttProvider` routing and `wrapLedgeredStt` along with its static confinement rule under D22.

---

### Q2.2: Cloud-Fetched Media, Subprocess Audio Extraction, and the "Never Write to Disk" Rule

- **Context:**
  - § 5.3 & § 10 mandate: *"Bytes are held in memory and **never written to disk**, matching I35's screenshot rule."*
  - `WhisperSttProvider` (`packages/gateway/src/voice/stt.ts`) currently executes `Bun.spawn([this.whisperBin, "-f", audioPath, "-nt"])`, which requires a file path on disk.
  - Furthermore, `whisper-cli` expects 16kHz 16-bit uncompressed WAV input. For video files (MP4, MOV, WebM) or compressed audio (MP3, AAC) fetched from cloud services (Zoom, Google Drive, Loom), audio extraction via `ffmpeg` is necessary before transcription.
- **Ambiguity & Cross-Platform Risk:**
  - For **local files**, passing the validated path from `[[filesystem.roots]]` does not write new bytes to disk.
  - For **cloud-fetched media**, bytes reside in memory (`Uint8Array` / `Buffer`):
    1. How are in-memory bytes passed to `ffmpeg` and `whisper-cli` without touching disk?
    2. While `ffmpeg` can read from standard input (`pipe:0`), `whisper-cli`'s `-f` flag on Windows does not support standard input (`pipe:0` / `-` / named pipes) in standard builds.
- **Recommendation:**
  - Define the in-memory piping pipeline:
    - `media-bytes.ts` streams/pipes bytes to `ffmpeg` via stdin (`pipe:0`).
    - `ffmpeg` decodes audio and outputs 16kHz PCM WAV via stdout (`pipe:1`).
    - Evaluate whether `whisper-cli` can consume PCM WAV directly via stdin on all target platforms (Windows, macOS, Linux).
    - If `whisper-cli` on Windows requires a filesystem handle, document whether an in-memory virtual file system, OS-level anonymous pipe descriptor, or an explicitly documented ephemeral buffer with immediate zeroing is required, ensuring alignment with invariant I37.

---

### Q2.3: Vector Embedding Privacy Leakage via `PROSE_HEAVY_TYPES`

- **Context:**
  - § 4 states: *"Both types [`nimbus:image_understanding`, `nimbus:video_understanding`] join `PROSE_HEAVY_TYPES`."*
  - In `packages/gateway/src/embedding/routing.ts`, any item type in `PROSE_HEAVY_TYPES` is automatically dispatched to **OpenAI's remote 1536-dim embedding model** whenever `openai.api_key` or `[llm.remote.openai]` is enabled.
  - In contrast, `LOCAL_ONLY_PROSE_TYPES` (such as `nimbus:web_clip`) is explicitly pinned to the local MiniLM-384 embedder to prevent private clipped content from reaching OpenAI.
- **The Privacy Hazard:**
  - If a user runs a 100% local understanding pass using a local Ollama VLM and local Whisper on private photos or confidential scanned documents, the derived OCR text and captions will be stored as `nimbus:image_understanding`.
  - Because `nimbus:image_understanding` is in `PROSE_HEAVY_TYPES`, the gateway's embedding worker will immediately transmit the full OCR text and captions to OpenAI for embedding.
  - While the raw image bytes never left the machine (satisfying I37), the full semantic text content extracted from the image was exfiltrated to OpenAI without an artifact grant.
- **Recommendation:**
  - Either add `nimbus:image_understanding` and `nimbus:video_understanding` to `LOCAL_ONLY_PROSE_TYPES` (matching `nimbus:web_clip`), ensuring derived text embeddings are always calculated locally with MiniLM-384;
  - OR make embedding routing condition on `metadata.isLocal`: if the item was derived locally, it must remain on local MiniLM, preventing unexpected remote egress.

---

### Q2.4: V58 Schema Specification (Grants & Pass State)

- **Context:**
  - The spec reserves schema **V58** for `media-grant-store.ts` (§ 3.1, § 6.2, § 10), but does not define the table DDL or indexes.
  - § 3.1 also introduces `media-pass-state.ts` (cursor + resume).
- **Ambiguity:**
  - What is the exact schema for durable grants?
  - Is pass cursor/state persisted in SQLite (surviving gateway restarts) or kept in memory?
- **Recommendation:** Add the explicit V58 SQL DDL to § 4 / § 6.2:

  ```sql
  CREATE TABLE IF NOT EXISTS media_grant (
    id           TEXT PRIMARY KEY,
    item_id      TEXT NOT NULL,
    service      TEXT NOT NULL,
    modality     TEXT NOT NULL CHECK(modality IN ('image', 'av')),
    model_vendor TEXT NOT NULL, -- e.g. 'anthropic', 'openai', 'all'
    granted_at   INTEGER NOT NULL,
    revoked_at   INTEGER,
    UNIQUE(item_id, modality)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_media_grant_lookup 
    ON media_grant(item_id, modality) 
    WHERE revoked_at IS NULL;

  CREATE TABLE IF NOT EXISTS media_pass_cursor (
    pass_id          TEXT PRIMARY KEY,
    service          TEXT,
    modality         TEXT,
    last_item_id     TEXT NOT NULL,
    processed_count  INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL
  ) WITHOUT ROWID;
  ```

---

### Q2.5: Re-understanding, External ID Collision, and Orphan Pruning

- **Context:**
  - § 4 defines `externalId` as `<source_item_id>:understanding:v<understandingVersion>`.
  - § 4 states: *"Re-understanding is an idempotent upsert. Bumping `understandingVersion` when a better model lands re-understands a library with no migration, and the old rows are replaced rather than accumulated because the id is derived from the version."*
- **The Conflict:**
  - Because `externalId` is part of the primary key / unique constraint in `items`, changing `v1` to `v2` creates a **new row** (`...:v2`) rather than overwriting `...:v1`.
  - Without an explicit deletion step, bumping `understandingVersion` will accumulate stale versions, causing duplicate search results in FTS and duplicate context injection in agents.
- **Recommendation:**
  - Either make `externalId` stable without embedding the version string: `<source_item_id>:understanding` (and store `understandingVersion` exclusively in `metadata`), enabling native SQLite upsert (`ON CONFLICT DO UPDATE`);
  - OR explicitly specify that `media-pass.ts` deletes existing understanding rows matching `<source_item_id>:understanding:v%` prior to inserting the new version.
  - In addition, specify cascade pruning: when a source item is pruned from `items` (e.g. file deleted on disk or un-synced), its derived understanding rows must be deleted.

---

## 3. Technical Improvements & Edge Cases

### I3.1: Video Frame Extraction Sampling Budget & GPU Arbiter Protection

- **Context:**
  - § 8 states that `GpuArbiter` is acquired around the model call.
  - § 12.1 notes that video understanding requires frame captions via VLM.
- **Risk:**
  - A 30-minute video can contain 45,000+ frames. Running VLM inference on dozens of frames per video will easily trigger `GpuArbiter`'s 30-second watchdog timeout (`timeoutMs = 30_000` in `packages/gateway/src/llm/gpu-arbiter.ts`), leading to forced eviction.
- **Suggestion:**
  1. **Strict Sampling Policy:** Cap frame extraction to a fixed maximum (e.g. 5–10 representative keyframes uniformly spaced across the duration or detected via scene changes).
  2. **Per-Frame GPU Arbiter Lease:** Explicitly require acquiring and releasing `GpuArbiter` **per individual frame inference**, not across the entire video pass. This allows interactive `nimbus ask` queries to interleave gracefully without hitting the arbiter timeout.

---

### I3.2: Remote Grant UX Scalability (Batch Grants vs Prompt Fatigue)

- **Context:**
  - § 6.3 establishes the vital principle that the pass never prompts for grants during execution to prevent reflexive approvals.
  - However, granting individual items one-by-one via `nimbus media allow-remote <item>` becomes unwieldy when indexing a cloud album with dozens of items.
- **Suggestion:** Provide structured, preview-gated batch granting commands:
  - `nimbus media allow-remote --service google_photos --since 2026-08-01 --limit 20`
  - The CLI renders a single upfront preview showing item titles, dates, and sizes, and prompts the user for a single confirmation that creates durable grants for the matching batch in one transaction.

---

### I3.3: In-Memory Byte Caps & Non-Seekable Stream Handling for Large Media

- **Context:**
  - § 5.3 specifies: *"A per-artifact byte cap refuses rather than truncates... Bytes are held in memory and never written to disk."*
- **Risks:**
  1. High-resolution photos (10–50 MB) and video files (100 MB–2 GB+) held in memory as `Uint8Array` can cause V8 heap exhaustion and gateway crashes.
  2. Many MP4 container files place the index metadata (`moov` atom) at the end of the file. If an MP4 is streamed through a non-seekable pipe to `ffmpeg`, `ffmpeg` must buffer the entire file in memory before it can begin decoding.
- **Suggestion:**
  - Establish explicit, distinct byte caps:
    - Images: default cap of 25 MB (`max_image_bytes`).
    - Audio/Video: default cap of 250 MB (`max_media_bytes`).
  - Configure cloud fetchers to request optimized streaming renditions (e.g., audio-only stream or low-res video proxy from cloud providers) when available, rather than downloading original raw 4K footage.

---

### I3.4: Cross-Platform Binary Availability & Diagnostic Feedback

- **Context:**
  - Non-Negotiable #5: Platform equality across Windows, macOS, and Linux.
  - The multimodal pipeline relies on external binaries: `whisper-cli` / `main`, `ffmpeg`, and a local Ollama instance with a vision model (`llava`, `llama3.2-vision`, etc.).
- **Suggestion:**
  - Implement a dedicated `resolveFfmpegBin` helper in `platform/ffmpeg-resolver.ts` with customizable `spawn`/`which` hooks for dependency injection in unit tests.
  - In `ollama-vlm.ts`, implement `isAvailable()` by probing Ollama's HTTP `/api/tags` endpoint to verify not just that the Ollama server is running, but that an active multimodal model is pulled.
  - When `nimbus media understand` encounters missing dependencies, return actionable CLI remediation hints (e.g., `Install ffmpeg via winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg`).

---

### I3.5: Search & Citation Metadata in `understanding-item.ts`

- **Context:**
  - Derived items must render seamlessly in search results, CLI outputs, and agent synthesis citations.
- **Suggestion:** Specify the exact mapping produced by `understanding-item.ts`:
  - `title`: `"[Image Understanding] " + sourceItem.title` or `"[Transcript] " + sourceItem.title`
  - `url`: Inherit `sourceItem.url` so UI citations navigate directly to the source media.
  - `sourceFile`: Inherit `sourceItem.sourceFile` for local files.
  - `metadata.derivedFrom`: `sourceItem.id` / `sourceItem.externalId`.
  - `metadata.sourceMime`: MIME type of the original media.
  - `metadata.sourceBytes`: Size in bytes.
  - `metadata.modelDerived`: `true` (enforcing I31 honesty constraints).

---

## 4. Verification & Testing Strategy Recommendations

1. **Positive Control for Zero-Egress Assertion (§ 11.1):**
   - Register a mock remote VLM provider and verify that `wrapLedgeredVlm` successfully appends a `model` row to `egress_ledger`.
   - Run the local Ollama VLM path and assert that **0** egress rows are appended.
2. **Red-Proving D27 Static Source Guard (§ 11.2):**
   - Anchor AST / regex static analysis on function body boundaries to prevent multi-line return types from bypassing the check.
   - Include a synthetic violation test in `check-nimbus-invariants.ts` that fails the audit if an unauthorized caller invokes `describeBytes` or accesses `media_grant`.
3. **Cross-Platform In-Memory Subprocess Pipe Tests:**
   - Add integration tests verifying that `ffmpeg` audio extraction and VLM frame extraction succeed over memory streams without touching disk on all three target operating systems.
4. **Disjoint Prose Type Assertion:**
   - In `routing.test.ts`, assert that `LOCAL_ONLY_PROSE_TYPES` and `PROSE_HEAVY_TYPES` remain strictly disjoint when registering `image_understanding` and `video_understanding`.
