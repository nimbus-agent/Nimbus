#!/usr/bin/env bun

/**
 * audit:action-sha-pins — asserts every third-party GitHub Actions `uses:` ref in
 * .github/workflows/*.yml and .github/actions/{*}/action.yml is pinned to a full
 * 40-hex commit SHA. The `nimbus-agent` org now REQUIRES SHA-pinning, so an
 * unpinned `uses: owner/action@v4` ref is rejected at run time — this gate catches
 * the regression locally before it ever reaches CI.
 *
 * Exempt (correctly tag-less): local `./...` actions, reusable workflows
 * (`./.github/workflows/...`), and Docker refs (`docker://`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;

function collectYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectYaml(full));
    } else if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
      out.push(full);
    }
  }
  return out;
}

export function auditActionShaPins(repoRoot: string): AuditResult {
  const errors: string[] = [];
  const files = [
    ...collectYaml(join(repoRoot, ".github/workflows")),
    ...collectYaml(join(repoRoot, ".github/actions")),
  ];

  // Matches `uses: <ref>` (optionally quoted), capturing the ref up to any comment.
  const usesRe = /^\s*-?\s*uses:\s*["']?([^"'\s#]+)["']?/;

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(usesRe);
      if (!m) return;
      const ref = m[1];
      if (ref === undefined) return;
      // Exempt local actions / reusable workflows / docker refs.
      if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("docker://")) return;
      const at = ref.lastIndexOf("@");
      const rel = file.slice(repoRoot.length + 1).replace(/\\/g, "/");
      if (at === -1) {
        errors.push(`${rel}:${i + 1}: \`uses: ${ref}\` has no @ref — pin to a 40-hex SHA`);
        return;
      }
      const pin = ref.slice(at + 1);
      if (!SHA_RE.test(pin)) {
        errors.push(
          `${rel}:${i + 1}: \`uses: ${ref}\` is not SHA-pinned (got @${pin}) — the org requires a full 40-hex commit SHA`,
        );
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolves the repository root to audit. Defaults to the process cwd so the
 * local preflight gate is unchanged; `--root <path>` lets the org-wide sweep
 * aim the same audited logic at a checkout of another repository.
 */
export function parseRootArg(argv: string[]): string {
  const ix = argv.indexOf("--root");
  if (ix === -1) return process.cwd();
  const value = argv[ix + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--root requires a path");
  }
  return value;
}

if (import.meta.main) {
  const root = parseRootArg(process.argv.slice(2));
  const result = auditActionShaPins(root);
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:action-sha-pins: ${err}`);
    process.exit(1);
  }
  console.log("audit:action-sha-pins: OK");
}
