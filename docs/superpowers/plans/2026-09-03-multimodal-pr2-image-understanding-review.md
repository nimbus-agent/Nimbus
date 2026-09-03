# Implementation Plan Review: Multimodal PR 2 — Image Understanding & Frame Captions (2026-09-03)

**Date:** 2026-09-03  
**Review Target:** [`2026-09-03-multimodal-pr2-image-understanding.md`](./2026-09-03-multimodal-pr2-image-understanding.md)  
**Status:** Review Complete  

---

## 1. Executive Summary

The **Multimodal PR 2 (Image Understanding & Frame Captions)** implementation plan is exceptionally well-structured, rigorous, and aligns tightly with Nimbus architectural invariants and security posture:

1. **In-Memory Frame Extraction (Task 5):** Piping single JPEG frames directly off `ffmpeg`'s stdout into memory strengthens the narrowed disk rule (spec § 5.4), ensuring neither still images nor extracted video frames ever touch the local filesystem.
2. **Vision Egress Completeness (Task 3):** Introducing the dedicated `VlmProvider` seam and decorating it with `wrapLedgeredVlm` ensures that any future remote VLM route is strictly ledgered before any image bytes leave the machine (I29/D22(g)), preventing silent egress windows.
3. **Live Org-Policy Lockoff (Task 8):** Wiring a live `MediaRpcCtx.enforced` accessor at boot and failing closed on absent context removes the inert `multimodal_input` policy state present in PR 1.
4. **Resilient Degradation for Video (Task 6):** Audio transcription remains the load-bearing component for video, while vision frame caption failures degrade gracefully into disclosed prose notes without aborting usable transcripts.

This review identifies **4 critical implementation blockers/bugs** (including a disconnected metadata pipeline and an `ffprobe` process-hang hazard), **4 operational reliability & edge-case improvements**, and **3 open questions** for design alignment.

---

## 2. Critical Implementation Blockers & Bugs

### 2.1 Disconnected Frame Sampling Metadata in Production (`UnderstandOutcome` vs `LocalUnderstander`)

* **Context:** In **Task 7 Step 3 & 4**, `UnderstandOutcome` is extended with optional fields `framesSampled?: number` and `framesCaptioned?: number`, and `buildUnderstandingRow` spreads these into `item.metadata`. Unit tests are added to verify this mapping.
* **Issue:** 
  1. In `media-gate.ts` (and Task 4), `LocalUnderstander.understand(path)` returns `Promise<string>`.
  2. In `understandArtifact` (`media-gate.ts`), the outcome is constructed as:
     ```ts
     const text = await provider.understand(path);
     return { ok: true, outcome: { text, model: provider.model, isLocal: provider.isLocal } };
     ```
  3. In Task 6, `createAvUnderstander.understand(path)` returns a `Promise<string>` (the concatenated Markdown).
  4. Consequently, `understandArtifact` **never receives nor attaches `framesSampled` or `framesCaptioned`** to `UnderstandOutcome`.
  5. In production, `outcome.framesSampled` and `outcome.framesCaptioned` will **always be `undefined`**, and `item.metadata` will never contain the frame sampling counts.
* **Fix:**
  Widen `LocalUnderstander.understand` to optionally return structured detail:
  ```ts
  export interface UnderstandDetail {
    readonly text: string;
    readonly framesSampled?: number;
    readonly framesCaptioned?: number;
  }

  export interface LocalUnderstander {
    readonly isLocal: boolean;
    readonly model: string;
    isAvailable(): Promise<boolean>;
    understand(path: string): Promise<string | UnderstandDetail>;
  }
  ```
  In `understandArtifact` (`media-gate.ts`):
  ```ts
  const res = await provider.understand(path);
  const detail = typeof res === "string" ? { text: res } : res;
  return {
    ok: true,
    outcome: {
      text: detail.text,
      model: provider.model,
      isLocal: provider.isLocal,
      ...(detail.framesSampled !== undefined ? { framesSampled: detail.framesSampled } : {}),
      ...(detail.framesCaptioned !== undefined ? { framesCaptioned: detail.framesCaptioned } : {}),
    },
  };
  ```
  In `createAvUnderstander` (`av-understander.ts`):
  Return `{ text: sections.join("\n\n"), framesSampled: stamps.length, framesCaptioned: captions.length }`.

---

### 2.2 `probeDurationSeconds` Hangs Indefinitely on Wedged `ffprobe` Subprocess

* **Context:** In **Task 5 Step 4** (`packages/gateway/src/multimodal/frames/frame-extract.ts` lines 1501–1506):
  ```ts
  const out = await new Response(proc.stdout).text();
  const code = await withProcessTimeout(
    proc,
    opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    `ffprobe ${input}`,
  );
  ```
* **Issue:** 
  * `new Response(proc.stdout).text()` asynchronously consumes the readable stream to EOF.
  * If `ffprobe` wedges, deadlocks, or hangs on a corrupt media container without exiting, `proc.stdout` is never closed.
  * Because `await new Response(proc.stdout).text()` is executed **before** `withProcessTimeout` is called, the execution blocks on reading `stdout` indefinitely. The timeout race in `withProcessTimeout` is never initiated.
  * *(Note: In `extractFrameJpeg`, this was correctly handled by creating `const collect = readBounded(proc.stdout)` as a pending promise and awaiting `withProcessTimeout` first).*
* **Fix:**
  Do not await `stdout` before the timeout guard:
  ```ts
  const outPromise = new Response(proc.stdout).text();
  const code = await withProcessTimeout(
    proc,
    opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    `ffprobe ${input}`,
  );
  if (code !== 0) return null;
  const out = await outPromise;
  ```

---

### 2.3 Static Invariant Anchor Missing in `scripts/structure-audit/check-nimbus-invariants.ts`

* **Context:** In **Task 3 Step 5 & 6**, static audit rule D22(g) (`checkVlmAppenderConfinement`) is added to check that `wrapLedgeredVlm` and `createOllamaVlm` are confined to their allow-lists.
* **Issue:** 
  * `check-nimbus-invariants.ts` maintains `RULE_ANCHORS` (lines 1600–1646) which validates that every policed subsystem file is actually present in the scanned file set. If a policed directory drops out of the scanner glob, `assertScanIsMeaningful` aborts with exit code 2.
  * Task 3 omits adding an anchor for D22(g) to `RULE_ANCHORS`. Without an anchor, if `multimodal/` were ever omitted from `iterateSourceFiles()`, D22(g) would report green vacuously.
* **Fix:**
  Add `"packages/gateway/src/multimodal/build-media-pass-deps.ts"` to `RULE_ANCHORS` in `scripts/structure-audit/check-nimbus-invariants.ts`.

---

### 2.4 Existing `dispatchers.test.ts` Suite Breaks on Task 8

* **Context:** In **Task 8 Step 5**, `tryDispatchMediaRpc` in `dispatchers.ts` is updated to require `mediaRpcCtx` and fail closed with `-32603`:
  ```ts
  const mediaCtx = ctx.options.mediaRpcCtx;
  if (mediaCtx === undefined) {
    throw new RpcMethodError(
      -32603,
      "media.understand requires mediaRpcCtx (the org-policy accessor)",
    );
  }
  ```
* **Issue:** In [`packages/gateway/src/ipc/server/dispatchers.test.ts`](../../../packages/gateway/src/ipc/server/dispatchers.test.ts#L1119), the existing test `"media.understand hit through chain"` initializes context via `makeCtx({ localIndex, dataDir })` without passing `mediaRpcCtx`. Running `bun test packages/gateway/src/ipc` will fail immediately.
* **Fix:** Update Task 8 Step 10 / checklist to explicitly include adding `mediaRpcCtx: { enforced: { capabilitiesDisabled: new Set() } }` to the `dispatchers.test.ts` fixture.

---

## 3. Operational, Performance & Reliability Recommendations

### 3.1 Zero-Byte Image Handling in `image-understander.ts`

* **Observation:** In `image-understander.ts`, `read(path)` loads raw bytes into memory. If a zero-byte image exists on disk (e.g. placeholder file), passing `images: [""]` to Ollama `/api/generate` will trigger an unhandled 400/500 error from Ollama.
* **Recommendation:** Explicitly guard against empty byte arrays before calling the model:
  ```ts
  const bytes = await read(path);
  if (bytes.byteLength === 0) {
    throw new Error(`image file is empty: ${path}`);
  }
  ```

### 3.2 Clean Handling for Silent Audio / Missing Speech in `av-understander.ts`

* **Observation:** For videos with no audio track or silent audio (e.g. screen captures, silent instructional clips), `whisper-cli` returns an empty transcript (`""`).
* **Issue:** `av-understander.ts` formats this as:
  ```markdown
  ## Transcript

  
  ```
* **Recommendation:** Fall back to a descriptive marker when `transcript` is empty:
  ```ts
  const cleanTranscript = transcript === "" ? "(No speech detected)" : transcript;
  sections.push(`${TRANSCRIPT_HEADING}\n\n${cleanTranscript}`);
  ```

### 3.3 Prompt Invariance and OCR Robustness

* **Observation:** The prompt in `caption-prompts.ts` instructs the model to prefix OCR with `"Visible text:"`.
* **Note:** Vision LLMs (e.g. `qwen2.5-vl`, `llava`) occasionally format lines with markdown emphasis (`**Visible text:**`) or markdown lists. Because SQLite FTS5 indexes the entire prose `body` of `image_understanding` and `video_understanding` rows, exact string formatting will not impact keyword search. However, prompt tests should verify that assertions do not perform fragile regex matching on `"Visible text:"` when asserting against real live model output.

### 3.4 Rate / Concurrency of Frame Captions

* **Observation:** For a long video with `max_frames = 8`, `createAvUnderstander` captions frames sequentially in a `for (const at of stamps)` loop.
* **Analysis:** Each frame invocation involves `ffmpeg` seek + Ollama inference (~2–5s per frame). Total pass time per video may reach 20–40s.
* **Verification:** `media-gate.ts` already runs a 10-second heartbeat (`setInterval(() => deps.gpu.touch(), 10_000)`) throughout the entire `provider.understand()` execution. This ensures `GpuArbiter` will **not** trigger idle eviction during multi-frame inference. Sequential processing is safe and protects local VRAM.

---

## 4. Open Questions

1. **Short Video Frame Sampling Intervals:**
   If a clip is 2 seconds long and `max_frames` is 8, `frameTimestamps(2, 8)` produces 8 timestamps spaced ~220ms apart. Should `frameTimestamps` clamp sampling density (e.g. minimum interval of 1–2 seconds between frames) or is uniform density across short clips desired?
2. **`GpuArbiter` Modality Key Granularity:**
   `understandArtifact` requests `multimodal:${candidate.modality}` (e.g. `multimodal:image` or `multimodal:av`). Because `whisper-cli` and `ollama` both contend for local compute/GPU memory, they share the single arbiter lock. Is any differentiation needed between STT vs VLM within the arbiter? (Current single-lock design is sufficient and conservative).
3. **Legacy Ollama Version Detection Fallback:**
   In `ollama-vlm.ts`, the fallback checks `details.families` for `["clip", "mllama"]`. Are there other common vision projector families in older Ollama releases (e.g. `llama` with vision adapters)? The plan's choice to report unavailable when neither is present is a sound fail-closed posture.

---

## 5. Summary Checklist of Plan Edits

- [ ] **Task 5:** Fix `probeDurationSeconds` stream reading order to prevent unhandled hang on wedged `ffprobe`.
- [ ] **Task 6 & 7:** Widen `LocalUnderstander.understand` return type to pass `framesSampled` and `framesCaptioned` up through `media-gate.ts` into `UnderstandOutcome` and `item.metadata`.
- [ ] **Task 3:** Add `"packages/gateway/src/multimodal/build-media-pass-deps.ts"` to `RULE_ANCHORS` in `check-nimbus-invariants.ts`.
- [ ] **Task 8:** Add `mediaRpcCtx` fixture to `packages/gateway/src/ipc/server/dispatchers.test.ts`.
- [ ] **Task 4:** Add zero-byte file guard in `createImageUnderstander`.
- [ ] **Task 6:** Fall back to `"(No speech detected)"` for empty transcripts in `createAvUnderstander`.
