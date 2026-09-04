# Multimodal PR 3 — Cloud Byte-Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the media understanding pass reach artifacts stored in Google Photos, Google Drive and OneDrive, not only files under `[[filesystem.roots]]` — and fix four defects in the already-shipped PR 1/PR 2 code that the cloud arm would otherwise ride on top of.

**Architecture:** A new `multimodal/cloud-bytes.ts` owns dispatch, byte caps, the scratch-file lifecycle, the streaming budget and the `sync`-class egress append. Per-service URL resolution lives next to each connector's existing sync module, reached through a `fetchBytes` capability minted in `sync/sync-capabilities.ts`. Byte acquisition returns a union — bytes in memory for images, a scratch path for audio/video — because `whisper-cli` takes a path. No remote model is added, so no new egress class and no new invariant.

**Tech Stack:** Bun 1.2+ / TypeScript strict, `bun:sqlite`, `bun test`, Biome. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`](../specs/2026-09-02-s2-multimodal-io-design.md) — § 16 (PR 3 design) and § 17 (review disposition). Review: [`2026-09-04-s2-multimodal-io-design-review.md`](../specs/2026-09-04-s2-multimodal-io-design-review.md).

## Global Constraints

- **No `any`.** External data is `unknown` and narrowed with a real guard, never a type assertion.
- **Bound-parameter SQL only** (I9). Identifiers via `escapeIdentifier`. Never string-concatenate a value into SQL.
- **Every outbound request appends one `sync`-class `egress_ledger` row BEFORE the request, fail-closed** (I29). An append failure aborts the fetch.
- **A credential is attached only to a URL this codebase constructed itself** (§ 16.4). Provider-returned URLs are pre-signed, fetched with **no** `Authorization` header, and pinned to `https:`.
- **Per-artifact byte caps refuse, never truncate** (§ 5.3). Half an image is not a smaller image.
- **Cross-platform:** build paths with `path.join()` / `os.tmpdir()`. `bun run audit:cross-platform` flags Windows-separator assertions.
- **Branch:** `dev/asaf/multimodal-pr3-cloud-byte-fetch` (already created, two design commits on it). Never commit on `main`.
- **Before finishing any task:** `bun run preflight:fast`. Before the PR: `bun run preflight`.
- **Default-off is unchanged.** `[multimodal] enabled` and per-root `media_index` both stay `false` by default; this PR adds no new way to turn the subsystem on.

---

## File Structure

**Modified — shipped code being corrected (Tasks 1–5):**
- `packages/gateway/src/multimodal/media-source-registry.ts` — gains a per-service size accessor and the mime-keyed modality arm
- `packages/gateway/src/multimodal/media-discovery.ts` — SQL mime predicate; size read through the accessor
- `packages/gateway/src/multimodal/media-pass.ts` — orphan prune at start; `stopReason` / `cloudBytesFetched`
- `packages/gateway/src/multimodal/stt/ffmpeg-bin.ts` — sweeper matches two prefixes

**Created:**
- `packages/gateway/src/multimodal/orphan-prune.ts` — deletes derived rows whose source is gone
- `packages/gateway/src/util/safe-fetch.ts` — moved from `share/`, plus redirect-safe following
- `packages/gateway/src/multimodal/cloud-bytes.ts` — the cloud arm
- `packages/gateway/src/multimodal/cloud-renditions.ts` — per-service rendition selection, pure

**Modified — connectors and wiring (Tasks 8–11):**
- `packages/gateway/src/connectors/{google-photos,google-drive,onedrive}-sync.ts` — one byte-URL resolver export each
- `packages/gateway/src/sync/sync-capabilities.ts` — the `fetchBytes` capability
- `packages/gateway/src/multimodal/{media-bytes,media-gate,multimodal-config,build-media-pass-deps}.ts`
- `packages/cli/src/commands/media-cmd.ts`, `packages/gateway/src/ipc/media-rpc.ts`

Each file keeps one responsibility: the registry knows *what is media*, `cloud-bytes.ts` knows *how to get bytes*, `cloud-renditions.ts` knows *which URL*, the gate knows *whether a model may be contacted*.

---

### Task 1: Per-service source-size resolution

`media-discovery.ts` reads `metadata.sizeBytes`. Only the filesystem connector writes that key. Drive writes `size` as a **string** (the Drive API returns int64 as a string), OneDrive writes `size` as a number, Photos writes nothing. So `sourceBytes` is `null` for every cloud candidate — silently, on two independent counts — and § 16.9's pre-flight budget layer would be decoration.

**Files:**
- Modify: `packages/gateway/src/multimodal/media-source-registry.ts`
- Modify: `packages/gateway/src/multimodal/media-discovery.ts:88` (the `sourceBytes` line)
- Test: `packages/gateway/src/multimodal/media-source-registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function mediaSourceBytes(service: string, metadata: Record<string, unknown>): number | null`

- [ ] **Step 1: Write the failing test**

In `media-source-registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mediaSourceBytes } from "./media-source-registry.ts";

describe("mediaSourceBytes", () => {
  test("filesystem reads sizeBytes as a number", () => {
    expect(mediaSourceBytes("filesystem", { sizeBytes: 1234 })).toBe(1234);
  });

  test("google_drive coerces its STRING size — the Drive API returns int64 as a string", () => {
    expect(mediaSourceBytes("google_drive", { size: "8388608" })).toBe(8388608);
  });

  test("onedrive reads its numeric size", () => {
    expect(mediaSourceBytes("onedrive", { size: 4096 })).toBe(4096);
  });

  test("google_photos has no size at all — null, not zero", () => {
    expect(mediaSourceBytes("google_photos", { width: "4032", height: "3024" })).toBeNull();
  });

  test("a non-numeric string is null, not NaN", () => {
    expect(mediaSourceBytes("google_drive", { size: "not-a-number" })).toBeNull();
  });

  test("an unknown service is null rather than guessing a key", () => {
    expect(mediaSourceBytes("slack", { size: 99 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/media-source-registry.test.ts`
Expected: FAIL — `mediaSourceBytes` is not exported.

- [ ] **Step 3: Implement**

Append to `media-source-registry.ts`:

```ts
/**
 * Where a service records its artifact's byte size, and in what type.
 *
 * Not one key: `filesystem` writes `sizeBytes` (number), Drive and OneDrive both write `size` but
 * Drive's is a STRING, because the Drive v3 API serialises int64 as a string. A plain numeric read
 * of that field returns null silently, which degrades the byte budget rather than breaking
 * anything visibly — which is exactly why this is a named table and not an inline read.
 *
 * A service absent from this map has no size to read. `google_photos` is deliberately absent:
 * `mediaMetadata` carries width and height and no byte count, so its size is genuinely unknown and
 * must be reported as unknown rather than estimated (spec § 16.9).
 */
const SOURCE_BYTES_KEY: ReadonlyMap<string, { readonly key: string; readonly numeric: boolean }> =
  new Map([
    ["filesystem", { key: "sizeBytes", numeric: true }],
    ["google_drive", { key: "size", numeric: false }],
    ["onedrive", { key: "size", numeric: true }],
  ]);

export function mediaSourceBytes(
  service: string,
  metadata: Record<string, unknown>,
): number | null {
  const spec = SOURCE_BYTES_KEY.get(service);
  if (spec === undefined) return null;

  const raw = metadata[spec.key];
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (!spec.numeric && typeof raw === "string" && raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}
```

- [ ] **Step 4: Wire it into discovery**

In `media-discovery.ts`, replace the `sourceBytes` line in the candidate loop:

```ts
      sourceBytes: mediaSourceBytes(row.service, meta),
```

and add `mediaSourceBytes` to the existing import from `./media-source-registry.ts`. Leave `numberOrNull` in place — `parseMetadata` still uses `stringOrNull`, and removing an unused helper is a separate concern; if Biome flags `numberOrNull` as unused, delete it in this same step.

- [ ] **Step 5: Run the full multimodal suite**

Run: `bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/media-source-registry.ts packages/gateway/src/multimodal/media-source-registry.test.ts packages/gateway/src/multimodal/media-discovery.ts
git commit -m "fix(multimodal): resolve source byte size per service"
```

---

### Task 2: Orphan pruning — make § 4.2 true

Spec § 4.2 states "Deleting a source item deletes its derived understanding row." `understanding-item.ts:64` writes `derivedFrom`, and **nothing in the codebase reads it**. The claim has been inert since PR 1. PR 3 makes orphans common, because a cloud item can leave the index without any local file being touched.

**Files:**
- Create: `packages/gateway/src/multimodal/orphan-prune.ts`
- Create: `packages/gateway/src/multimodal/orphan-prune.test.ts`
- Modify: `packages/gateway/src/multimodal/media-pass.ts` (call at pass start)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function pruneOrphanedUnderstandings(db: Database): number` — returns the number of rows deleted.

- [ ] **Step 1: Write the failing test**

`orphan-prune.test.ts`. Use the project's real-SQLite integration convention — no DB-layer mocks:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { pruneOrphanedUnderstandings } from "./orphan-prune.ts";

function seed(db: Database): void {
  db.exec(`CREATE TABLE item (
    id TEXT PRIMARY KEY, service TEXT NOT NULL, external_id TEXT NOT NULL,
    type TEXT NOT NULL, metadata TEXT
  )`);
}

function insert(db: Database, id: string, service: string, type: string, meta: object): void {
  db.query("INSERT INTO item (id, service, external_id, type, metadata) VALUES (?, ?, ?, ?, ?)")
    .run(id, service, id, type, JSON.stringify(meta));
}

describe("pruneOrphanedUnderstandings", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    seed(db);
  });

  test("deletes a derived row whose source is gone", () => {
    insert(db, "nimbus:vid1:understanding", "nimbus", "video_understanding", {
      derivedFrom: "filesystem:vid1",
    });
    expect(pruneOrphanedUnderstandings(db)).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 0 });
  });

  test("keeps a derived row whose source still exists", () => {
    insert(db, "filesystem:vid1", "filesystem", "media_av", {});
    insert(db, "nimbus:vid1:understanding", "nimbus", "video_understanding", {
      derivedFrom: "filesystem:vid1",
    });
    expect(pruneOrphanedUnderstandings(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 2 });
  });

  test("never touches a non-understanding nimbus row", () => {
    insert(db, "nimbus:clip1", "nimbus", "web_clip", { derivedFrom: "gone" });
    expect(pruneOrphanedUnderstandings(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 1 });
  });

  test("a derived row with no derivedFrom is left alone rather than deleted", () => {
    insert(db, "nimbus:orphan:understanding", "nimbus", "image_understanding", {});
    expect(pruneOrphanedUnderstandings(db)).toBe(0);
  });
});
```

The last case matters: a NULL `derivedFrom` must not be treated as "source missing", or a metadata-shape change would silently delete every derived row.

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/orphan-prune.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/orphan-prune.ts
/**
 * Deletes derived understanding rows whose source item has left the index (spec § 4.2).
 *
 * § 4.2 has claimed this behaviour since PR 1 and nothing implemented it: `derivedFrom` was
 * written and never read. Run at pass start rather than as a cascade in every delete path —
 * cheaper, and it self-heals rows orphaned before this shipped.
 *
 * A row whose `derivedFrom` is absent is KEPT. Treating a missing key as a missing source would
 * make a metadata-shape change delete every derived row at once.
 *
 * Bound-parameter free (no user input reaches this statement) and I9-safe: every identifier is a
 * literal in the source.
 */
import type { Database } from "bun:sqlite";

const UNDERSTANDING_TYPES = ["image_understanding", "video_understanding"] as const;

export function pruneOrphanedUnderstandings(db: Database): number {
  const result = db
    .query(
      `DELETE FROM item
        WHERE service = 'nimbus'
          AND type IN (${UNDERSTANDING_TYPES.map(() => "?").join(", ")})
          AND json_extract(metadata, '$.derivedFrom') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM item AS src
             WHERE src.id = json_extract(item.metadata, '$.derivedFrom')
          )`,
    )
    .run(...UNDERSTANDING_TYPES);
  return result.changes;
}
```

- [ ] **Step 4: Call it at pass start**

In `media-pass.ts`, immediately after the existing `sweepStaleScratchFiles` block:

```ts
  // Reclaim derived rows whose source has left the index (spec § 4.2). Cheap, indexed, and it
  // self-heals rows orphaned before this shipped.
  pruneOrphanedUnderstandings(deps.db);
```

Add the import.

- [ ] **Step 5: Run the suite**

Run: `bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/orphan-prune.ts packages/gateway/src/multimodal/orphan-prune.test.ts packages/gateway/src/multimodal/media-pass.ts
git commit -m "fix(multimodal): prune derived rows whose source has left the index"
```

---

### Task 3: Scratch sweeper matches the cloud-download prefix

`sweepStaleScratchFiles` (`stt/ffmpeg-bin.ts:181`) matches only `nimbus-stt-*.wav` (line 194). A cloud download killed mid-write would leave the user's media on disk indefinitely — the exact hazard the sweep exists for.

The review proposed matching an extension list (`.tmp`/`.wav`/`.mp4`). Rejected: a download's extension is whatever the artifact is (`.mov`, `.mkv`, `.m4a`, `.webm`, …) and that list will drift. **Cloud downloads are extensionless**, named `nimbus-media-<uuid>`; ffmpeg probes content and never needs a suffix.

**Files:**
- Modify: `packages/gateway/src/multimodal/stt/ffmpeg-bin.ts:193-196`
- Test: `packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const CLOUD_SCRATCH_PREFIX = "nimbus-media-"` (consumed by Task 9's `cloud-bytes.ts`).

- [ ] **Step 1: Write the failing test**

Append to `ffmpeg-bin.test.ts`:

```ts
test("sweeps a stale extensionless cloud download", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
  const stale = join(dir, "nimbus-media-abc123");
  writeFileSync(stale, "x");
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  utimesSync(stale, twoHoursAgo / 1000, twoHoursAgo / 1000);

  expect(sweepStaleScratchFiles(dir, Date.now())).toBe(1);
  expect(existsSync(stale)).toBe(false);
});

test("leaves a YOUNG cloud download alone — a concurrent pass may own it", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
  const fresh = join(dir, "nimbus-media-def456");
  writeFileSync(fresh, "x");

  expect(sweepStaleScratchFiles(dir, Date.now())).toBe(0);
  expect(existsSync(fresh)).toBe(true);
});

test("never touches an unrelated file, however old", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
  const other = join(dir, "important.mp4");
  writeFileSync(other, "x");
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  utimesSync(other, twoHoursAgo / 1000, twoHoursAgo / 1000);

  expect(sweepStaleScratchFiles(dir, Date.now())).toBe(0);
  expect(existsSync(other)).toBe(true);
});
```

Import `mkdtempSync`, `writeFileSync`, `utimesSync`, `existsSync` from `node:fs`, `join` from `node:path`, `tmpdir` from `node:os`. Use `os.tmpdir()` + `path.join`, never a hardcoded separator.

- [ ] **Step 2: Run it and confirm the first test fails**

Run: `bun test packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts`
Expected: FAIL — the stale cloud file is not swept (returns 0, expected 1).

- [ ] **Step 3: Implement**

In `ffmpeg-bin.ts`, above `sweepStaleScratchFiles`:

```ts
/**
 * Cloud downloads are named `nimbus-media-<uuid>` with NO extension.
 *
 * Deliberate: a downloaded artifact's extension is whatever the provider served (`.mov`, `.mkv`,
 * `.m4a`, `.webm`, …), so matching on extension is a list guaranteed to drift and to fail on
 * exactly the format nobody anticipated. ffmpeg probes content and never needs the suffix, so the
 * prefix can be the only key.
 */
export const CLOUD_SCRATCH_PREFIX = "nimbus-media-";
const STT_SCRATCH_PREFIX = "nimbus-stt-";
```

Replace the filter at line 194:

```ts
    const isSttScratch = name.startsWith(STT_SCRATCH_PREFIX) && name.endsWith(".wav");
    const isCloudScratch = name.startsWith(CLOUD_SCRATCH_PREFIX);
    if (!isSttScratch && !isCloudScratch) {
      continue;
    }
```

- [ ] **Step 4: Run to verify all three pass**

Run: `bun test packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/stt/ffmpeg-bin.ts packages/gateway/src/multimodal/stt/ffmpeg-bin.test.ts
git commit -m "fix(multimodal): sweep cloud download scratch files by prefix"
```

---

### Task 4: `MediaPassSummary` can express "stopped early but healthy"

Today the summary is `understood` / `skipped` / `skippedByReason` / `lastItemId`. A budget-stopped or rate-limited run is indistinguishable from a completed one, which would let a truncated pass report as finished — the same disclosure failure § 8 forbids for skip counts.

This task adds the fields and defaults them; Task 11 makes the budget actually set them. Landing the shape first keeps Task 11 a behaviour change rather than a shape-plus-behaviour change.

**Files:**
- Modify: `packages/gateway/src/multimodal/media-pass.ts:39-44`
- Test: `packages/gateway/src/multimodal/media-pass.test.ts`

**Interfaces:**
- Produces: `MediaPassSummary.stopReason: "completed" | "budget_exhausted" | "rate_limited"` and `MediaPassSummary.cloudBytesFetched: number`.

- [ ] **Step 1: Write the failing test**

Append to `media-pass.test.ts` (follow the file's existing helper for building `MediaPassDeps`):

```ts
test("a normal run reports stopReason completed and zero cloud bytes", async () => {
  const summary = await runMediaPass(depsWithCandidates([]));
  expect(summary.stopReason).toBe("completed");
  expect(summary.cloudBytesFetched).toBe(0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/multimodal/media-pass.test.ts`
Expected: FAIL — `stopReason` is `undefined`.

- [ ] **Step 3: Implement**

```ts
export type MediaPassStopReason = "completed" | "budget_exhausted" | "rate_limited";

export interface MediaPassSummary {
  readonly understood: number;
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<SkipReason, number>>;
  readonly lastItemId: string | null;
  /**
   * Why the run ended. Without this a truncated pass is indistinguishable from a finished one,
   * and the CLI cannot print resume guidance (spec § 17.3).
   *
   * `budget_exhausted` is deliberately NOT a `SkipReason`: a budget stop ends the run, and
   * recording it per-item would report artifacts that were never attempted as artifacts that
   * failed (spec § 16.10).
   */
  readonly stopReason: MediaPassStopReason;
  /** Bytes actually fetched from a connected service this run. Always 0 for a local-only pass. */
  readonly cloudBytesFetched: number;
}
```

And in `runMediaPass`'s return:

```ts
  return {
    understood,
    skipped,
    skippedByReason: reasons,
    lastItemId,
    stopReason: "completed",
    cloudBytesFetched: 0,
  };
```

- [ ] **Step 4: Fix every consumer the compiler names**

Run: `bun run typecheck`
Expected: errors in `ipc/media-rpc.ts` and `cli/src/commands/media-cmd.ts` if they construct summaries. Add the two fields at each site. Do not add `?? "completed"` defaults at the consumers — a missing field must be a compile error, not a silent default.

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test packages/gateway/src/multimodal && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A packages/gateway/src/multimodal packages/gateway/src/ipc packages/cli/src/commands
git commit -m "feat(multimodal): report why a pass ended and how many cloud bytes it fetched"
```

---

### Task 5: The mime predicate moves into SQL, and the cloud pairs are registered

**This is the task that prevents a silent data-loss bug**, so it lands before anything can fetch.

`findCandidates` applies `LIMIT` in SQL and then filters in JS. Today the JS filter can never drop a row, because the type list comes from the same registry map — it is a no-op safety net. Registering `google_drive:file` breaks that equivalence: a page of 50 Drive PDFs yields zero candidates, and `media-pass.ts:113` reads `candidates.length < deps.limit` as end-of-queue and calls `clearCursor`. A Drive with 40,000 files and 6 videos would report **a clean, complete run having understood nothing**.

The review's alternative — loop until `limit` candidates accumulate — is rejected: it turns `limit` from *rows examined* into *rows returned*, so a `--limit 50` against a media-free 40,000-file Drive scans the whole table. The budget and the resumable cursor both assume one page is one bounded unit of work.

**Files:**
- Modify: `packages/gateway/src/multimodal/media-source-registry.ts`
- Modify: `packages/gateway/src/multimodal/media-discovery.ts`
- Test: `packages/gateway/src/multimodal/media-discovery.test.ts`

**Interfaces:**
- Consumes: `mediaSourceBytes` (Task 1).
- Produces: `export const MIME_KEYED_SERVICES: ReadonlySet<string>`; `export function mimeModality(mime: string | null): MediaModality | undefined`; `modalityForItem(service, type, mime?)` gains an optional third parameter.

- [ ] **Step 1: Write the failing test**

In `media-discovery.test.ts`:

```ts
test("pages past non-media files without clearing the cursor (the starvation bug)", () => {
  const db = freshIndexDb();
  // 100 Drive files; only #70-#75 are media. A JS-side mime filter would return 0 candidates
  // for page 1, and the pass would treat that as end-of-queue.
  for (let i = 0; i < 100; i += 1) {
    const media = i >= 70 && i < 76;
    insertItem(db, {
      id: `google_drive:f${String(i).padStart(3, "0")}`,
      service: "google_drive",
      type: "file",
      metadata: { mimeType: media ? "video/mp4" : "application/pdf", size: "1024" },
    });
  }

  const page1 = findCandidates(db, { limit: 50 });
  // The SQL predicate excludes the PDFs, so page 1 is the SIX media items, not zero.
  expect(page1).toHaveLength(6);
  expect(page1.every((c) => c.modality === "av")).toBe(true);
});

test("--modality image excludes a video sharing the same item type", () => {
  const db = freshIndexDb();
  insertItem(db, {
    id: "google_photos:p1", service: "google_photos", type: "photo",
    metadata: { mimeType: "image/jpeg" },
  });
  insertItem(db, {
    id: "google_photos:p2", service: "google_photos", type: "photo",
    metadata: { mimeType: "video/mp4" },
  });

  expect(findCandidates(db, { limit: 10, modality: "image" }).map((c) => c.itemId))
    .toEqual(["google_photos:p1"]);
  expect(findCandidates(db, { limit: 10, modality: "av" }).map((c) => c.itemId))
    .toEqual(["google_photos:p2"]);
});

test("a mime-keyed row with NO mimeType is excluded by SQL, not fetched and dropped", () => {
  const db = freshIndexDb();
  insertItem(db, { id: "google_drive:f1", service: "google_drive", type: "file", metadata: {} });
  expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/multimodal/media-discovery.test.ts`
Expected: FAIL — the first test returns 0 candidates (the cloud pairs are not registered yet).

- [ ] **Step 3: Extend the registry**

In `media-source-registry.ts`:

```ts
/**
 * Services whose items carry a GENERIC type and whose modality must come from mime instead.
 *
 * Drive and OneDrive index everything as `type: "file"`; Photos indexes both stills and videos as
 * `type: "photo"`. A mime type is the PROVIDER'S OWN DECLARATION, not our inference, so reading it
 * does not weaken the "never defaulted" rule this module states above — an absent or unrecognised
 * mime is still skipped rather than guessed.
 */
export const MIME_KEYED_SERVICES: ReadonlySet<string> = new Set([
  "google_photos",
  "google_drive",
  "onedrive",
]);

/** SQL `LIKE` patterns per modality. Bound as parameters, never concatenated (I9). */
export const MIME_PATTERNS_FOR_MODALITY: Readonly<Record<MediaModality, readonly string[]>> = {
  image: ["image/%"],
  av: ["video/%", "audio/%"],
};

export function mimeModality(mime: string | null): MediaModality | undefined {
  if (mime === null || mime === "") return undefined;
  const lower = mime.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/") || lower.startsWith("audio/")) return "av";
  return undefined;
}

export function modalityForItem(
  service: string,
  type: string,
  mime?: string | null,
): MediaModality | undefined {
  if (MIME_KEYED_SERVICES.has(service)) {
    return mimeModality(mime ?? null);
  }
  return ITEM_TYPE_MODALITY.get(`${service}:${type}`);
}
```

Add the cloud pairs to `ITEM_TYPE_MODALITY` **for the type-list query only**, with the modality left to mime. Simplest correct shape: keep `ITEM_TYPE_MODALITY` as the filesystem-only map and add a separate list of mime-keyed `(service, type)` pairs that `mediaItemTypesForModality` unions in:

```ts
/** `(service, type)` pairs whose modality is mime-derived. Contributes TYPES to the query. */
const MIME_KEYED_PAIRS: readonly (readonly [string, string])[] = [
  ["google_photos", "photo"],
  ["google_drive", "file"],
  ["onedrive", "file"],
];

export function mediaItemTypesForModality(modality?: MediaModality): readonly string[] {
  const out = new Set<string>();
  for (const [key, m] of ITEM_TYPE_MODALITY) {
    if (modality !== undefined && m !== modality) continue;
    out.add(key.slice(key.indexOf(":") + 1));
  }
  // Mime-keyed types are added for EVERY modality: the type alone cannot tell them apart, so the
  // SQL mime predicate does the narrowing instead.
  for (const [, type] of MIME_KEYED_PAIRS) out.add(type);
  return [...out];
}
```

- [ ] **Step 4: Add the SQL predicate in `findCandidates`**

Replace the plain type clause with a two-arm one:

```ts
  const mimeServices = [...MIME_KEYED_SERVICES];
  const mimePatterns =
    opts.modality === undefined
      ? [...MIME_PATTERNS_FOR_MODALITY.image, ...MIME_PATTERNS_FOR_MODALITY.av]
      : MIME_PATTERNS_FOR_MODALITY[opts.modality];

  // A mime-keyed service is admitted ONLY when its declared mime matches the requested modality.
  // Filtering this in JS instead would under-fill the SQL page, and `media-pass.ts` reads a short
  // page as end-of-queue and clears the cursor — silently truncating the pass (spec § 17.1).
  wheres.push(
    `(
       (src.service NOT IN (${mimeServices.map(() => "?").join(", ")})
        AND src.type IN (${mediaTypes.map(() => "?").join(", ")}))
       OR
       (src.service IN (${mimeServices.map(() => "?").join(", ")})
        AND (${mimePatterns.map(() => "json_extract(src.metadata, '$.mimeType') LIKE ?").join(" OR ")}))
     )`,
  );
  params.push(...mimeServices, ...mediaTypes, ...mimeServices, ...mimePatterns);
```

Remove the original `src.type IN (...)` clause and its params so types are not filtered twice.

In the candidate loop, pass the mime through:

```ts
    const mime = stringOrNull(meta["mimeType"]);
    const modality = modalityForItem(row.service, row.type, mime);
```

Note `meta` must be parsed **before** the modality call — move `const meta = parseMetadata(row.metadata);` above it.

- [ ] **Step 5: Run the discovery tests**

Run: `bun test packages/gateway/src/multimodal/media-discovery.test.ts`
Expected: PASS, all three new tests plus the existing ones.

- [ ] **Step 6: Red-prove the starvation guard by reverting**

Temporarily move the mime predicate back into the JS loop (drop the SQL arm), re-run the first test, and confirm it returns 0 candidates. Restore. This proves the test fails for the reason claimed rather than passing for an unrelated one.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/multimodal/media-source-registry.ts packages/gateway/src/multimodal/media-discovery.ts packages/gateway/src/multimodal/media-discovery.test.ts packages/gateway/src/multimodal/media-source-registry.test.ts
git commit -m "feat(multimodal): discover cloud media by mime, filtered in SQL"
```

---

### Task 6: `safe-fetch` moves to `util/` and learns to follow redirects safely

`share/safe-fetch.ts` already implements `assertSafeUrl` / `isPrivateAddress` / `safeFetch`, covering IPv4 and IPv6 private ranges, IPv4-mapped IPv6 and a DNS check. **Reuse it — do not write a second private-range table.**

Two changes. It moves to `util/` because a `multimodal/ → share/` import would read as a subsystem dependency that does not exist. And it gains redirect-safe following: today `safeFetch` validates only the URL it is handed and passes `init` to `fetch`, which follows redirects itself — so a 302 to `127.0.0.1` is followed unchecked. The most interesting loopback target on this machine is the gateway's own HTTP API (the I13 write surface).

**Verified, do not redo:** Bun 1.3.14's `fetch` *does* strip `Authorization` across an origin-crossing redirect. Manual following is used anyway, so the property does not depend on undocumented runtime behaviour.

**Files:**
- Move: `packages/gateway/src/share/safe-fetch.ts` → `packages/gateway/src/util/safe-fetch.ts` (and its test)
- Modify: importers named by `bun run typecheck`
- Test: `packages/gateway/src/util/safe-fetch.test.ts`

**Interfaces:**
- Produces: `export async function safeFetchFollowing(raw: string, init: RequestInit, deps?: SafeFetchDeps & { maxHops?: number }): Promise<Response>`

- [ ] **Step 1: Move the file**

```bash
git mv packages/gateway/src/share/safe-fetch.ts packages/gateway/src/util/safe-fetch.ts
git mv packages/gateway/src/share/safe-fetch.test.ts packages/gateway/src/util/safe-fetch.test.ts
bun run typecheck
```

Fix every import path the typecheck names (`share/verify-share.ts`, `ipc/share-rpc.ts`, and the test's own relative imports).

- [ ] **Step 2: Write the failing test**

Append to `util/safe-fetch.test.ts`:

```ts
test("refuses a redirect to loopback", async () => {
  const hops: string[] = [];
  const fetchFn = ((url: URL | string, _init?: RequestInit) => {
    hops.push(String(url));
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/x" } }),
    );
  }) as unknown as typeof fetch;

  await expect(
    safeFetchFollowing("https://example.test/a", {}, { fetchFn, lookupFn: publicLookup }),
  ).rejects.toThrow(/loopback\/private/);
  expect(hops).toHaveLength(1);
});

test("stops after maxHops rather than following a redirect loop", async () => {
  let calls = 0;
  const fetchFn = (() => {
    calls += 1;
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "https://example.test/next" } }),
    );
  }) as unknown as typeof fetch;

  await expect(
    safeFetchFollowing("https://example.test/a", {}, { fetchFn, lookupFn: publicLookup, maxHops: 3 }),
  ).rejects.toThrow(/too many redirects/);
  expect(calls).toBe(4); // initial + 3 hops
});

test("returns the final response when every hop is public", async () => {
  let calls = 0;
  const fetchFn = (() => {
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.test/b" } })
        : new Response("BYTES", { status: 200 }),
    );
  }) as unknown as typeof fetch;

  const res = await safeFetchFollowing("https://example.test/a", {}, { fetchFn, lookupFn: publicLookup });
  expect(await res.text()).toBe("BYTES");
});
```

`publicLookup` is a fake resolving every host to `93.184.216.34`:

```ts
const publicLookup = (() =>
  Promise.resolve([{ address: "93.184.216.34", family: 4 }])) as unknown as typeof lookup;
```

- [ ] **Step 3: Run and confirm failure**

Run: `bun test packages/gateway/src/util/safe-fetch.test.ts`
Expected: FAIL — `safeFetchFollowing` is not exported.

- [ ] **Step 4: Implement**

```ts
const DEFAULT_MAX_HOPS = 5;

/**
 * `safeFetch` with MANUAL redirect handling, so every hop is re-validated.
 *
 * `safeFetch` alone validates only the URL it is handed and then lets `fetch` follow redirects on
 * its own — so a 302 to `127.0.0.1` is followed unchecked. That matters more for a
 * provider-returned download URL, which is pinned to nothing, than for `share/`'s config-pinned
 * sink; and the most interesting loopback target here is this gateway's own HTTP API.
 *
 * Manual following additionally removes any dependency on the runtime's own header handling across
 * an origin crossing. Bun 1.3.14 strips `Authorization` there, but relying on that would make a
 * security property depend on undocumented behaviour a version bump could change silently.
 *
 * INHERITED BOUND: `safeFetch`'s DNS-rebind TOCTOU is not closed here either — see its doc comment.
 */
export async function safeFetchFollowing(
  raw: string,
  init: RequestInit,
  deps?: SafeFetchDeps & { readonly maxHops?: number },
): Promise<Response> {
  const maxHops = deps?.maxHops ?? DEFAULT_MAX_HOPS;
  let url = raw;

  for (let hop = 0; hop <= maxHops; hop += 1) {
    // Every hop, not just the first: assertSafeUrl + the DNS check run inside safeFetch.
    const res = await safeFetch(url, { ...init, redirect: "manual" }, deps);
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (location === null || location === "") return res;
    url = new URL(location, url).toString();
  }
  throw new Error(`unsafe url: too many redirects (>${maxHops})`);
}
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/gateway/src/util/safe-fetch.test.ts && bun test packages/gateway/src/share`
Expected: PASS both — the move must not break the share suite.

- [ ] **Step 6: Commit**

```bash
git add -A packages/gateway/src/util packages/gateway/src/share packages/gateway/src/ipc
git commit -m "refactor(util): move safe-fetch out of share and re-validate every redirect hop"
```

---

### Task 7: Config keys `fetch_budget_bytes` and `prefer_renditions`

**Files:**
- Modify: `packages/gateway/src/multimodal/multimodal-config.ts`
- Test: `packages/gateway/src/multimodal/multimodal-config.test.ts`

**Interfaces:**
- Produces: `MultimodalConfig.fetchBudgetBytes: number`, `MultimodalConfig.preferRenditions: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
test("parses fetch_budget_bytes and prefer_renditions", () => {
  const cfg = loadMultimodalConfig(`
[multimodal]
enabled = true
fetch_budget_bytes = 4294967296
prefer_renditions = true
`);
  expect(cfg.fetchBudgetBytes).toBe(4294967296);
  expect(cfg.preferRenditions).toBe(true);
});

test("defaults are 2 GiB and originals", () => {
  const cfg = loadMultimodalConfig(`[multimodal]\nenabled = true\n`);
  expect(cfg.fetchBudgetBytes).toBe(2 * 1024 * 1024 * 1024);
  expect(cfg.preferRenditions).toBe(false);
});

test("a malformed budget fails the load off, matching enabled/max_frames", () => {
  const cfg = loadMultimodalConfig(`[multimodal]\nenabled = true\nfetch_budget_bytes = lots\n`);
  expect(cfg.enabled).toBe(false);
});
```

The third test matters: this loader's stated contract is that a malformed value fails the **whole** section off rather than falling back to a default while leaving `enabled = true` standing. Match the existing `max_frames` handling exactly — read it before implementing.

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/multimodal/multimodal-config.test.ts`
Expected: FAIL — the fields do not exist.

- [ ] **Step 3: Implement**

Add both fields to the interface and defaults object (`fetchBudgetBytes: 2 * 1024 * 1024 * 1024`, `preferRenditions: false`), and two `key === ...` branches in the parse loop mirroring `max_frames` (integer, fail-off on non-integer) and `enabled` (boolean, fail-off on non-boolean).

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/multimodal/multimodal-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/multimodal-config.ts packages/gateway/src/multimodal/multimodal-config.test.ts
git commit -m "feat(multimodal): add fetch_budget_bytes and prefer_renditions config"
```

---

### Task 8: Rendition selection and per-service byte-URL resolvers

Pure URL logic, separated from transport so it is testable without a network. **The credential rule lives here**: each resolver declares whether its URL is one we constructed (bearer attached) or one the provider returned (pre-signed, no header).

**Files:**
- Create: `packages/gateway/src/multimodal/cloud-renditions.ts`
- Create: `packages/gateway/src/multimodal/cloud-renditions.test.ts`
- Modify: `packages/gateway/src/connectors/google-photos-sync.ts` (export a `mediaItems/{id}` re-resolve helper)

**Interfaces:**
- Produces:
  ```ts
  export type ByteUrl =
    | { readonly kind: "constructed"; readonly url: string; readonly bearer: true }
    | { readonly kind: "provider"; readonly url: string; readonly bearer: false };
  export function driveByteUrl(externalId: string): ByteUrl;
  export function photosByteUrl(baseUrl: string, modality: MediaModality, renditions: boolean): ByteUrl;
  export function onedriveByteUrl(downloadUrl: string): ByteUrl;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { driveByteUrl, onedriveByteUrl, photosByteUrl } from "./cloud-renditions.ts";

describe("the credential rule", () => {
  test("a Drive URL is CONSTRUCTED by us, so it carries the bearer", () => {
    const u = driveByteUrl("1AbC");
    expect(u.kind).toBe("constructed");
    expect(u.bearer).toBe(true);
    expect(u.url).toBe("https://www.googleapis.com/drive/v3/files/1AbC?alt=media&supportsAllDrives=true");
  });

  test("a Photos URL is PROVIDER-returned and pre-signed, so it carries NO bearer", () => {
    const u = photosByteUrl("https://lh3.googleusercontent.com/abc", "image", false);
    expect(u.kind).toBe("provider");
    expect(u.bearer).toBe(false);
  });

  test("a OneDrive download URL is PROVIDER-returned, so it carries NO bearer", () => {
    expect(onedriveByteUrl("https://x.sharepoint.com/d?t=1").bearer).toBe(false);
  });

  test("an external id is percent-encoded into the Drive path", () => {
    expect(driveByteUrl("a/b?c").url).toContain("a%2Fb%3Fc");
  });
});

describe("renditions", () => {
  test("photos image rendition bounds the long edge", () => {
    expect(photosByteUrl("https://lh3.example/abc", "image", true).url).toBe(
      "https://lh3.example/abc=w2048-h2048",
    );
  });

  test("photos av rendition asks for the transcoded video", () => {
    expect(photosByteUrl("https://lh3.example/abc", "av", true).url).toBe("https://lh3.example/abc=dv");
  });

  test("originals mode appends nothing", () => {
    expect(photosByteUrl("https://lh3.example/abc", "image", false).url).toBe("https://lh3.example/abc");
  });

  test("drive has no rendition — the same URL either way", () => {
    expect(driveByteUrl("x").url).toBe(driveByteUrl("x").url);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/multimodal/cloud-renditions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/cloud-renditions.ts
/**
 * Which URL to fetch an artifact's bytes from, and whether a credential may ride on it.
 *
 * THE RULE (spec § 16.4): a credential is attached only to a URL this codebase CONSTRUCTED. A
 * provider-returned URL is pre-signed and is fetched with no `Authorization` header at all, so a
 * hostile or compromised API response naming any host it likes learns nothing.
 *
 * Pure — no network, no vault, no clock — so the rule is testable without either.
 */
import type { MediaModality } from "./media-types.ts";

export type ByteUrl =
  | { readonly kind: "constructed"; readonly url: string; readonly bearer: true }
  | { readonly kind: "provider"; readonly url: string; readonly bearer: false };

/** We build this against a FIXED host, so the bearer is safe on it. */
export function driveByteUrl(externalId: string): ByteUrl {
  const id = encodeURIComponent(externalId);
  return {
    kind: "constructed",
    url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
    bearer: true,
  };
}

/**
 * Google Photos serves bytes from a pre-signed `baseUrl`. Renditions are a SUFFIX on it:
 * `=w<W>-h<H>` bounds a still's long edge; `=dv` asks for the transcoded video.
 *
 * NOTE: the caller must have RE-RESOLVED `baseUrl` — an indexed one is expired (spec § 16.6).
 */
const PHOTOS_RENDITION_EDGE = 2048;

export function photosByteUrl(
  baseUrl: string,
  modality: MediaModality,
  renditions: boolean,
): ByteUrl {
  const suffix = !renditions
    ? ""
    : modality === "image"
      ? `=w${PHOTOS_RENDITION_EDGE}-h${PHOTOS_RENDITION_EDGE}`
      : "=dv";
  return { kind: "provider", url: `${baseUrl}${suffix}`, bearer: false };
}

/** Microsoft Graph's `@microsoft.graph.downloadUrl` is pre-signed and short-lived. */
export function onedriveByteUrl(downloadUrl: string): ByteUrl {
  return { kind: "provider", url: downloadUrl, bearer: false };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/multimodal/cloud-renditions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/cloud-renditions.ts packages/gateway/src/multimodal/cloud-renditions.test.ts
git commit -m "feat(multimodal): resolve per-service byte URLs and renditions"
```

---

### Task 9: `cloud-bytes.ts` — the transport, budget and ledger

**Files:**
- Create: `packages/gateway/src/multimodal/cloud-bytes.ts`
- Create: `packages/gateway/src/multimodal/cloud-bytes.test.ts`

**Interfaces:**
- Consumes: `ByteUrl` (Task 8), `safeFetchFollowing` (Task 6), `CLOUD_SCRATCH_PREFIX` (Task 3), `recordSyncEgress` from `egress/sync-egress.ts`.
- Produces:
  ```ts
  export type CloudBytes =
    | { readonly ok: true; readonly kind: "bytes"; readonly bytes: Uint8Array; readonly fetched: number }
    | { readonly ok: true; readonly kind: "path"; readonly path: string; readonly fetched: number }
    | { readonly ok: false; readonly reason: SkipReason }
    | { readonly ok: false; readonly stop: "budget_exhausted" | "rate_limited" };
  export interface CloudBytesDeps { … }
  export async function fetchCloudBytes(candidate, byteUrl, deps): Promise<CloudBytes>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
describe("fetchCloudBytes", () => {
  test("appends ONE sync egress row BEFORE the request", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      appendEgress: () => { order.push("egress"); return { rowHash: "h" }; },
      fetchFn: async () => { order.push("fetch"); return new Response("AB"); },
    });
    await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(order).toEqual(["egress", "fetch"]);
  });

  test("an egress append failure ABORTS — fail-closed, no request is made", async () => {
    let fetched = false;
    const deps = fakeDeps({
      appendEgress: () => { throw new Error("ledger down"); },
      fetchFn: async () => { fetched = true; return new Response("AB"); },
    });
    await expect(fetchCloudBytes(imageCandidate, providerUrl, deps)).rejects.toThrow("ledger down");
    expect(fetched).toBe(false);
  });

  test("NO Authorization header on a provider-returned URL", async () => {
    let seen: Headers | undefined;
    const deps = fakeDeps({
      fetchFn: async (_u, init) => { seen = new Headers(init?.headers); return new Response("AB"); },
    });
    await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(seen?.has("authorization")).toBe(false);
  });

  test("Authorization IS present on a constructed URL", async () => {
    let seen: Headers | undefined;
    const deps = fakeDeps({
      fetchFn: async (_u, init) => { seen = new Headers(init?.headers); return new Response("AB"); },
    });
    await fetchCloudBytes(imageCandidate, constructedUrl, deps);
    expect(seen?.get("authorization")).toBe("Bearer test-token");
  });

  test("refuses over the per-artifact cap rather than truncating", async () => {
    const deps = fakeDeps({ maxBytes: 1, fetchFn: async () => new Response("ABCDEF") });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, reason: "over_byte_cap" });
  });

  test("stops the RUN when the streaming budget is exhausted mid-download", async () => {
    const deps = fakeDeps({ remainingBudget: 3, fetchFn: async () => new Response("ABCDEFGHIJ") });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, stop: "budget_exhausted" });
  });

  test("a 429 that persists stops the run rather than skipping the item", async () => {
    const deps = fakeDeps({
      fetchFn: async () => new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, stop: "rate_limited" });
  });

  test("a 404 is a per-item fetch_miss, not a run stop", async () => {
    const deps = fakeDeps({ fetchFn: async () => new Response(null, { status: 404 }) });
    expect(await fetchCloudBytes(imageCandidate, providerUrl, deps)).toEqual({
      ok: false, reason: "fetch_miss",
    });
  });

  test("an AV artifact lands in an extensionless scratch file that is 0600", async () => {
    const deps = fakeDeps({ fetchFn: async () => new Response("AB") });
    const r = await fetchCloudBytes(avCandidate, providerUrl, deps);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "path") {
      expect(basename(r.path).startsWith("nimbus-media-")).toBe(true);
      expect(extname(r.path)).toBe("");
      if (process.platform !== "win32") {
        expect(statSync(r.path).mode & 0o777).toBe(0o600);
      }
    }
  });

  test("a budget stop mid-download deletes the partial scratch file", async () => {
    const deps = fakeDeps({ remainingBudget: 3, fetchFn: async () => new Response("ABCDEFGHIJ") });
    await fetchCloudBytes(avCandidate, providerUrl, deps);
    expect(readdirSync(deps.scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
  });
});
```

The 0600 assertion is POSIX-only: Windows does not carry Unix mode bits, and asserting them there would fail for a reason unrelated to the property. Do NOT skip the whole test on Windows — the prefix and extension assertions must run on all three platforms.

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/multimodal/cloud-bytes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/multimodal/cloud-bytes.ts
/**
 * The cloud arm of byte acquisition (spec § 16.2). Contacts NO model — that separation is what
 * makes `media-gate.ts`'s chokepoint claim checkable, exactly as for the local arm.
 *
 * Three properties the tests pin:
 *  - ONE `sync`-class egress row is appended BEFORE the request and an append failure ABORTS it,
 *    so a zero-row window means no bytes were fetched, never that some were fetched unrecorded;
 *  - a credential rides only on a URL we constructed (§ 16.4);
 *  - the run budget is evaluated PER CHUNK, so an overrun aborts the transfer instead of paying
 *    for the whole artifact and then declining it.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, createWriteStream, rmSync } from "node:fs";
import { join } from "node:path";
import type { ByteUrl } from "./cloud-renditions.ts";
import type { MediaCandidate, SkipReason } from "./media-types.ts";
import { CLOUD_SCRATCH_PREFIX } from "./stt/ffmpeg-bin.ts";

export type CloudBytes =
  | { readonly ok: true; readonly kind: "bytes"; readonly bytes: Uint8Array; readonly fetched: number }
  | { readonly ok: true; readonly kind: "path"; readonly path: string; readonly fetched: number }
  | { readonly ok: false; readonly reason: SkipReason }
  | { readonly ok: false; readonly stop: "budget_exhausted" | "rate_limited" };

const MAX_429_RETRIES = 2;

export interface CloudBytesDeps {
  readonly scratchDir: string;
  /** Per-artifact cap for this modality. Refuses, never truncates (spec § 5.3). */
  readonly maxBytes: number;
  /** Bytes still permitted this RUN. Reaching zero stops the pass (spec § 16.9). */
  readonly remainingBudget: number;
  /** Resolved only for a `constructed` URL — never called for a provider-returned one. */
  readonly bearerFor: (service: string) => Promise<string | null>;
  /**
   * Appends ONE `sync` row. THROWS to abort — fail-closed. Injected rather than importing
   * `appendEgressEntry`, which static rule D22(b) confines to `egress/*`.
   */
  readonly appendEgress: (row: { destination: string; method: string }) => { rowHash: string } | undefined;
  readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  readonly sleep: (ms: number) => Promise<void>;
}

export async function fetchCloudBytes(
  candidate: MediaCandidate,
  byteUrl: ByteUrl,
  deps: CloudBytesDeps,
): Promise<CloudBytes> {
  // Fail-closed: append first. A throw here propagates and no request is made.
  deps.appendEgress({ destination: candidate.service, method: "media.fetchBytes" });

  const headers: Record<string, string> = {};
  if (byteUrl.bearer) {
    const token = await deps.bearerFor(candidate.service);
    if (token === null) return { ok: false, reason: "not_configured" };
    headers["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  let res: Response;
  for (let attempt = 0; ; attempt += 1) {
    res = await deps.fetchFn(byteUrl.url, { headers, signal: controller.signal });
    if (res.status !== 429 && res.status !== 503) break;
    if (attempt >= MAX_429_RETRIES) return { ok: false, stop: "rate_limited" };
    const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000;
    await deps.sleep(waitMs + Math.floor(Math.random() * 250));
  }
  if (!res.ok) return { ok: false, reason: "fetch_miss" };

  // A declared length lets an oversized artifact be refused without transferring it at all.
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > deps.maxBytes) {
    controller.abort();
    return { ok: false, reason: "over_byte_cap" };
  }

  return candidate.modality === "image"
    ? await collectToMemory(res, controller, deps)
    : await collectToScratch(res, controller, deps);
}
```

Both collectors share one loop shape: read chunks from `res.body`, accumulate a running count, and after each chunk check the per-artifact cap (`over_byte_cap`, abort) and then the run budget (`budget_exhausted`, abort). `collectToScratch` writes to `join(deps.scratchDir, CLOUD_SCRATCH_PREFIX + randomUUID())` with no extension, `chmodSync(path, 0o600)` immediately after creation, and removes the file in a `finally` on every non-`ok` exit. Write them as two small functions in this file rather than one branching one — the memory arm returns bytes and the disk arm owns a file lifecycle, and merging them makes the cleanup path harder to see.

- [ ] **Step 4: Add `not_configured` and `rate_limited` to `SkipReason`**

In `media-types.ts`, extend the union and `emptyReasons()` in `media-pass.ts`. The compiler will name any exhaustive switch that needs a new arm.

- [ ] **Step 5: Run tests**

Run: `bun test packages/gateway/src/multimodal/cloud-bytes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/cloud-bytes.ts packages/gateway/src/multimodal/cloud-bytes.test.ts packages/gateway/src/multimodal/media-types.ts packages/gateway/src/multimodal/media-pass.ts
git commit -m "feat(multimodal): fetch cloud media bytes under a ledgered, budgeted transport"
```

---

### Task 10: Byte acquisition becomes a union, and the gate accepts either arm

`understandArtifact(candidate, path, deps)` takes a path. Images now arrive as bytes and never touch disk.

**Files:**
- Modify: `packages/gateway/src/multimodal/media-bytes.ts`
- Modify: `packages/gateway/src/multimodal/media-gate.ts`
- Modify: `packages/gateway/src/multimodal/vlm/image-understander.ts`, `frames/av-understander.ts`
- Test: `packages/gateway/src/multimodal/media-gate.test.ts`

**Interfaces:**
- Produces: `export type MediaSource = { kind: "path"; path: string } | { kind: "bytes"; bytes: Uint8Array; mime: string | null };` and `LocalUnderstander.understand(source: MediaSource)`.

- [ ] **Step 1: Write the failing test**

```ts
test("the gate passes a bytes source straight through to the understander", async () => {
  let received: MediaSource | undefined;
  const deps = gateDeps({
    understanderFor: () => ({
      isLocal: true, model: "fake",
      isAvailable: async () => true,
      understand: async (s: MediaSource) => { received = s; return { text: "ok" }; },
    }),
  });
  const src: MediaSource = { kind: "bytes", bytes: new Uint8Array([1, 2]), mime: "image/png" };
  const r = await understandArtifact(imageCandidate, src, deps);
  expect(r.ok).toBe(true);
  expect(received).toEqual(src);
});

test("a non-local provider is still refused BEFORE the source is touched", async () => {
  let touched = false;
  const deps = gateDeps({
    understanderFor: () => ({
      isLocal: false, model: "remote",
      isAvailable: async () => { touched = true; return true; },
      understand: async () => ({ text: "" }),
    }),
  });
  const r = await understandArtifact(imageCandidate, { kind: "path", path: "/x" }, deps);
  expect(r).toEqual({ ok: false, reason: "no_remote_grant" });
  expect(touched).toBe(false);
});
```

The second test is a regression guard: the union must not reorder the gate's steps. Step 3 (non-local refused) still precedes step 4 (availability) and step 5 (model contact).

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/multimodal/media-gate.test.ts`
Expected: FAIL — `understandArtifact` takes a `string`.

- [ ] **Step 3: Implement**

Define `MediaSource` in `media-types.ts`. Change `understandArtifact`'s second parameter and `LocalUnderstander.understand` to take it. In `image-understander.ts`, take the bytes directly when `kind === "bytes"` and read the file when `kind === "path"`. In `av-understander.ts`, require `kind === "path"` — `whisper-cli` and `ffmpeg` both need a seekable file — and return a `transcode_failed` outcome if handed bytes, which cannot happen but must not be a silent cast.

`resolveLocalMediaPath` keeps its name and now returns `{ ok: true, source: { kind: "path", path } }` so both arms produce the same type.

- [ ] **Step 4: Run the whole multimodal suite**

Run: `bun test packages/gateway/src/multimodal && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/gateway/src/multimodal
git commit -m "refactor(multimodal): accept bytes or a path as the understanding source"
```

---

### Task 11: Pass integration — pre-flight pricing, running budget, stop reasons

**Files:**
- Modify: `packages/gateway/src/multimodal/media-pass.ts`
- Modify: `packages/gateway/src/multimodal/build-media-pass-deps.ts`
- Test: `packages/gateway/src/multimodal/media-pass.test.ts`

**Interfaces:**
- Consumes: `fetchCloudBytes` (Task 9), `mediaSourceBytes` (Task 1), the config fields (Task 7).
- Produces: `export function priceRun(candidates: readonly MediaCandidate[]): { knownBytes: number; knownCount: number; unknownCount: number }`.

- [ ] **Step 1: Write the failing test**

```ts
test("prices a run without inventing a number for unknown sizes", () => {
  const priced = priceRun([
    { ...driveCandidate, sourceBytes: 1000 },
    { ...driveCandidate, sourceBytes: 2000 },
    { ...photosCandidate, sourceBytes: null },
  ]);
  expect(priced).toEqual({ knownBytes: 3000, knownCount: 2, unknownCount: 1 });
});

test("a budget stop ends the run and leaves the cursor where it stopped", async () => {
  const deps = passDeps({ candidates: [c1, c2, c3], fetchBudgetBytes: 5, cloudFetch: budgetStopOn(c2) });
  const summary = await runMediaPass(deps);
  expect(summary.stopReason).toBe("budget_exhausted");
  expect(summary.lastItemId).toBe(c2.itemId);
  expect(readCursor(deps.db, deps.passId)).toBe(c2.itemId);
});

test("a budget stop does NOT clear the cursor, even on a short page", async () => {
  // The short-page rule means "queue drained". A budget stop is not a drained queue, and clearing
  // here would restart the next run from the top and re-fetch everything already understood.
  const deps = passDeps({ candidates: [c1], limit: 50, fetchBudgetBytes: 0 });
  await runMediaPass(deps);
  expect(readCursor(deps.db, deps.passId)).not.toBeNull();
});

test("a rate-limit stop reports rate_limited, not budget_exhausted", async () => {
  const deps = passDeps({ candidates: [c1], cloudFetch: async () => ({ ok: false, stop: "rate_limited" }) });
  expect((await runMediaPass(deps)).stopReason).toBe("rate_limited");
});
```

The third test is the important one: `media-pass.ts:113`'s existing `candidates.length < deps.limit → clearCursor` rule must not fire on an early stop.

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/gateway/src/multimodal/media-pass.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `priceRun` (a pure fold over `sourceBytes`). In `runMediaPass`:

1. After `findCandidates`, if any candidate is cloud-backed and `priceRun(...).knownBytes > deps.fetchBudgetBytes`, return immediately with `stopReason: "budget_exhausted"` and `understood: 0` — the pre-flight refusal. The CLI renders the guidance (Task 12).
2. Track `cloudBytesFetched` and a `remainingBudget` across the loop.
3. Route a cloud candidate (`sourcePath === null`) through `fetchCloudBytes`; a local one through `resolveLocalMediaPath`, unchanged.
4. On a result carrying `stop`, break the loop and record that stop reason.
5. Guard the cursor clear: `if (stopReason === "completed" && candidates.length < deps.limit)`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test packages/gateway/src/multimodal && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/gateway/src/multimodal
git commit -m "feat(multimodal): price a run up front and stop it on the running byte budget"
```

---

### Task 12: CLI flags and summary rendering

**Files:**
- Modify: `packages/cli/src/commands/media-cmd.ts`
- Modify: `packages/gateway/src/ipc/media-rpc.ts`
- Test: `packages/cli/src/commands/media-cmd.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("--renditions and --originals together are rejected, not silently resolved", async () => {
  const r = await runMediaCommand(["understand", "--renditions", "--originals"]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain("--renditions and --originals are mutually exclusive");
});

test("--budget accepts a human size", async () => {
  expect(parseBudget("4GB")).toBe(4 * 1024 * 1024 * 1024);
  expect(parseBudget("500MB")).toBe(500 * 1024 * 1024);
  expect(parseBudget("1048576")).toBe(1048576);
  expect(parseBudget("lots")).toBeNull();
});

test("a budget-stopped summary prints resume guidance and both flags", () => {
  const out = renderSummary({
    understood: 12, skipped: 3, skippedByReason: { ...zeroReasons, over_byte_cap: 3 },
    lastItemId: "google_drive:f42", stopReason: "budget_exhausted", cloudBytesFetched: 2_147_483_648,
  });
  expect(out).toContain("stopped: byte budget reached");
  expect(out).toContain("--renditions");
  expect(out).toContain("nimbus media understand");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun test packages/cli/src/commands/media-cmd.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `--renditions`, `--originals`, `--budget <size>` to the parser. Reject the flag pair with an explicit message naming both — never resolve by precedence; a silent override on a pair that controls bandwidth is something a user discovers from their data cap. `parseBudget` accepts `GB`/`MB`/`KB` suffixes (case-insensitive) or a raw byte count, and returns `null` on anything else.

`renderSummary` prints understood, skipped-by-reason (existing behaviour, unchanged), bytes fetched, the rendition mode in force, and — when `stopReason !== "completed"` — one line saying the run stopped and is resumable, plus the exact re-run command.

- [ ] **Step 4: Run tests**

Run: `bun test packages/cli/src/commands/media-cmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands packages/gateway/src/ipc/media-rpc.ts
git commit -m "feat(cli): rendition and budget flags for nimbus media understand"
```

---

### Task 13: Documentation — every restatement, not just one

A correction that lands at one restatement and not the others is the drift this project has hit repeatedly. Four facts changed and each is stated in more than one place.

**Files:**
- Modify: `CLAUDE.md`, `GEMINI.md` (mirrors it), `docs/roadmap.md`, `docs/SECURITY-INVARIANTS.md`, `.claude/commands/nimbus-egress.md`, `docs/cli-reference.md`, `docs/architecture.md`

- [ ] **Step 1: The scratch-file sentence (§ 16.3)**

Find every copy of "the only file this subsystem writes" / "one 0600 scratch WAV remains the ONLY file". Replace with: the image path writes nothing on either arm; the AV path writes at most two 0600 gateway-owned scratch files (the downloaded artifact on the cloud arm, and its transcode), both deleted in a `finally` and both swept at pass start.

```bash
grep -rn "ONLY file this subsystem writes\|only file this subsystem writes" CLAUDE.md GEMINI.md docs/
```

- [ ] **Step 2: The I29 `sync`-appender enumeration (§ 16.11)**

`multimodal/cloud-bytes.ts` is the **third** `sync`-class appender. Re-derive the *list*, do not bump a count — a total that is still right can hide an enumeration that is wrong.

```bash
grep -rn "targeted-fetch.ts. appends one row\|one row per scheduled sync RUN" CLAUDE.md GEMINI.md docs/SECURITY-INVARIANTS.md .claude/commands/nimbus-egress.md
```

- [ ] **Step 3: Roadmap and status**

Update the S2 Multimodal row: PR 3 of 4 shipped, cloud byte-fetch for Photos/Drive/OneDrive, still no remote model and no cloud STT. Add the Zoom follow-up (index recording files + caption frames) as its own deferred row with the reason recorded, per this project's convention of recording deferral *reasons*.

- [ ] **Step 4: CLI reference**

Document `--renditions` / `--originals` / `--budget` and the two new config keys under `[multimodal]`.

- [ ] **Step 5: Verify the docs gates**

Run: `bun run audit:doc-refs && bun run audit:status-drift`
Expected: PASS. Note `docs/superpowers/` is excluded from `audit:doc-refs`, so the spec's own citations are **not** checked by it — they were verified by hand at design time.

- [ ] **Step 6: Commit**

```bash
git add -A CLAUDE.md GEMINI.md docs .claude/commands
git commit -m "docs(multimodal): record the cloud arm and correct every restated fact"
```

---

### Task 14: Full preflight and the manual acceptance run

- [ ] **Step 1: Full preflight**

Run: `bun run preflight`
Expected: all gates green. If a Linux-only gate fails, reproduce with `bun run verify:docker --changed` before pushing — a Windows-local green predicts nothing about the Linux leg.

- [ ] **Step 2: The end-to-end acceptance run (manual)**

This closes § 12.1's open claim. `CLAUDE.md` currently records Phase 14 Core acceptance as *"structurally satisfiable, not verified end-to-end"*, and it stays that way until a real recording has been through the pass.

Requires `whisper-cli`, a vision-capable model served by a local Ollama, and one real video in a connected Google Drive.

```bash
# in nimbus.toml: [multimodal] enabled = true ; the root's media_index = true
nimbus media understand --service google_drive --modality av --limit 1
nimbus query --type video_understanding --limit 1
```

Expected: one `nimbus:video_understanding` row whose body carries a **non-empty transcript** AND **at least one frame caption**, and which states the rendition it was understood from.

- [ ] **Step 3: Record the result honestly**

Paste the actual output into the PR description. If the run does not produce both halves, say so and leave the `CLAUDE.md` claim unchanged — a claim of verification that was not performed is worse than the open claim it replaces.

- [ ] **Step 4: Open the PR**

The PR title carries the conventional-commit type (release-please parses the squash subject), and the body carries the reasoning — local commit messages are discarded on squash.

```bash
git push -u origin dev/asaf/multimodal-pr3-cloud-byte-fetch
gh pr create --title "feat(multimodal): cloud byte-fetch for Photos, Drive and OneDrive (S2 PR 3 of 4)" --body-file <(cat)
```

Wait for **`PR quality — required gates`** to report green before merging, or use `gh pr merge --squash --auto`. Merging while checks are pending is the main cause of red `main`.

---

## Self-Review

**Spec coverage.** § 16.1 → Tasks 8–9 (single-repo, no `nimbus-mcp-servers` change). § 16.2 → Tasks 8–10. § 16.3 → Tasks 3, 9, 10, 13. § 16.4 → Tasks 6, 8, 9. § 16.5 → Task 5. § 16.6 → Task 8 (Photos re-resolve; the helper is exported from `google-photos-sync.ts` and called by the `fetchBytes` capability). § 16.7 → Task 13 (Zoom recorded as a follow-up). § 16.8 → Tasks 7, 8, 12. § 16.9 → Tasks 1, 7, 9, 11. § 16.10 → Task 9 step 4. § 16.11 → Tasks 9, 13. § 16.12 → tests throughout. § 16.13 → Task 13. § 17.1 → Task 5. § 17.2 → Task 6. § 17.3 → Tasks 4, 9, 11. § 17.4 → Task 3. § 17.5 → Task 9. § 17.6 → Task 2 (orphan prune); I37/D27 correctly absent — PR 4. § 17.7 → Task 1. § 17.8 → Task 12. § 17.9 → Tasks 5, 6, 9.

**Not covered, deliberately:** I37, D27, `media_grant`/V59, the remote arm, remote STT, diarization, OCR — all PR 4 or explicitly out of scope. No task adds a remote model, so no task adds an egress class.

**Placeholder scan:** no "TBD", no "add error handling", no "similar to Task N". Every code step carries real code; the two steps that describe a shape rather than paste it (Task 9's collectors, Task 11's loop changes) state the exact structure and the reason for it.

**Type consistency:** `MediaSource` (Task 10) is the type `resolveLocalMediaPath` and `fetchCloudBytes` both produce and `understandArtifact` consumes. `CloudBytes.stop` values (`"budget_exhausted"` / `"rate_limited"`) match `MediaPassStopReason` (Task 4) exactly. `CLOUD_SCRATCH_PREFIX` is defined in Task 3 and consumed in Task 9. `mediaSourceBytes` is defined in Task 1 and consumed in Tasks 5 and 11. `ByteUrl` is defined in Task 8 and consumed in Task 9.

**One ordering constraint that is load-bearing:** Task 5 must land before any cloud `(service, type)` pair can be discovered, or the pass silently truncates. Tasks 1–4 are independent shipped-code fixes and can be reviewed in any order among themselves.
