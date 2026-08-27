#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const CONNECTOR_PACKAGE = "@nimbus-dev/connectors";
const OUT = join(
  REPO_ROOT,
  "packages",
  "gateway",
  "src",
  "connectors",
  "bundled-connector-registry.ts",
);

/**
 * A connector id: lowercase letters, digits and hyphens.
 *
 * The SAME shape the standalone launcher validates before joining an id into a path. Filtering
 * only on "a subpath export with no further slash" was not enough: 0.2.0 added `./package.json`
 * to the exports map, which has no slash after `./` and was duly counted as a connector called
 * "package.json". The registry-drift audit caught it immediately, which is the whole reason that
 * gate exists — the alternative was a compiled binary carrying an import of a connector that does
 * not exist.
 */
const CONNECTOR_ID_RE = /^[a-z0-9-]+$/;

/**
 * Every connector the installed `@nimbus-dev/connectors` exposes.
 *
 * Derived from the package's `exports` map, which is the only thing that decides what a consumer
 * can actually import. This used to scan `packages/mcp-connectors` for directories containing
 * `src/server.ts`; that stopped being the right question when the connectors moved out, because a
 * connector present in the package but absent from its exports map is unreachable — exactly the
 * shape of the bug that shipped in 0.1.0, where `shared/connector-mode.ts` was packed but not
 * exported.
 *
 * Subpath exports with a further segment (`./shared/connector-mode.ts`) are not connectors and are
 * filtered out; so is the root export.
 */
/**
 * The installed package's own directory.
 *
 * Resolved through a subpath the package DOES export, then walked up to the manifest — rather than
 * `require("<pkg>/package.json")`, which fails: an exports map is a whitelist and this package does
 * not list `./package.json`. Exporting it would be the conventional fix and is worth doing next
 * time that package is published; walking up needs no release and does not depend on which
 * subpath happens to be exported.
 */
function connectorPackageDir(packageName: string): string {
  // Resolved from the GATEWAY's manifest, not this script's location: the gateway is the package's
  // consumer and the dependency is declared there, so that is where node resolution can see it.
  const require = createRequire(join(REPO_ROOT, "packages", "gateway", "package.json"));
  let dir = dirname(require.resolve(`${packageName}/shared/connector-mode.ts`));
  for (let up = 0; up < 8; up++) {
    const candidate = join(dir, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>)["name"] === packageName
      ) {
        return dir;
      }
    } catch {
      // Not this level — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate the ${packageName} package root`);
}

export function bundledConnectorIds(packageName: string = CONNECTOR_PACKAGE): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(join(connectorPackageDir(packageName), "package.json"), "utf8"),
  );
  const exportsMap =
    typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, unknown>)["exports"]
      : undefined;
  if (typeof exportsMap !== "object" || exportsMap === null) {
    throw new Error(`${packageName} has no exports map — cannot derive the connector list`);
  }
  return Object.keys(exportsMap)
    .filter((k) => k.startsWith("./"))
    .map((k) => k.slice(2))
    .filter((id) => CONNECTOR_ID_RE.test(id))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Where a connector entrypoint is imported FROM.
 *
 * `package` (the DEFAULT) emits a bare specifier into `@nimbus-dev/connectors`, the published
 * package the connectors now live in. `workspace` emits a relative path into
 * `packages/mcp-connectors`, the in-repo copy that has not been deleted yet.
 *
 * The default flipped once the assumption the flag existed to test was proven: that
 * `bun build --compile` embeds a BARE-specifier dynamic import as reliably as a relative one.
 * Measured against the published 0.1.1 tarball, a compiled binary booted all 94 connectors with
 * the same verdict as the relative build — 89 answered, 5 refused without credentials, 0 failed.
 *
 * `workspace` is kept, not as a fallback but as a bisection tool: if a connector misbehaves after
 * the switch, regenerating against the in-repo copy says whether the package boundary is implicated
 * or the connector itself is. It stops being meaningful once packages/mcp-connectors is deleted.
 */
function specifierFor(id: string): string {
  return process.env["NIMBUS_CONNECTOR_SPECIFIER"] === "workspace"
    ? `../../../mcp-connectors/${id}/src/server.ts`
    : `@nimbus-dev/connectors/${id}`;
}

function render(ids: readonly string[]): string {
  const entries = ids
    .map((id) => `  ${JSON.stringify(id)}: () => import("${specifierFor(id)}"),`)
    .join("\n");
  return `// GENERATED by scripts/gen-bundled-connector-registry.ts — do not edit by hand.
// Re-run: bun run gen:connector-registry
//
// Every first-party connector entrypoint, as a lazy dynamic import. The imports are static enough
// for the bundler to retain all ${ids.length} in the compiled gateway binary, and lazy enough that
// only the requested connector is ever evaluated.

export const BUNDLED_CONNECTORS: Readonly<Record<string, () => Promise<unknown>>> = {
${entries}
};
`;
}

if (import.meta.main) {
  const ids = bundledConnectorIds();
  writeFileSync(OUT, render(ids));
  // Biome's FORMATTER strips unnecessary quotes from object keys, and it is the authority on which
  // ids need them (`"monte-carlo"` does, `airflow` does not). Formatting the output here keeps the
  // generated file canonical by construction rather than duplicating that policy in `render()`,
  // which would silently rot the next time the formatter's rules change. Without this the file
  // fails `bun run lint`.
  const fmt = Bun.spawnSync(["bunx", "biome", "check", "--write", OUT], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (fmt.exitCode !== 0) {
    console.error("gen-bundled-connector-registry: biome failed to format the generated file");
    process.exit(1);
  }
  console.log(`wrote ${OUT} with ${ids.length} connectors`);
}
