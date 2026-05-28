#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILENAME = ".release-please-manifest.json";

export interface AuditResult {
  ok: boolean;
  errors: string[];
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

  for (const [pkgPath, manifestVersion] of Object.entries(manifest)) {
    const pkgJsonPath = join(repoRoot, pkgPath === "." ? "" : pkgPath, "package.json");
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
