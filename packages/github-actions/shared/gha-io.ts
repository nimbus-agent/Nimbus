// Shared GitHub Actions I/O helpers for the first-party Nimbus actions (preflight-query +
// annotate-action). These were byte-identical across both actions' main.ts/output.ts; hoisting them
// here removes the duplication. The packages are bundled standalone via `bun build`, so this relative
// module is inlined at build time (no workspace/package dependency is introduced).

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit byte ranges define the sanitizer barrier
const DENY_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip control characters and clamp to maxLen. Non-string input → "". */
export function safeString(raw: unknown, maxLen: number): string {
  const s = typeof raw === "string" ? raw : "";
  return s.replace(DENY_CHARS, "").slice(0, maxLen);
}

/** Coerce to a finite truncated integer; non-finite input → 0. */
export function safeInt(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Read an action input from its `INPUT_<NAME>` env var (missing → ""). */
export function getInput(name: string): string {
  const envName = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  return process.env[envName] ?? "";
}

/** Read a boolean action input ("true"/"1"/"yes" → true, case-insensitive). */
export function getBooleanInput(name: string): boolean {
  const raw = getInput(name).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/** Read an integer action input, falling back when empty or non-integer. */
export function getIntInput(name: string, fallback: number): number {
  const raw = getInput(name);
  if (raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : fallback;
}

const STEP_SUMMARY_MAX_BYTES = 64 * 1024;

/** Append markdown to the job summary file (capped), if `GITHUB_STEP_SUMMARY` is set. */
export function writeJobSummary(md: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file === undefined) return;
  const safe = md.length > STEP_SUMMARY_MAX_BYTES ? md.slice(0, STEP_SUMMARY_MAX_BYTES) : md;
  appendFileSync(file, `${safe}\n`);
}

/** Emit a GitHub Actions workflow annotation command on stdout. */
export function emitAnnotation(level: "warning" | "error", message: string): void {
  process.stdout.write(`::${level}::${message}\n`);
}

/**
 * Build a `setOutput(name, value)` bound to an action's allow-list of output names. Uses the
 * heredoc-delimiter form to support multi-line values; refuses unknown output names (each action
 * declares exactly the outputs in its action.yml). No-op when `GITHUB_OUTPUT` is unset.
 */
export function makeSetOutput(
  allowedNames: ReadonlySet<string>,
): (name: string, value: string) => void {
  return (name: string, value: string): void => {
    if (!allowedNames.has(name)) {
      throw new Error(`refusing to set unknown output: ${name}`);
    }
    const outFile = process.env.GITHUB_OUTPUT;
    if (outFile === undefined) return;
    let delim: string;
    do {
      delim = `EOF_${randomUUID().replaceAll("-", "")}`;
    } while (value.includes(delim));
    appendFileSync(outFile, `${name}<<${delim}\n${value}\n${delim}\n`);
  };
}
