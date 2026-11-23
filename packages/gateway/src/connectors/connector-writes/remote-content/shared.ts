// packages/gateway/src/connectors/connector-writes/remote-content/shared.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import type { MarkupToken } from "../markup-tokens.ts";
import { foldAndStrip, settle, settleUrl } from "../text-normalise.ts";

// ---------------------------------------------------------------------------------------------
// R2: what "external" means.
// ---------------------------------------------------------------------------------------------

const SCHEME = /^[a-z][a-z0-9+.-]*:/;
/** A character reference the gateway's six-name decoder left unresolved (`;` required). */
export const UNRESOLVED_REFERENCE = /&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/;

/** The RAW form: lower-cased, TAB/LF/CR deleted anywhere, leading and trailing C0 and space trimmed. */
export function rawUrlForm(value: string): string {
  let out = "";
  for (const ch of value.toLowerCase()) {
    if (ch !== "\t" && ch !== "\n" && ch !== "\r") out += ch;
  }
  let lo = 0;
  let hi = out.length;
  while (lo < hi && (out.codePointAt(lo) ?? 0) <= 0x20) lo++;
  while (hi > lo && (out.codePointAt(hi - 1) ?? 0) <= 0x20) hi--;
  return out.slice(lo, hi);
}

export function isSlash(ch: string | undefined): boolean {
  return ch === "/" || ch === "\\";
}

/** R2 (a) and (b) on one form: protocol-relative, or any scheme but an allowed `cid:`. */
function formIsExternal(form: string, allowCid: boolean): boolean {
  if (isSlash(form[0]) && isSlash(form[1])) return true;
  if (!SCHEME.test(form)) return false;
  return !(allowCid && form.startsWith("cid:"));
}

/**
 * R2: whether a URL-bearing value is external. Checked in the RAW form and in the SETTLED form
 * (`settleUrl`; a value that does not settle is external), either deciding "external" refuses:
 * protocol-relative (`//`, `\\`, `/\`, `\/`), any scheme (`cid:` excepted when `allowCid`), or a
 * settled form still holding a character reference the decoder does not resolve (`&sol;`, which
 * a browser reads as `/`). Not external: `""`, `#...` and every other relative reference. The
 * service's own host is NOT exempted (the tenant is not known here; stated).
 */
export function urlIsExternal(value: string, opts: { readonly allowCid: boolean }): boolean {
  if (formIsExternal(rawUrlForm(value), opts.allowCid)) return true;
  const settled = settleUrl(value);
  if (settled === undefined) return true;
  return formIsExternal(settled, opts.allowCid) || UNRESOLVED_REFERENCE.test(settled);
}

// ---------------------------------------------------------------------------------------------
// Name forms (R4 step 2): lower-cased, folded, and the local part after the last `:` of each.
// ---------------------------------------------------------------------------------------------

export function localPart(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

interface NameFormSet {
  /** Lower-cased, folded, and the local part of each. */
  readonly all: readonly string[];
  /** The local parts only. */
  readonly local: readonly string[];
}

/**
 * The forms of each name, computed once per name per `remoteContentIn` call (adversarial review:
 * a name is compared many times). Cleared when the call returns, so nothing outlives a scan.
 */
export const nameFormCache = new Map<string, NameFormSet>();

function formsOf(name: string): NameFormSet {
  const cached = nameFormCache.get(name);
  if (cached !== undefined) return cached;
  const lower = name.toLowerCase();
  const folded = foldAndStrip(name).toLowerCase();
  const local = [localPart(lower), localPart(folded)];
  const forms: NameFormSet = { all: [lower, folded, ...local], local };
  nameFormCache.set(name, forms);
  return forms;
}

/** The local parts of a name: of its lower-cased form and of its folded lower-cased form. */
export function localForms(name: string): readonly string[] {
  return formsOf(name).local;
}

/** Every form a name is compared in (lower-cased, folded, and the local part of each). */
function nameForms(name: string): readonly string[] {
  return formsOf(name).all;
}

export function nameIn(name: string, set: ReadonlySet<string>): boolean {
  return nameForms(name).some((f) => set.has(f));
}

/** A value's settled forms (deleted and spaced invisible), trimmed; `undefined` if unsettled. */
function settledForms(value: string): readonly string[] | undefined {
  const deleted = settle(value, "");
  const spaced = settle(value, " ");
  if (deleted === undefined || spaced === undefined) return undefined;
  return [deleted.trim(), spaced.trim()];
}

/** The text of one value in every form it is compared in: raw lower-trimmed and settled. */
export function valueForms(value: string): readonly string[] | undefined {
  const settled = settledForms(value);
  return settled === undefined ? undefined : [value.toLowerCase().trim(), ...settled];
}

export type StartToken = Extract<MarkupToken, { kind: "start" }>;

export const STYLE: ReadonlySet<string> = new Set(["style"]);

export function localIn(name: string, set: ReadonlySet<string>): boolean {
  return localForms(name).some((l) => set.has(l));
}

export function isAsciiLetterCode(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
