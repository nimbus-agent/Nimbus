#!/usr/bin/env bun
/**
 * Cross-repo drift guard for the extracted MCP launcher.
 *
 * `packages/mcp-launcher` used to live here, and its `resolve-binary.test.ts` read
 * `scripts/install/lib/paths.ts` as TEXT to assert the launcher's first-choice install
 * directory matched what the installer actually writes. The launcher now lives in
 * nimbus-agent/nimbus-mcp and vendors those two literals in `src/installer-contract.ts`,
 * which on its own is a change-detector, not a contract — nothing over there can see
 * this side move.
 *
 * This script is the missing half. It is run by two jobs:
 *   - `install-smoke.yml` — PR-time, on `scripts/install/**` changes. Catches OUR change.
 *   - `org-drift-sweep.yml` — scheduled, clones nimbus-mcp. The only thing that catches
 *     a change made THERE.
 * Both check out nimbus-mcp and pass its `src/installer-contract.ts` as argv[2].
 *
 * Importing `resolveInstallDir` rather than re-reading its source is deliberate: both
 * files are AGPL and in this repo, so there is no licence reason to text-scrape, and an
 * import cannot drift from the function it is checking. The vendored side must still be
 * parsed as text, because it lives in a repo this one does not depend on.
 */
import { readFileSync } from "node:fs";

import { resolveInstallDir } from "../install/lib/paths.ts";

/**
 * Pull the two vendored literals out of nimbus-mcp's `src/installer-contract.ts`.
 *
 * Deliberately form-sensitive: the win32 value must be a `String.raw` backtick literal
 * and the posix value a double-quoted string, matching how the vendored file writes
 * them. Reshaping either changes its escaping semantics, so the parser returns `null`
 * rather than guessing — and `null` is reported as drift, which is the loud outcome.
 * A regex that accepted any form could match a value whose backslashes no longer mean
 * what they did.
 */
export function parseVendoredSuffixes(src: string): {
  win32: string | null;
  posix: string | null;
} {
  const win = /INSTALLER_WIN32_SUFFIX\s*=\s*String\.raw`([^`]*)`/.exec(src);
  const posix = /INSTALLER_POSIX_SUFFIX\s*=\s*"([^"]*)"/.exec(src);
  return { win32: win?.[1] ?? null, posix: posix?.[1] ?? null };
}

/**
 * What the installer actually appends, derived by CALLING `resolveInstallDir` with
 * sentinel roots and stripping them back off — never by restating the literals, which
 * would just be a third copy to drift.
 */
export function installerSuffixes(): { win32: string; posix: string } {
  const localAppData = String.raw`C:\LAD`;
  const home = "/home/u";
  return {
    win32: resolveInstallDir("win32", { LOCALAPPDATA: localAppData }).slice(localAppData.length),
    posix: resolveInstallDir("linux", { HOME: home }).slice(home.length),
  };
}

function main(): void {
  const contractPath = process.argv[2];
  if (contractPath === undefined) {
    console.error(
      "usage: check-launcher-installer-contract.ts <path to nimbus-mcp/src/installer-contract.ts>",
    );
    process.exit(2);
  }
  const vendored = parseVendoredSuffixes(readFileSync(contractPath, "utf8"));
  const installer = installerSuffixes();
  const problems: string[] = [];
  if (vendored.win32 === null) {
    problems.push("INSTALLER_WIN32_SUFFIX not found (renamed? no longer a String.raw literal?)");
  } else if (vendored.win32 !== installer.win32) {
    problems.push(`win32: vendored '${vendored.win32}' != installer '${installer.win32}'`);
  }
  if (vendored.posix === null) {
    problems.push("INSTALLER_POSIX_SUFFIX not found (renamed? no longer a double-quoted literal?)");
  } else if (vendored.posix !== installer.posix) {
    problems.push(`posix: vendored '${vendored.posix}' != installer '${installer.posix}'`);
  }
  if (problems.length > 0) {
    for (const p of problems) {
      console.error(`::error file=scripts/install/lib/paths.ts::launcher contract drift — ${p}`);
    }
    console.error(
      "check-launcher-installer-contract: FAILED — update nimbus-agent/nimbus-mcp's src/installer-contract.ts to match, or revert the installer change.",
    );
    process.exit(1);
  }
  console.log("check-launcher-installer-contract: ok (win32 + posix suffixes match)");
}

// Load-bearing: without this guard, importing the module from the test file executes
// main() and exits the test process.
if (import.meta.main) {
  main();
}
