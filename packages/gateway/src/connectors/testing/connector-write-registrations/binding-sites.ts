import {
  type BindingSite,
  type Declaration,
  type FileIndex,
  type FnShape,
  functionHeadAt,
  genericStart,
  type ImportSpans,
  type Named,
  type NamedImport,
  type Range,
  type SiteGroup,
} from "./file-index.ts";
import {
  CLOSE,
  closeOrEnd,
  IDENT,
  innermostOpener,
  matchForward,
  OPEN,
  type Prepared,
  skipAngles,
  skipWs,
  skipWsBack,
  splitGroup,
  stringLiteralAt,
  typeDepthDelta,
} from "./lexical.ts";

// ---------------------------------------------------------------------------------------------
// The binding census. An id is read through identifiers — a loop's table, a string constant, a
// loop variable, a kit option, a forwarded parameter — and each must be read through the ONE
// binding its use can see. Reading a same-named binding the use cannot see (a table another
// function declares), or one a nearer binding shadows (a constant a parameter redeclares), derives
// the wrong ids with no violation at all.
// ---------------------------------------------------------------------------------------------
export function within(o: number, [start, end]: Range): boolean {
  return start <= o && o <= end;
}

/** The identifier starting at `i`, or "" when none does. */
export function identAt(s: string, i: number): string {
  if (!/[A-Za-z_$]/.test(s.charAt(i))) return "";
  let j = i + 1;
  while (j < s.length && /[\w$]/.test(s.charAt(j))) j++;
  return s.slice(i, j);
}

/** Words that stand where a bound name would and bind nothing: `const enum`, `class extends`, `of`. */
export const NOT_A_BINDING: ReadonlySet<string> = new Set([
  "enum",
  "extends",
  "implements",
  "in",
  "of",
]);

/** The binding target at `i` — one identifier, or a destructuring pattern — its names and its end. */
export function bindingTarget(
  s: string,
  i: number,
): { readonly names: readonly Named[]; readonly end: number } | null {
  const c = s.charAt(i);
  if (c === "{" || c === "[") {
    const close = matchForward(s, i);
    return close < 0 ? null : { names: patternNames(s, i), end: close + 1 };
  }
  const name = identAt(s, i);
  if (name === "" || NOT_A_BINDING.has(name)) return null;
  return { names: [{ name, at: i }], end: i + name.length };
}

/** Every name the object or array pattern at `open` binds: nested, rest and defaulted elements too. */
export function patternNames(s: string, open: number): Named[] {
  const array = s.charAt(open) === "[";
  return splitGroup(s, open).flatMap(([a, b]) => {
    const target = array ? arrayElementTarget(s, a, b) : objectElementTarget(s, a, b);
    return target < 0 ? [] : (bindingTarget(s, target)?.names ?? []);
  });
}

/** Where an object-pattern element's target starts: past its `key:` (computed or quoted too), or the shorthand. */
export function objectElementTarget(s: string, a: number, b: number): number {
  const i = skipWs(s, a);
  if (s.startsWith("...", i)) return skipWs(s, i + 3);
  const colon = keyColon(s, i, b);
  return colon < 0 ? i : skipWs(s, colon + 1);
}

/** The `:` after an object-pattern element's key, or -1 for a shorthand, whose default `=` comes first. */
export function keyColon(s: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (depth === 0 && (c === ":" || c === "=")) return c === ":" ? i : -1;
  }
  return -1;
}

/** Where an array-pattern element's target starts, past a rest `...`; -1 for a hole. */
export function arrayElementTarget(s: string, a: number, b: number): number {
  const i = skipWs(s, a);
  if (i >= b) return -1;
  return s.startsWith("...", i) ? skipWs(s, i + 3) : i;
}

/** What a declaration binds — every declarator, initialised or not — read from just past its keyword. */
export function declaratorNames(s: string, from: number): Named[] {
  const out: Named[] = [];
  let target = bindingTarget(s, skipWs(s, from));
  while (target !== null) {
    out.push(...target.names);
    const comma = nextDeclarator(s, target.end);
    target = comma < 0 ? null : bindingTarget(s, skipWs(s, comma + 1));
  }
  return out;
}

/** After a declarator's binding target: the `,` before the next declarator, or -1 for the last. */
export function nextDeclarator(s: string, from: number): number {
  let j = skipWs(s, from);
  if (s.charAt(j) === "!") j = skipWs(s, j + 1); // a definite assignment, `let x!: T`
  if (s.charAt(j) === ":") j = typeAnnotationEnd(s, j + 1);
  if (s.charAt(j) === "=" && s.charAt(j + 1) !== "=" && s.charAt(j + 1) !== ">") {
    j = initializerEnd(s, j + 1);
  }
  return s.charAt(j) === "," ? j : -1;
}

/** Past a declarator's type (after its `:`): the `=` `,` or `;` ending it at depth 0, a stray closer, or -1. */
export function typeAnnotationEnd(s: string, from: number): number {
  let depth = 0;
  let j = from;
  while (j < s.length) {
    const c = s.charAt(j);
    if (s.startsWith("=>", j)) {
      j += 2;
    } else {
      depth += typeDepthDelta(c);
      if (depth < 0 || (depth === 0 && "=,;".includes(c))) return j;
      j++;
    }
  }
  return -1;
}

/** End of a declarator's initializer: its `,` or `;` at depth 0, or a stray closer. Type arguments are skipped. */
export function initializerEnd(s: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < s.length) {
    const c = s.charAt(i);
    const typeArgs = c === "<" ? typeArgumentsEnd(s, i) : -1;
    if (typeArgs > 0) {
      i = typeArgs;
    } else {
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) depth--;
      if (depth < 0 || (depth === 0 && (c === "," || c === ";"))) return i;
      i++;
    }
  }
  return s.length;
}

/**
 * Past the type arguments of a generic call (`f<A, B>(`) whose `<` is at `open`, or -1 for a
 * comparison. Type arguments hold no `=` but an arrow's and no `;`, and a `(` follows them.
 */
export function typeArgumentsEnd(s: string, open: number): number {
  const close = skipAngles(s, open);
  if (close < 0 || s.charAt(skipWs(s, close)) !== "(") return -1;
  return /[;=]/.test(s.slice(open, close).replaceAll("=>", "")) ? -1 : close;
}

/** A parameter's own leads: a decorator, a rest `...`, an accessibility or `readonly` modifier. */
export const PARAM_LEAD = /^(?:@[\w$.]+|\.\.\.|(?:readonly|public|private|protected|override)\s)/;

/** Where a parameter's binding target starts, past its decorators and modifiers. */
export function paramTarget(s: string, from: number): number {
  let i = skipWs(s, from);
  let lead = PARAM_LEAD.exec(s.slice(i, i + 40));
  while (lead !== null) {
    const decorator = lead[0].startsWith("@");
    i = skipWs(s, i + lead[0].length);
    if (decorator && s.charAt(i) === "(") i = skipWs(s, closeOrEnd(s, i) + 1);
    lead = PARAM_LEAD.exec(s.slice(i, i + 40));
  }
  return i;
}

/** What a parameter list binds: each parameter's name or pattern. */
export function paramNames(s: string, paramsAt: number): readonly Named[] {
  if (s.charAt(paramsAt) !== "(") return bindingTarget(s, paramsAt)?.names ?? [];
  return splitGroup(s, paramsAt).flatMap(([a]) => bindingTarget(s, paramTarget(s, a))?.names ?? []);
}

/** Words a `(` follows that make it something other than a method's parameter list. */
export const NOT_A_METHOD: ReadonlySet<string> = new Set([
  "await",
  "case",
  "catch",
  "delete",
  "do",
  "else",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "super",
  "switch",
  "throw",
  "typeof",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * Methods and accessors — `name(...) {`, `get name() {`, `[key](...) {`, generic or not — which the
 * function index leaves out: their parameters bind names like any other function's.
 */
export function methodsOf(s: string): FnShape[] {
  const out: FnShape[] = [];
  for (let open = s.indexOf("("); open >= 0; open = s.indexOf("(", open + 1)) {
    const head = followsMethodName(s, open) ? functionHeadAt(s, open) : null;
    // A signature ending a one-line type literal (`{ run(a: T): void }`) has no body: the `{` past
    // its closing `}` belongs to something else.
    if (head !== null && closesNothingBetween(s, open, head.bodyStart)) {
      out.push({
        paramsAt: open,
        bodyStart: head.bodyStart,
        bodyEnd: matchForward(s, head.bodyStart),
      });
    }
  }
  return out;
}

/** Whether no bracket closes between `from` and `to` that did not open there: the two are siblings. */
export function closesNothingBetween(s: string, from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (depth < 0) return false;
  }
  return true;
}

/** Whether the `(` at `open` follows a method's name: an identifier that is no keyword, or a computed or quoted key. */
export function followsMethodName(s: string, open: number): boolean {
  if (s.startsWith("=>", skipWsBack(s, open - 1) - 1)) return false; // an arrow's parenthesised body
  const k = skipWsBack(s, genericStart(s, open) - 1);
  const c = s.charAt(k);
  if (c === "]" || c === '"' || c === "'") return true;
  let start = k;
  while (start >= 0 && /[\w$]/.test(s.charAt(start))) start--;
  return start < k && !NOT_A_METHOD.has(s.slice(start + 1, k + 1));
}

/** A `for (...)` or `for await (...)` statement. */
export interface ForStatement {
  readonly at: number;
  readonly headOpen: number;
  readonly headClose: number;
  /** The `}` closing its body when that is a block, else -1. */
  readonly end: number;
}

export function forStatementsOf(s: string): ForStatement[] {
  const out: ForStatement[] = [];
  for (const m of s.matchAll(/(?<![\w$.])for(?:\s+await)?\s*\(/g)) {
    const at = m.index ?? 0;
    const headOpen = at + m[0].length - 1;
    const headClose = matchForward(s, headOpen);
    if (headClose < 0) continue;
    const body = skipWs(s, headClose + 1);
    out.push({ at, headOpen, headClose, end: s.charAt(body) === "{" ? matchForward(s, body) : -1 });
  }
  return out;
}

/** The keywords that open a declaration. `as const` is not one. */
export const DECLARATION_KEYWORD = /(?<![\w$.])(?:const|let|var|using)\b/g;

/** What every declaration binds, each reaching as far as `reachOf` says. */
export function declarationGroups(
  s: string,
  reachOf: (keyword: string, at: number) => Range,
): SiteGroup[] {
  const out: SiteGroup[] = [];
  for (const m of s.matchAll(DECLARATION_KEYWORD)) {
    const at = m.index ?? 0;
    if (/\bas\s+$/.test(s.slice(Math.max(0, at - 12), at))) continue;
    out.push({ names: declaratorNames(s, at + m[0].length), reach: reachOf(m[0], at) });
  }
  return out;
}

/** What every `catch (binding) { ... }` binds, reaching over its clause. */
export function catchGroups(s: string): SiteGroup[] {
  const out: SiteGroup[] = [];
  for (const m of s.matchAll(/(?<![\w$.])catch\s*\(/g)) {
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    const close = matchForward(s, open);
    const block = close < 0 ? -1 : skipWs(s, close + 1);
    if (s.charAt(block) === "{") {
      const names = bindingTarget(s, skipWs(s, open + 1))?.names ?? [];
      out.push({ names, reach: [at, matchForward(s, block)] });
    }
  }
  return out;
}

/** `import name from` and `import name, ...`: a default import. */
export const DEFAULT_IMPORT = new RegExp(
  String.raw`^import\s+(?:type\s+)?(${IDENT})\s*(?:,|from\b)`,
  "d",
);
/** `* as name` in an import clause: a namespace import. */
export const NAMESPACE_BINDING = new RegExp(String.raw`\*\s*as\s+(${IDENT})`, "d");
/** `import name = require(...)` and `import name = Some.Namespace`. */
export const IMPORT_EQUALS = new RegExp(
  String.raw`(?<![\w$.])import\s+(?:type\s+)?(${IDENT})\s*=(?!=)`,
  "dg",
);

/** What every import binds — named, default, namespace and `import name =` — reaching over the file. */
export function importGroup(
  s: string,
  namedImports: readonly NamedImport[],
  imports: ImportSpans,
): SiteGroup {
  const names: Named[] = namedImports.map((i) => ({ name: i.local, at: i.at }));
  const add = (m: RegExpExecArray | null, base: number): void => {
    const at = m?.indices?.[1]?.[0];
    if (m?.[1] !== undefined && at !== undefined) names.push({ name: m[1], at: base + at });
  };
  for (const [start, end] of imports) {
    const statement = s.slice(start, end);
    add(DEFAULT_IMPORT.exec(statement), start);
    add(NAMESPACE_BINDING.exec(statement), start);
  }
  for (const m of s.matchAll(IMPORT_EQUALS)) add(m, 0);
  return { names, reach: [0, s.length] };
}

/** `function name`, `class name`, `enum name`, `namespace name`: a declared name. */
export const DECLARED_NAME = new RegExp(
  String.raw`(?<![\w$.])(?:function\b(?:\s*\*)?|class\b|enum\b|namespace\b|module\b)\s*(${IDENT})`,
  "dg",
);

/** Every function, class, enum and namespace name, reaching over the function around it. */
export function declaredNameGroups(s: string, reachOf: (at: number) => Range): SiteGroup[] {
  return [...s.matchAll(DECLARED_NAME)].flatMap((m) => {
    const name = m[1] ?? "";
    const at = m.indices?.[1]?.[0];
    if (at === undefined || NOT_A_BINDING.has(name)) return [];
    return [{ names: [{ name, at }], reach: reachOf(at) }];
  });
}

/** One site per bound identifier; a second record of the same one widens its reach. */
export function mergeSites(groups: readonly SiteGroup[]): BindingSite[] {
  const sites = new Map<string, BindingSite>();
  for (const { names, reach } of groups) {
    for (const { name, at } of names) {
      const key = `${name}@${at}`;
      const had = sites.get(key)?.reach ?? reach;
      sites.set(key, { name, at, reach: [Math.min(had[0], reach[0]), Math.max(had[1], reach[1])] });
    }
  }
  return [...sites.values()];
}

/** Every name a file binds — the binding census, one {@link BindingSite} per bound identifier. */
export function bindingSitesOf(
  s: string,
  fns: readonly FnShape[],
  namedImports: readonly NamedImport[],
  imports: ImportSpans,
): BindingSite[] {
  const shapes = [...fns, ...methodsOf(s)];
  const fors = forStatementsOf(s);
  // The innermost function BLOCK body around `at`, or the whole file. Only a block can hold a
  // declaration, and only a block's extent is exact: an expression body is read to the next `,` or
  // `;`, which for the `=>` of a function TYPE (`): (x: T) => Promise<U> {`) runs on past the end
  // of the function into the next statement.
  const bodyReach = (at: number): Range => {
    let best: Range = [0, s.length];
    for (const g of shapes) {
      const holds = s.charAt(g.bodyStart) === "{" && g.bodyStart <= at && at <= g.bodyEnd;
      if (holds && g.bodyStart > best[0]) best = [g.bodyStart, g.bodyEnd];
    }
    return best;
  };
  // A block-scoped loop variable reaches over its loop; anything else over its function body.
  const declarationReach = (keyword: string, at: number): Range => {
    const loop =
      keyword === "var" ? undefined : fors.find((l) => l.headOpen < at && at < l.headClose);
    return loop === undefined || loop.end < 0 ? bodyReach(at) : [loop.at, loop.end];
  };
  return mergeSites([
    ...declarationGroups(s, declarationReach),
    ...shapes.map(
      (g): SiteGroup => ({ names: paramNames(s, g.paramsAt), reach: [g.paramsAt, g.bodyEnd] }),
    ),
    ...catchGroups(s),
    importGroup(s, namedImports, imports),
    ...declaredNameGroups(s, bodyReach),
  ]);
}

/** The bindings of `name` a use at `at` might see. */
export function bindingsSeenAt(ix: FileIndex, name: string, at: number): BindingSite[] {
  return ix.bindings.filter((b) => b.name === name && within(at, b.reach));
}

/** Where a binding the scan reads is written (`own`), and the function or loop it is bound for (`scope`). */
export interface ReadBinding {
  readonly own: Range;
  readonly scope: Range;
}

/**
 * Whether a use of `name` at `at` might see a binding that shadows the one the scan reads: one
 * written inside that binding's `scope` other than at its `own` site. A binding written OUTSIDE the
 * scope encloses it instead, and is the one shadowed.
 */
export function isShadowed(ix: FileIndex, name: string, at: number, read: ReadBinding): boolean {
  return bindingsSeenAt(ix, name, at).some(
    (b) => !within(b.at, read.own) && within(b.at, read.scope),
  );
}

/** Whether the declaration whose keyword is at `kw` is visible at `at`: it is top level, or its block holds `at`. */
export function blockHolds(s: string, kw: number, at: number): boolean {
  const open = innermostOpener(s, kw);
  return open < 0 || (s.charAt(open) === "{" && within(at, [open, matchForward(s, open)]));
}

/** What may follow a constant's literal: nothing, or `as const`. */
export const EXACT_LITERAL_TAIL = /^\s*(?:as\s+const\s*)?$/;

/** The string literal a `const` holds, exactly; else null. */
export function stringInitializer(p: Prepared, d: Declaration): string | null {
  const lit = d.isConst ? stringLiteralAt(p, skipWs(p.blank, d.initStart)) : null;
  return lit !== null && EXACT_LITERAL_TAIL.test(p.blank.slice(lit.end, d.initEnd))
    ? lit.value
    : null;
}

/** The `[` of the array literal a `const` holds, exactly; else -1. `[...].concat(more)` is not one. */
export function arrayInitializer(s: string, d: Declaration): number {
  const open = skipWs(s, d.initStart);
  const close = d.isConst && s.charAt(open) === "[" ? matchForward(s, open) : -1;
  return close >= 0 && EXACT_LITERAL_TAIL.test(s.slice(close + 1, d.initEnd)) ? open : -1;
}
