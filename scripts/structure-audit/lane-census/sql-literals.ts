import { stripComments } from "../lib.ts";

/**
 * A raw SQL string literal found in a source file, with `${…}` interpolation neutralised to the
 * placeholder identifier `__INTERP__` (template literals only — see below) and the 1-indexed line
 * its opening quote starts on.
 */
export type SqlLiteral = { readonly sql: string; readonly line: number };

/**
 * A literal counts as SQL when it contains `SELECT` and `FROM` (case-insensitive), in that order.
 * Narrow on purpose: a false positive here costs a spurious census row downstream, not a missed
 * lane, so precision is favored over recall.
 */
const SQL_SHAPE = /\bselect\b[\s\S]*\bfrom\b/i;

/** Every `${ … }` interpolation span, non-greedy on the inside so adjacent spans don't merge. */
const INTERP = /\$\{[^}]*\}/g;

/**
 * Scan `contents` for SQL string literals across all three JS/TS quoting styles — backtick
 * template literals, double-quoted, and single-quoted. A backtick-only scanner is a blind spot
 * shaped exactly like the bug class this whole gate exists to catch: plenty of production SQL is
 * plainly quoted (`agents/decisions.ts`'s `db.query("SELECT service, type FROM item WHERE id =
 * ?")"`, `agents/expert.ts`'s quoted `graph_entity` read).
 *
 * Comments are stripped first (via `stripComments`, which preserves one `\n` per original `\n` so
 * line numbers stay correct) so a SQL-shaped string sitting inside a comment is never matched.
 */
export function extractSqlLiterals(contents: string): readonly SqlLiteral[] {
  const src = stripComments(contents);
  const out: SqlLiteral[] = [];

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "`") {
      const end = findTemplateEnd(src, i);
      if (end === -1) break;
      const raw = src.slice(i + 1, end);
      if (SQL_SHAPE.test(raw)) {
        out.push({ sql: raw.replace(INTERP, "__INTERP__"), line: lineAt(src, i) });
      }
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findQuotedEnd(src, i);
      // A quote char that never closes on this line is treated as ordinary content rather than
      // an unterminated literal that swallows the rest of the file — single/double-quoted JS
      // strings cannot legitimately span a raw newline, so this is almost always a stray
      // apostrophe our char-level scanner has no business treating as a string opener.
      if (end === -1) continue;
      const raw = src.slice(i + 1, end);
      // Single- and double-quoted literals cannot contain `${…}` (that syntax only means
      // something inside backticks), so they skip the interpolation-neutralising pass entirely.
      if (SQL_SHAPE.test(raw)) {
        out.push({ sql: raw, line: lineAt(src, i) });
      }
      i = end;
    }
  }

  return out;
}

/**
 * Find the index of the backtick that closes the template literal opened at `start`. Skips `\\`
 * escapes and tracks `${ … }` nesting depth via brace count, so a backtick or a `}` that occurs
 * *inside* an interpolation never ends the outer literal early. Returns `-1` if the literal never
 * closes before EOF.
 */
function findTemplateEnd(src: string, start: number): number {
  let i = start + 1;
  let interpDepth = 0; // 0 = scanning template text; >0 = inside `${ … }`, counting nested braces
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (interpDepth === 0) {
      if (ch === "`") return i;
      if (ch === "$" && src[i + 1] === "{") {
        interpDepth = 1;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Inside `${ … }`: a backtick here is just code (possibly a nested template) and must not
    // close the outer literal; only brace balance decides when the interpolation ends.
    if (ch === "{") interpDepth++;
    else if (ch === "}") interpDepth--;
    i++;
  }
  return -1;
}

/**
 * Find the index of the quote that closes the single-/double-quoted string opened at `start`.
 * Skips `\\` escapes. Returns `-1` on an unescaped newline or EOF before the string closes.
 */
function findQuotedEnd(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    if (ch === "\n") return -1;
    i++;
  }
  return -1;
}

/** 1-indexed line number of `index`, counted as newlines seen before it, plus one. */
function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}
