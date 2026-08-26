#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bundledConnectorIds } from "../gen-bundled-connector-registry.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
/**
 * The package whose exports decide which connectors exist.
 *
 * Was `packages/mcp-connectors` until the connectors were extracted. The comparison is now
 * "registry vs. what the installed package EXPORTS" rather than "registry vs. directories on
 * disk" — which is the stricter question: a connector present in the package but missing from its
 * exports map is unreachable to the gateway, and a directory scan would have called it present.
 */
export const CONNECTOR_PACKAGE = "@nimbus-dev/connectors";
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

/**
 * Distinct from a `RegistryDriftViolation`: this means the check itself could not reach a
 * verdict, not that a verdict of "drift" was reached. Reported separately so a caller (and a
 * human reading CI output) never mistakes "the parser couldn't read the registry" for "every
 * connector is missing from the registry" — the remedy for the two is different, and the wrong
 * one (`gen:connector-registry`) does nothing to fix a parser that no longer matches the
 * generator's output format.
 */
export interface RegistryDriftIndeterminate {
  readonly reason: string;
}

export type RegistryDriftCheck =
  | { readonly status: "ok" }
  | { readonly status: "drift"; readonly violations: readonly RegistryDriftViolation[] }
  | { readonly status: "indeterminate"; readonly indeterminate: RegistryDriftIndeterminate };

// Matched on the import PATH rather than the object key: Biome's formatter strips unnecessary
// quotes from keys, so a key-based pattern would have to duplicate that policy and would rot the
// next time the formatter's rules change. The path is always a quoted string literal.
//
// No platform normalization is needed and none should be added: the separators here are
// literal characters in the generator's template string, not the output of any path API, and
// the interpolated id is a readdirSync entry NAME, which never contains a separator. The
// generated file is byte-identical on Windows, macOS and Linux.
// BOTH specifier forms the generator can emit — see `specifierFor` in
// scripts/gen-bundled-connector-registry.ts. The relative form is what ships today; the package
// form (`@nimbus-dev/connectors/<id>`) is what ships after the extraction.
//
// Matching only one of them does not fail loudly: `registryIds` returns [], the check reports
// "indeterminate", and that is a WARNING rather than an error — so the drift gate would go quietly
// inert at exactly the moment the extraction made it matter most.
const ENTRY_RE =
  /import\("(?:\.\.\/\.\.\/\.\.\/mcp-connectors\/([^"/]+)\/src\/server\.ts|@nimbus-dev\/connectors\/([^"/]+))"\)/g;

export function registryIds(registryFile: string): string[] {
  if (!existsSync(registryFile)) return [];
  const src = readFileSync(registryFile, "utf8");
  return [...src.matchAll(ENTRY_RE)]
    .map((m) => (m[1] ?? m[2]) as string)
    .sort((a, b) => a.localeCompare(b));
}

function buildViolations(
  onDisk: ReadonlySet<string>,
  listed: ReadonlySet<string>,
): RegistryDriftViolation[] {
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

/**
 * The bundled connector registry is GENERATED into a committed file. Nothing else diffs it, and
 * `test:connector-boot` structurally cannot: it boots the connectors the registry ships, so one
 * missing FROM the registry is invisible to it. A stale registry means a connector that exists in
 * the tree, passes every other gate, and can never be started by the shipped binary.
 *
 * A registry file that EXISTS but parses to zero entries, while connectors exist on disk, is
 * reported as `indeterminate` rather than as a violation for every connector on disk. The repo's
 * convention (matching `check-doc-references.ts` and friends) is that unreadable/unparseable
 * input degrades to indeterminate, never to a finding: `registryIds` matches on a specific import
 * shape emitted by `gen-bundled-connector-registry.ts`, and if that generator's emitted format
 * ever changes, the regex stops matching ANYTHING — not just the entries that actually drifted.
 * Reporting that as "every connector is missing from the registry" would be a false flood whose
 * printed remedy (`gen:connector-registry`) does not fix the real cause (a stale parser here).
 *
 * A missing registry file is NOT covered by that carve-out and remains a real drift finding: a
 * missing file is unambiguous (there is nothing to fail to parse), unlike a present file that
 * yields zero matches.
 */
export function checkConnectorRegistryDrift(
  // The ids are INJECTED rather than discovered inside, so this stays a pure comparison. It used
  // to take a directory to scan, which tied every test to a temp tree; discovery now goes through
  // node resolution of an installed package, which a temp directory cannot stand in for at all.
  exportedIds: readonly string[] = bundledConnectorIds(),
  registryFile: string = REGISTRY_FILE,
): RegistryDriftCheck {
  const onDisk = new Set(exportedIds);

  if (!existsSync(registryFile)) {
    const violations = buildViolations(onDisk, new Set());
    return violations.length === 0 ? { status: "ok" } : { status: "drift", violations };
  }

  const listedIds = registryIds(registryFile);
  if (listedIds.length === 0 && onDisk.size > 0) {
    return {
      status: "indeterminate",
      indeterminate: {
        reason:
          `${registryFile} exists but zero connector entries could be parsed from it, even ` +
          `though ${onDisk.size} connector(s) are exported by ${CONNECTOR_PACKAGE}. The registry ` +
          "could not be read as connector entries. The likely cause is that the registry " +
          "generator's emitted import format changed and this check's parser (the ENTRY_RE " +
          "regex in check-connector-registry-drift.ts) no longer matches it — NOT that every " +
          "connector was actually removed from the registry. Confirm by eye whether the " +
          "registry file's entries look sane, then update ENTRY_RE to match the new format.",
      },
    };
  }

  const violations = buildViolations(onDisk, new Set(listedIds));
  return violations.length === 0 ? { status: "ok" } : { status: "drift", violations };
}

if (import.meta.main) {
  const result = checkConnectorRegistryDrift();
  if (result.status === "drift") {
    for (const v of result.violations) {
      console.error(
        `::error file=packages/gateway/src/connectors/bundled-connector-registry.ts::${v.connector} ${v.reason}`,
      );
    }
    console.log(`connector registry drift: ${result.violations.length} violation(s)`);
    process.exit(1);
  } else if (result.status === "indeterminate") {
    console.error(
      `::warning file=packages/gateway/src/connectors/bundled-connector-registry.ts::${result.indeterminate.reason}`,
    );
    console.log(`connector registry drift: indeterminate — ${result.indeterminate.reason}`);
    // A distinct, non-zero-non-one exit code: 1 is reserved for a real, actionable drift finding
    // (the CI-familiar "fix and re-run `gen:connector-registry`" case). 2 means the check itself
    // could not render a verdict — CI should still fail loudly (this is not "ok"), but a human
    // triaging red CI should be able to tell "the registry drifted" (1) apart from "the drift
    // checker's parser is stale and needs a code fix" (2) from the exit code alone, before even
    // reading the log.
    process.exit(2);
  } else {
    console.log("connector registry drift: ok");
    process.exit(0);
  }
}
