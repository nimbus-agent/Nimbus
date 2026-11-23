import {
  CLOSE,
  expressionEnd,
  IDENT,
  matchBackward,
  matchForward,
  OPEN,
  type Prepared,
  skipAngles,
  skipReturnTypeToBody,
  skipTypeToAssign,
  skipWs,
  skipWsBack,
  splitGroup,
  stringLiteralAt,
} from "./lexical.ts";

// ---------------------------------------------------------------------------------------------
// Structural index of one file: declarations, destructurings, functions, for-of loops, tables.
// ---------------------------------------------------------------------------------------------

export interface Binding {
  readonly key: string;
  readonly local: string;
}

export interface Declaration {
  readonly name: string;
  /** Offset of its `const` / `let` / `var` keyword. */
  readonly at: number;
  /** Offset of the declared name. */
  readonly nameAt: number;
  readonly isConst: boolean;
  readonly initStart: number;
  readonly initEnd: number;
}

export interface Destructuring {
  readonly bindings: readonly Binding[];
  readonly at: number;
  /** The pattern's `{`. */
  readonly open: number;
  readonly rhsStart: number;
  readonly rhsEnd: number;
}

export interface Param {
  readonly name: string | null;
  readonly pattern: readonly Binding[];
}

export interface FnInfo extends FnShape {
  readonly name: string | null;
  readonly exported: boolean;
  /** An anonymous function that is directly `return`ed. */
  readonly returned: boolean;
  readonly params: readonly Param[];
}

export interface ForOf {
  /** Offset of the `for` keyword. */
  readonly at: number;
  readonly ident: string | null;
  readonly pattern: readonly Binding[];
  /** The iterated table's name, or null for an inline array literal. */
  readonly iterable: string | null;
  /** The inline array literal's `[`, when `iterable` is null. */
  readonly inlineArray: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/** One binding of a static `import { imported as local } from "spec"`, or of an unaliased one. */
export interface NamedImport {
  readonly imported: string;
  readonly local: string;
  /** Offset of the local name. */
  readonly at: number;
  /** The module specifier when it is a plain string literal, else null. */
  readonly spec: string | null;
}

/** `[start, end)` spans of `import ... from` statements. */
export type ImportSpans = ReadonlyArray<readonly [number, number]>;

export interface FileIndex {
  readonly declarations: readonly Declaration[];
  readonly destructurings: readonly Destructuring[];
  readonly fns: readonly FnInfo[];
  readonly loops: readonly ForOf[];
  /** Every name the file binds, and where a use might see it: the binding census. */
  readonly bindings: readonly BindingSite[];
  readonly imports: ImportSpans;
  /** Every binding of those statements' `{ ... }` clauses. */
  readonly namedImports: readonly NamedImport[];
}

/** One element of an object pattern: `key`, `key: local`, either with a default. */
export const PATTERN_ELEMENT = new RegExp(
  String.raw`^\s*(${IDENT})\s*(?::\s*(${IDENT}))?\s*(?:=[\s\S]*)?$`,
);

export function parsePattern(s: string, open: number): Binding[] {
  const out: Binding[] = [];
  for (const [a, b] of splitGroup(s, open)) {
    const m = PATTERN_ELEMENT.exec(s.slice(a, b));
    if (m?.[1] !== undefined) out.push({ key: m[1], local: m[2] ?? m[1] });
  }
  return out;
}

/**
 * Whether every element of the object pattern at `open` is one {@link parsePattern} reads. A
 * computed key (`[k]: r`), a rest element (`...rest`) or a nested pattern binds a value the scan
 * cannot name.
 */
export function isSimplePattern(s: string, open: number): boolean {
  return splitGroup(s, open).every(([a, b]) => PATTERN_ELEMENT.test(s.slice(a, b)));
}

export function parseParams(s: string, open: number): Param[] {
  return splitGroup(s, open).map(([a, b]) => {
    let i = skipWs(s, a);
    const rest = s.slice(i, b);
    const mod = /^(?:\.\.\.|(?:readonly|public|private|protected)\s+)/.exec(rest);
    if (mod !== null) i = skipWs(s, i + mod[0].length);
    if (s.charAt(i) === "{") return { name: null, pattern: parsePattern(s, i) };
    const m = new RegExp(`^${IDENT}`).exec(s.slice(i, b));
    return { name: m?.[0] ?? null, pattern: [] };
  });
}

export function declarationsOf(s: string): Declaration[] {
  const out: Declaration[] = [];
  for (const m of s.matchAll(new RegExp(String.raw`\b(const|let|var)\s+(${IDENT})\s*`, "g"))) {
    const name = m[2];
    if (name === undefined) continue;
    const at = m.index ?? 0;
    let i = at + m[0].length;
    if (s.charAt(i) === ":") i = skipTypeToAssign(s, i + 1);
    if (i < 0 || s.charAt(i) !== "=" || "=>".includes(s.charAt(i + 1))) continue;
    out.push({
      name,
      at,
      nameAt: at + m[0].trimEnd().length - name.length,
      isConst: m[1] === "const",
      initStart: i + 1,
      initEnd: expressionEnd(s, i + 1),
    });
  }
  return out;
}

export function destructuringsOf(s: string): Destructuring[] {
  const out: Destructuring[] = [];
  for (const m of s.matchAll(/\b(?:const|let|var)\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchForward(s, open);
    if (close < 0) continue;
    let i = skipWs(s, close + 1);
    if (s.charAt(i) === ":") i = skipTypeToAssign(s, i + 1);
    if (i < 0 || s.charAt(i) !== "=") continue;
    const rhsStart = i + 1;
    out.push({
      bindings: parsePattern(s, open),
      at: m.index ?? 0,
      open,
      rhsStart,
      rhsEnd: expressionEnd(s, rhsStart),
    });
  }
  return out;
}

/** What a function's head says about it: the name it is bound to, and whether it is exported or returned. */
export type FnContext = Omit<FnInfo, "params" | "paramsAt" | "bodyStart" | "bodyEnd">;

/** What precedes a function head: the name it is bound to, and whether it is exported/returned. */
export function headContext(s: string, headStart: number): FnContext {
  const before = s.slice(Math.max(0, headStart - 200), headStart);
  const bound = new RegExp(
    String.raw`(\bexport\s+)?\b(?:const|let|var)\s+(${IDENT})\s*(?::[^=;]*)?=\s*(?:async\s+)?$`,
  ).exec(before);
  if (bound?.[2] !== undefined) {
    return { name: bound[2], exported: bound[1] !== undefined, returned: false };
  }
  return { name: null, exported: false, returned: /\breturn\s+(?:async\s+)?$/.test(before) };
}

/**
 * After `function name` (at `i`): the parameter list's `(` and the body's `{`, past any type
 * parameters and return type — or null when what follows is not a function with a body.
 */
export function functionHeadAt(
  s: string,
  i: number,
): { paramsOpen: number; bodyStart: number } | null {
  const paramsOpen = s.charAt(i) === "<" ? skipWs(s, skipAngles(s, i)) : i;
  if (paramsOpen < 0 || s.charAt(paramsOpen) !== "(") return null;
  const paramsClose = matchForward(s, paramsOpen);
  if (paramsClose < 0) return null;
  const j = skipWs(s, paramsClose + 1);
  const bodyStart = s.charAt(j) === ":" ? skipReturnTypeToBody(s, j + 1) : j;
  return bodyStart >= 0 && s.charAt(bodyStart) === "{" ? { paramsOpen, bodyStart } : null;
}

/** A declaration `function name` is bound to `name`, exported when `export` precedes it. */
export function namedFunctionContext(s: string, at: number, name: string): FnContext {
  const before = s.slice(Math.max(0, at - 40), at);
  return {
    name,
    exported: /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(before),
    returned: false,
  };
}

export function functionDeclarationsOf(s: string): FnInfo[] {
  const out: FnInfo[] = [];
  const re = new RegExp(String.raw`\bfunction\b\s*\*?\s*(${IDENT})?\s*`, "g");
  for (const m of s.matchAll(re)) {
    const at = m.index ?? 0;
    const head = functionHeadAt(s, at + m[0].length);
    if (head === null) continue;
    const ctx = m[1] === undefined ? headContext(s, at) : namedFunctionContext(s, at, m[1]);
    out.push({
      ...ctx,
      params: parseParams(s, head.paramsOpen),
      paramsAt: head.paramsOpen,
      bodyStart: head.bodyStart,
      bodyEnd: matchForward(s, head.bodyStart),
    });
  }
  return out;
}

/** End of a body starting at `b`: its matching `}` for a block, else the expression's end. */
export function blockOrExpressionEnd(s: string, b: number): number {
  return s.charAt(b) === "{" ? matchForward(s, b) : expressionEnd(s, b);
}

/** The `(` of an arrow's parameter list ending just before `arrow`, or -1. */
export function arrowParamsOpen(s: string, arrow: number): number {
  const k = skipWsBack(s, arrow - 1);
  if (s.charAt(k) === ")") return matchBackward(s, k);
  // `(...): ReturnType =>` — walk back over the return type to its `:`, then to the `)`. An object
  // or parenthesised part of the type (`): { name?: string } =>`) is stepped over whole.
  let m = k;
  while (m >= 0) {
    const c = s.charAt(m);
    if (c === "}" || c === ")") m = matchBackward(s, m) - 1;
    else if (/[\w$.<>[\]|&,\s]/.test(c)) m--;
    else break;
  }
  if (s.charAt(m) !== ":") return -1;
  const close = skipWsBack(s, m - 1);
  return s.charAt(close) === ")" ? matchBackward(s, close) : -1;
}

/** Where an arrow's head starts: the `<` of `<T>(...)` when it is generic, else its `(`. */
export function genericStart(s: string, open: number): number {
  const g = skipWsBack(s, open - 1);
  if (s.charAt(g) !== ">") return open;
  let depth = 0;
  for (let i = g; i >= 0; i--) {
    const c = s.charAt(i);
    if (c === ">") depth++;
    else if (c === "<" && --depth === 0) return i;
  }
  return open;
}

/**
 * The parameters and head start of the arrow function whose `=>` is at `arrow`, or null. Its
 * parameters start at `paramsAt`: the list's `(`, or the bare parameter of `x => ...`.
 */
export function arrowHead(
  s: string,
  arrow: number,
): { params: Param[]; headStart: number; paramsAt: number } | null {
  const open = arrowParamsOpen(s, arrow);
  if (open >= 0) {
    return { params: parseParams(s, open), headStart: genericStart(s, open), paramsAt: open };
  }
  const single = new RegExp(String.raw`(${IDENT})\s*$`).exec(
    s.slice(Math.max(0, arrow - 80), arrow),
  );
  if (single?.[1] === undefined) return null;
  const headStart = arrow - single[0].length;
  return { params: [{ name: single[1], pattern: [] }], headStart, paramsAt: headStart };
}

export function arrowFunctionsOf(s: string): FnInfo[] {
  const out: FnInfo[] = [];
  for (let arrow = s.indexOf("=>"); arrow >= 0; arrow = s.indexOf("=>", arrow + 2)) {
    const head = arrowHead(s, arrow);
    if (head === null) continue;
    const b = skipWs(s, arrow + 2);
    out.push({
      ...headContext(s, head.headStart),
      params: head.params,
      paramsAt: head.paramsAt,
      bodyStart: b,
      bodyEnd: blockOrExpressionEnd(s, b),
    });
  }
  return out;
}

/** A for-of binding starting at `i`: a destructuring pattern or one identifier, and its end. */
export function loopBinding(
  s: string,
  i: number,
  limit: number,
): { ident: string | null; pattern: Binding[]; end: number } | null {
  if (s.charAt(i) === "{")
    return { ident: null, pattern: parsePattern(s, i), end: matchForward(s, i) + 1 };
  const id = new RegExp(`^${IDENT}`).exec(s.slice(i, limit));
  return id === null ? null : { ident: id[0], pattern: [], end: i + id[0].length };
}

export function forOfLoopsOf(s: string): ForOf[] {
  const out: ForOf[] = [];
  for (const m of s.matchAll(/\bfor\s*\(/g)) {
    const headOpen = (m.index ?? 0) + m[0].length - 1;
    const headClose = matchForward(s, headOpen);
    const decl =
      headClose < 0 ? null : /^\s*(?:const|let|var)\s+/.exec(s.slice(headOpen + 1, headClose));
    if (decl === null) continue;
    const binding = loopBinding(s, headOpen + 1 + decl[0].length, headClose);
    if (binding === null) continue;
    const of = new RegExp(String.raw`^\s+of\s+(?:(${IDENT})\s*$|(\[))`).exec(
      s.slice(binding.end, headClose),
    );
    if (of === null) continue;
    const b = skipWs(s, headClose + 1);
    out.push({
      at: m.index ?? 0,
      ident: binding.ident,
      pattern: binding.pattern,
      iterable: of[1] ?? null,
      inlineArray: of[2] === undefined ? -1 : binding.end + of[0].length - 1,
      bodyStart: b,
      bodyEnd: blockOrExpressionEnd(s, b),
    });
  }
  return out;
}

export const NAMED_CLAUSE_LEAD = new RegExp(String.raw`^\s*(?:type\s+)?(?:${IDENT}\s*,\s*)?$`);

/** One element of a named-import clause: `name` or `name as local`, either one `type`-only. */
export const IMPORT_ELEMENT = new RegExp(
  String.raw`^\s*(?:type\s+)?(${IDENT})(?:\s+as\s+(${IDENT}))?\s*$`,
);

/**
 * The bindings of each `import { ... } from "spec"` statement among the `imports` spans. A span
 * that is really an expression — `import("m").then(({ a }) => Array.from(a))`, which runs on to a
 * later `from` — has something else before its first `{`, and binds nothing.
 */
export function namedImportsOf(p: Prepared, imports: ImportSpans): NamedImport[] {
  const s = p.blank;
  const out: NamedImport[] = [];
  for (const [start, end] of imports) {
    const open = s.indexOf("{", start);
    if (open < 0 || open >= end) continue;
    if (!NAMED_CLAUSE_LEAD.test(s.slice(start + "import".length, open))) continue;
    const spec = stringLiteralAt(p, skipWs(s, end))?.value ?? null;
    for (const [a, b] of splitGroup(s, open)) {
      const element = s.slice(a, b);
      const m = IMPORT_ELEMENT.exec(element);
      if (m?.[1] === undefined) continue;
      const local = m[2] ?? m[1];
      // The local name ends the element, so its offset is read back from the trimmed end.
      out.push({ imported: m[1], local, at: a + element.trimEnd().length - local.length, spec });
    }
  }
  return out;
}

/** Identifiers that START at bracket depth 0 of `s[start, end)`, with their offsets. */
export function topLevelWords(
  s: string,
  start: number,
  end: number,
): Array<{ at: number; word: string }> {
  const out: Array<{ at: number; word: string }> = [];
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && /[A-Za-z_$]/.test(c) && !/[\w$]/.test(s.charAt(i - 1))) {
      const word = new RegExp(`^${IDENT}`).exec(s.slice(i, end))?.[0] ?? "";
      out.push({ at: i, word });
      i += Math.max(0, word.length - 1);
    }
  }
  return out;
}

/** Functions whose body contains `offset`, innermost first. */
export function enclosingFns(ix: FileIndex, offset: number): FnInfo[] {
  return ix.fns
    .filter((f) => f.bodyStart <= offset && offset <= f.bodyEnd)
    .sort((a, b) => b.bodyStart - a.bodyStart);
}

export type Range = readonly [number, number];

/** A bound name, at the offset of its identifier. */
export interface Named {
  readonly name: string;
  readonly at: number;
}

/** One binding of a name, and where a use might see it. */
export interface BindingSite extends Named {
  /**
   * Never SMALLER than the region that sees the binding, so a use outside it does not: a
   * parameter's function, a `catch` binding's clause, a block-scoped loop variable's loop, and for
   * anything else the body of the innermost function around it, or the whole file.
   */
  readonly reach: Range;
}

/** Names bound together, all reaching over one range. */
export interface SiteGroup {
  readonly names: readonly Named[];
  readonly reach: Range;
}

/** A function-like whose parameters the census reads: a function, an arrow or a method. */
export interface FnShape {
  /** The parameter list's `(`, or the bare parameter of `x => ...`. */
  readonly paramsAt: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}
