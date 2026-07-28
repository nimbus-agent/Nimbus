#!/usr/bin/env bun

/**
 * audit:coverage-gate-pal — keeps the PAL classification behind the Linux-only
 * coverage gates honest.
 *
 * `_test-suite.yml` runs coverage-threshold gates on Linux only unless the gate
 * is marked `pal: true`. That is safe only while the covered code does not
 * branch on platform. This audit fails when:
 *
 *   1. a source file branches on platform but is absent from the allowlist
 *   2. an allowlist entry names a file that no longer branches on platform
 *      (or no longer exists) — stale entries rot in the other direction
 *   3. an allowlisted file declares a gate that is not `pal: true`
 *   4. a matrix entry carries no explicit `pal` field
 *
 * Rule 4 is why the field is spelled out on all 24 entries: a new gate must be
 * classified deliberately, never by inheriting a default.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { PLATFORM_BRANCHING_ALLOWLIST } from "./platform-branching-allowlist.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

export interface GateEntry {
  name: string;
  /** null when the matrix entry carries no `pal` field at all. */
  pal: boolean | null;
}

const TEST_SUITE = ".github/workflows/_test-suite.yml";

/**
 * Runtime platform branching, or a filename that names an OS.
 *
 * The destructured-import alternative is NOT optional to cover:
 * `import { platform } from "node:os"` is the dominant idiom in this codebase
 * (6 files), and an earlier revision of this audit that matched only
 * `process.platform` missed `doctor-core.ts` — whose gate was consequently
 * classified Linux-only by mistake.
 */
const BRANCHES_ON_PLATFORM = [
  /process\.platform/,
  /os\.platform\(\)/,
  /os\.type\(\)/,
  // import { platform } / { platform as alias } / { arch, platform } from "node:os"
  /import\s*\{[^}]*\b(?:platform|type|arch)\b[^}]*\}\s*from\s*["']node:os["']/,
];
const OS_NAMED_FILE = /\/(win32|darwin|linux)\.ts$/;

function collectSources(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `src` directory anywhere under `packages/`, at any depth.
 *
 * NOT `packages/{*}/src`: `packages/mcp-connectors/src` does not exist — the 94
 * connectors each have their own `packages/mcp-connectors/{name}/src`. A
 * one-level scan silently skipped all of them, and a detector with a silent
 * blind spot is worse than none, because its green is read as coverage.
 */
function findSrcDirs(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "src") out.push(full);
    else findSrcDirs(full, out);
  }
  return out;
}

/**
 * Every non-test source file under any `src` directory in `packages/` that
 * branches on the host platform. Tests are excluded deliberately: a
 * cross-platform test branching on `process.platform` is correct, not a finding.
 */
export function detectPlatformBranchingFiles(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return [];
  const files: string[] = [];
  for (const srcDir of findSrcDirs(packagesDir, [])) {
    collectSources(srcDir, files);
  }
  const hits: string[] = [];
  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    if (OS_NAMED_FILE.test(`/${rel}`) || BRANCHES_ON_PLATFORM.some((re) => re.test(src))) {
      hits.push(rel);
    }
  }
  return hits.sort((a, b) => a.localeCompare(b));
}

/**
 * Line-based parse of the `coverage-gates` matrix. A YAML dependency is not
 * worth taking on for one well-known block, and the sibling audits
 * (check-action-sha-pins) parse workflow YAML the same way.
 */
export function parseCoverageGateMatrix(yaml: string): GateEntry[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s+gate:\s*$/.test(l));
  if (start === -1) return [];
  // Indentation is measured RELATIVE to the `gate:` key rather than assumed at
  // fixed columns, so reformatting the workflow cannot red this gate for a
  // purely cosmetic change. A parse that breaks anyway fails loud, never
  // silent: zero entries is a hard error, and a name whose `pal:` did not parse
  // stays `null`, which rule 4 reports.
  const gateIndent = (lines[start] ?? "").search(/\S/);
  const gates: GateEntry[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (line.search(/\S/) <= gateIndent) break;
    const nameMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (nameMatch?.[1] !== undefined) {
      gates.push({ name: nameMatch[1].replace(/^["']|["']$/g, ""), pal: null });
      continue;
    }
    const palMatch = line.match(/^\s*pal:\s*(true|false)\s*$/);
    const last = gates[gates.length - 1];
    if (palMatch?.[1] !== undefined && last) last.pal = palMatch[1] === "true";
  }
  return gates;
}

export function auditCoverageGatePal(repoRoot: string): AuditResult {
  const errors: string[] = [];

  const workflow = join(repoRoot, TEST_SUITE);
  if (!existsSync(workflow)) {
    return { ok: false, errors: [`${TEST_SUITE} not found`] };
  }
  const gates = parseCoverageGateMatrix(readFileSync(workflow, "utf8"));
  if (gates.length === 0) {
    return { ok: false, errors: [`${TEST_SUITE}: no coverage-gates matrix entries found`] };
  }

  // 4. every matrix entry classified explicitly
  for (const g of gates) {
    if (g.pal === null) {
      errors.push(
        `${TEST_SUITE}: coverage gate "${g.name}" has no explicit \`pal:\` field — add \`pal: true\` (runs on all 3 OSes) or \`pal: false\` (Linux only)`,
      );
    }
  }

  const palByName = new Map(gates.map((g) => [g.name, g.pal]));
  const allowByFile = new Map(PLATFORM_BRANCHING_ALLOWLIST.map((e) => [e.file, e]));
  const detected = detectPlatformBranchingFiles(repoRoot);
  const detectedSet = new Set(detected);

  // 1. detected but unclassified
  for (const file of detected) {
    if (!allowByFile.has(file)) {
      errors.push(
        `${file}: branches on platform but is not in PLATFORM_BRANCHING_ALLOWLIST — add an entry naming the coverage gate that covers it (or "none"), then make sure that gate is \`pal: true\``,
      );
    }
  }

  // 2. classified but no longer branching
  for (const entry of PLATFORM_BRANCHING_ALLOWLIST) {
    if (!detectedSet.has(entry.file)) {
      errors.push(
        `${entry.file}: listed in PLATFORM_BRANCHING_ALLOWLIST but no longer branches on platform (or no longer exists) — remove the stale entry`,
      );
    }
  }

  // 3. declared gate must be pal: true
  for (const entry of PLATFORM_BRANCHING_ALLOWLIST) {
    if (entry.gate === "none") continue;
    if (!palByName.has(entry.gate)) {
      errors.push(
        `${entry.file}: declares coverage gate "${entry.gate}", which is not in the ${TEST_SUITE} matrix`,
      );
      continue;
    }
    if (palByName.get(entry.gate) !== true) {
      errors.push(
        `${entry.file}: branches on platform and is covered by gate "${entry.gate}", but that gate is not \`pal: true\` — its coverage would run on Linux only`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const result = auditCoverageGatePal(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:coverage-gate-pal: ${err}`);
    process.exit(1);
  }
  console.log(`audit:coverage-gate-pal: OK`);
}
