import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSpecFiles } from "./openapi-indexer-discovery.ts";

function setupTree(): string {
  const root = mkdtempSync(join(tmpdir(), "openapi-discover-"));
  mkdirSync(join(root, "services", "billing"), { recursive: true });
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
  mkdirSync(join(root, "deep", "a", "b", "c", "d", "e", "f", "g", "h"), { recursive: true });
  writeFileSync(join(root, "openapi.yaml"), "openapi: 3.0.0");
  writeFileSync(join(root, "services", "billing", "swagger.json"), "{}");
  writeFileSync(join(root, "services", "billing", "asyncapi.yaml"), "asyncapi: 2.6.0");
  writeFileSync(join(root, "node_modules", "junk", "openapi.yaml"), "should be skipped");
  writeFileSync(join(root, "deep", "a", "b", "c", "d", "e", "f", "g", "h", "openapi.yaml"), "");
  return root;
}

test("finds OpenAPI/Swagger/AsyncAPI files and skips default-ignored dirs", () => {
  const root = setupTree();
  const files = discoverSpecFiles(root, { maxWalkDepth: 8, ignoreGlobs: [] });
  const rels = files.map((f) => {
    let rel = f;
    if (rel.startsWith(root)) {
      rel = rel.slice(root.length);
      if (rel.startsWith("/") || rel.startsWith("\\")) {
        rel = rel.slice(1);
      }
    }
    return rel.replaceAll("\\", "/");
  });
  expect(rels).toContain("openapi.yaml");
  expect(rels).toContain("services/billing/swagger.json");
  expect(rels).toContain("services/billing/asyncapi.yaml");
  for (const r of rels) {
    expect(r.includes("node_modules")).toBe(false);
  }
});

test("respects max_walk_depth", () => {
  const root = setupTree();
  const shallow = discoverSpecFiles(root, { maxWalkDepth: 2, ignoreGlobs: [] });
  const deep = discoverSpecFiles(root, { maxWalkDepth: 12, ignoreGlobs: [] });
  expect(deep.length).toBeGreaterThan(shallow.length);
});

test("matches case-insensitively for known filenames", () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-discover-case-"));
  writeFileSync(join(root, "OpenAPI.YAML"), "");
  writeFileSync(join(root, "Swagger.JSON"), "{}");
  const files = discoverSpecFiles(root, { maxWalkDepth: 8, ignoreGlobs: [] });
  expect(files.length).toBe(2);
});

test("does not follow symlinks (file or directory)", () => {
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "openapi-discover-symlink-"));
  writeFileSync(join(root, "openapi.yaml"), "openapi: 3.0.0");
  try {
    symlinkSync(join(root, "openapi.yaml"), join(root, "linked.yaml"));
  } catch {
    return;
  }
  try {
    symlinkSync(root, join(root, "self"));
  } catch {
    // ignore — same reason as above
  }
  const files = discoverSpecFiles(root, { maxWalkDepth: 8, ignoreGlobs: [] });
  expect(files.length).toBe(1);
  const first = files[0];
  expect(first).toBeDefined();
  expect(first?.endsWith("openapi.yaml")).toBe(true);
});

test("ignoreGlobs excludes both files and directories", () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-discover-globs-"));
  mkdirSync(join(root, "legacy"), { recursive: true });
  mkdirSync(join(root, "current", "active"), { recursive: true });
  writeFileSync(join(root, "openapi.yaml"), "");
  writeFileSync(join(root, "legacy", "openapi.yaml"), "");
  writeFileSync(join(root, "current", "active", "openapi.yaml"), "");
  writeFileSync(join(root, "current", "swagger.json"), "{}");
  const files = discoverSpecFiles(root, {
    maxWalkDepth: 8,
    ignoreGlobs: ["legacy/**", "current/swagger.json"],
  });
  const rels = files
    .map((f) => f.replace(`${root}/`, "").replace(`${root}\\`, "").replaceAll("\\", "/"))
    .sort();
  expect(rels).toEqual(["current/active/openapi.yaml", "openapi.yaml"]);
});

test("ignoreGlobs supports `?` single-char and literal special chars", () => {
  const root = mkdtempSync(join(tmpdir(), "openapi-discover-globs-q-"));
  writeFileSync(join(root, "openapi.yaml"), "");
  writeFileSync(join(root, "swagger.json"), "{}");
  const files = discoverSpecFiles(root, {
    maxWalkDepth: 8,
    ignoreGlobs: ["?wagger.json"],
  });
  const rels = files
    .map((f) => f.replace(`${root}/`, "").replace(`${root}\\`, "").replaceAll("\\", "/"))
    .sort();
  expect(rels).toEqual(["openapi.yaml"]);
});
