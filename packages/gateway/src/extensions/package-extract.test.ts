import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";

import { extractPackage, MAX_PACKAGE_ENTRIES, MAX_UNPACKED_BYTES } from "./package-extract.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";

const MANIFEST = JSON.stringify({ id: "com.example.a", version: "1.0.0" });

let work: string;
let dest: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "nimbus-pkg-extract-"));
  dest = join(work, "dest");
  mkdirSync(dest);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function writePkg(dir: string): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "nimbus.extension.json"), MANIFEST);
  writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
}

async function pack(cwd: string, entries: string[]): Promise<string> {
  const file = join(work, `a-${String(Math.random()).slice(2)}.tgz`);
  await tar.c({ gzip: true, file, cwd }, entries);
  return file;
}

/** A gzip'd tar made of raw headers, so a declared size or entry type needs no real payload. */
function rawArchive(headers: tar.Header[]): string {
  const blocks = headers.map((h) => {
    const buf = Buffer.alloc(512);
    h.encode(buf, 0);
    return buf;
  });
  const file = join(work, `raw-${String(Math.random()).slice(2)}.tgz`);
  writeFileSync(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
  return file;
}

describe("extractPackage", () => {
  it("refuses a symlink entry before extracting anything", async () => {
    const src = join(work, "src");
    writePkg(src);
    try {
      symlinkSync("/etc/passwd", join(src, "link"));
    } catch {
      return; // symlink creation needs privilege on some Windows hosts; the raw-header case below covers the type check
    }
    const archive = await pack(src, ["nimbus.extension.json", "dist", "link"]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(/package_entry_refused: link/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("names a symlink refusal in plain words (typeflag 2 raw header)", async () => {
    const archive = rawArchive([
      new tar.Header({
        path: "pkg/evil.link",
        type: "SymbolicLink",
        linkpath: "/etc/passwd",
        size: 0,
      }),
    ]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(
      /package_entry_refused: pkg\/evil\.link \(symlink\)/i,
    );
  });

  it("names a hardlink refusal in plain words", async () => {
    const archive = rawArchive([
      new tar.Header({ path: "pkg/h", type: "Link", linkpath: "pkg/x", size: 0 }),
    ]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(/\(hardlink\)/);
  });

  it("refuses a link entry type from a raw header, extracting nothing", async () => {
    const archive = rawArchive([
      new tar.Header({ path: "evil", type: "SymbolicLink", linkpath: "/etc/passwd", size: 0 }),
    ]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(/package_entry_refused: evil/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses a ../ entry", async () => {
    const archive = rawArchive([new tar.Header({ path: "../escape.txt", type: "File", size: 0 })]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(
      /package_entry_refused: \.\.\/escape\.txt/,
    );
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses a backslash-climbing entry", async () => {
    const archive = rawArchive([new tar.Header({ path: "..\\evil", type: "File", size: 0 })]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(/package_entry_refused/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses a drive-absolute entry", async () => {
    const archive = rawArchive([new tar.Header({ path: "C:/evil", type: "File", size: 0 })]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(/package_entry_refused/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses more than MAX_PACKAGE_ENTRIES entries", async () => {
    const headers: tar.Header[] = [];
    for (let i = 0; i <= MAX_PACKAGE_ENTRIES; i++) {
      headers.push(new tar.Header({ path: `f${String(i)}`, type: "File", size: 0 }));
    }
    const archive = rawArchive(headers);
    await expect(extractPackage(archive, dest)).rejects.toThrow(/package_too_large/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses when declared sizes exceed MAX_UNPACKED_BYTES", async () => {
    const archive = rawArchive([
      new tar.Header({ path: "big.bin", type: "File", size: MAX_UNPACKED_BYTES + 1 }),
    ]);
    await expect(extractPackage(archive, dest)).rejects.toThrow(/package_too_large/);
    expect(readdirSync(dest)).toEqual([]);
  });

  it("finds the source root inside one top-level folder", async () => {
    const src = join(work, "src");
    writePkg(join(src, "pkg"));
    const archive = await pack(src, ["pkg"]);
    const out = await extractPackage(archive, dest);
    expect(out.sourceRoot).toBe(join(dest, "pkg"));
  });

  it("returns the tree digest of the source root", async () => {
    const src = join(work, "src");
    writePkg(src);
    const archive = await pack(src, ["nimbus.extension.json", "dist"]);
    const out = await extractPackage(archive, dest);
    expect(out.sourceRoot).toBe(dest);
    expect(out.treeDigest).toBe(computeExtensionTreeDigest(dest));
    expect(out.treeDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
