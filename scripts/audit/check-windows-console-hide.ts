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
 * `Bun.spawn(`/`Bun.spawnSync(`, or a BARE `spawn(`/`spawnSync(`.
 *
 * The lookbehind is what excludes `runner.spawn(...)` and `spawnCaptureInternals.spawn(...)`:
 * a member call on something other than `Bun` is indirection, and the real spawn it reaches is
 * checked at its own definition. Without it the guard would flag the indirection and miss
 * nothing extra.
 */
const CALL_RE = /(?<![.\w$])(Bun\.)?spawn(Sync)?\s*\(/g;

/** A file may call a bare `spawn(...)` that is a real process spawn only if it can reach one. */
function fileCanSpawnBare(code: string): boolean {
  return /from\s+["']node:child_process["']/.test(code) || /typeof\s+Bun\.spawn/.test(code);
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
  let depth = 0;
  for (let i = openParen; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { hasFlag: false };
      continue;
    }
    if (depth === 1 && code.startsWith(REQUIRED_FLAG, i)) {
      // Found at this call's own depth. Still need the call to terminate, but the answer is fixed.
      for (let j = i; j < code.length; j++) {
        if (code[j] === "(") depth += 1;
        else if (code[j] === ")") {
          depth -= 1;
          if (depth === 0) return { hasFlag: true };
        }
      }
      return null;
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
  const issues: UnhiddenSpawnIssue[] = [];

  CALL_RE.lastIndex = 0;
  for (const m of code.matchAll(CALL_RE)) {
    const start = m.index;
    const qualified = m[1] !== undefined;
    if (!qualified && !bareAllowed) continue;

    const openParen = start + m[0].length - 1;
    if (isDeclaration(code, openParen)) continue;

    const callee = `${qualified ? "Bun." : ""}spawn${m[2] ?? ""}`;
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
        : `${i.callee}(...) does not pass ${REQUIRED_FLAG} — the detached Gateway has no console, so this pops a window on Windows. Add \`${REQUIRED_FLAG}: true\`, route through platform/spawn-capture.ts, or annotate \`// ${SUPPRESS}: <reason>\``;
    console.error(`::error file=${i.file},line=${i.line}::${why}`);
  }
  console.error(`\n${all.length} unhidden gateway spawn(s).`);
  process.exit(1);
}

if (import.meta.main) await main();
