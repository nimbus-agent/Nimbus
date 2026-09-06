# Design Review: S2 — Multimodal I/O (Local-First Media Understanding) — PR 4 Remote Arm & Architectural Audit

**Date:** 2026-09-05  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Review Complete / Actionable Feedback Provided  
**Target Spec:** [`docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`](./2026-09-02-s2-multimodal-io-design.md)  
**Slot:** [Spine S2 — Local Compute Fleet](../../roadmap.md#active)  
**Implementation State:**

- **PR 1 (Shipped #1429, 2026-09-02):** Local discovery, long-form STT, V58 cursor, `video_understanding`, local-arm `media-gate.ts`.
- **PR 2 (Shipped #1438, 2026-09-03):** Local Ollama VLM (`/api/show`), `wrapLedgeredVlm`, D22(g), `image_understanding`, frame extraction, `UNDERSTANDING_VERSION = 2`.
- **PR 3 (Shipped, 2026-09-04):** Cloud byte acquisition (`google_photos`, `google_drive`, `onedrive`), safe URL resolution (`cloud-url-resolver.ts`), manual redirect following (`safeFetchFollowing`), stream-level bandwidth budget, two scratch files for cloud AV with prefix sweeper, `sync`-class egress enumeration (4 appenders).
- **PR 4 (Designed in § 18):** Remote VLM arm (images only), durable grants (Schema **V59** `media_grant`), the CLI/RPC grant workflow (`nimbus media allow-remote`/`grants list`/`grants revoke` — no gateway-side consent broker; § 6.3 forbids prompting from inside a pass), Invariant **I37**, and Static Rule **D27**.

---

## 1. Executive Summary

The S2 Multimodal I/O design specification [`2026-09-02-s2-multimodal-io-design.md`](./2026-09-02-s2-multimodal-io-design.md) has evolved across three shipped pull requests into a robust, privacy-first subsystem. The newly added **§ 18 (PR 4 — The Remote Arm)** provides the blueprint for the final, most sensitive leg of this slice: permitting user-selected image artifacts to be described by frontier vision models (OpenAI, Anthropic, Gemini) under strict, durable, artifact-scoped consent.

### Core Architectural Strengths

1. **Strict Locality Enforcement for Speech-to-Text (§ 12.7, § 18.9):** Pinning audio/video transcription strictly to local `whisper-cli` across all four PRs preserves the highest privacy standard for conversational audio while simplifying the remote invariant (I37) to govern image payloads.
2. **Four-Stage Fail-Closed Gate Sequencing (§ 18.1):** Checking (1) Org Policy (`multimodal_input`), (2) `[multimodal] enabled`, (3) `[multimodal] remote_vlm = "<vendor>"`, and (4) Durable Artifact Grant in fixed order ensures that disabled or ungranted capabilities refuse immediately without leaking metadata or triggering prompt fatigue.
3. **Reusing Vault Credentials without Capability Inheritance (§ 18.2):** Reusing the existing `[llm.remote.<vendor>]` Vault secrets while requiring a dedicated `[multimodal] remote_vlm` configuration avoids secret proliferation while respecting the distinct consent boundaries between text generation and media transmission.
4. **Append-Only Grant History with Partial Uniqueness (§ 18.3):** Defining `idx_media_grant_active ON media_grant (item_id, modality, model_vendor) WHERE revoked_at IS NULL` guarantees that revocations preserve an immutable audit trail while allowing re-granting without table mutation.
5. **Dual-Ended Cross-Vendor Transfer Disclosure (§ 18.5):** Providing an upfront batch preview that explicitly names both the origin service and the target model (`source google_photos · destination openai`) ensures the user understands the exact cross-cloud data path before confirming.

Below are critical architectural gaps, spec drift issues, edge cases, and concrete recommendations for PR 4.

---

## 2. Spec Drift, Obsolete Text & Cross-Section Inconsistencies

As PRs 1, 2, and 3 were implemented and amended (§ 15, § 16, § 17), several earlier sections in the design specification became outdated. These should be reconciled in place to preserve document integrity:

### 2.1 Table § 13 (Sequencing Table) Contains Obsolete PR 3 Details

- **Issue:** In § 13, the PR 3 row states: `Ships: fetchBytes capability (D24), cloud byte-fetch over the existing host boundary | Droppable: yes`.
- **Reality:** As ratified in § 16.2, § 16.4, and § 17.10, PR 3 shipped with **no `fetchBytes` capability**, **no D24 exemption**, and bypassed `fetch-host-boundary.ts` in favor of `cloud-url-resolver.ts` with manual redirect validation. PR 3 is also already **shipped**, not droppable.
- **Recommendation:** Update § 13 to mark PRs 1–3 as SHIPPED with their actual architectural mechanisms.

### 2.2 Invariant I37 Scratch File Wording Discrepancy (§ 10 vs § 16.3 vs § 18.6)

- **Issue:** In § 10, the definition of I37 claims: *"a transcode writes exactly one 0600 gateway-owned scratch file that is deleted in a finally and swept at pass start."*
- **Reality:** § 16.3 and § 18.6 correctly explain that Cloud AV downloads require **two** scratch files (the downloaded media artifact and the transcoded WAV).
- **Recommendation:** Update the verbatim I37 definition block in § 10 to state *"at most two 0600 gateway-owned scratch files (cloud download + transcode WAV)"*, aligning with § 16.3 and § 18.6.

### 2.3 Placement Map (§ 3.1) vs Shipped Subsystem Layout

- **Issue:** § 3.1 reflects the initial speculative directory layout before PRs 1–3 landed.
- **Reality:** The codebase now contains modular subdirectories: `multimodal/frames/` (`frame-extract.ts`, `av-understander.ts`), `multimodal/vlm/` (`image-understander.ts`, `ollama-vlm.ts`, `caption-prompts.ts`), `multimodal/stt/` (`ffmpeg-bin.ts`, `whisper-bin.ts`, `transcribe-file.ts`), `multimodal/cloud-bytes.ts`, `multimodal/cloud-url-resolver.ts`, `multimodal/cloud-renditions.ts`, and `multimodal/orphan-prune.ts`.
- **Recommendation:** Update § 3.1 with the actual directory structure and note the arrival points for PR 4 (`media-grant-store.ts`, `media-consent-broker.ts`, `multimodal/vlm/remote/`).

---

## 3. Critical Findings & Open Questions (PR 4 Remote Arm)

### Finding 3.1: Candidate Re-Discovery Starvation for Newly Granted Items

- **Context (§ 4.1, § 8, § 18.4 vs `media-discovery.ts`):**
  - In `media-discovery.ts`, candidate discovery selects items where:

    ```sql
    (u.id IS NULL OR COALESCE(json_extract(u.metadata, '$.understandingVersion'), -1) < ?)
    ```

    where `?` is `UNDERSTANDING_VERSION` (currently `2`).
  - Suppose a user runs a pass under local Ollama. 100 images are processed locally, and each receives a derived `nimbus:image_understanding` row with `metadata.understandingVersion = 2`, `metadata.isLocal = true`, and `metadata.model = "qwen2.5vl:7b"`.
  - Later, the user identifies 5 low-quality or complex charts and explicitly grants remote access:

    ```bash
    nimbus media allow-remote item_42 item_43 item_44
    ```

  - The user runs `nimbus media understand`.
- **The Defect:**
  - `media-discovery.ts` checks SQLite: `u.metadata.understandingVersion` is already `2`.
  - `findCandidates` **skips all 5 granted items**, because an understanding row at the current version already exists!
  - The pass reports: `Understood 0 items (0 pending)`. The remote grants are completely ignored unless the user manually truncates database rows or a global `UNDERSTANDING_VERSION` bump occurs.
- **Impact:** Granting remote access to an already-indexed library does nothing.
- **Recommendations:**
  1. **Grant-Driven Row Invalidation:** When `nimbus media allow-remote <item>` writes a grant into `media_grant`, it should update existing derived understanding rows for that source item, setting `json_extract(metadata, '$.understandingVersion') = 0` (or deleting the derived row), forcing `media-discovery.ts` to re-evaluate it on the next pass.
  2. **Selective Version Predicate in Discovery Query:** Alternatively, expand `findCandidates()` SQL to re-offer items if an active remote grant exists for a vendor that differs from `json_extract(u.metadata, '$.model')`:

     ```sql
     OR EXISTS (
       SELECT 1 FROM media_grant AS g
        WHERE g.item_id = src.id
          AND g.revoked_at IS NULL
          AND g.model_vendor = :configuredRemoteVendor
          AND json_extract(u.metadata, '$.isLocal') = 1
     )
     ```

---

### Finding 3.2: `VlmDescribeInput` MIME Type Sniffing & Wire Serialization Gap

- **Context (§ 9.2, § 18 vs `vlm-types.ts`):**
  - `VlmDescribeInput` is currently defined as:

    ```ts
    export interface VlmDescribeInput {
      readonly bytes: Uint8Array;
      readonly prompt: string;
      readonly egressMethod?: string;
    }
    ```

  - For local Ollama (`ollama-vlm.ts`), raw base64 encoding without an explicit MIME type works because Ollama's `/api/generate` accepts raw base64 arrays in `images: [base64]`.
  - However, **remote frontier APIs strictly require MIME types**:
    - **Anthropic Messages API:** `source: { type: "base64", media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: base64 }`. Missing or invalid `media_type` causes immediate HTTP 400 rejection.
    - **Google Gemini API:** `inline_data: { mime_type: "image/jpeg" | "image/png", data: base64 }`.
    - **OpenAI / xAI Chat Completions:** `image_url: { url: "data:image/jpeg;base64,..." }`.
- **The Gap:**
  - `VlmDescribeInput` passes only `bytes: Uint8Array`. It does not provide `mimeType`.
  - For a still image, `MediaCandidate.sourceMime` is known in `image-understander.ts`.
  - For video frames extracted via `frame-extract.ts`, ffmpeg outputs JPEG bytes (`image/jpeg`).
- **Recommendation:**
  - Add optional `mimeType?: string` to `VlmDescribeInput`.
  - Implement a lightweight magic-byte sniffer (`multimodal/vlm/image-mime.ts`) as a fallback in case `mimeType` is missing or generic (`application/octet-stream`):
    - `FF D8 FF` -> `image/jpeg`
    - `89 50 4E 47` -> `image/png`
    - `52 49 46 46 ... 57 45 42 50` -> `image/webp`
    - `47 49 46 38` -> `image/gif`

---

### Finding 3.3: Provider Selection & Gate Resolution Matrix in `media-gate.ts`

- **Context (§ 18.1, § 18.4):**
  - `media-gate.ts` must coordinate between a local VLM provider (Ollama) and a remote VLM provider (OpenAI/Anthropic/Gemini) on a per-artifact basis.
- **Ambiguity:** How does `media-gate.ts` select between local and remote providers when both are present?
- **Specification Matrix:** The resolution order in `understandArtifact` should follow this explicit truth table:

| Remote Grant Active? | `remote_vlm` Configured & Enabled? | Local Model Available? | Resolution / Action | Outcome / Reason |
| :--- | :--- | :--- | :--- | :--- |
| **No** | *Any* | **Yes** | Use Local VLM (Ollama) | `ok: true` (`isLocal: true`) |
| **No** | *Any* | **No** | Refuse Fail-Closed | `ok: false, reason: "no_local_model"` |
| **Yes** | **No** (unset/disabled) | **Yes** | Refuse Fail-Closed (Grant exists but remote disabled) | `ok: false, reason: "no_remote_grant"` |
| **Yes** | **Yes** | *Any* | Use Remote VLM (via `wrapLedgeredVlm`) | `ok: true` (`isLocal: false`) |
| **Yes** | **Yes** (Remote fails) | **Yes** | Refuse Fail-Closed (Never degrade to local) | `ok: false, reason: "describe_failed"` |

- **Key Rule:** If a remote grant exists and remote VLM is configured, the gate **must never silently degrade to local** upon a remote network error or rate limit. A remote failure is terminal for that artifact, preserving predictable model behavior.

---

### Finding 3.4: Video Frame Captions vs Audio Locality Under `av` Modality

- **Context (§ 18.3, § 18.6 vs `av-understander.ts`):**
  - Schema V59 defines: `modality TEXT NOT NULL CHECK (modality IN ('image', 'av'))`.
  - § 18.3 states: *"modality retains 'av' even though PR 4 grants only images... a later remote STT tier writes 'av' rows into the same table."*
  - § 18.6 states: *"Because STT is local-only in this slice (§ 7, § 12.7), images are the only modality that can reach a non-local model today."*
- **The Question:**
  - What happens when a user runs a pass on a **video** (`modality: "av"`)?
  - `av-understander.ts` runs two operations:
    1. Audio transcription via `whisper-cli` (100% local).
    2. Video frame captioning via `VlmProvider` over 8 sampled frames.
  - If a user grants an `image` grant (or an `av` grant) on a video artifact:
    - Does frame captioning use the remote VLM while Whisper STT runs locally?
    - Or is remote VLM strictly restricted to `type: "image_understanding"` rows in PR 4?
- **Recommendation:**
  - Explicitly document the hybrid rule for video understanding in PR 4:
    - If an artifact has modality `av`: Whisper STT **always** runs locally.
    - If `remote_vlm` is enabled AND an active grant exists for `(candidate.itemId, 'av', vendor)` (or `(candidate.itemId, 'image', vendor)`): the 8 sampled frame captions are described by the remote VLM, while the transcript remains local.
    - The resulting `UnderstandOutcome` reports `isLocal: false`, `model: "${remoteModel} + whisper-cli"`, and notes in `metadata.modelDerived` that frames were captioned remotely while audio was transcribed locally.

---

### Finding 3.5: Static Rule D27 Confinement Implementation Details

- **Context (§ 18.7):**
  - **D27(a)**: A non-local `VlmProvider` may be CONSTRUCTED in only one factory (`createRemoteVlm` / `createRemoteVlmProvider`), and that factory is nameable only by `multimodal/build-media-pass-deps.ts` (and its own definition).
  - **D27(b)**: `media_grant` table access is confined to `multimodal/media-grant-store.ts`.
- **Implementation Recommendations:**
  1. In `scripts/structure-audit/check-nimbus-invariants.ts`, add `checkRemoteVlmConfinement()`:
     - Scan all files outside `packages/gateway/src/multimodal/` for references to remote VLM factory identifiers (`createRemoteVlmProvider`, `createOpenAiVlm`, `createAnthropicVlm`, `createGeminiVlm`).
     - Verify that inside `multimodal/build-media-pass-deps.ts`, every construction of a remote VLM provider is wrapped immediately by `wrapLedgeredVlm(db, ...)`, mirroring D22(g).
  2. Add `checkMediaGrantStoreConfinement()`:
     - Scan all `.ts` files for SQL queries containing `FROM media_grant` or `INTO media_grant`.
     - Allow only `packages/gateway/src/multimodal/media-grant-store.ts` and `packages/gateway/src/index/media-grant-v59-sql.ts`.
  3. Red-prove both rules in `packages/gateway/src/security-invariants.test.ts` by asserting violations are caught when synthetic rogue references are introduced.

---

## 4. Grant Store, Consent UX & Data Hygiene (Schema V59)

### Finding 4.1: Active Grant Idempotency & Batch Granting

- **Context (§ 18.3, § 18.5):**
  - `media_grant` has a partial unique index:

    ```sql
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_grant_active
      ON media_grant (item_id, modality, model_vendor)
      WHERE revoked_at IS NULL;
    ```

- **Edge Cases in `media-grant-store.ts`:**
  1. **Idempotent Insertion:** Calling `createGrant(db, { itemId, modality, modelVendor })` when an active grant already exists for `(itemId, modality, modelVendor)` must not throw a SQLite `SQLITE_CONSTRAINT_UNIQUE` exception. It should either return the existing grant ID or execute `INSERT OR IGNORE`.
  2. **Re-Granting after Revocation:** If an active grant was previously revoked (`revoked_at` is set to timestamp `T1`), calling `createGrant` creates a new row with `id = uuid()`, `granted_at = T2`, `revoked_at = NULL`. The partial index allows this without conflict.
  3. **Batch Grant Deduplication:** When running `nimbus media allow-remote --service google_photos --since 2026-08-01 --limit 20`:
     - The CLI preview should distinguish between *newly matched items* and *already-granted items*.
     - The transaction should insert grants only for items lacking an active grant, reporting: `Granted 16 new items (4 already granted)`.

---

### Finding 4.2: Orphan Pruning for `media_grant` Table

- **Context (§ 4.2, § 17.6 vs `orphan-prune.ts`):**
  - PR 3 added `orphan-prune.ts` to clean up derived `nimbus:image_understanding` and `nimbus:video_understanding` items when their source items are removed from `item`.
- **The Gap:**
  - If a source item is deleted from Google Drive or local disk, active grants in `media_grant` for that `item_id` will linger indefinitely.
- **Recommendation:**
  - In `orphan-prune.ts`, add an orphan cleanup query for active grants:

    ```sql
    UPDATE media_grant
       SET revoked_at = :nowMs
     WHERE revoked_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM item AS src WHERE src.id = media_grant.item_id
       );
    ```

  - Marking them revoked (or deleting them) ensures stale grants do not accumulate while maintaining an accurate count of active grants in `nimbus media grants list`.

---

## 5. Configuration & Vault Integration

### Finding 5.1: `[multimodal] remote_vlm` Validation against `[llm.remote.<vendor>]`

- **Context (§ 18.2):**
  - `[multimodal] remote_vlm = "<vendor>"` specifies the frontier VLM vendor.
  - The API key is read from the Vault under `llm.remote.<vendor>.api_key` (e.g. `openai.api_key`, `anthropic.api_key`).
- **Validation Discipline in `multimodal-config.ts`:**
  1. **Supported Vendor Check:** `remote_vlm` must be strictly validated against the allowed set: `"openai" | "anthropic" | "gemini" | "xai"`. Any other string is a `MultimodalConfigError`.
  2. **Enabled Parent Check:** If `remote_vlm = "anthropic"`, `loadMultimodalConfig` or `buildMediaPassDeps` must verify that `[llm.remote.anthropic] enabled = true` is set in `nimbus.toml`. If the vendor is disabled in `[llm.remote]`, the multimodal remote capability must fail closed and refuse to run.
  3. **No Environment Key Fallback:** As established in Slice 2b, API keys must be retrieved strictly from `VaultService`, never from `process.env.OPENAI_API_KEY` or `process.env.ANTHROPIC_API_KEY`.

---

## 6. Implementation & Verification Checklist for PR 4

When executing PR 4, the following end-to-end deliverables should be verified:

### Database & Schema (V59)

- [ ] Implement `index/media-grant-v59-sql.ts` creating `media_grant` table and `idx_media_grant_active` partial unique index.
- [ ] Register schema version `59` in `index/schema-migrations.ts` and update `CURRENT_SCHEMA_VERSION`.
- [ ] Implement `multimodal/media-grant-store.ts` (`createGrant`, `revokeGrant`, `listActiveGrants`, `hasActiveGrant`).

### Remote VLM Providers & Egress

- [ ] Implement remote VLM adapters in `multimodal/vlm/remote/` (`openai-vlm.ts`, `anthropic-vlm.ts`, `gemini-vlm.ts`) implementing `VlmProvider`.
- [ ] Implement `VlmDescribeInput` MIME sniffing / propagation in `multimodal/vlm/image-mime.ts`.
- [ ] Wire remote VLM construction in `multimodal/build-media-pass-deps.ts` wrapped by `wrapLedgeredVlm(db, provider)` (D22(g)).
- [ ] Assert `wrapLedgeredVlm` appends `sourceType: "model"`, `destination: vendor`, `method: "multimodal.vlm.describe"`, and `payloadSummary: { model, imageBytes }` before firing requests.

### Gate & Pass Logic

- [ ] Update `media-gate.ts` to evaluate active grants via `deps.grantStore` when `remote_vlm` is configured.
- [ ] Ensure local VLM is used for ungranted items, and remote VLM is used exclusively for granted items.
- [ ] Assert fail-closed behavior: an ungranted item never contacts a remote provider, and a remote failure never silently falls back to local.
- [ ] Update `media-discovery.ts` (or `media-grant-store.ts`) to ensure newly granted items are re-offered for understanding even if previously understood locally (Finding 3.1).

### CLI Commands & UX

- [ ] Implement `nimbus media allow-remote <itemId>` and `nimbus media allow-remote --service <service> --since <date> --limit <n>`.
- [ ] Implement dual-ended preview: `source <service> · destination <vendor>` with mandatory confirmation prompt.
- [ ] Implement `nimbus media grants list` and `nimbus media grants revoke <itemId> [--vendor <vendor>]`.
- [ ] Update `nimbus media understand` summary to disclose remote items understood vs skipped for lack of grant (`skippedByReason.no_remote_grant`).

### Static Invariant Rules & Security Tests

- [ ] Add static rule **D27(a)** in `check-nimbus-invariants.ts` confining remote VLM constructors to `multimodal/build-media-pass-deps.ts`.
- [ ] Add static rule **D27(b)** confining `media_grant` SQL operations to `multimodal/media-grant-store.ts`.
- [ ] Implement **I37** enforcement test in `packages/gateway/src/security-invariants.test.ts`:
  - Positive control: Register a mock remote VLM with active grant -> assert `model` egress row appears and describe succeeds.
  - Negative control: Attempt remote describe without active grant -> assert gate refuses with `no_remote_grant` and 0 egress rows are appended.
  - Fail-closed control: Local model unavailable + no grant -> assert gate refuses with `no_local_model` and does not contact remote.

---

## 7. Conclusion

The design for S2 Multimodal I/O is comprehensive, secure, and faithful to Nimbus's local-first architecture. By addressing candidate re-discovery for newly granted items (Finding 3.1), standardizing MIME type handling for remote VLM adapters (Finding 3.2), and reconciling historical spec drift (Section 2), PR 4 will complete Spine S2 Multimodal I/O with ironclad privacy invariants and an exceptional user experience.
