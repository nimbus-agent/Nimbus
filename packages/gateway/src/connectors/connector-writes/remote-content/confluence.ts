// packages/gateway/src/connectors/connector-writes/remote-content/confluence.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import { type MarkupToken, tokenizeMarkup } from "../markup-tokens.ts";
import { settleUrl } from "../text-normalise.ts";
import { type MarkupRules, refusesMarkupInDeclarations } from "./elements.ts";
import { type DetectOptions, refusesTags, tripwire } from "./html.ts";
import { refusesCss } from "./raw-text.ts";
import {
  isSlash,
  localForms,
  localIn,
  rawUrlForm,
  type StartToken,
  UNRESOLVED_REFERENCE,
  valueForms,
} from "./shared.ts";
import { refusesPresentationUrls, refusesSvgElements } from "./svg.ts";

// ---------------------------------------------------------------------------------------------
// R5: Confluence storage, in addition to R4 (storage is XML that Confluence renders as HTML).
// ---------------------------------------------------------------------------------------------

/**
 * The macros the model may write (owner ruling OR-B3r-1: a fail-closed ALLOWLIST). Every other
 * macro (`iframe`, `widget`, `html`, `html-include`, `rss`, `gadget`, `roadmap`, any marketplace
 * macro) and a macro without `ac:name` is refused.
 */
export const CONFLUENCE_INERT_MACROS: ReadonlySet<string> = new Set([
  "info",
  "note",
  "tip",
  "warning",
  "panel",
  "code",
  "noformat",
  "expand",
  "toc",
  "status",
  "anchor",
  "excerpt",
  "excerpt-include",
  "include",
  "details",
  "children",
  "pagetree",
  "jira",
]);

/**
 * The `jira` macro's URL-bearing parameters, refused when non-empty whatever the value (owner
 * ruling OR-B3r-1): `url` is the Jira XML or RSS issue-navigator URL Confluence itself fetches,
 * and `baseurl` the base it builds issue links from. Confirmed against Atlassian's Jira Issues
 * macro reference (https://confluence.atlassian.com/doc/jira-issues-macro-139380.html, retrieved
 * 2026-11-05: its parameters are `anonymous`, `baseurl`, `columns`, `count`, `cache`, `height`,
 * `renderMode`, `title`, `url` and `width`, and only `url` and `baseurl` take a URL). `server-url`
 * is kept as well (fail closed). `server` / `serverId` name a configured application link, which
 * is why the macro is allowed (stated bound: it shows issues only from a Jira the tenant admin
 * linked); every other parameter falls under the external-URL rule.
 */
const JIRA_URL_PARAMETERS: ReadonlySet<string> = new Set(["url", "baseurl", "server-url"]);

const MACRO_ELEMENTS: ReadonlySet<string> = new Set(["structured-macro", "macro"]);
/**
 * A parameter element: any whose local name ENDS in `parameter` (`ac:parameter`, and
 * `ac:default-parameter`, the macro's unnamed default; adversarial review).
 */
function isParameterElement(name: string): boolean {
  return localForms(name).some((l) => l.endsWith("parameter"));
}

/**
 * A default parameter: an element whose local name ends in `parameter` but is not `parameter`
 * itself, or a parameter with no name or an empty one (the macro's unnamed default).
 */
function isDefaultParameter(t: StartToken, names: readonly string[]): boolean {
  const own = localForms(t.name).some((l) => l !== "parameter" && l.endsWith("parameter"));
  return own || names.length === 0 || names.includes("");
}
const PLAIN_TEXT_BODY: ReadonlySet<string> = new Set(["plain-text-body"]);
const NAME_ATTRIBUTE: ReadonlySet<string> = new Set(["name"]);
const CODE_MACROS: ReadonlySet<string> = new Set(["code", "noformat"]);
/** Deeper CDATA nesting than this is refused. */
const CDATA_MAX_DEPTH = 2;

/**
 * The names a macro or parameter element gives itself: every attribute whose local name is
 * `name` (`ac:name`; duplicates kept), in every form. `undefined` when a value does not settle.
 */
function elementNames(t: StartToken): readonly string[] | undefined {
  const out: string[] = [];
  for (const a of t.attrs) {
    if (!localIn(a.name, NAME_ATTRIBUTE)) continue;
    const forms = valueForms(a.value);
    if (forms === undefined) return undefined;
    out.push(...forms);
  }
  return out;
}

/** A macro's names when every form of every `ac:name` is an inert macro; else `undefined`. */
function inertMacroNames(t: StartToken): readonly string[] | undefined {
  const names = elementNames(t);
  if (names === undefined || names.length === 0) return undefined;
  return names.every((n) => CONFLUENCE_INERT_MACROS.has(n)) ? names : undefined;
}

/** The macro names on the stack at each token (innermost last), for a forward walk. */
interface MacroWalk {
  readonly stack: (readonly string[])[];
}

/** Push or pop the macro stack for `t`; `false` when `t` is a macro that is refused. */
function stepMacros(walk: MacroWalk, t: MarkupToken): boolean {
  if (t.kind === "start" && localIn(t.name, MACRO_ELEMENTS)) {
    const names = inertMacroNames(t);
    if (names === undefined) return false;
    if (!t.selfClosing) walk.stack.push(names);
  } else if (t.kind === "end" && localIn(t.name, MACRO_ELEMENTS)) {
    walk.stack.pop();
  }
  return true;
}

/** Whether the innermost macro is a `code` or `noformat` macro (every name it gives). */
function inCodeMacro(walk: MacroWalk): boolean {
  const top = walk.stack.at(-1);
  return top?.every((n) => CODE_MACROS.has(n)) ?? false;
}

function isWhitespaceText(t: MarkupToken | undefined): boolean {
  return t?.kind === "text" && t.text.trim() === "";
}

/**
 * The CDATA token of an `ac:plain-text-body` opened at `k` when the CDATA is its only
 * non-whitespace content, or -1.
 */
function soleCdataOfBody(tokens: readonly MarkupToken[], k: number): number {
  let j = k + 1;
  if (isWhitespaceText(tokens[j])) j++;
  if (tokens[j]?.kind !== "cdata") return -1;
  const cdata = j;
  j++;
  if (isWhitespaceText(tokens[j])) j++;
  const end = tokens[j];
  return end?.kind === "end" && localIn(end.name, PLAIN_TEXT_BODY) ? cdata : -1;
}

/**
 * The CDATA tokens Confluence shows as escaped text: the sole content of an `ac:plain-text-body`
 * whose enclosing macro is `code` or `noformat`. They are not scanned, and their source spans are
 * left out of the tripwire input.
 */
function exemptCodeBodies(tokens: readonly MarkupToken[]): ReadonlySet<MarkupToken> {
  const walk: MacroWalk = { stack: [] };
  const out = new Set<MarkupToken>();
  tokens.forEach((t, k) => {
    stepMacros(walk, t);
    if (t.kind !== "start" || !localIn(t.name, PLAIN_TEXT_BODY) || !inCodeMacro(walk)) return;
    const cdata = tokens[soleCdataOfBody(tokens, k)];
    if (cdata !== undefined) out.add(cdata);
  });
  return out;
}

/**
 * The schemes that make an `ac:parameter` text a URL without a following `//` (coordinator
 * ruling on B3r concern 6, 2026-11-05). Any other scheme counts only when `//` follows it.
 */
const PARAMETER_URL_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "mailto",
  "tel",
  "blob",
  "filesystem",
  "about",
  "ws",
  "wss",
  "ftp",
  "http",
  "https",
]);
const PARAMETER_SCHEME = /^([a-z][a-z0-9+.-]*):(\/\/)?/;

/** One form of a parameter text: protocol-relative, a scheme + `//`, or a listed scheme. */
function parameterFormIsUrl(form: string): boolean {
  if (isSlash(form[0]) && isSlash(form[1])) return true;
  const m = PARAMETER_SCHEME.exec(form);
  if (m === null) return false;
  return m[2] !== undefined || PARAMETER_URL_SCHEMES.has(m[1] ?? "");
}

/**
 * R5 (narrowed by the coordinator ruling on B3r concern 6): an `ac:parameter` text is a URL only
 * when it has a REAL URL scheme (a scheme followed by `//`, or one of
 * {@link PARAMETER_URL_SCHEMES}) or is protocol-relative, in its RAW or SETTLED form (R2), or
 * when its settled form keeps an unresolved character reference (R2(c)). So a panel title such as
 * "Note: x" is allowed, while "JaVaScRiPt:x" and "//h" are refused. An unsettled text refuses.
 */
function parameterIsUrl(text: string): boolean {
  if (parameterFormIsUrl(rawUrlForm(text))) return true;
  const settled = settleUrl(text);
  if (settled === undefined) return true;
  return parameterFormIsUrl(settled) || UNRESOLVED_REFERENCE.test(settled);
}

/** An open `ac:parameter`: its names, whether it sits in a `jira` macro, and its text so far. */
interface OpenParameter {
  readonly names: readonly string[];
  readonly inJira: boolean;
  /** The macro's unnamed default parameter (for `jira`, the issue-navigator URL). */
  readonly isDefault: boolean;
  text: string;
}

/** R5 for one closed parameter: a URL value, or a non-empty `jira` URL or default parameter. */
function refusesParameter(p: OpenParameter): boolean {
  if (parameterIsUrl(p.text)) return true;
  if (!p.inJira || rawUrlForm(p.text) === "") return false;
  return p.isDefault || p.names.some((n) => JIRA_URL_PARAMETERS.has(n));
}

/**
 * One step of the parameter walk (a single forward pass: adversarial review). A parameter's text
 * is the concatenation of its text and CDATA tokens up to its end tag. A parameter that opens
 * inside another, or whose names do not settle, is refused. Returns the open parameter after `t`,
 * or `"refused"`.
 */
function stepParameter(
  open: OpenParameter | undefined,
  t: MarkupToken,
  walk: MacroWalk,
): OpenParameter | undefined | "refused" {
  if (t.kind === "start" && isParameterElement(t.name)) {
    const names = elementNames(t);
    if (open !== undefined || names === undefined) return "refused";
    const inJira = walk.stack.at(-1)?.includes("jira") ?? false;
    const p: OpenParameter = { names, inJira, isDefault: isDefaultParameter(t, names), text: "" };
    if (!t.selfClosing) return p;
    return refusesParameter(p) ? "refused" : undefined;
  }
  if (open === undefined) return undefined;
  if (t.kind === "text" || t.kind === "cdata") open.text += t.text;
  if (t.kind === "end" && isParameterElement(t.name)) {
    return refusesParameter(open) ? "refused" : undefined;
  }
  return open;
}

const URL_ELEMENT: ReadonlySet<string> = new Set(["url"]);

/** An `ri:url` (any prefix: `res:url` too) or an `ac:adf-*` element. */
function refusesStorageElement(t: StartToken): boolean {
  return localIn(t.name, URL_ELEMENT) || localForms(t.name).some((l) => l.startsWith("adf-"));
}

/**
 * R5 over one token stream: `ri:url` and `ac:adf-*` elements, macros outside the inert list (or
 * left open), parameters, and CDATA scanned recursively (R4 steps 2-6 and R5, depth at most
 * {@link CDATA_MAX_DEPTH}) unless it is an exempt code body.
 */
function refusesStorage(
  tokens: readonly MarkupToken[],
  exempt: ReadonlySet<MarkupToken>,
  depth: number,
): boolean {
  const walk: MacroWalk = { stack: [] };
  let parameter: OpenParameter | undefined;
  const refused = tokens.some((t) => {
    if (!stepMacros(walk, t)) return true;
    if (t.kind === "start" && refusesStorageElement(t)) return true;
    const next = stepParameter(parameter, t, walk);
    if (next === "refused") return true;
    parameter = next;
    return t.kind === "cdata" && !exempt.has(t) && refusesStorageCdata(t.text, depth);
  });
  // A macro or a parameter left open is refused.
  return refused || walk.stack.length > 0 || parameter !== undefined;
}

/** R5 CDATA: its content tokenized and scanned as storage, one level deeper. */
function refusesStorageCdata(content: string, depth: number): boolean {
  // Defence in depth: a CDATA section cannot hold a complete one (its `]]>` would end the
  // outer), so a nested opener never tokenizes and this bound is not reached in practice.
  if (depth >= CDATA_MAX_DEPTH) return true;
  const inner = tokenizeMarkup(content);
  if (inner === undefined) return true;
  return storageRules(inner, content, depth + 1);
}

/** R4 steps 2-6 and R5 over one storage token stream (no tripwire; the caller runs it once). */
function storageRules(tokens: readonly MarkupToken[], text: string, depth: number): boolean {
  const rules: MarkupRules = { allowCid: false, confluence: true, allowFragmentUrl: false };
  const exempt = depth === 0 ? exemptCodeBodies(tokens) : new Set<MarkupToken>();
  return (
    refusesTags(tokens, text, rules) || // steps 2-4
    refusesSvgElements(tokens) || // SVG elements (every format)
    refusesPresentationUrls(tokens, false) || // SVG presentation attributes
    refusesCss(tokens, text, rules) || // step 5
    refusesMarkupInDeclarations(tokens) || // step 6
    refusesStorage(tokens, exempt, depth) // step 7 (CDATA) and R5
  );
}

/** The source outside the exempt code bodies (a slice by offsets, not a strip). */
function textOutside(
  text: string,
  tokens: readonly MarkupToken[],
  exempt: ReadonlySet<MarkupToken>,
): string {
  let out = "";
  let at = 0;
  for (const t of tokens) {
    if (!exempt.has(t)) continue;
    out += text.slice(at, t.start);
    at = t.end;
  }
  return out + text.slice(at);
}

/** Confluence storage (R4 + R5, no `cid:`): the eight steps, in order. */
export function confluenceStorageRemote(text: string, opts: DetectOptions): boolean {
  const tokens = tokenizeMarkup(text); // step 1
  if (tokens === undefined) return true;
  if (storageRules(tokens, text, 0)) return true; // steps 2-7 and R5
  const exempt = exemptCodeBodies(tokens);
  return opts.tripwire && tripwire(textOutside(text, tokens, exempt), "default"); // step 8
}
