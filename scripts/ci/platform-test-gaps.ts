#!/usr/bin/env bun
// scripts/ci/platform-test-gaps.ts — `bun run audit:platform-test-gaps`
//
// Advisory. Answers one question before you push: "which tests in my diff will CI be the FIRST
// thing to execute?"
//
// Develop on Windows and `it.skipIf(process.platform === "win32")` never runs — not in
// `bun test`, not in `preflight`, not once. The suite reports green having skipped it, so a
// broken POSIX branch looks identical to a working one right up until the macOS leg goes red.
// That is not hypothetical: `platform/sandbox/win32.test.ts`'s "spawns THROUGH the helper" case
// is `skipIf(process.platform === "win32")`, so it is unrunnable on the machine most likely to
// be editing the Windows sandbox, and it reached `main` red on 2026-08-21.
//
// This is a REPORTER, not a gate. Platform-gated tests are correct and necessary — the defect
// would be failing a build over them. It exits 0 always and is registered `soft`. Its only job
// is to convert a silent skip into a sentence you read before opening the PR.
//
// The detection is a deliberate heuristic over source text: it recognises the literal skip forms
// this repo actually uses (`process.platform`/`platform()` compared against a string literal)
// and stays silent on anything else, rather than pretending to evaluate arbitrary conditions.
// A composite or imported condition is simply not reported — this under-reports by design and
// must never be read as "everything else is covered".

import { relative } from "node:path";

import { changedFiles } from "./changed-files.ts";

export interface SkipSite {
  readonly file: string;
  readonly line: number;
  /** The platform named in the condition. */
  readonly namedPlatform: string;
  /** True when the site is skipped on `onPlatform`. */
  readonly skipped: boolean;
  readonly text: string;
}

const SKIP_CALL = /\b(?:it|test|describe)\.skipIf\(([^\n]*)/;

/**
 * True when `index` falls inside a string literal on this line.
 *
 * Necessary, not defensive: any file that DISCUSSES `skipIf` in a quoted string — this script's
 * own test file, a fixture, a docs snippet — otherwise reports as a real skip site. Counting
 * unescaped quote openers before the match is enough for a single line, and is honest about its
 * limit: a string spanning lines is not tracked, so such a case is reported rather than
 * suppressed. Over-reporting is the safe direction for an advisory tool.
 */
export function insideStringLiteral(text: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === null) {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    } else if (ch === quote) {
      quote = null;
    }
  }
  return quote !== null;
}

/**
 * Decide one line. Returns `null` when the line has no recognisable platform skip.
 *
 * `skipIf(cond)` skips when `cond` is TRUE — the inverse of `runIf`. So
 * `skipIf(process.platform === "win32")` is skipped ON win32, and
 * `skipIf(process.platform !== "win32")` is skipped EVERYWHERE ELSE.
 */
export function matchSkipSite(
  file: string,
  line: number,
  text: string,
  onPlatform: string,
): SkipSite | null {
  const call = SKIP_CALL.exec(text);
  if (!call) return null;
  if (insideStringLiteral(text, call.index)) return null;
  const arg = call[1] ?? "";

  const neq = /(?:process\.)?platform(?:\(\))?\s*!==\s*["'](\w+)["']/.exec(arg);
  if (neq) {
    const named = neq[1] ?? "";
    // Skipped when the running platform is NOT the named one.
    return { file, line, namedPlatform: named, skipped: onPlatform !== named, text: text.trim() };
  }

  const eq = /(?:process\.)?platform(?:\(\))?\s*===\s*["'](\w+)["']/.exec(arg);
  if (eq) {
    const named = eq[1] ?? "";
    // Skipped when the running platform IS the named one.
    return { file, line, namedPlatform: named, skipped: onPlatform === named, text: text.trim() };
  }

  return null;
}

/** Scan one file's source for platform-gated sites that are skipped on `onPlatform`. */
export function scanSource(file: string, source: string, onPlatform: string): SkipSite[] {
  const out: SkipSite[] = [];
  const lines = source.split("\n");
  for (const [i, text] of lines.entries()) {
    const site = matchSkipSite(file, i + 1, text, onPlatform);
    if (site?.skipped === true) out.push(site);
  }
  return out;
}

/**
 * Test files touched by this branch. Delegates the git plumbing to `changed-files.ts` — see there
 * for the empty-list-on-degraded-lookup rule.
 */
export function changedTestFiles(): string[] {
  return changedFiles().filter((f) => /\.test\.tsx?$/.test(f));
}

async function main(): Promise<number> {
  const onPlatform = process.platform;
  const files = changedTestFiles();

  const sites: SkipSite[] = [];
  for (const f of files) {
    const handle = Bun.file(f);
    if (!(await handle.exists())) continue;
    sites.push(...scanSource(f, await handle.text(), onPlatform));
  }

  if (files.length === 0) {
    console.log("platform-test-gaps: no changed test files — nothing to report.");
    return 0;
  }
  if (sites.length === 0) {
    console.log(
      `platform-test-gaps: ${String(files.length)} changed test file(s); every test in them runs on ${onPlatform}.`,
    );
    return 0;
  }

  const byFile = new Map<string, SkipSite[]>();
  for (const s of sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);

  console.log(
    `platform-test-gaps: ${String(sites.length)} test(s) in your diff DO NOT RUN on ${onPlatform}.`,
  );
  console.log("Your local green says nothing about them. CI will be their first execution.\n");
  for (const [file, fileSites] of byFile) {
    console.log(`  ${relative(process.cwd(), file).replaceAll("\\", "/")}`);
    for (const s of fileSites) {
      console.log(`    :${String(s.line)}  (gated on "${s.namedPlatform}")`);
    }
  }
  console.log("\nRun them before you push:");
  console.log("  bun run verify:docker        # Linux, the CI image — covers the POSIX-only ones");
  console.log("  # macOS-only sites have no local equivalent; CI is the only coverage.");
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
