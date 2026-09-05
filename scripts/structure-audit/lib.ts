import { join, resolve } from "node:path";
import { Glob } from "bun";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

type StringDelim = '"' | "'" | "`";
type StripState = {
  i: number;
  out: string;
  inString: StringDelim | null;
  done: boolean;
};

/**
 * Characters after which a `/` opens a REGEX literal rather than a division.
 *
 * The complement is what matters: after an identifier, a number, a closing `)` / `]`, a string
 * or a member access, `/` is division. `)` is deliberately in the DIVISION camp — `(a + b) / 2`
 * is common and `if (x) /re/.test(y)` is not — and the newline bound below is what keeps that
 * trade cheap when it is wrong.
 */
const REGEX_PREV_CHARS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);
const REGEX_PREV_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "case",
  "yield",
  "await",
]);

const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * Can a regex literal legally begin right after `code[0..end)`? Backward half of the decision,
 * separated so `stripComments` can ask it about the code it has EMITTED (comments removed) while
 * reading the character itself from the raw source.
 */
export function regexCanFollow(code: string, end: number): boolean {
  let i = end - 1;
  while (i >= 0 && /\s/.test(code[i] ?? "")) i--;
  if (i < 0) return true; // start of file: nothing to divide
  const ch = code[i] ?? "";
  if (REGEX_PREV_CHARS.has(ch)) return true;
  if (!WORD_CHAR.test(ch)) return false; // `)`, `]`, a quote, `.` → division / member access
  let j = i;
  while (j >= 0 && WORD_CHAR.test(code[j] ?? "")) j--;
  return REGEX_PREV_KEYWORDS.has(code.slice(j + 1, i + 1));
}

/** Does the `/` at `slash` open a regex literal (as opposed to a division operator)? */
export function startsRegexLiteral(code: string, slash: number): boolean {
  const next = code[slash + 1];
  // `//` and `/*` are comments, and the empty regex must be written `/(?:)/` — so neither
  // can be a literal. Checked here too so this is safe on source that still has comments.
  if (next === "/" || next === "*" || next === undefined) return false;
  return regexCanFollow(code, slash);
}

/**
 * Index one past the end of the regex literal opening at `slash` (flags included), or `null`
 * when it does not close before the end of the line.
 *
 * Refusing to cross a newline is the safety property: a real regex literal cannot span one, so
 * a wrong regex-vs-division call can never swallow more than the rest of its own line — which is
 * what made this cheap enough to fix. `[...]` is tracked because `/` inside a character class is
 * a literal slash, not the terminator.
 */
export function regexLiteralEnd(code: string, slash: number): number | null {
  let inClass = false;
  for (let i = slash + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\n") return null;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      while (j < code.length && /[a-z]/.test(code[j] ?? "")) j++;
      return j;
    }
  }
  return null;
}

function stepInString(src: string, state: StripState): void {
  const c = src[state.i] as string;
  const next = src[state.i + 1];
  state.out += c;
  if (c === "\\") {
    if (next !== undefined) state.out += next;
    state.i += 2;
    return;
  }
  if (c === state.inString) state.inString = null;
  state.i += 1;
}

function stepDefault(src: string, state: StripState): void {
  const c = src[state.i] as string;
  const next = src[state.i + 1];
  if (c === "/" && next === "*") {
    const end = src.indexOf("*/", state.i + 2);
    if (end === -1) {
      state.done = true;
      return;
    }
    const block = src.slice(state.i, end + 2);
    for (const ch of block) {
      if (ch === "\n") state.out += "\n";
    }
    state.i = end + 2;
    return;
  }
  if (c === "/" && next === "/") {
    const nl = src.indexOf("\n", state.i);
    if (nl === -1) {
      state.done = true;
      return;
    }
    state.i = nl;
    return;
  }
  // A regex literal is emitted VERBATIM and skipped past, so a quote inside it can no longer
  // open a phantom string and leave every later comment unstripped. `state.out` is the code
  // emitted so far, which is exactly the token context the regex-vs-division call needs.
  // The two comment forms are already handled above, so any `/` reaching here is either a
  // division or a regex. The backward look reads `state.out` — the code emitted so far, with
  // comments removed — because a comment sitting between the previous token and this `/` must
  // not change the answer.
  if (c === "/" && regexCanFollow(state.out, state.out.length)) {
    const end = regexLiteralEnd(src, state.i);
    if (end !== null) {
      state.out += src.slice(state.i, end);
      state.i = end;
      return;
    }
  }
  if (c === '"' || c === "'" || c === "`") {
    state.inString = c;
    state.out += c;
    state.i += 1;
    return;
  }
  state.out += c;
  state.i += 1;
}

/**
 * Remove comments from TypeScript source.
 *
 * Regex literals ARE recognised (`startsRegexLiteral` / `regexLiteralEnd`). They were not until
 * 2026-09-05: a quote inside one opened a phantom string and every comment after it survived
 * unstripped, which the previous note recorded as acceptable because the one affected connector
 * had a `test:connector-boot` backstop. `audit:windows-console` has no backstop — nothing else
 * detects an unhidden spawn — and 12 of 1986 `gateway/src` files derailed the scanner, including
 * `platform/linux.ts`, which contains two real violations the guard could not see. That is the
 * "next time someone is in this file with reason to" the old note anticipated.
 *
 * The `/`-as-regex vs `/`-as-division call is the standard backward-token heuristic, and the
 * safety property that makes it cheap is `regexLiteralEnd` refusing to cross a newline: a real
 * regex literal cannot span one, so a wrong call can never swallow more than the rest of its own
 * line. Verified over the tree: `gateway/src` went from 12 derailing files to 0.
 *
 * REMAINING LIMITATION — nested template substitutions. One file still derails the scanner,
 * `scripts/structure-audit/check-coverage-gate-pal.ts`, on the escaped-backtick-inside-a-nested-
 * `${}` shape around its line 344. That is a template-frame issue, unrelated to regex literals,
 * and no audit reads that file as input.
 *
 * If you need comment-stripping for a NEW guard, consider whether a line-based skip suffices —
 * `check-connector-consent.ts` uses one. Note the trade: line-based handles block comments and
 * misses TRAILING ones (`const x = 1; // marker`), which this function handles correctly.
 */
export function stripComments(src: string): string {
  const state: StripState = { i: 0, out: "", inString: null, done: false };
  while (!state.done && state.i < src.length) {
    if (state.inString) {
      stepInString(src, state);
    } else {
      stepDefault(src, state);
    }
  }
  return state.out;
}

/**
 * Replace every string / template literal body with spaces, preserving length — but KEEP the
 * contents of a template's `${...}` substitutions, which are code, not text.
 *
 * A single left-to-right scan rather than a regex, because the cases that matter are exactly the
 * ones a regex gets wrong: an escaped quote inside a literal must not end it early, and an
 * apostrophe inside a double-quoted string must not open one.
 *
 * Exported so a guard that needs to paren-match on code (e.g. "is this call nested inside that
 * one?") can compose it with `stripComments` and not have a stray `)` inside a string literal
 * throw its depth count off — the same reason `countAnyInSource` composes the two below.
 *
 * **Substitutions are preserved deliberately.** Blanking a `${...}` body along with the prose
 * around it made every guard built on this helper blind to real code: `${x as any}` is a real
 * `any` the ratchet must count, and — the reason this was fixed — a
 * `${createOpenAIEmbedder(...).embed(...)}` issues a real, UNLEDGERED outbound request no matter
 * what the template does with the stringified result, so D22(f)'s
 * `checkEmbeddingConstructorConfinement` could be walked past by moving one call inside backticks.
 * The nesting is arbitrary (a substitution may contain a template that contains a substitution),
 * so the scan carries an explicit context stack rather than a single `quote` variable. A
 * substitution's own string literals are still blanked, because inside it we are back in code.
 * Length is preserved throughout: callers index into the result to recover line numbers and to
 * paren-match, so every replacement is one char for one char.
 */
type StripFrame =
  /** Inside a plain '' / "" string: blank through to the closing quote. */
  | { readonly kind: "string"; readonly quote: string }
  /** Inside a template's TEXT: blank, until a `${` opens code or a backtick closes it. */
  | { readonly kind: "template" }
  /** Inside a `${...}`: ordinary code. `depth` tracks nested `{}` so the right `}` closes it. */
  | { kind: "subst"; depth: number };

export function stripStringLiterals(src: string): string {
  const out = src.split("");
  const stack: StripFrame[] = [];
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    const frame = stack[stack.length - 1];

    if (frame?.kind === "string") {
      if (ch === "\\") {
        // Blank the escape AND the character it escapes, so a closing quote is never faked.
        out[i] = " ";
        if (i + 1 < out.length) out[i + 1] = " ";
        i++;
      } else if (ch === frame.quote) {
        stack.pop();
      } else {
        out[i] = " ";
      }
      continue;
    }

    if (frame?.kind === "template") {
      if (ch === "\\") {
        out[i] = " ";
        if (i + 1 < out.length) out[i + 1] = " ";
        i++;
      } else if (ch === "$" && out[i + 1] === "{") {
        // Keep `${` verbatim and switch to code until its matching `}`.
        stack.push({ kind: "subst", depth: 0 });
        i++;
      } else if (ch === "`") {
        stack.pop();
      } else {
        out[i] = " ";
      }
      continue;
    }

    // Code — either top level or inside a substitution.
    if (ch === "/" && startsRegexLiteral(src, i)) {
      const end = regexLiteralEnd(src, i);
      if (end !== null) {
        // Blank the BODY, keep the delimiters and the length. A quote inside can no longer open
        // a phantom string, and a `spawn(` inside can no longer be read as a call.
        for (let k = i + 1; k < end - 1; k++) out[k] = " ";
        i = end - 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      stack.push({ kind: "string", quote: ch });
    } else if (ch === "`") {
      stack.push({ kind: "template" });
    } else if (frame?.kind === "subst") {
      if (ch === "{") {
        frame.depth++;
      } else if (ch === "}") {
        if (frame.depth === 0) stack.pop();
        else frame.depth--;
      }
    }
  }
  return out.join("");
}

/**
 * How many `any` TYPES the source uses.
 *
 * Comments were always stripped first; string literals now are too. Without that this counted
 * prose — an English stopword list containing "any", a user-facing message, a SQL fragment — and
 * each one demanded a baseline bump for debt that did not exist. A ratchet that fires on writing
 * the word is one people learn to satisfy by rewording, which is the opposite of its purpose.
 */
export function countAnyInSource(src: string): number {
  const stripped = stripStringLiterals(stripComments(src));
  const matches = stripped.match(/\bany\b/g);
  return matches ? matches.length : 0;
}

async function* iterateGlob(
  glob: Glob,
  seen: Set<string>,
): AsyncGenerator<{ path: string; relPath: string; contents: string }> {
  for await (const rawRelPath of glob.scan({ cwd: REPO_ROOT })) {
    const relPath = rawRelPath.replaceAll("\\", "/");
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    if (relPath.endsWith(".test.ts")) continue;
    if (relPath.endsWith("-sql.ts")) continue;
    if (relPath.endsWith(".d.ts")) continue;
    if (relPath.includes("/__fixtures__/")) continue;
    if (relPath.includes("/test/fixtures/")) continue;
    if (relPath.includes("/testing/")) continue;
    const path = join(REPO_ROOT, relPath);
    const contents = await Bun.file(path).text();
    yield { path, relPath, contents };
  }
}

export async function* iterateSourceFiles(): AsyncGenerator<{
  path: string;
  relPath: string;
  contents: string;
}> {
  const seen = new Set<string>();
  yield* iterateGlob(new Glob("packages/*/src/**/*.ts"), seen);
  yield* iterateGlob(new Glob("packages/mcp-connectors/*/src/**/*.ts"), seen);
}

export function auditOutputPath(name: string): string {
  return join(REPO_ROOT, "docs", "structure-audit", name);
}
