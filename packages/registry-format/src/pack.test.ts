import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { packExtensionDir } from "./pack.ts";

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-reg-pack-"));
  writeFileSync(join(dir, "nimbus.extension.json"), '{"id":"x"}');
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "b.js"), "b");
  writeFileSync(join(dir, "dist", "a.js"), "a");
  writeFileSync(join(dir, "README.md"), "z");
  return dir;
}

function tarNames(tar: Buffer): string[] {
  const names: string[] = [];
  for (let off = 0; off + 512 <= tar.length && tar[off] !== 0; ) {
    names.push(
      tar
        .subarray(off, off + 100)
        .toString()
        .replaceAll("\0", ""),
    );
    const size = Number.parseInt(tar.subarray(off + 124, off + 136).toString(), 8);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
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

  test("file modes are normalised to 0644 regardless of on-disk mode", async () => {
    const a = makeTree();
    const b = makeTree();
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      chmodSync(join(b, "README.md"), 0o600);
      chmodSync(join(b, "dist", "a.js"), 0o755);
      await packExtensionDir(a, join(out, "a.tgz"));
      await packExtensionDir(b, join(out, "b.tgz"));
      const ba = readFileSync(join(out, "a.tgz"));
      expect(ba.equals(readFileSync(join(out, "b.tgz")))).toBe(true);
      const tar = gunzipSync(ba);
      let seen = 0;
      for (let off = 0; off + 512 <= tar.length && tar[off] !== 0; ) {
        const name = tar
          .subarray(off, off + 100)
          .toString()
          .replaceAll("\0", "");
        const mode = Number.parseInt(tar.subarray(off + 100, off + 108).toString(), 8);
        const size = Number.parseInt(tar.subarray(off + 124, off + 136).toString(), 8);
        expect([name, mode]).toEqual([name, 0o644]);
        seen++;
        off += 512 + Math.ceil(size / 512) * 512;
      }
      expect(seen).toBe(4);
    } finally {
      for (const d of [a, b, out]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("entries are listed in sorted order, nested files by their / path, directories omitted", async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      mkdirSync(join(src, "dist", "deep"));
      writeFileSync(join(src, "dist", "deep", "c.js"), "c");
      mkdirSync(join(src, "dist", "empty"));
      await packExtensionDir(src, join(out, "x.tgz"));
      expect(tarNames(gunzipSync(readFileSync(join(out, "x.tgz"))))).toEqual([
        "README.md",
        "dist/a.js",
        "dist/b.js",
        "dist/deep/c.js",
        "nimbus.extension.json",
      ]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "linux")("pack refuses a special file (FIFO)", async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      const fifo = join(src, "dist", "pipe");
      const r = Bun.spawnSync(["mkfifo", fifo]);
      expect(r.exitCode).toBe(0);
      await expect(packExtensionDir(src, join(out, "x.tgz"))).rejects.toThrow(
        "refusing to pack a special file: dist/pipe",
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("only the package file set is packed", async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      mkdirSync(join(src, "node_modules"));
      writeFileSync(join(src, "node_modules", "x.js"), "x");
      mkdirSync(join(src, "src"));
      writeFileSync(join(src, "src", "i.ts"), "i");
      writeFileSync(join(src, ".env"), "SECRET=1");
      await packExtensionDir(src, join(out, "x.tgz"));
      expect(tarNames(gunzipSync(readFileSync(join(out, "x.tgz"))))).toEqual([
        "README.md",
        "dist/a.js",
        "dist/b.js",
        "nimbus.extension.json",
      ]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("evals/** is packed with the extension", async () => {
    const src = makeTree();
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      mkdirSync(join(src, "evals"));
      writeFileSync(join(src, "evals", "a.eval.json"), "{}");
      await packExtensionDir(src, join(out, "x.tgz"));
      expect(tarNames(gunzipSync(readFileSync(join(out, "x.tgz"))))).toContain("evals/a.eval.json");
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("packs a directory holding only the manifest and README", async () => {
    const src = mkdtempSync(join(tmpdir(), "nimbus-reg-pack-"));
    const out = mkdtempSync(join(tmpdir(), "nimbus-reg-out-"));
    try {
      writeFileSync(join(src, "nimbus.extension.json"), '{"id":"x","kind":"starter-pack"}');
      writeFileSync(join(src, "README.md"), "z");
      await packExtensionDir(src, join(out, "x.tgz"));
      expect(tarNames(gunzipSync(readFileSync(join(out, "x.tgz"))))).toEqual([
        "README.md",
        "nimbus.extension.json",
      ]);
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
        symlinkSync(join(src, "README.md"), join(src, "dist", "link.txt"));
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
