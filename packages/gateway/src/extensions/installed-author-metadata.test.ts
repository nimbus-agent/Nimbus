import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionRow } from "../automation/extension-store.ts";
import { installedAuthorMetadata } from "./installed-author-metadata.ts";
import { EXTENSION_MANIFEST_FILENAME } from "./manifest.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function manifestText(extra: Record<string, unknown>): string {
  return JSON.stringify({
    id: "com.example.meta",
    name: "Meta",
    version: "1.0.0",
    entry: "dist/index.js",
    permissions: { network: [] },
    ...extra,
  });
}

function rowFor(text: string | undefined, hashOf: string | undefined = text): ExtensionRow {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-author-meta-unit-"));
  dirs.push(dir);
  if (text !== undefined) writeFileSync(join(dir, EXTENSION_MANIFEST_FILENAME), text);
  return {
    id: "com.example.meta",
    version: "1.0.0",
    install_path: dir,
    manifest_hash: createHash("sha256")
      .update(hashOf ?? "")
      .digest("hex"),
    entry_hash: "e".repeat(64),
    enabled: 1,
    installed_at: 1,
    last_verified_at: 1,
  } as ExtensionRow;
}

describe("installedAuthorMetadata", () => {
  test("a hash-matching manifest yields funding and license", () => {
    const text = manifestText({
      funding: [{ url: "https://github.com/sponsors/acme", label: "Sponsor" }],
      license: "MIT",
    });
    expect(installedAuthorMetadata(rowFor(text))).toEqual({
      funding: [{ url: "https://github.com/sponsors/acme", label: "Sponsor" }],
      license: "MIT",
    });
  });

  test("a manifest edited after hashing yields nothing", () => {
    const original = manifestText({ license: "MIT" });
    const edited = manifestText({ license: "GPL-3.0" });
    expect(installedAuthorMetadata(rowFor(edited, original))).toEqual({
      funding: null,
      license: null,
    });
  });

  test("no manifest file yields nothing", () => {
    expect(installedAuthorMetadata(rowFor(undefined))).toEqual({ funding: null, license: null });
  });

  test("a malformed funding with a matching hash is flagged invalid", () => {
    const view = installedAuthorMetadata(rowFor(manifestText({ funding: "nope", license: "MIT" })));
    expect(view.funding).toBeNull();
    expect(view.fundingInvalid).toBe(true);
    expect(view.license).toBe("MIT");
  });

  test("unparseable JSON with a matching hash yields nothing", () => {
    expect(installedAuthorMetadata(rowFor("{not json"))).toEqual({ funding: null, license: null });
  });
});
