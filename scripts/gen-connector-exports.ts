#!/usr/bin/env bun
/**
 * Writes the `exports` map of `packages/mcp-connectors/package.json` from the connector directories
 * on disk.
 *
 * Hand-maintaining 94 subpath entries is a drift source with no gate: a connector added without its
 * export resolves at development time (the source tree is right there) and fails only once the
 * package is installed from the registry, which is the worst possible place to find out. This
 * reuses `bundledConnectorIds` — the SAME scan the runtime registry generator uses — so the two
 * cannot disagree about which directories are connectors.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bundledConnectorIds } from "./gen-bundled-connector-registry.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PKG = join(REPO_ROOT, "packages", "mcp-connectors", "package.json");

export function connectorExportsMap(ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {
    // The launcher, so `@nimbus-dev/connectors` alone resolves to something useful rather than
    // erroring on a bare import.
    ".": "./standalone/src/bin.ts",
  };
  for (const id of ids) {
    out[`./${id}`] = `./${id}/src/server.ts`;
  }
  return out;
}

function main(): void {
  const ids = bundledConnectorIds();
  const pkg = JSON.parse(readFileSync(PKG, "utf8")) as Record<string, unknown>;
  pkg["exports"] = connectorExportsMap(ids);
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`wrote ${PKG} with ${String(ids.length)} connector exports`);
}

if (import.meta.main) {
  main();
}
