/**
 * Which manifest FILE a directory resolves to. The parser's own refusals are pinned in
 * `@nimbus-dev/registry-format`'s `manifest.coverage.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_MANIFEST_FILENAME_LEGACY,
  resolveExtensionManifestPath,
} from "./manifest.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveExtensionManifestPath", () => {
  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "nimbus-manifest-cov-"));
    dirs.push(d);
    return d;
  }

  test("a directory with no manifest resolves to undefined", () => {
    expect(resolveExtensionManifestPath(tempDir())).toBeUndefined();
  });

  test("the legacy filename is still found when it is the only one", () => {
    const d = tempDir();
    writeFileSync(join(d, EXTENSION_MANIFEST_FILENAME_LEGACY), "{}");
    expect(resolveExtensionManifestPath(d)).toBe(join(d, EXTENSION_MANIFEST_FILENAME_LEGACY));
  });

  test("the current filename wins when both are present", () => {
    const d = tempDir();
    writeFileSync(join(d, EXTENSION_MANIFEST_FILENAME_LEGACY), "{}");
    writeFileSync(join(d, EXTENSION_MANIFEST_FILENAME), "{}");
    expect(resolveExtensionManifestPath(d)).toBe(join(d, EXTENSION_MANIFEST_FILENAME));
  });
});
