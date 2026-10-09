import { stripComments, stripStringLiterals } from "../lib.ts";

/**
 * A verified `// lane-census: scope=<type>[,<type>] [service=<id>[,<id>]]` annotation (spec §5.3,
 * rulings R3/R4/R10). It tells the census which item type(s) — and optionally which writing
 * services — the metadata reads inside one STATEMENT are about, for the reads it cannot scope on
 * its own: a JS `meta["k"]` read whose rows come from a query in another function, or a SQL read
 * scoped only by `type = ?`.
 *
 * R4 (amended): the annotation's TYPES apply only to a read whose own SQL literal carries no type
 * predicate. A read the SQL already scopes keeps its SQL types; an annotation whose types do not
 * fully cover them is an error (`annotation contradicts the statement's SQL type scope (…)`), and
 * the read is matched against its own SQL types. `service=` still narrows an agreeing SQL-scoped
 * read. The span (R3, below) can be wider than one query, so without this an annotation sized for
 * one query would re-type every other query inside it.
 *
 * R3: the annotation covers the whole statement beginning on the next non-blank, non-comment line —
 * through its first top-level `;`, or, for a `function` declaration, through its closing `}`. A
 * `//` cannot sit on the line directly above a read that lives inside a multi-line SQL template
 * (it would be SQL text), which is why the span is a statement and not a single line.
 */
export type LaneAnnotation = {
  readonly file: string;
  /** The comment's own line (1-indexed). */
  readonly line: number;
  readonly types: readonly string[];
  readonly services: readonly string[] | null;
  /** First covered line (1-indexed). */
  readonly startLine: number;
  /** Last covered line, inclusive. */
  readonly endLine: number;
};

export type AnnotationError = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

/**
 * A line that IS an annotation candidate — a well-formed annotation or a malformed attempt at one:
 * its trimmed text starts with `//` then `lane-census:`. A mention inside a JSDoc block
 * (` * … // lane-census: …`), a string, or trailing a code line is prose, not an annotation.
 * Built fresh per call (this directory's shared-`g`-RegExp hazard).
 */
function markerRegex(): RegExp {
  return /^\s*\/\/\s*lane-census:/;
}

/** The one accepted form, as the whole line. */
function annotationRegex(): RegExp {
  return /^\s*\/\/\s*lane-census:\s*scope=([a-z0-9_]+(?:,[a-z0-9_]+)*)(?:\s+service=([a-z0-9_]+(?:,[a-z0-9_]+)*))?\s*$/;
}

/** A `function` declaration statement head (optionally exported / default / async). */
function functionHeadRegex(): RegExp {
  return /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/;
}

/**
 * A brace-terminated declaration head other than `function`: a class (optionally exported /
 * default / abstract / declared), an interface or an enum. None ends in `;`, so a `;` search would
 * bleed into the NEXT statement (Review Focus 2).
 */
function braceDeclarationHeadRegex(): RegExp {
  return /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const\s+)?(?:class|interface|enum)\b/;
}

/**
 * End offset of a brace-terminated declaration starting at `start`: the `}` matching the first
 * `{` of its head at bracket depth 0 — `(…)`, `[…]` and `<…>` (a generic constraint such as
 * `<T extends { a: string }>`) are skipped. `null` when no balanced body is found.
 */
function braceDeclarationEnd(code: string, start: number): number | null {
  let angle = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    else if (ch === "(" || ch === "[") {
      const end = matchingClose(code, i);
      if (end === null) return null;
      i = end;
    } else if (ch === "{") {
      const end = matchingClose(code, i);
      if (end === null) return null;
      if (angle === 0) return end;
      i = end;
    }
  }
  return null;
}

/**
 * A compound-statement head. R10: an annotation above one of these is an ERROR, not a span — a `;`
 * search would run past the block's `}` into the next statement, and `else`/`catch` chains make any
 * brace rule fragile.
 */
function compoundHeadRegex(): RegExp {
  return /^\s*(?:if|for|while|do|switch|try|else)\b/;
}

const FORM = "`// lane-census: scope=<type>[,<type>] [service=<id>[,<id>]]`";

/**
 * `contents` with comments removed and string/template bodies blanked, but with EVERY original
 * newline kept, so a line index into the result is a line index into the raw file.
 * `stripComments` already keeps one `\n` per original `\n`; `stripStringLiterals` does not — it
 * blanks a template body's newlines to spaces along with the rest of its text — so its output is
 * re-newlined against its (equal-length) input.
 */
function newlinePreservingCode(contents: string): string {
  const noComments = stripComments(contents);
  const blanked = stripStringLiterals(noComments);
  const out = blanked.split("");
  for (let i = 0; i < out.length; i++) {
    if (noComments[i] === "\n") out[i] = "\n";
  }
  return out.join("");
}

/** 0-based offset of the start of each line of `code`. */
function lineStarts(code: string): readonly number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-indexed line of `offset` in `code`. */
function lineOfOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Offset of the bracket closing the one at `open` (same kind), or `null` when unbalanced. */
function matchingClose(code: string, open: number): number | null {
  const openCh = code[open];
  const closeCh = openCh === "(" ? ")" : openCh === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** The last non-whitespace character before `offset`, and its offset (`-1` when none). */
function previousSignificant(code: string, offset: number): number {
  let k = offset - 1;
  while (k >= 0 && /\s/.test(code[k] ?? "")) k--;
  return k;
}

/**
 * Whether the `{` at `brace` (after a function's parameter list) opens a TYPE rather than the body:
 * an object return type (`): { a: T } {`), a generic argument (`Promise<{ a: T }>`), a union /
 * intersection member, or the result of a function type (`(): () => { a: T } {`).
 */
function bracePrecedesType(code: string, brace: number): boolean {
  const k = previousSignificant(code, brace);
  const ch = code[k];
  if (ch === ":" || ch === "|" || ch === "&" || ch === "<" || ch === "," || ch === "(") return true;
  return ch === ">" && code[k - 1] === "=";
}

/**
 * End offset of a `function` declaration starting at `start`: the `}` closing its body — the first
 * `{` after the parameter list's `)` that does not open a return TYPE — or an overload signature's
 * `;` reached first. `null` when no parameter list or body can be found.
 */
function functionEnd(code: string, start: number): number | null {
  const open = code.indexOf("(", start);
  if (open === -1) return null;
  const close = matchingClose(code, open);
  if (close === null) return null;
  for (let i = close + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === ";") return i;
    if (ch === "(" || ch === "[") {
      const end = matchingClose(code, i);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (ch !== "{") continue;
    const end = matchingClose(code, i);
    if (end === null) return null;
    if (!bracePrecedesType(code, i)) return end;
    i = end;
  }
  return null;
}

/**
 * A declaration head whose depth-0 commas do NOT end it: `const a = 1, b = 2;` and, more often, a
 * type annotation such as `const m: Map<string, number> = …;` (`<…>` is not tracked as a bracket,
 * since `<` is also the less-than operator).
 */
function declarationHeadRegex(): RegExp {
  return /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|type|import|using)\b/;
}

/**
 * End offset of an ordinary statement starting at `start`: its first `;` at bracket depth 0
 * (tracking `(){}[]`) — or, unless `head` is a declaration, its first depth-0 `,`, so an annotation
 * above an object-literal PROPERTY or a call ARGUMENT covers that one entry and not the later ones
 * (final review M-1). A closer that takes the depth below 0 means the statement ended without a
 * `;` at the end of its enclosing block — it ends at the last code before that closer. No `;` at
 * all = end of file.
 */
function plainStatementEnd(code: string, start: number, head: string): number {
  const commaEnds = !declarationHeadRegex().test(head);
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth < 0) return Math.max(start, previousSignificant(code, i));
    } else if (depth === 0 && (ch === ";" || (ch === "," && commaEnds))) return i;
  }
  return Math.max(start, previousSignificant(code, code.length));
}

/** Words that can sit before `(` at the start of a line without naming a method. */
const NOT_A_METHOD_NAME: ReadonlySet<string> = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "await",
  "yield",
  "typeof",
  "new",
  "delete",
  "void",
  "throw",
  "super",
  "this",
  "import",
  "with",
]);

/** Optional modifiers, a method name, an optional generic list, then `(`. */
function methodHeadRegex(): RegExp {
  return /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
}

/**
 * A class METHOD (or object-literal method shorthand) head (final review M-1): `methodHeadRegex`
 * AND the parameter list's `)` is followed by `{` (the body) or `:` (a return type). The second
 * half is what separates `async load(x) {` from a plain call statement `load(x);`, which the regex
 * alone also matches. Without this an annotation above a method was a plain statement, and
 * `plainStatementEnd` ran on to the end of the CLASS.
 */
function isMethodHead(code: string, start: number, head: string): boolean {
  const m = methodHeadRegex().exec(head);
  if (m === null || NOT_A_METHOD_NAME.has(m[1] ?? "")) return false;
  const open = start + m[0].length - 1;
  if (code[open] !== "(") return false;
  const close = matchingClose(code, open);
  if (close === null) return false;
  let k = close + 1;
  while (k < code.length && /\s/.test(code[k] ?? "")) k++;
  return code[k] === "{" || code[k] === ":";
}

/** End offset of the statement starting at `start` whose first line (code view) is `head`. */
function statementEnd(code: string, start: number, head: string): number {
  if (functionHeadRegex().test(head)) {
    return functionEnd(code, start) ?? plainStatementEnd(code, start, head);
  }
  if (braceDeclarationHeadRegex().test(head)) {
    return braceDeclarationEnd(code, start) ?? plainStatementEnd(code, start, head);
  }
  if (isMethodHead(code, start, head)) {
    return functionEnd(code, start) ?? plainStatementEnd(code, start, head);
  }
  return plainStatementEnd(code, start, head);
}

/**
 * Every lane-census annotation in `contents` (parsed from the RAW text — the comments are what is
 * being read) and every annotation error a file-local check can find: a malformed annotation, two
 * annotations on one statement, an annotation that covers nothing, and an annotation above a
 * compound statement (R10). Type/service validity needs the writer corpus and is checked by the
 * census, not here.
 */
export function extractAnnotations(
  file: string,
  contents: string,
): {
  readonly annotations: readonly LaneAnnotation[];
  readonly errors: readonly AnnotationError[];
} {
  const annotations: LaneAnnotation[] = [];
  const errors: AnnotationError[] = [];
  const lines = contents.split(/\r?\n/);
  let code: string | null = null;
  let starts: readonly number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (!markerRegex().test(raw)) continue;
    const m = annotationRegex().exec(raw);
    if (m === null) {
      errors.push({
        file,
        line: i + 1,
        message: `malformed lane-census annotation; expected ${FORM}`,
      });
      continue;
    }

    let j = i + 1;
    let doubled = false;
    while (j < lines.length) {
      const trimmed = (lines[j] ?? "").trim();
      if (trimmed !== "" && !trimmed.startsWith("//")) break;
      if (markerRegex().test(lines[j] ?? "")) doubled = true;
      j++;
    }
    if (doubled) {
      errors.push({ file, line: i + 1, message: "two lane-census annotations on one statement" });
      continue;
    }
    if (j >= lines.length) {
      errors.push({ file, line: i + 1, message: "annotation covers nothing" });
      continue;
    }

    if (code === null) {
      code = newlinePreservingCode(contents);
      starts = lineStarts(code);
    }
    const start = starts[j] ?? code.length;
    const head = code.slice(
      start,
      code.indexOf("\n", start) === -1 ? code.length : code.indexOf("\n", start),
    );
    if (compoundHeadRegex().test(head)) {
      errors.push({
        file,
        line: i + 1,
        message:
          "annotation sits above a compound statement; annotate the enclosing function or a statement inside the block",
      });
      continue;
    }
    const endOffset = statementEnd(code, start, head);

    annotations.push({
      file,
      line: i + 1,
      types: (m[1] ?? "").split(","),
      services: m[2] === undefined ? null : m[2].split(","),
      startLine: j + 1,
      endLine: Math.max(j + 1, lineOfOffset(starts, endOffset)),
    });
  }
  return { annotations, errors };
}
