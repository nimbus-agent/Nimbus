#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILENAME = ".release-please-manifest.json";
const CONFIG_FILENAME = ".release-please-config.json";
const DEFAULT_CHANGELOG = "CHANGELOG.md";
const VERSION_ANNOTATION = "x-release-please-version";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

interface PackageConfig {
  readonly changelogPath: string;
  readonly extraFiles: readonly string[];
}

// Anchored, no nested quantifiers — linear on any input (see the ReDoS note in
// docs/SECURITY-INVARIANTS.md's testing guidance).
const SEMVER_EXACT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** release-please writes `## [1.2.3](compare-link) (date)`; `## 1.2.3` is also accepted. */
const CHANGELOG_HEADING = /^#{2,3}\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/;
/** Does this line mention a version at all? Distinguishes a bump site from prose. */
const SEMVER_ANYWHERE = /\d+\.\d+\.\d+/;

function parseSemver(text: string): Semver | null {
  const m = SEMVER_EXACT.exec(text.trim());
  const [, major, minor, patch] = m ?? [];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: m?.[4] ?? null,
  };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  // A release outranks a prerelease of the same triple (1.2.3 > 1.2.3-rc.1).
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function formatSemver(v: Semver): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease === null ? base : `${base}-${v.prerelease}`;
}

/** Every version documented by a heading in a release-please CHANGELOG. */
function changelogVersions(text: string): Semver[] {
  const found: Semver[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("##")) continue;
    const version = CHANGELOG_HEADING.exec(line)?.[1];
    if (version === undefined) continue;
    const parsed = parseSemver(version);
    if (parsed) found.push(parsed);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * Per-package `changelog-path` + `extra-files`, straight from
 * `.release-please-config.json`, so this gate follows the config rather than
 * re-hardcoding it. An absent or unreadable config yields defaults.
 */
function readPackageConfigs(repoRoot: string): Record<string, PackageConfig> {
  const configPath = join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(configPath)) return {};

  let parsed: unknown;
  try {
    parsed = readJson(configPath);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const packages = parsed["packages"];
  if (!isRecord(packages)) return {};

  const out: Record<string, PackageConfig> = {};
  for (const [pkgPath, raw] of Object.entries(packages)) {
    const entry = isRecord(raw) ? raw : {};
    const changelog = entry["changelog-path"];
    const extras = entry["extra-files"];
    out[pkgPath] = {
      changelogPath: typeof changelog === "string" ? changelog : DEFAULT_CHANGELOG,
      extraFiles: Array.isArray(extras)
        ? extras.filter((f): f is string => typeof f === "string")
        : [],
    };
  }
  return out;
}

function packageDir(repoRoot: string, pkgPath: string): string {
  return pkgPath === "." ? repoRoot : join(repoRoot, pkgPath);
}

/**
 * The manifest version must be the HIGHEST version its changelog documents.
 *
 * This is the rule that catches a manifest walking BACKWARDS. In #1184
 * release-please lost its anchor tag, re-walked all 915 commits, picked up a
 * stale `Release-As: 1.12.0` trailer, and wrote the manifest back to 1.12.0
 * while the changelog still documented 2.5.0 and the live release was v2.4.1.
 * The old package.json-only check passed throughout, because release-please
 * had rewritten package.json to 1.12.0 too — the two agreed with each other
 * and were both wrong. Comparing against the changelog's own high-water mark
 * needs no network and no tags, so it holds in any checkout.
 */
function auditChangelogHighWaterMark(
  repoRoot: string,
  pkgPath: string,
  manifestVersion: string,
  config: PackageConfig,
  errors: string[],
): void {
  const changelogPath = join(packageDir(repoRoot, pkgPath), config.changelogPath);
  // A package that has not shipped yet has no changelog; that is not drift.
  if (!existsSync(changelogPath)) return;

  const declared = parseSemver(manifestVersion);
  if (declared === null) {
    errors.push(`${pkgPath}: manifest version "${manifestVersion}" is not valid semver`);
    return;
  }

  const documented = changelogVersions(readFileSync(changelogPath, "utf8"));
  if (documented.length === 0) return;

  const highest = documented.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
  if (compareSemver(declared, highest) < 0) {
    errors.push(
      `${pkgPath}: manifest version ${manifestVersion} is BEHIND ${formatSemver(highest)}, ` +
        `the highest version documented in ${config.changelogPath} — the manifest has gone ` +
        `backwards. Do not "fix" this by editing the changelog: reconcile the manifest with ` +
        `the newest tag actually published, and never move a released tag.`,
    );
  }
}

/**
 * Every `extra-files` line carrying the `x-release-please-version` annotation
 * must spell the manifest version. release-please rewrites those lines on
 * release; nothing else checked that they landed, so a missed extra-file
 * would ship a binary reporting a version it is not.
 *
 * Only annotated lines that ALSO carry a version are candidates. The annotation
 * name legitimately appears in prose too — version.ts's own header comment
 * explains what the annotation does — and treating that mention as a bump site
 * made this check fail against a perfectly healthy tree.
 */
function auditExtraFiles(
  repoRoot: string,
  pkgPath: string,
  manifestVersion: string,
  config: PackageConfig,
  errors: string[],
): void {
  for (const relPath of config.extraFiles) {
    const abs = join(repoRoot, relPath);
    if (!existsSync(abs)) {
      errors.push(`${pkgPath}: extra-file ${relPath} is listed in ${CONFIG_FILENAME} but missing`);
      continue;
    }

    const annotated = readFileSync(abs, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes(VERSION_ANNOTATION) && SEMVER_ANYWHERE.test(line));
    if (annotated.length === 0) {
      errors.push(
        `${pkgPath}: extra-file ${relPath} has no ${VERSION_ANNOTATION} line carrying a ` +
          `version, so release-please has nothing to bump`,
      );
      continue;
    }

    for (const line of annotated) {
      if (!line.includes(manifestVersion)) {
        errors.push(
          `${pkgPath}: extra-file ${relPath} does not carry manifest version ${manifestVersion} ` +
            `on its ${VERSION_ANNOTATION} line: ${line.trim()}`,
        );
      }
    }
  }
}

export function auditReleasePleaseManifest(repoRoot: string): AuditResult {
  const manifestPath = join(repoRoot, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`${MANIFEST_FILENAME} not found at repo root`] };
  }

  let manifest: Record<string, string>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { ok: false, errors: [`${MANIFEST_FILENAME} is not valid JSON: ${String(err)}`] };
  }

  const errors: string[] = [];
  const configs = readPackageConfigs(repoRoot);

  for (const [pkgPath, manifestVersion] of Object.entries(manifest)) {
    const pkgJsonPath = join(packageDir(repoRoot, pkgPath), "package.json");
    if (!existsSync(pkgJsonPath)) {
      errors.push(`${pkgPath}: package.json missing at ${pkgJsonPath}`);
      continue;
    }

    let pkgJson: { version?: string };
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch (err) {
      errors.push(`${pkgPath}: package.json is not valid JSON: ${String(err)}`);
      continue;
    }

    if (pkgJson.version !== manifestVersion) {
      errors.push(
        `${pkgPath}: manifest version ${manifestVersion} does not match package.json version ${pkgJson.version}`,
      );
    }

    const config = configs[pkgPath] ?? { changelogPath: DEFAULT_CHANGELOG, extraFiles: [] };
    auditChangelogHighWaterMark(repoRoot, pkgPath, manifestVersion, config, errors);
    auditExtraFiles(repoRoot, pkgPath, manifestVersion, config, errors);
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const repoRoot = process.cwd();
  const result = auditReleasePleaseManifest(repoRoot);
  if (!result.ok) {
    for (const err of result.errors) {
      console.error(`audit:release-please: ${err}`);
    }
    process.exit(1);
  }
  console.log("audit:release-please: OK");
}
