# S2 Multimodal PR 2 — Image Understanding & Frame Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the multimodal understanding pass a vision arm — a local Ollama-served VLM that captions images and sampled video frames — so `nimbus media understand` produces `image_understanding` rows and a `video_understanding` row carrying both a transcript and frame captions, which is what Phase 14's Core acceptance criterion actually requires.

**Architecture:** A new `VlmProvider` seam (distinct from `LlmProvider`, whose `LlmGenerateOptions` is text-only) with its own I29 `model`-class decorator `wrapLedgeredVlm`, mirroring the four-decorators-for-four-seams shape already established by `wrapLedgeredProvider` / `wrapLedgeredMastraModel` / `wrapLedgeredEmbedder`. Two adapters turn a `VlmProvider` into the `LocalUnderstander` the existing `media-gate.ts` chokepoint already consumes: one for still images, one composite for audio/video that runs the shipped `LongFormStt` and then captions N uniformly sampled frames. Bytes reach the model in memory only — the image path reads the source file, and the frame path takes single JPEG frames off ffmpeg's stdout — so no new file is written on either path.

**Tech Stack:** Bun 1.2+, TypeScript 7 strict, `bun:sqlite`, Biome. External binaries spawned (never linked): `ffmpeg`, `ffprobe`, `whisper-cli`. Local model served over HTTP by Ollama at a loopback base URL.

**Spec:** [`docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`](../specs/2026-09-02-s2-multimodal-io-design.md) — this plan implements its § 13 row for **PR 2**. Read §§ 3.4, 4, 5.4, 8, 8.1, 9.2, 9.3, 12.1, 12.3, 12.8, 12.10 before starting.

---

## Global Constraints

- **No `any`.** External JSON (an Ollama response, ffprobe stdout) is narrowed from `unknown` with real guards, never an `as` cast. Non-Negotiable #7.
- **DI over `mock.module`.** `mock.module` is process-global and leaks across the combined CI run. Every subprocess spawn and every `fetch` is an injected seam with an injectable override. House rule, stated in `long-form-stt.ts`'s own header.
- **`isLocal` is DERIVED, never passed in.** Invariant I34. A local runtime derives it from its resolved base URL via `llm/base-url-locality.ts` `isLoopbackBaseUrl`. A caller-supplied locality flag is what makes a false zero representable in the ledger.
- **Ledger THEN act.** An append failure aborts the call (`EgressAppendFailedError`), so a zero-row window means nothing left the machine, never that something left unrecorded.
- **Default off.** `[multimodal] enabled` stays `false` on absent section, absent key, absent `nimbus.toml`, and absent `configDir`. A missing or malformed config must never read as "on".
- **Every spawn scopes its env** via `extensionProcessEnv({})` (invariant I1). Copy the pattern from `multimodal/stt/ffmpeg-bin.ts`.
- **Every spawn is wall-clock bounded**, and `clearTimeout`/`clearInterval` runs in a `finally` — an outstanding timer keeps `bun test` alive past the last assertion, which presents as a hanging suite rather than a failing one.
- **Cross-platform paths** via `path.join()`; no hardcoded separators. `bun run audit:cross-platform` gates this.
- **Skips are disclosed by reason**, never as a bare total. Spec § 8.
- **Pre-push:** `bun run preflight:fast` after every task; `bun run preflight` before opening the PR. `test:ci` is not the full gate set.
- **Commit on the branch, never `main`.** This plan is executed in the worktree `.claude/worktrees/multimodal-vlm` on `dev/asaf/multimodal-pr2-image-understanding`.

### Decisions this plan makes that the spec left open

Each is a deliberate, recorded deviation — Task 9 writes them back into the spec rather than leaving the spec and the code disagreeing.

1. **Vision capability is detected via `POST /api/show`, not by matching model names in `/api/tags`.** § 9.2 says `isAvailable()` probes `/api/tags` and confirms a vision-capable model is pulled. `/api/tags` returns names and `details.families`; inferring vision from name fragments (`llava`, `qwen2-vl`, `gemma3`) breaks on every new model and on any custom tag. `/api/show` returns an explicit `capabilities` array. Same requirement, durable mechanism. A legacy Ollama with no `capabilities` field falls back to a `families` check for `clip`/`mllama`; when neither is present the provider reports unavailable, which the gate turns into a `no_local_model` refusal rather than a guess.
2. **Frame bytes never touch disk.** § 5.4 anticipated frame extraction writing scratch files. Instead each frame is a separate `ffmpeg -ss <t> -i <in> -frames:v 1 -f image2 -vcodec mjpeg pipe:1` invocation whose single JPEG is read off stdout. One spawn per frame (8 by default) against a fast input seek, which is cheap next to a VLM call. This **strengthens** § 5.4's disk rule rather than amending it: the narrowed rule's "nothing is written on the image path" now also covers video frames, and the one 0600 scratch WAV for audio transcode remains the only file the subsystem writes.
3. **One GPU lease per artifact, not per frame.** § 8 words the lease as "per frame and per audio chunk". PR 1 already ships one `acquire()` + heartbeat per `understandArtifact` call, and the heartbeat — not the lease's narrowness — is what defuses `GpuArbiter`'s idle-eviction hazard (§ 8.1). Re-acquiring per frame would add N queue round-trips per video and let another caller take the GPU mid-artifact, leaving a half-captioned video whose partial state nothing records. The existing shape is kept and § 8's wording is corrected to match.
4. **`UNDERSTANDING_VERSION` goes to `2`.** `media-discovery.ts` re-offers any row whose `metadata.understandingVersion` is below the current constant, so the bump makes every already-transcribed video re-run and gain captions. Correct per § 4.1 (one stable row per artifact, version advances in place) and cheap in practice: PR 1 is default-off and one day old.
5. **Frame captions are composed BEFORE the transcript in the body.** `bodyCapForItemType` clamps `video_understanding` at `BODY_MAX_PROSE` (16,384) and `item-store.ts` sets `body_complete = 0` automatically when the clamp bites. Captions-first means a long transcript loses its tail rather than the captions vanishing, and the truncation is already disclosed by `body_complete`.
6. **PR 4's static rule D27(a) must be re-derived, not copied.** The spec writes D27(a) as confining free functions named `describeBytes` / `transcribeBytes` to `media-gate.ts`. This PR's model contact is a **provider method** (`VlmProvider.describe`) reached through a confined decorator, so a rule scanning for those two identifiers would pass over the real shape and enforce nothing. Task 9 records this so PR 4 writes a rule against what exists.

### Review dispositions (2026-09-03)

Findings from [`…-review.md`](./2026-09-03-multimodal-pr2-image-understanding-review.md), each verified against the codebase before being acted on.

| # | Finding | Disposition |
| --- | --- | --- |
| 2.1 | Frame-sampling metadata never reaches production — `understand()` returns a bare `string`, so `framesSampled`/`framesCaptioned` are always `undefined` | **Fixed, with a different mechanism.** Confirmed: the unit test on `buildUnderstandingRow` would have passed on a fixture while production wrote nothing. Task 4 Step 5(b) now returns a total `UnderstandDetail`, not the reviewer's `string \| UnderstandDetail` union — see below. |
| 2.2 | `probeDurationSeconds` awaits stdout to EOF **before** the timeout guard, so a wedged `ffprobe` hangs forever | **Fixed** (Task 5 Step 4) + a red-provable test. `extractFrameJpeg` had it right and `probeDurationSeconds` did not, in the same file. |
| 2.3 | No `RULE_ANCHORS` entry for D22(g), so it would report clean vacuously if `multimodal/` left the scan | **Fixed** (Task 3 Step 7), anchored on `build-media-pass-deps.ts` — a file the rule scans and permits — matching the D23 and D22(f) precedents. |
| 2.4 | `dispatchers.test.ts`'s `"media.understand hit through chain"` builds no `mediaRpcCtx` and breaks on Task 8's refusal | **Fixed** (Task 8 Step 9), by supplying the fixture, not by weakening the refusal. |
| 3.1 | Zero-byte image sends `images: [""]` and buys a 400 | **Fixed** (Task 4), guarded before the call so the skip reason stays precise. |
| 3.2 | Empty transcript renders a bare `## Transcript` heading | **Fixed and extended** (Task 6): `"(No speech detected.)"` when there are captions — **and a throw when transcript and captions are both empty**, which the review did not raise. A row whose entire body is disclosure notes understands nothing, and writing one is the overclaim the rest of this plan guards against. |
| 3.3 | Live VLM output may wrap `Visible text:` in markdown; don't assert on it with fragile regex | **No change needed.** The live test (Task 9) asserts only `text.trim().length > 0`. Noted rather than actioned. |
| 3.4 | Sequential frame captioning takes 20–40 s/video | **No change.** The review verifies the 10 s heartbeat covers the whole `understand()` call, which is the same conclusion decision 3 reached independently. |
| Q1 | A 2 s clip sampled 8 times gives near-identical captions ~220 ms apart | **Fixed** (Task 5): `frameTimestamps` clamps to one frame per `MIN_FRAME_INTERVAL_SECONDS` (2), floored at one. Real GPU waste, cheap to prevent. |
| Q2 | Should STT and VLM contend on separate arbiter keys? | **No change.** One lock is correct: they contend for the same VRAM, so separate keys would let both run at once — the failure the arbiter exists to prevent. |
| Q3 | Other legacy vision projector families beyond `clip`/`mllama`? | **Open, and deliberately fail-closed.** An unrecognised family reports unavailable, which refuses rather than guessing. Recorded as a known bound in Task 9's spec amendment; widen the list only against an observed real daemon, never speculatively. |

**Why not the union return type (2.1).** The review proposed `understand(path): Promise<string \| UnderstandDetail>` with a `typeof res === "string"` narrow at the gate. Verified the blast radius first: `understand` has three implementers and one caller, all inside `multimodal/`, and `LongFormStt` has exactly one consumer — so there is no compatibility argument for the looser type. A union would leave that narrow at the gate permanently and, worse, makes "this understander forgot to report its counts" and "this understander has no counts to report" the same value. A total type puts every implementer in front of the compiler when a field is added.

### Already satisfied by PR 1 — do not re-do

- **Spec § 11.4, embedding-routing set membership.** `nimbus:image_understanding` is *already* in `LOCAL_ONLY_PROSE_TYPES` (`embedding/routing.ts`) and `routing.test.ts` already pins the two sets disjoint, so the first `image_understanding` row this PR writes is embedded locally with no edit here. That is the property from § 4 that matters most — a scanned private document is as exposed by its OCR text as by its pixels — so verify it still holds (`bun test packages/gateway/src/embedding/routing.test.ts`) rather than assuming, but expect no change.
- **`bodyCapForItemType`.** `LONG_BODY_TYPES` unions `LOCAL_ONLY_PROSE_TYPES`, so both understanding types already get the 16 KiB prose cap.
- **Orphan pruning (§ 4.2) and the scratch-file sweep (§ 11.5)** are PR 1's and unchanged. The frame path writes no scratch file, so it adds nothing to sweep.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/multimodal/multimodal-config.ts` | The whole `[multimodal]` section reader — `enabled` plus the vision keys. Replaces `resolveMultimodalEnabled`'s single-boolean parser. |
| `packages/gateway/src/multimodal/vlm/vlm-types.ts` | `VlmProvider`, `VlmDescribeInput`, `VlmDescribeResult`. No implementation, no imports from `llm/`. |
| `packages/gateway/src/multimodal/vlm/ollama-vlm.ts` | `createOllamaVlm` — the one real `VlmProvider`. Injected `fetch`. Derives `isLocal` (I34). |
| `packages/gateway/src/egress/vlm-egress.ts` | `wrapLedgeredVlm` — the I29 `model`-class appender for vision. Local provider returned unchanged. |
| `packages/gateway/src/multimodal/vlm/image-understander.ts` | `VlmProvider` → `LocalUnderstander` for a still image. Reads the file into memory; writes nothing. |
| `packages/gateway/src/multimodal/vlm/caption-prompts.ts` | The two prompt strings, in one place so the version bump has one thing to point at. |
| `packages/gateway/src/multimodal/frames/frame-extract.ts` | `resolveFfprobeBin`, `probeDurationSeconds`, `frameTimestamps`, `extractFrameJpeg`. |
| `packages/gateway/src/multimodal/frames/av-understander.ts` | Composite `LocalUnderstander`: transcript + sampled frame captions + the sampling disclosure. |
| `packages/gateway/src/ipc/media-rpc.ts` (modify) | Add `MediaRpcCtx` carrying the live `enforced` policy accessor. |

**Modify:**

| File | Change |
| --- | --- |
| `packages/gateway/src/multimodal/media-types.ts` | `UNDERSTANDING_VERSION` → `2`; export `MULTIMODAL_CAPABILITY`. |
| `packages/gateway/src/multimodal/media-gate.ts` | Rename `MediaGateDeps.sttFor` → `understanderFor` (it now serves images too). |
| `packages/gateway/src/multimodal/stt/ffmpeg-bin.ts` | Export `withProcessTimeout` for reuse by the frame extractor. |
| `packages/gateway/src/multimodal/understanding-item.ts` | Frame-sampling metadata fields. |
| `packages/gateway/src/multimodal/build-media-pass-deps.ts` | Build the VLM, wrap it, wire both understanders. |
| `packages/gateway/src/ipc/server/options.ts` | `mediaRpcCtx?: MediaRpcCtx`. |
| `packages/gateway/src/ipc/server/dispatchers.ts` | Read the real `capabilityDisabled`; fail closed when the accessor is absent. |
| `packages/gateway/src/platform/assemble.ts` | `ipcOpts.mediaRpcCtx = { get enforced() { … } }`. |
| `scripts/structure-audit/check-nimbus-invariants.ts` | D22(g) rule + its run-list entry. |
| `packages/gateway/src/security-invariants.test.ts` | D22(g) enforcement test; update the `model`-class appender enumeration. |
| `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/roadmap.md`, `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, the spec | Task 9. |

---

## Task 1: The `[multimodal]` config section

`resolveMultimodalEnabled` hand-parses one boolean. PR 2 needs four values, so the parser becomes a small section reader — still standalone rather than routed through `nimbus-toml.ts`, matching `connectors/openapi-indexer-config.ts`.

**Files:**
- Create: `packages/gateway/src/multimodal/multimodal-config.ts`
- Test: `packages/gateway/src/multimodal/multimodal-config.test.ts`
- Modify: `packages/gateway/src/multimodal/build-media-pass-deps.ts` (delete `resolveMultimodalEnabled` + `parseMultimodalEnabled`, re-export from the new module)

**Interfaces:**
- Consumes: `stripComment` from `../config/toml-primitives.ts`.
- Produces: `interface MultimodalConfig { readonly enabled: boolean; readonly vlmBaseUrl: string; readonly vlmModel: string; readonly maxFrames: number }` and `loadMultimodalConfig(configDir: string | undefined): MultimodalConfig`, plus `DEFAULT_VLM_BASE_URL`, `DEFAULT_VLM_MODEL`, `DEFAULT_MAX_FRAMES`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/multimodal-config.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_VLM_BASE_URL,
  DEFAULT_VLM_MODEL,
  loadMultimodalConfig,
} from "./multimodal-config.ts";

function withToml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-cfg-"));
  writeFileSync(join(dir, "nimbus.toml"), body, "utf8");
  return dir;
}

describe("loadMultimodalConfig", () => {
  test("no configDir is OFF with defaults", () => {
    const cfg = loadMultimodalConfig(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmBaseUrl).toBe(DEFAULT_VLM_BASE_URL);
    expect(cfg.vlmModel).toBe(DEFAULT_VLM_MODEL);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("absent section is OFF", () => {
    expect(loadMultimodalConfig(withToml("[llm]\nprefer_local = true\n")).enabled).toBe(false);
  });

  test("reads all four keys, comments stripped", () => {
    const dir = withToml(
      [
        "[multimodal]",
        "enabled = true # on locally",
        'vlm_base_url = "http://127.0.0.1:11434"',
        'vlm_model = "qwen2.5vl:7b"',
        "max_frames = 4",
      ].join("\n"),
    );
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.vlmModel).toBe("qwen2.5vl:7b");
    expect(cfg.maxFrames).toBe(4);
  });

  test("a later section ends the block", () => {
    const dir = withToml("[multimodal]\nenabled = true\n\n[llm]\nmax_frames = 99\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("max_frames is clamped to a sane range, never zero or absurd", () => {
    expect(loadMultimodalConfig(withToml("[multimodal]\nmax_frames = 0\n")).maxFrames).toBe(1);
    expect(loadMultimodalConfig(withToml("[multimodal]\nmax_frames = 9999\n")).maxFrames).toBe(64);
    expect(
      loadMultimodalConfig(withToml("[multimodal]\nmax_frames = nonsense\n")).maxFrames,
    ).toBe(DEFAULT_MAX_FRAMES);
  });

  test("a malformed file reads as OFF, never as on", () => {
    const dir = withToml("[multimodal\nenabled = true\n");
    expect(loadMultimodalConfig(dir).enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/multimodal-config.test.ts`
Expected: FAIL — `Cannot find module './multimodal-config.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/gateway/src/multimodal/multimodal-config.ts
/**
 * The `[multimodal]` section (spec § 9.2, § 8).
 *
 * Standalone rather than routed through `nimbus-toml.ts`, mirroring
 * `connectors/openapi-indexer-config.ts`: four keys do not warrant a shared parser's full
 * section-table machinery. Reuses `stripComment` from the dependency-free `toml-primitives.ts`
 * so `enabled = true # on locally` reads correctly.
 *
 * DEFAULT OFF, and every failure path — absent `configDir`, absent file, absent section, absent
 * key, unreadable or malformed TOML — reads as `false`. A missing config must never read as "on".
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComment } from "../config/toml-primitives.ts";

/** Loopback, so `isLoopbackBaseUrl` derives `isLocal === true` for the default (I34). */
export const DEFAULT_VLM_BASE_URL = "http://127.0.0.1:11434";

/**
 * A tag the user must have pulled themselves. Nothing here pulls a model: `isAvailable()`
 * reporting false is a refusal condition (spec § 3.4 step 4), not a trigger to download
 * gigabytes during a pass.
 */
export const DEFAULT_VLM_MODEL = "qwen2.5vl:7b";

/** Spec § 8: "a small fixed maximum (default 8) of uniformly spaced keyframes". */
export const DEFAULT_MAX_FRAMES = 8;

const MIN_FRAMES = 1;
const MAX_FRAMES_CEILING = 64;

export interface MultimodalConfig {
  readonly enabled: boolean;
  readonly vlmBaseUrl: string;
  readonly vlmModel: string;
  readonly maxFrames: number;
}

function defaults(): MultimodalConfig {
  return {
    enabled: false,
    vlmBaseUrl: DEFAULT_VLM_BASE_URL,
    vlmModel: DEFAULT_VLM_MODEL,
    maxFrames: DEFAULT_MAX_FRAMES,
  };
}

export function loadMultimodalConfig(configDir: string | undefined): MultimodalConfig {
  if (configDir === undefined) return defaults();
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return defaults();
  try {
    return parseSection(readFileSync(tomlPath, "utf8"));
  } catch {
    return defaults();
  }
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && (t.startsWith('"') || t.startsWith("'")) && t.endsWith(t[0] ?? "")) {
    return t.slice(1, -1);
  }
  return t;
}

function clampFrames(raw: string, fallback: number): number {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_FRAMES_CEILING, Math.max(MIN_FRAMES, n));
}

function parseSection(raw: string): MultimodalConfig {
  let inSection = false;
  let out = defaults();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === "") continue;
    // A malformed header (`[multimodal`) never equals the section name, so it leaves `inSection`
    // false and the whole file reads as defaults — the fail-safe direction.
    if (line.startsWith("[")) {
      inSection = line === "[multimodal]";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === "enabled") {
      const v = value.trim().toLowerCase();
      if (v === "true") out = { ...out, enabled: true };
      else if (v === "false") out = { ...out, enabled: false };
    } else if (key === "vlm_base_url") {
      const v = unquote(value);
      if (v !== "") out = { ...out, vlmBaseUrl: v };
    } else if (key === "vlm_model") {
      const v = unquote(value);
      if (v !== "") out = { ...out, vlmModel: v };
    } else if (key === "max_frames") {
      out = { ...out, maxFrames: clampFrames(value, out.maxFrames) };
    }
  }
  return out;
}
```

- [ ] **Step 4: Point the old name at the new reader**

In `build-media-pass-deps.ts`, delete `resolveMultimodalEnabled`, `parseMultimodalEnabled` and the now-unused `existsSync` / `readFileSync` / `stripComment` imports, then re-export so no call site breaks in this task:

```ts
// build-media-pass-deps.ts — near the top, with the other imports
import { loadMultimodalConfig } from "./multimodal-config.ts";

/**
 * Kept as a named re-export so `ipc/server/dispatchers.ts` keeps compiling while Task 8 moves it
 * to the full config object. Delete when that task lands.
 */
export function resolveMultimodalEnabled(configDir: string | undefined): boolean {
  return loadMultimodalConfig(configDir).enabled;
}
```

- [ ] **Step 5: Run the suite for the module and its callers**

Run: `bun test packages/gateway/src/multimodal`
Expected: PASS, including the existing `build-media-pass-deps.test.ts` cases that call `resolveMultimodalEnabled`.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/multimodal-config.ts \
        packages/gateway/src/multimodal/multimodal-config.test.ts \
        packages/gateway/src/multimodal/build-media-pass-deps.ts
git commit -m "feat(multimodal): read the whole [multimodal] section, not just enabled"
```

---

## Task 2: The `VlmProvider` seam and the Ollama VLM

`LlmGenerateOptions` is `{ task, prompt: string, … }` with no image field, and widening it would push image bytes through `wrapLedgeredProvider` and every text caller. This is the same fork the Mastra engine agent hit over `tools`, and it takes the same answer: a distinct provider with its own decorator (spec § 9.2).

**Files:**
- Create: `packages/gateway/src/multimodal/vlm/vlm-types.ts`, `packages/gateway/src/multimodal/vlm/ollama-vlm.ts`
- Test: `packages/gateway/src/multimodal/vlm/ollama-vlm.test.ts`

**Interfaces:**
- Consumes: `isLoopbackBaseUrl` from `../../llm/base-url-locality.ts` (I34).
- Produces:
  ```ts
  interface VlmDescribeInput { readonly bytes: Uint8Array; readonly prompt: string; readonly egressMethod?: string }
  interface VlmDescribeResult { readonly text: string }
  interface VlmProvider {
    readonly providerId: string;
    readonly isLocal: boolean;
    readonly model: string;
    isAvailable(): Promise<boolean>;
    describe(input: VlmDescribeInput): Promise<VlmDescribeResult>;
  }
  createOllamaVlm(opts: { baseUrl?: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): VlmProvider
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/vlm/ollama-vlm.test.ts
import { describe, expect, test } from "bun:test";
import { createOllamaVlm } from "./ollama-vlm.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createOllamaVlm", () => {
  test("isLocal is DERIVED from the base URL, not the vendor id (I34)", () => {
    expect(createOllamaVlm({ baseUrl: "http://127.0.0.1:11434" }).isLocal).toBe(true);
    expect(createOllamaVlm({ baseUrl: "http://gpu-box.lan:11434" }).isLocal).toBe(false);
  });

  test("isAvailable is true when /api/show reports the vision capability", async () => {
    const calls: string[] = [];
    const vlm = createOllamaVlm({
      model: "qwen2.5vl:7b",
      fetchImpl: (input) => {
        calls.push(String(input));
        return Promise.resolve(jsonResponse({ capabilities: ["completion", "vision"] }));
      },
    });
    expect(await vlm.isAvailable()).toBe(true);
    expect(calls[0]).toContain("/api/show");
  });

  test("a pulled model WITHOUT the vision capability is unavailable", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ capabilities: ["completion"] })),
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("legacy Ollama with no capabilities field falls back to the families check", async () => {
    const withClip = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ details: { families: ["llama", "clip"] } })),
    });
    expect(await withClip.isAvailable()).toBe(true);

    const textOnly = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ details: { families: ["llama"] } })),
    });
    expect(await textOnly.isAvailable()).toBe(false);
  });

  test("a 404 from /api/show — model not pulled — is unavailable, not a throw", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: () => Promise.resolve(new Response("not found", { status: 404 })),
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("an unreachable daemon is unavailable, not a throw", async () => {
    const vlm = createOllamaVlm({ fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("describe posts base64 image bytes to /api/generate and returns the response text", async () => {
    let body: unknown;
    const vlm = createOllamaVlm({
      model: "qwen2.5vl:7b",
      fetchImpl: (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ response: "A slide titled Q3 roadmap." }));
      },
    });
    const res = await vlm.describe({
      bytes: new Uint8Array([1, 2, 3]),
      prompt: "Describe this image.",
    });
    expect(res.text).toBe("A slide titled Q3 roadmap.");
    expect(body).toMatchObject({
      model: "qwen2.5vl:7b",
      prompt: "Describe this image.",
      stream: false,
      images: [Buffer.from([1, 2, 3]).toString("base64")],
    });
  });

  test("a non-200 from /api/generate throws, so the gate records transcribe_failed", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    await expect(
      vlm.describe({ bytes: new Uint8Array([1]), prompt: "p" }),
    ).rejects.toThrow(/500/);
  });

  test("a malformed body throws rather than yielding an empty caption", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ unexpected: true })),
    });
    await expect(vlm.describe({ bytes: new Uint8Array([1]), prompt: "p" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/vlm/ollama-vlm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the types**

```ts
// packages/gateway/src/multimodal/vlm/vlm-types.ts
/**
 * The vision seam (spec § 9.2).
 *
 * Deliberately NOT an `LlmProvider`. `LlmGenerateOptions` is `{ task, prompt: string, … }` with no
 * image field; widening it would push image bytes through `wrapLedgeredProvider` and through every
 * text caller's type. That is the same fork the Mastra engine agent hit over `tools`, and it takes
 * the same answer: a separate provider with its own decorator (`egress/vlm-egress.ts`). Four
 * decorators for four seams is the established shape, not a proliferation.
 *
 * No imports from `llm/` beyond locality: this file must stay a leaf so `egress/vlm-egress.ts`
 * can depend on it without dragging the router in.
 */
export interface VlmDescribeInput {
  /** Raw image bytes, in memory. Nothing on this path writes them to disk (spec § 5.4). */
  readonly bytes: Uint8Array;
  readonly prompt: string;
  /**
   * Names the ledger row when this call is ledgered. It can never SUPPRESS one — same contract as
   * `LlmGenerateOptions.egressMethod`.
   */
  readonly egressMethod?: string;
}

export interface VlmDescribeResult {
  readonly text: string;
}

export interface VlmProvider {
  /** The ledger row's `destination` — a vendor, never a URL. */
  readonly providerId: string;
  /**
   * DERIVED (invariant I34). A local runtime computes it from its resolved base URL via
   * `isLoopbackBaseUrl`; a cloud adapter would hardcode `false`. Never accepted from a caller:
   * the egress decorator and any future air-gap refusal both read this one field, so a wrong
   * `true` fails silently in both directions at once.
   */
  readonly isLocal: boolean;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  describe(input: VlmDescribeInput): Promise<VlmDescribeResult>;
}
```

- [ ] **Step 4: Write the Ollama provider**

```ts
// packages/gateway/src/multimodal/vlm/ollama-vlm.ts
/**
 * The one real `VlmProvider`: an Ollama-served vision model over HTTP (spec § 9.2).
 *
 * WHY HTTP AND NOT AN IN-PROCESS DECODE. `workers/sharp-stub.ts` exists because
 * `@xenova/transformers` statically imports the native `sharp`, which killed the whole embedding
 * runtime at load (#1396). Ollama does its own preprocessing, so nothing here decodes an image and
 * the native-module-in-a-compiled-binary problem never arises (spec § 9.3). Do not reintroduce
 * `sharp`, and do not link a frame-extraction library either — ffmpeg is SPAWNED.
 *
 * WHY `/api/show` AND NOT A NAME MATCH. Vision capability must be read, not guessed. `/api/tags`
 * gives names and `details.families`; matching `llava` / `qwen2-vl` / `gemma3` fragments breaks on
 * every new model and on any custom tag, and a running daemon with no VLM pulled would pass a
 * bare "is Ollama up" check and then fail per artifact across a whole pass. `/api/show` answers
 * the real question once, up front. Legacy daemons that predate the `capabilities` field fall back
 * to `families`; when neither says vision, this reports UNAVAILABLE, which the gate turns into a
 * `no_local_model` refusal (spec § 3.4 step 4) rather than a guess.
 */
import { isLoopbackBaseUrl } from "../../llm/base-url-locality.ts";
import { DEFAULT_VLM_BASE_URL, DEFAULT_VLM_MODEL } from "../multimodal-config.ts";
import type { VlmDescribeInput, VlmDescribeResult, VlmProvider } from "./vlm-types.ts";

export interface OllamaVlmOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  /** Injected so tests never need a daemon. `mock.module` is process-global; DI is the house rule. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** A caption on a cold model can take a while; this bounds a HANG, not slowness. */
const DEFAULT_VLM_TIMEOUT_MS = 5 * 60 * 1000;

/** `unknown` narrowing, never an `as` cast: this is external JSON (Non-Negotiable #7). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasVisionCapability(payload: unknown): boolean {
  const root = asRecord(payload);
  if (root === undefined) return false;

  const caps = root["capabilities"];
  if (Array.isArray(caps)) {
    // Authoritative when present. An empty array is a real answer — "no vision" — so it must NOT
    // fall through to the legacy heuristic below.
    return caps.some((c) => typeof c === "string" && c.toLowerCase() === "vision");
  }

  // Legacy Ollama: no `capabilities` field at all. A vision model carries a projector family.
  const families = asRecord(root["details"])?.["families"];
  if (Array.isArray(families)) {
    return families.some(
      (f) => typeof f === "string" && (f.toLowerCase() === "clip" || f.toLowerCase() === "mllama"),
    );
  }
  return false;
}

function responseText(payload: unknown): string {
  const root = asRecord(payload);
  const text = root?.["response"];
  if (typeof text !== "string") {
    throw new Error("ollama vlm: response body has no string `response` field");
  }
  return text;
}

export function createOllamaVlm(opts: OllamaVlmOptions = {}): VlmProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_VLM_BASE_URL).replace(/\/$/, "");
  const model = opts.model ?? DEFAULT_VLM_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VLM_TIMEOUT_MS;

  return {
    providerId: "ollama",
    // DERIVED (I34). An Ollama daemon is reachable over the network and `vlm_base_url` accepts a
    // remote host, so "ollama" says nothing about where the weights run.
    isLocal: isLoopbackBaseUrl(baseUrl),
    model,

    async isAvailable(): Promise<boolean> {
      try {
        const resp = await doFetch(`${baseUrl}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return false;
        return hasVisionCapability(await resp.json());
      } catch {
        // Unreachable daemon, model not pulled, malformed body. All the same answer: unavailable,
        // which is a REFUSAL upstream, never a degrade to remote.
        return false;
      }
    },

    async describe(input: VlmDescribeInput): Promise<VlmDescribeResult> {
      const resp = await doFetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          images: [Buffer.from(input.bytes).toString("base64")],
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        throw new Error(`ollama vlm: /api/generate returned ${resp.status}`);
      }
      // A throw here becomes `transcribe_failed` in `understandArtifact`'s catch, which records the
      // reason and moves to the next candidate. Returning an empty caption instead would write a
      // row claiming an understanding that never happened.
      return { text: responseText(await resp.json()) };
    },
  };
}
```

- [ ] **Step 5: Run the test**

Run: `bun test packages/gateway/src/multimodal/vlm/ollama-vlm.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/vlm/
git commit -m "feat(multimodal): a VlmProvider seam and the Ollama vision provider"
```

---

## Task 3: `wrapLedgeredVlm` + static rule D22(g)

The `model` egress class is already `per-call` and carries no named exclusions. A vision provider that generated without a row would re-open one — and it would be the worst-shaped kind, because a remote VLM call carries the *image itself*. The decorator ships now, before any remote VLM exists, for the same reason PR 1 shipped the gate with only its local arm.

**Files:**
- Create: `packages/gateway/src/egress/vlm-egress.ts`, `packages/gateway/src/egress/vlm-egress.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**
- Consumes: `VlmProvider` (Task 2); `appendEgressEntry` from `./egress-ledger.ts`; `redactEgressSummary` from `./egress-record.ts`; `EgressAppendFailedError` from `./model-egress.ts`.
- Produces: `wrapLedgeredVlm(db: Database, provider: VlmProvider, now?: () => number): VlmProvider`; exported audit check `checkVlmAppenderConfinement(files): Violation[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/egress/vlm-egress.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { VlmProvider } from "../multimodal/vlm/vlm-types.ts";
import { listEgress } from "./egress-verify.ts";
import { EgressAppendFailedError } from "./model-egress.ts";
import { wrapLedgeredVlm } from "./vlm-egress.ts";

// The REAL schema via the migration runner — the pattern every other `egress/*.test.ts` uses.
// `appendEgressEntry` reads the head hash and computes a BLAKE3 chain over prior rows, so a
// hand-rolled CREATE TABLE would exercise something other than the code path that runs. Rows come
// back camelCased from `listEgress`.
function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function fakeVlm(isLocal: boolean, onDescribe?: () => void): VlmProvider {
  return {
    providerId: "ollama",
    isLocal,
    model: "qwen2.5vl:7b",
    isAvailable: () => Promise.resolve(true),
    describe: () => {
      onDescribe?.();
      return Promise.resolve({ text: "a caption" });
    },
  };
}

describe("wrapLedgeredVlm", () => {
  test("a LOCAL provider is returned unchanged and appends nothing", async () => {
    const d = db();
    const local = fakeVlm(true);
    const wrapped = wrapLedgeredVlm(d, local);
    expect(wrapped).toBe(local);
    await wrapped.describe({ bytes: new Uint8Array([1]), prompt: "p" });
    expect(listEgress(d, {})).toHaveLength(0);
  });

  test("a NON-LOCAL provider appends one model-class row per describe", async () => {
    const d = db();
    const wrapped = wrapLedgeredVlm(d, fakeVlm(false), () => 1234);
    await wrapped.describe({ bytes: new Uint8Array([1]), prompt: "p" });
    await wrapped.describe({ bytes: new Uint8Array([2]), prompt: "p" });
    const r = listEgress(d, {});
    expect(r).toHaveLength(2);
    expect(r[0]?.sourceType).toBe("model");
    // #1321's lesson: the destination names the VENDOR, never the word "model".
    expect(r[0]?.destination).toBe("ollama");
    expect(r[0]?.sourceId).toBe("qwen2.5vl:7b");
    expect(r[0]?.method).toBe("multimodal.vlm.describe");
    expect(r[0]?.timestamp).toBe(1234);
    expect(r[0]?.resultStatus).toBe("authorized");
  });

  test("egressMethod NAMES the row and cannot suppress it", async () => {
    const d = db();
    const wrapped = wrapLedgeredVlm(d, fakeVlm(false));
    await wrapped.describe({
      bytes: new Uint8Array([1]),
      prompt: "p",
      egressMethod: "multimodal.vlm.frame",
    });
    const r = listEgress(d, {});
    expect(r).toHaveLength(1);
    expect(r[0]?.method).toBe("multimodal.vlm.frame");
  });

  test("the append happens BEFORE the request, and a failed append aborts it", async () => {
    const d = db();
    let described = false;
    const wrapped = wrapLedgeredVlm(d, fakeVlm(false, () => (described = true)));
    d.run("DROP TABLE egress_ledger");
    await expect(
      wrapped.describe({ bytes: new Uint8Array([1]), prompt: "p" }),
    ).rejects.toBeInstanceOf(EgressAppendFailedError);
    expect(described).toBe(false);
  });

  test("no image bytes and no prompt reach the payload summary", async () => {
    const d = db();
    const wrapped = wrapLedgeredVlm(d, fakeVlm(false));
    await wrapped.describe({ bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef]), prompt: "secret" });
    const summary = String(listEgress(d, {})[0]?.payloadSummary ?? "");
    expect(summary).not.toContain("secret");
    expect(summary).not.toContain("dead");
    expect(summary).toContain("qwen2.5vl:7b");
  });

  test("locality is read off the provider, so a caller cannot fabricate or suppress rows", () => {
    const d = db();
    // No parameter exists to say "this is local" — the only source is the provider's own field.
    expect(wrapLedgeredVlm(d, fakeVlm(true)).isLocal).toBe(true);
    expect(wrapLedgeredVlm(d, fakeVlm(false)).isLocal).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/egress/vlm-egress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the decorator**

```ts
// packages/gateway/src/egress/vlm-egress.ts
/**
 * The I29 `model`-class appender for VISION calls (spec § 9.2, § 7).
 *
 * A DECORATOR over the provider instance, not an append at a call site — the same shape as
 * `wrapLedgeredProvider` (routes), `wrapLedgeredMastraModel` (the AI-SDK seam) and
 * `wrapLedgeredEmbedder` (embeddings). Wrapping the instance covers every current caller and
 * every caller written later without any of them cooperating; a call-site append covers only the
 * sites that exist today, which is how `recordSynthesisEgress` came to leave one of two reachable
 * remote paths silent.
 *
 * Ships BEFORE any remote VLM exists, for the same reason PR 1 shipped the gate with only its
 * local arm: retrofitting an appender onto code that already reaches the model is how a silent
 * window gets built. In this PR a local provider is the only one constructed, so this function is
 * an identity — and it is tested with a deliberately non-local fake so the row exists before the
 * thing that would emit it.
 *
 * WHY LOCALITY IS DERIVED. Reading `provider.isLocal` (I34) makes both failure modes
 * unrepresentable: a caller cannot pass `false` for a remote provider and put a false zero in the
 * ledger `nimbus prove` reports on, nor `true` for a local one and fabricate rows. A LOCAL
 * provider is returned UNCHANGED — identity, not a pass-through wrapper — because a local describe
 * makes no outbound request and ledgering it would over-claim egress. Same choice as
 * `LOCAL_ONLY_SYNC_SERVICES` in `sync-egress.ts`.
 *
 * WHAT THE ROW MAY NOT CARRY. `payload_summary` gets the model and the byte COUNT — never the
 * prompt and never the image. An image is the most sensitive payload in the subsystem; a summary
 * that quoted it would put the artifact in a table whose whole purpose is to be readable.
 */
import type { Database } from "bun:sqlite";
import type { VlmDescribeInput, VlmDescribeResult, VlmProvider } from "../multimodal/vlm/vlm-types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

export function wrapLedgeredVlm(
  db: Database,
  provider: VlmProvider,
  now: () => number = Date.now,
): VlmProvider {
  if (provider.isLocal) {
    return provider;
  }
  return {
    providerId: provider.providerId,
    isLocal: provider.isLocal,
    model: provider.model,
    isAvailable: () => provider.isAvailable(),
    describe: async (input: VlmDescribeInput): Promise<VlmDescribeResult> => {
      // Ledger THEN act. An append that throws aborts the call, so a window with no rows means no
      // image left the machine -- never that one left unrecorded.
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "model",
          sourceId: provider.model,
          destination: provider.providerId,
          method: input.egressMethod ?? "multimodal.vlm.describe",
          payloadSummary: redactEgressSummary({
            model: provider.model,
            imageBytes: input.bytes.byteLength,
          }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        throw new EgressAppendFailedError(err, { appender: "vlm", model: provider.model });
      }
      return provider.describe(input);
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/egress/vlm-egress.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add static rule D22(g)**

Append to `scripts/structure-audit/check-nimbus-invariants.ts`, immediately after `checkEmbeddingConstructorConfinement`:

```ts
// D22 (g): the VISION appender. `egress/vlm-egress.ts`'s `wrapLedgeredVlm` is the I29
// `model`-class appender for a `VlmProvider`. A file that constructs a VLM without it puts an
// unrecorded egress path in the understanding pass -- and the payload on that path is the image
// itself, which makes it the worst-shaped false zero in the ledger.
//
// Two allow-lists, mirroring D22(f): the DECORATOR (so a stray reference is caught) and the
// CONSTRUCTOR (so a new construction site that never mentions the decorator at all is caught
// too -- the gap that rule's second half exists to close).
const D22_VLM_WRAP_RE = /\bwrapLedgeredVlm\b/;
const D22_VLM_WRAP_ALLOWED: readonly string[] = [
  "packages/gateway/src/egress/vlm-egress.ts",
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
];
const D22_VLM_CTOR_RE = /\bcreateOllamaVlm\s*\(/;
const D22_VLM_CTOR_DEFINITION = "packages/gateway/src/multimodal/vlm/ollama-vlm.ts";
const D22_VLM_CTOR_ALLOWED: readonly string[] = [
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
];

export function checkVlmAppenderConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");

    if (!D22_VLM_WRAP_ALLOWED.includes(f.relPath)) {
      const re = new RegExp(D22_VLM_WRAP_RE.source, "g");
      for (const m of stripped.matchAll(re)) {
        const line = stripped.slice(0, m.index).split("\n").length;
        out.push({
          rule: "vlm-appender-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }

    if (f.relPath !== D22_VLM_CTOR_DEFINITION && !D22_VLM_CTOR_ALLOWED.includes(f.relPath)) {
      const re = new RegExp(D22_VLM_CTOR_RE.source, "g");
      for (const m of stripped.matchAll(re)) {
        const line = stripped.slice(0, m.index).split("\n").length;
        out.push({
          rule: "vlm-constructor-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 6: Wire it into the audit run-list**

In the same file, immediately after the `checkEmbeddingConstructorConfinement` block (near line 1886), add:

```ts
  if (mode === "binary-only" || mode === "all") {
    const v = checkVlmAppenderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(g) a VlmProvider constructed or wrapped outside egress/vlm-egress.ts + build-media-pass-deps.ts — an unrecorded vision egress path; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
```

- [ ] **Step 7: Anchor the rule, so it cannot report clean while scanning nothing**

`RULE_ANCHORS` (same file, ~line 1600) lists one file per policed subsystem, and `assertScanIsMeaningful` exits **2** — distinct from a violation's 1 — when any anchor is missing from the scanned set. Without an anchor of its own, D22(g) would report green vacuously the moment `iterateSourceFiles()` stopped reaching `multimodal/`, while the D10–D22 anchors kept the run looking healthy. D23 and D22(f) each carry an anchor for exactly this reason; follow their shape and anchor on a file the rule **scans and then permits**, not on a definition file it skips:

```ts
  // D22(g) — anchored on the ONE production construction site, a file the rule SCANS (it is on
  // both allow-lists, so it is read and then permitted) rather than `vlm/ollama-vlm.ts`, which the
  // constructor rule skips as its own definition and whose presence would therefore prove nothing.
  // Same shape as the D23 and D22(f) anchors above.
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
```

Verify the anchor is load-bearing rather than decorative:

```bash
bun run audit:invariants   # exit 0
# Temporarily add "packages/gateway/src/multimodal/does-not-exist.ts" to RULE_ANCHORS
bun run audit:invariants; echo "exit=$?"   # MUST be exit=2, not 1 and not 0
# Revert that line.
```

- [ ] **Step 8: Red-prove the rule by REVERTING, not by trusting green**

A guard that has never rejected anything is not known to work. Prove it both ways:

```bash
# Positive control: the audit is green as landed.
bun run audit:invariants

# Now plant a violation in a file that is NOT on either allow-list.
printf '\nconst _probe = createOllamaVlm({});\n' >> packages/gateway/src/multimodal/media-pass.ts
bun run audit:invariants   # MUST fail, naming D22(g) and media-pass.ts

# Revert the probe.
git checkout -- packages/gateway/src/multimodal/media-pass.ts
bun run audit:invariants   # green again
```

Expected: the middle run exits non-zero with `vlm-constructor-confined`. If it passes, the rule is not wired — fix that before continuing.

- [ ] **Step 9: Add the enforcement test and update the appender enumeration**

In `packages/gateway/src/security-invariants.test.ts`, inside the existing `describe("I29 — egress-ledger completeness over the executor chokepoint")` block:

```ts
  test("I29/D22(g): wrapLedgeredVlm and createOllamaVlm are confined to their allow-lists", async () => {
    const { checkVlmAppenderConfinement } = await import(
      "../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    const clean = checkVlmAppenderConfinement([
      {
        relPath: "packages/gateway/src/multimodal/build-media-pass-deps.ts",
        contents: "const vlm = wrapLedgeredVlm(db, createOllamaVlm({}));",
      },
    ]);
    expect(clean).toHaveLength(0);

    const dirty = checkVlmAppenderConfinement([
      {
        relPath: "packages/gateway/src/multimodal/media-pass.ts",
        contents: "const vlm = createOllamaVlm({});",
      },
    ]);
    expect(dirty.map((v) => v.rule)).toContain("vlm-constructor-confined");
  });

  test("I29: a non-local VlmProvider cannot describe without a model-class row", async () => {
    // The decorator, not a call site, is the appender — so this holds for callers written later.
    const src = await Bun.file("packages/gateway/src/egress/vlm-egress.ts").text();
    // Append precedes delegation, and the append failure path throws rather than continuing.
    const appendAt = src.indexOf("appendEgressEntry");
    const delegateAt = src.indexOf("provider.describe(input)");
    expect(appendAt).toBeGreaterThan(-1);
    expect(delegateAt).toBeGreaterThan(appendAt);
    expect(src).toContain("throw new EgressAppendFailedError");
    // Locality is DERIVED, never a parameter (I34).
    expect(src).toContain("if (provider.isLocal)");
    expect(src).not.toMatch(/\bisLocal\s*:\s*boolean\s*[,)]/);
  });
```

Then find the `model`-class appender enumeration (the comment near line 2165 listing `wrapLedgeredProvider`, `wrapLedgeredMastraModel` and `wrapLedgeredEmbedder`) and add the vision appender. **Re-derive the list, do not just bump a count** — a total that is still right can hide an enumeration that is wrong.

- [ ] **Step 10: Run the gates**

```bash
bun test packages/gateway/src/egress packages/gateway/src/security-invariants.test.ts
bun run audit:invariants
bun run preflight:fast
```
Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/src/egress/vlm-egress.ts \
        packages/gateway/src/egress/vlm-egress.test.ts \
        scripts/structure-audit/check-nimbus-invariants.ts \
        packages/gateway/src/security-invariants.test.ts
git commit -m "feat(egress): ledger every non-local VLM describe (D22(g))"
```

---

## Task 4: The image understander, and `sttFor` becomes `understanderFor`

The gate consumes `LocalUnderstander`, whose `understand(path)` returns text. An image adapter reads the file into memory and asks the VLM for a caption plus verbatim visible text in one call. The dep's name stops being accurate the moment it serves images, so it is renamed in the same task.

**Files:**
- Create: `packages/gateway/src/multimodal/vlm/caption-prompts.ts`, `packages/gateway/src/multimodal/vlm/image-understander.ts`, `packages/gateway/src/multimodal/vlm/image-understander.test.ts`
- Modify: `packages/gateway/src/multimodal/media-gate.ts`, `packages/gateway/src/multimodal/media-gate.test.ts`, `packages/gateway/src/multimodal/build-media-pass-deps.ts`, `packages/gateway/src/multimodal/build-media-pass-deps.test.ts`

**Interfaces:**
- Consumes: `VlmProvider` (Task 2); `LocalUnderstander` from `../media-gate.ts`.
- Produces: `IMAGE_CAPTION_PROMPT`, `FRAME_CAPTION_PROMPT`; `createImageUnderstander(deps: { vlm: VlmProvider; readFile?: (p: string) => Promise<Uint8Array> }): LocalUnderstander`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/vlm/image-understander.test.ts
import { describe, expect, test } from "bun:test";
import type { VlmDescribeInput, VlmProvider } from "./vlm-types.ts";
import { createImageUnderstander } from "./image-understander.ts";
import { IMAGE_CAPTION_PROMPT } from "./caption-prompts.ts";

function vlmSpy(text = "A whiteboard.\nVisible text: none"): {
  provider: VlmProvider;
  calls: VlmDescribeInput[];
} {
  const calls: VlmDescribeInput[] = [];
  return {
    calls,
    provider: {
      providerId: "ollama",
      isLocal: true,
      model: "qwen2.5vl:7b",
      isAvailable: () => Promise.resolve(true),
      describe: (input) => {
        calls.push(input);
        return Promise.resolve({ text });
      },
    },
  };
}

describe("createImageUnderstander", () => {
  test("isLocal MIRRORS the provider — it is never hardcoded (I34)", () => {
    const local = vlmSpy().provider;
    expect(createImageUnderstander({ vlm: local }).isLocal).toBe(true);
    const remote: VlmProvider = { ...local, isLocal: false };
    expect(createImageUnderstander({ vlm: remote }).isLocal).toBe(false);
  });

  test("model is the provider's model, so the derived row records what produced it", () => {
    expect(createImageUnderstander({ vlm: vlmSpy().provider }).model).toBe("qwen2.5vl:7b");
  });

  test("understand reads the file into memory and sends the caption prompt", async () => {
    const spy = vlmSpy();
    const bytes = new Uint8Array([9, 8, 7]);
    const u = createImageUnderstander({
      vlm: spy.provider,
      readFile: () => Promise.resolve(bytes),
    });
    const detail = await u.understand("/photos/board.png");
    expect(detail.text).toBe("A whiteboard.\nVisible text: none");
    // An image was never sampled, so it reports no frame counts at all — distinct from a video
    // whose every frame failed, which reports `0 of N`.
    expect(detail.framesSampled).toBeUndefined();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.bytes).toBe(bytes);
    expect(spy.calls[0]?.prompt).toBe(IMAGE_CAPTION_PROMPT);
    expect(spy.calls[0]?.egressMethod).toBe("multimodal.vlm.image");
  });

  test("an unreadable file REJECTS, so the gate records a reason rather than writing an empty row", async () => {
    const u = createImageUnderstander({
      vlm: vlmSpy().provider,
      readFile: () => Promise.reject(new Error("EACCES")),
    });
    await expect(u.understand("/photos/locked.png")).rejects.toThrow(/EACCES/);
  });

  test("an empty caption REJECTS rather than writing a row that claims nothing", async () => {
    const u = createImageUnderstander({
      vlm: vlmSpy("   ").provider,
      readFile: () => Promise.resolve(new Uint8Array([1])),
    });
    await expect(u.understand("/photos/x.png")).rejects.toThrow(/empty caption/i);
  });

  test("a zero-byte file REJECTS before the model is contacted", async () => {
    // `Buffer.from(new Uint8Array()).toString("base64")` is `""`, so this would POST
    // `images: [""]` and spend a round-trip earning a 400 that surfaces as the vaguer
    // `transcribe_failed`. Refusing here keeps the reason precise and the call unmade.
    const spy = vlmSpy();
    const u = createImageUnderstander({
      vlm: spy.provider,
      readFile: () => Promise.resolve(new Uint8Array()),
    });
    await expect(u.understand("/photos/empty.png")).rejects.toThrow(/empty/i);
    expect(spy.calls).toHaveLength(0);
  });

  test("isAvailable delegates to the provider", async () => {
    const spy = vlmSpy();
    const unavailable: VlmProvider = { ...spy.provider, isAvailable: () => Promise.resolve(false) };
    expect(await createImageUnderstander({ vlm: unavailable }).isAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/vlm/image-understander.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the prompts**

```ts
// packages/gateway/src/multimodal/vlm/caption-prompts.ts
/**
 * The caption prompts, in ONE place.
 *
 * A prompt change alters what every stored caption says, which is exactly what
 * `UNDERSTANDING_VERSION` (media-types.ts) exists to make re-runnable — so the two must be edited
 * together. Keeping the strings here gives that bump one file to point at.
 *
 * Both prompts ask for OCR text in the SAME call as the description: a VLM's text extraction is
 * materially worse than a purpose-built OCR pass (spec § 12.10), and splitting it into a second
 * call would double the GPU cost without improving that.
 *
 * Both also forbid speculation. A caption is a model's ASSERTION, recorded with
 * `modelDerived: true` so a brief presents it as such (spec § 12.3); a prompt that invited
 * inference would make that flag carry more weight than it can.
 */
export const IMAGE_CAPTION_PROMPT = [
  "Describe this image factually in two to four sentences.",
  "Then, on a new line beginning exactly with 'Visible text:', transcribe any text visible in the",
  "image verbatim. If there is no visible text, write 'Visible text: none'.",
  "Describe only what is visible. Do not speculate about intent, context, or anything outside the frame.",
].join(" ");

export const FRAME_CAPTION_PROMPT = [
  "Describe this single video frame factually in one or two sentences.",
  "Then, on a new line beginning exactly with 'Visible text:', transcribe any text visible in the",
  "frame verbatim. If there is no visible text, write 'Visible text: none'.",
  "Describe only what is visible in this frame. Do not speculate about what happens before or after it.",
].join(" ");
```

- [ ] **Step 4: Write the understander**

```ts
// packages/gateway/src/multimodal/vlm/image-understander.ts
/**
 * `VlmProvider` -> `LocalUnderstander`, so a still image flows through the SAME
 * `understandArtifact` chokepoint as audio and video (spec § 3.2). The gate gains an arm, not a
 * bypass.
 *
 * Nothing is written to disk on this path: the source file is read into memory and handed to the
 * provider as bytes (spec § 5.4). The one scratch file the subsystem writes remains the audio
 * transcode's WAV.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import type { LocalUnderstander } from "../media-gate.ts";
import type { UnderstandDetail } from "../media-types.ts";
import { IMAGE_CAPTION_PROMPT } from "./caption-prompts.ts";
import type { VlmProvider } from "./vlm-types.ts";

export interface ImageUnderstanderDeps {
  readonly vlm: VlmProvider;
  /** Injected for tests; production uses `node:fs/promises`. */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export function createImageUnderstander(deps: ImageUnderstanderDeps): LocalUnderstander {
  const read = deps.readFile ?? (async (p: string) => new Uint8Array(await fsReadFile(p)));
  return {
    // MIRRORED from the provider, never hardcoded. The gate reads this to decide whether a
    // per-artifact remote grant is required (spec § 3.4 step 3, invariant I34); a hardcoded `true`
    // here would route a remote VLM straight past that check.
    get isLocal(): boolean {
      return deps.vlm.isLocal;
    },
    model: deps.vlm.model,
    isAvailable: () => deps.vlm.isAvailable(),
    async understand(path: string): Promise<UnderstandDetail> {
      const bytes = await read(path);
      if (bytes.byteLength === 0) {
        // Base64 of nothing is `""`, so this would POST `images: [""]` and buy a 400 that reaches
        // the user as the vaguer `transcribe_failed`. Refuse before the call, not after it.
        throw new Error(`image file is empty: ${path}`);
      }
      const { text } = await deps.vlm.describe({
        bytes,
        prompt: IMAGE_CAPTION_PROMPT,
        egressMethod: "multimodal.vlm.image",
      });
      const caption = text.trim();
      if (caption === "") {
        // REJECT rather than return "". `understandArtifact` turns this into the
        // `transcribe_failed` skip reason, which the pass summary discloses and a re-run retries.
        // Writing an empty-bodied row instead would claim an understanding that did not happen.
        throw new Error(`vlm returned an empty caption for ${path}`);
      }
      // No frame counts: an image was never sampled. Omitting them is what lets a reader tell that
      // apart from a video whose every frame failed, which reports `framesCaptioned: 0`.
      return { text: caption };
    },
  };
}
```

> `LocalUnderstander.isLocal` is declared `readonly isLocal: boolean`. A getter satisfies a readonly property in TypeScript, so this compiles; it is a getter rather than a snapshot so a provider swapped behind the adapter cannot leave a stale locality behind.

- [ ] **Step 5: Rename the gate dep AND widen the understander's return type**

Two changes to one interface, done together because both touch every implementer.

**(a) The rename.** In `media-gate.ts`:

```ts
  /**
   * Resolves the understander for a modality. Named for what it does rather than for STT: since
   * PR 2 the `image` modality resolves to a VLM-backed understander, and `av` to a composite of
   * transcription and frame captions.
   */
  readonly understanderFor: (modality: MediaModality) => LocalUnderstander | undefined;
```

And in `understandArtifact`, `const provider = deps.understanderFor(candidate.modality);`.

```bash
grep -rn "sttFor" packages/gateway/src packages/cli/src scripts
```
Expected sites: `media-gate.ts`, `media-gate.test.ts`, `build-media-pass-deps.ts`, `build-media-pass-deps.test.ts`. Rename all; leave no alias behind.

**(b) The return type.** `understand` returns `Promise<string>` today, and a string cannot carry the frame-sampling counts Task 7 puts on the derived row — so those counts would be permanently `undefined` in production while a unit test on `buildUnderstandingRow` proved the mapping "works". Add to `media-types.ts`, beside `UnderstandOutcome`:

```ts
/**
 * What an understander RETURNS, as opposed to {@link UnderstandOutcome} which is what the gate
 * RECORDS. The gate adds `model` and `isLocal` from the provider — those are derived, never
 * reported by the understander (I34) — and carries the rest through.
 *
 * A structured type rather than `string | UnderstandDetail`: a union leaves a `typeof` narrow at
 * the gate forever, and it makes "this understander forgot to report its counts" and "this
 * understander has no counts to report" the same value. Total, the compiler names every implementer
 * when a field is added. There are three implementers and one caller, all inside `multimodal/`, so
 * there is no compatibility argument for the looser type.
 */
export interface UnderstandDetail {
  readonly text: string;
  readonly framesSampled?: number;
  readonly framesCaptioned?: number;
}
```

`UnderstandOutcome` gains the same two optional fields **in this task**, not in Task 7 — the gate below spreads them, so deferring them would not compile:

```ts
export interface UnderstandOutcome {
  readonly text: string;
  readonly model: string;
  readonly isLocal: boolean;
  /**
   * Present only for a video that reached frame sampling. Recorded so a reader can tell a video
   * whose frames all failed (`framesCaptioned: 0`) from one that was never sampled at all (both
   * absent) — the body states the same thing in prose (spec § 12.8), and these are the
   * machine-readable half.
   */
  readonly framesSampled?: number;
  readonly framesCaptioned?: number;
}
```

In `media-gate.ts`, `understand(path: string): Promise<UnderstandDetail>;` on `LocalUnderstander`, and in `understandArtifact` replace the success arm:

```ts
    const detail = await provider.understand(path);
    return {
      ok: true,
      outcome: {
        text: detail.text,
        // Both DERIVED from the provider, never reported by the understander (I34).
        model: provider.model,
        isLocal: provider.isLocal,
        // Conditional spread: absent counts must stay absent, not become 0. See UnderstandDetail.
        ...(detail.framesSampled === undefined ? {} : { framesSampled: detail.framesSampled }),
        ...(detail.framesCaptioned === undefined ? {} : { framesCaptioned: detail.framesCaptioned }),
      },
    };
```

In `stt/long-form-stt.ts`, change `LongFormStt.understand` to `Promise<UnderstandDetail>` and its body's last line to `return { text: res.text };`. It has exactly one consumer (`build-media-pass-deps.ts`), so this is contained.

Add a gate test pinning the wire, since this is the defect that made the counts fictional:

```ts
test("understandArtifact carries frame counts from the understander onto the outcome", async () => {
  const res = await understandArtifact(candidate, "/m/a.mp4", {
    ...baseDeps,
    understanderFor: () => ({
      isLocal: true,
      model: "m",
      isAvailable: () => Promise.resolve(true),
      understand: () => Promise.resolve({ text: "t", framesSampled: 8, framesCaptioned: 6 }),
    }),
  });
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.outcome.framesSampled).toBe(8);
    expect(res.outcome.framesCaptioned).toBe(6);
  }
});

test("an understander reporting no counts leaves them absent, not zero", async () => {
  const res = await understandArtifact(candidate, "/m/a.png", {
    ...baseDeps,
    understanderFor: () => ({
      isLocal: true,
      model: "m",
      isAvailable: () => Promise.resolve(true),
      understand: () => Promise.resolve({ text: "t" }),
    }),
  });
  if (res.ok) expect("framesSampled" in res.outcome).toBe(false);
});
```

Reuse whatever `candidate` / deps fixtures `media-gate.test.ts` already defines rather than inventing new ones.

- [ ] **Step 6: Run the affected suites**

```bash
bun test packages/gateway/src/multimodal
bun run typecheck
```
Expected: PASS, and no remaining `sttFor` matches.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/multimodal/
git commit -m "feat(multimodal): caption a still image through the media gate"
```

---

## Task 5: Frame extraction, in memory

**Files:**
- Create: `packages/gateway/src/multimodal/frames/frame-extract.ts`, `packages/gateway/src/multimodal/frames/frame-extract.test.ts`
- Modify: `packages/gateway/src/multimodal/stt/ffmpeg-bin.ts` (export `withProcessTimeout`)

**Interfaces:**
- Consumes: `extensionProcessEnv` from `../../extensions/spawn-env.ts`; `processEnvGet` from `../../platform/env-access.ts`; `withProcessTimeout` from `../stt/ffmpeg-bin.ts`.
- Produces:
  ```ts
  resolveFfprobeBin(configuredPath?: string, which?: (n: string) => string | null): string
  probeDurationSeconds(input: string, opts: ProbeOptions): Promise<number | null>
  frameTimestamps(durationSeconds: number, maxFrames: number): number[]
  extractFrameJpeg(input: string, atSeconds: number, opts: FrameOptions): Promise<Uint8Array>
  interface ProbeOptions { readonly ffprobeBin: string; readonly spawn?: typeof Bun.spawn; readonly timeoutMs?: number }
  interface FrameOptions { readonly ffmpegBin: string; readonly spawn?: typeof Bun.spawn; readonly timeoutMs?: number; readonly maxBytes?: number }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/frames/frame-extract.test.ts
import { describe, expect, test } from "bun:test";
import {
  extractFrameJpeg,
  frameTimestamps,
  probeDurationSeconds,
  resolveFfprobeBin,
} from "./frame-extract.ts";

function fakeSpawn(opts: {
  code?: number;
  stdout?: Uint8Array | string;
  stderr?: string;
  neverExits?: boolean;
  record?: string[][];
}) {
  return ((cmd: string[]) => {
    opts.record?.push(cmd);
    const body = opts.stdout ?? new Uint8Array();
    return {
      exited: opts.neverExits === true ? new Promise<number>(() => {}) : Promise.resolve(opts.code ?? 0),
      stdout: new Response(body).body,
      stderr: new Response(opts.stderr ?? "").body,
      kill: () => {},
    };
  }) as unknown as typeof Bun.spawn;
}

describe("resolveFfprobeBin", () => {
  test("configured path wins, then PATH lookup, then the bare name", () => {
    expect(resolveFfprobeBin("/opt/ffprobe")).toBe("/opt/ffprobe");
    expect(resolveFfprobeBin(undefined, () => "/usr/bin/ffprobe")).toBe("ffprobe");
    // Bare name regardless, so a spawn failure names the missing binary rather than a path the
    // user never configured — matching resolveFfmpegBin.
    expect(resolveFfprobeBin(undefined, () => null)).toBe("ffprobe");
  });
});

describe("frameTimestamps", () => {
  test("uniformly spaced, strictly inside the duration, never at 0 or the end", () => {
    expect(frameTimestamps(90, 3)).toEqual([22.5, 45, 67.5]);
  });

  test("a short clip still yields one timestamp", () => {
    expect(frameTimestamps(1, 8).length).toBeGreaterThanOrEqual(1);
    expect(frameTimestamps(1, 8).every((t) => t > 0 && t < 1)).toBe(true);
  });

  test("never returns more than maxFrames, and never a non-finite value", () => {
    expect(frameTimestamps(3600, 8)).toHaveLength(8);
    expect(frameTimestamps(0, 8)).toEqual([]);
    expect(frameTimestamps(Number.NaN, 8)).toEqual([]);
    expect(frameTimestamps(-5, 8)).toEqual([]);
  });

  test("sampling density is clamped: a short clip gets fewer frames, not 8 near-identical ones", () => {
    // A 2s clip sampled 8 times is 8 VLM calls ~220ms apart — near-duplicate captions at full
    // GPU cost. At most one frame per MIN_FRAME_INTERVAL_SECONDS.
    expect(frameTimestamps(2, 8)).toHaveLength(1);
    expect(frameTimestamps(10, 8)).toHaveLength(5);
    // The clamp never raises the count above maxFrames, and never drops below one frame.
    expect(frameTimestamps(3600, 8)).toHaveLength(8);
    expect(frameTimestamps(0.5, 8)).toHaveLength(1);
  });
});

describe("probeDurationSeconds", () => {
  test("parses ffprobe's bare duration line", async () => {
    const d = await probeDurationSeconds("/v/clip.mp4", {
      ffprobeBin: "ffprobe",
      spawn: fakeSpawn({ stdout: "123.456\n" }),
    });
    expect(d).toBeCloseTo(123.456, 3);
  });

  test("returns null — never throws — when ffprobe is missing or fails", async () => {
    expect(
      await probeDurationSeconds("/v/clip.mp4", {
        ffprobeBin: "ffprobe",
        spawn: fakeSpawn({ code: 127, stderr: "not found" }),
      }),
    ).toBeNull();
  });

  test("returns null on unparseable output rather than a NaN duration", async () => {
    expect(
      await probeDurationSeconds("/v/clip.mp4", {
        ffprobeBin: "ffprobe",
        spawn: fakeSpawn({ stdout: "N/A\n" }),
      }),
    ).toBeNull();
  });

  test("a wedged ffprobe whose stdout never closes still rejects within the bound", async () => {
    // The hazard this pins: awaiting `new Response(stdout).text()` BEFORE the timeout guard blocks
    // forever, because that promise resolves only at EOF and a hung process never closes the pipe.
    // The timeout race would then never be constructed at all. Red-prove it by moving the await
    // back above `withProcessTimeout` — this test must hang-then-fail, not pass.
    const neverClosing = new ReadableStream<Uint8Array>({ start() {} });
    const spawn = (() => ({
      exited: new Promise<number>(() => {}),
      stdout: neverClosing,
      stderr: new Response("").body,
      kill: () => {},
    })) as unknown as typeof Bun.spawn;
    expect(
      await probeDurationSeconds("/v/clip.mp4", { ffprobeBin: "ffprobe", timeoutMs: 20, spawn }),
    ).toBeNull();
  });
});

describe("extractFrameJpeg", () => {
  test("seeks BEFORE -i and writes the single frame to stdout, never to a file", async () => {
    const record: string[][] = [];
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const bytes = await extractFrameJpeg("/v/clip.mp4", 12.5, {
      ffmpegBin: "ffmpeg",
      spawn: fakeSpawn({ stdout: jpeg, record }),
    });
    expect(Array.from(bytes)).toEqual(Array.from(jpeg));
    const cmd = record[0] ?? [];
    expect(cmd.indexOf("-ss")).toBeLessThan(cmd.indexOf("-i"));
    expect(cmd).toContain("pipe:1");
    expect(cmd).toContain("-frames:v");
    // No output path argument: nothing on this path touches disk.
    expect(cmd.some((a) => a.endsWith(".jpg") || a.endsWith(".jpeg"))).toBe(false);
  });

  test("a non-zero exit throws with the stderr tail", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, {
        ffmpegBin: "ffmpeg",
        spawn: fakeSpawn({ code: 1, stderr: "Invalid data found" }),
      }),
    ).rejects.toThrow(/Invalid data found/);
  });

  test("empty stdout throws rather than sending zero bytes to the model", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, { ffmpegBin: "ffmpeg", spawn: fakeSpawn({}) }),
    ).rejects.toThrow(/no frame/i);
  });

  test("a frame over maxBytes throws instead of buffering without bound", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, {
        ffmpegBin: "ffmpeg",
        maxBytes: 2,
        spawn: fakeSpawn({ stdout: new Uint8Array([1, 2, 3, 4]) }),
      }),
    ).rejects.toThrow(/exceeds/i);
  });

  test("a wedged ffmpeg is killed and rejects within the bound", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, {
        ffmpegBin: "ffmpeg",
        timeoutMs: 20,
        spawn: fakeSpawn({ neverExits: true }),
      }),
    ).rejects.toThrow(/timed out/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/frames/frame-extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Export `withProcessTimeout` from `ffmpeg-bin.ts`**

Change `async function withProcessTimeout(` to `export async function withProcessTimeout(` and extend its doc comment with one line:

```ts
/**
 * … (existing comment) …
 *
 * Exported for `frames/frame-extract.ts`, which spawns ffmpeg once per sampled frame and needs
 * the identical kill-then-reap behaviour. One implementation rather than two: a second copy would
 * be the place the reap gets forgotten.
 */
```

- [ ] **Step 4: Write the extractor**

```ts
// packages/gateway/src/multimodal/frames/frame-extract.ts
/**
 * Sampled video frames, extracted to MEMORY (spec § 8, § 5.4).
 *
 * WHY ONE SPAWN PER FRAME, AND WHY NO FILES. The spec anticipated writing frames to scratch files
 * beside the transcode WAV. This does not: each frame is its own
 * `ffmpeg -ss <t> -i <in> -frames:v 1 -f image2 -vcodec mjpeg pipe:1`, whose single JPEG is read
 * off stdout and handed straight to the VLM. `-ss` BEFORE `-i` is an input seek, so the cost is a
 * seek rather than a decode of everything preceding the timestamp — cheap next to the VLM call
 * that follows. The alternative, one invocation streaming N frames through `image2pipe`, needs the
 * caller to split a concatenated MJPEG stream on SOI/EOI markers; sound in principle (JPEG byte
 * stuffing escapes an in-scan `FF`), but it trades a process spawn for a hand-rolled parser on the
 * least-trusted bytes in the subsystem. It strengthens the narrowed disk rule: with this, "nothing
 * is written on the image path" covers video frames too, and the audio transcode's single 0600 WAV
 * is the only file this subsystem writes at all.
 *
 * NOT in `platform/`: resolving an external binary is not OS-specific logic reached through
 * `PlatformServices`. Same reasoning as `stt/ffmpeg-bin.ts` and `computer-use/cu-lanes/chromium-path.ts`.
 */
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { processEnvGet } from "../../platform/env-access.ts";
import { withProcessTimeout } from "../stt/ffmpeg-bin.ts";

/** A probe is metadata only; it has no reason to be slow. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** A single seek + decode. Generous enough for a slow disk, tight enough to bound a hang. */
const DEFAULT_FRAME_TIMEOUT_MS = 60_000;

/** A 4K MJPEG frame is a few MB; this bounds a runaway, not a legitimate frame. */
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface ProbeOptions {
  readonly ffprobeBin: string;
  readonly spawn?: typeof Bun.spawn;
  readonly timeoutMs?: number;
}

export interface FrameOptions {
  readonly ffmpegBin: string;
  readonly spawn?: typeof Bun.spawn;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

type SpawnedProc = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
};

/** Mirrors `resolveFfmpegBin` exactly — configured path, env override, PATH, then the bare name. */
export function resolveFfprobeBin(
  configuredPath?: string,
  which: (name: string) => string | null = (name) => Bun.which(name),
): string {
  if (configuredPath !== undefined && configuredPath !== "") return configuredPath;
  const envPath = processEnvGet("NIMBUS_FFPROBE_PATH");
  if (envPath !== undefined && envPath !== "") return envPath;
  if (which("ffprobe") !== null) return "ffprobe";
  return "ffprobe";
}

/**
 * Duration in seconds, or `null` when it cannot be determined.
 *
 * NEVER throws. ffprobe ships with every mainstream ffmpeg distribution, but it is a SEPARATE
 * binary and a user can have one without the other. A null here degrades the artifact to
 * transcript-only with a disclosed count (see `av-understander.ts`) instead of failing a video
 * whose audio transcribed perfectly well.
 */
export async function probeDurationSeconds(
  input: string,
  opts: ProbeOptions,
): Promise<number | null> {
  const spawn = opts.spawn ?? Bun.spawn;
  try {
    const proc = spawn(
      [
        opts.ffprobeBin,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        input,
      ],
      { stdout: "pipe", stderr: "pipe", env: extensionProcessEnv({}) },
    ) as unknown as SpawnedProc;
    // Start the read but do NOT await it before the timeout guard. `new Response(stream).text()`
    // resolves only at EOF, and a wedged ffprobe never closes stdout — awaiting here would block
    // forever and the timeout race below would never even be constructed. `extractFrameJpeg` has
    // the same hazard and the same shape; the two must not diverge.
    const outPromise = new Response(proc.stdout).text();
    const code = await withProcessTimeout(
      proc,
      opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      `ffprobe ${input}`,
    );
    if (code !== 0) return null;
    const seconds = Number.parseFloat((await outPromise).trim());
    // `N/A` and an empty line both land here. A NaN duration would produce NaN timestamps and an
    // ffmpeg invocation with a garbage `-ss`.
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** At most one sampled frame per this many seconds of video. See {@link frameTimestamps}. */
const MIN_FRAME_INTERVAL_SECONDS = 2;

/**
 * Uniformly spaced timestamps strictly INSIDE the clip, at a density bounded from BOTH ends.
 *
 * `(i + 1) / (n + 1)` rather than `i / n`: frame 0 of a video is very often a black or title
 * frame, and the final instant is often a fade. Sampling the open interval spends the budget on
 * frames that carry content.
 *
 * The density clamp is the other half. `maxFrames` alone would sample a 2-second clip eight times
 * at ~220 ms apart — eight VLM calls producing near-identical captions, at full GPU cost, for a
 * clip one frame describes. Frames are therefore capped at one per
 * {@link MIN_FRAME_INTERVAL_SECONDS} as well as at `maxFrames`, and floored at one so a short clip
 * still gets a caption rather than none.
 */
export function frameTimestamps(durationSeconds: number, maxFrames: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || maxFrames < 1) return [];
  const byDensity = Math.floor(durationSeconds / MIN_FRAME_INTERVAL_SECONDS);
  const n = Math.max(1, Math.min(Math.floor(maxFrames), byDensity));
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push((durationSeconds * (i + 1)) / (n + 1));
  }
  return out;
}

export async function extractFrameJpeg(
  input: string,
  atSeconds: number,
  opts: FrameOptions,
): Promise<Uint8Array> {
  const spawn = opts.spawn ?? Bun.spawn;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const proc = spawn(
    [
      opts.ffmpegBin,
      "-nostdin",
      "-loglevel",
      "error",
      // BEFORE -i: an input seek, not a decode of everything up to `atSeconds`.
      "-ss",
      atSeconds.toFixed(3),
      "-i",
      input,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      // I1: scope the child's env rather than inherit the gateway's whole process.env.
      env: extensionProcessEnv({}),
    },
  ) as unknown as SpawnedProc;

  // Read stdout CONCURRENTLY with waiting on exit. ffmpeg blocks once the pipe buffer fills, so
  // awaiting `exited` first would deadlock on any frame larger than that buffer.
  const collect = readBounded(proc.stdout, maxBytes);
  const code = await withProcessTimeout(
    proc,
    opts.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
    `ffmpeg frame ${atSeconds}s of ${input}`,
  );
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(`ffmpeg exited ${code} extracting frame at ${atSeconds}s: ${err.slice(0, 400)}`);
  }
  const bytes = await collect;
  if (bytes.byteLength === 0) {
    // A seek past the last frame exits 0 with no output. Throwing keeps the caller from sending
    // zero bytes to the model and storing whatever it says about them.
    throw new Error(`ffmpeg produced no frame at ${atSeconds}s of ${input}`);
  }
  return bytes;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`frame exceeds the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
```

- [ ] **Step 5: Run the test**

Run: `bun test packages/gateway/src/multimodal/frames/frame-extract.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/frames/ packages/gateway/src/multimodal/stt/ffmpeg-bin.ts
git commit -m "feat(multimodal): extract sampled video frames to memory, never to disk"
```

---

## Task 6: The composite AV understander

**Files:**
- Create: `packages/gateway/src/multimodal/frames/av-understander.ts`, `packages/gateway/src/multimodal/frames/av-understander.test.ts`

**Interfaces:**
- Consumes: `LongFormStt` from `../stt/long-form-stt.ts`; `VlmProvider` (Task 2); `frameTimestamps` / `probeDurationSeconds` / `extractFrameJpeg` (Task 5); `FRAME_CAPTION_PROMPT` (Task 4).
- Produces: `createAvUnderstander(deps: AvUnderstanderDeps): LocalUnderstander`; `AV_SAMPLING_DISCLOSURE`; `FRAME_HEADING`; `TRANSCRIPT_HEADING`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/frames/av-understander.test.ts
import { describe, expect, test } from "bun:test";
import type { LocalUnderstander } from "../media-gate.ts";
import type { VlmProvider } from "../vlm/vlm-types.ts";
import {
  AV_SAMPLING_DISCLOSURE,
  FRAME_HEADING,
  TRANSCRIPT_HEADING,
  createAvUnderstander,
} from "./av-understander.ts";

function stt(text = "hello from the recording"): LocalUnderstander {
  return {
    isLocal: true,
    model: "whisper-cli",
    isAvailable: () => Promise.resolve(true),
    understand: () => Promise.resolve({ text }),
  };
}

function vlm(opts: { text?: string; fail?: boolean; isLocal?: boolean } = {}): VlmProvider {
  return {
    providerId: "ollama",
    isLocal: opts.isLocal ?? true,
    model: "qwen2.5vl:7b",
    isAvailable: () => Promise.resolve(true),
    describe: () =>
      opts.fail === true
        ? Promise.reject(new Error("vlm down"))
        : Promise.resolve({ text: opts.text ?? "a slide" }),
  };
}

function deps(over: Partial<Parameters<typeof createAvUnderstander>[0]> = {}) {
  return createAvUnderstander({
    stt: stt(),
    vlm: vlm(),
    maxFrames: 2,
    ffmpegBin: "ffmpeg",
    ffprobeBin: "ffprobe",
    probeDuration: () => Promise.resolve(90),
    extractFrame: () => Promise.resolve(new Uint8Array([0xff, 0xd8])),
    ...over,
  });
}

/** Every assertion below is on the body text; the counts are asserted separately. */
async function bodyOf(u: ReturnType<typeof createAvUnderstander>, p = "/v/clip.mp4"): Promise<string> {
  return (await u.understand(p)).text;
}

describe("createAvUnderstander", () => {
  test("captions come FIRST, then the transcript", async () => {
    const body = await bodyOf(deps());
    expect(body.indexOf(FRAME_HEADING)).toBeLessThan(body.indexOf(TRANSCRIPT_HEADING));
    expect(body).toContain("hello from the recording");
    expect(body).toContain("a slide");
  });

  test("the sampling disclosure is always present when any frame was captioned", async () => {
    expect(await bodyOf(deps())).toContain(AV_SAMPLING_DISCLOSURE);
  });

  test("each caption is timestamped so a reader can locate it in the video", async () => {
    const body = await bodyOf(deps());
    expect(body).toContain("[00:00:30]");
    expect(body).toContain("[00:01:00]");
  });

  test("the frame counts are RETURNED, not only rendered into prose", async () => {
    // The defect this pins: counts that exist only in the body never reach `item.metadata`,
    // because the gate builds `UnderstandOutcome` from what the understander returns.
    const detail = await deps().understand("/v/clip.mp4");
    expect(detail.framesSampled).toBe(2);
    expect(detail.framesCaptioned).toBe(2);
  });

  test("a video that never reached sampling reports NO counts, not zeros", async () => {
    const detail = await deps({ probeDuration: () => Promise.resolve(null) }).understand("/v/c.mp4");
    expect(detail.framesSampled).toBeUndefined();
    expect(detail.framesCaptioned).toBeUndefined();
  });

  test("sampled-but-all-failed reports 0 captioned, distinct from never-sampled", async () => {
    const detail = await deps({ vlm: vlm({ fail: true }) }).understand("/v/clip.mp4");
    expect(detail.framesSampled).toBe(2);
    expect(detail.framesCaptioned).toBe(0);
  });

  test("a silent video says so rather than rendering an empty transcript heading", async () => {
    const body = await bodyOf(deps({ stt: stt("") }));
    expect(body).toContain("(No speech detected.)");
    expect(body).toContain("a slide");
    expect(body).not.toMatch(/## Transcript\n\n\s*$/);
  });

  test("no speech AND no captions REJECTS — an all-disclosure body understands nothing", async () => {
    await expect(
      deps({ stt: stt(""), vlm: vlm({ fail: true }) }).understand("/v/silent.mp4"),
    ).rejects.toThrow(/no speech and no frame captions/);
  });

  test("model names BOTH contributors, so the derived row records what produced it", () => {
    expect(deps().model).toBe("whisper-cli+qwen2.5vl:7b");
  });

  test("isLocal is true only when BOTH legs are local (I34)", () => {
    expect(deps().isLocal).toBe(true);
    expect(deps({ vlm: vlm({ isLocal: false }) }).isLocal).toBe(false);
  });

  test("availability tracks the TRANSCRIPT leg — the video is still understandable without a VLM", async () => {
    const noVlm = deps({ vlm: { ...vlm(), isAvailable: () => Promise.resolve(false) } });
    expect(await noVlm.isAvailable()).toBe(true);
    const noStt = deps({ stt: { ...stt(), isAvailable: () => Promise.resolve(false) } });
    expect(await noStt.isAvailable()).toBe(false);
  });

  test("no VLM: transcript only, and the body says why there are no captions", async () => {
    const body = await bodyOf(deps({ vlm: { ...vlm(), isAvailable: () => Promise.resolve(false) } }));
    expect(body).toContain("hello from the recording");
    expect(body).not.toContain(FRAME_HEADING);
    expect(body).toMatch(/no vision model/i);
  });

  test("no duration (ffprobe missing): transcript only, with the reason stated", async () => {
    const body = await bodyOf(deps({ probeDuration: () => Promise.resolve(null) }), "/v/c.mp4");
    expect(body).toContain("hello from the recording");
    expect(body).toMatch(/duration could not be determined/i);
  });

  test("a per-frame failure NEVER aborts the artifact and is disclosed by count", async () => {
    let n = 0;
    const u = deps({
      extractFrame: () => {
        n += 1;
        return n === 1
          ? Promise.reject(new Error("bad frame"))
          : Promise.resolve(new Uint8Array([0xff]));
      },
    });
    const detail = await u.understand("/v/clip.mp4");
    expect(detail.text).toContain("hello from the recording");
    expect(detail.text).toContain("1 of 2");
    expect(detail.framesCaptioned).toBe(1);
  });

  test("every frame failing still yields the transcript, with the count disclosed", async () => {
    const body = await bodyOf(deps({ vlm: vlm({ fail: true }) }));
    expect(body).toContain("hello from the recording");
    expect(body).toContain("0 of 2");
  });

  test("a failing TRANSCRIPT rejects — the gate must record it, not paper over it with captions", async () => {
    const bad = deps({
      stt: { ...stt(), understand: () => Promise.reject(new Error("whisper died")) },
    });
    await expect(bad.understand("/v/clip.mp4")).rejects.toThrow(/whisper died/);
  });

  test("frame captions carry their own egressMethod", async () => {
    const seen: (string | undefined)[] = [];
    await deps({
      vlm: {
        ...vlm(),
        describe: (input) => {
          seen.push(input.egressMethod);
          return Promise.resolve({ text: "a slide" });
        },
      },
    }).understand("/v/clip.mp4");
    expect(seen).toEqual(["multimodal.vlm.frame", "multimodal.vlm.frame"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/frames/av-understander.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the composite**

```ts
// packages/gateway/src/multimodal/frames/av-understander.ts
/**
 * Transcript + sampled frame captions, as ONE `LocalUnderstander` (spec § 8, § 12.8).
 *
 * WHY THE TRANSCRIPT IS LOAD-BEARING AND THE CAPTIONS ARE NOT. A video with no transcript is a
 * failed artifact — the gate records `transcribe_failed` and a re-run retries it. A video with a
 * transcript and no captions is a PARTIAL success worth storing, so every caption failure degrades
 * rather than aborts: a missing ffprobe, an unavailable VLM, a corrupt frame, a model error. Each
 * degradation states its reason IN THE BODY, because the body is what reaches an agent's context;
 * a count kept only in metadata would not travel with the text a brief quotes.
 *
 * WHY CAPTIONS COME FIRST. `bodyCapForItemType` clamps `video_understanding` at `BODY_MAX_PROSE`
 * (16,384) and `item-store.ts` sets `body_complete = 0` when it bites. Captions first means a long
 * transcript loses its tail — already disclosed by that flag — rather than the captions silently
 * vanishing from a body that still claims to have them.
 *
 * WHY ONE GPU LEASE COVERS ALL OF THIS. `understandArtifact` takes one `GpuArbiter` lease per
 * artifact with a heartbeat, and the heartbeat — not the lease's narrowness — is what defuses the
 * idle-eviction hazard (spec § 8.1). Re-acquiring per frame would add a queue round-trip per frame
 * and let another caller take the GPU mid-artifact, leaving a half-captioned video that nothing
 * records as partial.
 */
import type { LocalUnderstander } from "../media-gate.ts";
import type { UnderstandDetail } from "../media-types.ts";
import { FRAME_CAPTION_PROMPT } from "../vlm/caption-prompts.ts";
import type { VlmProvider } from "../vlm/vlm-types.ts";
import { extractFrameJpeg, frameTimestamps, probeDurationSeconds } from "./frame-extract.ts";

export const FRAME_HEADING = "## Frames (sampled)";
export const TRANSCRIPT_HEADING = "## Transcript";

/**
 * Spec § 12.8: a sampled video is not a watched video. This sentence is why a brief quoting a
 * caption cannot present it as a description of the whole video.
 */
export const AV_SAMPLING_DISCLOSURE =
  "Frames were sampled at uniform intervals, not watched: anything occurring only between sampled frames is not described here.";

export interface AvUnderstanderDeps {
  readonly stt: LocalUnderstander;
  readonly vlm: VlmProvider;
  readonly maxFrames: number;
  readonly ffmpegBin: string;
  readonly ffprobeBin: string;
  /** Injected for tests; production passes the real `frame-extract.ts` functions. */
  readonly probeDuration?: (input: string) => Promise<number | null>;
  readonly extractFrame?: (input: string, atSeconds: number) => Promise<Uint8Array>;
}

function hhmmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export function createAvUnderstander(deps: AvUnderstanderDeps): LocalUnderstander {
  const probe =
    deps.probeDuration ??
    ((input: string) => probeDurationSeconds(input, { ffprobeBin: deps.ffprobeBin }));
  const grab =
    deps.extractFrame ??
    ((input: string, at: number) => extractFrameJpeg(input, at, { ffmpegBin: deps.ffmpegBin }));

  return {
    /**
     * Both legs must be local for the artifact to be local. The gate reads this to decide whether
     * a per-artifact remote grant is required (spec § 3.4 step 3): if EITHER leg would reach a
     * remote model, the artifact is not a local understanding and must not be treated as one.
     */
    get isLocal(): boolean {
      return deps.stt.isLocal && deps.vlm.isLocal;
    },
    model: `${deps.stt.model}+${deps.vlm.model}`,

    /**
     * Tracks the TRANSCRIPT leg only. A machine with whisper and no VLM can still understand a
     * video usefully; refusing the artifact outright would throw away the transcript to avoid
     * missing captions.
     */
    isAvailable: () => deps.stt.isAvailable(),

    async understand(path: string): Promise<UnderstandDetail> {
      // A throw here propagates: the gate records `transcribe_failed` and a re-run retries this
      // artifact. Swallowing it and shipping captions alone would store a `video_understanding`
      // row whose transcript is silently absent.
      const transcript = (await deps.stt.understand(path)).text.trim();

      const sections: string[] = [];
      const notes: string[] = [];
      let sampled = 0;
      let captioned = 0;

      if (!(await deps.vlm.isAvailable())) {
        notes.push(
          "Frame captions are absent: no vision model was available on this machine when the pass ran.",
        );
      } else {
        const duration = await probe(path);
        if (duration === null) {
          notes.push(
            "Frame captions are absent: the video duration could not be determined, so frames could not be sampled.",
          );
        } else {
          const stamps = frameTimestamps(duration, deps.maxFrames);
          const captions: string[] = [];
          for (const at of stamps) {
            try {
              const bytes = await grab(path, at);
              const { text } = await deps.vlm.describe({
                bytes,
                prompt: FRAME_CAPTION_PROMPT,
                egressMethod: "multimodal.vlm.frame",
              });
              const caption = text.trim();
              if (caption !== "") {
                captions.push(`[${hhmmss(at)}] ${caption}`);
              }
            } catch {
              // Per-frame failure degrades this frame only. The count below is the disclosure;
              // a silent skip would leave a body claiming completeness it does not have.
            }
          }
          sampled = stamps.length;
          captioned = captions.length;
          if (captions.length > 0) {
            sections.push(`${FRAME_HEADING}\n\n${captions.join("\n\n")}`);
          }
          notes.push(
            `${captions.length} of ${stamps.length} sampled frames captioned. ${AV_SAMPLING_DISCLOSURE}`,
          );
        }
      }

      // A video with no audio track, or only silence, transcribes to "". That is a legitimate
      // artifact — a screen capture with eight good frame captions is worth storing — but the
      // section must SAY so rather than render an empty heading that reads as a lost transcript.
      if (transcript === "" && captioned === 0) {
        // Nothing was understood at all: no speech and no caption. Writing a row here would be a
        // `video_understanding` item whose entire body is an apology. Throw instead, so the gate
        // records `transcribe_failed`, the pass discloses it by reason, and a re-run retries it
        // once a vision model or a working probe exists.
        throw new Error(`no speech and no frame captions for ${path}`);
      }

      if (notes.length > 0) {
        sections.push(notes.join("\n\n"));
      }
      sections.push(
        `${TRANSCRIPT_HEADING}\n\n${transcript === "" ? "(No speech detected.)" : transcript}`,
      );

      return {
        text: sections.join("\n\n"),
        // Reported only when sampling actually happened, so "never sampled" and "sampled, all
        // failed" stay distinguishable on the row (see `UnderstandDetail`).
        ...(sampled === 0 ? {} : { framesSampled: sampled, framesCaptioned: captioned }),
      };
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/src/multimodal/frames/av-understander.test.ts`
Expected: PASS (17 tests).

> The `1 of 2` / `0 of 2` assertions require the note to be emitted even when no caption survived — that is why `notes.push` sits outside the `captions.length > 0` guard. If those two tests fail, that is the line to look at.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/frames/av-understander.ts \
        packages/gateway/src/multimodal/frames/av-understander.test.ts
git commit -m "feat(multimodal): caption sampled frames alongside the transcript"
```

---

## Task 7: Version bump, sampling metadata, and the production wiring

**Files:**
- Modify: `packages/gateway/src/multimodal/media-types.ts`, `packages/gateway/src/multimodal/understanding-item.ts`, `packages/gateway/src/multimodal/understanding-item.test.ts`, `packages/gateway/src/multimodal/build-media-pass-deps.ts`, `packages/gateway/src/multimodal/build-media-pass-deps.test.ts`, `packages/gateway/src/multimodal/media-discovery.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `UNDERSTANDING_VERSION = 2`; `MULTIMODAL_CAPABILITY = "multimodal_input"`; `BuildMediaPassDepsInput` gains `vlmBaseUrl?`, `vlmModel?`, `maxFrames?`, `ffprobeBin?`, `vlmFetch?`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/multimodal/build-media-pass-deps.test.ts`:

**REPLACE** the existing `"supplies an AV understander and none for image — PR 1 has no VLM"` test — its `expect(deps.gate.understanderFor("image")).toBeUndefined()` assertion inverts in this task, so it must be rewritten, not merely renamed by Task 4's rename sweep. The local helper is `db()`, and `CURRENT_SCHEMA_VERSION` / `runIndexedSchemaMigrations` are already imported in that file:

```ts
test("understanderFor resolves BOTH modalities now that a VLM exists", () => {
  const deps = buildMediaPassDeps({
    db: db(),
    roots: [],
    enabled: true,
    capabilityDisabled: false,
    scratchDir: "/scratch",
  });
  expect(deps.gate.understanderFor("av")).toBeDefined();
  expect(deps.gate.understanderFor("image")).toBeDefined();
});

test("the image understander is the LEDGERED provider, not a bare one", () => {
  // A loopback default makes the wrapper an identity, so this asserts the WIRING is present
  // rather than the row: D22(g) is what proves the wrap cannot be dropped.
  const src = readFileSync("packages/gateway/src/multimodal/build-media-pass-deps.ts", "utf8");
  const wrapAt = src.indexOf("wrapLedgeredVlm(");
  const ctorAt = src.indexOf("createOllamaVlm(");
  expect(wrapAt).toBeGreaterThan(-1);
  // The constructor call is textually INSIDE the wrapper's argument list.
  expect(ctorAt).toBeGreaterThan(wrapAt);
});
```

Add to `packages/gateway/src/multimodal/understanding-item.test.ts`. That file's fixtures are the module-level consts `CANDIDATE` (an `av` candidate) and `OUTCOME` — use those, and derive the image case from `CANDIDATE`. Also **update the existing assertion that expects `understandingVersion` to be `1`** (near line 68); do not leave two tests disagreeing:

```ts
test("understandingVersion is 2, so PR 1 rows are re-offered for captioning", () => {
  const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 1_700_000_000_000);
  expect(row.metadata["understandingVersion"]).toBe(2);
});

test("frame sampling is recorded in metadata when the outcome carries it", () => {
  const row = buildUnderstandingRow(
    CANDIDATE,
    { ...OUTCOME, framesSampled: 8, framesCaptioned: 6 },
    1_700_000_000_000,
  );
  expect(row.metadata["framesSampled"]).toBe(8);
  expect(row.metadata["framesCaptioned"]).toBe(6);
});

test("an outcome with no frame data omits the keys rather than writing zeros", () => {
  const image: MediaCandidate = { ...CANDIDATE, modality: "image", type: "media_image" };
  const row = buildUnderstandingRow(image, OUTCOME, 1_700_000_000_000);
  expect(row.type).toBe("image_understanding");
  // A zero would be indistinguishable from a video whose every frame failed.
  expect("framesSampled" in row.metadata).toBe(false);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/multimodal`
Expected: FAIL — `understanderFor` undefined for `"image"`, `understandingVersion` is 1, `framesSampled` missing.

- [ ] **Step 3: Bump the version and add the capability constant**

In `media-types.ts`:

```ts
/**
 * Bumped when a better model or a changed prompt means existing understanding should be redone.
 *
 * V2 (PR 2): `video_understanding` now carries sampled frame captions alongside the transcript,
 * and `image_understanding` rows exist for the first time. `media-discovery.ts` re-offers any row
 * below this number, so the bump is what makes a PR 1 transcript gain captions on the next pass.
 *
 * It lives in item METADATA and never in an `externalId`: `item` is UNIQUE(service, external_id),
 * so a version in the id would create a second row per artifact per version rather than replacing
 * the first — duplicate FTS hits and duplicate agent context (spec § 4.1).
 */
export const UNDERSTANDING_VERSION = 2;

/**
 * The `AI_V2_CAPABILITIES` member (`policy/types.ts`) an org policy disables to turn this
 * capability off gateway-wide (invariant I22). Exported so a test can pin it against that frozen
 * list rather than repeating the string — a typo here would read as "never disabled".
 */
export const MULTIMODAL_CAPABILITY = "multimodal_input";
```

`UnderstandOutcome`'s two optional count fields already landed in **Task 4 Step 5(b)**, along with the gate code that populates them — nothing to add here. This step is the version bump and the capability constant only.

- [ ] **Step 4: Carry the counts onto the row**

In `understanding-item.ts`'s `buildUnderstandingRow`, add to the `metadata` object:

```ts
      // Conditional spread, not `?? 0`: writing a zero for an artifact that never reached sampling
      // would be indistinguishable from one whose every frame failed.
      ...(outcome.framesSampled === undefined ? {} : { framesSampled: outcome.framesSampled }),
      ...(outcome.framesCaptioned === undefined ? {} : { framesCaptioned: outcome.framesCaptioned }),
```

- [ ] **Step 5: Wire the production deps**

In `build-media-pass-deps.ts`:

```ts
// with the other imports
import { wrapLedgeredVlm } from "../egress/vlm-egress.ts";
import { createAvUnderstander } from "./frames/av-understander.ts";
import { resolveFfprobeBin } from "./frames/frame-extract.ts";
import { DEFAULT_MAX_FRAMES, DEFAULT_VLM_BASE_URL, DEFAULT_VLM_MODEL } from "./multimodal-config.ts";
import { createImageUnderstander } from "./vlm/image-understander.ts";
import { createOllamaVlm } from "./vlm/ollama-vlm.ts";
```

Add to `BuildMediaPassDepsInput`:

```ts
  readonly vlmBaseUrl?: string;
  readonly vlmModel?: string;
  readonly maxFrames?: number;
  readonly ffprobeBin?: string;
  /** Injected only by tests; production uses the global `fetch`. */
  readonly vlmFetch?: typeof fetch;
```

And in `buildMediaPassDeps`, after the `stt` construction:

```ts
  // THE ONLY production site that may name `createOllamaVlm` or `wrapLedgeredVlm` (static rule
  // D22(g)). The constructor sits INSIDE the wrapper's argument list so an unwrapped provider is
  // not representable here: the audit checks that association, not merely that both names appear.
  const vlm = wrapLedgeredVlm(
    input.db,
    createOllamaVlm({
      baseUrl: input.vlmBaseUrl ?? DEFAULT_VLM_BASE_URL,
      model: input.vlmModel ?? DEFAULT_VLM_MODEL,
      ...(input.vlmFetch === undefined ? {} : { fetchImpl: input.vlmFetch }),
    }),
  );

  const imageUnderstander = createImageUnderstander({ vlm });
  const avUnderstander = createAvUnderstander({
    stt,
    vlm,
    maxFrames: input.maxFrames ?? DEFAULT_MAX_FRAMES,
    ffmpegBin: resolveFfmpegBin(input.ffmpegBin),
    ffprobeBin: resolveFfprobeBin(input.ffprobeBin),
  });
```

Then replace the gate's resolver:

```ts
      understanderFor: (modality: MediaModality): LocalUnderstander | undefined =>
        modality === "av" ? avUnderstander : imageUnderstander,
```

> `MediaModality` is `"image" | "av"` and total, so the ternary covers it. Do NOT widen this to a default arm — an unresolvable modality must reach the gate as `undefined` and be skipped with a reason, never handed to the wrong model.

- [ ] **Step 6: Fix the version-sensitive existing tests**

`media-discovery.test.ts` sets `understandingVersion` to `0` to force a re-offer, which still works. Run the suite and update any assertion that hardcoded `1`:

```bash
bun test packages/gateway/src/multimodal
grep -rn "understandingVersion" packages/gateway/src packages/cli/src
```

- [ ] **Step 7: Run the gates**

```bash
bun test packages/gateway/src/multimodal packages/gateway/src/egress
bun run audit:invariants
bun run typecheck
```
Expected: green, including D22(g) — which now has a real production site to approve.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/multimodal/
git commit -m "feat(multimodal): wire the vision arm into the pass and bump to understanding v2"
```

---

## Task 8: Make the org-policy lockoff real

`multimodal_input` is a real `AI_V2_CAPABILITIES` member, the gate already honours a `capabilityDisabled` boolean, and the dispatcher hardcodes it `false` — so an org policy disabling this capability currently does nothing. `code_execution` and `computer_use` each get a live `enforced` getter wired at boot; this gives media the same, and fails CLOSED when the accessor is absent rather than defaulting to permissive.

**Files:**
- Modify: `packages/gateway/src/ipc/media-rpc.ts`, `packages/gateway/src/ipc/server/options.ts`, `packages/gateway/src/ipc/server/dispatchers.ts`, `packages/gateway/src/platform/assemble.ts`
- Test: `packages/gateway/src/multimodal/media-policy-wiring.test.ts` (create), `packages/gateway/src/security-invariants.test.ts` (modify)

**Interfaces:**
- Consumes: `EnforcedPolicy` from `../policy/policy-gate.ts`; `MULTIMODAL_CAPABILITY` (Task 7).
- Produces: `interface MediaRpcCtx { readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/media-policy-wiring.test.ts
import { describe, expect, test } from "bun:test";
import { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { MULTIMODAL_CAPABILITY } from "./media-types.ts";

describe("multimodal org-policy lockoff", () => {
  test("the capability name is a real AI_V2_CAPABILITIES member", () => {
    expect([...AI_V2_CAPABILITIES]).toContain(MULTIMODAL_CAPABILITY);
  });

  test("the dispatcher no longer hardcodes capabilityDisabled false", async () => {
    const src = await Bun.file("packages/gateway/src/ipc/server/dispatchers.ts").text();
    const at = src.indexOf("tryDispatchMediaRpc");
    const body = src.slice(at, at + 2500);
    expect(body).not.toContain("capabilityDisabled: false");
    expect(body).toContain("capabilitiesDisabled.has(MULTIMODAL_CAPABILITY)");
  });

  test("an absent accessor FAILS CLOSED rather than defaulting to permissive", async () => {
    const src = await Bun.file("packages/gateway/src/ipc/server/dispatchers.ts").text();
    const at = src.indexOf("tryDispatchMediaRpc");
    const body = src.slice(at, at + 2500);
    // A `?? false` on an injected policy dep is silent: it would restore the inert state this
    // task exists to remove, and no test would notice.
    expect(body).not.toMatch(/mediaRpcCtx[^\n]*\?\?\s*false/);
    expect(body).toContain("requires mediaRpcCtx");
  });

  test("boot wires a LIVE getter, so a policy installed after boot tightens the next pass", async () => {
    const src = await Bun.file("packages/gateway/src/platform/assemble.ts").text();
    const at = src.indexOf("ipcOpts.mediaRpcCtx");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toContain("get enforced()");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/media-policy-wiring.test.ts`
Expected: FAIL — the dispatcher still contains `capabilityDisabled: false` and `assemble.ts` has no `mediaRpcCtx`.

- [ ] **Step 3: Declare `MediaRpcCtx`**

In `packages/gateway/src/ipc/media-rpc.ts`:

```ts
import type { EnforcedPolicy } from "../policy/policy-gate.ts";

/**
 * The boot-assembled seam behind `media.understand`.
 *
 * `enforced` is the live org-policy accessor (invariant I22), matching `ExecGateDeps.enforced` and
 * `CuGateDeps.enforced`. It is a GETTER at the wiring site rather than a snapshot, so a policy
 * installed after boot tightens the next pass rather than the next restart.
 *
 * REQUIRED, not optional-with-a-default. `media.understand` refuses when this ctx is absent: a
 * `?? false` fallback would silently restore the state where an org policy disabling
 * `multimodal_input` did nothing, and nothing in the suite would go red. Same reasoning as
 * `MediaGateDeps.gpu.touch` being required rather than defaulted.
 */
export interface MediaRpcCtx {
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
}
```

- [ ] **Step 4: Add it to the options**

In `packages/gateway/src/ipc/server/options.ts`, beside `computerRpcCtx`:

```ts
  // Multimodal I/O (S2). The boot-assembled org-policy accessor behind media.understand. Present
  // only when assembled at boot; the dispatcher REFUSES rather than skipping when unset, because a
  // permissive default is exactly the inert state this seam exists to remove. The whole namespace
  // is LAN-forbidden (I5) and absent from the Tauri allowlist (I7) — it reads local files and
  // spawns subprocesses, the exec.* posture.
  mediaRpcCtx?: MediaRpcCtx;
```

Add `MediaRpcCtx` to the existing `import type { … } from "../media-rpc.ts"` group.

- [ ] **Step 5: Read the real value in the dispatcher**

In `dispatchers.ts`, replace the hardcoded line and rewrite the stale half of the doc comment:

```ts
/**
 * … (keep the first paragraph) …
 *
 * `roots`, `enabled` and `capabilityDisabled` are all re-read on every call, so a
 * `[[filesystem.roots]]` edit, a `[multimodal]` edit, or a newly installed org policy applies
 * without a gateway restart. The org-policy half reads `ctx.options.mediaRpcCtx.enforced`
 * (invariant I22) — the same live accessor `code_execution` and `computer_use` use. When that ctx
 * is absent the method REFUSES: defaulting to `false` is what made this capability's policy
 * lockoff inert through PR 1.
 */
```

```ts
  const mediaCtx = ctx.options.mediaRpcCtx;
  if (mediaCtx === undefined) {
    throw new RpcMethodError(
      -32603,
      "media.understand requires mediaRpcCtx (the org-policy accessor)",
    );
  }
  const deps = buildMediaPassDeps({
    db: ctx.options.localIndex.getDatabase(),
    roots: resolveMediaRoots(ctx.options.configDir),
    enabled: mmConfig.enabled,
    capabilityDisabled: mediaCtx.enforced.capabilitiesDisabled.has(MULTIMODAL_CAPABILITY),
    scratchDir: join(ctx.options.dataDir, "multimodal-scratch"),
    vlmBaseUrl: mmConfig.vlmBaseUrl,
    vlmModel: mmConfig.vlmModel,
    maxFrames: mmConfig.maxFrames,
  });
```

…with `const mmConfig = loadMultimodalConfig(ctx.options.configDir);` above it. Update the imports: add `loadMultimodalConfig` from `../../multimodal/multimodal-config.ts` and `MULTIMODAL_CAPABILITY` from `../../multimodal/media-types.ts`, and drop `resolveMultimodalEnabled`.

- [ ] **Step 6: Delete the transitional re-export**

Remove `resolveMultimodalEnabled` from `build-media-pass-deps.ts` (Task 1 Step 4 marked it for deletion) and update any test that imported it to call `loadMultimodalConfig(...).enabled`.

```bash
grep -rn "resolveMultimodalEnabled" packages/
```
Expected: no matches.

- [ ] **Step 7: Wire boot**

In `platform/assemble.ts`, immediately after the `ipcOpts.computerRpcCtx = { … }` block:

```ts
  // Multimodal I/O (S2). Only the org-policy accessor: the local `[multimodal] enabled` switch and
  // the roots are re-read per call in the dispatcher. LAZY through `policyGate.enforced()` rather
  // than snapshotted, so a policy installed after boot tightens the next pass rather than the next
  // restart — the same shape as execRpcCtx and computerRpcCtx above.
  ipcOpts.mediaRpcCtx = {
    get enforced() {
      return policyGate.enforced();
    },
  };
```

- [ ] **Step 8: Add the invariant test**

In `security-invariants.test.ts`, inside the I22 describe block:

```ts
  test("I22: multimodal_input is enforced, not merely listed", async () => {
    // Through PR 1 this capability was a real AI_V2_CAPABILITIES member whose lockoff did
    // nothing, because the dispatcher hardcoded `capabilityDisabled: false`. All five members
    // must now reach a gate.
    const dispatchers = await Bun.file("packages/gateway/src/ipc/server/dispatchers.ts").text();
    expect(dispatchers).toContain("capabilitiesDisabled.has(MULTIMODAL_CAPABILITY)");
    const assemble = await Bun.file("packages/gateway/src/platform/assemble.ts").text();
    expect(assemble).toContain("ipcOpts.mediaRpcCtx");
  });
```

- [ ] **Step 9: Update the dispatcher test fixture that this fail-closed change breaks**

`packages/gateway/src/ipc/server/dispatchers.test.ts` (~line 1115) has `"media.understand hit through chain (returns a MediaPassSummary, not a skip)"`, which builds its context with `makeCtx({ localIndex, dataDir })` — no `mediaRpcCtx` — and asserts a real summary comes back. Step 5's refusal breaks it. Supply the ctx rather than weakening the refusal; the test's purpose (proving the `PHASE4_PLATFORM_DISPATCHERS` entry exists, so deleting it doesn't silently return `phase4RpcSkipped`) is preserved either way:

```ts
    const { ctx } = makeCtx({
      localIndex,
      dataDir,
      // An EMPTY disabled set — the capability is permitted, and the pass still returns an empty
      // summary because `[multimodal] enabled` is false in this fixture. Supplying the accessor is
      // the point: without it the dispatcher now refuses, which is the intended fail-closed shape.
      mediaRpcCtx: { enforced: { capabilitiesDisabled: new Set<string>() } },
    });
```

Then sweep for any other construction site that reaches `media.understand`:

```bash
grep -rn "media.understand" packages/gateway packages/cli --include=*.ts | grep -v "src/multimodal\|src/ipc/media-rpc"
```
Add the ctx to each; never reintroduce a permissive default to make a fixture pass.

- [ ] **Step 10: Run the gates**

```bash
bun test packages/gateway/src/multimodal packages/gateway/src/ipc packages/gateway/src/security-invariants.test.ts
bun run typecheck
bun run preflight:fast
```
Expected: green. If an e2e or integration test constructs server options without `mediaRpcCtx` and calls `media.understand`, it now gets an explicit refusal — add the ctx to that fixture rather than reintroducing a permissive default.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/src/ipc/ packages/gateway/src/platform/assemble.ts \
        packages/gateway/src/multimodal/ packages/gateway/src/security-invariants.test.ts
git commit -m "fix(multimodal): honour an org policy disabling multimodal_input"
```

---

## Task 9: Docs, the spec amendment, and the real-model integration test

Docs are part of the change, not a follow-up: the triple rule is wiring + docs + test in the same commit.

**Files:**
- Create: `packages/gateway/test/integration/multimodal/vlm-live.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/roadmap.md`, `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`

- [ ] **Step 1: Write the skip-gated live test**

No CI runner has Ollama or a VLM (spec § 11.3), so this never runs there — and it never runs on a Windows dev box either unless the developer deliberately starts Ollama. It exists so the wire is exercised at least once by something other than a fake, which is the only thing that catches a contract mismatch between our request shape and Ollama's.

```ts
// packages/gateway/test/integration/multimodal/vlm-live.test.ts
/**
 * Exercised only when a real Ollama with a vision model is reachable. Fakes prove the ENDS
 * (our adapter, and a stand-in daemon); only this proves the WIRE — that `/api/show`'s
 * `capabilities` field and `/api/generate`'s `images` array are shaped the way `ollama-vlm.ts`
 * assumes. Set NIMBUS_TEST_VLM=1 to opt in.
 */
import { describe, expect, test } from "bun:test";
import { createOllamaVlm } from "../../../src/multimodal/vlm/ollama-vlm.ts";

const OPTED_IN = process.env["NIMBUS_TEST_VLM"] === "1";

describe.skipIf(!OPTED_IN)("Ollama VLM (live)", () => {
  test("a real daemon reports the vision capability and captions a 1x1 PNG", async () => {
    const vlm = createOllamaVlm({});
    expect(await vlm.isAvailable()).toBe(true);
    // Smallest valid PNG: a single white pixel.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const { text } = await vlm.describe({
      bytes: new Uint8Array(png),
      prompt: "Describe this image in one sentence.",
    });
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
```

- [ ] **Step 2: Confirm it SKIPS by default and passes when opted in**

```bash
bun test packages/gateway/test/integration/multimodal/vlm-live.test.ts
# Expected: 0 pass, tests skipped.

# Only if Ollama is running locally with a vision model pulled:
NIMBUS_TEST_VLM=1 bun test packages/gateway/test/integration/multimodal/vlm-live.test.ts
```

> Do NOT report this task complete on the skipped run alone. Either run it opted-in against a real daemon, or say plainly in the PR body that the live wire was never exercised. A skipped test is not evidence.

- [ ] **Step 3: Amend the spec**

Add a `## 15. Amendments (PR 2, 2026-09-03)` section to `docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md` recording all six decisions from this plan's *Decisions* section, each with its reason. Then correct the spec's own text in place:

- § 9.2 — `isAvailable()` probes `/api/show` for `capabilities`, with a `families` fallback for legacy daemons; it does not name-match over `/api/tags`.
- § 8 — the GPU lease is per ARTIFACT with a heartbeat, not per frame; § 8.1's heartbeat argument is what makes that safe, and per-frame re-acquisition is rejected for leaving a half-captioned video unrecorded.
- § 5.4 — frame bytes are never written to disk; the audio transcode's single 0600 WAV remains the only file written.
- § 10 — D27(a) as worded (confining `describeBytes` / `transcribeBytes`) does not match what shipped: model contact is `VlmProvider.describe`, reached through the D22(g)-confined decorator. PR 4 must write D27(a) against that shape, or it will enforce nothing.
- § 12.1 — Phase 14 Core acceptance is met at PR 2, and note that frame captions are present only when a vision model AND a duration probe are both available; a machine with neither still gets a transcript, with the absence stated in the body.

- [ ] **Step 4: Update `docs/SECURITY-INVARIANTS.md`**

Extend I29's D22 rule list to SEVEN rules with `(g)`: `wrapLedgeredVlm` confined to `egress/vlm-egress.ts` + `multimodal/build-media-pass-deps.ts`, and `createOllamaVlm` confined to its own definition + that one construction site — the constructor half being what catches a new site that never mentions the decorator. State plainly that the `model` class still carries no named exclusions, and that a LOCAL VLM appends nothing (derived from `provider.isLocal`, I34) for the same reason a local embedder does. Note that no new coverage class is added: vision rides the existing `model` class.

- [ ] **Step 5: Update `CLAUDE.md` and `GEMINI.md`**

Both files, identically:
- The I29 entry: D22 now has SEVEN rules; add the vision appender to the `model`-class appender enumeration (there are now four: provider, Mastra model, embedder, VLM). **Re-derive the enumeration; do not just change a count.**
- The § Status paragraph's multimodal sentence: PR 2 of 4 shipped 2026-09-03 — image understanding via a local Ollama VLM, sampled frame captions, Phase 14 Core acceptance now MET. Remove the "no VLM / image candidates are skipped" claim and the "`nimbus:image_understanding` is registered but nothing writes one" claim; both are now false.
- The "org policy is INERT here" sentence must GO, replaced by the wired state. This is the specific line that becomes a false attestation the moment Task 8 lands.
- Invariant ceiling stays I36 and the schema stays V58 — PR 2 adds neither. Do not bump either.

- [ ] **Step 6: Update `docs/roadmap.md`**

In § Active's multimodal row: mark PR 2 shipped, restate what PR 3 and PR 4 still carry, and state the bounds honestly — OCR quality is the VLM's (§ 12.10), a sampled video is not a watched video (§ 12.8), a caption is a guess (§ 12.3), and frame captions need both a vision model and a working duration probe. Record that the org-policy lockoff is now real. Keep §§ 12.2 and 12.7 (no diarization, no remote STT at any tier) exactly as they are — PR 2 changes neither.

- [ ] **Step 7: Update `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`**

- architecture: the `multimodal/vlm/` and `multimodal/frames/` directories, the `VlmProvider` seam and why it is not an `LlmProvider`, and the four `[multimodal]` config keys.
- cli-reference: `nimbus media understand` now captions images and video frames; document `vlm_base_url`, `vlm_model`, `max_frames`, and the `NIMBUS_FFPROBE_PATH` override. Say that a vision model must be pulled by the user — nothing here downloads one.
- CHANGELOG: a dated entry under the current unreleased heading.

- [ ] **Step 8: Run the doc gates**

```bash
bun run audit:doc-refs
bun run audit:status-drift
bun run preflight:fast
```
Expected: green. `audit:doc-refs` resolves every path cited in `docs/` and `.claude/commands/`, so a wrong path in the spec amendment fails here rather than rotting.

- [ ] **Step 9: Full preflight**

```bash
bun run preflight
```
Expected: green. If the coverage floor flags a new file, remember it is CI-Linux-authoritative — reproduce with `bun run verify:docker --changed` rather than trusting a Windows run.

- [ ] **Step 10: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md packages/gateway/test/integration/multimodal/
git commit -m "docs(multimodal): record PR 2 — vision arm, D22(g), and the spec amendments"
```

---

## Verification Before Claiming Completion

Do not report this plan complete on a green scoped run. Run and paste the output of:

```bash
bun run preflight
bun run audit:invariants
bun test packages/gateway packages/cli scripts
```

That last command is the whole-repo, one-process shape the push matrix uses — `mock.module` is process-global, so a per-package run does not have the same mocks in play and can be green where the push leg is red. Two known local traps in this worktree: three exec/sandbox tests fail without the git-ignored `nimbus-sandbox-helper` build (compare the built `.exe`, not the runner), and `typecheck:tests` is advisory on Windows with a Linux-authoritative baseline.

State explicitly in the PR body:
- whether the live VLM test was ever run opted-in, or only skipped;
- that D22(g) was red-proved by reverting (Task 3 Step 7), with the failing output;
- that Phase 14 Core acceptance is met, and on what evidence — a real `video_understanding` row carrying both a transcript and at least one frame caption, not a fixture.

## PR Title

`feat(multimodal): image understanding and sampled frame captions (S2 PR 2 of 4)`

Not breaking. Nothing an existing user must change: the capability is default-off, `[multimodal]`'s new keys all have defaults, and the `understandingVersion` bump re-runs a pass that is off unless opted into. The squash commit is built from the PR title and description, so the reasoning belongs in the description.
