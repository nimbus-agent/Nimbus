import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packExtensionDir } from "./registry-pack.ts";

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-reg-pack-"));
  writeFileSync(join(dir, "manifest.json"), '{"id":"x"}');
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "b.js"), "b");
  writeFileSync(join(dir, "src", "a.js"), "a");
  writeFileSync(join(dir, "Z.txt"), "z");
  return dir;
}

describe("registry packer", () => {
  test("packing the same tree twice yields identical bytes", async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      await packExtensionDir(src, join(out, "one.tgz"));
      await new Promise((r) => setTimeout(r, 1100));
      await packExtensionDir(src, join(out, "two.tgz"));
      const one = readFileSync(join(out, "one.tgz"));
      expect(one.equals(readFileSync(join(out, "two.tgz")))).toBe(true);
      // gzip header: MTIME (bytes 4-7) is zero and the OS byte (9) is the fixed "unknown" 255.
      expect([...one.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
      expect(one[9]).toBe(255);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("pack refuses a symlink", async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      try {
        symlinkSync(join(src, "Z.txt"), join(src, "link.txt"));
      } catch {
        return; // symlink creation not permitted on this host
      }
      await expect(packExtensionDir(src, join(out, "x.tgz"))).rejects.toThrow(/symlink/i);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
