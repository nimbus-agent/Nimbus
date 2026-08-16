#!/usr/bin/env bun

/**
 * Guard — the squash commit this PR will produce must PARSE.
 *
 * The repo squash-merges, so the PR title becomes the commit subject and **the PR body becomes the
 * commit body**. `pr-title-lint.yml` already protects the title, for exactly this reason. Nothing
 * protected the body, and the body is parsed too.
 *
 * Twice now that has silently cost a release note:
 *
 *   v2.4.6 — #1218's body contained `` `.run(` ``/`` `.exec(` ``: code spans holding unbalanced
 *            parentheses. release-please failed with `unexpected token '(' at 103:15` and dropped
 *            the commit, so a `fix(security):` shipped with no changelog entry.
 *   v2.4.7 — #1224, the PR that FIXED the fallout, quoted those same strings while explaining
 *            them and was dropped the same way (`17:15`).
 *
 * Tags are immutable, so neither can be corrected after the fact.
 *
 * WHY THE REAL PARSER, NOT A HEURISTIC. I tried to model this as "unbalanced parens" and then as
 * "nesting depth", and measured both against 400 commits on `main`: the first flagged 17 where
 * only 2 had actually failed, the second flagged 148 including a commit that parsed fine, and
 * neither explained the reported error positions. A gate that noisy gets switched off. This uses
 * `@conventional-commits/parser`, which is release-please's OWN dependency
 * (`'@conventional-commits/parser': '^0.4.1'`), so the answer here is the answer there — verified
 * by reproducing both historical failures at their exact reported line:col.
 */

import { parser } from "@conventional-commits/parser";

/**
 * Compose the commit message GitHub will create on squash-merge.
 *
 * Subject is `<title> (#<number>)`; the body follows after a blank line. Reproducing the `(#N)`
 * suffix matters — it is part of what gets parsed, and it is itself a parenthesised token.
 */
export function squashMessage(title: string, body: string, prNumber: number | undefined): string {
  const subject = prNumber === undefined ? title.trim() : `${title.trim()} (#${prNumber})`;
  const trimmedBody = body.replace(/\r\n/g, "\n").trim();
  return trimmedBody === "" ? subject : `${subject}\n\n${trimmedBody}`;
}

/** The parser's own error, or undefined when the message parses. */
export function parseFailure(message: string): string | undefined {
  try {
    parser(message);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** `line:col` from a parser error, for pointing at the offending character. */
export function positionOf(error: string): { line: number; col: number } | undefined {
  const m = /at (\d+):(\d+)/.exec(error);
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  return { line: Number(m[1]), col: Number(m[2]) };
}

/** The offending line with a caret under the column, so the author can see what to change. */
export function excerpt(message: string, at: { line: number; col: number }): string {
  const line = message.split("\n")[at.line - 1];
  if (line === undefined) return "";
  return `${line}\n${" ".repeat(Math.max(0, at.col - 1))}^`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const title = process.env["PR_TITLE"] ?? "";
  const body = process.env["PR_BODY"] ?? "";
  const numberRaw = process.env["PR_NUMBER"];
  if (title.trim() === "") {
    console.error("::error::PR_TITLE is empty — refusing to report a clean parse on no input.");
    process.exit(1);
  }
  const prNumber = numberRaw === undefined || numberRaw === "" ? undefined : Number(numberRaw);
  const message = squashMessage(title, body, Number.isFinite(prNumber) ? prNumber : undefined);

  const failure = parseFailure(message);
  if (failure === undefined) {
    console.log("check-pr-message-parses: OK — the squash commit will parse.");
    return;
  }

  console.error(`::error::this PR's squash commit will NOT parse: ${failure}`);
  const at = positionOf(failure);
  if (at !== undefined) {
    console.error(`::error::line ${at.line}, column ${at.col} of the composed commit message:`);
    for (const l of excerpt(message, at).split("\n")) console.error(`  ${l}`);
  }
  console.error(
    "::error::release-please parses the squash commit, and the PR BODY is that commit's body. A message it cannot parse is DROPPED from the changelog silently — the release still ships, just without this entry, and the tag is immutable afterwards.",
  );
  console.error(
    "::error::Most often this is an unbalanced `(` inside a code span — write `` `.run(…)` `` rather than `` `.run(` ``. Edit the PR description and this check re-runs.",
  );
  process.exit(1);
}

if (import.meta.main) main();
