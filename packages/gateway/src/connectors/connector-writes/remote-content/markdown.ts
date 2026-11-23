// packages/gateway/src/connectors/connector-writes/remote-content/markdown.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.
import { type MarkupToken, tokenizeMarkup } from "../markup-tokens.ts";
import { foldAndStrip, settle } from "../text-normalise.ts";
import { hasCdata, type MarkupRules, refusesMarkupInDeclarations } from "./elements.ts";
import { type DetectOptions, refusesTags, tripwire } from "./html.ts";
import { refusesCss } from "./raw-text.ts";
import { isSlash } from "./shared.ts";
import { refusesPresentationUrls, refusesSvgElements } from "./svg.ts";

// ---------------------------------------------------------------------------------------------
// R9: Obsidian Markdown. Obsidian renders Markdown images and inline HTML in reading view.
// Refused: (a) the R4 HTML scan of the whole note (Markdown read as text, inline HTML as markup;
// no `cid:`); (b) any `![` that does not begin a well-formed vault embed `![[target]]` (target
// non-empty, no `:`, not starting with `/` or `\`, not followed by `(` or `[`, which could make
// it a Markdown image), in the raw and both settled forms, so every Markdown image is refused,
// even a relative one (the destination cannot be found without a CommonMark parser); (c) R6.
// Fenced code blocks and escaped `\![` are not exempt (stated over-refusal).
// ---------------------------------------------------------------------------------------------

/** The first `]]` at or after the last embed opener asked about (`-1`: none). */
interface CloseCursor {
  close: number;
}

/**
 * Whether the `![` at `at` begins a well-formed vault embed. `cursor` carries the first `]]` found
 * so far: openers are visited left to right, so it is searched again only once it lies before
 * this opener's target, and the whole note is scanned once (final review item 2). A target that
 * itself holds `![` or `[[` is not an embed (fail closed: a nested opener is never well formed).
 */
function isVaultEmbed(form: string, at: number, cursor: CloseCursor): boolean {
  if (!form.startsWith("![[", at)) return false;
  if (cursor.close < at + 3) cursor.close = form.indexOf("]]", at + 3);
  const close = cursor.close;
  if (close === -1) return false;
  const target = form.slice(at + 3, close);
  if (target === "" || target.includes(":") || isSlash(target[0])) return false;
  if (target.includes("![") || target.includes("[[")) return false;
  const after = form.charAt(close + 2);
  return after !== "(" && after !== "[";
}

/**
 * R9 (b): a `![` that is not a vault embed, in any form (an unsettled note is refused). With
 * `vaultEmbeds: false` (B3w forge Markdown, which has no `![[...]]` embeds) every `![` refuses.
 */
export function markdownImageRemote(
  text: string,
  opts: { readonly vaultEmbeds: boolean },
): boolean {
  const deleted = settle(text, "");
  const spaced = settle(text, " ");
  if (deleted === undefined || spaced === undefined) return true;
  return [text, deleted, spaced].some((form) => {
    const cursor: CloseCursor = { close: -1 };
    for (let at = form.indexOf("!["); at !== -1; at = form.indexOf("![", at + 1)) {
      if (!opts.vaultEmbeds || !isVaultEmbed(form, at, cursor)) return true;
    }
    return false;
  });
}

/**
 * A line that holds a fence run: the container markers before it (`>` and list markers, the
 * whitespace dropped), the indent between the last marker and the run (a TAB counts 4), the fence
 * character (backtick or tilde), the run length and the text after the run.
 */
interface FenceLine {
  readonly markers: string;
  readonly indent: number;
  readonly ch: string;
  readonly len: number;
  readonly info: string;
}

/**
 * A list marker at `i` (`-`, `*`, `+`, or one to nine digits then `.` or `)`) followed by a space,
 * a TAB or the end of the line: the index after it, or -1.
 */
function listMarkerEnd(line: string, i: number): number {
  const c = line.charAt(i);
  let j = i;
  if (c === "-" || c === "*" || c === "+") j = i + 1;
  else {
    while (j - i < 9 && line.charAt(j) >= "0" && line.charAt(j) <= "9") j++;
    if (j === i || (line.charAt(j) !== "." && line.charAt(j) !== ")")) return -1;
    j++;
  }
  const next = line.charAt(j);
  return next === "" || next === " " || next === "\t" ? j : -1;
}

/** The container markers, indent and offset where a line's fence run (if any) would start. */
function skipFenceContainers(line: string): { markers: string; indent: number; i: number } {
  let markers = "";
  let indent = 0;
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === " " || c === "\t") {
      indent += c === " " ? 1 : 4;
      i++;
      continue;
    }
    if (c === ">") {
      markers += ">";
      indent = 0;
      i++;
      continue;
    }
    const end = listMarkerEnd(line, i);
    if (end === -1) break;
    markers += c === "-" || c === "*" || c === "+" ? c : `N${line.charAt(end - 1)}`;
    indent = 0;
    i = end;
  }
  return { markers, indent, i };
}

/**
 * The fence run a line holds after any spaces, TABs, blockquote `>` markers and list markers, or
 * `undefined`. Any indent is accepted for an opener (an over-approximation: a 4-space-indented
 * "fence" is read as one, fail closed); a closer is checked separately.
 */
function fenceLineOf(line: string): FenceLine | undefined {
  const { markers, indent, i } = skipFenceContainers(line);
  const ch = line.charAt(i);
  if (ch !== "\x60" && ch !== "~") return undefined;
  let j = i;
  while (line.charAt(j) === ch) j++;
  return j - i < 3 ? undefined : { markers, indent, ch, len: j - i, info: line.slice(j) };
}

/** Only spaces and TABs. */
function isBlank(text: string): boolean {
  for (const ch of text) {
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

/**
 * A STRICT closing fence: at most 3 columns of indent after its container markers, and nothing
 * after the run but spaces and TABs. Its markers, character and length are matched by the caller.
 */
function isStrictCloser(f: FenceLine): boolean {
  return f.indent <= 3 && isBlank(f.info);
}

/** A URL in a diagram body: `//` anywhere, or one of the real URL schemes (`click A "https:..."`). */
const MERMAID_URL_SCHEME =
  /\b(?:javascript|data|vbscript|file|mailto|tel|blob|filesystem|about|ws|wss|ftp|http|https):/;

/** Whether one line of a diagram body names a URL (lower-cased; the settled text is scanned too). */
function lineLoads(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes("//") || MERMAID_URL_SCHEME.test(lower);
}

/**
 * PR #1916 review: a diagram format with a preprocessor or an expression language can ASSEMBLE a
 * URL that no line spells (PlantUML `!$u = "htt" + "ps:/" + "/h"` then `%load_json($u)`; a Vega
 * `{"url": {"signal": "..."}}`; D2 and Structurizr `${var}` substitution), so for those formats a
 * line naming a loader or a constructor counts as a URL line, whatever its arguments. Matched in
 * the lower-cased line with every space and TAB removed (`! include`, `%load_json (`). Sources
 * (retrieved 2026-11-06): PlantUML "Use the preprocessor" (https://plantuml.com/preprocessing:
 * `!include`, `!include_many`, `!include_once`, `!includesub`, `!includeurl`, `!includedef`,
 * `!import`, `!theme ... from`, `%load_json`) and "Creole" (`<img:...>`); Vega "Data"
 * (https://vega.github.io/vega/docs/data/: `url`, which takes a `signal`) and "Expressions";
 * D2 "Variables" (`${...}`); Structurizr DSL (`!include`, `!script`, `!plugin`, `${...}`).
 * Over-refusal (I53 bound): a PlantUML stdlib `!include <C4/C4_Context>` and a Vega `expr` that
 * loads nothing are refused too. `kroki` fences take every format's tokens (fail closed).
 */
const PLANTUML_LOADERS = ["!include", "!import", "!theme", "%load_json", "%loadjson", "<img"];
const VEGA_LOADERS = ["url", "signal", "expr", "loader", String.raw`\u`];
const SUBSTITUTION_LOADERS = ["${"];
const STRUCTURIZR_LOADERS = ["!include", "!script", "!plugin", "${"];
const DIAGRAM_LOADERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["plantuml", PLANTUML_LOADERS],
  ["puml", PLANTUML_LOADERS],
  ["c4plantuml", PLANTUML_LOADERS],
  ["vega", VEGA_LOADERS],
  ["vega-lite", VEGA_LOADERS],
  ["vegalite", VEGA_LOADERS],
  ["d2", SUBSTITUTION_LOADERS],
  ["structurizr", STRUCTURIZR_LOADERS],
  [
    "kroki",
    [...PLANTUML_LOADERS, ...VEGA_LOADERS, ...SUBSTITUTION_LOADERS, ...STRUCTURIZR_LOADERS],
  ],
]);

/** Every loader token, for an info string that does not settle (fail closed). */
const ALL_DIAGRAM_LOADER_LANGUAGES: readonly string[] = [...DIAGRAM_LOADERS.keys()];

/** A line lower-cased with every space and TAB removed, for the loader tokens. */
function compactLine(line: string): string {
  // A character loop, not a replace call: these files never replace (markup-tokens.test.ts pin).
  const lower = line.toLowerCase();
  let out = "";
  for (const ch of lower) {
    if (ch !== " " && ch !== "\t") out += ch;
  }
  return out;
}

/**
 * A fence's language: the FIRST word of its NFKC-folded, lower-cased info string (CommonMark 0.31
 * section 4.5: "the first word of the info string is typically used to specify the language"),
 * compared exactly (B3w review fix 5: `godot` or `snapshot` is not a diagram fence).
 */
function fenceLanguage(info: string): string {
  const folded = foldAndStrip(info).toLowerCase();
  let i = 0;
  while (i < folded.length && (folded[i] === " " || folded[i] === "\t")) i++;
  let j = i;
  while (j < folded.length && folded[j] !== " " && folded[j] !== "\t") j++;
  return folded.slice(i, j);
}

/**
 * Whether an info string names a diagram fence: its first word, and the first word of its settled
 * form (character references decoded: `&#109;ermaid`), compared exactly with `names`. An info
 * string that does not settle is a diagram fence (fail closed; final B3w review, item 2).
 */
function isDiagramInfo(info: string, names: ReadonlySet<string>): boolean {
  if (names.has(fenceLanguage(info))) return true;
  const settled = settle(info, "");
  return settled === undefined || names.has(fenceLanguage(settled));
}

/**
 * The loader languages an opener's info string names (in `names`): its first word and its settled
 * form's, or every loader language when the info string does not settle (fail closed).
 */
function loaderLanguagesOf(info: string, names: ReadonlySet<string>): readonly string[] {
  const settled = settle(info, "");
  if (settled === undefined) return ALL_DIAGRAM_LOADER_LANGUAGES.filter((l) => names.has(l));
  return [fenceLanguage(info), fenceLanguage(settled)].filter(
    (l) => names.has(l) && DIAGRAM_LOADERS.has(l),
  );
}

/** The line breaks the raw text is split on: CRLF, LF, CR, VT, FF, NEL, LS and PS. */
const LINE_BREAKS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/**
 * A closer stack per container markers + fence character, for the reverse pass: the nearest closer
 * is last, and each entry below it is strictly longer (a nearer closer at least as long makes a
 * farther one unreachable), so the nearest closer at least `len` long is found by binary search.
 */
interface Closer {
  readonly len: number;
  readonly at: number;
}
type CloserStacks = Map<string, Closer[]>;

function pushCloser(stacks: CloserStacks, key: string, len: number, at: number): void {
  let stack = stacks.get(key);
  if (stack === undefined) {
    stack = [];
    stacks.set(key, stack);
  }
  while (stack.length > 0 && (stack.at(-1)?.len ?? 0) <= len) stack.pop();
  stack.push({ len, at });
}

/** The index of the nearest closer at least `len` long, or `Infinity` when there is none. */
function nearestCloser(stack: readonly Closer[] | undefined, len: number): number {
  if (stack === undefined) return Number.POSITIVE_INFINITY;
  // Lengths decrease along the array; find the last entry whose length is at least `len`.
  let lo = 0;
  let hi = stack.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((stack[mid]?.len ?? 0) >= len) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found === -1 ? Number.POSITIVE_INFINITY : (stack[found]?.at ?? Number.POSITIVE_INFINITY);
}

/**
 * One form's lines: a diagram opener ANYWHERE (inside another fence, an indented code block, a list
 * item or a blockquote too: fence state is never tracked, so wrong pairing cannot hide one) whose
 * body, up to its strict closer (same markers, same character, a run at least as long) or the end
 * of the text, holds a URL line. One reverse pass: the nearest URL line after each line and the
 * closer stacks are both maintained as the pass moves up, so the whole scan is linear.
 */
function diagramLinesLoad(lines: readonly string[], names: ReadonlySet<string>): boolean {
  const closers: CloserStacks = new Map();
  // The loader languages these `names` can open (Obsidian's mermaid has none).
  const loaderLanguages = ALL_DIAGRAM_LOADER_LANGUAGES.filter((l) => names.has(l));
  let nextLoad = Number.POSITIVE_INFINITY;
  // Per loader language: the nearest line after this one naming one of its loader tokens.
  const nextLoader = new Map<string, number>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const f = fenceLineOf(line);
    if (f !== undefined && openerLoads(f, names, nextLoad, nextLoader, closers)) return true;
    if (f !== undefined && isStrictCloser(f)) pushCloser(closers, f.markers + f.ch, f.len, i);
    if (lineLoads(line)) nextLoad = i;
    noteLoaderLines(line, loaderLanguages, nextLoader, i);
  }
  return false;
}

/** Records line `i` as the nearest loader line of each language whose token it holds. */
function noteLoaderLines(
  line: string,
  loaderLanguages: readonly string[],
  nextLoader: Map<string, number>,
  i: number,
): void {
  const compact = loaderLanguages.length > 0 ? compactLine(line) : "";
  for (const l of loaderLanguages) {
    if ((DIAGRAM_LOADERS.get(l) ?? []).some((t) => compact.includes(t))) nextLoader.set(l, i);
  }
}

/** Whether a diagram opener `f` has a URL or loader line after it, before its strict closer. */
function openerLoads(
  f: FenceLine,
  names: ReadonlySet<string>,
  nextLoad: number,
  nextLoader: ReadonlyMap<string, number>,
  closers: CloserStacks,
): boolean {
  if (!isDiagramInfo(f.info, names)) return false;
  let bound = nextLoad;
  for (const l of loaderLanguagesOf(f.info, names)) {
    bound = Math.min(bound, nextLoader.get(l) ?? Number.POSITIVE_INFINITY);
  }
  return (
    bound !== Number.POSITIVE_INFINITY &&
    bound < nearestCloser(closers.get(f.markers + f.ch), f.len)
  );
}

/**
 * Coordinator rulings and the final B3w review (item 1): a diagram fence (backtick or tilde; its
 * language in `names`) whose body holds `//` or a real URL scheme is refused, because the renderer
 * can reach a URL on view (a mermaid `click` link or `img`, a PlantUML `!include https://...`, a
 * Vega `"url"`). Openers are looked for on every line, independent of fence state, in the raw text
 * (split on every line break) and in its settled form (line breaks kept); an unsettled text refuses.
 */
export function diagramFenceLoadsRemote(text: string, names: ReadonlySet<string>): boolean {
  const settled = settle(text, "", true);
  if (settled === undefined) return true;
  return (
    diagramLinesLoad(text.split(LINE_BREAKS), names) || diagramLinesLoad(settled.split("\n"), names)
  );
}

/** The diagram fences Obsidian renders: mermaid (coordinator ruling). */
const OBSIDIAN_DIAGRAM_FENCES: ReadonlySet<string> = new Set(["mermaid"]);

/**
 * R9 (a), shared by Obsidian and forge Markdown (B3w): the R4 HTML scan of a Markdown body's
 * tokens (inline HTML read as markup, the rest as text; no `cid:`).
 */
export function markdownHtmlRemote(tokens: readonly MarkupToken[], text: string): boolean {
  const rules: MarkupRules = { allowCid: false, confluence: false, allowFragmentUrl: false };
  return (
    refusesTags(tokens, text, rules) || // R4 steps 2-4
    refusesSvgElements(tokens) || // SVG elements (every format)
    refusesPresentationUrls(tokens, false) || // SVG presentation attributes
    refusesCss(tokens, text, rules) || // R4 step 5
    refusesMarkupInDeclarations(tokens) || // R4 step 6
    hasCdata(tokens) // R4 step 7
  );
}

/** R9: an Obsidian note, (a) then (b) then (c). */
export function obsidianRemote(text: string, opts: DetectOptions): boolean {
  const tokens = tokenizeMarkup(text); // (a) step 1
  if (tokens === undefined) return true;
  return (
    markdownHtmlRemote(tokens, text) || // (a)
    markdownImageRemote(text, { vaultEmbeds: true }) || // (b)
    diagramFenceLoadsRemote(text, OBSIDIAN_DIAGRAM_FENCES) || // mermaid fences (coordinator ruling)
    (opts.tripwire && tripwire(text, "default")) // (c)
  );
}
