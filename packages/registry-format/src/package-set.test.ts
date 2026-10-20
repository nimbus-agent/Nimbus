import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPackageFile, listPackageFiles } from "./package-set.ts";

const CAN_SYMLINK = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "nimbus-symprobe-"));
  try {
    writeFileSync(join(probe, "a"), "a");
    symlinkSync(join(probe, "a"), join(probe, "b"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

function touch(root: string, rel: string): void {
  const parts = rel.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), "x");
}

describe("package file set", () => {
  test("listPackageFiles keeps manifest, dist and README/LICENSE and drops node_modules, src and tests", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-pkgset-"));
    try {
      for (const f of [
        "nimbus.extension.json",
        "dist/index.js",
        "dist/lib/util.js",
        "README.md",
        "LICENSE",
        "node_modules/dep/index.js",
        "src/index.ts",
        "test/a.test.ts",
        "package.json",
        ".env",
      ]) {
        touch(root, f);
      }
      expect(listPackageFiles(root)).toEqual([
        "LICENSE",
        "README.md",
        "dist/index.js",
        "dist/lib/util.js",
        "nimbus.extension.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("LICENSE.md and readme.txt match case-insensitively", () => {
    expect(isPackageFile("LICENSE.md")).toBe(true);
    expect(isPackageFile("readme.txt")).toBe(true);
    expect(isPackageFile("README")).toBe(true);
    expect(isPackageFile("README-extra.md")).toBe(false);
    expect(isPackageFile("docs/README.md")).toBe(false);
    expect(isPackageFile("dist/")).toBe(false);
    expect(isPackageFile("dist/a.js")).toBe(true);
    expect(isPackageFile("distant/a.js")).toBe(false);
    expect(isPackageFile("nimbus.extension.json")).toBe(true);
  });

  test.skipIf(!CAN_SYMLINK)(
    "a symlink inside the set is refused; one outside it is ignored",
    () => {
      const root = mkdtempSync(join(tmpdir(), "nimbus-pkgset-"));
      try {
        touch(root, "nimbus.extension.json");
        touch(root, "target.txt");
        symlinkSync(join(root, "target.txt"), join(root, "node_modules"));
        expect(listPackageFiles(root)).toEqual(["nimbus.extension.json"]);
        symlinkSync(join(root, "target.txt"), join(root, "README.md"));
        expect(() => listPackageFiles(root)).toThrow(/symlink/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
