import {
  stripComments,
  stripStringLiterals,
} from "../../../../../../scripts/structure-audit/lib.ts";
import type { PackageSource } from "./package-sources.ts";

// ---------------------------------------------------------------------------------------------
// Lexical helpers. Every one of them works on `blank`: comments removed and string/template text
// blanked to spaces (length-preserving against `code`, which keeps the string contents), so a
// bracket, keyword or identifier seen in `blank` is real code.
// ---------------------------------------------------------------------------------------------

export interface Prepared {
  readonly rel: string;
  readonly code: string;
  readonly blank: string;
  readonly lineStarts: readonly number[];
}

export const IDENT = String.raw`[A-Za-z_$][\w$]*`;
export const IDENT_RE = new RegExp(`^${IDENT}$`);
export const OPEN = "([{";
export const CLOSE = ")]}";

export function prepare(src: PackageSource): Prepared {
  const code = stripComments(src.text);
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charAt(i) === "\n") lineStarts.push(i + 1);
  return { rel: src.rel, code, blank: stripStringLiterals(code), lineStarts };
}

export function lineAt(p: Prepared, offset: number): number {
  let lo = 0;
  let hi = p.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((p.lineStarts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Index of the bracket closing the one at `open`, or -1. */
export function matchForward(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Index of the bracket opening the one at `close`, or -1. */
export function matchBackward(s: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = s.charAt(i);
    if (CLOSE.includes(c)) depth++;
    else if (OPEN.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Whether every bracket closes the kind it opened. False means the stripper lost its place. */
export function isBalanced(s: string): boolean {
  const stack: string[] = [];
  for (const c of s) {
    const open = OPEN.indexOf(c);
    if (open >= 0) stack.push(CLOSE.charAt(open));
    else if (CLOSE.includes(c) && stack.pop() !== c) return false;
  }
  return stack.length === 0;
}

export function skipWs(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s.charAt(j))) j++;
  return j;
}

export function skipWsBack(s: string, i: number): number {
  let j = i;
  while (j >= 0 && /\s/.test(s.charAt(j))) j--;
  return j;
}

/** Past a `<...>` starting at `i` (an `=>` inside does not close it). */
export function skipAngles(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s.charAt(j);
    if (c === "=" && s.charAt(j + 1) === ">") j++;
    else if (c === "<") depth++;
    else if (c === ">" && --depth === 0) return j + 1;
  }
  return -1;
}

/** End of the expression starting at `start`: the first `,` `;` or unmatched closer at depth 0. */
export function expressionEnd(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === "," || c === ";")) return i;
  }
  return s.length;
}

/** +1 for a bracket that opens inside a type (generics included), -1 for one that closes. */
export function typeDepthDelta(c: string): number {
  if (OPEN.includes(c) || c === "<") return 1;
  if (CLOSE.includes(c) || c === ">") return -1;
  return 0;
}

/** Past a type annotation (after its `:`), to the `=` it ends at; -1 when it is not followed by one. */
export function skipTypeToAssign(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s.startsWith("=>", j)) {
      j++;
      continue;
    }
    const c = s.charAt(j);
    depth += typeDepthDelta(c);
    if (depth < 0) return -1;
    if (depth === 0 && c === "=") return j;
    if (depth === 0 && c === ";") return -1;
  }
  return -1;
}

/** +1 for `(` `[` `<`, -1 for `)` `]` `>` — the brackets a return type nests through. */
export function parenAngleDelta(c: string): number {
  if ("([<".includes(c)) return 1;
  return ")]>".includes(c) ? -1 : 0;
}

/** An object TYPE literal can follow these; a `{` after anything else opens a function body. */
export const OBJECT_TYPE_LEADS = ":|&,";

/** The bracket closing the one at `open`, or the end of `s` when it never closes. */
export function closeOrEnd(s: string, open: number): number {
  const close = matchForward(s, open);
  return close < 0 ? s.length : close;
}

/** Past a return-type annotation (after its `:`), to the `{` that opens the body; -1 if none. */
export function skipReturnTypeToBody(s: string, i: number): number {
  let depth = 0;
  let prev = ":";
  let j = skipWs(s, i);
  while (j < s.length) {
    const c = s.charAt(j);
    if (c === "{" && depth === 0) {
      if (!OBJECT_TYPE_LEADS.includes(prev)) return j;
      j = closeOrEnd(s, j); // an object type: skip it whole
    } else if (s.startsWith("=>", j)) {
      j++;
    } else {
      depth += parenAngleDelta(c);
      if (depth === 0 && c === ";") return -1;
    }
    prev = s.charAt(j);
    j = skipWs(s, j + 1);
  }
  return -1;
}

/** Top-level comma-separated parts of the bracket group opening at `open`, as `[start, end)`. */
export function splitGroup(s: string, open: number): Array<[number, number]> {
  const close = matchForward(s, open);
  if (close < 0) return [];
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  if (s.slice(start, close).trim() !== "") parts.push([start, close]);
  return parts;
}

/** The string value of a quoted literal opening at `at` in `code`, or null (escapes are refused). */
export function stringLiteralAt(p: Prepared, at: number): { value: string; end: number } | null {
  const quote = p.code.charAt(at);
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const close = p.blank.indexOf(quote, at + 1);
  if (close < 0) return null;
  const value = p.code.slice(at + 1, close);
  if (value.includes("\\") || (quote === "`" && value.includes("${"))) return null;
  return { value, end: close + 1 };
}

/** Offset of the innermost bracket still open at `o`, or -1 at the top level. */
export function innermostOpener(s: string, o: number): number {
  let depth = 0;
  for (let i = o - 1; i >= 0; i--) {
    const c = s.charAt(i);
    if (CLOSE.includes(c)) depth++;
    else if (OPEN.includes(c) && depth-- === 0) return i;
  }
  return -1;
}
