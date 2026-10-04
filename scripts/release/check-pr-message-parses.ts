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
 *
 * WHY THE BODY IS RE-WRAPPED FIRST — the correction that made this gate real (#1234, v2.5.0).
 *
 * The first version composed `subject\n\n<PR body verbatim>` and parsed that. **GitHub does not
 * squash a PR body verbatim: it hard-wraps the BODY at 72 columns, breaking on spaces, and leaves
 * the SUBJECT alone.** So the message this gate judged was not the message that landed, and the
 * difference is exactly the kind that flips a parse: wrapping inserts a newline mid-line, and this
 * grammar will not accept a newline inside a `(`-group. A body whose `(` and `)` sat on one line
 * parses; wrapped so the `)` falls to the next line, it does not.
 *
 * That gap made the gate mostly inert. Measured over the 120 most recently merged PRs, whose real
 * squash commits are the ground truth: four of them genuinely fail to parse (#1218, #1219, #1224,
 * #1234), and the un-wrapped composition caught only **#1224**. It missed #1218 — the incident the
 * gate was built for — and it missed #1234, which is how a `feat` reached `main` unreleasable.
 * `docs/CHANGELOG.md`'s claim that all seven historically dropped commits "would be blocked today"
 * was checked against bodies reconstructed from the already-wrapped COMMITS, not against the
 * un-wrapped PR bodies the workflow actually feeds in, so it did not detect this.
 *
 * `wrapBody` reproduces #1234's landed commit body byte-for-byte (222 of 222 lines; GitHub then
 * appends its own `Co-authored-by:` trailer, which this does not model and does not need to — a
 * trailer appended after the body cannot change a parse failure earlier in it). With it, all three
 * reproducible incidents land on their exact CI-reported positions (103:15, 20:72, 105:24), and
 * across those 120 PRs the model agrees with the real commit on every one — zero false positives.
 */

import { parser } from "@conventional-commits/parser";

/**
 * The column GitHub hard-wraps a squash commit BODY at. Derived, not guessed: of the widths tried
 * against #1234's landed commit (70/72/75/76/80), only 72 reproduced it line-for-line.
 */
export const WRAP_COLUMNS = 72;

/**
 * Hard-wrap a commit body the way GitHub does when it composes a squash commit.
 *
 * Greedy, breaks on spaces, and never breaks INSIDE a word — a token longer than the limit is
 * emitted alone on its own line rather than split. Lines already within the limit pass through
 * untouched, which is why an already-wrapped body is a fixed point of this function.
 */
export function wrapBody(body: string, columns: number = WRAP_COLUMNS): string {
  return body
    .split("\n")
    .flatMap((line) => {
      if (line.length <= columns) return [line];
      const out: string[] = [];
      let current = "";
      for (const word of line.split(" ")) {
        if (current === "") current = word;
        else if (`${current} ${word}`.length <= columns) current = `${current} ${word}`;
        else {
          out.push(current);
          current = word;
        }
      }
      if (current !== "") out.push(current);
      return out;
    })
    .join("\n");
}

/**
 * Compose `subject\n\n<body>` from a PR title, a body, and a number, without wrapping.
 *
 * Subject is `<title> (#<number>)`; the body follows after a blank line. Reproducing the `(#N)`
 * suffix matters — it is part of what gets parsed, and it is itself a parenthesised token.
 *
 * This is NOT what GitHub produces — see `githubSquashMessage`, which is. It is kept separate
 * because the gate checks both forms.
 */
export function squashMessage(title: string, body: string, prNumber: number | undefined): string {
  const subject = prNumber === undefined ? title.trim() : `${title.trim()} (#${prNumber})`;
  const trimmedBody = body.replace(/\r\n/g, "\n").trim();
  return trimmedBody === "" ? subject : `${subject}\n\n${trimmedBody}`;
}

/**
 * The commit message GitHub will actually create on squash-merge: subject unwrapped, body wrapped.
 */
export function githubSquashMessage(
  title: string,
  body: string,
  prNumber: number | undefined,
): string {
  return squashMessage(title, wrapBody(body.replace(/\r\n/g, "\n")), prNumber);
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
  const n = Number.isFinite(prNumber) ? prNumber : undefined;

  // The wrapped form is what GitHub lands, so it decides — and its line:col is the one
  // release-please will report. The un-wrapped form is checked too rather than assumed
  // subsumed: wrapping only ever ADDS newlines, so it is not obvious that a failure in the
  // raw body must survive it, and a gate is the wrong place to rely on that being true.
  const wrapped = githubSquashMessage(title, body, n);
  const message = parseFailure(wrapped) !== undefined ? wrapped : squashMessage(title, body, n);

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
    if (message === wrapped) {
      console.error(
        `::error::That excerpt is the body AFTER GitHub hard-wraps it at ${String(WRAP_COLUMNS)} columns — which is what it squashes — so line ${String(at.line)} will NOT look like this in the PR editor, and a '(' and its ')' that share one line in your description can still land split across two. Keep the pair well inside ${String(WRAP_COLUMNS)} columns, or reword to drop the parens.`,
      );
    }
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
