// packages/gateway/src/multimodal/media-bytes.test.ts

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalMediaPath } from "./media-bytes.ts";
import type { MediaCandidate } from "./media-types.ts";

/**
 * Symlink creation can require elevated privilege on Windows (no Developer Mode, non-admin
 * process). Probed once at module load, synchronously, so `test.skipIf` sees a real boolean
 * rather than guessing from `process.platform` alone — a platform guess would both skip
 * unnecessarily on a Windows box that CAN create symlinks and (in principle) miss a host where
 * the platform check says "should work" but the filesystem still refuses.
 */
function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-symlink-probe-"));
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "x");
    symlinkSync(target, join(dir, "link"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    // Anything other than a privilege problem is a real bug in the probe itself — surface it
    // rather than silently treating it the same as EPERM.
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CAN_SYMLINK = canCreateSymlinks();
if (!CAN_SYMLINK) {
  console.warn(
    "media-bytes.test.ts: skipping the symlink-escape test — symlinkSync raised EPERM " +
      "(this host/user cannot create symlinks; the branch it covers stays otherwise untested here)",
  );
}

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

  test("refuses when the file on DISK is over the cap even though the indexed size is small", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
    const file = join(root, "grew.mp4");
    writeFileSync(file, "x".repeat(2_000));
    // Indexed size is stale and under the cap; the live file is over it.
    const out = resolveLocalMediaPath(candidate(file, 10), [root], 1_000);
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

  test.skipIf(!CAN_SYMLINK)(
    "refuses a symlink INSIDE a root that resolves OUTSIDE it — the post-realpath re-check",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nimbus-roots-"));
      const outside = mkdtempSync(join(tmpdir(), "nimbus-outside-"));
      const secret = join(outside, "secret.mp4");
      writeFileSync(secret, "x");
      // The link's own path IS inside the configured root, so the FIRST containment check (on
      // the unresolved path) passes it through — this test is only meaningful because of that.
      const link = join(root, "escape-link.mp4");
      symlinkSync(secret, link);

      const out = resolveLocalMediaPath(candidate(link), [root], 1000);
      expect(out).toEqual({ ok: false, reason: "path_outside_roots" });
    },
  );
});
