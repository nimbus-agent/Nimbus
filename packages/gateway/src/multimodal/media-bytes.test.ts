// packages/gateway/src/multimodal/media-bytes.test.ts

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
