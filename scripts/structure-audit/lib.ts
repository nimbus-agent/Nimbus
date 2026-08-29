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
 * KNOWN LIMITATION — no regex-literal awareness. The scanner tracks `"`, `'` and `` ` `` but does
 * not recognise a regex literal, so a quote character INSIDE one opens a phantom string and every
 * comment after it survives unstripped. Verified minimal case:
 *
 * ```ts
 * const RE = /(["|]) /;
 * /** this whole comment survives stripComments *\/
 * ```
 *
 * Measured against the tree on 2026-08-23: of the 94 connector `src/server.ts` files, exactly ONE
 * desyncs — `snowflake`, on `/^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$/` — and it changes NO audit
 * verdict, because snowflake both guards on `import.meta.main` and exports `startConnector`. So
 * `check-connector-entrypoints` is correct today by luck, not by construction: a connector that
 * adds a quote-bearing regex AND has the guard-without-export shape would be silently passed.
 * `test:connector-boot` still catches the resulting dead connector, which is why this is recorded
 * rather than fixed.
 *
 * Fixing it means disambiguating `/`-as-regex from `/`-as-division (standard heuristic: a `/`
 * starts a regex unless the preceding token is an identifier, literal or closing bracket). That is
 * worth doing the next time someone is in this file with reason to; it was judged a poor trade to
 * hand-roll lexer heuristics into a helper three passing audits depend on, for a latent issue with
 * a backstop.
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
