import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPackageMatchesClaims, computeExtensionPackageHashes } from "./package-hashes.ts";

const sha = (s: string): string =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-pkg-hashes-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePackage(
  manifest: Record<string, unknown>,
  entryRel: string,
  entryText: string,
): string {
  const manifestText = JSON.stringify(manifest);
  writeFileSync(join(dir, "nimbus.extension.json"), manifestText, "utf8");
  const entryPath = join(dir, ...entryRel.split("/"));
  mkdirSync(join(entryPath, ".."), { recursive: true });
  writeFileSync(entryPath, entryText, "utf8");
  return manifestText;
}

describe("computeExtensionPackageHashes", () => {
  test("hashes the manifest file and the DEFAULT entry file, not anything else", () => {
    const manifestText = writePackage({ id: "x", version: "1.0.0" }, "dist/index.js", "entry-v1");
    expect(computeExtensionPackageHashes(dir)).toEqual({
      manifestHash: sha(manifestText),
      entryHash: sha("entry-v1"),
    });
  });

  test("follows the manifest's declared entry", () => {
    const manifestText = writePackage(
      { id: "x", version: "1.0.0", entry: "lib/main.js" },
      "lib/main.js",
      "custom-entry",
    );
    expect(computeExtensionPackageHashes(dir)).toEqual({
      manifestHash: sha(manifestText),
      entryHash: sha("custom-entry"),
    });
  });

  test("refuses when the manifest is missing", () => {
    expect(() => computeExtensionPackageHashes(dir)).toThrow(/package_hash_unreadable/);
  });

  test("refuses when the entry file is missing", () => {
    writeFileSync(
      join(dir, "nimbus.extension.json"),
      JSON.stringify({ id: "x", version: "1.0.0" }),
    );
    expect(() => computeExtensionPackageHashes(dir)).toThrow(/package_hash_unreadable/);
  });

  test("refuses an entry that escapes the package directory", () => {
    writeFileSync(
      join(dir, "nimbus.extension.json"),
      JSON.stringify({ id: "x", version: "1.0.0", entry: "../outside.js" }),
    );
    expect(() => computeExtensionPackageHashes(dir)).toThrow(/package_hash_unreadable/);
  });
});

describe("assertPackageMatchesClaims", () => {
  test("returns the locally computed hashes when both claims match", () => {
    const manifestText = writePackage({ id: "x", version: "1.0.0" }, "dist/index.js", "entry-v1");
    const claims = { manifestHash: sha(manifestText), entryHash: sha("entry-v1").toUpperCase() };
    expect(assertPackageMatchesClaims(dir, claims)).toEqual({
      manifestHash: sha(manifestText),
      entryHash: sha("entry-v1"),
    });
  });

  test("refuses when the entry differs from the claim", () => {
    const manifestText = writePackage({ id: "x", version: "1.0.0" }, "dist/index.js", "tampered");
    expect(() =>
      assertPackageMatchesClaims(dir, {
        manifestHash: sha(manifestText),
        entryHash: sha("entry-v1"),
      }),
    ).toThrow(/package_hash_mismatch: entry/);
  });

  test("refuses when the manifest differs from the claim", () => {
    writePackage({ id: "x", version: "1.0.0" }, "dist/index.js", "entry-v1");
    expect(() =>
      assertPackageMatchesClaims(dir, { manifestHash: "d".repeat(64), entryHash: sha("entry-v1") }),
    ).toThrow(/package_hash_mismatch: manifest/);
  });
});
