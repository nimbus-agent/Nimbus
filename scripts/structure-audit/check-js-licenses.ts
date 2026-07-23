#!/usr/bin/env bun

import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./lib.ts";

type Mode = "check" | "report";

type Violation = {
  name: string;
  version: string;
  licenses: string[];
  path: string;
};

const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "Unlicense",
  "MPL-2.0",
  "Python-2.0",
  "WTFPL",
  "Zlib",
  "Artistic-2.0",
]);

const PACKAGE_OVERRIDES: ReadonlySet<string> = new Set([
  // sharp's prebuilt libvips native binaries are LGPL-3.0, dynamically linked
  // (not statically compiled into our AGPL code) — the standard, already-accepted
  // sharp arrangement. Version-pinned here so a bump is reviewed; sharp 0.35.3
  // moved these from 1.2.4 to 1.3.2.
  "@img/sharp-libvips-linux-x64@1.3.2",
  "@img/sharp-libvips-linuxmusl-x64@1.3.2",
  "flatbuffers@1.12.0",
]);

type LicenseField = string | { type: string } | LicenseField[] | undefined;

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  license?: LicenseField;
  licenses?: LicenseField;
};

function parseLicenseField(field: LicenseField): string[] {
  if (field === undefined || field === null) return [];
  if (typeof field === "string") {
    return field
      .replace(/[()]/g, "")
      .split(/\s+(?:OR|AND)\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(field)) {
    return field.flatMap((entry) => parseLicenseField(entry));
  }
  if (typeof field === "object" && "type" in field && typeof field.type === "string") {
    return [field.type];
  }
  return [];
}

function isAllowed(licenses: string[], name: string, version: string): boolean {
  if (licenses.length === 0) return false;
  if (PACKAGE_OVERRIDES.has(`${name}@${version}`) || PACKAGE_OVERRIDES.has(name)) return true;
  return licenses.some((l) => ALLOWED_LICENSES.has(l));
}

function decodeBunStoreName(encoded: string): string | null {
  const versionSep = encoded.indexOf("@", 1);
  if (versionSep <= 0) return null;
  let name = encoded.slice(0, versionSep);
  if (name.startsWith("@")) {
    const plus = name.indexOf("+");
    if (plus <= 0) return null;
    name = `${name.slice(0, plus)}/${name.slice(plus + 1)}`;
  }
  return name;
}

async function* iteratePackageManifests(): AsyncGenerator<{ path: string; pkg: PackageJson }> {
  const storeRoot = join(REPO_ROOT, "node_modules", ".bun");
  if (!existsSync(storeRoot)) {
    const nm = join(REPO_ROOT, "node_modules");
    if (!existsSync(nm)) return;
    yield* iterateHoisted(nm);
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const seen = new Set<string>();
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const decoded = decodeBunStoreName(dirent.name);
    if (decoded === null) continue;
    const pjAbs = join(storeRoot, dirent.name, "node_modules", decoded, "package.json");
    if (!existsSync(pjAbs)) continue;
    const rel = relative(REPO_ROOT, pjAbs).replaceAll("\\", "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      const pkg = (await Bun.file(pjAbs).json()) as PackageJson;
      yield { path: rel, pkg };
    } catch {
      // Malformed package.json — skip silently. Real installs shouldn't
      // produce these; the rare case is a partial/corrupted dep dir.
    }
  }
}

async function* iterateHoisted(nm: string): AsyncGenerator<{ path: string; pkg: PackageJson }> {
  const entries = await readdir(nm, { withFileTypes: true });
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name.startsWith(".")) continue;
    if (dirent.name.startsWith("@")) {
      const scopeDir = join(nm, dirent.name);
      const sub = await readdir(scopeDir, { withFileTypes: true });
      for (const inner of sub) {
        if (!inner.isDirectory()) continue;
        const pjAbs = join(scopeDir, inner.name, "package.json");
        if (!existsSync(pjAbs)) continue;
        const rel = relative(REPO_ROOT, pjAbs).replaceAll("\\", "/");
        try {
          const pkg = (await Bun.file(pjAbs).json()) as PackageJson;
          yield { path: rel, pkg };
        } catch {
          // skip malformed
        }
      }
      continue;
    }
    const pjAbs = join(nm, dirent.name, "package.json");
    if (!existsSync(pjAbs)) continue;
    const rel = relative(REPO_ROOT, pjAbs).replaceAll("\\", "/");
    try {
      const pkg = (await Bun.file(pjAbs).json()) as PackageJson;
      yield { path: rel, pkg };
    } catch {
      // skip malformed
    }
  }
}

async function run(): Promise<void> {
  const argv = Bun.argv;
  let mode: Mode = "check";
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") mode = "check";
    else if (a === "--report") mode = "report";
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }

  if (!existsSync(join(REPO_ROOT, "node_modules"))) {
    console.error("node_modules not found — run `bun install` before this check.");
    process.exit(2);
  }

  const violations: Violation[] = [];
  let total = 0;
  let withMissingLicense = 0;
  for await (const { path, pkg } of iteratePackageManifests()) {
    if (pkg.private === true) continue;
    total += 1;
    const name = pkg.name ?? "<unknown>";
    const version = pkg.version ?? "0.0.0";
    const fromLicense = parseLicenseField(pkg.license);
    const fromLicenses = parseLicenseField(pkg.licenses);
    const licenses = [...new Set([...fromLicense, ...fromLicenses])];
    if (licenses.length === 0) withMissingLicense += 1;
    if (!isAllowed(licenses, name, version)) {
      violations.push({ name, version, licenses, path });
    }
  }

  if (mode === "report") {
    console.log(`Scanned ${total} packages`);
    if (withMissingLicense > 0) {
      console.log(`  ${withMissingLicense} with missing license field (counted as violations)`);
    }
    for (const v of violations) {
      const lic = v.licenses.length === 0 ? "(none)" : v.licenses.join(", ");
      console.log(`  ${v.name}@${v.version}  [${lic}]  ${v.path}`);
    }
    console.log(`${violations.length} violation(s)`);
    process.exit(violations.length === 0 ? 0 : 1);
  }

  if (violations.length === 0) {
    console.log(`JS license check: ${total} packages — all under the allowlist.`);
    return;
  }
  for (const v of violations) {
    const lic = v.licenses.length === 0 ? "(none declared)" : v.licenses.join(", ");
    console.error(`::error::license violation: ${v.name}@${v.version} → ${lic} (${v.path})`);
  }
  console.error(`\n${violations.length} JS license violation(s).`);
  console.error(
    `If a license is safe in context, add it to ALLOWED_LICENSES in ` +
      `scripts/structure-audit/check-js-licenses.ts and update docs/license-policy.md.`,
  );
  console.error(
    `If a single package needs an exception, add "name@version" to PACKAGE_OVERRIDES with a justifying comment.`,
  );
  process.exit(1);
}

await run();
