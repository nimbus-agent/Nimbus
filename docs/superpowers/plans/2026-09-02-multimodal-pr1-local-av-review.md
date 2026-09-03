# Implementation Plan Review: Multimodal PR 1 — Local Audio/Video Understanding (2026-09-02)

**Date:** 2026-09-02  
**Review Target:** [`2026-09-02-multimodal-pr1-local-av.md`](./2026-09-02-multimodal-pr1-local-av.md)  
**Status:** Review Complete  

---

## 1. Executive Summary

The **Multimodal PR 1 (Local Audio/Video Understanding)** implementation plan is exceptionally thorough, well-sequenced, and grounded in the core architectural principles of Nimbus:

1. **Gate-First Posture (Task 8):** Implementing `media-gate.ts` with its ordered refusals in PR 1 before any remote provider exists prevents architectural drift and bypass risks.
2. **Privacy Protection via Routing (Task 2):** Pinning `nimbus:image_understanding` and `nimbus:video_understanding` to `LOCAL_ONLY_PROSE_TYPES` before derived rows are ever written guarantees that extracted media text is never transmitted to remote embedders (e.g. OpenAI) without user consent.
3. **Resilient Pass Architecture (Task 11):** Adopting SQLite-backed cursor persistence (`media_pass_cursor`, V58) and per-reason skip disclosure ensures that the batch pass is robust against restarts and transparent about skips.
4. **Positive Control Verification (Task 13):** Testing the zero-egress guarantee against an active positive control ensures that the claim cannot pass vacuously.

This review identifies **4 critical implementation blockers/gaps**, **4 operational and reliability risks (notably `GpuArbiter` watchdog timeouts on long media files)**, and a set of actionable recommendations to ensure smooth execution.

---

## 2. Critical Implementation Blockers & Bugs

### 2.1 Production Connector Sync Wiring Missing in Task 4 (`createFilesystemV2Syncable`)

* **Context:** In **Task 4**, `collectMediaFiles` and `upsertMediaFiles` are implemented and tested against in-memory databases in `filesystem-v2-media.test.ts`.
* **Issue:** In [`packages/gateway/src/connectors/filesystem-v2-sync.ts`](../../../packages/gateway/src/connectors/filesystem-v2-sync.ts), `createFilesystemV2Syncable.sync()` iterates over configured filesystem roots and invokes sync operations for `gitAware`, `dependencyGraph`, and `codeIndex`. However:
  1. `collectMediaFiles` / `upsertMediaFiles` is **never wired into `createFilesystemV2Syncable.sync()`** in Task 4.
  2. `upsertMediaFiles` is signature-typed with `db: Database`, whereas `sync()` operates through `ctx: SyncContext` (`ctx.upsertItem(...)`), which does not expose the raw `db` handle (enforcing D24).
  3. Consequently, running `nimbus sync` in production will never index media files into the `item` table, causing `findCandidates` in `nimbus media understand` to return 0 candidates on real user databases.
* **Fix:**
  * In `filesystem-v2-sync.ts`, implement `syncFilesystemMediaForRoot(ctx: SyncContext, root: string, exclude: readonly string[], maxFiles: number, now: number)` using `ctx.upsertItem(...)`.
  * Wire `syncFilesystemMediaForRoot` into `createFilesystemV2Syncable.sync()` under the root iteration loop.

---

### 2.2 Relative Path Exclusions (`isExcluded`) Missing in `walkMediaFilesRecursive`

* **Context:** In **Task 4 Step 3**, `walkMediaFilesRecursive` handles exclusions using:

  ```ts
  if (exclude.includes(entry.name)) {
    continue;
  }
  ```

* **Issue:** The existing code file walk in `filesystem-v2-sync.ts` ([lines 407–414](../../../packages/gateway/src/connectors/filesystem-v2-sync.ts)) evaluates both entry names and relative paths using `isExcluded(rel, exclude)`:

  ```ts
  const rel = relative(root, full);
  if (isExcluded(rel, exclude)) {
    continue;
  }
  ```

  `exclude` in `nimbus.toml` frequently contains glob patterns and directory path prefixes (e.g. `dist/**`, `fixtures/*`, `target/`). The entry-name check alone misses these relative path patterns.
* **Fix:** In `walkMediaFilesRecursive`, compute `rel = relative(root, full)` and invoke the existing `isExcluded(rel, exclude)` helper to ensure consistency between code and media indexing.

---

### 2.3 `Bun.spawn` stderr Stream Typing vs Mock Discrepancy in `transcodeToWav`

* **Context:** In **Task 6 Step 3** (`packages/gateway/src/multimodal/stt/ffmpeg-bin.ts` line 1111):

  ```ts
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as {
    exited: Promise<number>;
    stderr: Response;
  };
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr as unknown as BodyInit).text().catch(() => "");
    throw new Error(`ffmpeg exited ${code} for ${input}: ${err.slice(0, 400)}`);
  }
  ```

* **Issue:** In Bun's runtime, `proc.stderr` returned by `Bun.spawn` is a `ReadableStream<Uint8Array>`, not a `Response`.
  * Wrapping `proc.stderr` in `new Response(proc.stderr)` works when `proc.stderr` is a `ReadableStream`, but in Task 6 Step 1's mock test ([line 1006](./2026-09-02-multimodal-pr1-local-av.md)), the test mock supplies `stderr: new Response("boom")` (an actual `Response` instance).
  * Passing a `Response` object into `new Response(proc.stderr as unknown as BodyInit)` causes runtime type confusion.
* **Fix:** Standardize the signature in `ffmpeg-bin.ts`:

  ```ts
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(`ffmpeg exited ${code} for ${input}: ${err.slice(0, 400)}`);
  }
  ```

  In test mocks, provide `stderr: new Response("boom").body` (a `ReadableStream`).

---

### 2.4 CLI Command Execution Runner Missing in `media-cmd.ts`

* **Context:** In **Task 12 Step 7**, `packages/cli/src/commands/media-cmd.ts` exports `parseMediaArgs` and `renderSummary`.
* **Issue:** The file does not specify the IPC client integration runner that connects the CLI command to the Gateway.
* **Fix:** Explicitly export the command handler in `media-cmd.ts`:

  ```ts
  export async function executeMedia(argv: readonly string[], ctx: CommandContext): Promise<void> {
    const parsed = parseMediaArgs(argv);
    const summary = await ctx.client.call<MediaPassSummary>("media.understand", parsed.params);
    ctx.stdout.write(renderSummary(summary) + "\n");
  }
  ```

---

## 3. Architectural & Operational Considerations

### 3.1 `GpuArbiter` 30-Second Watchdog Eviction during Long Audio Transcriptions

* **Context:** In **Task 8 Step 3** (`media-gate.ts`), `understandArtifact` acquires a `GpuArbiter` lease around `provider.understand(path)`:

  ```ts
  const release = await deps.gpu.acquire(`multimodal:${candidate.modality}`);
  try {
    const text = await provider.understand(path);
    return { ok: true, outcome: ... };
  } finally {
    release();
  }
  ```

* **Risk:** In [`packages/gateway/src/llm/gpu-arbiter.ts`](../../../packages/gateway/src/llm/gpu-arbiter.ts), `GpuArbiter` enforces a hardcoded default idle watchdog timeout of **30 seconds** (`timeoutMs = 30_000`):

  ```ts
  if (this.locked && Date.now() - this.lastActivityAt > this.timeoutMs) {
    this.forceRelease();
  }
  ```

  For a 10-to-30 minute audio recording transcribed on CPU via `whisper-cli`, transcription will take several minutes.
  If an interactive query (`nimbus ask`) arrives after 30 seconds, `GpuArbiter.acquire()` will observe that `lastActivityAt` is older than 30s, trigger `forceRelease()`, evict the multimodal lease, and clear the queue.
* **Recommendation:**
  1. Have long-running operations send periodic heartbeat ticks to `deps.gpu.touch?.()` during transcription, OR
  2. Configure a dedicated timeout window for multimodal batch workloads when initializing `GpuArbiter`.

---

### 3.2 Subprocess Execution Timeout / Cancellation for `ffmpeg` and `whisper-cli`

* **Context:** `transcodeToWav` (Task 6) and `WhisperSttProvider.transcribe` (voice/stt.ts) spawn external binaries and await `proc.exited`.
* **Risk:** If a corrupted media file causes `ffmpeg` or `whisper-cli` to hang or loop indefinitely, the entire understanding pass hangs forever with no timeout.
* **Recommendation:** Introduce a reasonable wall-clock execution timeout (e.g. 5–10 minutes) for transcode and transcribe subprocesses using `AbortSignal` or a timer that terminates `proc.kill()` on expiration.

---

### 3.3 Scratch File Orphaning on Process Interruption (SIGINT)

* **Context:** Task 6 implements `withScratchFile` with a `finally` block executing `rmSync(path, { force: true })`.
* **Risk:** While `finally` guarantees cleanup on exceptions and promise rejections, if the gateway process receives a `SIGINT` (Ctrl+C) or `SIGTERM` during a long batch pass, the process terminates immediately without executing `finally`, leaving orphaned `.wav` scratch files in `scratchDir`.
* **Recommendation:** Add a lightweight startup sweep in `stt/ffmpeg-bin.ts` (or during pass initialization) that prunes stale `nimbus-stt-*.wav` files older than 1 hour from `scratchDir`.

---

### 3.4 Missing `metadata.mimeType` in `upsertMediaFiles`

* **Context:**
  * In Task 4 Step 7 (`upsertMediaFiles`), metadata is populated with `{ path: file.path, sizeBytes, mediaKind: file.modality }`.
  * In Task 10 Step 3 (`media-discovery.ts`), candidate construction attempts to read `sourceMime: stringOrNull(meta["mimeType"])`.
* **Observation:** Because `upsertMediaFiles` does not set `mimeType`, `candidate.sourceMime` is always `null`, and derived `video_understanding` items will always record `metadata.sourceMime: null`.
* **Fix:** In `upsertMediaFiles`, infer `mimeType` from file extension (e.g. `.mp4` -> `video/mp4`, `.mp3` -> `audio/mpeg`, `.wav` -> `audio/wav`) and write it into metadata.

---

## 4. Security & Invariant Alignment

1. **Local-Only STT & Zero Egress:** The plan strictly upholds the local-only constraint. No network handles, remote keys, or vault secrets are accessed in PR 1.
2. **Scratch File Permissions (0600):** Setting `chmodSync(out, 0o600)` on the intermediate WAV file inside `withScratchFile` correctly protects temporary audio from local multi-user observation on POSIX systems.
3. **Re-Validation Against Live Roots:** `resolveLocalMediaPath` (Task 5) correctly resolves symlinks and re-verifies directory containment against live `[[filesystem.roots]]` before accessing files on disk.

---

## 5. Implementation Checklist

* [ ] Wire `syncFilesystemMediaForRoot` into `createFilesystemV2Syncable.sync()` in `filesystem-v2-sync.ts` (Task 4)
* [ ] Add `isExcluded(rel, exclude)` to `walkMediaFilesRecursive` in `filesystem-v2-sync.ts` (Task 4)
* [ ] Infer `mimeType` from extension in `upsertMediaFiles` (Task 4)
* [ ] Fix `Bun.spawn` stderr stream handling in `transcodeToWav` and mock tests (Task 6)
* [ ] Address `GpuArbiter` 30-second timeout handling during long STT transcription (Task 8)
* [ ] Export full `executeMedia` command runner in `packages/cli/src/commands/media-cmd.ts` (Task 12)
* [ ] Verify `CURRENT_SCHEMA_VERSION === 58` across all test migration helpers (Task 1)
