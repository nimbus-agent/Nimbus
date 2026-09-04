# Multimodal PR 3 — Cloud Byte-Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the media understanding pass reach artifacts stored in Google Photos, Google Drive and OneDrive, not only files under `[[filesystem.roots]]` — and fix four defects in the already-shipped PR 1/PR 2 code that the cloud arm would otherwise ride on top of.

**Architecture:** A new `multimodal/cloud-bytes.ts` owns dispatch, byte caps, the scratch-file lifecycle, the streaming budget and the `sync`-class egress append. Per-service URL resolution lives next to each connector's existing sync module, reached through a `fetchBytes` capability minted in `sync/sync-capabilities.ts`. Byte acquisition returns a union — bytes in memory for images, a scratch path for audio/video — because `whisper-cli` takes a path. No remote model is added, so no new egress class and no new invariant.

**Tech Stack:** Bun 1.2+ / TypeScript strict, `bun:sqlite`, `bun test`, Biome. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`](../specs/2026-09-02-s2-multimodal-io-design.md) — § 16 (PR 3 design) and § 17 (review disposition). Review: [`2026-09-04-s2-multimodal-io-design-review.md`](../specs/2026-09-04-s2-multimodal-io-design-review.md).

## Global Constraints

- **No `any`.** External data is `unknown` and narrowed with a real guard, never a type assertion.
- **Bound-parameter SQL only** (I9). Identifiers via `escapeIdentifier`. Never string-concatenate a value into SQL.
- **Every SQLite WRITE goes through `dbRun` / `dbExec` / `dbStmtRun`** (`db/write.ts`, invariant **I14**, static rule **D12**). A bare `db.query(...).run(...)` fails `scripts/structure-audit/check-nimbus-invariants.ts` before the test suite even starts, and skips the `SQLITE_FULL` → `setDiskSpaceWarning` handling.
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
import { dbStmtRun } from "../db/write.ts";

const UNDERSTANDING_TYPES = ["image_understanding", "video_understanding"] as const;

export function pruneOrphanedUnderstandings(db: Database): number {
  // dbStmtRun, never a bare .run() — invariant I14 / static rule D12. A raw call fails the
  // structure audit before the tests run, and skips the SQLITE_FULL -> disk-space-warning path.
  const stmt = db.query(
    `DELETE FROM item
      WHERE service = 'nimbus'
        AND type IN (${UNDERSTANDING_TYPES.map(() => "?").join(", ")})
        AND json_extract(metadata, '$.derivedFrom') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM item AS src
           WHERE src.id = json_extract(item.metadata, '$.derivedFrom')
        )`,
  );
  const result = dbStmtRun(stmt, ...UNDERSTANDING_TYPES);
  return result.changes;
}
```

**Verify the invariant, not just the test:**

Run: `bun run audit:invariants`
Expected: PASS. Then temporarily change `dbStmtRun(stmt, …)` back to `stmt.run(…)`, re-run, and confirm D12 rejects it. Restore. A guard nobody has seen fail is a guard nobody knows works.

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

test("a NON-mime-keyed service sharing the type name 'file' is never selected", () => {
  // figma-file-mapping.ts:60 also emits type "file". If arm 1 matched it, the JS loop would drop
  // it for having no modality and the page would under-fill — the same starvation bug, via a
  // different service.
  const db = freshIndexDb();
  insertItem(db, {
    id: "figma:f1", service: "figma", type: "file", metadata: { mimeType: "image/png" },
  });
  expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
});

test("a Drive FOLDER is excluded — its mime fails every pattern", () => {
  const db = freshIndexDb();
  insertItem(db, {
    id: "google_drive:d1", service: "google_drive", type: "folder",
    metadata: { mimeType: "application/vnd.google-apps.folder" },
  });
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

**`mediaItemTypesForModality` is left EXACTLY as it is** — returning only the `ITEM_TYPE_MODALITY` (type-keyed) types. Do not add the cloud types to it.

An earlier draft of this plan unioned the mime-keyed types (`photo`, `file`) into its result. That is wrong, and wrong in the specific way this task exists to prevent: `connectors/figma-file-mapping.ts:60` emits `type: "file"` and Figma is **not** a mime-keyed service, so every Figma file would match arm 1 of the SQL below, `modalityForItem("figma", "file")` would return `undefined`, the JS loop would drop it, and the page would under-fill — cursor starvation, re-introduced through a different service.

The two arms are disjoint by construction: arm 1 selects **non**-mime-keyed services by type, arm 2 selects mime-keyed services by mime. Arm 2 needs no type list at all — a Drive folder carries `application/vnd.google-apps.folder`, which fails every mime pattern, so folders are excluded without one.

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

- [ ] **Step 4b: Carry `externalId` on `MediaCandidate`**

Task 8's resolvers need the provider's own id (`mediaItems/{id}`, `drive/v3/files/{id}`). Select the column rather than reverse-engineering it from the primary key:

```ts
// media-discovery.ts — add to the SELECT list and the CandidateRow interface
SELECT src.id, src.service, src.external_id, src.type, src.title, src.url, src.metadata
```

```ts
// media-types.ts — MediaCandidate
  /** The PROVIDER's own id, read from the column. */
  readonly externalId: string;
```

Do **not** derive it with `itemId.slice(service.length + 1)`. `index/item-key.ts`'s `itemPrimaryKey` is idempotent — it returns `externalId` unchanged when it already starts with `${service}:` — so the key is not always `service` + `:` + `externalId`, and that slice would silently produce a wrong id for the one case that round-trips. The column is right there.

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

test("STRIPS Authorization when the redirect crosses an origin", async () => {
  const seen: (string | null)[] = [];
  let calls = 0;
  const fetchFn = ((_u: URL | string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? new Response(null, { status: 302, headers: { location: "https://cdn.other.test/b" } })
        : new Response("BYTES", { status: 200 }),
    );
  }) as unknown as typeof fetch;

  await safeFetchFollowing(
    "https://api.example.test/a",
    { headers: { Authorization: "Bearer SECRET" } },
    { fetchFn, lookupFn: publicLookup },
  );
  expect(seen).toEqual(["Bearer SECRET", null]);
});

test("KEEPS Authorization on a same-origin redirect", async () => {
  const seen: (string | null)[] = [];
  let calls = 0;
  const fetchFn = ((_u: URL | string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? new Response(null, { status: 302, headers: { location: "https://api.example.test/b" } })
        : new Response("BYTES", { status: 200 }),
    );
  }) as unknown as typeof fetch;

  await safeFetchFollowing(
    "https://api.example.test/a",
    { headers: { Authorization: "Bearer SECRET" } },
    { fetchFn, lookupFn: publicLookup },
  );
  expect(seen).toEqual(["Bearer SECRET", "Bearer SECRET"]);
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
  let current: RequestInit = { ...init };

  for (let hop = 0; hop <= maxHops; hop += 1) {
    // Every hop, not just the first: assertSafeUrl + the DNS check run inside safeFetch.
    const res = await safeFetch(url, { ...current, redirect: "manual" }, deps);
    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (location === null || location === "") return res;
    const next = new URL(location, url).toString();

    // STRIP the credential when the origin changes. Taking over redirect handling means taking
    // over the header stripping the runtime was doing for us — and this path is LIVE, not
    // theoretical: a Drive `alt=media` download carries a bearer to `www.googleapis.com` and is
    // routinely 302'd to `*.googleusercontent.com`. Forwarding it there would hand an OAuth token
    // to a host we never authenticated to, which is the exact failure the credential rule
    // (spec § 16.4) exists to prevent.
    if (new URL(next).origin !== new URL(url).origin) {
      const headers = new Headers(current.headers);
      headers.delete("authorization");
      current = { ...current, headers };
    }
    url = next;
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

- [ ] **Step 5: Write the failing test for the RESOLVER**

The three helpers above are pure and take a URL they are given. Two of the three services do not *have* one yet: a Photos `baseUrl` expires in ~1 hour so the indexed copy is dead (spec § 16.6), and OneDrive's `@microsoft.graph.downloadUrl` is not indexed at all. Something has to call the provider first.

That lives in a **separate, impure module** — `cloud-url-resolver.ts` — so `cloud-renditions.ts` stays pure and the credential rule stays testable with no network at all. Create `cloud-url-resolver.test.ts`:

```ts
describe("resolveCloudByteUrl", () => {
  test("drive needs no round-trip — the URL is constructed from the external id", async () => {
    let called = false;
    const r = await resolveCloudByteUrl(driveCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => { called = true; return new Response("{}"); },
    });
    expect(called).toBe(false);
    expect(r).toEqual({ kind: "constructed", url: expect.stringContaining("alt=media"), bearer: true });
  });

  test("photos RE-RESOLVES baseUrl rather than trusting the indexed one", async () => {
    let requested = "";
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async (u) => {
        requested = u;
        return new Response(JSON.stringify({ baseUrl: "https://lh3.example/fresh" }));
      },
    });
    expect(requested).toContain("/v1/mediaItems/p1");
    expect(r).toEqual({ kind: "provider", url: "https://lh3.example/fresh", bearer: false });
  });

  test("photos with no baseUrl in the response is a fetch_miss, not a crash", async () => {
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response(JSON.stringify({ id: "p1" })),
    });
    expect(r).toEqual({ error: "fetch_miss" });
  });

  test("onedrive reads @microsoft.graph.downloadUrl", async () => {
    const r = await resolveCloudByteUrl(onedriveCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () =>
        new Response(JSON.stringify({ "@microsoft.graph.downloadUrl": "https://x.sharepoint.test/d" })),
    });
    expect(r).toEqual({ kind: "provider", url: "https://x.sharepoint.test/d", bearer: false });
  });

  test("a missing credential is not_configured, and no request is made", async () => {
    let called = false;
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => null,
      fetchFn: async () => { called = true; return new Response("{}"); },
    });
    expect(r).toEqual({ error: "not_configured" });
    expect(called).toBe(false);
  });

  test("an unknown service resolves nothing rather than guessing", async () => {
    const r = await resolveCloudByteUrl({ ...photosCandidate, service: "dropbox" }, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response("{}"),
    });
    expect(r).toEqual({ error: "unresolvable_modality" });
  });
});
```

Run: `bun test packages/gateway/src/multimodal/cloud-url-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the resolver**

```ts
// packages/gateway/src/multimodal/cloud-url-resolver.ts
/**
 * Turns a cloud candidate into the URL its bytes live at (spec § 16.6).
 *
 * Separate from `cloud-renditions.ts` ON PURPOSE: that module is pure, which is what lets the
 * credential rule be tested with no network and no vault. This one talks to a provider, so it
 * takes its collaborators as injected functions rather than reaching for a global `fetch`.
 *
 * Drive alone needs no round-trip — its byte URL is constructed from the external id. The other
 * two must ASK, because a Photos `baseUrl` expires in about an hour and OneDrive's
 * `@microsoft.graph.downloadUrl` is never indexed. Same rule as the local arm's: what the item
 * stored is not trusted (§ 5.1) — there for security, here for plain correctness.
 *
 * The resolve request itself carries a bearer to a host WE construct. The URL it returns for
 * Photos and OneDrive is pre-signed and is fetched with no credential at all.
 */
import { type ByteUrl, driveByteUrl, onedriveByteUrl, photosByteUrl } from "./cloud-renditions.ts";
import type { MediaCandidate, SkipReason } from "./media-types.ts";

export interface CloudUrlResolverDeps {
  readonly bearerFor: (service: string) => Promise<string | null>;
  readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
}

export type ResolvedByteUrl = ByteUrl | { readonly error: SkipReason };

/** Narrows an untyped JSON body without an assertion — external data is `unknown` (no-`any` rule). */
function stringField(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : null;
}

export async function resolveCloudByteUrl(
  candidate: MediaCandidate,
  preferRenditions: boolean,
  deps: CloudUrlResolverDeps,
): Promise<ResolvedByteUrl> {
  if (candidate.service === "google_drive") {
    return driveByteUrl(candidate.externalId);
  }

  if (candidate.service !== "google_photos" && candidate.service !== "onedrive") {
    return { error: "unresolvable_modality" };
  }

  const token = await deps.bearerFor(candidate.service);
  if (token === null) return { error: "not_configured" };

  const id = encodeURIComponent(candidate.externalId);
  const url =
    candidate.service === "google_photos"
      ? `https://photoslibrary.googleapis.com/v1/mediaItems/${id}`
      : `https://graph.microsoft.com/v1.0/me/drive/items/${id}`;

  const res = await deps.fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: res.status === 429 ? "rate_limited" : "fetch_miss" };

  const body: unknown = await res.json();
  if (candidate.service === "google_photos") {
    const baseUrl = stringField(body, "baseUrl");
    return baseUrl === null
      ? { error: "fetch_miss" }
      : photosByteUrl(baseUrl, candidate.modality, preferRenditions);
  }

  const downloadUrl = stringField(body, "@microsoft.graph.downloadUrl");
  return downloadUrl === null ? { error: "fetch_miss" } : onedriveByteUrl(downloadUrl);
}
```

**Note on `sync-capabilities.ts`:** the plan's original file list named a `fetchBytes` capability there, following spec § 5.2. It is not needed and is **dropped**: that capability exists so a *connector's own sync* can reach a credential without holding a vault handle, and this resolver is not a connector — it is gateway code that already receives `bearerFor` as an injected function, scoped by the caller. Adding a capability nothing consumes would widen the D24 boundary for no gain.

- [ ] **Step 7: Run tests**

Run: `bun test packages/gateway/src/multimodal/cloud-url-resolver.test.ts packages/gateway/src/multimodal/cloud-renditions.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/multimodal/cloud-renditions.ts packages/gateway/src/multimodal/cloud-renditions.test.ts packages/gateway/src/multimodal/cloud-url-resolver.ts packages/gateway/src/multimodal/cloud-url-resolver.test.ts
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
    | { readonly ok: false; readonly stop: "budget_exhausted" | "rate_limited"; readonly fetched: number };
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

  test("refuses a provider-returned http: URL", async () => {
    const insecure: ByteUrl = { kind: "provider", url: "http://example.test/i.jpg", bearer: false };
    let fetched = false;
    const deps = fakeDeps({ fetchFn: async () => { fetched = true; return new Response("AB"); } });
    expect(await fetchCloudBytes(imageCandidate, insecure, deps)).toEqual({
      ok: false, reason: "fetch_miss",
    });
    expect(fetched).toBe(false);
  });

  test("refuses BEFORE streaming when the declared length exceeds the run budget", async () => {
    let bodyRead = false;
    const deps = fakeDeps({
      remainingBudget: 10,
      fetchFn: async () =>
        new Response(new ReadableStream({ pull() { bodyRead = true; } }), {
          headers: { "content-length": "500000000" },
        }),
    });
    expect(await fetchCloudBytes(imageCandidate, providerUrl, deps)).toEqual({
      ok: false, stop: "budget_exhausted", fetched: 0,
    });
    expect(bodyRead).toBe(false);
  });

  test("refuses over the per-artifact cap rather than truncating", async () => {
    const deps = fakeDeps({ maxBytes: 1, fetchFn: async () => new Response("ABCDEF") });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, reason: "over_byte_cap" });
  });

  test("stops the RUN when the streaming budget is exhausted mid-download", async () => {
    const deps = fakeDeps({ remainingBudget: 3, fetchFn: async () => new Response("ABCDEFGHIJ") });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, stop: "budget_exhausted", fetched: expect.any(Number) });
  });

  test("a 429 that persists stops the run rather than skipping the item", async () => {
    const deps = fakeDeps({
      fetchFn: async () => new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, stop: "rate_limited", fetched: 0 });
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
  | { readonly ok: false; readonly stop: "budget_exhausted" | "rate_limited"; readonly fetched: number };

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
  // A provider-returned URL is pinned to https: (spec § 16.4). `assertSafeUrl` permits both
  // schemes — it guards the HOST, not the transport — so this check is not redundant with it.
  // Checked BEFORE the ledger append: a URL we will never fetch should not produce an egress row
  // claiming we did.
  if (byteUrl.kind === "provider") {
    let parsed: URL;
    try {
      parsed = new URL(byteUrl.url);
    } catch {
      return { ok: false, reason: "fetch_miss" };
    }
    if (parsed.protocol !== "https:") return { ok: false, reason: "fetch_miss" };
  }

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
    if (attempt >= MAX_429_RETRIES) return { ok: false, stop: "rate_limited", fetched: 0 };
    const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000;
    await deps.sleep(waitMs + Math.floor(Math.random() * 250));
  }
  if (!res.ok) return { ok: false, reason: "fetch_miss" };

  // A declared length lets an oversized artifact be refused without transferring it at all.
  // Both bounds are checked here, not just the per-artifact one: streaming 10 MB of a 500 MB file
  // before tripping the run budget spends exactly the resource the budget exists to conserve.
  // `content-length` is a HINT, not a guarantee — it can be absent, or wrong — so the per-chunk
  // checks below still run. This is an optimisation over them, never a replacement.
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared)) {
    if (declared > deps.maxBytes) {
      controller.abort();
      return { ok: false, reason: "over_byte_cap" };
    }
    if (declared > deps.remainingBudget) {
      controller.abort();
      return { ok: false, stop: "budget_exhausted", fetched: 0 };
    }
  }

  return candidate.modality === "image"
    ? await collectToMemory(res, controller, deps)
    : await collectToScratch(res, controller, deps);
}
```

Both collectors share one loop shape: read chunks from `res.body`, accumulate a running count, and after each chunk check the per-artifact cap (`over_byte_cap`, abort) and then the run budget (`budget_exhausted`, abort). `collectToScratch` writes to `join(deps.scratchDir, CLOUD_SCRATCH_PREFIX + randomUUID())` with no extension, via `createWriteStream(path, { mode: 0o600 })` — the mode goes on **creation**, not a `chmodSync` afterwards, so there is no window in which the file exists world-readable under a permissive umask. It removes the file in a `finally` on every non-`ok` exit. Write them as two small functions in this file rather than one branching one — the memory arm returns bytes and the disk arm owns a file lifecycle, and merging them makes the cleanup path harder to see.

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

test("deletes a cloud AV scratch file after a SUCCESSFUL understanding", async () => {
  const deps = passDeps({ candidates: [avCloudCandidate] });
  const summary = await runMediaPass(deps);
  expect(summary.understood).toBe(1);
  expect(readdirSync(deps.scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
});

test("deletes the scratch file even when understanding THROWS", async () => {
  const deps = passDeps({
    candidates: [avCloudCandidate],
    gate: { ...gateStub, understand: async () => { throw new Error("model died"); } },
  });
  await runMediaPass(deps).catch(() => undefined);
  expect(readdirSync(deps.scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
});

test("counts partial bytes transferred before a budget abort", async () => {
  // 1.8 MB really crossed the wire before the abort. Reporting 0 would understate what the run
  // actually cost the user's connection and quota.
  const deps = passDeps({ candidates: [c1], cloudFetch: async () => ({ ok: false, stop: "budget_exhausted", fetched: 1_800_000 }) });
  expect((await runMediaPass(deps)).cloudBytesFetched).toBe(1_800_000);
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
3. Route a cloud candidate (`sourcePath === null`) through `resolveCloudByteUrl` then `fetchCloudBytes`; a local one through `resolveLocalMediaPath`, unchanged. A resolver `{ error }` is a per-item skip.
4. **Delete the cloud scratch file in a `finally` around each iteration's body.** `fetchCloudBytes` removes it on its own failure paths but *returns* it on success, and the understanding step is what consumes it — so ownership passes to this loop and this loop must release it:

   ```ts
   let cloudScratch: string | undefined;
   try {
     // …resolve, fetch, understand, writeUnderstanding…
     if (fetched.ok && fetched.kind === "path") cloudScratch = fetched.path;
   } finally {
     if (cloudScratch !== undefined) {
       try { rmSync(cloudScratch, { force: true }); } catch { /* a failed unlink must not end the pass */ }
     }
   }
   ```

   Without this, every successfully-understood cloud video stays on disk until the next pass's
   hour-old sweep — so a single run over twenty videos can hold twenty full downloads at once. The
   `finally` must also cover the throwing path, not just `continue`.
5. On a result carrying `stop`, break the loop and record that stop reason. Add its `fetched` count to `cloudBytesFetched` first — those bytes really crossed the wire.
6. Guard the cursor clear: `if (stopReason === "completed" && candidates.length < deps.limit)`.
7. **Wire `fetchFn` to `safeFetchFollowing` in `build-media-pass-deps.ts`, and assert the wiring.** Task 6 builds the redirect-re-validating fetch and Task 9 takes `fetchFn` as an injected dependency — nothing else connects them, so without this step both the SSRF re-validation and the cross-origin credential stripping exist and never run. Both `CloudBytesDeps.fetchFn` and `CloudUrlResolverDeps.fetchFn` get it:

   ```ts
   test("the constructed deps fetch through safeFetchFollowing, not bare fetch", async () => {
     const deps = buildMediaPassDeps({ /* …minimal input… */ });
     // A loopback URL must be REFUSED by the wiring itself. Bare `fetch` would happily return.
     await expect(deps.cloudBytes.fetchFn("http://127.0.0.1:9/x", {})).rejects.toThrow(
       /loopback\/private/,
     );
   });
   ```

   A guard that is built and never wired is worse than one that was never built — it reads as protection in every later review.
8. Pass the rendition mode into `writeUnderstanding` so the derived row records `rendition: "original" | "w2048-h2048" | "dv"` in metadata **and** states it in the body. The body sentence is what a reader sees; the metadata field is what a later pass can filter on, the same split `framesSampled`/`framesCaptioned` already uses (§ 12.8).

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

test("a value-less flag does not swallow the next flag", async () => {
  // The existing loop steps i += 2, so `--renditions` would consume `--limit` as its value.
  const parsed = parseMediaArgs(["understand", "--renditions", "--limit", "10"]);
  expect(parsed.params.renditions).toBe(true);
  expect(parsed.params.limit).toBe(10);
});

test("a value-less flag at the END does not throw 'requires a value'", async () => {
  expect(() => parseMediaArgs(["understand", "--renditions"])).not.toThrow();
});

test("--budget uses the unit it was GIVEN — GB is decimal, GiB is binary", async () => {
  expect(parseBudget("4GB")).toBe(4_000_000_000);
  expect(parseBudget("4GiB")).toBe(4 * 1024 ** 3);
  expect(parseBudget("500MB")).toBe(500_000_000);
  expect(parseBudget("1.5GiB")).toBe(Math.round(1.5 * 1024 ** 3));
  expect(parseBudget("1048576")).toBe(1048576);
  expect(parseBudget("lots")).toBeNull();
  expect(parseBudget("-1GB")).toBeNull();
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

**First, fix the loop.** `parseMediaArgs` (`media-cmd.ts:87`) is `for (let i = 1; i < argv.length; i += 2)` and treats every token as a flag/value pair — so `--renditions` swallows the next flag as its value, or throws `"--renditions requires a value"` when it is last. Both boolean flags are unusable until this changes. Rewrite as a `while` loop that consumes value-less flags with `i += 1` and flag/value pairs with `i += 2`:

```ts
  let i = 1;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === "--renditions" || flag === "--originals") {
      if (flag === "--renditions") params.renditions = true;
      else params.originals = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`nimbus media: ${flag ?? ""} requires a value`);
    }
    switch (flag) {
      // …existing cases, unchanged…
      case "--budget":
        params.budgetBytes = parseBudget(value);
        break;
      default:
        throw new Error(`nimbus media: unknown flag "${flag ?? ""}"`);
    }
    i += 2;
  }
```

Then reject the flag pair with an explicit message naming both — never resolve by precedence; a silent override on a pair that controls bandwidth is something a user discovers from their data cap.

`parseBudget` accepts a raw byte count or a number with a unit, case-insensitively. **`GB` and `GiB` are not the same number and are not treated as such**: `GB`/`MB`/`KB` are decimal (10³ⁿ), `GiB`/`MiB`/`KiB` binary (2¹⁰ⁿ). Collapsing them would silently grant 7% more than a user typing `4GB` asked for — small, but it is a number reported back to them in the summary, and a budget that does not mean what it says is worse than no budget. Negative and non-finite values return `null`.

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
grep -rn "targeted-fetch" CLAUDE.md GEMINI.md docs/SECURITY-INVARIANTS.md docs/architecture.md .claude/commands/nimbus-egress.md
```

**`docs/architecture.md:1837` carries the enumeration too** — inside the long I29 coverage-vector bullet, which names `sync/scheduler.ts` and `sync/targeted-fetch.ts` as the two appenders sharing `recordSyncEgress`. It is easy to miss because it is one clause inside a very long paragraph, which is exactly how a restatement goes stale.

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

> **Amended after the plan review — see the Review Disposition below.** This pass originally
> matched each spec section to a *task* and called that coverage. It is not: § 16.6 was mapped to
> Task 8 when no *step* in Task 8 implemented it. **Coverage means a spec section maps to a step
> that carries real code**, and the mapping below now names steps wherever the task alone is
> ambiguous.

**Spec coverage.** § 16.1 → Tasks 8–9 (single-repo, no `nimbus-mcp-servers` change). § 16.2 → Tasks 8–10. § 16.3 → Tasks 3, 9, 10, 13. § 16.4 → Tasks 6, 8, 9. § 16.5 → Task 5. § 16.6 → Task 8 **step 6** (`cloud-url-resolver.ts` re-resolves the Photos `baseUrl` via `mediaItems/{id}`; OneDrive's `downloadUrl` likewise). § 16.7 → Task 13 (Zoom recorded as a follow-up). § 16.8 → Tasks 7, 8, 12. § 16.9 → Tasks 1, 7, 9, 11. § 16.10 → Task 9 step 4. § 16.11 → Tasks 9, 13. § 16.12 → tests throughout. § 16.13 → Task 13. § 17.1 → Task 5. § 17.2 → Task 6. § 17.3 → Tasks 4, 9, 11. § 17.4 → Task 3. § 17.5 → Task 9. § 17.6 → Task 2 (orphan prune); I37/D27 correctly absent — PR 4. § 17.7 → Task 1. § 17.8 → Task 12. § 17.9 → Tasks 5, 6, 9.

**Not covered, deliberately:** I37, D27, `media_grant`/V59, the remote arm, remote STT, diarization, OCR — all PR 4 or explicitly out of scope. No task adds a remote model, so no task adds an egress class.

**Placeholder scan:** no "TBD", no "add error handling", no "similar to Task N". Every code step carries real code; the two steps that describe a shape rather than paste it (Task 9's collectors, Task 11's loop changes) state the exact structure and the reason for it.

**Type consistency:** `MediaSource` (Task 10) is the type `resolveLocalMediaPath` and `fetchCloudBytes` both produce and `understandArtifact` consumes. `CloudBytes.stop` values (`"budget_exhausted"` / `"rate_limited"`) match `MediaPassStopReason` (Task 4) exactly. `CLOUD_SCRATCH_PREFIX` is defined in Task 3 and consumed in Task 9. `mediaSourceBytes` is defined in Task 1 and consumed in Tasks 5 and 11. `ByteUrl` is defined in Task 8 and consumed in Task 9.

**One ordering constraint that is load-bearing:** Task 5 must land before any cloud `(service, type)` pair can be discovered, or the pass silently truncates. Tasks 1–4 are independent shipped-code fixes and can be reviewed in any order among themselves.

---

## Review Disposition (plan review, 2026-09-04)

Review: [`2026-09-04-multimodal-pr3-cloud-arm-review.md`](./2026-09-04-multimodal-pr3-cloud-arm-review.md)
(Antigravity). Every finding was checked against the code before being accepted. **All five
"blockers" were real** — three of them defects in this plan, one an invariant violation, one a
credential leak in code this plan itself introduced.

| # | Finding | Verdict | Landed in |
| --- | --- | --- | --- |
| 2.1 | Cloud byte-URL resolution pipeline missing | **Accepted, fix relocated** | Task 8 steps 5–8 |
| 2.2 | Cloud AV scratch file leaks on the SUCCESS path | **Accepted** | Task 11 step 4 |
| 2.3 | `parseMediaArgs` cannot parse a value-less flag | **Accepted** | Task 12 step 3 |
| 2.4 | No `https:` pinning on provider-returned URLs | **Accepted** | Task 9 steps 1, 3 |
| 2.5 | `safeFetchFollowing` forwards `Authorization` cross-origin | **Accepted** | Task 6 steps 2, 4 |
| 3.1 | No pre-emptive check of `content-length` vs run budget | **Accepted** | Task 9 step 3 |
| 3.2 | `pruneOrphanedUnderstandings` bypasses I14 / D12 | **Accepted** | Task 2 step 3 + Global Constraints |
| 3.3 | `chmod` after create leaves a umask window | **Accepted** | Task 9 step 3 |
| 3.4 | `parseBudget` unit handling | **Accepted, values corrected** | Task 12 |
| 3.5 | `docs/architecture.md` also enumerates the `sync` appenders | **Accepted** | Task 13 step 2 |
| OQ 1 | Rendition disclosed on the derived row | **Yes — body AND metadata** | Task 11 step 7 |
| OQ 2 | Count partial bytes on a budget abort | **Yes** | Task 11 step 5 |
| OQ 3 | OneDrive thumbnail renditions | **Deferred; spec corrected** | spec § 16.8 |

### The three that were this plan's own defects

**2.1 — work named in prose but present in no step.** The file list said Task 8 modifies the three
connector sync files, and the self-review asserted "§ 16.6 → Task 8 (Photos re-resolve; the helper
is exported from `google-photos-sync.ts`)". No step did it, and nothing turned a candidate into a
`ByteUrl`, so Photos and OneDrive would have been undeliverable in production. **The self-review is
what failed**: its spec-coverage pass matched each spec section to a task by *intent* and never
checked that a step existed to carry it. Matching section→task is not coverage; matching
section→**step** is.

**2.2 — the leak is on the path that works.** `fetchCloudBytes` cleans up on its own failure paths
and *returns* the path on success, so ownership passes to the pass loop — which had no `finally`.
Every successfully-understood cloud video would sit on disk until the next pass's hour-old sweep, so
one run over twenty videos holds twenty full downloads at once. The sweeper (Task 3) would have
masked it into a slow disk-fill rather than an obvious bug.

**2.5 — a credential leak in the function written to prevent credential leaks.** Taking over
redirect handling meant taking over the `Authorization` stripping the runtime had been doing, and
the plan's `safeFetchFollowing` passed `init` through unchanged on every hop. This is **live, not
theoretical**: a Drive `alt=media` download carries a bearer to `www.googleapis.com` and is
routinely 302'd to `*.googleusercontent.com`. The empirical probe that showed Bun 1.3.14 strips the
header is exactly what made the regression invisible — the property was verified on the code path
being *replaced*.

### 3.2 was an invariant violation, not a style note

`db.query(...).run(...)` fails static rule **D12** in
`scripts/structure-audit/check-nimbus-invariants.ts`, which runs *before* the test suite — so the
task would have failed the build at its first gate. I14 is now in Global Constraints, where I9
already was; listing one write-path invariant and omitting the other is what let it through.

### Two fixes taken, but not in the shape proposed

**2.1's location.** The review put the network resolution inside `cloud-renditions.ts`, adding
`fetchFn` and `bearerFor` to it. Rejected: that module is deliberately **pure** — "no network, no
vault, no clock — so the rule is testable without either" — and the credential rule is the thing it
exists to make testable. The resolution lives in a new impure `cloud-url-resolver.ts` that consumes
the pure helpers instead.

**2.1's id derivation.** The review derived the provider id as
`candidate.itemId.slice(candidate.service.length + 1)`. Rejected: `index/item-key.ts`'s
`itemPrimaryKey` is **idempotent** — it returns `externalId` unchanged when it already begins with
`${service}:` — so the key is not always `service` + `:` + `externalId`, and that slice silently
produces a wrong id for the case that round-trips. `external_id` is a column; Task 5 step 4b selects
it and carries it on `MediaCandidate`.

**3.4's unit values.** The review's `parseBudget` maps `GB` to 1024³. Rejected: `GB` is decimal and
`GiB` is binary, and collapsing them silently grants 7% more than a user typing `4GB` asked for. Both
spellings are accepted and each means what it says. The number is reported back in the run summary,
so a budget that does not mean what it says is worse than no budget.

### Dropped from the plan

**The `fetchBytes` capability in `sync/sync-capabilities.ts`** (spec § 5.2) is not needed and no task
adds it. That capability exists so a *connector's own sync* can reach a credential without holding a
vault handle. `cloud-url-resolver.ts` is not a connector — it is gateway code that receives
`bearerFor` as an injected function, already scoped by its caller. Adding a capability nothing
consumes would widen the D24 boundary for nothing.
