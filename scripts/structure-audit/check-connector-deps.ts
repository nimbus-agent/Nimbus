#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONNECTORS_DIR = resolve(import.meta.dir, "..", "..", "packages", "mcp-connectors");

/**
 * Runtime dependencies a first-party connector may declare. Every connector is bundled into the
 * gateway binary, so a native (node-gyp / prebuilt `.node`) dependency would either fail the
 * compile or produce a binary that cannot load its shared library at runtime — and the only symptom
 * a user sees is a sync that never works. Keep this list pure JavaScript.
 */
export const ALLOWED_CONNECTOR_DEPS: readonly string[] = [
  "@modelcontextprotocol/sdk",
  "@nimbus-dev/sdk",
  "zod",
  "hyparquet",
  "imapflow",
  "nodemailer",
  "tsdav",
];

export interface DepViolation {
  readonly connector: string;
  readonly dependency: string;
}

export function checkConnectorDeps(dir: string = CONNECTORS_DIR): DepViolation[] {
  const allowed = new Set(ALLOWED_CONNECTOR_DEPS);
  const out: DepViolation[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(dir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!allowed.has(dep)) out.push({ connector: entry.name, dependency: dep });
    }
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorDeps();
  for (const v of violations) {
    console.error(
      `::error file=packages/mcp-connectors/${v.connector}/package.json::dependency "${v.dependency}" is not in ALLOWED_CONNECTOR_DEPS — connectors are bundled into the gateway binary, so a native dependency breaks it silently`,
    );
  }
  console.log(
    violations.length === 0
      ? "connector deps: ok"
      : `connector deps: ${violations.length} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
