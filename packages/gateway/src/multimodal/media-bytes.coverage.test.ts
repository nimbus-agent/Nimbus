/**
 * Containment arms of `resolveLocalMediaPath` that `media-bytes.test.ts` does not reach: a root
 * that names the artifact itself, a root that already ends in a separator (a filesystem root),
 * and a configured root that no longer exists on disk.
 *
 * Every fixture lives in a fresh mkdtemp directory. The filesystem-root case reads only that
 * root's real path — it creates nothing outside the temp directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { resolveLocalMediaPath } from "./media-bytes.ts";
import type { MediaCandidate } from "./media-types.ts";

function candidate(path: string): MediaCandidate {
  return {
    itemId: "filesystem:clip",
    service: "filesystem",
    externalId: "clip",
    type: "media_av",
    title: "clip",
    url: null,
    modality: "av",
    sourcePath: path,
    sourceMime: null,
    sourceBytes: 4,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-media-bytes-cov-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveLocalMediaPath — containment edges", () => {
  test("a root that names the artifact itself contains it (the equality arm, not only 'beneath')", () => {
    const clip = join(dir, "clip.mp4");
    writeFileSync(clip, "abcd");
    expect(resolveLocalMediaPath(candidate(clip), [clip], 1_000)).toEqual({
      ok: true,
      source: { kind: "path", path: realpathSync(clip) },
    });
    // Control: a sibling whose name merely EXTENDS the root's is not the root and not beneath it.
    const sibling = join(dir, "clip.mp4.bak");
    writeFileSync(sibling, "abcd");
    expect(resolveLocalMediaPath(candidate(sibling), [clip], 1_000)).toEqual({
      ok: false,
      reason: "path_outside_roots",
    });
  });

  test("a filesystem-root root, which already ends in a separator, still contains what is under it", () => {
    // `/` (or `C:\`) already ends in the separator, so appending another would produce `//` (or
    // `C:\\`), which no resolved path starts with — every artifact would read as outside its root.
    const clip = join(dir, "clip.mp4");
    writeFileSync(clip, "abcd");
    const fsRoot = parse(clip).root;
    expect(fsRoot.length).toBeGreaterThan(0);
    expect(resolveLocalMediaPath(candidate(clip), [fsRoot], 1_000)).toEqual({
      ok: true,
      source: { kind: "path", path: realpathSync(clip) },
    });
  });

  test("a configured root that no longer exists is skipped, not fatal, for an artifact under a live root", () => {
    // Roots can be unmounted or deleted after indexing. Its real path cannot be resolved, so the
    // unresolved spelling is kept for the comparison — and the live root still answers.
    const live = join(dir, "live");
    const gone = join(dir, "unmounted-volume");
    mkdirSync(live);
    const clip = join(live, "clip.mp4");
    writeFileSync(clip, "abcd");
    expect(resolveLocalMediaPath(candidate(clip), [gone, live], 1_000)).toEqual({
      ok: true,
      source: { kind: "path", path: realpathSync(clip) },
    });
    // And an artifact that was indexed under the vanished root is a miss, never a read.
    expect(resolveLocalMediaPath(candidate(join(gone, "old.mp4")), [gone, live], 1_000)).toEqual({
      ok: false,
      reason: "fetch_miss",
    });
  });
});
