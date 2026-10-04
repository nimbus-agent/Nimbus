/**
 * Discovery paths the main suite does not reach: a single-`*` ignore glob (which must stay inside
 * one path segment, unlike `**`), a root that cannot be listed, and files whose names merely look
 * spec-like.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSpecFiles } from "./openapi-indexer-discovery.ts";

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openapi-discover-cov-"));
  roots.push(root);
  return root;
}

/** Root-relative, forward-slashed, sorted — comparable on every platform. */
function rels(root: string, files: readonly string[]): string[] {
  return files
    .map((f) => f.slice(root.length + 1).replaceAll("\\", "/"))
    .sort((a, b) => a.localeCompare(b));
}

describe("discoverSpecFiles — single-star ignore globs", () => {
  test("`*` matches within one path segment only, so a nested file with the same name survives", () => {
    const root = makeRoot();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "openapi.yaml"), "openapi: 3.0.0");
    writeFileSync(join(root, "swagger.json"), "{}");
    writeFileSync(join(root, "nested", "swagger.json"), "{}");

    const files = discoverSpecFiles(root, { maxWalkDepth: 8, ignoreGlobs: ["*.json"] });

    expect(rels(root, files)).toEqual(["nested/swagger.json", "openapi.yaml"]);
  });

  test("`*` also prunes a whole directory whose name it matches", () => {
    const root = makeRoot();
    mkdirSync(join(root, "legacy-v1"));
    mkdirSync(join(root, "current"));
    writeFileSync(join(root, "legacy-v1", "openapi.yaml"), "");
    writeFileSync(join(root, "current", "openapi.yaml"), "");

    const files = discoverSpecFiles(root, { maxWalkDepth: 8, ignoreGlobs: ["legacy-*"] });

    expect(rels(root, files)).toEqual(["current/openapi.yaml"]);
  });
});

describe("discoverSpecFiles — unlistable roots", () => {
  test("a root that does not exist yields no files instead of throwing", () => {
    const root = makeRoot();
    expect(discoverSpecFiles(join(root, "missing"), { maxWalkDepth: 8, ignoreGlobs: [] })).toEqual(
      [],
    );
  });

  test("a root that is a regular file yields no files instead of throwing", () => {
    const root = makeRoot();
    const file = join(root, "openapi.yaml");
    writeFileSync(file, "openapi: 3.0.0");
    expect(discoverSpecFiles(file, { maxWalkDepth: 8, ignoreGlobs: [] })).toEqual([]);
  });
});

describe("discoverSpecFiles — file-name filter", () => {
  test("only exact openapi/swagger/asyncapi names with a yaml/yml/json extension are returned", () => {
    const root = makeRoot();
    for (const name of [
      "README.md",
      "openapi.txt",
      "my-openapi.yaml",
      "openapi.yaml.bak",
      "swagger.json5",
      "asyncapi.yml",
    ]) {
      writeFileSync(join(root, name), "");
    }

    const files = discoverSpecFiles(root, { maxWalkDepth: 8, ignoreGlobs: [] });

    expect(rels(root, files)).toEqual(["asyncapi.yml"]);
  });
});
