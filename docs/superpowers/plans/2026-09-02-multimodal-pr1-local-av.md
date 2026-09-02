# Multimodal PR 1 — Local Audio/Video Understanding: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe local audio/video files under `[[filesystem.roots]]` and index the transcripts as searchable derived items, driven by a resumable, owner-invoked `nimbus media understand` command.

**Architecture:** A discovery step finds media items in the index that lack current understanding. `media-gate.ts` is the single chokepoint from bytes to a model — it ships in this PR with only its local arm, so PR 4 adds an arm rather than retrofitting a gate. Transcription reuses the existing `WhisperSttProvider` behind a long-form wrapper, transcoding via ffmpeg to a 0600 scratch file deleted in a `finally`. Output is written as a `nimbus:video_understanding` derived item via `upsertIndexedItem` (not the sync wrapper), registered in `LOCAL_ONLY_PROSE_TYPES` so its text is never embedded remotely.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict, `bun:sqlite`, Biome, `bun test`. External binaries: `ffmpeg`, `whisper-cli` (both spawned, never linked).

**Spec:** [`docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`](../specs/2026-09-02-s2-multimodal-io-design.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **No plaintext credentials.** Nothing in this PR touches the Vault; if that changes, Vault-only.
- **Platform equality.** Windows/macOS/Linux equally supported. Build paths with `path.join()` / `os.tmpdir()`, never hardcoded separators. `bun run audit:cross-platform` flags Windows-separator assertions.
- **No new outbound network traffic in this PR.** Local files only; no cloud fetch, no remote model. The pass must append **zero** `egress_ledger` rows.
- **STT is local-only** in this and all four PRs. There is no remote STT provider, no `wrapLedgeredStt`.
- **Derived types go in `LOCAL_ONLY_PROSE_TYPES`, never `PROSE_HEAVY_TYPES`.** Membership is the whole enforcement; the two sets must stay disjoint (`routing.test.ts` pins this).
- **`understandingVersion` is NEVER part of an `externalId`.** `item` is `UNIQUE(service, external_id)`; a version in the id accumulates stale rows instead of replacing them.
- **Prefer dependency injection over `mock.module`.** `mock.module` is process-global and leaks across the combined `bun test packages/cli/src` run on CI Linux.
- **Before pushing:** `bun run preflight:fast`. Fix failures locally; never present work with a failing gate.
- **Branch:** never commit on `main`. Work on `dev/<you>/<topic>`.

---

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `packages/gateway/src/index/media-pass-v58-sql.ts` | V58 DDL: `media_pass_cursor` |
| `packages/gateway/src/multimodal/media-types.ts` | Shared types: `MediaModality`, `MediaCandidate`, `UnderstandOutcome`, `SkipReason` |
| `packages/gateway/src/multimodal/media-source-registry.ts` | SSoT mapping `(service, type)` → modality; media extension allow-list |
| `packages/gateway/src/multimodal/media-discovery.ts` | Selects candidates needing understanding |
| `packages/gateway/src/multimodal/media-bytes.ts` | Resolves a candidate to a readable local path; validates against live roots |
| `packages/gateway/src/multimodal/stt/ffmpeg-bin.ts` | `resolveFfmpegBin` + transcode to 16 kHz PCM WAV scratch file |
| `packages/gateway/src/multimodal/stt/long-form-stt.ts` | Wraps `WhisperSttProvider` for file-length input |
| `packages/gateway/src/multimodal/media-gate.ts` | **The chokepoint.** Ordered refusals, then the model call |
| `packages/gateway/src/multimodal/understanding-item.ts` | Pure mapper: outcome → derived item row; the upsert |
| `packages/gateway/src/multimodal/media-pass-state.ts` | V58 cursor read/write |
| `packages/gateway/src/multimodal/media-pass.ts` | Budgeted, resumable orchestration + summary |
| `packages/gateway/src/ipc/media-rpc.ts` | `media.understand` dispatcher |
| `packages/cli/src/commands/media-cmd.ts` | `nimbus media understand` |

**Modify:**

| Path | Change |
| --- | --- |
| `packages/gateway/src/embedding/routing.ts` | Add both derived types to `LOCAL_ONLY_PROSE_TYPES` |
| `packages/gateway/src/index/migrations/runner.ts` | Register `simpleStep(57, 58, …)` |
| `packages/gateway/src/index/local-index.ts:265` | Bump `CURRENT_SCHEMA_VERSION` 57 → 58 |
| `packages/gateway/src/connectors/filesystem-v2-sync.ts` | Walk media extensions alongside `CODE_EXT` |
| `packages/cli/src/commands/index.ts` | Register the `media` command |
| `packages/cli/src/commands/help.ts` | Help line |
| `packages/gateway/src/config/filesystem-toml.ts` | `media_index` per-root toggle, default off |

---

## Task 1: V58 migration — `media_pass_cursor`

**Files:**

- Create: `packages/gateway/src/index/media-pass-v58-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Test: `packages/gateway/src/index/migrations/runner-v58.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `MEDIA_PASS_V58_SQL: string`, and `CURRENT_SCHEMA_VERSION === 58` (every later task's test helper migrates to it). Table `media_pass_cursor(pass_id TEXT PK, service TEXT, modality TEXT, last_item_id TEXT NOT NULL, processed_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/index/migrations/runner-v58.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V58 — media_pass_cursor", () => {
  test("creates the cursor table and reaches version 58", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    const row = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='media_pass_cursor'",
      )
      .get();
    expect(row?.name).toBe("media_pass_cursor");
    db.close();
  });

  test("cursor round-trips and pass_id is the primary key", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    db.run(
      "INSERT INTO media_pass_cursor (pass_id, service, modality, last_item_id, processed_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["p1", "filesystem", "av", "filesystem:a.mp4", 3, 1000],
    );
    db.run(
      `INSERT INTO media_pass_cursor (pass_id, service, modality, last_item_id, processed_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(pass_id) DO UPDATE SET last_item_id = excluded.last_item_id, processed_count = excluded.processed_count`,
      ["p1", "filesystem", "av", "filesystem:b.mp4", 7, 2000],
    );

    const rows = db
      .query<{ last_item_id: string; processed_count: number }, []>(
        "SELECT last_item_id, processed_count FROM media_pass_cursor",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_item_id).toBe("filesystem:b.mp4");
    expect(rows[0]?.processed_count).toBe(7);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v58.test.ts`
Expected: FAIL — `row?.name` is `undefined` because no such table exists.

- [ ] **Step 3: Write the SQL module**

```ts
// packages/gateway/src/index/media-pass-v58-sql.ts
/**
 * V58 — the multimodal understanding pass cursor (spec § 6.2).
 *
 * SQLite-backed rather than in-memory so an interrupted pass resumes across a gateway restart,
 * which is the entire point of a budgeted pass over a large media library.
 *
 * Grants are NOT here: they land in V59 with PR 4. Schema is forward-only, so creating a table
 * three PRs before anything reads it would be drift waiting to happen.
 */
export const MEDIA_PASS_V58_SQL = `
CREATE TABLE IF NOT EXISTS media_pass_cursor (
  pass_id          TEXT PRIMARY KEY,
  service          TEXT,
  modality         TEXT,
  last_item_id     TEXT NOT NULL,
  processed_count  INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
) WITHOUT ROWID;
`;
```

- [ ] **Step 4: Register the step**

In `packages/gateway/src/index/migrations/runner.ts`, add the import next to the other SQL imports:

```ts
import { MEDIA_PASS_V58_SQL } from "../media-pass-v58-sql.ts";
```

and append to the steps array, immediately after the `simpleStep(56, 57, …)` line:

```ts
  simpleStep(57, 58, "multimodal understanding pass cursor", MEDIA_PASS_V58_SQL),
```

- [ ] **Step 5: Bump the schema version**

**Without this the step never runs.** `runIndexedSchemaMigrations(db, targetVersion)` stops at
`targetVersion`, and every caller passes `CURRENT_SCHEMA_VERSION`. In
`packages/gateway/src/index/local-index.ts:265`:

```ts
export const CURRENT_SCHEMA_VERSION = 58;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/gateway/src/index/`
Expected: PASS. Run the whole `index/` directory, not just `migrations/` — several suites assert
against `CURRENT_SCHEMA_VERSION` and a bump that breaks one of them must surface here rather than
in CI.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/media-pass-v58-sql.ts packages/gateway/src/index/migrations/runner.ts packages/gateway/src/index/migrations/runner-v58.test.ts packages/gateway/src/index/local-index.ts
git commit -m "feat(index): V58 media_pass_cursor for the multimodal understanding pass"
```

---

## Task 2: Embedding routing — derived types are local-only

**Files:**

- Modify: `packages/gateway/src/embedding/routing.ts`
- Test: `packages/gateway/src/embedding/routing.test.ts:120-150` (extend)

**Interfaces:**

- Consumes: nothing.
- Produces: routing keys `nimbus:image_understanding` and `nimbus:video_understanding` present in `LOCAL_ONLY_PROSE_TYPES`.

**Why this task exists and why it is early:** if the types are added to `PROSE_HEAVY_TYPES` instead, a fully local understanding pass over private media ships all the derived transcript text to OpenAI's embedder with no grant. Landing this before anything writes such an item means there is never a window where the wrong routing is live.

Both types are added now even though `image_understanding` is not written until PR 2 — set membership is inert until a row exists, and splitting it risks PR 2 landing the writer without the routing.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/embedding/routing.test.ts`:

```ts
test("understanding types are local-only, never prose-heavy", () => {
  for (const key of ["nimbus:image_understanding", "nimbus:video_understanding"]) {
    expect(LOCAL_ONLY_PROSE_TYPES.has(key)).toBe(true);
    expect(PROSE_HEAVY_TYPES.has(key)).toBe(false);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/embedding/routing.test.ts`
Expected: FAIL — `LOCAL_ONLY_PROSE_TYPES.has(...)` returns `false`.

- [ ] **Step 3: Add the types**

In `packages/gateway/src/embedding/routing.ts`, replace the `LOCAL_ONLY_PROSE_TYPES` declaration:

```ts
export const LOCAL_ONLY_PROSE_TYPES: ReadonlySet<string> = new Set([
  "nimbus:web_clip",
  // Multimodal understanding output (spec § 4). Derived captions and transcripts carry the FULL
  // semantic content of a private photo or recording. Routing them to the remote embedder would
  // keep the pixels on the machine while shipping everything extracted from them to OpenAI, with
  // no grant, through a different door than the one I37 guards. Retrieval quality on long
  // transcripts is the deliberate price, exactly as it already is for web clips.
  "nimbus:image_understanding",
  "nimbus:video_understanding",
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/embedding/routing.test.ts packages/gateway/src/index/body-caps.test.ts`
Expected: PASS. `body-caps.test.ts` iterates the union of both sets and asserts each gets `BODY_MAX_PROSE`, so it exercises the new keys too.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/embedding/routing.ts packages/gateway/src/embedding/routing.test.ts
git commit -m "feat(embedding): pin multimodal understanding types to local-only embedding"
```

---

## Task 3: Media source registry and shared types

**Files:**

- Create: `packages/gateway/src/multimodal/media-types.ts`
- Create: `packages/gateway/src/multimodal/media-source-registry.ts`
- Test: `packages/gateway/src/multimodal/media-source-registry.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type MediaModality = "image" | "av"`
  - `type SkipReason = "over_byte_cap" | "no_local_model" | "no_remote_grant" | "unresolvable_modality" | "fetch_miss" | "path_outside_roots" | "transcode_failed" | "transcribe_failed"`
  - `interface MediaCandidate { itemId: string; service: string; type: string; title: string; url: string | null; modality: MediaModality; sourcePath: string | null; sourceMime: string | null; sourceBytes: number | null; }`
  - `interface UnderstandOutcome { text: string; model: string; isLocal: boolean; }`
  - `const UNDERSTANDING_VERSION = 1`
  - `mediaExtensionModality(ext: string): MediaModality | undefined`
  - `modalityForItem(service: string, type: string): MediaModality | undefined`
  - `MEDIA_EXTENSIONS: ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/media-source-registry.test.ts
import { describe, expect, test } from "bun:test";
import {
  MEDIA_EXTENSIONS,
  mediaExtensionModality,
  modalityForItem,
} from "./media-source-registry.ts";

describe("mediaExtensionModality", () => {
  test("classifies audio and video as av", () => {
    expect(mediaExtensionModality(".mp4")).toBe("av");
    expect(mediaExtensionModality(".mp3")).toBe("av");
    expect(mediaExtensionModality(".m4a")).toBe("av");
  });

  test("classifies images", () => {
    expect(mediaExtensionModality(".png")).toBe("image");
    expect(mediaExtensionModality(".jpg")).toBe("image");
  });

  test("is case-insensitive — Windows and macOS produce upper-case extensions", () => {
    expect(mediaExtensionModality(".MP4")).toBe("av");
    expect(mediaExtensionModality(".PNG")).toBe("image");
  });

  test("returns undefined for a non-media extension rather than guessing", () => {
    expect(mediaExtensionModality(".ts")).toBeUndefined();
    expect(mediaExtensionModality("")).toBeUndefined();
  });

  test("MEDIA_EXTENSIONS covers exactly the classifiable extensions", () => {
    for (const ext of MEDIA_EXTENSIONS) {
      expect(mediaExtensionModality(ext)).toBeDefined();
    }
  });
});

describe("modalityForItem", () => {
  test("filesystem media items resolve by their recorded modality type", () => {
    expect(modalityForItem("filesystem", "media_av")).toBe("av");
    expect(modalityForItem("filesystem", "media_image")).toBe("image");
  });

  test("an unregistered pair returns undefined, never a default", () => {
    expect(modalityForItem("filesystem", "symbol")).toBeUndefined();
    expect(modalityForItem("slack", "message")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/multimodal/media-source-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the types module**

```ts
// packages/gateway/src/multimodal/media-types.ts
/**
 * Shared vocabulary for the multimodal understanding pass (spec § 3.1).
 *
 * Kept separate from the registry so the gate, the pass and the item mapper can all depend on the
 * types without depending on the registry's data.
 */

export type MediaModality = "image" | "av";

/**
 * Every reason an artifact can be skipped. The pass summary reports counts PER REASON — a bare
 * "understood 42 of 108" is the disclosure failure spec § 8 exists to prevent.
 */
export type SkipReason =
  | "over_byte_cap"
  | "no_local_model"
  | "no_remote_grant"
  | "unresolvable_modality"
  | "fetch_miss"
  | "path_outside_roots"
  | "transcode_failed"
  | "transcribe_failed";

export interface MediaCandidate {
  readonly itemId: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly modality: MediaModality;
  /** Absolute path for a local artifact; null for a cloud artifact (PR 3). */
  readonly sourcePath: string | null;
  readonly sourceMime: string | null;
  readonly sourceBytes: number | null;
}

export interface UnderstandOutcome {
  readonly text: string;
  readonly model: string;
  /**
   * DERIVED from the provider, never supplied by a caller (spec § 3.4 step 2, invariant I34).
   * Recorded on the derived item so a reader can tell where the understanding came from.
   */
  readonly isLocal: boolean;
}

/**
 * Bumped when a better model or a changed prompt means existing understanding should be redone.
 *
 * It lives in item METADATA and never in an `externalId`: `item` is UNIQUE(service, external_id),
 * so a version in the id would create a second row per artifact per version rather than replacing
 * the first — duplicate FTS hits and duplicate agent context (spec § 4.1).
 */
export const UNDERSTANDING_VERSION = 1;
```

- [ ] **Step 4: Write the registry module**

```ts
// packages/gateway/src/multimodal/media-source-registry.ts
/**
 * The SSoT for "is this thing understandable, and as what" (spec § 3.1).
 *
 * Two lookups that must not be collapsed: an EXTENSION lookup used by the filesystem walk to decide
 * what to index at all, and an ITEM lookup used by discovery to decide what to understand. A cloud
 * photo has an item type but no extension; a file on disk has both.
 */
import type { MediaModality } from "./media-types.ts";

const AV_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
  ".ogg",
]);

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
]);

/** The union, for the filesystem walk's allow-list (spec § 12.4). */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...AV_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]);

/**
 * Lower-cases before lookup: `readdirSync` returns the on-disk casing, and `.MP4` and `.PNG` are
 * ordinary on Windows and on media exported from phones.
 */
export function mediaExtensionModality(ext: string): MediaModality | undefined {
  const lower = ext.toLowerCase();
  if (AV_EXTENSIONS.has(lower)) return "av";
  if (IMAGE_EXTENSIONS.has(lower)) return "image";
  return undefined;
}

/**
 * `(service, type)` -> modality. A pair that is absent returns undefined and the candidate is
 * skipped as `unresolvable_modality` — never defaulted, since guessing the modality means handing
 * bytes to the wrong model.
 *
 * PR 3 adds the cloud pairs (`google_photos:photo`, `zoom:recording`, ...). Deliberately not
 * pre-populated: an entry here with no `fetchBytes` behind it would make discovery surface
 * candidates the pass can only skip.
 */
const ITEM_TYPE_MODALITY: ReadonlyMap<string, MediaModality> = new Map([
  ["filesystem:media_av", "av"],
  ["filesystem:media_image", "image"],
]);

export function modalityForItem(service: string, type: string): MediaModality | undefined {
  return ITEM_TYPE_MODALITY.get(`${service}:${type}`);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/media-source-registry.test.ts`
Expected: PASS (10 assertions across 7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/
git commit -m "feat(multimodal): media source registry and shared types"
```

---

## Task 4: Walk local media files

**Files:**

- Modify: `packages/gateway/src/connectors/filesystem-v2-sync.ts` (add beside `walkCodeFilesRecursive`, ~line 387)
- Test: `packages/gateway/src/connectors/filesystem-v2-media.test.ts`

**Interfaces:**

- Consumes: `MEDIA_EXTENSIONS`, `mediaExtensionModality` (Task 3).
- Produces: `interface FoundMediaFile { path: string; modality: MediaModality; }`, `collectMediaFiles(root: string, exclude: readonly string[], maxFiles: number): FoundMediaFile[]`, `mimeTypeForMediaExtension(ext: string): string | null`.

**Context:** `filesystem-v2-sync.ts` currently walks for `CODE_EXT` (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) only and indexes code *symbols*. Media files are indexed as whole-file items with no body — the body arrives later, from the understanding pass.

**Use the file's own `isExcluded` helper, not a bare name check.** The existing code walk applies **both** `exclude.includes(name)` and `isExcluded(rel, exclude)`; the media walk must match it. Note what `isExcluded` actually does (line 47): it splits the relative path on `/` and tests each **component** against the exclude list — exact matching, not globbing. A `dist/**` entry in `nimbus.toml` matches nothing under either walk. The reason to use the shared helper is a single code path that both walks inherit if it ever grows glob support, not a correctness gap between the two today.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/filesystem-v2-media.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { collectMediaFiles, mimeTypeForMediaExtension } from "./filesystem-v2-sync.ts";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-media-"));
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "demo.mp4"), "x");
  writeFileSync(join(root, "shot.PNG"), "x");
  writeFileSync(join(root, "notes.ts"), "x");
  writeFileSync(join(root, "nested", "call.m4a"), "x");
  writeFileSync(join(root, "node_modules", "vendored.mp4"), "x");
  return root;
}

function names(files: readonly { path: string }[]): string[] {
  return files.map((f) => f.path.split(/[\\/]/).pop() ?? "").sort();
}

describe("collectMediaFiles", () => {
  test("finds media recursively and ignores non-media", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules"], 100);
    expect(names(found)).toEqual(["call.m4a", "demo.mp4", "shot.PNG"]);
  });

  test("classifies modality, case-insensitively", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules"], 100);
    const byName = new Map(found.map((f) => [f.path.split(/[\\/]/).pop(), f.modality]));
    expect(byName.get("demo.mp4")).toBe("av");
    expect(byName.get("shot.PNG")).toBe("image");
  });

  test("honours the file cap — a photo library must not be unbounded", () => {
    expect(collectMediaFiles(fixtureRoot(), [], 2)).toHaveLength(2);
  });

  test("excludes a directory at any depth, matching the code walk", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules"], 100);
    expect(names(found)).not.toContain("vendored.mp4");
  });

  test("excludes a nested directory by name", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules", "nested"], 100);
    expect(names(found)).toEqual(["demo.mp4", "shot.PNG"]);
  });
});

describe("mimeTypeForMediaExtension", () => {
  test("maps known media extensions", () => {
    expect(mimeTypeForMediaExtension(".mp4")).toBe("video/mp4");
    expect(mimeTypeForMediaExtension(".mp3")).toBe("audio/mpeg");
    expect(mimeTypeForMediaExtension(".png")).toBe("image/png");
  });

  test("is case-insensitive", () => {
    expect(mimeTypeForMediaExtension(".MP4")).toBe("video/mp4");
  });

  test("returns null rather than a guess for an unknown extension", () => {
    expect(mimeTypeForMediaExtension(".xyz")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-media.test.ts`
Expected: FAIL — `collectMediaFiles` is not exported.

- [ ] **Step 3: Implement the walk**

Add to `packages/gateway/src/connectors/filesystem-v2-sync.ts`, next to `walkCodeFilesRecursive`:

```ts
import { MEDIA_EXTENSIONS, mediaExtensionModality } from "../multimodal/media-source-registry.ts";
import type { MediaModality } from "../multimodal/media-types.ts";

export interface FoundMediaFile {
  readonly path: string;
  readonly modality: MediaModality;
}

/**
 * `sourceMime` on a derived understanding item comes from here.
 *
 * Returns null rather than `application/octet-stream` for an unknown extension: a wrong MIME is
 * worse than an absent one, because a reader cannot tell a guess from a fact.
 */
const MEDIA_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".m4v", "video/x-m4v"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".tiff", "image/tiff"],
]);

export function mimeTypeForMediaExtension(ext: string): string | null {
  return MEDIA_MIME_TYPES.get(ext.toLowerCase()) ?? null;
}

/**
 * Media files under a root, capped and exclude-aware.
 *
 * Separate from the code walk because the two answer different questions: the code walk indexes
 * SYMBOLS inside a file, this indexes the file ITSELF as an artifact whose body arrives later from
 * the understanding pass. `maxFiles` is load-bearing — a root pointed at a photo library is
 * otherwise unbounded (spec § 12.4).
 *
 * Exclusion applies BOTH checks the code walk applies, so the two stay one behaviour.
 */
export function collectMediaFiles(
  root: string,
  exclude: readonly string[],
  maxFiles: number,
): FoundMediaFile[] {
  const found: FoundMediaFile[] = [];
  walkMediaFilesRecursive(root, exclude, maxFiles, found, root, 0);
  return found;
}

function walkMediaFilesRecursive(
  root: string,
  exclude: readonly string[],
  maxFiles: number,
  found: FoundMediaFile[],
  dir: string,
  depth: number,
): void {
  if (found.length >= maxFiles || depth > 10) {
    return;
  }
  const entries = readDirectoryDirentsOrUndefined(dir);
  if (entries === undefined) {
    return;
  }
  for (const ent of entries) {
    if (found.length >= maxFiles) {
      return;
    }
    const name = String(ent.name);
    if (exclude.includes(name)) {
      continue;
    }
    const full = join(dir, name);
    const rel = relative(root, full);
    if (isExcluded(rel, exclude)) {
      continue;
    }
    if (ent.isDirectory()) {
      walkMediaFilesRecursive(root, exclude, maxFiles, found, full, depth + 1);
      continue;
    }
    if (!ent.isFile()) {
      continue;
    }
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    if (!MEDIA_EXTENSIONS.has(ext.toLowerCase())) {
      continue;
    }
    const modality = mediaExtensionModality(ext);
    if (modality !== undefined) {
      found.push({ path: full, modality });
    }
  }
}
```

`join`, `relative`, `isExcluded` and `readDirectoryDirentsOrUndefined` already exist in this file — do not redeclare any of them. Read the top of the file and extend the existing `node:path` import rather than adding a second one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-media.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/filesystem-v2-sync.ts packages/gateway/src/connectors/filesystem-v2-media.test.ts
git commit -m "feat(filesystem): walk local media files with the shared exclude helper"
```

---

## Task 4b: The `media_index` root toggle

**Files:**

- Modify: `packages/gateway/src/config/filesystem-toml.ts:7-13` (type), `:42-49` (default), `:67+` (key switch)
- Test: `packages/gateway/src/config/filesystem-toml.test.ts` (extend)

**Interfaces:**

- Consumes: nothing.
- Produces: `NimbusFilesystemRootToml.mediaIndex: boolean`, parsed from the TOML key `media_index`, **defaulting to `false`**.

**Why a toggle, and why default off:** every other expensive per-root behaviour has one (`git_aware`, `code_index`, `dependency_graph`), and `code_index` — the closest analogue — already defaults to `false`. Media indexing walks a whole tree looking for large binaries, so a user who points a root at a home directory must opt in rather than discover the cost.

- [ ] **Step 1: Write the failing test**

Read `packages/gateway/src/config/filesystem-toml.test.ts` first and match its actual parser entry point and import — this plan does not restate them, and the name has changed over time. Then append, adapting the call to match:

```ts
test("media_index defaults to false — media indexing is opt-in per root", () => {
  const roots = parseFilesystemRoots(`
[[filesystem.roots]]
path = "/tmp/x"
`);
  expect(roots[0]?.mediaIndex).toBe(false);
});

test("media_index = true is parsed", () => {
  const roots = parseFilesystemRoots(`
[[filesystem.roots]]
path = "/tmp/x"
media_index = true
`);
  expect(roots[0]?.mediaIndex).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/config/filesystem-toml.test.ts`
Expected: FAIL — `mediaIndex` is `undefined`.

- [ ] **Step 3: Implement**

Add to the `NimbusFilesystemRootToml` type:

```ts
  mediaIndex: boolean;
```

Add to `defaultRoot()`:

```ts
    mediaIndex: false,
```

Add a case to `applyFilesystemRootKey`, beside `code_index`:

```ts
    case "media_index": {
      applyOptionalBool(valRaw, (b) => {
        cur.mediaIndex = b;
      });
      break;
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/config/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/filesystem-toml.ts packages/gateway/src/config/filesystem-toml.test.ts
git commit -m "feat(config): media_index per-root toggle, default off"
```

---

## Task 4c: Wire media indexing into the filesystem sync

**Files:**

- Modify: `packages/gateway/src/connectors/filesystem-v2-sync.ts` (`createFilesystemV2Syncable.sync`, ~line 599-625)
- Test: `packages/gateway/src/connectors/filesystem-v2-media.test.ts` (extend)

**Interfaces:**

- Consumes: `collectMediaFiles`, `mimeTypeForMediaExtension` (Task 4); `mediaIndex` (Task 4b).
- Produces: `syncFilesystemMediaForRoot(ctx, root, exclude, maxFiles, now): { upserted: number; bytes: number }`, writing `item` rows with `service = "filesystem"`, `type = "media_av"` / `"media_image"`, `externalId` = the absolute path, `metadata = { path, sizeBytes, mimeType, mediaKind }`.

**This task exists because without it the feature is inert.** Tasks 4 and 4b produce a walk and a toggle that nothing calls; `nimbus media understand` would find zero candidates on every real database while every unit test passed.

**A connector writes through `ctx.upsertItem`, NEVER a raw `Database`.** `SyncContext` deliberately exposes no `db` and no `vault` — static rule **D24** enforces it, because before that narrowing any of ~90 connectors could read another connector's credentials and write any table. A `ctx.db` in this file fails the structure audit before the test suite even runs.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/connectors/filesystem-v2-media.test.ts`:

```ts
import type { SyncContext } from "../sync/types.ts";
import { syncFilesystemMediaForRoot } from "./filesystem-v2-sync.ts";

interface UpsertCall {
  service: string;
  type: string;
  externalId: string;
  title: string;
  metadata?: Record<string, unknown>;
}

function fakeCtx(calls: UpsertCall[]): SyncContext {
  // Only `upsertItem` is exercised here. The cast is confined to this test helper so it need not
  // construct ~15 unrelated capabilities; PRODUCTION code must never cast into SyncContext — that
  // cast is the one thing D24's type narrowing cannot catch.
  return {
    upsertItem: (row: UpsertCall) => {
      calls.push(row);
    },
  } as unknown as SyncContext;
}

describe("syncFilesystemMediaForRoot", () => {
  test("upserts one bodyless item per media file", () => {
    const calls: UpsertCall[] = [];
    const res = syncFilesystemMediaForRoot(
      fakeCtx(calls),
      fixtureRoot(),
      ["node_modules"],
      100,
      1000,
    );
    expect(res.upserted).toBe(3);
    expect(calls).toHaveLength(3);
  });

  test("types each item by modality and keys it on the absolute path", () => {
    const calls: UpsertCall[] = [];
    const root = fixtureRoot();
    syncFilesystemMediaForRoot(fakeCtx(calls), root, ["node_modules"], 100, 1000);
    const mp4 = calls.find((c) => c.externalId.endsWith("demo.mp4"));
    expect(mp4?.service).toBe("filesystem");
    expect(mp4?.type).toBe("media_av");
    expect(mp4?.externalId.startsWith(root)).toBe(true);
  });

  test("records path, sizeBytes and mimeType in metadata", () => {
    const calls: UpsertCall[] = [];
    syncFilesystemMediaForRoot(fakeCtx(calls), fixtureRoot(), ["node_modules"], 100, 1000);
    const mp4 = calls.find((c) => c.externalId.endsWith("demo.mp4"));
    expect(mp4?.metadata?.["mimeType"]).toBe("video/mp4");
    expect(mp4?.metadata?.["mediaKind"]).toBe("av");
    expect(typeof mp4?.metadata?.["path"]).toBe("string");
    expect(typeof mp4?.metadata?.["sizeBytes"]).toBe("number");
  });

  test("reports zero for a root with no media", () => {
    const empty = mkdtempSync(join(tmpdir(), "nimbus-empty-"));
    const calls: UpsertCall[] = [];
    expect(syncFilesystemMediaForRoot(fakeCtx(calls), empty, [], 100, 1000).upserted).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-media.test.ts`
Expected: FAIL — `syncFilesystemMediaForRoot` is not exported.

- [ ] **Step 3: Implement the per-root sync**

```ts
/** Cap per root. A home directory full of photos is otherwise unbounded (spec § 12.4). */
const MEDIA_MAX_FILES_PER_ROOT = 5_000;

/**
 * Indexes each media file under `root` as a BODYLESS item.
 *
 * The body arrives later as a separate derived `nimbus:*_understanding` item (spec § 4) — this row
 * is the artifact's existence and location, and deliberately carries no transcript of its own.
 *
 * Writes through `ctx.upsertItem`, never a raw `Database`: `SyncContext` exposes no handles and
 * static rule D24 enforces that, so a `ctx.db` here fails the structure audit.
 */
export function syncFilesystemMediaForRoot(
  ctx: SyncContext,
  root: string,
  exclude: readonly string[],
  maxFiles: number,
  now: number,
): { upserted: number; bytes: number } {
  const files = collectMediaFiles(root, exclude, maxFiles);
  let upserted = 0;

  for (const file of files) {
    let sizeBytes: number | null = null;
    let modifiedAt = now;
    try {
      const st = statSync(file.path);
      sizeBytes = st.size;
      modifiedAt = Math.floor(st.mtimeMs);
    } catch {
      // Vanished between walk and stat — simply not indexed this run.
      continue;
    }
    const dot = file.path.lastIndexOf(".");
    const ext = dot >= 0 ? file.path.slice(dot) : "";
    const name = file.path.split(/[\\/]/).pop() ?? file.path;

    ctx.upsertItem({
      service: SERVICE_ID,
      type: file.modality === "av" ? "media_av" : "media_image",
      externalId: file.path,
      title: name.length > 512 ? name.slice(0, 512) : name,
      bodyPreview: "",
      url: null,
      canonicalUrl: null,
      modifiedAt,
      authorId: null,
      metadata: {
        path: file.path,
        sizeBytes,
        mimeType: mimeTypeForMediaExtension(ext),
        mediaKind: file.modality,
      },
      pinned: false,
      syncedAt: now,
    });
    upserted += 1;
  }

  // `bytes` is 0 because no file is READ here — only `stat`ed. Counting file sizes would inflate
  // the connector's reported transfer total with data that never moved.
  return { upserted, bytes: 0 };
}
```

- [ ] **Step 4: Wire it into `sync()`**

In `createFilesystemV2Syncable.sync`, inside the `for (const rootCfg of options.roots)` loop, after the existing `if (rootCfg.codeIndex) { … }` block:

```ts
        if (rootCfg.mediaIndex) {
          const m = syncFilesystemMediaForRoot(
            ctx,
            root,
            rootCfg.exclude,
            MEDIA_MAX_FILES_PER_ROOT,
            now,
          );
          upserted += m.upserted;
          bytes += m.bytes;
        }
```

- [ ] **Step 5: Run the connector suites**

Run: `bun test packages/gateway/src/connectors/filesystem-v2-media.test.ts packages/gateway/src/connectors/filesystem-v2-sync.test.ts`
Expected: PASS. The pre-existing sync test must stay green — media indexing is default-off, so a root without `media_index = true` behaves exactly as before.

- [ ] **Step 6: Run the structure audit**

Run: `bun run audit:structure`
Expected: PASS, D24 included. If it reports a `ctx.db` / `ctx.vault` violation in this file, the implementation reached for a raw handle — rewrite it through `ctx.upsertItem` rather than adding an exemption.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/connectors/filesystem-v2-sync.ts packages/gateway/src/connectors/filesystem-v2-media.test.ts
git commit -m "feat(filesystem): index media files during sync behind the media_index toggle"
```

---

## Task 5: Byte acquisition — path validation against live roots

**Files:**

- Create: `packages/gateway/src/multimodal/media-bytes.ts`
- Test: `packages/gateway/src/multimodal/media-bytes.test.ts`

**Interfaces:**

- Consumes: `MediaCandidate`, `SkipReason` (Task 3).
- Produces: `resolveLocalMediaPath(candidate: MediaCandidate, roots: readonly string[], maxBytes: number): { ok: true; path: string } | { ok: false; reason: SkipReason }`

**Security context:** this is the function that decides whether a path in the *index* may be read from *disk*. Roots can narrow after indexing, so the stored path is not trustworthy on its own. `isAbsolute` is insufficient — `/a/b/../../etc` passes it. Resolve first, then containment-check.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/media-bytes.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveLocalMediaPath } from "./media-bytes.ts";
import type { MediaCandidate } from "./media-types.ts";

function candidate(path: string, bytes: number | null = 10): MediaCandidate {
  return {
    itemId: "filesystem:x",
    service: "filesystem",
    type: "media_av",
    title: "x",
    url: null,
    modality: "av",
    sourcePath: path,
    sourceMime: null,
    sourceBytes: bytes,
  };
}

describe("resolveLocalMediaPath", () => {
  test("accepts a file inside a configured root", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const file = join(root, "a.mp4");
    writeFileSync(file, "x");
    const out = resolveLocalMediaPath(candidate(file), [root], 1000);
    expect(out.ok).toBe(true);
  });

  test("refuses a path outside every root", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const other = mkdtempSync(join(tmpdir(), "nimbus-other-"));
    const file = join(other, "a.mp4");
    writeFileSync(file, "x");
    const out = resolveLocalMediaPath(candidate(file), [root], 1000);
    expect(out).toEqual({ ok: false, reason: "path_outside_roots" });
  });

  test("refuses traversal that escapes a root — isAbsolute is not enough", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const escaping = join(root, "..", "escaped.mp4");
    const out = resolveLocalMediaPath(candidate(escaping), [root], 1000);
    expect(out).toEqual({ ok: false, reason: "path_outside_roots" });
  });

  test("refuses a sibling root whose name merely PREFIXES a configured root", () => {
    // `/tmp/rootA-evil` must not pass a containment check against `/tmp/rootA`.
    const base = mkdtempSync(join(tmpdir(), "nimbus-prefix-"));
    const root = join(base, "rootA");
    const evil = join(base, "rootA-evil");
    const out = resolveLocalMediaPath(candidate(join(evil, "a.mp4")), [root], 1000);
    expect(out).toEqual({ ok: false, reason: "path_outside_roots" });
  });

  test("refuses an artifact over the byte cap rather than truncating", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const file = join(root, "big.mp4");
    writeFileSync(file, "x");
    const out = resolveLocalMediaPath(candidate(file, 5_000), [root], 1_000);
    expect(out).toEqual({ ok: false, reason: "over_byte_cap" });
  });

  test("refuses a candidate with no local path", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const out = resolveLocalMediaPath(candidate(null as unknown as string), [root], 1000);
    expect(out.ok).toBe(false);
  });

  test("refuses a file that no longer exists", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const out = resolveLocalMediaPath(candidate(join(root, "gone.mp4")), [root], 1000);
    expect(out).toEqual({ ok: false, reason: "fetch_miss" });
  });

  test("an empty root list accepts nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const file = join(root, "a.mp4");
    writeFileSync(file, "x");
    expect(resolveLocalMediaPath(candidate(file), [], 1000).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/multimodal/media-bytes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/media-bytes.ts
/**
 * Resolves a candidate to a path that may actually be read (spec § 5.1).
 *
 * Contacts no model — that separation is what makes `media-gate.ts`'s chokepoint claim checkable.
 *
 * The path stored on an item is NOT trusted. Roots can narrow after indexing, so containment is
 * re-checked against the LIVE roots at read time. `isAbsolute` is not sufficient:
 * `/a/b/../../etc` passes it, and the terminal lane shipped that bug — the consent prompt showed
 * the unresolved string while the sandbox bound the resolved one. Resolve first, compare after.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { MediaCandidate, SkipReason } from "./media-types.ts";

export type ResolvedMediaPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: SkipReason };

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * The trailing separator matters: a plain `startsWith` would accept `/tmp/rootA-evil` for the root
 * `/tmp/rootA`, since one string does prefix the other.
 */
function isContainedBy(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(withSep);
}

export function resolveLocalMediaPath(
  candidate: MediaCandidate,
  roots: readonly string[],
  maxBytes: number,
): ResolvedMediaPath {
  const raw = candidate.sourcePath;
  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, reason: "fetch_miss" };
  }

  const resolved = resolve(raw);

  // Containment is checked on the RESOLVED path first, so a traversal that escapes is rejected
  // before the filesystem is touched at all.
  const rootsResolved = roots.map((r) => resolve(r));
  if (!rootsResolved.some((r) => isContainedBy(resolved, r))) {
    return { ok: false, reason: "path_outside_roots" };
  }

  if (!existsSync(resolved)) {
    return { ok: false, reason: "fetch_miss" };
  }

  // Re-check containment after following symlinks: a link INSIDE a root pointing OUTSIDE it would
  // otherwise pass the check above and then read an out-of-root file.
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    return { ok: false, reason: "fetch_miss" };
  }
  const realRoots = rootsResolved.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  if (!realRoots.some((r) => isContainedBy(real, r))) {
    return { ok: false, reason: "path_outside_roots" };
  }

  let size: number;
  try {
    size = statSync(real).size;
  } catch {
    return { ok: false, reason: "fetch_miss" };
  }
  if (size > maxBytes) {
    return { ok: false, reason: "over_byte_cap" };
  }

  return { ok: true, path: real };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/media-bytes.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/media-bytes.ts packages/gateway/src/multimodal/media-bytes.test.ts
git commit -m "feat(multimodal): validate local media paths against live filesystem roots"
```

---

## Task 6: ffmpeg resolution and transcode to a scratch WAV

**Files:**

- Create: `packages/gateway/src/multimodal/stt/ffmpeg-bin.ts`
- Test: `packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `resolveFfmpegBin(configuredPath?: string, which?: (n: string) => string | null): string`
  - `transcodeToWav(input: string, opts: TranscodeOptions): Promise<string>` — returns the scratch WAV path
  - `interface TranscodeOptions { ffmpegBin: string; scratchDir: string; spawn?: typeof Bun.spawn; }`
  - `withScratchFile<T>(path: string, fn: (p: string) => Promise<T>): Promise<T>`

**Context:** this mirrors `resolveWhisperBin` in `packages/gateway/src/voice/stt.ts` exactly — config path, then `NIMBUS_FFMPEG_PATH`, then `Bun.which`, with injectable `which`/`spawn` so tests never touch a real binary. It does **not** live in `platform/`: resolving an external binary is not OS-specific logic reached through `PlatformServices`, and both precedents (`resolveWhisperBin`, `computer-use/cu-lanes/chromium-path.ts`) keep the resolver beside its consumer.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  resolveFfmpegBin,
  sweepStaleScratchFiles,
  transcodeToWav,
  withScratchFile,
} from "./ffmpeg-bin.ts";

describe("resolveFfmpegBin", () => {
  test("prefers an explicit configured path", () => {
    expect(resolveFfmpegBin("/opt/ffmpeg", () => null)).toBe("/opt/ffmpeg");
  });

  test("falls back to PATH lookup", () => {
    expect(resolveFfmpegBin(undefined, (n) => (n === "ffmpeg" ? "/usr/bin/ffmpeg" : null))).toBe(
      "ffmpeg",
    );
  });

  test("returns the bare name when nothing resolves, so the spawn error names it", () => {
    expect(resolveFfmpegBin(undefined, () => null)).toBe("ffmpeg");
  });
});

describe("transcodeToWav", () => {
  test("builds a 16 kHz mono PCM command and returns the scratch path", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    let seen: string[] = [];
    const out = await transcodeToWav("/in/demo.mp4", {
      ffmpegBin: "ffmpeg",
      scratchDir: scratch,
      // `stderr` is a ReadableStream, which is what Bun.spawn({stderr:"pipe"}) actually returns.
      // An earlier draft of this plan had the fake return a `Response` here while production code
      // wrapped it in `new Response(...)` — the fake and the real thing disagreed, so the test
      // proved nothing about the wire. `.body` is the stream.
      spawn: ((cmd: string[]) => {
        seen = cmd;
        writeFileSync(cmd[cmd.length - 1] as string, "wav");
        return { exited: Promise.resolve(0), stderr: new Response("").body, kill: () => undefined };
      }) as unknown as typeof Bun.spawn,
    });

    expect(seen).toContain("-ar");
    expect(seen).toContain("16000");
    expect(seen).toContain("-ac");
    expect(seen).toContain("1");
    expect(seen[0]).toBe("ffmpeg");
    expect(out.endsWith(".wav")).toBe(true);
    expect(out.startsWith(scratch)).toBe(true);
  });

  test("throws when ffmpeg exits non-zero", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    await expect(
      transcodeToWav("/in/demo.mp4", {
        ffmpegBin: "ffmpeg",
        scratchDir: scratch,
        spawn: (() => ({
          exited: Promise.resolve(1),
          stderr: new Response("boom").body,
          kill: () => undefined,
        })) as unknown as typeof Bun.spawn,
      }),
    ).rejects.toThrow(/ffmpeg/);
  });
});

describe("withScratchFile", () => {
  test("deletes the file after a successful callback", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const f = join(scratch, "a.wav");
    writeFileSync(f, "x");
    await withScratchFile(f, async () => "done");
    expect(existsSync(f)).toBe(false);
  });

  test("deletes the file when the callback THROWS — the finally is the contract", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const f = join(scratch, "b.wav");
    writeFileSync(f, "x");
    await expect(
      withScratchFile(f, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    expect(existsSync(f)).toBe(false);
  });

  test("does not throw when the file is already gone", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const f = join(scratch, "missing.wav");
    await expect(withScratchFile(f, async () => 1)).resolves.toBe(1);
  });
});

describe("transcodeToWav timeout", () => {
  test("kills the process and throws when it never exits", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    let killed = 0;
    await expect(
      transcodeToWav("/in/hangs.mp4", {
        ffmpegBin: "ffmpeg",
        scratchDir: scratch,
        timeoutMs: 20,
        spawn: (() => ({
          // Never settles — the hang this bound exists for.
          exited: new Promise<number>(() => undefined),
          stderr: new Response("").body,
          kill: () => {
            killed += 1;
          },
        })) as unknown as typeof Bun.spawn,
      }),
    ).rejects.toThrow(/timed out/);
    expect(killed).toBe(1);
  });
});

describe("sweepStaleScratchFiles", () => {
  test("removes an old scratch wav a dead process left behind", () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
    const old = join(scratch, "nimbus-stt-old.wav");
    writeFileSync(old, "x");
    utimesSync(old, new Date(0), new Date(0));
    expect(sweepStaleScratchFiles(scratch, Date.now())).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  test("leaves a RECENT scratch wav alone — a concurrent pass may be using it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
    const fresh = join(scratch, "nimbus-stt-fresh.wav");
    writeFileSync(fresh, "x");
    expect(sweepStaleScratchFiles(scratch, Date.now())).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  test("never touches a file it did not create", () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
    const foreign = join(scratch, "someone-elses.wav");
    writeFileSync(foreign, "x");
    utimesSync(foreign, new Date(0), new Date(0));
    expect(sweepStaleScratchFiles(scratch, Date.now())).toBe(0);
    expect(existsSync(foreign)).toBe(true);
  });

  test("returns 0 for a directory that does not exist", () => {
    expect(sweepStaleScratchFiles(join(tmpdir(), "nimbus-not-here-xyz"), Date.now())).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/stt/ffmpeg-bin.ts
/**
 * ffmpeg resolution and the transcode to whisper's expected input format (spec § 5.4).
 *
 * `whisper-cli` takes a PATH (`-f`) and wants 16 kHz 16-bit mono PCM WAV, so any compressed or
 * containerised media needs a transcode first. That is why the spec's "never written to disk" rule
 * is narrowed rather than absolute: ONE gateway-owned scratch file, 0600, deleted in a `finally`.
 *
 * NOT in `platform/`: resolving an external binary is not OS-specific logic reached through
 * `PlatformServices`. Both existing precedents keep the resolver beside its consumer —
 * `resolveWhisperBin` in `voice/stt.ts` and `computer-use/cu-lanes/chromium-path.ts`.
 */
import { chmodSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { processEnvGet } from "../../platform/env-access.ts";

export function resolveFfmpegBin(
  configuredPath?: string,
  which: (name: string) => string | null = (name) => Bun.which(name),
): string {
  if (configuredPath !== undefined && configuredPath !== "") return configuredPath;
  const envPath = processEnvGet("NIMBUS_FFMPEG_PATH");
  if (envPath !== undefined && envPath !== "") return envPath;
  if (which("ffmpeg") !== null) return "ffmpeg";
  // Bare name regardless, so the spawn failure names the missing binary rather than a path the
  // user never configured.
  return "ffmpeg";
}

export interface TranscodeOptions {
  readonly ffmpegBin: string;
  readonly scratchDir: string;
  readonly spawn?: typeof Bun.spawn;
  readonly timeoutMs?: number;
}

/** Generous: a long recording on a slow CPU is legitimate. This bounds a HANG, not slowness. */
export const DEFAULT_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Awaits `proc.exited` under a wall-clock bound, killing the process if it expires.
 *
 * `clearTimeout` runs on every path — an outstanding timer keeps `bun test` alive past the last
 * assertion, which shows up as a suite that hangs rather than one that fails.
 */
async function withProcessTimeout(
  proc: { exited: Promise<number>; kill: () => void },
  timeoutMs: number,
  label: string,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      proc.exited,
      new Promise<number>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            // Already gone.
          }
          reject(new Error(`timed out after ${timeoutMs}ms for ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      // Reap it, so a killed child is not left as a zombie for the life of the gateway.
      await proc.exited.catch(() => undefined);
    }
  }
}

/**
 * Transcodes to 16 kHz mono PCM WAV in `scratchDir` and returns the path.
 *
 * The caller is responsible for deleting it — always via {@link withScratchFile}, never by hand,
 * so the cleanup rides a `finally` rather than the happy path.
 */
export async function transcodeToWav(input: string, opts: TranscodeOptions): Promise<string> {
  const spawn = opts.spawn ?? Bun.spawn;
  const out = join(opts.scratchDir, `nimbus-stt-${crypto.randomUUID()}.wav`);
  const cmd = [
    opts.ffmpegBin,
    "-nostdin",
    "-loglevel",
    "error",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-y",
    out,
  ];
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as {
    exited: Promise<number>;
    // What Bun.spawn({stderr:"pipe"}) actually gives: a byte stream, NOT a Response.
    stderr: ReadableStream<Uint8Array>;
    kill: () => void;
  };

  // A corrupt or adversarial file can make ffmpeg loop or stall forever. Without a bound, one bad
  // artifact hangs the whole pass with no output and no way to tell it apart from slow progress.
  // Kill, then still await `exited` so the process is reaped rather than orphaned.
  const code = await withProcessTimeout(proc, opts.timeoutMs ?? DEFAULT_TRANSCODE_TIMEOUT_MS, input);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(`ffmpeg exited ${code} for ${input}: ${err.slice(0, 400)}`);
  }
  try {
    // Owner-only. No-op on Windows, which is why it is not asserted cross-platform.
    chmodSync(out, 0o600);
  } catch {
    // A filesystem that rejects chmod does not invalidate the transcode.
  }
  return out;
}

/**
 * Runs `fn` with the scratch path and deletes the file on EVERY exit path.
 *
 * The `finally` is the whole point: the narrowed disk rule (spec § 5.4) is only acceptable if the
 * file always goes away, including on a throw and on cancellation.
 */
export async function withScratchFile<T>(
  path: string,
  fn: (p: string) => Promise<T>,
): Promise<T> {
  try {
    return await fn(path);
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // force:true already swallows ENOENT; this guards an exotic EPERM from failing the pass.
    }
  }
}

/**
 * Deletes stale scratch WAVs left by a PREVIOUS gateway process.
 *
 * `withScratchFile`'s `finally` covers exceptions and rejections but NOT process death: a SIGINT,
 * a SIGKILL, or a crash mid-pass leaves the file behind. On Windows a SIGTERM is
 * `TerminateProcess`, so there is no graceful path there at all. Without this sweep those files
 * accumulate indefinitely — and they are decoded audio of the user's recordings, which is exactly
 * the artifact the narrowed disk rule (spec § 5.4) exists to keep short-lived.
 *
 * Call once at pass start. Age-bounded rather than delete-all, so it cannot remove a file a
 * CONCURRENT pass is mid-way through using.
 */
export function sweepStaleScratchFiles(
  scratchDir: string,
  nowMs: number,
  maxAgeMs = 60 * 60 * 1000,
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(scratchDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith("nimbus-stt-") || !name.endsWith(".wav")) {
      continue;
    }
    const full = join(scratchDir, name);
    try {
      if (nowMs - statSync(full).mtimeMs > maxAgeMs) {
        rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      // Raced with another sweep or another process; nothing to do.
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/stt/
git commit -m "feat(multimodal): ffmpeg resolution, WAV transcode, scratch-file lifecycle"
```

---

## Task 7: Long-form STT wrapper

**Files:**

- Create: `packages/gateway/src/multimodal/stt/long-form-stt.ts`
- Test: `packages/gateway/src/multimodal/stt/long-form-stt.test.ts`

**Interfaces:**

- Consumes: `transcodeToWav`, `withScratchFile` (Task 6); `WhisperSttProvider` from `../../voice/stt.ts`.
- Produces:
  - `interface LongFormStt { readonly isLocal: true; readonly model: string; isAvailable(): Promise<boolean>; understand(path: string): Promise<string>; }`
  - `createLongFormStt(deps: LongFormSttDeps): LongFormStt`
  - `interface LongFormSttDeps { transcribe: (wavPath: string) => Promise<{ text: string }>; isAvailable: () => Promise<boolean>; ffmpegBin: string; scratchDir: string; model: string; spawn?: typeof Bun.spawn; }`

**Note on `isLocal`:** it is the literal `true`, not a computed value. STT is local-only across all four PRs (spec § 12.7), so there is no remote STT provider whose locality could differ. If a remote tier is ever added it must derive `isLocal` rather than widen this literal.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/stt/long-form-stt.test.ts
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createLongFormStt } from "./long-form-stt.ts";

function deps(over: Partial<Parameters<typeof createLongFormStt>[0]> = {}) {
  return {
    transcribe: async () => ({ text: "hello world" }),
    isAvailable: async () => true,
    ffmpegBin: "ffmpeg",
    scratchDir: mkdtempSync(join(tmpdir(), "nimbus-lfs-")),
    model: "whisper-base",
    spawn: ((cmd: string[]) => {
      writeFileSync(cmd[cmd.length - 1] as string, "wav");
      return { exited: Promise.resolve(0), stderr: new Response("") };
    }) as unknown as typeof Bun.spawn,
    ...over,
  };
}

describe("createLongFormStt", () => {
  test("is always local", () => {
    expect(createLongFormStt(deps()).isLocal).toBe(true);
  });

  test("transcodes then transcribes, returning the text", async () => {
    const stt = createLongFormStt(deps());
    expect(await stt.understand("/in/demo.mp4")).toBe("hello world");
  });

  test("passes the TRANSCODED wav to whisper, not the original", async () => {
    let given = "";
    const stt = createLongFormStt(
      deps({
        transcribe: async (p: string) => {
          given = p;
          return { text: "t" };
        },
      }),
    );
    await stt.understand("/in/demo.mp4");
    expect(given.endsWith(".wav")).toBe(true);
    expect(given).not.toContain("demo.mp4");
  });

  test("deletes the scratch wav after success", async () => {
    let given = "";
    const stt = createLongFormStt(
      deps({
        transcribe: async (p: string) => {
          given = p;
          return { text: "t" };
        },
      }),
    );
    await stt.understand("/in/demo.mp4");
    expect(existsSync(given)).toBe(false);
  });

  test("deletes the scratch wav when transcription THROWS", async () => {
    let given = "";
    const stt = createLongFormStt(
      deps({
        transcribe: async (p: string) => {
          given = p;
          throw new Error("whisper blew up");
        },
      }),
    );
    await expect(stt.understand("/in/demo.mp4")).rejects.toThrow("whisper blew up");
    expect(given).not.toBe("");
    expect(existsSync(given)).toBe(false);
  });

  test("reports unavailability from the injected probe", async () => {
    const stt = createLongFormStt(deps({ isAvailable: async () => false }));
    expect(await stt.isAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/multimodal/stt/long-form-stt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/stt/long-form-stt.ts
/**
 * File-length transcription over the existing `WhisperSttProvider` (spec § 9.1).
 *
 * That provider takes a PATH and assumes whisper's input format, so this wrapper owns the
 * transcode and the scratch-file lifecycle and hands whisper a WAV it is guaranteed to accept.
 *
 * Everything is injected rather than constructed here: `mock.module` is process-global and leaks
 * across the combined CI test run, so DI is the house rule for anything spawning a subprocess.
 */
import { transcodeToWav, withScratchFile } from "./ffmpeg-bin.ts";

export interface LongFormSttDeps {
  /** Usually `WhisperSttProvider.transcribe`, bound. Receives the TRANSCODED wav path. */
  readonly transcribe: (wavPath: string) => Promise<{ text: string }>;
  readonly isAvailable: () => Promise<boolean>;
  readonly ffmpegBin: string;
  readonly scratchDir: string;
  readonly model: string;
  readonly spawn?: typeof Bun.spawn;
}

export interface LongFormStt {
  /**
   * Literal `true`: STT is local-only in all four PRs (spec § 12.7), so no remote STT provider
   * exists whose locality could differ. A remote tier must DERIVE this, never widen the literal.
   */
  readonly isLocal: true;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  understand(path: string): Promise<string>;
}

export function createLongFormStt(deps: LongFormSttDeps): LongFormStt {
  return {
    isLocal: true,
    model: deps.model,
    isAvailable: deps.isAvailable,
    async understand(path: string): Promise<string> {
      const wav = await transcodeToWav(path, {
        ffmpegBin: deps.ffmpegBin,
        scratchDir: deps.scratchDir,
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      });
      return withScratchFile(wav, async (p) => {
        const res = await deps.transcribe(p);
        return res.text;
      });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/stt/long-form-stt.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/stt/long-form-stt.ts packages/gateway/src/multimodal/stt/long-form-stt.test.ts
git commit -m "feat(multimodal): long-form STT wrapper over WhisperSttProvider"
```

---

## Task 8: The gate — ordered refusals and the model call

**Files:**

- Create: `packages/gateway/src/multimodal/media-gate.ts`
- Test: `packages/gateway/src/multimodal/media-gate.test.ts`

**Interfaces:**

- Consumes: `MediaCandidate`, `UnderstandOutcome`, `SkipReason` (Task 3); `LongFormStt` (Task 7).
- Produces:
  - `type GateResult = { ok: true; outcome: UnderstandOutcome } | { ok: false; reason: SkipReason }`
  - `interface MediaGateDeps { enabled: boolean; capabilityDisabled: boolean; sttFor: (m: MediaModality) => LocalUnderstander | undefined; gpu: { acquire(id: string): Promise<() => void> }; }`
  - `interface LocalUnderstander { readonly isLocal: boolean; readonly model: string; isAvailable(): Promise<boolean>; understand(path: string): Promise<string>; }`
  - `understandArtifact(candidate: MediaCandidate, path: string, deps: MediaGateDeps): Promise<GateResult>`

**This is the chokepoint.** The order in `understandArtifact` is the invariant (spec § 3.4). In this PR there is no remote arm and no grant store — step 3 is structurally unreachable because every registered understander is local — but the ordering and the refusal shape land now so PR 4 adds an arm rather than a gate.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/media-gate.test.ts
import { describe, expect, test } from "bun:test";
import { understandArtifact } from "./media-gate.ts";
import type { LocalUnderstander, MediaGateDeps } from "./media-gate.ts";
import type { MediaCandidate } from "./media-types.ts";

const CANDIDATE: MediaCandidate = {
  itemId: "filesystem:/m/a.mp4",
  service: "filesystem",
  type: "media_av",
  title: "a.mp4",
  url: null,
  modality: "av",
  sourcePath: "/m/a.mp4",
  sourceMime: null,
  sourceBytes: 10,
};

function understander(over: Partial<LocalUnderstander> = {}): LocalUnderstander {
  return {
    isLocal: true,
    model: "whisper-base",
    isAvailable: async () => true,
    understand: async () => "transcript text",
    ...over,
  };
}

function deps(over: Partial<MediaGateDeps> = {}): MediaGateDeps {
  return {
    enabled: true,
    capabilityDisabled: false,
    sttFor: () => understander(),
    gpu: { acquire: async () => () => undefined },
    ...over,
  };
}

describe("understandArtifact — ordered refusals", () => {
  test("refuses when the capability is disabled by config, before any model work", async () => {
    let touched = false;
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({ enabled: false }),
      sttFor: () => {
        touched = true;
        return understander();
      },
    });
    expect(out).toEqual({ ok: false, reason: "no_local_model" });
    expect(touched).toBe(false);
  });

  test("refuses when disabled by org policy, before any model work", async () => {
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", deps({ capabilityDisabled: true }));
    expect(out).toEqual({ ok: false, reason: "no_local_model" });
  });

  test("refuses an unresolvable modality rather than guessing", async () => {
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", deps({ sttFor: () => undefined }));
    expect(out).toEqual({ ok: false, reason: "unresolvable_modality" });
  });

  test("REFUSES rather than degrading when the local model is unavailable", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      "/m/a.mp4",
      deps({ sttFor: () => understander({ isAvailable: async () => false }) }),
    );
    expect(out).toEqual({ ok: false, reason: "no_local_model" });
  });

  test("refuses a NON-LOCAL understander with no grant — never falls back to remote", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      "/m/a.mp4",
      deps({ sttFor: () => understander({ isLocal: false }) }),
    );
    expect(out).toEqual({ ok: false, reason: "no_remote_grant" });
  });

  test("succeeds locally and reports isLocal DERIVED from the provider", async () => {
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", deps());
    expect(out).toEqual({
      ok: true,
      outcome: { text: "transcript text", model: "whisper-base", isLocal: true },
    });
  });

  test("maps a thrown understander error to transcribe_failed, not a crash", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      "/m/a.mp4",
      deps({
        sttFor: () =>
          understander({
            understand: async () => {
              throw new Error("whisper died");
            },
          }),
      }),
    );
    expect(out).toEqual({ ok: false, reason: "transcribe_failed" });
  });

  test("RELEASES the GPU lease even when the understander throws", async () => {
    let released = 0;
    await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({
        sttFor: () =>
          understander({
            understand: async () => {
              throw new Error("boom");
            },
          }),
      }),
      gpu: {
        acquire: async () => () => {
          released += 1;
        },
      },
    });
    expect(released).toBe(1);
  });

  test("acquires the GPU lease ONCE PER CALL, not once per pass", async () => {
    let acquired = 0;
    const d: MediaGateDeps = {
      ...deps(),
      gpu: {
        acquire: async () => {
          acquired += 1;
          return () => undefined;
        },
      },
    };
    await understandArtifact(CANDIDATE, "/m/a.mp4", d);
    await understandArtifact(CANDIDATE, "/m/a.mp4", d);
    expect(acquired).toBe(2);
  });

  test("does NOT acquire the GPU when it refuses before the model call", async () => {
    let acquired = 0;
    await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({ enabled: false }),
      gpu: {
        acquire: async () => {
          acquired += 1;
          return () => undefined;
        },
      },
    });
    expect(acquired).toBe(0);
  });

  /**
   * A multi-minute transcription must keep the arbiter's idle timer fresh. Without the heartbeat an
   * interactive `nimbus ask` evicts the lease AND wipes the arbiter's waiter queue.
   */
  test("heartbeats touch() while a slow understander runs", async () => {
    let touches = 0;
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({
        sttFor: () =>
          understander({
            understand: async () => {
              await Bun.sleep(60);
              return "slow transcript";
            },
          }),
      }),
      heartbeatMs: 10,
      gpu: {
        acquire: async () => () => undefined,
        touch: () => {
          touches += 1;
        },
      },
    });
    expect(out.ok).toBe(true);
    expect(touches).toBeGreaterThan(0);
  }, 10_000);

  test("stops heartbeating once the call returns — a live interval hangs the suite", async () => {
    let touches = 0;
    await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps(),
      heartbeatMs: 10,
      gpu: {
        acquire: async () => () => undefined,
        touch: () => {
          touches += 1;
        },
      },
    });
    const after = touches;
    await Bun.sleep(60);
    expect(touches).toBe(after);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/multimodal/media-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/media-gate.ts
/**
 * THE chokepoint: the only path from media bytes to a model (spec § 3.2, § 3.4).
 *
 * The ORDER below is the invariant, exactly as in I33 and I35. It ships in PR 1 with only its
 * local arm — before there is any remote path to gate — because retrofitting a chokepoint onto
 * code that already reaches the resource is how a bypass gets built. PR 4 adds an ARM here; it
 * does not introduce a gate.
 *
 * In this PR step 3 is structurally unreachable: every registered understander is local, so
 * `isLocal === false` cannot occur. It is implemented anyway, and tested with a deliberately
 * non-local fake, so the refusal exists before the thing it refuses does.
 */
import type { MediaCandidate, MediaModality, SkipReason, UnderstandOutcome } from "./media-types.ts";

export interface LocalUnderstander {
  /** DERIVED by the provider (I34). The gate READS it; it never accepts it from a caller. */
  readonly isLocal: boolean;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  understand(path: string): Promise<string>;
}

/**
 * Well inside `GpuArbiter`'s 30s idle bound, so a slow tick can never let the lease look stale.
 */
const GPU_HEARTBEAT_MS = 10_000;

export interface MediaGateDeps {
  /** `[multimodal] enabled`, default off. */
  readonly enabled: boolean;
  /** Resolved org policy (I22) disabling the capability. Checked BEFORE any model work. */
  readonly capabilityDisabled: boolean;
  readonly sttFor: (modality: MediaModality) => LocalUnderstander | undefined;
  /**
   * `touch` is optional so a test double can omit it, but production MUST pass the real
   * `GpuArbiter.touch` — without it a multi-minute transcription is evicted mid-run and takes the
   * arbiter's waiter queue with it.
   */
  readonly gpu: { acquire(id: string): Promise<() => void>; touch?: () => void };
  /**
   * Heartbeat period. Injectable ONLY so a test can observe ticks without sleeping ten seconds;
   * production leaves it unset and gets {@link GPU_HEARTBEAT_MS}.
   */
  readonly heartbeatMs?: number;
}

export type GateResult =
  | { readonly ok: true; readonly outcome: UnderstandOutcome }
  | { readonly ok: false; readonly reason: SkipReason };

export async function understandArtifact(
  candidate: MediaCandidate,
  path: string,
  deps: MediaGateDeps,
): Promise<GateResult> {
  // 0. Disabled by local config or org policy — refuse BEFORE resolving anything, so a disabled
  //    capability never announces itself by doing work.
  if (!deps.enabled || deps.capabilityDisabled) {
    return { ok: false, reason: "no_local_model" };
  }

  // 1. Resolve the provider for this modality. Absent means SKIP, never a default: guessing the
  //    modality means handing bytes to the wrong model.
  const provider = deps.sttFor(candidate.modality);
  if (provider === undefined) {
    return { ok: false, reason: "unresolvable_modality" };
  }

  // 2. Locality is DERIVED from the provider (I34), never supplied.
  // 3. Non-local requires a per-artifact grant. There is no grant store until PR 4, so a non-local
  //    provider is refused outright here — never silently allowed, never prompted from inside a
  //    pass (spec § 6.3).
  if (!provider.isLocal) {
    return { ok: false, reason: "no_remote_grant" };
  }

  // 4. A local provider that is unavailable REFUSES. It does not degrade to remote — the same
  //    fail-closed posture as `enforce_air_gap`.
  if (!(await provider.isAvailable())) {
    return { ok: false, reason: "no_local_model" };
  }

  // 5. Only now is the model contacted.
  //
  //    The GPU lease is per CALL — but for AV, ONE call is the whole file, which is minutes. That
  //    is long enough to matter: `GpuArbiter`'s 30s bound is an IDLE timer over `lastActivityAt`,
  //    evaluated lazily whenever some other caller reaches `acquire()`. So an interactive
  //    `nimbus ask` arriving mid-transcription sees a stale timestamp and calls `forceRelease()`,
  //    which does `this.queue.length = 0` — discarding every queued waiter as a promise that never
  //    settles. The pass would not merely lose the GPU; it would strand unrelated callers.
  //
  //    The heartbeat is the fix, and it is honest rather than a workaround: `touch()` means "still
  //    working", which is exactly true while the subprocess runs. `clearInterval` in the `finally`
  //    is load-bearing — an outstanding interval keeps `bun test` alive past the last assertion,
  //    which presents as a hanging suite rather than a failing one.
  const release = await deps.gpu.acquire(`multimodal:${candidate.modality}`);
  const heartbeat = setInterval(() => {
    deps.gpu.touch?.();
  }, deps.heartbeatMs ?? GPU_HEARTBEAT_MS);
  try {
    const text = await provider.understand(path);
    return { ok: true, outcome: { text, model: provider.model, isLocal: provider.isLocal } };
  } catch {
    return { ok: false, reason: "transcribe_failed" };
  } finally {
    clearInterval(heartbeat);
    release();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/media-gate.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/media-gate.ts packages/gateway/src/multimodal/media-gate.test.ts
git commit -m "feat(multimodal): media gate chokepoint with ordered fail-closed refusals"
```

---

## Task 9: Derived understanding item

**Files:**

- Create: `packages/gateway/src/multimodal/understanding-item.ts`
- Test: `packages/gateway/src/multimodal/understanding-item.test.ts`

**Interfaces:**

- Consumes: `MediaCandidate`, `UnderstandOutcome`, `UNDERSTANDING_VERSION` (Task 3).
- Produces:
  - `understandingExternalId(sourceItemId: string): string`
  - `buildUnderstandingRow(c: MediaCandidate, o: UnderstandOutcome, nowMs: number): UnderstandingRow`
  - `writeUnderstanding(db: Database, c: MediaCandidate, o: UnderstandOutcome, nowMs: number, scheduleEmbedding?: (id: string) => void): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/understanding-item.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { MediaCandidate, UnderstandOutcome } from "./media-types.ts";
import { buildUnderstandingRow, understandingExternalId, writeUnderstanding } from "./understanding-item.ts";

const CANDIDATE: MediaCandidate = {
  itemId: "filesystem:/m/standup.mp4",
  service: "filesystem",
  type: "media_av",
  title: "standup.mp4",
  url: "file:///m/standup.mp4",
  modality: "av",
  sourcePath: "/m/standup.mp4",
  sourceMime: "video/mp4",
  sourceBytes: 4096,
};

const OUTCOME: UnderstandOutcome = { text: "we shipped the gate", model: "whisper-base", isLocal: true };

describe("understandingExternalId", () => {
  test("is stable and carries NO version — a version would accumulate rows", () => {
    expect(understandingExternalId("filesystem:/m/a.mp4")).toBe("filesystem:/m/a.mp4:understanding");
    expect(understandingExternalId("filesystem:/m/a.mp4")).not.toContain("v1");
  });
});

describe("buildUnderstandingRow", () => {
  test("maps to a nimbus-service derived item of the right type", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(row.service).toBe("nimbus");
    expect(row.type).toBe("video_understanding");
  });

  test("titles with the house Transcript prefix and inherits the source url", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(row.title).toBe("Transcript — standup.mp4");
    expect(row.url).toBe("file:///m/standup.mp4");
  });

  test("an image candidate becomes a Caption", () => {
    const row = buildUnderstandingRow({ ...CANDIDATE, modality: "image" }, OUTCOME, 999);
    expect(row.type).toBe("image_understanding");
    expect(row.title).toBe("Caption — standup.mp4");
  });

  test("declares a FULL body so the prose cap applies, not the 512-char default", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(row.body).toBe("we shipped the gate");
  });

  test("carries provenance: modelDerived, model, version, isLocal, derivedFrom", () => {
    const row = buildUnderstandingRow(CANDIDATE, OUTCOME, 999);
    expect(row.metadata["modelDerived"]).toBe(true);
    expect(row.metadata["model"]).toBe("whisper-base");
    expect(row.metadata["isLocal"]).toBe(true);
    expect(row.metadata["understandingVersion"]).toBe(1);
    expect(row.metadata["derivedFrom"]).toBe("filesystem:/m/standup.mp4");
    expect(row.metadata["sourceMime"]).toBe("video/mp4");
    expect(row.metadata["sourceBytes"]).toBe(4096);
  });
});

describe("writeUnderstanding", () => {
  test("re-understanding REPLACES rather than accumulating", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    writeUnderstanding(db, CANDIDATE, OUTCOME, 1000);
    writeUnderstanding(db, CANDIDATE, { ...OUTCOME, text: "revised transcript" }, 2000);

    const rows = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service = 'nimbus' AND type = 'video_understanding'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("revised transcript");
    db.close();
  });

  test("schedules the derived item for embedding — upsertIndexedItem does not", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const scheduled: string[] = [];
    const id = writeUnderstanding(db, CANDIDATE, OUTCOME, 1000, (i) => scheduled.push(i));
    expect(scheduled).toEqual([id]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/multimodal/understanding-item.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/understanding-item.ts
/**
 * The derived understanding item (spec § 4).
 *
 * Writes via `upsertIndexedItem` DIRECTLY, not `upsertIndexedItemForSync`: that wrapper exists to
 * apply a CONNECTOR's configured index depth, and a Nimbus-derived item has no connector and so no
 * depth to apply. Every existing derived writer does the same — `glossary/glossary-project.ts`,
 * `briefs/brief-save.ts`, `clips/clip-ingest.ts`.
 *
 * The consequence to remember: only the sync wrapper calls `scheduleItemEmbedding`, so a derived
 * item that is not scheduled here is never embedded and never found by semantic search.
 */
import type { Database } from "bun:sqlite";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import { type MediaCandidate, type UnderstandOutcome, UNDERSTANDING_VERSION } from "./media-types.ts";

const SERVICE = "nimbus";

export interface UnderstandingRow {
  readonly service: string;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly modifiedAt: number;
  readonly syncedAt: number;
  readonly metadata: Record<string, unknown>;
}

/**
 * STABLE — the version is deliberately NOT in the id.
 *
 * `item` is UNIQUE(service, external_id) and upserts ON CONFLICT(id), so `…:understanding:v1` and
 * `…:understanding:v2` would be two rows, not one replaced: a stale duplicate per artifact per
 * version, producing duplicate FTS hits and duplicate agent context (spec § 4.1). The version lives
 * in metadata and discovery compares it there.
 */
export function understandingExternalId(sourceItemId: string): string {
  return `${sourceItemId}:understanding`;
}

export function buildUnderstandingRow(
  candidate: MediaCandidate,
  outcome: UnderstandOutcome,
  nowMs: number,
): UnderstandingRow {
  const isAv = candidate.modality === "av";
  return {
    service: SERVICE,
    type: isAv ? "video_understanding" : "image_understanding",
    externalId: understandingExternalId(candidate.itemId),
    // Matches `zoom:transcript`'s existing house style (`Transcript — <topic>`) so a derived row is
    // distinguishable from its source in a result list without a bracketed tag.
    title: `${isAv ? "Transcript" : "Caption"} — ${candidate.title}`,
    body: outcome.text,
    url: candidate.url,
    modifiedAt: nowMs,
    syncedAt: nowMs,
    metadata: {
      derivedFrom: candidate.itemId,
      model: outcome.model,
      // A caption or transcript is a model's ASSERTION, not an observation. This flag is what lets
      // a brief present it as such rather than citing it as authoritative (spec § 12.3).
      modelDerived: true,
      understandingVersion: UNDERSTANDING_VERSION,
      isLocal: outcome.isLocal,
      sourceMime: candidate.sourceMime,
      sourceBytes: candidate.sourceBytes,
    },
  };
}

export function writeUnderstanding(
  db: Database,
  candidate: MediaCandidate,
  outcome: UnderstandOutcome,
  nowMs: number,
  scheduleEmbedding?: (itemId: string) => void,
): string {
  const row = buildUnderstandingRow(candidate, outcome, nowMs);
  upsertIndexedItem(db, {
    service: row.service,
    type: row.type,
    externalId: row.externalId,
    title: row.title,
    // `body` (not `bodyPreview`) declares a FULL body, so `bodyCapForItemType` applies the 16 KiB
    // prose cap instead of the 512-char default. Both understanding types are prose-capped via
    // their membership in LOCAL_ONLY_PROSE_TYPES, which `body-caps.ts` unions in.
    body: row.body,
    url: row.url,
    canonicalUrl: row.url,
    modifiedAt: row.modifiedAt,
    syncedAt: row.syncedAt,
    metadata: row.metadata,
  });
  const id = itemPrimaryKey(row.service, row.externalId);
  scheduleEmbedding?.(id);
  return id;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/understanding-item.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/understanding-item.ts packages/gateway/src/multimodal/understanding-item.test.ts
git commit -m "feat(multimodal): derived understanding item with stable id and provenance"
```

---

## Task 10: Discovery

**Files:**

- Create: `packages/gateway/src/multimodal/media-discovery.ts`
- Test: `packages/gateway/src/multimodal/media-discovery.test.ts`

**Interfaces:**

- Consumes: `MediaCandidate`, `UNDERSTANDING_VERSION` (Task 3); `modalityForItem` (Task 3).
- Produces: `findCandidates(db: Database, opts: DiscoveryOptions): MediaCandidate[]`, `interface DiscoveryOptions { service?: string; modality?: MediaModality; sinceMs?: number; limit: number; afterItemId?: string; }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/media-discovery.test.ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { findCandidates } from "./media-discovery.ts";
import { writeUnderstanding } from "./understanding-item.ts";

let db: Database;

function addMedia(path: string, type = "media_av", modifiedAt = 1000): void {
  upsertIndexedItem(db, {
    service: "filesystem",
    type,
    externalId: path,
    title: path.split("/").pop() ?? path,
    bodyPreview: "",
    modifiedAt,
    syncedAt: modifiedAt,
    metadata: { path, sizeBytes: 10, mediaKind: type === "media_av" ? "av" : "image" },
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("findCandidates", () => {
  test("returns media items that have no understanding yet", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.mp4");
    expect(findCandidates(db, { limit: 10 })).toHaveLength(2);
  });

  test("excludes an item already understood at the CURRENT version", () => {
    addMedia("/m/a.mp4");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    writeUnderstanding(db, c, { text: "t", model: "m", isLocal: true }, 2000);
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
  });

  test("RE-INCLUDES an item understood at an older version", () => {
    addMedia("/m/a.mp4");
    const [c] = findCandidates(db, { limit: 10 });
    if (c === undefined) throw new Error("expected a candidate");
    writeUnderstanding(db, c, { text: "t", model: "m", isLocal: true }, 2000);
    db.run(
      "UPDATE item SET metadata = json_set(metadata, '$.understandingVersion', 0) WHERE type = 'video_understanding'",
    );
    expect(findCandidates(db, { limit: 10 })).toHaveLength(1);
  });

  test("ignores non-media item types", () => {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: "m1",
      title: "hi",
      bodyPreview: "hi",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
  });

  test("resolves modality and carries the path from metadata", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.png", "media_image");
    const byTitle = new Map(findCandidates(db, { limit: 10 }).map((c) => [c.title, c]));
    expect(byTitle.get("a.mp4")?.modality).toBe("av");
    expect(byTitle.get("b.png")?.modality).toBe("image");
    expect(byTitle.get("a.mp4")?.sourcePath).toBe("/m/a.mp4");
    expect(byTitle.get("a.mp4")?.sourceBytes).toBe(10);
  });

  test("honours the limit", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.mp4");
    addMedia("/m/c.mp4");
    expect(findCandidates(db, { limit: 2 })).toHaveLength(2);
  });

  test("filters by modality", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.png", "media_image");
    expect(findCandidates(db, { limit: 10, modality: "image" })).toHaveLength(1);
  });

  test("filters by sinceMs on modified_at", () => {
    addMedia("/m/old.mp4", "media_av", 1000);
    addMedia("/m/new.mp4", "media_av", 5000);
    const found = findCandidates(db, { limit: 10, sinceMs: 3000 });
    expect(found.map((c) => c.title)).toEqual(["new.mp4"]);
  });

  test("resumes after a cursor item id", () => {
    addMedia("/m/a.mp4");
    addMedia("/m/b.mp4");
    const all = findCandidates(db, { limit: 10 });
    const first = all[0];
    if (first === undefined) throw new Error("expected candidates");
    const rest = findCandidates(db, { limit: 10, afterItemId: first.itemId });
    expect(rest.some((c) => c.itemId === first.itemId)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/multimodal/media-discovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/media-discovery.ts
/**
 * Selects the media items that still need understanding (spec § 8).
 *
 * "Needs understanding" is a VERSION comparison, not an existence check: an item understood at an
 * older `understandingVersion` must be re-offered, which is what makes a model upgrade a re-run
 * rather than a migration (spec § 4.1).
 *
 * SQL is bound-parameter only (I9). `json_extract` on `metadata` is safe here because every row
 * this query can reach was written by `upsertIndexedItem`, which JSON-serialises metadata itself —
 * the column is never free-form text.
 */
import type { Database } from "bun:sqlite";
import { type MediaModality, type MediaCandidate, UNDERSTANDING_VERSION } from "./media-types.ts";
import { modalityForItem } from "./media-source-registry.ts";

export interface DiscoveryOptions {
  readonly service?: string;
  readonly modality?: MediaModality;
  readonly sinceMs?: number;
  readonly limit: number;
  /** Resume cursor: return only ids strictly greater than this. */
  readonly afterItemId?: string;
}

interface CandidateRow {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly metadata: string | null;
}

const MEDIA_TYPES = ["media_av", "media_image"] as const;

export function findCandidates(db: Database, opts: DiscoveryOptions): MediaCandidate[] {
  const wheres: string[] = [
    `src.type IN (${MEDIA_TYPES.map(() => "?").join(", ")})`,
    // No understanding row, OR one at an older version.
    `(u.id IS NULL OR COALESCE(json_extract(u.metadata, '$.understandingVersion'), -1) < ?)`,
  ];
  const params: (string | number)[] = [...MEDIA_TYPES, UNDERSTANDING_VERSION];

  if (opts.service !== undefined) {
    wheres.push("src.service = ?");
    params.push(opts.service);
  }
  if (opts.sinceMs !== undefined) {
    wheres.push("src.modified_at >= ?");
    params.push(opts.sinceMs);
  }
  if (opts.afterItemId !== undefined) {
    wheres.push("src.id > ?");
    params.push(opts.afterItemId);
  }

  params.push(opts.limit);

  const rows = db
    .query<CandidateRow, (string | number)[]>(
      `SELECT src.id, src.service, src.type, src.title, src.url, src.metadata
         FROM item AS src
         LEFT JOIN item AS u
           ON u.service = 'nimbus'
          AND u.external_id = src.id || ':understanding'
        WHERE ${wheres.join(" AND ")}
        ORDER BY src.id
        LIMIT ?`,
    )
    .all(...params);

  const out: MediaCandidate[] = [];
  for (const row of rows) {
    const modality = modalityForItem(row.service, row.type);
    if (modality === undefined) continue;
    if (opts.modality !== undefined && modality !== opts.modality) continue;

    const meta = parseMetadata(row.metadata);
    out.push({
      itemId: row.id,
      service: row.service,
      type: row.type,
      title: row.title,
      url: row.url,
      modality,
      sourcePath: stringOrNull(meta["path"]),
      sourceMime: stringOrNull(meta["mimeType"]),
      sourceBytes: numberOrNull(meta["sizeBytes"]),
    });
  }
  return out;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/media-discovery.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/media-discovery.ts packages/gateway/src/multimodal/media-discovery.test.ts
git commit -m "feat(multimodal): candidate discovery by understanding version"
```

---

## Task 11: Pass state and the orchestrating pass

**Files:**

- Create: `packages/gateway/src/multimodal/media-pass-state.ts`
- Create: `packages/gateway/src/multimodal/media-pass.ts`
- Test: `packages/gateway/src/multimodal/media-pass-state.test.ts`
- Test: `packages/gateway/src/multimodal/media-pass.test.ts`

**Interfaces:**

- Consumes: `findCandidates` (Task 10), `resolveLocalMediaPath` (Task 5), `understandArtifact` (Task 8), `writeUnderstanding` (Task 9).
- Produces:
  - `readCursor(db, passId): string | null`, `writeCursor(db, passId, opts): void`, `clearCursor(db, passId): void`
  - `runMediaPass(deps: MediaPassDeps): Promise<MediaPassSummary>`
  - `interface MediaPassSummary { understood: number; skipped: number; skippedByReason: Record<SkipReason, number>; lastItemId: string | null; }`

- [ ] **Step 1: Write the failing test for pass state**

```ts
// packages/gateway/src/multimodal/media-pass-state.test.ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { clearCursor, readCursor, writeCursor } from "./media-pass-state.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("media pass cursor", () => {
  test("reads null when no cursor exists", () => {
    expect(readCursor(db, "default")).toBeNull();
  });

  test("round-trips a cursor", () => {
    writeCursor(db, "default", { lastItemId: "filesystem:/m/a.mp4", processedCount: 1, nowMs: 10 });
    expect(readCursor(db, "default")).toBe("filesystem:/m/a.mp4");
  });

  test("advancing overwrites rather than inserting a second row", () => {
    writeCursor(db, "default", { lastItemId: "a", processedCount: 1, nowMs: 10 });
    writeCursor(db, "default", { lastItemId: "b", processedCount: 2, nowMs: 20 });
    expect(readCursor(db, "default")).toBe("b");
    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_pass_cursor")
      .get()?.n;
    expect(count).toBe(1);
  });

  test("clearing removes it so the next run starts from the beginning", () => {
    writeCursor(db, "default", { lastItemId: "a", processedCount: 1, nowMs: 10 });
    clearCursor(db, "default");
    expect(readCursor(db, "default")).toBeNull();
  });

  test("separate pass ids do not collide", () => {
    writeCursor(db, "images", { lastItemId: "i", processedCount: 1, nowMs: 10 });
    writeCursor(db, "av", { lastItemId: "v", processedCount: 1, nowMs: 10 });
    expect(readCursor(db, "images")).toBe("i");
    expect(readCursor(db, "av")).toBe("v");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/multimodal/media-pass-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pass state**

```ts
// packages/gateway/src/multimodal/media-pass-state.ts
/**
 * V58 cursor persistence (spec § 6.2).
 *
 * SQLite-backed rather than in-memory so an interrupted pass resumes across a gateway restart —
 * the whole point of a budgeted pass over a large library.
 *
 * Bound parameters only (I9).
 */
import type { Database } from "bun:sqlite";

export function readCursor(db: Database, passId: string): string | null {
  const row = db
    .query<{ last_item_id: string }, [string]>(
      "SELECT last_item_id FROM media_pass_cursor WHERE pass_id = ?",
    )
    .get(passId);
  return row?.last_item_id ?? null;
}

export function writeCursor(
  db: Database,
  passId: string,
  opts: { lastItemId: string; processedCount: number; nowMs: number },
): void {
  db.run(
    `INSERT INTO media_pass_cursor (pass_id, service, modality, last_item_id, processed_count, updated_at)
     VALUES (?, NULL, NULL, ?, ?, ?)
     ON CONFLICT(pass_id) DO UPDATE SET
       last_item_id = excluded.last_item_id,
       processed_count = excluded.processed_count,
       updated_at = excluded.updated_at`,
    [passId, opts.lastItemId, opts.processedCount, opts.nowMs],
  );
}

export function clearCursor(db: Database, passId: string): void {
  db.run("DELETE FROM media_pass_cursor WHERE pass_id = ?", [passId]);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/multimodal/media-pass-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for the pass**

```ts
// packages/gateway/src/multimodal/media-pass.test.ts
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { runMediaPass } from "./media-pass.ts";
import type { MediaPassDeps } from "./media-pass.ts";

let db: Database;
let root: string;

function addMediaFile(name: string): string {
  const p = join(root, name);
  writeFileSync(p, "x");
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "media_av",
    externalId: p,
    title: name,
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
  });
  return p;
}

function deps(over: Partial<MediaPassDeps> = {}): MediaPassDeps {
  return {
    db,
    roots: [root],
    limit: 100,
    maxBytes: 1_000_000,
    nowMs: () => 5000,
    passId: "default",
    gate: {
      enabled: true,
      capabilityDisabled: false,
      sttFor: () => ({
        isLocal: true,
        model: "whisper-base",
        isAvailable: async () => true,
        understand: async () => "transcript",
      }),
      gpu: { acquire: async () => () => undefined },
    },
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  root = mkdtempSync(join(tmpdir(), "nimbus-pass-"));
});

describe("runMediaPass", () => {
  test("understands each candidate and writes a derived item", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps());
    expect(summary.understood).toBe(1);

    const rows = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("transcript");
  });

  test("is idempotent — a second run understands nothing new", async () => {
    addMediaFile("a.mp4");
    await runMediaPass(deps());
    const second = await runMediaPass(deps({ passId: "second" }));
    expect(second.understood).toBe(0);
  });

  test("honours the limit budget", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    addMediaFile("c.mp4");
    expect((await runMediaPass(deps({ limit: 2 }))).understood).toBe(2);
  });

  test("a per-artifact failure does NOT abort the pass", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    let calls = 0;
    const summary = await runMediaPass(
      deps({
        gate: {
          enabled: true,
          capabilityDisabled: false,
          sttFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => {
              calls += 1;
              if (calls === 1) throw new Error("first one fails");
              return "ok";
            },
          }),
          gpu: { acquire: async () => () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(1);
    expect(summary.skippedByReason["transcribe_failed"]).toBe(1);
  });

  test("reports skips BY REASON — a bare success line is the disclosure failure", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(
      deps({ roots: [] }), // nothing is inside a configured root
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["path_outside_roots"]).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  test("refuses everything when the capability is disabled", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(
      deps({
        gate: {
          enabled: false,
          capabilityDisabled: false,
          sttFor: () => undefined,
          gpu: { acquire: async () => () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_local_model"]).toBe(1);
  });

  test("advances the cursor so an interrupted pass resumes", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps());
    expect(summary.lastItemId).not.toBeNull();
    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id).toBe(summary.lastItemId);
  });

  test("appends ZERO egress rows — this PR makes no outbound request", async () => {
    addMediaFile("a.mp4");
    await runMediaPass(deps());
    const n = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_ledger")
      .get()?.n;
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test packages/gateway/src/multimodal/media-pass.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the pass**

```ts
// packages/gateway/src/multimodal/media-pass.ts
/**
 * The budgeted, resumable understanding pass (spec § 8).
 *
 * Owner-invoked, never scheduled and never agent-callable in this slice. Shaped after
 * `nimbus index rebody`, which solved the same problem: a large recovery pass over an existing
 * index that must survive interruption.
 *
 * Two properties the tests pin, because both are easy to lose:
 *  - a per-artifact failure NEVER aborts the pass; it is recorded so a re-run retries exactly it;
 *  - the summary discloses skips BY REASON. "understood 42 of 108" with no breakdown is the
 *    disclosure failure this pass exists not to commit.
 */
import type { Database } from "bun:sqlite";
import { sweepStaleScratchFiles } from "./stt/ffmpeg-bin.ts";
import { understandArtifact, type MediaGateDeps } from "./media-gate.ts";
import { resolveLocalMediaPath } from "./media-bytes.ts";
import { findCandidates } from "./media-discovery.ts";
import type { MediaModality, SkipReason } from "./media-types.ts";
import { writeCursor } from "./media-pass-state.ts";
import { writeUnderstanding } from "./understanding-item.ts";

export interface MediaPassDeps {
  readonly db: Database;
  readonly roots: readonly string[];
  readonly limit: number;
  readonly maxBytes: number;
  readonly nowMs: () => number;
  readonly passId: string;
  readonly gate: MediaGateDeps;
  readonly service?: string;
  readonly modality?: MediaModality;
  readonly sinceMs?: number;
  readonly afterItemId?: string;
  readonly scheduleEmbedding?: (itemId: string) => void;
  /** Where transcodes land. Omitted, no start-of-pass sweep runs (unit tests that never transcode). */
  readonly scratchDir?: string;
}

export interface MediaPassSummary {
  readonly understood: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<SkipReason, number>>;
  readonly lastItemId: string | null;
}

function emptyReasons(): Record<SkipReason, number> {
  return {
    over_byte_cap: 0,
    no_local_model: 0,
    no_remote_grant: 0,
    unresolvable_modality: 0,
    fetch_miss: 0,
    path_outside_roots: 0,
    transcode_failed: 0,
    transcribe_failed: 0,
  };
}

export async function runMediaPass(deps: MediaPassDeps): Promise<MediaPassSummary> {
  // Reclaim scratch WAVs a previous gateway process died mid-write and never unwound (spec § 5.4).
  // Age-bounded, so a concurrently running pass's file is never removed under it.
  if (deps.scratchDir !== undefined) {
    sweepStaleScratchFiles(deps.scratchDir, deps.nowMs());
  }

  const candidates = findCandidates(deps.db, {
    limit: deps.limit,
    ...(deps.service === undefined ? {} : { service: deps.service }),
    ...(deps.modality === undefined ? {} : { modality: deps.modality }),
    ...(deps.sinceMs === undefined ? {} : { sinceMs: deps.sinceMs }),
    ...(deps.afterItemId === undefined ? {} : { afterItemId: deps.afterItemId }),
  });

  const reasons = emptyReasons();
  let understood = 0;
  let skipped = 0;
  let lastItemId: string | null = null;

  for (const candidate of candidates) {
    lastItemId = candidate.itemId;

    const resolved = resolveLocalMediaPath(candidate, deps.roots, deps.maxBytes);
    if (!resolved.ok) {
      reasons[resolved.reason] += 1;
      skipped += 1;
      advance(deps, lastItemId, understood + skipped);
      continue;
    }

    const result = await understandArtifact(candidate, resolved.path, deps.gate);
    if (!result.ok) {
      reasons[result.reason] += 1;
      skipped += 1;
      advance(deps, lastItemId, understood + skipped);
      continue;
    }

    writeUnderstanding(
      deps.db,
      candidate,
      result.outcome,
      deps.nowMs(),
      deps.scheduleEmbedding,
    );
    understood += 1;
    advance(deps, lastItemId, understood + skipped);
  }

  return { understood, skipped, skippedByReason: reasons, lastItemId };
}

/**
 * The cursor advances on a SKIP as well as a success. A skip that did not advance would make the
 * next resume start on the same unprocessable artifact forever.
 */
function advance(deps: MediaPassDeps, lastItemId: string, processedCount: number): void {
  writeCursor(deps.db, deps.passId, {
    lastItemId,
    processedCount,
    nowMs: deps.nowMs(),
  });
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/`
Expected: PASS — all multimodal suites, 8 tests in `media-pass.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/multimodal/media-pass-state.ts packages/gateway/src/multimodal/media-pass.ts packages/gateway/src/multimodal/media-pass-state.test.ts packages/gateway/src/multimodal/media-pass.test.ts
git commit -m "feat(multimodal): resumable budgeted understanding pass with per-reason disclosure"
```

---

## Task 12: IPC method and CLI command

**Files:**

- Create: `packages/gateway/src/ipc/media-rpc.ts`
- Create: `packages/cli/src/commands/media-cmd.ts`
- Modify: `packages/cli/src/commands/index.ts`
- Modify: `packages/cli/src/commands/help.ts`
- Test: `packages/gateway/src/ipc/media-rpc.test.ts`
- Test: `packages/cli/src/commands/media-cmd.test.ts`

**Interfaces:**

- Consumes: `runMediaPass`, `MediaPassSummary` (Task 11).
- Produces: IPC method `media.understand` with params `{ service?: string; modality?: "image" | "av"; sinceDays?: number; limit?: number }` returning `MediaPassSummary`.

**Exposure rules (verify before wiring):** `media.understand` reads local files and spawns subprocesses, so it is **LAN-forbidden** and **absent from the Tauri `ALLOWED_METHODS`**, matching how the whole `exec.*` namespace is treated. Consult the `nimbus-ipc` and `nimbus-tauri-allowlist` skills before adding it anywhere else.

- [ ] **Step 1: Write the failing IPC test**

```ts
// packages/gateway/src/ipc/media-rpc.test.ts
import { describe, expect, test } from "bun:test";
import { dispatchMediaRpc } from "./media-rpc.ts";

const SUMMARY = {
  understood: 2,
  skipped: 1,
  skippedByReason: {
    over_byte_cap: 1,
    no_local_model: 0,
    no_remote_grant: 0,
    unresolvable_modality: 0,
    fetch_miss: 0,
    path_outside_roots: 0,
    transcode_failed: 0,
    transcribe_failed: 0,
  },
  lastItemId: "filesystem:/m/a.mp4",
};

describe("dispatchMediaRpc", () => {
  test("returns undefined for an unrelated method", async () => {
    expect(
      await dispatchMediaRpc("index.rebody", {}, { runPass: async () => SUMMARY }),
    ).toBeUndefined();
  });

  test("runs the pass and returns the summary", async () => {
    const out = await dispatchMediaRpc("media.understand", {}, { runPass: async () => SUMMARY });
    expect(out).toEqual(SUMMARY);
  });

  test("passes through the limit", async () => {
    let seen: unknown = null;
    await dispatchMediaRpc(
      "media.understand",
      { limit: 5 },
      {
        runPass: async (o) => {
          seen = o;
          return SUMMARY;
        },
      },
    );
    expect(seen).toMatchObject({ limit: 5 });
  });

  test("converts sinceDays to an epoch-ms floor", async () => {
    let seen: { sinceMs?: number } = {};
    await dispatchMediaRpc(
      "media.understand",
      { sinceDays: 2 },
      {
        runPass: async (o) => {
          seen = o;
          return SUMMARY;
        },
        nowMs: () => 1_000_000_000,
      },
    );
    expect(seen.sinceMs).toBe(1_000_000_000 - 2 * 86_400_000);
  });

  test("rejects a non-numeric limit rather than coercing it", async () => {
    await expect(
      dispatchMediaRpc("media.understand", { limit: "lots" }, { runPass: async () => SUMMARY }),
    ).rejects.toThrow(/limit/);
  });

  test("rejects an unknown modality", async () => {
    await expect(
      dispatchMediaRpc(
        "media.understand",
        { modality: "smell" },
        { runPass: async () => SUMMARY },
      ),
    ).rejects.toThrow(/modality/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/ipc/media-rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dispatcher**

```ts
// packages/gateway/src/ipc/media-rpc.ts
/**
 * `media.understand` — runs the multimodal understanding pass (spec § 8).
 *
 * LAN-FORBIDDEN and absent from the Tauri allowlist: it reads local files and spawns subprocesses,
 * the same posture the whole `exec.*` namespace has. Do not add it to `ALLOWED_METHODS`.
 *
 * Params are validated, never coerced — an unparseable `limit` is a caller error, and silently
 * defaulting it would run an unbounded pass the caller thought they had bounded.
 */
import type { MediaPassSummary } from "../multimodal/media-pass.ts";
import type { MediaModality } from "../multimodal/media-types.ts";

export interface MediaRpcDeps {
  readonly runPass: (opts: {
    service?: string;
    modality?: MediaModality;
    sinceMs?: number;
    limit: number;
  }) => Promise<MediaPassSummary>;
  readonly nowMs?: () => number;
}

const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;

export async function dispatchMediaRpc(
  method: string,
  rawParams: unknown,
  deps: MediaRpcDeps,
): Promise<MediaPassSummary | undefined> {
  if (method !== "media.understand") {
    return undefined;
  }
  const params = asRecord(rawParams);

  const limit = readLimit(params["limit"]);
  const modality = readModality(params["modality"]);
  const service = typeof params["service"] === "string" ? params["service"] : undefined;
  const sinceMs = readSinceMs(params["sinceDays"], deps.nowMs ?? (() => Date.now()));

  return deps.runPass({
    limit,
    ...(service === undefined ? {} : { service }),
    ...(modality === undefined ? {} : { modality }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
  });
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readLimit(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error("media.understand: limit must be a positive integer");
  }
  return v;
}

function readModality(v: unknown): MediaModality | undefined {
  if (v === undefined || v === null) return undefined;
  if (v !== "image" && v !== "av") {
    throw new Error('media.understand: modality must be "image" or "av"');
  }
  return v;
}

function readSinceMs(v: unknown, nowMs: () => number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error("media.understand: sinceDays must be a non-negative number");
  }
  return nowMs() - v * DAY_MS;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/ipc/media-rpc.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing CLI test**

```ts
// packages/cli/src/commands/media-cmd.test.ts
import { describe, expect, test } from "bun:test";
import { parseMediaArgs, renderSummary } from "./media-cmd.ts";

describe("parseMediaArgs", () => {
  test("defaults to the understand subcommand shape", () => {
    expect(parseMediaArgs(["understand"])).toEqual({ kind: "understand", params: {} });
  });

  test("parses --limit as a number", () => {
    expect(parseMediaArgs(["understand", "--limit", "10"])).toEqual({
      kind: "understand",
      params: { limit: 10 },
    });
  });

  test("rejects a non-numeric --limit rather than defaulting", () => {
    expect(() => parseMediaArgs(["understand", "--limit", "nope"])).toThrow(/limit/);
  });

  test("parses --service and --modality", () => {
    expect(parseMediaArgs(["understand", "--service", "filesystem", "--modality", "av"])).toEqual({
      kind: "understand",
      params: { service: "filesystem", modality: "av" },
    });
  });

  test("rejects an unknown subcommand", () => {
    expect(() => parseMediaArgs(["frobnicate"])).toThrow(/unknown/i);
  });
});

describe("renderSummary", () => {
  test("names the total AND breaks skips out by reason", () => {
    const out = renderSummary({
      understood: 42,
      skipped: 2,
      skippedByReason: {
        over_byte_cap: 1,
        no_local_model: 1,
        no_remote_grant: 0,
        unresolvable_modality: 0,
        fetch_miss: 0,
        path_outside_roots: 0,
        transcode_failed: 0,
        transcribe_failed: 0,
      },
      lastItemId: "x",
    });
    expect(out).toContain("Understood 42 of 44");
    expect(out).toContain("over_byte_cap: 1");
    expect(out).toContain("no_local_model: 1");
    // Zero-count reasons are noise, not disclosure.
    expect(out).not.toContain("fetch_miss");
  });

  test("says so plainly when nothing was skipped", () => {
    const out = renderSummary({
      understood: 3,
      skipped: 0,
      skippedByReason: {
        over_byte_cap: 0,
        no_local_model: 0,
        no_remote_grant: 0,
        unresolvable_modality: 0,
        fetch_miss: 0,
        path_outside_roots: 0,
        transcode_failed: 0,
        transcribe_failed: 0,
      },
      lastItemId: "x",
    });
    expect(out).toContain("Understood 3 of 3");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test packages/cli/src/commands/media-cmd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the CLI**

```ts
// packages/cli/src/commands/media-cmd.ts
/**
 * `nimbus media understand` — the owner-invoked multimodal understanding pass.
 *
 * Argument parsing and summary rendering are pure and exported so they can be tested without a
 * gateway: the dispatcher-driven path uses DI rather than `mock.module`, which is process-global
 * and leaks across the combined CI test run.
 */

export type SkipReasonKey =
  | "over_byte_cap"
  | "no_local_model"
  | "no_remote_grant"
  | "unresolvable_modality"
  | "fetch_miss"
  | "path_outside_roots"
  | "transcode_failed"
  | "transcribe_failed";

export interface CliSummary {
  readonly understood: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<SkipReasonKey, number>>;
  readonly lastItemId: string | null;
}

export interface ParsedMediaArgs {
  readonly kind: "understand";
  readonly params: {
    service?: string;
    modality?: "image" | "av";
    sinceDays?: number;
    limit?: number;
  };
}

export function parseMediaArgs(argv: readonly string[]): ParsedMediaArgs {
  const sub = argv[0];
  if (sub !== "understand") {
    throw new Error(`nimbus media: unknown subcommand "${sub ?? ""}" (expected "understand")`);
  }
  const params: ParsedMediaArgs["params"] = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`nimbus media: ${flag ?? ""} requires a value`);
    }
    switch (flag) {
      case "--service":
        params.service = value;
        break;
      case "--modality":
        if (value !== "image" && value !== "av") {
          throw new Error('nimbus media: --modality must be "image" or "av"');
        }
        params.modality = value;
        break;
      case "--limit": {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error("nimbus media: --limit must be a positive integer");
        }
        params.limit = n;
        break;
      }
      case "--since": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error("nimbus media: --since must be a non-negative number of days");
        }
        params.sinceDays = n;
        break;
      }
      default:
        throw new Error(`nimbus media: unknown flag "${flag ?? ""}"`);
    }
  }
  return { kind: "understand", params };
}

/**
 * Reports the total AND the per-reason breakdown. A bare "Understood 42" is precisely the
 * disclosure failure the pass exists not to commit (spec § 8) — the reader cannot tell whether the
 * other 66 were absent, too large, or silently refused.
 */
export function renderSummary(summary: CliSummary): string {
  const total = summary.understood + summary.skipped;
  const lines = [`Understood ${summary.understood} of ${total}.`];
  const reasons = Object.entries(summary.skippedByReason).filter(([, n]) => n > 0);
  if (reasons.length > 0) {
    lines.push("Skipped:");
    for (const [reason, n] of reasons) {
      lines.push(`  ${reason}: ${n}`);
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `bun test packages/cli/src/commands/media-cmd.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Add the runner that actually calls the gateway**

`parseMediaArgs` and `renderSummary` are pure and unit-tested; nothing yet connects them to IPC.
Add the runner to the same file, following `runIndexCmd` / `runRebody` in
`packages/cli/src/commands/index-cmd.ts` — read those first; this is the shape the CLI registry
expects (`runXCmd(args: string[]): Promise<void>`), and `withGatewayIpc` from
`packages/cli/src/lib/with-gateway-ipc.ts` is how every other command gets a client.

```ts
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export async function runMediaCmd(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printMediaHelp();
    return;
  }
  const isJson = args.includes("--json");
  const parsed = parseMediaArgs(args.filter((a) => a !== "--json"));

  const summary = await withGatewayIpc((c) =>
    c.call<CliSummary>("media.understand", parsed.params),
  );

  process.stdout.write(isJson ? `${JSON.stringify(summary)}\n` : `${renderSummary(summary)}\n`);
}
```

Match `withGatewayIpc`'s and the IPC client's real signatures — read both files rather than
trusting the sketch above; `c.call` in particular has varied.

`printMediaHelp` prints the subcommand, the four flags, and the two facts a user needs before
running it: understanding is **local-models-only**, and the pass is **resumable**.

Note the deliberate asymmetry with `nimbus index rebody`, which requires `--yes` before a non-dry
run: `rebody` triggers real outbound network traffic against connectors, so a confirmation is
warranted. This pass makes **no** network request at all, so a confirmation gate here would be
ceremony that teaches users to type `--yes` without reading.

- [ ] **Step 10: Register the command**

In `packages/cli/src/commands/index.ts`, re-export `runMediaCmd` and add `media` to the command registry beside the existing entries, following the exact shape the neighbouring commands use (read the file first — the registry shape has changed over time and this plan does not restate it).

In `packages/cli/src/commands/help.ts`, add beside the `nimbus index rebody` line:

```text
  nimbus media understand …  Transcribe/caption indexed local media (local models only)
```

- [ ] **Step 11: Run the CLI suites**

Run: `bun test packages/cli/src/commands/`
Expected: PASS. `readme-cli` drift checks assert help output matches the documented command list, so a missing help line fails here.

- [ ] **Step 12: Commit**

```bash
git add packages/gateway/src/ipc/media-rpc.ts packages/gateway/src/ipc/media-rpc.test.ts packages/cli/src/commands/
git commit -m "feat(multimodal): media.understand IPC and nimbus media understand CLI"
```

---

## Task 12b: Register the dispatcher and construct the real deps

**Files:**

- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (import + a dispatch function, following the `index.rebody` block at ~:605-630)
- Create: `packages/gateway/src/multimodal/build-media-pass-deps.ts`
- Test: `packages/gateway/src/multimodal/build-media-pass-deps.test.ts`

**Interfaces:**

- Consumes: `runMediaPass`, `MediaPassDeps` (Task 11); `dispatchMediaRpc`, `MediaRpcDeps` (Task 12); `createLongFormStt` (Task 7); `resolveFfmpegBin` (Task 6).
- Produces: `buildMediaPassDeps(input: BuildMediaPassDepsInput): Omit<MediaPassDeps, "limit" | "service" | "modality" | "sinceMs">`, and a reachable `media.understand` IPC method.

**This task exists because without it the feature is unreachable.** Task 12 creates
`ipc/media-rpc.ts`, but nothing adds it to `ipc/server/dispatchers.ts`, where every dispatcher is
wired. And no task constructs the pass's real dependencies — the configured `[[filesystem.roots]]`,
a `WhisperSttProvider`, the shared `GpuArbiter`, a scratch directory. As the plan stood,
`nimbus media understand` would reach the gateway and get "method not found" while every unit test
stayed green. This is the same dead-wiring defect the plan review caught in Task 4
(`upsertMediaFiles` was never called), one layer up. Read `ipc/server/dispatchers.ts` around the
`index.rebody` block before writing anything — that block is the shape to copy.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/multimodal/build-media-pass-deps.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { buildMediaPassDeps } from "./build-media-pass-deps.ts";

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

describe("buildMediaPassDeps", () => {
  test("passes the configured roots through", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: ["/a", "/b"],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.roots).toEqual(["/a", "/b"]);
  });

  test("supplies an AV understander and none for image — PR 1 has no VLM", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.gate.sttFor("av")).toBeDefined();
    expect(deps.gate.sttFor("image")).toBeUndefined();
  });

  test("the AV understander declares itself LOCAL", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.gate.sttFor("av")?.isLocal).toBe(true);
  });

  test("propagates the disabled flags into the gate, so the gate refuses", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: false,
      capabilityDisabled: true,
      scratchDir: "/scratch",
    });
    expect(deps.gate.enabled).toBe(false);
    expect(deps.gate.capabilityDisabled).toBe(true);
  });

  test("wires a REAL touch() — without it a long transcription is evicted mid-run", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(typeof deps.gate.gpu.touch).toBe("function");
  });

  test("passes the scratch directory through, so the start-of-pass sweep runs", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.scratchDir).toBe("/scratch");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/multimodal/build-media-pass-deps.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

```ts
// packages/gateway/src/multimodal/build-media-pass-deps.ts
/**
 * Constructs the production dependencies for the understanding pass.
 *
 * Separate from `media-pass.ts` so the pass stays a pure orchestrator over injected seams and can
 * be tested without a whisper binary, an arbiter or a config. This is the one place that knows
 * what the real implementations are.
 *
 * `sttFor("image")` returns undefined DELIBERATELY: PR 1 ships no VLM, so an image candidate is
 * skipped as `unresolvable_modality` rather than mis-handed to the STT path. PR 2 adds that arm.
 */
import type { Database } from "bun:sqlite";
import { GpuArbiter } from "../llm/gpu-arbiter.ts";
import { WhisperSttProvider } from "../voice/stt.ts";
import type { LocalUnderstander } from "./media-gate.ts";
import type { MediaPassDeps } from "./media-pass.ts";
import type { MediaModality } from "./media-types.ts";
import { resolveFfmpegBin } from "./stt/ffmpeg-bin.ts";
import { createLongFormStt } from "./stt/long-form-stt.ts";

export interface BuildMediaPassDepsInput {
  readonly db: Database;
  readonly roots: readonly string[];
  readonly enabled: boolean;
  readonly capabilityDisabled: boolean;
  readonly scratchDir: string;
  readonly maxBytes?: number;
  /** Shared with the LLM runtime when one exists, so media and generation contend on one lock. */
  readonly gpu?: GpuArbiter;
  readonly whisperBin?: string;
  readonly ffmpegBin?: string;
}

/** 250 MB (spec § 5.3 `max_media_bytes`). */
const DEFAULT_MAX_MEDIA_BYTES = 250 * 1024 * 1024;

export type BuiltMediaPassDeps = Omit<
  MediaPassDeps,
  "limit" | "service" | "modality" | "sinceMs" | "afterItemId"
>;

export function buildMediaPassDeps(input: BuildMediaPassDepsInput): BuiltMediaPassDeps {
  const whisper = new WhisperSttProvider(
    input.whisperBin === undefined ? {} : { whisperBin: input.whisperBin },
  );
  const stt = createLongFormStt({
    transcribe: (wavPath: string) => whisper.transcribe(wavPath),
    isAvailable: () => whisper.isAvailable(),
    ffmpegBin: resolveFfmpegBin(input.ffmpegBin),
    scratchDir: input.scratchDir,
    model: "whisper-cli",
  });

  const arbiter = input.gpu ?? new GpuArbiter();

  return {
    db: input.db,
    roots: input.roots,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    nowMs: () => Date.now(),
    passId: "default",
    scratchDir: input.scratchDir,
    gate: {
      enabled: input.enabled,
      capabilityDisabled: input.capabilityDisabled,
      sttFor: (modality: MediaModality): LocalUnderstander | undefined =>
        modality === "av" ? stt : undefined,
      gpu: {
        acquire: (id: string) => arbiter.acquire(id),
        // Load-bearing: a multi-minute transcription without a heartbeat is evicted by the
        // arbiter's idle timer, and `forceRelease()` wipes the waiter queue with it.
        touch: () => arbiter.touch(),
      },
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/multimodal/build-media-pass-deps.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Register the dispatcher**

In `packages/gateway/src/ipc/server/dispatchers.ts`, follow the `index.rebody` block (~:605-630)
exactly — read it first. Add the import beside the other RPC imports, then a dispatch function that
returns the skip sentinel for any other method, throws `RpcMethodError(-32603, …)` when
`ctx.options.localIndex` is undefined, and otherwise calls `dispatchMediaRpc`. Register it in the
same chain the neighbouring dispatchers are registered in.

The pass's config inputs come from the gateway config already available on `ctx.options`: the
`[[filesystem.roots]]` paths, and `[multimodal] enabled` (**default false**). Read how a
neighbouring dispatcher reaches config rather than inventing an accessor. `scratchDir` is a
Nimbus-owned temp directory — reuse the gateway's existing temp/config-dir helper rather than
calling `os.tmpdir()` directly, so the file lands somewhere the gateway owns.

**`media.understand` is LAN-forbidden and must NOT be added to the Tauri `ALLOWED_METHODS`.** It
reads local files and spawns subprocesses — the same posture as the whole `exec.*` namespace. If a
LAN-method allow-list exists in this file's neighbourhood, confirm the method is absent from it.

- [ ] **Step 6: Verify the method is reachable and correctly exposed**

Run: `bun test packages/gateway/src/ipc/`
Expected: PASS. Several suites assert method-count and exposure invariants; if one fails on a count,
update the count only after confirming the new method belongs on that surface.

Run: `bun test packages/gateway/src/security-invariants.test.ts`
Expected: PASS — I7 (Tauri allowlist) must not have gained `media.understand`.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/multimodal/build-media-pass-deps.ts packages/gateway/src/multimodal/build-media-pass-deps.test.ts packages/gateway/src/ipc/server/dispatchers.ts
git commit -m "feat(multimodal): wire media.understand into the IPC dispatcher chain"
```

---

## Task 13: Zero-egress integration test with a positive control

**Files:**

- Create: `packages/gateway/test/integration/multimodal/local-pass-zero-egress.test.ts`

**Interfaces:**

- Consumes: `runMediaPass` (Task 11).
- Produces: nothing consumed by later tasks.

**Why this task is separate:** "the local pass appends zero egress rows" passes for *any* reason, including a test that never reached a model at all. The positive control is what makes it a real test. This mirrors `packages/gateway/test/integration/computer-use/terminal-loopback.test.ts`, which ran the same command through an unconfined shell first precisely so that "zero server hits" could not pass vacuously.

- [ ] **Step 1: Write the test — control first, then the claim**

```ts
// packages/gateway/test/integration/multimodal/local-pass-zero-egress.test.ts
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { runMediaPass } from "../../../src/multimodal/media-pass.ts";
import type { MediaGateDeps } from "../../../src/multimodal/media-gate.ts";

let db: Database;
let root: string;

function addMedia(name: string): void {
  const p = join(root, name);
  writeFileSync(p, "x");
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "media_av",
    externalId: p,
    title: name,
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
  });
}

function countEgress(): number {
  return (
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_ledger").get()?.n ?? 0
  );
}

function gate(isLocal: boolean, onCall: () => void): MediaGateDeps {
  return {
    enabled: true,
    capabilityDisabled: false,
    sttFor: () => ({
      isLocal,
      model: isLocal ? "whisper-base" : "remote-stt",
      isAvailable: async () => true,
      understand: async () => {
        onCall();
        return "transcript";
      },
    }),
    gpu: { acquire: async () => () => undefined },
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  root = mkdtempSync(join(tmpdir(), "nimbus-egress-"));
});

describe("local understanding pass — egress", () => {
  /**
   * POSITIVE CONTROL. Without this, "zero rows" below would pass even if the pass never reached a
   * model, never read a file, or silently found no candidates. This asserts the pass DOES do work
   * and DOES reach the understander — so the zero-row assertion afterwards means something.
   */
  test("control: the pass genuinely reaches the understander and produces a derived item", async () => {
    addMedia("a.mp4");
    let called = 0;
    const summary = await runMediaPass({
      db,
      roots: [root],
      limit: 10,
      maxBytes: 1_000_000,
      nowMs: () => 5000,
      passId: "control",
      gate: gate(true, () => {
        called += 1;
      }),
    });

    expect(called).toBe(1);
    expect(summary.understood).toBe(1);
    const derived = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .get()?.n;
    expect(derived).toBe(1);
  });

  /**
   * The claim. Given the control above proves the pass did real work, a zero count here means no
   * outbound request was made — not that nothing happened.
   */
  test("a fully local pass appends ZERO egress rows", async () => {
    addMedia("a.mp4");
    addMedia("b.mp4");
    expect(countEgress()).toBe(0);

    await runMediaPass({
      db,
      roots: [root],
      limit: 10,
      maxBytes: 1_000_000,
      nowMs: () => 5000,
      passId: "claim",
      gate: gate(true, () => undefined),
    });

    expect(countEgress()).toBe(0);
  });

  /**
   * The gate refuses a non-local understander outright in PR 1 (no grant store exists yet), so it
   * must never reach the model AND must never ledger. This pins that the refusal happens BEFORE
   * the model call rather than after it.
   */
  test("a non-local understander is refused before contact, and still appends nothing", async () => {
    addMedia("a.mp4");
    let called = 0;
    const summary = await runMediaPass({
      db,
      roots: [root],
      limit: 10,
      maxBytes: 1_000_000,
      nowMs: () => 5000,
      passId: "remote",
      gate: gate(false, () => {
        called += 1;
      }),
    });

    expect(called).toBe(0);
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_remote_grant"]).toBe(1);
    expect(countEgress()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test packages/gateway/test/integration/multimodal/local-pass-zero-egress.test.ts`
Expected: PASS (3 tests). If the control test fails, the zero-egress assertions are meaningless — fix the control before trusting anything else in this file.

- [ ] **Step 3: Red-prove the control**

Temporarily change the control test's `expect(called).toBe(1)` to `expect(called).toBe(0)` and re-run. It must FAIL. If it passes, the pass is not reaching the understander at all and the whole suite is vacuous. Revert the change.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/integration/multimodal/
git commit -m "test(multimodal): zero-egress claim with a positive control"
```

---

## Task 14: Documentation and full pre-flight

**Files:**

- Modify: `docs/CHANGELOG.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/roadmap.md` (S2 multimodal row)
- Modify: `CLAUDE.md` and `GEMINI.md` (schema version V58; S2 row status)

- [ ] **Step 1: Update the CLI reference**

Add a `nimbus media understand` section documenting `--service`, `--modality`, `--limit`, `--since`, that it is **local-models-only**, that it is resumable, and that it reports skips by reason.

- [ ] **Step 2: Update the roadmap row**

In `docs/roadmap.md` § Active, mark the Multimodal I/O row as partially delivered and state the bounds verbatim from the spec rather than paraphrasing:

- PR 1 covers **local audio/video only**; images land in PR 2 and cloud artifacts in PR 3.
- **Phase 14's Core acceptance criterion is NOT yet met** — it requires a frame caption, which needs the VLM (PR 2) plus ffmpeg frame extraction.
- **Diarization is scoped out**, because `whisper-cli` does not do it.
- STT is **local-only**; there is no remote transcription tier.

- [ ] **Step 3: Update the mirrored status surfaces**

In both `CLAUDE.md` and `GEMINI.md`, update the schema version to **V58** and the S2 row status. Both files must change together — they mirror each other by convention and a drift audit compares them.

- [ ] **Step 4: Add a CHANGELOG entry**

Follow the existing dated-entry format in `docs/CHANGELOG.md`.

- [ ] **Step 5: Run the full pre-flight**

Run: `bun run preflight`
Expected: all gates green. Specifically confirm:

- `audit:doc-refs` — every path cited in the new docs resolves.
- `audit:status-drift` — the mirrored status surfaces agree.
- `audit:cross-platform` — no Windows-separator path assertions (the tests here split on `/[\\/]/` deliberately).
- `audit:any` — no `any` introduced.

Fix any failure locally. Do not push with a red gate.

- [ ] **Step 6: Verify on Linux**

Run: `bun run verify:docker --changed`
Expected: PASS. A green `--changed` run is evidence about the changed files, not about the whole suite — it cannot reproduce cross-file `mock.module` contamination.

- [ ] **Step 7: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md
git commit -m "docs: multimodal PR 1 — local audio/video understanding"
```

---

## Self-Review Notes

**Spec coverage.** § 3.1 placement → Tasks 3–11 (PR 1 files only; `media-consent-broker.ts`, `media-grant-store.ts`, `vlm/`, `vlm-egress.ts` are PR 2/PR 4). § 3.3 gate-first → Task 8. § 3.4 order → Task 8 tests, one per step. § 4 storage → Task 9. § 4.0 write path → Task 9. § 4.1 stable id → Task 9. § 5.1 root validation → Task 5. § 5.3 caps → Tasks 5, 11. § 5.4 scratch file → Tasks 6, 7. § 7 zero egress → Task 13. § 8 pass + disclosure → Tasks 11, 12. § 8.1 per-call GPU lease → Task 8. § 9.1 STT → Task 7. § 9.1.1 ffmpeg resolution → Task 6. § 11.1 positive control → Task 13. § 11.4 routing membership → Task 2. § 12.4 walk cap → Task 4.

**Deliberately deferred to later PRs, with the spec section that owns each:** § 4.2 orphan pruning (needs the source-deletion hook; PR 2), § 6 consent surfaces and § 6.4 batch granting (PR 4), § 9.2 the VLM seam and § 8's frame sampling (PR 2), § 5.2 cloud arm (PR 3), § 10 I37/D27/D22(g) (PR 4 — the invariant guards a remote arm that does not exist until then, and landing an enforcement test for an unreachable path would be a test that cannot fail).

**Review round 2 (2026-09-02) changed the shape of Task 4.** It had `upsertMediaFiles(db, …)`
taking a raw `Database` and was never wired into `createFilesystemV2Syncable.sync()` — so the
feature would have found zero candidates on every real database while every unit test passed, and
the signature is one static rule D24 forbids outright (`SyncContext` exposes no `db`). Task 4 is now
three: the walk (4), the `media_index` config toggle (4b), and the `ctx.upsertItem` sync wiring
(4c), with an `audit:structure` step so a reach for a raw handle fails before the tests do.

**Known gap this plan does not close:** `media-gate.ts` step 3's non-local branch is unreachable in production in PR 1, since every registered understander is local. It is tested with a deliberately non-local fake. That is the intended state — the gate exists before the arm it will gate — but it means the branch's *production* behaviour is first exercised in PR 4.
