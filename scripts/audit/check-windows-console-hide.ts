#!/usr/bin/env bun
/**
 * Every process spawn in the GATEWAY must pass `windowsHide`.
 *
 * ## Why
 *
 * `nimbus start` launches the Gateway with `windowsHide: true` + `detached: true`
 * (`packages/cli/src/lib/spawn-gateway.ts`), so the daemon runs with **no console of its own**.
 * On Windows a parent with no console gets a brand-new console — and a visible window —
 * allocated for every console-subsystem child it spawns. The user-visible result is console
 * windows opening and closing on an idle machine.
 *
 * Measured on Windows 11 / Bun 1.3.14 with a console-less parent and 8 children, counting
 * VISIBLE `ConsoleWindowClass` windows via `EnumWindows` + `IsWindowVisible`:
 *
 * | spawn API            | `windowsHide` | visible windows |
 * | -------------------- | ------------- | --------------- |
 * | `Bun.spawn`          | absent        | 8 / 8           |
 * | `Bun.spawn`          | `true`        | 0               |
 * | `node:child_process` | `false`       | 8 / 8           |
 * | `node:child_process` | `true`        | 0               |
 *
 * Note the measurement method: **counting `conhost.exe` cannot detect this bug.**
 * `CREATE_NO_WINDOW` still allocates a console and still spawns a conhost — it is only
 * invisible — so both modes produce identical conhost counts. Only visible-window enumeration
 * separates them.
 *
 * ## Why a static gate rather than a helper
 *
 * `platform/spawn-capture.ts` already exists for exactly this, and it fixed the vendor CLIs
 * (`aws`/`gcloud`/`az`/`bq`/`kubectl`) — but nothing stopped the `git`-spawning sync paths from
 * being written afterwards without it, and they were: `connectors/filesystem-v2-sync.ts` spawned
 * one `git blame` per indexed file, up to 120 per root, on EVERY 10-minute tick. A helper you can
 * decline to use is not a defense. This gate is what makes the property hold for spawns written
 * later, including ones that legitimately cannot use `spawnCapture` (streaming stdout, an
 * `AbortSignal`, a long-lived child).
 *
 * ## Scope
 *
 * `packages/gateway/src` only. `packages/cli` is a console application: its children inherit the
 * user's terminal console and allocate nothing, so the same flag there would be noise. The one
 * CLI spawn that matters is the daemon launch itself, which already hides — and must, since a
 * visible daemon window is its own bug.
 *
 * A spawn that genuinely cannot pop a window (a POSIX-only code path, a GUI target) is suppressed
 * with `// windows-console-ok: <reason>` on the call's line or the line above. The reason is not
 * optional prose: it is what a later reader needs in order to know the exemption still holds.
 *
 * ## What counts as passing
 *
 * The literal `windowsHide: true`, in the call's OWN options object — `parens === 1` so a nested
 * call's flag cannot excuse this one, `braces === 1` so `{ env: { windowsHide: true } }` cannot
 * either, and the value checked so `windowsHide: false` cannot. Accepting the bare token was the
 * first version of this rule and it was wrong in a way that mattered: this PR's own measurement
 * harness built its positive control out of `windowsHide: false`.
 *
 * ## What counts as a spawn
 *
 * `Bun.spawn`/`Bun.spawnSync`; a bare `spawn`/`spawnSync` in a file that imports
 * `node:child_process` or declares a `typeof Bun.spawn` injection point; and `X.spawn(...)` where
 * `X` is bound by `import * as X from "node:child_process"`. A member call on anything else
 * (`runner.spawn(...)`, `spawnCaptureInternals.spawn(...)`) is indirection — the real spawn it
 * reaches is checked at its own definition, so flagging the indirection would add noise and
 * catch nothing.
 */
import { readFileSync } from "node:fs";
import { Glob } from "bun";

import { REPO_ROOT, stripComments, stripStringLiterals } from "../structure-audit/lib.ts";

export interface UnhiddenSpawnIssue {
  readonly file: string;
  readonly line: number;
  /** `Bun.spawn`, `Bun.spawnSync`, `spawn` or `spawnSync` — what was called. */
  readonly callee: string;
  /** Set when paren-matching ran off the end of the file rather than finding the flag missing. */
  readonly unterminated?: true;
}

const SUPPRESS = "windows-console-ok";
const REQUIRED_FLAG = "windowsHide";

/**
 * A `spawn(`/`spawnSync(` call, optionally qualified by a single identifier: `Bun.spawn(`,
 * `childProcess.spawn(`, `runner.spawn(`.
 *
 * Capturing the qualifier rather than excluding every member call is what lets the two be told
 * apart. `runner.spawn(...)` is indirection through `SandboxRunner` and the real spawn it
 * reaches is checked at the runner's own definition — but `childProcess.spawn(...)` from a
 * `node:child_process` NAMESPACE import is a real spawn wearing the same shape, and excluding
 * all member calls let it through.
 */
const CALL_RE = /(?<![.\w$])(?:([A-Za-z_$][A-Za-z0-9_$]*)\.)?spawn(Sync)?\s*\(/g;

/** A file may call a bare `spawn(...)` that is a real process spawn only if it can reach one. */
function fileCanSpawnBare(code: string): boolean {
  return /from\s+["']node:child_process["']/.test(code) || /typeof\s+Bun\.spawn/.test(code);
}

/** Aliases bound by `import * as X from "node:child_process"` — `X.spawn(...)` is a real spawn. */
function childProcessNamespaces(code: string): ReadonlySet<string> {
  const out = new Set<string>();
  const re = /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']node:child_process["']/g;
  for (const m of code.matchAll(re)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return out;
}

/** 1-based line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Walk from the call's `(` to its matching `)`, collecting whether `windowsHide` appears at
 * relative paren depth 0 — i.e. in THIS call's own argument list, not inside an argument's own
 * call. Returns `null` when the parens never close (fail-closed: the caller reports it).
 */
function scanCallArgs(code: string, openParen: number): { hasFlag: boolean } | null {
  let parens = 0;
  let braces = 0;
  let hasFlag = false;
  for (let i = openParen; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") {
      parens += 1;
      continue;
    }
    if (ch === ")") {
      parens -= 1;
      if (parens === 0) return { hasFlag };
      continue;
    }
    if (ch === "{") {
      braces += 1;
      continue;
    }
    if (ch === "}") {
      braces -= 1;
      continue;
    }
    // `parens === 1` keeps a nested CALL's flag from excusing this one; `braces === 1` keeps a
    // flag nested one object deeper (`{ env: { windowsHide: true } }`) from doing the same.
    // The value must be the literal `true`: accepting the bare token let `windowsHide: false`
    // pass while still popping a window.
    if (parens === 1 && braces === 1 && code.startsWith(REQUIRED_FLAG, i)) {
      const rest = code.slice(i + REQUIRED_FLAG.length);
      if (/^\s*:\s*true\b/.test(rest)) hasFlag = true;
    }
  }
  return null;
}

/**
 * A declaration, not a call: `spawn(cmd: string, ...): ChildProcess` in an interface or class.
 * The discriminator is the return-type colon directly after the closing paren.
 */
function isDeclaration(code: string, openParen: number): boolean {
  let depth = 0;
  for (let i = openParen; i < code.length; i++) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        const rest = code.slice(i + 1).trimStart();
        return rest.startsWith(":");
      }
    }
  }
  return false;
}

function isSuppressed(sourceLines: readonly string[], line: number): boolean {
  const own = sourceLines[line - 1] ?? "";
  const above = line >= 2 ? (sourceLines[line - 2] ?? "") : "";
  return own.includes(SUPPRESS) || above.includes(SUPPRESS);
}

export function findUnhiddenSpawns(source: string, file: string): UnhiddenSpawnIssue[] {
  const decommented = stripComments(source);
  const code = stripStringLiterals(decommented);
  const sourceLines = source.split("\n");
  // Checked BEFORE string literals are blanked: the import specifier this looks for
  // (`"node:child_process"`) IS a string literal, and reading it from `code` finds nothing.
  // Comments are still stripped, so a commented-out import does not license a bare call.
  const bareAllowed = fileCanSpawnBare(decommented);
  // Read before string blanking, for the same reason as `fileCanSpawnBare`: the module specifier
  // it matches on is itself a string literal.
  const namespaces = childProcessNamespaces(decommented);
  const issues: UnhiddenSpawnIssue[] = [];

  CALL_RE.lastIndex = 0;
  for (const m of code.matchAll(CALL_RE)) {
    const start = m.index;
    const qualifier = m[1];
    if (qualifier === undefined) {
      if (!bareAllowed) continue;
    } else if (qualifier !== "Bun" && !namespaces.has(qualifier)) {
      continue; // `runner.spawn(...)` and friends: indirection, checked at the definition
    }

    const openParen = start + m[0].length - 1;
    if (isDeclaration(code, openParen)) continue;

    const callee = `${qualifier === undefined ? "" : `${qualifier}.`}spawn${m[2] ?? ""}`;
    const line = lineAt(code, start);
    if (isSuppressed(sourceLines, line)) continue;

    const scan = scanCallArgs(code, openParen);
    if (scan === null) {
      issues.push({ file, line, callee, unterminated: true });
      continue;
    }
    if (!scan.hasFlag) issues.push({ file, line, callee });
  }
  return issues;
}

async function main(): Promise<void> {
  const all: UnhiddenSpawnIssue[] = [];
  const glob = new Glob("packages/gateway/src/**/*.ts");
  for await (const rel of glob.scan({ cwd: REPO_ROOT })) {
    if (rel.endsWith(".test.ts")) continue;
    const posix = rel.replaceAll("\\", "/");
    for (const issue of findUnhiddenSpawns(readFileSync(`${REPO_ROOT}/${rel}`, "utf8"), posix)) {
      all.push(issue);
    }
  }

  if (all.length === 0) {
    console.log("windows-console audit: every gateway process spawn passes windowsHide.");
    return;
  }
  for (const i of all) {
    const why =
      i.unterminated === true
        ? `could not find the end of this ${i.callee}(...) call — check it passes ${REQUIRED_FLAG}`
        : `${i.callee}(...) does not pass \`${REQUIRED_FLAG}: true\` in its own options object — the detached Gateway has no console, so this pops a window on Windows. Add it, route through platform/spawn-capture.ts, or annotate \`// ${SUPPRESS}: <reason>\``;
    console.error(`::error file=${i.file},line=${i.line}::${why}`);
  }
  console.error(`\n${all.length} unhidden gateway spawn(s).`);
  process.exit(1);
}

if (import.meta.main) await main();
