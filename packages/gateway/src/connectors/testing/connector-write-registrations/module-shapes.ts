import { codeUnitCompare } from "../../../util/code-unit-compare.ts";
import { ENDS_IN_FUNCTION_KEYWORD, escapeRe, type File, type State } from "./analysis-state.ts";
import {
  IDENT,
  innermostOpener,
  matchForward,
  type Prepared,
  skipWs,
  skipWsBack,
  splitGroup,
  stringLiteralAt,
} from "./lexical.ts";

/** What introduces a declared name: `function` (generators too) or `const` / `let` / `var`. */
export const DECLARATION_LEAD = String.raw`\b(?:function\s*\*?\s*|(?:const|let|var)\s+)`;

/** `export default function NAME`, async and generator forms included. */
export const DEFAULT_EXPORTED_FUNCTION = new RegExp(
  String.raw`\bexport\s+default\s+(?:async\s+)?function\s*\*?\s*(${IDENT})`,
  "g",
);

/** `import * as ns from ` (after an optional default binding), up to the specifier's quote. */
export const NAMESPACE_IMPORT = new RegExp(
  String.raw`\bimport\s+(?:${IDENT}\s*,\s*)?\*\s*as\s+(${IDENT})\s+from\s*`,
  "g",
);

/** `export * as ns from `, up to the specifier's quote. */
export const NAMESPACE_REEXPORT = new RegExp(
  String.raw`\bexport\s+\*\s*as\s+(${IDENT})\s+from\s*`,
  "g",
);

/** A runtime module load: `import(...)` or `require(...)`, never a member `.import(`. */
export const DYNAMIC_IMPORT = /(?<![\w$.])(import|require)\s*\(/g;

/** The members a PROMISE has; anything else read off an unawaited `import(...)` is a type. */
export const PROMISE_METHODS: ReadonlySet<string> = new Set(["then", "catch", "finally"]);

export interface DynamicImport {
  /** Offset of `import` / `require`. */
  readonly at: number;
  /** Offset of the call's `)`. */
  readonly close: number;
  readonly callee: string;
  /** The first argument when it is a plain string literal, else null. */
  readonly spec: string | null;
}

/** Every runtime `import(...)` / `require(...)` in `p`, never a type (`let x: import("m").T`). */
export function dynamicImportsOf(p: Prepared): DynamicImport[] {
  const s = p.blank;
  const out: DynamicImport[] = [];
  for (const m of s.matchAll(DYNAMIC_IMPORT)) {
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    const close = matchForward(s, open);
    const callee = m[1] ?? "";
    if (close < 0 || (callee === "import" && isTypeImport(s, at, close))) continue;
    out.push({ at, close, callee, spec: firstStringArgument(p, open) });
  }
  return out;
}

/** The first argument of the call opening at `open`, when it is a plain string literal. */
export function firstStringArgument(p: Prepared, open: number): string | null {
  const first = splitGroup(p.blank, open)[0];
  if (first === undefined) return null;
  const lit = stringLiteralAt(p, skipWs(p.blank, first[0]));
  return lit !== null && p.blank.slice(lit.end, first[1]).trim() === "" ? lit.value : null;
}

/**
 * `typeof import("m")`, or `import("m").T` read without an `await`: a TYPE, which loads nothing. A
 * runtime import is awaited, or chained with a promise method.
 */
export function isTypeImport(s: string, at: number, close: number): boolean {
  if (isTypeofOperand(s, at)) return true;
  if (/\bawait(?:\s*\()?\s*$/.test(s.slice(Math.max(0, at - 20), at))) return false;
  const member = new RegExp(String.raw`^\s*\??\.\s*(${IDENT})`).exec(
    s.slice(close + 1, close + 80),
  );
  return member?.[1] !== undefined && !PROMISE_METHODS.has(member[1]);
}

/**
 * The span of the value a dynamic import produces — the call, with the `await` before it and one
 * pair of grouping parentheses around both — and whether that value is the MODULE OBJECT (awaited,
 * or a `require`) rather than a promise of it.
 */
export function dynamicImportValue(
  s: string,
  d: DynamicImport,
): { readonly start: number; readonly end: number; readonly module: boolean } {
  const awaited = /\bawait\s*$/.exec(s.slice(Math.max(0, d.at - 20), d.at));
  const start = awaited === null ? d.at : d.at - awaited[0].length;
  const end = d.close + 1;
  const module = awaited !== null || d.callee === "require";
  const open = skipWsBack(s, start - 1);
  const close = skipWs(s, end);
  if (s.charAt(open) === "(" && s.charAt(close) === ")" && isGroupingParen(s, open)) {
    return { start: open, end: close + 1, module };
  }
  return { start, end, module };
}

/** Whether the `(` at `open` groups an expression, rather than opening a call's arguments. */
export function isGroupingParen(s: string, open: number): boolean {
  return !/[\w$)\]]/.test(s.charAt(skipWsBack(s, open - 1)));
}

/** Whether `[start, end)` is a whole expression statement, its value discarded (`void` allowed). */
export function isDiscarded(s: string, start: number, end: number): boolean {
  const lead = /\bvoid\s*$/.exec(s.slice(Math.max(0, start - 10), start));
  const prev = s.charAt(skipWsBack(s, start - (lead?.[0].length ?? 0) - 1));
  const next = s.charAt(skipWs(s, end));
  return (prev === "" || "{};".includes(prev)) && (next === "" || "};".includes(next));
}

/** Whether a `.member` (or `?.member`) read follows offset `end`. */
export function isMemberRead(s: string, end: number): boolean {
  return /^\s*\??\.\s*[A-Za-z_$]/.test(s.slice(end, end + 40));
}

/** Whether the word at `o` is the operand of `typeof`. */
export function isTypeofOperand(s: string, o: number): boolean {
  return /\btypeof\s+$/.test(s.slice(Math.max(0, o - 20), o));
}

/** Whether the declaration starting at `at` (its `const`, `let` or `var`) is `export`ed. */
export function isExportedAt(s: string, at: number): boolean {
  return /\bexport\s+$/.test(s.slice(Math.max(0, at - 20), at));
}

/** Whether a string literal of exactly `len` characters opens at `o` — real quotes in `blank`. */
export function isWholeStringLiteral(p: Prepared, o: number, len: number): boolean {
  const quote = p.code.charAt(o);
  return (
    p.blank.charAt(o) === quote &&
    p.blank.charAt(o + len + 1) === quote &&
    p.blank.slice(o + 1, o + 1 + len).trim() === ""
  );
}

/**
 * Whether the kit-function name at `o` is a use the scan reads: a call (bare, or as a member), its
 * declaration, a `typeof`, or a plain import of it — never an aliased one (`import { kit as k }`).
 */
export function isKitUse(f: File, o: number, name: string): boolean {
  const s = f.p.blank;
  const before = s.slice(Math.max(0, o - 20), o);
  const after = s.slice(o + name.length, o + name.length + 40);
  if (/^\s*[<(]/.test(after)) return true;
  if (/\.\s*$/.test(before)) return false;
  if (new RegExp(`${DECLARATION_LEAD}$`).test(before) || isTypeofOperand(s, o)) return true;
  return f.ix.imports.some(([x, y]) => x <= o && o < y) && !/^\s+as\b/.test(after);
}

/** Whether `g` names `name` anywhere but a declaration of it or an import binding it. */
export function namedOutsideDeclaration(g: File, name: string): boolean {
  const s = g.p.blank;
  const lead = new RegExp(`${DECLARATION_LEAD}$`);
  for (const m of s.matchAll(new RegExp(String.raw`(?<![\w$])${escapeRe(name)}(?![\w$])`, "g"))) {
    const o = m.index ?? 0;
    if (lead.test(s.slice(Math.max(0, o - 20), o))) continue;
    if (g.ix.imports.some(([x, y]) => x <= o && o < y)) continue;
    return true;
  }
  return false;
}

/** `{ key: <o>...` — the value of an object-literal property. */
export function isKeyedValue(s: string, o: number): boolean {
  const before = s.slice(Math.max(0, o - 60), o);
  const opener = innermostOpener(s, o);
  return s.charAt(opener) === "{" && /(?<![\w$.?])[A-Za-z_$][\w$]*\s*:\s*$/.test(before);
}

/**
 * The positions where a registrar name is either a registration or a flow the scan follows: a
 * call; a declaration; a `typeof`; a shorthand or key inside `{...}` (an object literal handing it
 * off, a destructuring pattern taking it, or a type member declaring it); the value of a keyed
 * property (a hand-off under another key); or a TYPED parameter. A bare positional argument
 * (`f(registerWriteTool)`), an array element, and an `export { ... }` clause are NOT tracked — the
 * flow could go anywhere, so each is a violation instead.
 */
export function isTrackedUse(s: string, o: number, len: number): boolean {
  const before = s.slice(Math.max(0, o - 40), o);
  const after = s.slice(o + len, o + len + 40);
  if (/^\s*[<(]/.test(after)) return true;
  if (/\b(?:const|let|var)\s+$/.test(before) || ENDS_IN_FUNCTION_KEYWORD.test(before)) return true;
  if (/\btypeof\s+$/.test(before)) return true;
  const at = innermostOpener(s, o);
  const opener = s.charAt(at);
  const typedOrKey = /^\s*(?:\?\s*)?:/.test(after);
  if (opener === "{") {
    if (/\bexport\s*(?:type\s*)?$/.test(s.slice(Math.max(0, at - 20), at))) return false;
    const memberLead = /(?:[{,;]|\breadonly)\s*$/.test(before);
    if (memberLead && (typedOrKey || /^\s*[,}]/.test(after))) return true;
    return /:\s*$/.test(before) && /^\s*[,}]/.test(after);
  }
  return opener === "(" && /(?:[(,]|\breadonly)\s*$/.test(before) && typedOrKey;
}

/** `names` in code-unit order (the default `sort()` order, locale-independent), joined. */
export function sortedJoin(names: Iterable<string>, separator: string): string {
  return [...names].sort(codeUnitCompare).join(separator);
}

/** Snapshot of everything discovery can grow, to detect the fixpoint. */
export function fingerprint(state: State): string {
  const locals = [...state.locals].map(([f, m]) => `${f}=${sortedJoin(m.keys(), ",")}`);
  return [
    sortedJoin(state.factories.keys(), ","),
    sortedJoin(state.keys, ","),
    sortedJoin(state.exported.keys(), ","),
    sortedJoin(locals, ";"),
  ].join("|");
}
