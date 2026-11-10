import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";

import {
  extractPackage,
  extractTarGzToDirectory,
  findExtensionSourceRootInTree,
  resolveSystemTarCommand,
} from "./package-extract.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "nimbus-pkg-extract-extra-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("resolveSystemTarCommand", () => {
  it("is plain tar off Windows", () => {
    expect(resolveSystemTarCommand("linux", {})).toBe("tar");
    expect(resolveSystemTarCommand("darwin", { SystemRoot: "C:X" })).toBe("tar");
  });
  it("uses System32 tar.exe under SystemRoot, then windir, on Windows", () => {
    expect(resolveSystemTarCommand("win32", { SystemRoot: "D:Win" })).toBe(
      join("D:Win", "System32", "tar.exe"),
    );
    expect(resolveSystemTarCommand("win32", { windir: "E:W" })).toBe(
      join("E:W", "System32", "tar.exe"),
    );
  });
  it("falls back to C:Windows when no root is set or it is empty", () => {
    const expected = join("C:", "Windows", "System32", "tar.exe");
    expect(resolveSystemTarCommand("win32", {})).toBe(expected);
    expect(resolveSystemTarCommand("win32", { SystemRoot: "" })).toBe(expected);
  });
});

describe("extractTarGzToDirectory", () => {
  it("reports a failed extraction of a missing archive", () => {
    const dest = join(work, "dest");
    mkdirSync(dest);
    expect(() => extractTarGzToDirectory(join(work, "missing.tgz"), dest)).toThrow(
      /failed to extract archive/,
    );
  });
});

describe("extractPackage entry rules", () => {
  it("refuses a rooted (leading slash) entry", async () => {
    const buf = Buffer.alloc(512);
    new tar.Header({ path: "/abs/evil", type: "File", size: 0 }).encode(buf, 0);
    const file = join(work, "abs.tgz");
    writeFileSync(file, gzipSync(Buffer.concat([buf, Buffer.alloc(1024)])));
    const dest = join(work, "dest");
    mkdirSync(dest);
    await expect(extractPackage(file, dest)).rejects.toThrow(/package_entry_refused/);
  });
});

describe("findExtensionSourceRootInTree", () => {
  it("refuses a tree with no manifest at the root or one folder deep", () => {
    mkdirSync(join(work, "empty", "sub"), { recursive: true });
    writeFileSync(join(work, "empty", "file.txt"), "x");
    expect(() => findExtensionSourceRootInTree(join(work, "empty"))).toThrow(
      /does not contain nimbus\.extension\.json/,
    );
  });
});
