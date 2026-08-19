#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bundledConnectorIds } from "../gen-bundled-connector-registry.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const CONNECTORS_DIR = join(REPO_ROOT, "packages", "mcp-connectors");
export const REGISTRY_FILE = join(
  REPO_ROOT,
  "packages",
  "gateway",
  "src",
  "connectors",
  "bundled-connector-registry.ts",
);

export interface RegistryDriftViolation {
  readonly connector: string;
  readonly reason: string;
}

// Matched on the import PATH rather than the object key: Biome's formatter strips unnecessary
// quotes from keys, so a key-based pattern would have to duplicate that policy and would rot the
// next time the formatter's rules change. The path is always a quoted string literal.
//
// No platform normalization is needed and none should be added: the separators here are
// literal characters in the generator's template string, not the output of any path API, and
// the interpolated id is a readdirSync entry NAME, which never contains a separator. The
// generated file is byte-identical on Windows, macOS and Linux.
const ENTRY_RE = /import\("\.\.\/\.\.\/\.\.\/mcp-connectors\/([^"/]+)\/src\/server\.ts"\)/g;

export function registryIds(registryFile: string): string[] {
  if (!existsSync(registryFile)) return [];
  const src = readFileSync(registryFile, "utf8");
  return [...src.matchAll(ENTRY_RE)].map((m) => m[1] as string).sort((a, b) => a.localeCompare(b));
}

/**
 * The bundled connector registry is GENERATED into a committed file. Nothing else diffs it, and
 * `test:connector-boot` structurally cannot: it boots the connectors the registry ships, so one
 * missing FROM the registry is invisible to it. A stale registry means a connector that exists in
 * the tree, passes every other gate, and can never be started by the shipped binary.
 */
export function checkConnectorRegistryDrift(
  connectorsDir: string = CONNECTORS_DIR,
  registryFile: string = REGISTRY_FILE,
): RegistryDriftViolation[] {
  const onDisk = new Set(bundledConnectorIds(connectorsDir));
  const listed = new Set(registryIds(registryFile));
  const out: RegistryDriftViolation[] = [];

  for (const id of [...onDisk].sort((a, b) => a.localeCompare(b))) {
    if (listed.has(id)) continue;
    out.push({
      connector: id,
      reason:
        "exists in packages/mcp-connectors/ but is absent from the bundled registry: the shipped " +
        "binary can never start it. Run `bun run gen:connector-registry` and commit the result",
    });
  }
  for (const id of [...listed].sort((a, b) => a.localeCompare(b))) {
    if (onDisk.has(id)) continue;
    out.push({
      connector: id,
      reason:
        "is listed in the bundled registry but no longer exists on disk: the generated import " +
        "will fail to resolve. Run `bun run gen:connector-registry` and commit the result",
    });
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorRegistryDrift();
  for (const v of violations) {
    console.error(
      `::error file=packages/gateway/src/connectors/bundled-connector-registry.ts::${v.connector} ${v.reason}`,
    );
  }
  console.log(
    violations.length === 0
      ? "connector registry drift: ok"
      : `connector registry drift: ${violations.length} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
