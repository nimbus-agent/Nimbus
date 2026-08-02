#!/usr/bin/env bun

/**
 * audit:override-drift — a root `overrides` pin must satisfy every range the
 * workspace declares for that same package.
 *
 * Root `overrides` is this repo's mechanism for forcing a transitive dependency
 * onto a chosen version (see the preamble of `accepted-advisories.ts`: "Upgrade.
 * Root `overrides` in package.json is this repo's mechanism."). It is also, by
 * construction, the one field that outranks every `dependencies` declaration in
 * the tree — bun resolves the override and ignores the declared range entirely.
 *
 * That makes a divergence between the two silent AND self-concealing:
 *
 *   - `packages/gateway` declared `js-yaml: ^5.2.2` while root `overrides`
 *     pinned `4.3.0`. The installed copy was 4.3.0. Nothing reported this.
 *   - Because the override wins, Dependabot PRs against those packages MERGE
 *     GREEN AND CHANGE NOTHING. Dependabot edits `dependencies`; it has no
 *     notion of `overrides`. The manifest moves, the lockfile does not, CI is
 *     green, and the repo now believes it is running a version it is not.
 *   - `bun outdated` cannot see it either: it compares the DECLARED range
 *     against the `latest` dist-tag, so a package held on an older major shows
 *     only that major's successor and the held line disappears from the report.
 *
 * The only durable fix is to make the two agree, so this gate fails whenever
 * they do not. The correct resolution is a judgement call and deliberately not
 * automated: either move the pin up to satisfy the declaration, move the
 * declaration down to state what is actually installed, or delete an override
 * that has no reason to exist. What the gate forbids is leaving the manifest
 * lying about the tree.
 *
 * Scope is root + workspace members only. `packages/github-actions/*` are
 * tracked but intentionally NOT workspace members (see CLAUDE.md), so root
 * `overrides` never governs their installs and a divergence there would be no
 * lie about anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** One `<package> -> <range>` declaration found in a manifest. */
export interface Declaration {
  /** Repo-relative, forward slashes, so findings read identically on Windows. */
  readonly file: string;
  readonly field: string;
  readonly range: string;
}

/** Dependency fields a declared range can live in. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Both keys bun honours for forcing a resolution. `resolutions` is the Yarn
 * spelling and bun accepts it as a synonym; checking only `overrides` would
 * leave a one-word bypass of this entire gate.
 */
const OVERRIDE_FIELDS = ["overrides", "resolutions"] as const;

/**
 * Ranges this gate cannot and must not evaluate with semver.
 *
 * These are not version ranges at all — they are resolution PROTOCOLS naming a
 * location rather than a version (`workspace:*`, `npm:` aliases, `file:`/`link:`
 * paths, git/github specs, `catalog:` entries). `Bun.semver.satisfies` returns
 * false for every one of them, so treating them as ranges would manufacture a
 * finding for a manifest that is perfectly consistent.
 */
const NON_SEMVER_PROTOCOL =
  /^(?:workspace|npm|file|link|portal|catalog|git|git\+ssh|git\+https|github|patch|https?):/;

/** An exact version — the only pin shape whose intent is unambiguous. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Resolve one workspace entry (already stripped of any `!`) to the manifest
 * paths it names. A literal entry is taken at its word; a glob is expanded.
 */
function manifestsForPattern(repoRoot: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/");
  if (normalized.length === 0) return [];
  if (!normalized.includes("*")) return [`${normalized}/package.json`];
  const out: string[] = [];
  for (const hit of new Glob(`${normalized}/package.json`).scanSync({ cwd: repoRoot })) {
    out.push(hit.replace(/\\/g, "/"));
  }
  return out;
}

/**
 * Raised when `workspaces` contains a negated entry. A distinct type so the
 * audit can turn it into a finding instead of a stack trace, and so a test can
 * assert the fail-closed path fired for this reason and not another.
 */
export class NegatedWorkspaceEntryError extends Error {
  constructor(readonly entry: string) {
    super(
      `workspaces contains the negated entry "${entry}" — audit:override-drift does not model negated workspace patterns and refuses to guess at bun's resolution. Add support deliberately (with its own tests), or remove the entry.`,
    );
    this.name = "NegatedWorkspaceEntryError";
  }
}

/**
 * Every manifest root `overrides` actually governs: the root manifest plus each
 * workspace member. Workspace entries may be globs, so a literal path and a
 * `packages/*` pattern both resolve correctly — Nimbus lists 99 literal paths
 * today, but a future glob must not silently shrink this gate's scope.
 *
 * NEGATED entries (`"!packages/legacy-thing"`) are refused outright. Bun honours
 * them, but its handling was measured to be ORDER-DEPENDENT (bun 1.3.14, clean
 * temp workspaces and a fresh lockfile per case), while every straightforward
 * static re-implementation — including the one this replaces — is
 * order-INDEPENDENT. Such an implementation therefore computes a different member
 * set than bun actually installs, and it would do so in the one gate whose entire
 * job is catching a manifest that lies about the tree. This gate's value is that
 * it cannot be wrong: an explicit "I cannot model this" is strictly better than a
 * silently divergent answer. Supporting negation means replicating bun's ordering
 * semantics deliberately, as its own change with its own tests — not as a
 * side-effect of this one. Nothing in this repo is affected today: root
 * `workspaces` is 99 literal paths with no negated entries and no globs.
 */
export function workspaceManifests(repoRoot: string): string[] {
  const root = readJson(join(repoRoot, "package.json"));
  const files = ["package.json"];
  const workspaces = root?.["workspaces"];
  if (!Array.isArray(workspaces)) return files;
  for (const entry of workspaces) {
    if (typeof entry !== "string") continue;
    if (entry.startsWith("!")) throw new NegatedWorkspaceEntryError(entry);
    files.push(...manifestsForPattern(repoRoot, entry));
  }
  return [...new Set(files)];
}

/** Every declared range for `name` across the given manifests, protocols excluded. */
export function collectDeclarations(
  repoRoot: string,
  manifests: readonly string[],
  name: string,
): Declaration[] {
  const out: Declaration[] = [];
  for (const rel of manifests) {
    const json = readJson(join(repoRoot, rel));
    if (json === null) continue;
    for (const field of DEPENDENCY_FIELDS) {
      const range = stringRecord(json[field])[name];
      if (range === undefined) continue;
      if (NON_SEMVER_PROTOCOL.test(range)) continue;
      out.push({ file: rel, field, range });
    }
  }
  return out;
}

/**
 * The pins under both override spellings. A package listed under both wins
 * from `overrides`, matching bun's own precedence.
 */
export function collectPins(repoRoot: string): Record<string, unknown> {
  const root = readJson(join(repoRoot, "package.json"));
  const pins: Record<string, unknown> = {};
  if (root === null) return pins;
  for (const field of [...OVERRIDE_FIELDS].reverse()) {
    const block = root[field];
    if (!isRecord(block)) continue;
    for (const [k, v] of Object.entries(block)) pins[k] = v;
  }
  return pins;
}

export function auditOverrideDrift(repoRoot: string): AuditResult {
  const errors: string[] = [];
  if (readJson(join(repoRoot, "package.json")) === null) {
    return { ok: false, errors: ["package.json not found or unparseable"] };
  }
  let manifests: string[];
  try {
    manifests = workspaceManifests(repoRoot);
  } catch (err) {
    // Fail closed: a workspace set this gate cannot compute is not a pass.
    if (err instanceof NegatedWorkspaceEntryError) return { ok: false, errors: [err.message] };
    throw err;
  }

  for (const [name, pin] of Object.entries(collectPins(repoRoot))) {
    const declarations = collectDeclarations(repoRoot, manifests, name);
    // A transitive-only override has no declaration to contradict. That is the
    // normal case — most of this repo's pins exist precisely because nothing
    // declares the package directly — and it is not a finding.
    if (declarations.length === 0) continue;

    if (typeof pin !== "string") {
      errors.push(
        `overrides["${name}"] is not a version string — this gate cannot verify a nested override against the ${declarations.length} range(s) declared for "${name}"; flatten it to a single version`,
      );
      continue;
    }
    if (!EXACT_VERSION.test(pin)) {
      errors.push(
        `overrides["${name}"] is "${pin}", which is a range rather than an exact version — a pin that outranks ${declarations.length} declared range(s) must say exactly what gets installed`,
      );
      continue;
    }
    for (const d of declarations) {
      if (Bun.semver.satisfies(pin, d.range)) continue;
      errors.push(
        `overrides["${name}"] pins ${pin}, which is outside "${d.range}" declared in ${d.file} (${d.field}) — the override wins, so ${pin} is what is installed and the declaration is a lie. Move the pin, lower the declaration, or drop the override.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const result = auditOverrideDrift(process.cwd());
  if (!result.ok) {
    for (const err of result.errors) console.error(`audit:override-drift: ${err}`);
    process.exit(1);
  }
  console.log("audit:override-drift: OK");
}
