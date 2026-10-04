/**
 * Test support for the I26 connector-write sync guard (`../connector-write-sync.test.ts`).
 *
 * Reads the INSTALLED `@nimbus-dev/connectors` source as TEXT and derives every tool id the
 * connectors register through the consent kit's write registrar, so the gateway's I26 predicate
 * (`isConnectorWriteToolId`) can be checked against what the connectors actually treat as writes.
 * It never imports the package: the gateway's one import from it is `setConnectorMode`.
 *
 * Registrations are found by DATA FLOW from the consent kit's `createWriteToolRegistrar`, never by a
 * naming convention. connectors 0.2.2 already forwards writes through `registerStatusTool`,
 * `registerPipelineActionTool` and `registerFeedbackTool`, so a `register*WriteTool(` pattern would
 * miss every tool added through them. Every shape the scan cannot follow is a VIOLATION rather than
 * a silent skip:
 *
 *   - a registration whose tool id is not a literal, a template over constants, a loop over a
 *     constant table, or a string constant;
 *   - a registrar used as a value anywhere the flow below does not follow;
 *   - a registrar factory whose result is not bound to a name or handed off under a property key;
 *   - a `mutates:` literal (the action type `WriteToolConfig` requires of every write) that no
 *     recognised registration consumes, which is how a registration in an unrecognised shape shows
 *     up even when nothing else about it does;
 *   - a file whose brackets do not balance after stripping, i.e. the stripper lost its place.
 *
 * The flow it follows: a name bound to a registrar factory (`createWriteToolRegistrar`, or a kit
 * factory discovered by the forwarding arrow it returns) is a registrar; so is an alias of one, a
 * property it is handed off under (`{ registerWriteTool }`, `opts.registerWriteTool`), any property
 * or parameter typed `*WriteToolRegistrar`, and any function that forwards its FIRST parameter to a
 * registrar, whatever it is called. Calls of those names are registrations.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { stripComments, stripStringLiterals } from "../../../../../scripts/structure-audit/lib.ts";

export const CONNECTORS_PACKAGE = "@nimbus-dev/connectors";

/** The consent kit's registrar constructor: the root every write registration flows from. */
export const ROOT_REGISTRAR_FACTORY = "createWriteToolRegistrar";

export interface PackageSource {
  /** Package-relative path, forward slashes. */
  readonly rel: string;
  readonly text: string;
}

/**
 * How a registration's tool id reached the registrar. The first four say how the ID was written;
 * the last three say which kind of registrar was CALLED (a direct call of a consent-kit registrar
 * carries none of them).
 */
export type RegistrationTag =
  | "literal"
  | "template"
  | "loop"
  | "const"
  | "forwarder"
  | "kit-alias"
  | "factory";

export interface WriteToolRegistration {
  readonly id: string;
  /** The file holding the registering call. */
  readonly file: string;
  readonly line: number;
  /**
   * The file the id's VALUE was written in. Usually `file`; for an id built inside a shared kit
   * from a caller's constant (`${toolPrefix}_mail_send`) it is the caller's file, which is what
   * attributes the registration to the connector it belongs to.
   */
  readonly origin: string;
  readonly tags: readonly RegistrationTag[];
}

export interface ScanViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

export interface WriteToolScan {
  readonly registrations: readonly WriteToolRegistration[];
  readonly violations: readonly ScanViolation[];
}

/** The installed package's root directory, resolved from the gateway the way Bun resolves it. */
export function installedConnectorsPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(`${CONNECTORS_PACKAGE}/package.json`));
}

/**
 * Every non-test `.ts` file a connector can register a tool from: `connectors/<id>/src/**` and
 * `shared/**`. A missing `connectors/` directory throws, so a moved package fails loudly instead of
 * yielding an empty (and therefore passing) scan.
 */
export function readConnectorPackageSources(root: string): PackageSource[] {
  const out: PackageSource[] = [];
  const connectorsDir = join(root, "connectors");
  for (const id of readdirSync(connectorsDir).sort((a, b) => a.localeCompare(b))) {
    walkTs(join(connectorsDir, id, "src"), root, out);
  }
  walkTs(join(root, "shared"), root, out);
  return out;
}

function walkTs(dir: string, root: string, out: PackageSource[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return; // a connector need not have every directory
  }
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith(".ts")) {
      if (!name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        out.push({
          rel: relative(root, path).split(sep).join("/"),
          text: readFileSync(path, "utf8"),
        });
      }
    } else if (name !== "node_modules" && !name.includes(".")) {
      walkTs(path, root, out);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lexical helpers. Every one of them works on `blank`: comments removed and string/template text
// blanked to spaces (length-preserving against `code`, which keeps the string contents), so a
// bracket, keyword or identifier seen in `blank` is real code.
// ---------------------------------------------------------------------------------------------

interface Prepared {
  readonly rel: string;
  readonly code: string;
  readonly blank: string;
  readonly lineStarts: readonly number[];
}

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const IDENT_RE = new RegExp(`^${IDENT}$`);
const OPEN = "([{";
const CLOSE = ")]}";

function prepare(src: PackageSource): Prepared {
  const code = stripComments(src.text);
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charAt(i) === "\n") lineStarts.push(i + 1);
  return { rel: src.rel, code, blank: stripStringLiterals(code), lineStarts };
}

function lineAt(p: Prepared, offset: number): number {
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
function matchForward(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Index of the bracket opening the one at `close`, or -1. */
function matchBackward(s: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = s.charAt(i);
    if (CLOSE.includes(c)) depth++;
    else if (OPEN.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Whether every bracket closes the kind it opened. False means the stripper lost its place. */
function isBalanced(s: string): boolean {
  const stack: string[] = [];
  for (const c of s) {
    const open = OPEN.indexOf(c);
    if (open >= 0) stack.push(CLOSE.charAt(open));
    else if (CLOSE.includes(c) && stack.pop() !== c) return false;
  }
  return stack.length === 0;
}

function skipWs(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s.charAt(j))) j++;
  return j;
}

function skipWsBack(s: string, i: number): number {
  let j = i;
  while (j >= 0 && /\s/.test(s.charAt(j))) j--;
  return j;
}

/** Past a `<...>` starting at `i` (an `=>` inside does not close it). */
function skipAngles(s: string, i: number): number {
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
function expressionEnd(s: string, start: number): number {
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

/** Past a type annotation (after its `:`), to the `=` it ends at; -1 when it is not followed by one. */
function skipTypeToAssign(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s.charAt(j);
    if (c === "=" && s.charAt(j + 1) === ">") j++;
    else if (OPEN.includes(c) || c === "<") depth++;
    else if (CLOSE.includes(c) || c === ">") depth--;
    else if (depth === 0 && c === "=") return j;
    else if (depth === 0 && c === ";") return -1;
    if (depth < 0) return -1;
  }
  return -1;
}

/** Past a return-type annotation (after its `:`), to the `{` that opens the body; -1 if none. */
function skipReturnTypeToBody(s: string, i: number): number {
  let depth = 0;
  let prev = ":";
  for (let j = i; j < s.length; j++) {
    const c = s.charAt(j);
    if (/\s/.test(c)) continue;
    if (c === "=" && s.charAt(j + 1) === ">") {
      j++;
      prev = ">";
      continue;
    }
    if (c === "{" && depth === 0 && !":|&,".includes(prev)) return j;
    if (c === "{" && depth === 0) {
      j = matchForward(s, j);
      if (j < 0) return -1;
      prev = "}";
      continue;
    }
    if ("([<".includes(c)) depth++;
    else if (")]>".includes(c)) depth--;
    else if (depth === 0 && c === ";") return -1;
    prev = c;
  }
  return -1;
}

/** Top-level comma-separated parts of the bracket group opening at `open`, as `[start, end)`. */
function splitGroup(s: string, open: number): Array<[number, number]> {
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
function stringLiteralAt(p: Prepared, at: number): { value: string; end: number } | null {
  const quote = p.code.charAt(at);
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const close = p.blank.indexOf(quote, at + 1);
  if (close < 0) return null;
  const value = p.code.slice(at + 1, close);
  if (value.includes("\\") || (quote === "`" && value.includes("${"))) return null;
  return { value, end: close + 1 };
}

// ---------------------------------------------------------------------------------------------
// Structural index of one file: declarations, destructurings, functions, for-of loops, tables.
// ---------------------------------------------------------------------------------------------

interface Binding {
  readonly key: string;
  readonly local: string;
}

interface Declaration {
  readonly name: string;
  readonly at: number;
  readonly initStart: number;
  readonly initEnd: number;
}

interface Destructuring {
  readonly bindings: readonly Binding[];
  readonly at: number;
  readonly rhsStart: number;
  readonly rhsEnd: number;
}

interface Param {
  readonly name: string | null;
  readonly pattern: readonly Binding[];
}

interface FnInfo {
  readonly name: string | null;
  readonly exported: boolean;
  /** An anonymous function that is directly `return`ed. */
  readonly returned: boolean;
  readonly params: readonly Param[];
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

interface ForOf {
  readonly ident: string | null;
  readonly pattern: readonly Binding[];
  /** The iterated table's name, or null for an inline array literal. */
  readonly iterable: string | null;
  /** The inline array literal's `[`, when `iterable` is null. */
  readonly inlineArray: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

interface FileIndex {
  readonly declarations: readonly Declaration[];
  readonly destructurings: readonly Destructuring[];
  readonly fns: readonly FnInfo[];
  readonly loops: readonly ForOf[];
  /** `const NAME = [ ... ]` → the array's `[` offset. */
  readonly tables: ReadonlyMap<string, number>;
  /** `const NAME = "literal"` → value. */
  readonly strings: ReadonlyMap<string, string>;
  /** `[start, end)` spans of `import ... from` statements. */
  readonly imports: ReadonlyArray<readonly [number, number]>;
}

function parsePattern(s: string, open: number): Binding[] {
  const out: Binding[] = [];
  const re = new RegExp(String.raw`^\s*(${IDENT})\s*(?::\s*(${IDENT}))?\s*(?:=[\s\S]*)?$`);
  for (const [a, b] of splitGroup(s, open)) {
    const m = re.exec(s.slice(a, b));
    if (m?.[1] !== undefined) out.push({ key: m[1], local: m[2] ?? m[1] });
  }
  return out;
}

function parseParams(s: string, open: number): Param[] {
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

function declarationsOf(s: string): Declaration[] {
  const out: Declaration[] = [];
  for (const m of s.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*`, "g"))) {
    const name = m[1];
    if (name === undefined) continue;
    let i = (m.index ?? 0) + m[0].length;
    if (s.charAt(i) === ":") i = skipTypeToAssign(s, i + 1);
    if (i < 0 || s.charAt(i) !== "=" || "=>".includes(s.charAt(i + 1))) continue;
    out.push({ name, at: m.index ?? 0, initStart: i + 1, initEnd: expressionEnd(s, i + 1) });
  }
  return out;
}

function destructuringsOf(s: string): Destructuring[] {
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
      rhsStart,
      rhsEnd: expressionEnd(s, rhsStart),
    });
  }
  return out;
}

/** What precedes a function head: the name it is bound to, and whether it is exported/returned. */
function headContext(
  s: string,
  headStart: number,
): Omit<FnInfo, "params" | "bodyStart" | "bodyEnd"> {
  const before = s.slice(Math.max(0, headStart - 200), headStart);
  const bound = new RegExp(
    String.raw`(\bexport\s+)?\b(?:const|let|var)\s+(${IDENT})\s*(?::[^=;]*)?=\s*(?:async\s+)?$`,
  ).exec(before);
  if (bound?.[2] !== undefined) {
    return { name: bound[2], exported: bound[1] !== undefined, returned: false };
  }
  return { name: null, exported: false, returned: /\breturn\s+(?:async\s+)?$/.test(before) };
}

function functionDeclarationsOf(s: string): FnInfo[] {
  const out: FnInfo[] = [];
  const re = new RegExp(String.raw`\bfunction\b\s*\*?\s*(${IDENT})?\s*`, "g");
  for (const m of s.matchAll(re)) {
    const at = m.index ?? 0;
    let i = at + m[0].length;
    if (s.charAt(i) === "<") i = skipWs(s, skipAngles(s, i));
    if (i < 0 || s.charAt(i) !== "(") continue;
    const paramsClose = matchForward(s, i);
    if (paramsClose < 0) continue;
    let j = skipWs(s, paramsClose + 1);
    if (s.charAt(j) === ":") j = skipReturnTypeToBody(s, j + 1);
    if (j < 0 || s.charAt(j) !== "{") continue;
    const name = m[1] ?? null;
    const ctx =
      name === null
        ? headContext(s, at)
        : {
            name,
            exported: /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(
              s.slice(Math.max(0, at - 40), at),
            ),
            returned: false,
          };
    out.push({ ...ctx, params: parseParams(s, i), bodyStart: j, bodyEnd: matchForward(s, j) });
  }
  return out;
}

/** The `(` of an arrow's parameter list ending just before `arrow`, or -1. */
function arrowParamsOpen(s: string, arrow: number): number {
  const k = skipWsBack(s, arrow - 1);
  if (s.charAt(k) === ")") return matchBackward(s, k);
  // `(...): ReturnType =>` — walk back over a simple type to its `:`, then to the `)`.
  let m = k;
  while (m >= 0 && /[\w$.<>[\]|&,\s]/.test(s.charAt(m))) m--;
  if (s.charAt(m) !== ":") return -1;
  const close = skipWsBack(s, m - 1);
  return s.charAt(close) === ")" ? matchBackward(s, close) : -1;
}

function arrowFunctionsOf(s: string): FnInfo[] {
  const out: FnInfo[] = [];
  for (let arrow = s.indexOf("=>"); arrow >= 0; arrow = s.indexOf("=>", arrow + 2)) {
    let params: Param[];
    let headStart: number;
    const open = arrowParamsOpen(s, arrow);
    if (open >= 0) {
      params = parseParams(s, open);
      headStart = open;
      const g = skipWsBack(s, open - 1);
      if (s.charAt(g) === ">") {
        // `<T>(...) =>`: the generic's `<`.
        let depth = 0;
        for (let i = g; i >= 0; i--) {
          if (s.charAt(i) === ">") depth++;
          else if (s.charAt(i) === "<" && --depth === 0) {
            headStart = i;
            break;
          }
        }
      }
    } else {
      const single = new RegExp(`(${IDENT})\\s*$`).exec(s.slice(Math.max(0, arrow - 80), arrow));
      if (single?.[1] === undefined) continue;
      params = [{ name: single[1], pattern: [] }];
      headStart = arrow - single[0].length;
    }
    const b = skipWs(s, arrow + 2);
    const bodyEnd = s.charAt(b) === "{" ? matchForward(s, b) : expressionEnd(s, b);
    out.push({ ...headContext(s, headStart), params, bodyStart: b, bodyEnd });
  }
  return out;
}

function forOfLoopsOf(s: string): ForOf[] {
  const out: ForOf[] = [];
  for (const m of s.matchAll(/\bfor\s*\(/g)) {
    const headOpen = (m.index ?? 0) + m[0].length - 1;
    const headClose = matchForward(s, headOpen);
    if (headClose < 0) continue;
    const head = s.slice(headOpen + 1, headClose);
    const decl = /^\s*(?:const|let|var)\s+/.exec(head);
    if (decl === null) continue;
    let i = headOpen + 1 + decl[0].length;
    let ident: string | null = null;
    let pattern: Binding[] = [];
    if (s.charAt(i) === "{") {
      pattern = parsePattern(s, i);
      i = matchForward(s, i) + 1;
    } else {
      const id = new RegExp(`^${IDENT}`).exec(s.slice(i, headClose));
      if (id === null) continue;
      ident = id[0];
      i += id[0].length;
    }
    const of = new RegExp(String.raw`^\s+of\s+(?:(${IDENT})\s*$|(\[))`).exec(s.slice(i, headClose));
    if (of === null) continue;
    const inlineArray = of[2] === undefined ? -1 : i + of[0].length - 1;
    const b = skipWs(s, headClose + 1);
    const bodyEnd = s.charAt(b) === "{" ? matchForward(s, b) : expressionEnd(s, b);
    out.push({ ident, pattern, iterable: of[1] ?? null, inlineArray, bodyStart: b, bodyEnd });
  }
  return out;
}

function indexFile(p: Prepared): FileIndex {
  const s = p.blank;
  const tables = new Map<string, number>();
  const strings = new Map<string, string>();
  const declarations = declarationsOf(s);
  for (const d of declarations) {
    const v = skipWs(s, d.initStart);
    if (s.charAt(v) === "[") tables.set(d.name, v);
    const lit = stringLiteralAt(p, v);
    if (lit !== null && /^\s*(?:as\s+const\s*)?$/.test(s.slice(lit.end, d.initEnd))) {
      strings.set(d.name, lit.value);
    }
  }
  const imports: Array<readonly [number, number]> = [];
  for (const m of s.matchAll(/\bimport\b[^;]*?\bfrom\b/g)) {
    imports.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return {
    declarations,
    destructurings: destructuringsOf(s),
    fns: [...functionDeclarationsOf(s), ...arrowFunctionsOf(s)],
    loops: forOfLoopsOf(s),
    tables,
    strings,
    imports,
  };
}

/** Functions whose body contains `offset`, innermost first. */
function enclosingFns(ix: FileIndex, offset: number): FnInfo[] {
  return ix.fns
    .filter((f) => f.bodyStart <= offset && offset <= f.bodyEnd)
    .sort((a, b) => b.bodyStart - a.bodyStart);
}

// ---------------------------------------------------------------------------------------------
// The analysis.
// ---------------------------------------------------------------------------------------------

type RegistrarKind = "root" | "factory" | "forwarder" | "kit-alias";

interface State {
  /** Registrar factories: the consent kit's root plus kit factories found from their returns. */
  readonly factories: Map<string, "root" | "factory">;
  /** Property keys registrars are handed off under, or typed as. */
  readonly keys: Set<string>;
  /** Per-file registrar names. */
  readonly locals: Map<string, Map<string, RegistrarKind>>;
  /** Registrars and forwarders declared `export`ed, so callable from any file. */
  readonly exported: Map<string, RegistrarKind>;
}

interface File {
  readonly p: Prepared;
  readonly ix: FileIndex;
}

interface CallSite {
  /** Offset of the callee name. */
  readonly at: number;
  /** Offset of the call's `(`. */
  readonly open: number;
}

/**
 * Calls of `name` (bare, or `.name` when `member`), including ones with explicit type arguments —
 * `f<T>(...)` is exactly the spelling a guard keyed on `f(` misses. A `function name(` declaration
 * is not a call.
 */
function callsOf(s: string, name: string, member: boolean): CallSite[] {
  const out: CallSite[] = [];
  const lead = member ? String.raw`\.\s*` : String.raw`(?<![\w$.])`;
  for (const m of s.matchAll(new RegExp(`${lead}${escapeRe(name)}(?![\\w$])`, "g"))) {
    const at = (m.index ?? 0) + m[0].length - name.length;
    let i = skipWs(s, at + name.length);
    if (s.charAt(i) === "<") i = skipWs(s, skipAngles(s, i));
    if (i < 0 || s.charAt(i) !== "(") continue;
    if (/\bfunction\s*\*?\s*$/.test(s.slice(Math.max(0, at - 20), at))) continue;
    out.push({ at, open: i });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[$.*+?^{}()|[\]\\]/g, String.raw`\$&`);
}

/** A resolved string and the file it was written in. */
interface Valued {
  readonly value: string;
  readonly origin: string;
}

type Resolution =
  | { readonly kind: "ids"; readonly ids: readonly Valued[]; readonly tag: RegistrationTag }
  | { readonly kind: "forward"; readonly fn: FnInfo }
  | { readonly kind: "unresolved"; readonly reason: string };

class Analysis {
  readonly registrations: WriteToolRegistration[] = [];
  readonly violations: ScanViolation[] = [];
  /** Per file: `[open, close]` of every recognised registrar call, for the `mutates` cross-check. */
  readonly callSpans = new Map<string, Array<readonly [number, number]>>();
  /** Per file: `[` offsets of the constant tables a registration resolved through. */
  readonly tablesUsed = new Map<string, Set<number>>();
  private readonly seen = new Set<string>();

  constructor(
    readonly state: State,
    readonly files: readonly File[],
  ) {}

  violation(f: File, offset: number, reason: string): void {
    const line = lineAt(f.p, offset);
    const key = `${f.p.rel}:${line}:${reason}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.violations.push({ file: f.p.rel, line, reason });
  }

  localsOf(f: File): Map<string, RegistrarKind> {
    let m = this.state.locals.get(f.p.rel);
    if (m === undefined) {
      m = new Map();
      this.state.locals.set(f.p.rel, m);
    }
    return m;
  }

  /** Every registrar callable in `f`: its own names plus every exported one. */
  registrarsIn(f: File): Map<string, RegistrarKind> {
    return new Map([...this.state.exported, ...this.localsOf(f)]);
  }

  // -- discovery ------------------------------------------------------------------------------

  /** Bind names to registrars: factory results, aliases, destructured or typed registrar keys. */
  discoverBindings(f: File): void {
    const s = f.p.blank;
    const locals = this.localsOf(f);
    const typed = new RegExp(
      String.raw`(?<![\w$.])(${IDENT})\s*\??\s*:\s*(?:Readonly<\s*)?[A-Za-z_$]*WriteToolRegistrar\b`,
      "g",
    );
    for (const m of s.matchAll(typed)) {
      const name = m[1];
      if (name === undefined) continue;
      this.state.keys.add(name);
      if (!locals.has(name)) locals.set(name, "kit-alias");
    }
    for (const d of f.ix.declarations) {
      const kind = this.registrarValueKind(f, d.initStart, d.initEnd);
      if (kind === undefined) continue;
      // An exported registrar is callable from any file that imports it.
      const exported = /\bexport\s+$/.test(s.slice(Math.max(0, d.at - 20), d.at));
      const target = exported ? this.state.exported : locals;
      if (!target.has(d.name)) target.set(d.name, kind);
    }
    for (const d of f.ix.destructurings) {
      for (const b of d.bindings) {
        if (this.state.keys.has(b.key) && !locals.has(b.local)) locals.set(b.local, "kit-alias");
      }
    }
    for (const fn of f.ix.fns) {
      for (const param of fn.params) {
        for (const b of param.pattern) {
          if (this.state.keys.has(b.key) && !locals.has(b.local)) locals.set(b.local, "kit-alias");
        }
      }
    }
    // Hand-offs: `{ registerWriteTool }` / `{ key: registerWriteTool }` make the key a registrar key.
    for (const name of this.registrarsIn(f).keys()) {
      const re = new RegExp(
        String.raw`(?:[{,]\s*${escapeRe(name)}\s*(?=[,}])|(?<![\w$.])(${IDENT})\s*:\s*${escapeRe(name)}\s*(?=[,}]))`,
        "g",
      );
      for (const m of s.matchAll(re)) this.state.keys.add(m[1] ?? name);
    }
  }

  /**
   * The registrar kind an expression evaluates to at its top level: a factory call, a registrar
   * name, or a registrar key read off an object (`options.registerWriteTool ?? create...(...)`).
   */
  registrarValueKind(f: File, start: number, end: number): RegistrarKind | undefined {
    const s = f.p.blank;
    const registrars = this.registrarsIn(f);
    let depth = 0;
    let found: RegistrarKind | undefined;
    for (let i = start; i < end; i++) {
      const c = s.charAt(i);
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) depth--;
      if (depth !== 0 || !/[A-Za-z_$]/.test(c) || /[\w$]/.test(s.charAt(i - 1))) continue;
      const word = new RegExp(`^${IDENT}`).exec(s.slice(i, end))?.[0] ?? "";
      const next = s.charAt(skipWs(s, i + word.length));
      const member = s.charAt(skipWsBack(s, i - 1)) === ".";
      const factory = this.state.factories.get(word);
      if (!member && factory !== undefined && (next === "(" || next === "<")) return factory;
      if (next !== "(") {
        if (!member && registrars.has(word)) found ??= registrars.get(word);
        if (member && this.state.keys.has(word)) found ??= "kit-alias";
      }
      i += Math.max(0, word.length - 1);
    }
    return found;
  }

  // -- registrations --------------------------------------------------------------------------

  /** Resolve every call of every registrar in `f`; record registrations and new forwarders. */
  scanCalls(f: File): void {
    const s = f.p.blank;
    const spans: Array<readonly [number, number]> = [];
    const visit = (call: CallSite, kind: RegistrarKind): void => {
      spans.push([call.open, matchForward(s, call.open)]);
      const args = splitGroup(s, call.open);
      const first = args[0];
      if (first === undefined) {
        this.violation(f, call.at, "write-tool registration with no tool-id argument");
        return;
      }
      const r = this.resolveFirstArg(f, call.at, first);
      if (r.kind === "unresolved") {
        this.violation(f, call.at, r.reason);
      } else if (r.kind === "forward") {
        this.recordForwarder(f, call.at, r.fn);
      } else {
        const tags: RegistrationTag[] = [r.tag];
        if (kind !== "root") tags.push(kind);
        const line = lineAt(f.p, call.at);
        for (const { value, origin } of r.ids) {
          this.registrations.push({ id: value, file: f.p.rel, line, origin, tags });
        }
      }
    };
    for (const [name, kind] of this.registrarsIn(f)) {
      for (const call of callsOf(s, name, false)) visit(call, kind);
    }
    for (const key of this.state.keys) {
      for (const call of callsOf(s, key, true)) visit(call, "kit-alias");
    }
    this.callSpans.set(f.p.rel, spans);
  }

  recordForwarder(f: File, at: number, fn: FnInfo): void {
    if (fn.name !== null) {
      const target = fn.exported ? this.state.exported : this.localsOf(f);
      if (!target.has(fn.name)) target.set(fn.name, "forwarder");
      return;
    }
    if (fn.returned) {
      // An anonymous forwarder returned by a function: that function builds registrars.
      const outer = enclosingFns(f.ix, fn.bodyStart - 1).find((g) => g.name !== null);
      if (outer?.name !== undefined && outer.name !== null) {
        if (!this.state.factories.has(outer.name)) this.state.factories.set(outer.name, "factory");
        return;
      }
    }
    this.violation(f, at, "forwards its tool-id parameter from a function the scan cannot name");
  }

  resolveFirstArg(f: File, at: number, [a, b]: readonly [number, number]): Resolution {
    const s = f.p.blank;
    const start = skipWs(s, a);
    const text = f.p.code.slice(start, b).trim();
    const lit = stringLiteralAt(f.p, start);
    if (lit !== null && s.slice(lit.end, b).trim() === "") {
      return { kind: "ids", ids: [{ value: lit.value, origin: f.p.rel }], tag: "literal" };
    }
    if (f.p.code.charAt(start) === "`") return this.resolveTemplate(f, at, start, b);
    if (IDENT_RE.test(text)) {
      const forwarded = enclosingFns(f.ix, at)[0];
      if (forwarded?.params[0]?.name === text && !this.isLoopVar(f, at, text)) {
        return { kind: "forward", fn: forwarded };
      }
      const values = this.resolveIdent(f, at, text);
      if (values === null) {
        return { kind: "unresolved", reason: `write-tool id \`${text}\` resolves to no constant` };
      }
      return { kind: "ids", ids: values.values, tag: values.tag };
    }
    return {
      kind: "unresolved",
      reason: `write-tool id \`${text.replace(/\s+/g, " ").slice(0, 60)}\` is not a shape the scan resolves`,
    };
  }

  resolveTemplate(f: File, at: number, start: number, end: number): Resolution {
    const s = f.p.blank;
    const close = s.lastIndexOf("`", end - 1);
    let combos: Valued[] = [{ value: "", origin: f.p.rel }];
    let i = start + 1;
    while (i < close) {
      const sub = s.indexOf("${", i);
      const chunkEnd = sub < 0 || sub > close ? close : sub;
      const chunk = f.p.code.slice(i, chunkEnd);
      if (chunk.includes("\\")) return { kind: "unresolved", reason: "template id with an escape" };
      combos = combos.map((c) => ({ value: c.value + chunk, origin: c.origin }));
      if (chunkEnd === close) break;
      const subClose = matchForward(s, sub + 1);
      const expr = s.slice(sub + 2, subClose).trim();
      const resolved = IDENT_RE.test(expr) ? this.resolveIdent(f, at, expr) : null;
      if (resolved === null) {
        return {
          kind: "unresolved",
          reason: `template id substitution \`${expr}\` resolves to no constant`,
        };
      }
      combos = combos.flatMap((c) =>
        resolved.values.map((v) => ({ value: c.value + v.value, origin: v.origin })),
      );
      i = subClose + 1;
    }
    return { kind: "ids", ids: combos, tag: "template" };
  }

  isLoopVar(f: File, at: number, name: string): boolean {
    return this.loopFor(f, at, name) !== undefined;
  }

  loopFor(f: File, at: number, name: string): { loop: ForOf; key: string | null } | undefined {
    for (const loop of f.ix.loops) {
      if (at < loop.bodyStart || at > loop.bodyEnd) continue;
      if (loop.ident === name) return { loop, key: null };
      const b = loop.pattern.find((x) => x.local === name);
      if (b !== undefined) return { loop, key: b.key };
    }
    return undefined;
  }

  /** The string values `name` takes at `at`: a loop table, kit call-site constants, or a const. */
  resolveIdent(
    f: File,
    at: number,
    name: string,
  ): { values: Valued[]; tag: RegistrationTag } | null {
    const loop = this.loopFor(f, at, name);
    if (loop !== undefined) {
      const values = this.tableValues(f, loop.loop, loop.key);
      return values === null ? null : { values, tag: "loop" };
    }
    const fromCallers = this.kitOptionValues(f, at, name);
    if (fromCallers !== undefined) {
      return fromCallers === null ? null : { values: fromCallers, tag: "const" };
    }
    const value = f.ix.strings.get(name);
    return value === undefined ? null : { values: [{ value, origin: f.p.rel }], tag: "const" };
  }

  /** Each element's `key` value (or each element itself, for `key === null`) of a constant table. */
  tableValues(f: File, loop: ForOf, key: string | null): Valued[] | null {
    let host = f;
    let open = loop.inlineArray;
    if (loop.iterable !== null) {
      const local = f.ix.tables.get(loop.iterable);
      const other = this.files.find((g) => g.ix.tables.has(loop.iterable ?? ""));
      host = local === undefined && other !== undefined ? other : f;
      open = host.ix.tables.get(loop.iterable) ?? -1;
    }
    if (open < 0) return null;
    let used = this.tablesUsed.get(host.p.rel);
    if (used === undefined) {
      used = new Set();
      this.tablesUsed.set(host.p.rel, used);
    }
    used.add(open);
    const values: Valued[] = [];
    for (const [a, b] of splitGroup(host.p.blank, open)) {
      const v = key === null ? this.literalSpan(host, a, b) : this.propertyLiteral(host, a, key);
      if (v === null) return null;
      values.push({ value: v, origin: host.p.rel });
    }
    return values.length === 0 ? null : values;
  }

  literalSpan(f: File, a: number, b: number): string | null {
    const start = skipWs(f.p.blank, a);
    const lit = stringLiteralAt(f.p, start);
    return lit !== null && f.p.blank.slice(lit.end, b).trim() === "" ? lit.value : null;
  }

  /** The literal value of `key` directly inside the object literal starting at/after `a`. */
  propertyLiteral(f: File, a: number, key: string): string | null {
    const s = f.p.blank;
    const open = skipWs(s, a);
    if (s.charAt(open) !== "{") return null;
    for (const [x, y] of splitGroup(s, open)) {
      const m = new RegExp(String.raw`^\s*${escapeRe(key)}\s*:\s*`).exec(s.slice(x, y));
      if (m !== null) return this.literalSpan(f, x + m[0].length, y);
      if (new RegExp(String.raw`^\s*${escapeRe(key)}\s*$`).test(s.slice(x, y))) {
        return f.ix.strings.get(key) ?? null; // shorthand of a string constant
      }
    }
    return null;
  }

  /**
   * `name` destructured from a parameter of an enclosing named function: its values are that
   * property's literal at EVERY call site. `undefined` = not a kit option; `null` = it is one, and a
   * call site does not pin it to a literal.
   */
  kitOptionValues(f: File, at: number, name: string): Valued[] | null | undefined {
    for (const fn of enclosingFns(f.ix, at)) {
      const option = this.optionOf(f, fn, name);
      if (option === undefined) continue;
      if (fn.name === null) return null;
      const calls = this.files.flatMap((g) =>
        g === f || fn.exported
          ? callsOf(g.p.blank, fn.name ?? "", false).map((c) => ({ g, c }))
          : [],
      );
      if (calls.length === 0) return null;
      const values: Valued[] = [];
      for (const { g, c } of calls) {
        const arg = splitGroup(g.p.blank, c.open)[option.paramIndex];
        const v = arg === undefined ? null : this.propertyLiteral(g, arg[0], option.key);
        if (v === null) return null;
        values.push({ value: v, origin: g.p.rel });
      }
      return values;
    }
    return undefined;
  }

  optionOf(f: File, fn: FnInfo, name: string): { paramIndex: number; key: string } | undefined {
    for (const [i, param] of fn.params.entries()) {
      const b = param.pattern.find((x) => x.local === name);
      if (b !== undefined) return { paramIndex: i, key: b.key };
    }
    for (const d of f.ix.destructurings) {
      if (d.at < fn.bodyStart || d.at > fn.bodyEnd) continue;
      const b = d.bindings.find((x) => x.local === name);
      const rhs = f.p.blank.slice(d.rhsStart, d.rhsEnd).trim();
      const paramIndex = fn.params.findIndex((p) => p.name === rhs);
      if (b !== undefined && paramIndex >= 0) return { paramIndex, key: b.key };
    }
    return undefined;
  }

  // -- fail-closed checks ---------------------------------------------------------------------

  /**
   * Whether `o` is at the TOP level of a declaration's initializer: the only position where a
   * registrar reference is an alias {@link registrarValueKind} binds. A reference nested inside the
   * initializer (`const x = wrap(registerWriteTool)`) is a hand-off the scan does not follow.
   */
  isTopLevelOfInit(f: File, o: number): boolean {
    const s = f.p.blank;
    const spans = [
      ...f.ix.declarations.map((d) => [d.initStart, d.initEnd] as const),
      ...f.ix.destructurings.map((d) => [d.rhsStart, d.rhsEnd] as const),
    ];
    return spans.some(([x, y]) => {
      if (o < x || o >= y) return false;
      let depth = 0;
      for (let i = x; i < o; i++) {
        const c = s.charAt(i);
        if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c)) depth--;
      }
      return depth === 0;
    });
  }

  /** A registrar or factory used as a value somewhere the flow does not follow. */
  checkEscapes(f: File): void {
    const s = f.p.blank;
    const inImport = (o: number): boolean => f.ix.imports.some(([x, y]) => x <= o && o < y);
    for (const name of this.registrarsIn(f).keys()) {
      for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`, "g"))) {
        const o = m.index ?? 0;
        if (!isTrackedUse(s, o, name.length) && !this.isTopLevelOfInit(f, o)) {
          this.violation(f, o, `registrar \`${name}\` is used as a value the scan does not follow`);
        }
      }
    }
    for (const key of this.state.keys) {
      for (const m of s.matchAll(new RegExp(`\\.\\s*${escapeRe(key)}(?![\\w$])`, "g"))) {
        const o = (m.index ?? 0) + m[0].length - key.length;
        const next = s.charAt(skipWs(s, o + key.length));
        if (next !== "(" && next !== "<" && !this.isTopLevelOfInit(f, o)) {
          this.violation(
            f,
            o,
            `registrar property \`.${key}\` is read somewhere the scan does not follow`,
          );
        }
      }
    }
    for (const factory of this.state.factories.keys()) {
      for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(factory)}(?![\\w$])`, "g"))) {
        const o = m.index ?? 0;
        const before = s.slice(Math.max(0, o - 40), o);
        const after = s.slice(o + factory.length, o + factory.length + 40);
        if (inImport(o)) {
          if (/^\s+as\b/.test(after))
            this.violation(f, o, `\`${factory}\` is imported under an alias`);
          continue;
        }
        if (/\bfunction\s*\*?\s*$/.test(before) || /\btypeof\s+$/.test(before)) continue;
        if (!/^\s*[<(]/.test(after)) {
          this.violation(f, o, `registrar factory \`${factory}\` is used as a value`);
        } else if (!this.isTopLevelOfInit(f, o) && !isKeyedValue(s, o)) {
          this.violation(f, o, `registrar factory \`${factory}\`'s result is not bound to a name`);
        }
      }
    }
  }

  /** Every `mutates:` literal must sit in a recognised registration, a table one used, or a const one passed. */
  checkMutates(f: File): void {
    const s = f.p.blank;
    const spans = this.callSpans.get(f.p.rel) ?? [];
    const tables = this.tablesUsed.get(f.p.rel) ?? new Set<number>();
    const inSpan = (o: number): boolean => spans.some(([x, y]) => x < o && o < y);
    const inTable = (o: number): boolean =>
      [...tables].some((open) => open < o && o < matchForward(s, open));
    const inPassedConst = (o: number): boolean =>
      f.ix.declarations.some(
        (d) =>
          d.initStart <= o &&
          o < d.initEnd &&
          spans.some(([x, y]) =>
            new RegExp(`(?<![\\w$.])${escapeRe(d.name)}(?![\\w$])`).test(s.slice(x, y)),
          ),
      );
    for (const m of s.matchAll(/(?<![\w$.])mutates\s*:\s*/g)) {
      const o = m.index ?? 0;
      if (!"\"'`".includes(f.p.code.charAt(o + m[0].length))) continue;
      if (!inSpan(o) && !inTable(o) && !inPassedConst(o)) {
        this.violation(f, o, "a `mutates:` write declaration no recognised registration consumes");
      }
    }
  }
}

/** Offset of the innermost bracket still open at `o`, or -1 at the top level. */
function innermostOpener(s: string, o: number): number {
  let depth = 0;
  for (let i = o - 1; i >= 0; i--) {
    const c = s.charAt(i);
    if (CLOSE.includes(c)) depth++;
    else if (OPEN.includes(c) && depth-- === 0) return i;
  }
  return -1;
}

/** `{ key: <o>...` — the value of an object-literal property. */
function isKeyedValue(s: string, o: number): boolean {
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
function isTrackedUse(s: string, o: number, len: number): boolean {
  const before = s.slice(Math.max(0, o - 40), o);
  const after = s.slice(o + len, o + len + 40);
  if (/^\s*[<(]/.test(after)) return true;
  if (/\b(?:const|let|var)\s+$/.test(before) || /\bfunction\s*\*?\s*$/.test(before)) return true;
  if (/\btypeof\s+$/.test(before)) return true;
  const at = innermostOpener(s, o);
  const opener = s.charAt(at);
  const typedOrKey = /^\s*\??\s*:/.test(after);
  if (opener === "{") {
    if (/\bexport\s*(?:type\s*)?$/.test(s.slice(Math.max(0, at - 20), at))) return false;
    const memberLead = /(?:[{,;]|\breadonly)\s*$/.test(before);
    if (memberLead && (typedOrKey || /^\s*[,}]/.test(after))) return true;
    return /:\s*$/.test(before) && /^\s*[,}]/.test(after);
  }
  return opener === "(" && /(?:[(,]|\breadonly)\s*$/.test(before) && typedOrKey;
}

/** Snapshot of everything discovery can grow, to detect the fixpoint. */
function fingerprint(state: State): string {
  const locals = [...state.locals].map(([f, m]) => `${f}=${[...m.keys()].sort().join(",")}`);
  return [
    [...state.factories.keys()].sort().join(","),
    [...state.keys].sort().join(","),
    [...state.exported.keys()].sort().join(","),
    locals.sort().join(";"),
  ].join("|");
}

/**
 * Derive every write-tool registration in `sources`. Discovery runs to a fixpoint (a forwarder
 * found in one pass makes its call sites registrations in the next); the result and every
 * violation come from the final, converged pass.
 */
export function scanWriteToolRegistrations(sources: readonly PackageSource[]): WriteToolScan {
  const files: File[] = sources.map((src) => {
    const p = prepare(src);
    return { p, ix: indexFile(p) };
  });
  const state: State = {
    factories: new Map([[ROOT_REGISTRAR_FACTORY, "root"]]),
    keys: new Set(),
    locals: new Map(),
    exported: new Map(),
  };
  for (let pass = 0; pass < 25; pass++) {
    const before = fingerprint(state);
    const analysis = new Analysis(state, files);
    for (const f of files) analysis.discoverBindings(f);
    for (const f of files) analysis.scanCalls(f);
    if (fingerprint(state) !== before) continue;
    for (const f of files) {
      if (!isBalanced(f.p.blank)) {
        analysis.violation(
          f,
          0,
          "brackets do not balance after stripping — the scan lost its place",
        );
      }
      analysis.checkEscapes(f);
      analysis.checkMutates(f);
    }
    return { registrations: analysis.registrations, violations: analysis.violations };
  }
  return {
    registrations: [],
    violations: [{ file: "(package)", line: 0, reason: "registrar discovery did not converge" }],
  };
}
