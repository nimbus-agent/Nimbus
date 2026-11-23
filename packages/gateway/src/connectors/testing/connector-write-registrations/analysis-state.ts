import type { FileIndex, FnInfo } from "./file-index.ts";
import { type Prepared, skipAngles, skipWs } from "./lexical.ts";
import type { RegistrationTag } from "./package-sources.ts";

// ---------------------------------------------------------------------------------------------
// The analysis.
// ---------------------------------------------------------------------------------------------

export type RegistrarKind = "root" | "factory" | "forwarder" | "kit-alias";

export interface State {
  /** Registrar factories: the consent kit's root plus kit factories found from their returns. */
  readonly factories: Map<string, "root" | "factory">;
  /** Property keys registrars are handed off under, or typed as. */
  readonly keys: Set<string>;
  /** Per-file registrar names. */
  readonly locals: Map<string, Map<string, RegistrarKind>>;
  /** Registrars and forwarders declared `export`ed, so callable from any file. */
  readonly exported: Map<string, RegistrarKind>;
}

export interface File {
  readonly p: Prepared;
  readonly ix: FileIndex;
}

export interface CallSite {
  /** Offset of the callee name. */
  readonly at: number;
  /** Offset of the call's `(`. */
  readonly open: number;
}

/**
 * Text ending in the `function` keyword, a generator's `*` included: the name after it is being
 * declared, not called or read. The `*` takes its own leading whitespace so the two whitespace runs
 * cannot trade characters — `\s*\*?\s*` backtracks quadratically when the match fails.
 */
export const ENDS_IN_FUNCTION_KEYWORD = /\bfunction(?:\s*\*)?\s*$/;

/**
 * Calls of `name` (bare, or `.name` when `member`), including ones with explicit type arguments —
 * `f<T>(...)` is exactly the spelling a guard keyed on `f(` misses. A `function name(` declaration
 * is not a call.
 */
export function callsOf(s: string, name: string, member: boolean): CallSite[] {
  const out: CallSite[] = [];
  const lead = member ? String.raw`\.\s*` : String.raw`(?<![\w$.])`;
  for (const m of s.matchAll(new RegExp(String.raw`${lead}${escapeRe(name)}(?![\w$])`, "g"))) {
    const at = (m.index ?? 0) + m[0].length - name.length;
    let i = skipWs(s, at + name.length);
    if (s.charAt(i) === "<") i = skipWs(s, skipAngles(s, i));
    if (i < 0 || s.charAt(i) !== "(") continue;
    if (ENDS_IN_FUNCTION_KEYWORD.test(s.slice(Math.max(0, at - 20), at))) continue;
    out.push({ at, open: i });
  }
  return out;
}

export function escapeRe(s: string): string {
  return s.replace(/[$.*+?^{}()|[\]\\]/g, String.raw`\$&`);
}

/** A resolved string and the file it was written in. */
export interface Valued {
  readonly value: string;
  readonly origin: string;
}

/** Where a constant table lives: the file declaring it, and the offset of its `[`. */
export interface TableRef {
  readonly host: File;
  readonly open: number;
}

export type Resolution =
  | { readonly kind: "ids"; readonly ids: readonly Valued[]; readonly tag: RegistrationTag }
  | { readonly kind: "forward"; readonly fn: FnInfo }
  | { readonly kind: "unresolved"; readonly reason: string };

/** Why an identifier holds no value the scan can name. */
export const NO_CONSTANT = "resolves to no constant";

/** Why an identifier may not be the binding the scan would read: a second one is visible at the use. */
export const REBOUND = "is bound more than once where it is used";

/** What an identifier holds where it is used: its values, or why the scan cannot name them. */
export type IdentResolution =
  | { readonly values: readonly Valued[]; readonly tag: RegistrationTag }
  | { readonly reason: string };
