# Design Review: S2 — Multimodal I/O (Local-First Media Understanding) — PR 3 Cloud Arm & Architecture Audit

**Date:** 2026-09-04  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Status:** Review Complete / Actionable Feedback Provided  
**Target Spec:** [`docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`](./2026-09-02-s2-multimodal-io-design.md)  
**Slot:** [Spine S2 — Local Compute Fleet](../../roadmap.md#active)  
**Implementation State:** PR 1 (Shipped #1429), PR 2 (Shipped #1438), PR 3 (Designed in § 16), PR 4 (Planned in §§ 3, 6, 10, 13)

---

## 1. Executive Summary

This review assesses the full design specification [`2026-09-02-s2-multimodal-io-design.md`](./2026-09-02-s2-multimodal-io-design.md) with particular focus on the newly appended **§ 16 (PR 3 — The Cloud Arm)**, while also auditing alignment with PR 1 and PR 2 shipped code and validating the roadmap toward PR 4 (Remote Arm, Invariant **I37**, Static Rule **D27**, and Schema **V59**).

### Key Strengths of the Design

1. **Pragmatic Single-Repo Realization (§ 16.1):** Correcting the assumption in § 12.5 that `fetchBytes` required changes across `nimbus-mcp-servers`. Because `google_photos`, `google_drive`, and `onedrive` sync logic already lives in the gateway process, PR 3 can deliver immediate cloud capability without cross-repository coordination.
2. **Robust Credential Scoping (§ 16.4):** Replacing the ill-fitting `fetch-host-boundary.ts` with the strict principle that *credentials are attached only to URLs constructed by the gateway itself*, while pre-signed provider URLs (Google Photos `baseUrl`, OneDrive `@microsoft.graph.downloadUrl`) are fetched without credentials and pinned to `https:`.
3. **Honest, Two-Layer Bandwidth Budgeting (§ 16.9):** Pricing known sizes up front while enforcing `fetch_budget_bytes` on the running stream total resolves the fact that Google Photos indexes dimensions but no byte counts.
4. **Honest Disk Rule Formulation (§ 16.3):** Transparently acknowledging that cloud AV downloads require a second ephemeral scratch file (downloaded media + transcode WAV), eliminating the false claim that only a single WAV is ever written across the subsystem.

Below are critical findings, open architectural questions, and concrete improvements identified during the review.

---

## 2. Critical Findings & Open Questions (PR 3 Cloud Arm)

### Finding 2.1: Discovery Query & Cursor Starvation on `type: "file"` Connectors

- **Context (§ 16.5 vs `media-discovery.ts`):**
  - In `google-drive-sync.ts` and `onedrive-sync.ts`, all items are indexed as `type: "file"`.
  - Currently, `media-discovery.ts` selects candidates with `WHERE src.type IN (...) ORDER BY src.id LIMIT ?`.
  - In `media-pass.ts`:

    ```ts
    const candidates = findCandidates(deps.db, { limit: deps.limit, ... });
    // ... process candidates ...
    if (candidates.length < deps.limit) {
      clearCursor(deps.db, deps.passId);
    }
    ```

- **The Defect:**
  - If `file` is registered in `mediaItemTypePairsForModality()`, SQLite returns a batch of 50 items with `type = "file"`.
  - In a typical Drive/OneDrive containing thousands of non-media files (PDFs, spreadsheets, code, docs), all 50 items in that page may have non-media MIME types (e.g., `application/pdf`, `text/plain`).
  - In JS, `findCandidates()` filters out non-media items, returning `candidates.length === 0` (or `< limit`).
  - `media-pass.ts` interprets `candidates.length < limit` as reaching the end of the entire queue and executes `clearCursor()`.
  - **Impact:** The pass prematurely terminates after inspecting the first 50 files, leaving the remaining tens of thousands of drive files unprocessed forever.
- **Recommendations:**
  1. **SQL-Level MIME Filtering:** Add a service-aware MIME condition in `findCandidates()`:

     ```sql
     AND (
       src.type IN ('media_av', 'media_image', 'photo')
       OR (
         src.service IN ('google_drive', 'onedrive')
         AND src.type = 'file'
         AND (
           json_extract(src.metadata, '$.mimeType') LIKE 'image/%'
           OR json_extract(src.metadata, '$.mimeType') LIKE 'video/%'
           OR json_extract(src.metadata, '$.mimeType') LIKE 'audio/%'
         )
       )
     )
     ```

  2. **Candidate Paging Loop in `findCandidates`:** Ensure `findCandidates` loops in SQLite until either `limit` valid `MediaCandidate` objects are accumulated or no further rows exist in the database.

---

### Finding 2.2: Modality Filtering for Google Photos (`photo` type)

- **Context (§ 16.5 & `google-photos-sync.ts`):**
  - Google Photos indexes all assets as `type: "photo"`, but `mediaMetadata` / `mimeType` determines whether it is an image (`image/jpeg`, `image/png`) or a video (`video/mp4`, `video/quicktime`).
  - When an operator runs `nimbus media understand --modality av`, `mediaItemTypePairsForModality("av")` must decide whether `photo` should be queried.
- **The Dilemma:**
  - If `photo` is excluded from `"av"`, Google Photos videos will never be transcribed or captioned under `--modality av`.
  - If `photo` is included in `"av"`, SQLite will return still photos, which JS drops, causing the same candidate under-filling and cursor-clearing bug described in Finding 2.1.
- **Recommendation:**
  - When `--modality` is specified, filter `metadata.mimeType` directly in SQL for polymorphic types (`photo` and `file`), e.g.:
    - `modality === "image"`: `json_extract(metadata, '$.mimeType') LIKE 'image/%'`
    - `modality === "av"`: `(json_extract(metadata, '$.mimeType') LIKE 'video/%' OR json_extract(metadata, '$.mimeType') LIKE 'audio/%')`

---

### Finding 2.3: HTTP Redirect Following, SSRF, and Authorization Header Leakage

- **Context (§ 16.4):**
  - For Google Drive: `www.googleapis.com/drive/v3/files/{id}?alt=media` is fetched with a Bearer `Authorization` header. Google Drive frequently issues an HTTP 302/303 redirect to storage nodes (`*.googleusercontent.com` or `storage.googleapis.com`).
  - For Google Photos & OneDrive: Pre-signed URLs are fetched with **no** `Authorization` header and pinned to `https:`.
- **Risks:**
  1. **Bearer Header Leakage:** If Bun's `fetch()` automatically follows redirects to third-party storage hosts, it must strip the Bearer token upon crossing origin boundaries to avoid leaking OAuth credentials.
  2. **SSRF via Malicious/Compromised Redirect Targets:** If a provider-returned URL or redirect target resolves to loopback (`127.0.0.1`, `localhost`) or cloud metadata endpoints (`169.254.169.254`, `10.0.0.0/8`, `192.168.0.0/16`), the gateway could be tricked into fetching internal resources.
- **Recommendation:**
  - In `cloud-bytes.ts`, implement byte fetching with an explicit redirect policy:
    - Enforce `https:` on the initial URL and all subsequent redirect locations.
    - Block redirects targeting private/loopback IP ranges.
    - Explicitly strip `Authorization` headers on any cross-origin redirect.

---

### Finding 2.4: Stream-Level Budget Enforcement & Mid-Download Cleanup

- **Context (§ 16.9):**
  - `fetch_budget_bytes` (default 2 GiB) bounds total bytes fetched per run.
- **Edge Cases:**
  1. **Mid-Stream Budget Overrun:** If a 300 MB video is being downloaded from OneDrive and the budget has only 50 MB remaining, downloading the entire 300 MB before checking the budget wastes 250 MB of bandwidth.
  2. **Aborted Stream Cleanup:** If the budget is tripped mid-download, the response stream must be aborted immediately via `AbortController`, the network connection severed, and the partial scratch file deleted synchronously in a `finally` block.
  3. **Summary Reporting:** `MediaPassSummary` currently has no dedicated field for budget stops. If `runMediaPass` terminates due to budget exhaustion, the summary should report `stopReason: "budget_exhausted" | "completed"` and `cloudBytesFetched: number` so the CLI can format the exact refusal/resume guidance defined in § 16.9.

---

### Finding 2.5: Scratch Sweeper Alignment Across Multiple File Patterns

- **Context (§ 16.3 vs `stt/ffmpeg-bin.ts:181`):**
  - `sweepStaleScratchFiles()` currently deletes only files matching `nimbus-stt-*.wav`.
  - § 16.3 states: *"The start-of-pass sweep must learn the second filename pattern."*
- **Recommendation:**
  - Standardize scratch file naming:
    - Audio transcode scratch: `nimbus-stt-${uuid}.wav`
    - Cloud download scratch: `nimbus-cloud-${uuid}.tmp` (or `nimbus-cloud-${uuid}.${ext}`)
  - Update `sweepStaleScratchFiles(scratchDir, nowMs)` to sweep both patterns:

    ```ts
    const isScratch = (name.startsWith("nimbus-stt-") && name.endsWith(".wav")) ||
                      (name.startsWith("nimbus-cloud-") && (name.endsWith(".tmp") || name.endsWith(".wav") || name.endsWith(".mp4")));
    ```

  - Ensure all cloud downloads wrap file creation and execution in `withScratchFile()` so normal error unwinding deletes them immediately.

---

### Finding 2.6: Rate Limiting & Backoff on Provider Media Endpoints

- **Context (§ 16.10):**
  - `rate_limited` is added to the `SkipReason` union.
  - Google Photos API has strict per-minute quota limits on media items.
- **Risk:**
  - If a pass encounters HTTP 429 on the 1st photo of a 100-item album and merely skips it, it will immediately hammer the API 99 more times, generating 99 consecutive 429 errors and risking account-level throttling.
- **Suggestion:**
  - In `cloud-bytes.ts`, implement short exponential backoff with jitter (e.g. 1s, 2s, 4s, max 2 retries) upon receiving HTTP 429 or 503 with a `Retry-After` header.
  - If rate limiting persists after retries, abort the pass gracefully with a summary reporting that the run stopped due to upstream rate limits, rather than burning the entire candidate list.

---

## 3. Architecture & Security Invariants Review (PR 3 & PR 4)

### 3.1 Invariant I29 Egress Ledger Enumeration Update (§ 16.11)

- **Audit:**
  - I29 documentation currently states that the `sync` class has two appenders: `sync/scheduler.ts` (per-run) and `sync/targeted-fetch.ts` (per-call).
  - PR 3 introduces `multimodal/cloud-bytes.ts` as the **third** appender of `sync`-class egress rows.
  - Because each byte fetch is an outbound HTTP request for binary media, it appends one row via `recordSyncEgress(db, { destination, method, now })` before making the network call.
  - In accordance with the sweep-enumerations rule, verify that `CLAUDE.md`, `GEMINI.md`, `docs/SECURITY-INVARIANTS.md`, and the `nimbus-egress` skill are updated simultaneously in PR 3 to document the three-appender roster.

---

### 3.2 Invariant I37 & Static Rule D27 Formulation for PR 4 (§ 10, § 15 decision 6)

- **Audit:**
  - In PR 1 and PR 2, I37 is satisfied vacuously on the remote arm because no remote provider is registered, and `media-gate.ts` fail-closed refuses `!provider.isLocal` with `no_remote_grant`.
  - In PR 4, when remote VLM providers are introduced:
    - Model contact occurs via `VlmProvider.describe()`, wrapped by `wrapLedgeredVlm` (D22(g)).
    - Static rule **D27(a)** must verify that `media-gate.ts` is the only site that checks active grants in `media-grant-store.ts` before delegating to a remote provider.
    - Static rule **D27(b)** must confine writes to `media_grant` (V59 table) to `media-grant-store.ts`, callable only via the owner-facing consent broker.

---

### 3.3 Vector Embedding Privacy Isolation Verification (§ 4, § 11.4)

- **Audit:**
  - Derived items `nimbus:image_understanding` and `nimbus:video_understanding` are registered in `LOCAL_ONLY_PROSE_TYPES` in `embedding/routing.ts`.
  - `routing.test.ts` asserts that `PROSE_HEAVY_TYPES` and `LOCAL_ONLY_PROSE_TYPES` remain strictly disjoint.
  - This ensures that even when a remote OpenAI embedding model is active, the OCR text and transcripts derived from local or cloud media remain embedded strictly locally with MiniLM-384, preventing secondary text exfiltration. This architectural defense is sound and fully verified.

---

### 3.4 Cascade Pruning of Derived Understanding Items (§ 4.2)

- **Context (§ 4.2):**
  - "Deleting a source item deletes its derived understanding row."
  - In `item-store.ts`, `deleteItemByServiceExternal(db, service, externalId)` only deletes the specified `(service, external_id)` row.
  - The derived row lives under `service = 'nimbus'` with `external_id = '<source_item_id>:understanding'`.
- **Gap:**
  - When a source item is deleted from Google Drive, OneDrive, or local disk, its corresponding derived `nimbus:*_understanding` row will be orphaned unless explicitly pruned.
- **Suggestion:**
  - Add an explicit cascade cleanup in `deleteItemByServiceExternal` or a periodic orphan cleanup query in `media-discovery.ts`:

    ```sql
    DELETE FROM item
     WHERE service = 'nimbus'
       AND (type = 'image_understanding' OR type = 'video_understanding')
       AND NOT EXISTS (
         SELECT 1 FROM item AS src WHERE src.id = json_extract(item.metadata, '$.derivedFrom')
       );
    ```

---

## 4. Usability & CLI Improvements

### 4.1 CLI Argument Validation & Mutually Exclusive Flags (§ 16.8)

- In § 16.8, `nimbus media understand` introduces `--renditions` and `--originals`.
- **Improvement:**
  - Ensure the CLI parser enforces mutual exclusivity: passing both `--renditions` and `--originals` must exit immediately with an informative error rather than letting one flag silently override the other.
  - Support an optional `--budget <bytes>` flag (e.g. `--budget 4GB`) to allow a temporary one-run budget override without editing `nimbus.toml`.

### 4.2 Interactive Run Summary & Counterfactual Reporting (§ 16.8, § 16.9)

- To provide complete transparency to the user, ensure the CLI run summary formats:

  ```text
  Media Understanding Pass Summary:
    Understood: 42 (Images: 30, Videos: 12)
    Skipped: 18
      - over_byte_cap: 8
      - no_local_model: 4
      - rate_limited: 6
    Bandwidth: 1.14 GB fetched (Originals)
      [Tip: --renditions would have fetched ~180 MB for these artifacts]
    Status: Completed (Cursor saved at item_108)
  ```

---

## 5. Verification & Testing Checklist for PR 3

When implementing PR 3, ensure the following test legs are added:

1. [ ] **Provider Response Wire Tests:** Mock HTTP server tests using recorded, verbatim JSON response fixtures from Google Photos (`mediaItems.get`), Google Drive (`files.get?alt=media`), and Microsoft Graph (`/drive/items/{id}`).
2. [ ] **Credential Attachment Invariant Tests:**
   - Assert `Authorization: Bearer ...` is present on Google Drive download URLs.
   - Assert `Authorization` is strictly **absent** on Google Photos `baseUrl` and OneDrive `@microsoft.graph.downloadUrl` requests.
   - Assert requests to non-HTTPS URLs are rejected fail-closed.
   - Assert requests attempting to redirect to private/loopback IP addresses are blocked.
3. [ ] **Budget Abort Test on Running Total:** Test with mocked Google Photos items having unknown byte sizes, verifying that the run halts promptly when downloaded bytes exceed `fetch_budget_bytes`, leaving the V58 cursor pointing to the last processed item.
4. [ ] **Scratch File Cleanup Tests:**
   - Verify that download scratch files are removed on successful understanding, on download failure, on transcode failure, and on process cancellation.
   - Verify that `sweepStaleScratchFiles()` removes stale download scratch files older than 1 hour while leaving active/younger files intact.
5. [ ] **Candidate Discovery Paging Tests:**
   - Create a test database with 100 `google_drive` items of `type: 'file'`, where only items #70–#75 are images.
   - Verify that `findCandidates` correctly pages through the non-media files and returns the media items without prematurely terminating the pass.

---

## 6. Conclusion

The multimodal I/O design document [`2026-09-02-s2-multimodal-io-design.md`](./2026-09-02-s2-multimodal-io-design.md) provides an exceptionally clear, principled architecture. The newly added § 16 (PR 3 Cloud Arm) solves the cloud media acquisition problem cleanly while upholding Nimbus's non-negotiable local-first and privacy invariants.

Addressing the candidate discovery pagination on `type: "file"` connectors (Finding 2.1), enforcing redirect and credential isolation (Finding 2.3), and standardizing the scratch sweeper (Finding 2.5) will make PR 3 rock-solid across Windows, macOS, and Linux.
