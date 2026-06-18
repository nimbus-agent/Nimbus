#!/usr/bin/env bun

/**
 * audit:status-drift — keeps the human-facing "status surfaces" (CLAUDE.md,
 * GEMINI.md, docs/architecture.md, docs/SECURITY-INVARIANTS.md) in sync with the
 * two canonical numbers that drift every release+slice: the highest security
 * invariant (`I<N>`) and the SQLite schema version (`V<N>`).
 *
 * Canonical sources (code, not prose):
 *   - schema   → `CURRENT_SCHEMA_VERSION` in packages/gateway/src/index/local-index.ts
 *               (cross-checked against the highest `v<N>-*.ts` migration file)
 *   - invariant→ the highest `I<N>` referenced in
 *               packages/gateway/src/security-invariants.test.ts
 *
 * The check is intentionally narrow: it only matches the unambiguous *ceiling*
 * phrasings ("invariants through I<N>", "schema V<N>", the SECURITY-INVARIANTS
 * "## I<N>" headings + "Current ceiling" line) so legitimate references to
 * individual older invariants / migrations never false-positive.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

function read(repoRoot: string, rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** Highest integer captured by `re` (global, one capture group) across `text`. */
function maxCapture(text: string, re: RegExp): number | undefined {
  let max: number | undefined;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (max === undefined || n > max)) max = n;
  }
  return max;
}

function canonicalSchema(repoRoot: string): { value: number; errors: string[] } {
  const errors: string[] = [];
  const src = read(repoRoot, "packages/gateway/src/index/local-index.ts");
  const m = src.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/);
  if (!m) {
    errors.push("could not find CURRENT_SCHEMA_VERSION in local-index.ts");
    return { value: -1, errors };
  }
  const value = Number(m[1]);

  // Cross-check: the highest `…-v<N>-sql.ts` migration file must equal the constant.
  const indexDir = join(repoRoot, "packages/gateway/src/index");
  const migrationMax = readdirSync(indexDir)
    .map((f) => f.match(/v(\d+)-sql\.ts$/)?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number)
    .reduce((a, b) => Math.max(a, b), -1);
  if (migrationMax >= 0 && migrationMax !== value) {
    errors.push(
      `CURRENT_SCHEMA_VERSION (${value}) != highest migration file …-v${migrationMax}-sql.ts — one of them is stale`,
    );
  }
  return { value, errors };
}

function canonicalInvariant(repoRoot: string): { value: number; errors: string[] } {
  const errors: string[] = [];
  const test = read(repoRoot, "packages/gateway/src/security-invariants.test.ts");
  const value = maxCapture(test, /\bI(\d{1,2})\b/g);
  if (value === undefined) {
    errors.push("could not find any I<N> reference in security-invariants.test.ts");
    return { value: -1, errors };
  }
  return { value, errors };
}

export function auditStatusDrift(repoRoot: string): AuditResult {
  const errors: string[] = [];

  const schema = canonicalSchema(repoRoot);
  const invariant = canonicalInvariant(repoRoot);
  errors.push(...schema.errors, ...invariant.errors);
  const schemaV = schema.value;
  const invI = invariant.value;

  // Surfaces that carry the ceiling phrasings + which checks apply to each.
  const surfaces = ["CLAUDE.md", "GEMINI.md", "docs/architecture.md"] as const;

  for (const rel of surfaces) {
    if (!existsSync(join(repoRoot, rel))) {
      errors.push(`${rel}: status surface missing`);
      continue;
    }
    const text = read(repoRoot, rel);

    // "invariants through I<N>"
    for (const m of text.matchAll(/invariants?\s+through\s+I(\d+)/gi)) {
      if (Number(m[1]) !== invI) {
        errors.push(
          `${rel}: "invariants through I${m[1]}" is stale — canonical highest invariant is I${invI}`,
        );
      }
    }
    // "schema V<N>"
    for (const m of text.matchAll(/\bschema\s+V(\d+)/gi)) {
      if (Number(m[1]) !== schemaV) {
        errors.push(`${rel}: "schema V${m[1]}" is stale — canonical schema is V${schemaV}`);
      }
    }
  }

  // docs/SECURITY-INVARIANTS.md — the canonical invariant doc.
  const secInvRel = "docs/SECURITY-INVARIANTS.md";
  if (existsSync(join(repoRoot, secInvRel))) {
    const sec = read(repoRoot, secInvRel);
    // Highest "## I<N>" heading (line-anchored — ignores inline `## I28` examples).
    const headingMax = maxCapture(sec, /^#{1,6}\s+I(\d+)\b/gm);
    if (headingMax !== undefined && headingMax !== invI) {
      errors.push(
        `${secInvRel}: highest "## I${headingMax}" heading != canonical invariant I${invI}`,
      );
    }
    // "Current ceiling: invariants I1–I<N>"
    for (const m of sec.matchAll(/Current ceiling[^\n]*?I1[–—-]I?(\d+)/gi)) {
      if (Number(m[1]) !== invI) {
        errors.push(
          `${secInvRel}: "Current ceiling … I1–I${m[1]}" is stale — canonical is I${invI}`,
        );
      }
    }
  } else {
    errors.push(`${secInvRel}: status surface missing`);
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const result = auditStatusDrift(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:status-drift: ${err}`);
    console.error(
      "\naudit:status-drift: FAILED — update the status surfaces above to match the canonical invariant/schema numbers.",
    );
    process.exit(1);
  }
  console.log("audit:status-drift: OK");
}
