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
 * miss every tool added through them.
 *
 * The flow it follows: a name bound to a registrar factory (`createWriteToolRegistrar`, or a kit
 * factory discovered by the forwarding arrow it returns) is a registrar; so is an alias of one, a
 * property it is handed off under (`{ registerWriteTool }`, `opts.registerWriteTool`), any property
 * or parameter typed `*WriteToolRegistrar`, and any function that forwards its FIRST parameter to a
 * registrar, whatever it is called. Calls of those names are registrations. A shared KIT — a
 * function that builds each registered id from an option its caller passes
 * (`registerEmailConnectorTools({ toolPrefix, registerWriteTool })`) — registers one id per call
 * site, read from that call. An EXPORTED registrar, forwarder, factory or kit is followed through
 * every import shape that keeps its name: a named import, a member of a namespace or dynamic import
 * (`kit.registerStatusTool(...)`, or an alias of that member), and a destructuring that takes it,
 * renamed or not (`const { registerStatusTool: reopen } = await import("./status.ts")`).
 *
 * Every shape the scan cannot follow is a VIOLATION rather than a silent skip:
 *
 *   - a registration whose tool id is not a literal, a template over constants, a loop over a
 *     constant table, or a string constant;
 *   - a registrar used as a value anywhere the flow above does not follow: passed positionally,
 *     stored in an array, listed in an `export { ... }` clause or an aliased import, or read off an
 *     object and neither called nor bound;
 *   - a registrar factory whose result is not bound to a name or handed off under a property key;
 *   - a kit used other than by a call, its declaration or a plain (unaliased) import — its callers
 *     decide the ids it registers, so a caller reaching it any other way would go unseen;
 *   - a registrar, forwarder, factory or kit exported as the DEFAULT, which an importer binds under
 *     a name of its own choosing;
 *   - a namespace import of a module that exports one, used other than as `ns.member`; that module
 *     re-exported as a namespace; and a dynamic `import()` / `require()` of it that is not
 *     destructured, bound to a name used only as `m.member`, or dereferenced on the spot. A module
 *     specifier the scan cannot resolve (a non-literal, or a package path it does not read) counts
 *     as one that may export a registrar;
 *   - a string literal equal to a registrar, forwarder, factory or registrar-key name: a computed
 *     member access such as `regs["registerWriteTool"]`;
 *   - an exported registrar, forwarder or factory that no file names outside its own declaration,
 *     which is either reached in a shape the scan cannot see or dead;
 *   - a `mutates:` literal (the action type `WriteToolConfig` requires of every write) that no
 *     recognised registration consumes, which is how a registration in an unrecognised shape shows
 *     up even when nothing else about it does;
 *   - a file whose brackets do not balance after stripping, i.e. the stripper lost its place.
 *
 * STATED BOUND, what it still cannot see: an object a registrar was handed off into, read other than
 * by its key — a computed member access whose key is NOT a string literal (`regs[key](...)`), or
 * reflection over the object (`Object.values(regs)`). The `mutates:` check catches such a call only
 * when the call itself carries a `mutates:` literal, which a positional forwarder's call does not. A
 * tool that mutates while registered as a READ is outside the scan altogether.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, sep } from "node:path";
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

/** +1 for a bracket that opens inside a type (generics included), -1 for one that closes. */
function typeDepthDelta(c: string): number {
  if (OPEN.includes(c) || c === "<") return 1;
  if (CLOSE.includes(c) || c === ">") return -1;
  return 0;
}

/** Past a type annotation (after its `:`), to the `=` it ends at; -1 when it is not followed by one. */
function skipTypeToAssign(s: string, i: number): number {
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
function parenAngleDelta(c: string): number {
  if ("([<".includes(c)) return 1;
  return ")]>".includes(c) ? -1 : 0;
}

/** An object TYPE literal can follow these; a `{` after anything else opens a function body. */
const OBJECT_TYPE_LEADS = ":|&,";

/** The bracket closing the one at `open`, or the end of `s` when it never closes. */
function closeOrEnd(s: string, open: number): number {
  const close = matchForward(s, open);
  return close < 0 ? s.length : close;
}

/** Past a return-type annotation (after its `:`), to the `{` that opens the body; -1 if none. */
function skipReturnTypeToBody(s: string, i: number): number {
  let depth = 0;
  let prev = ":";
  for (let j = skipWs(s, i); j < s.length; j = skipWs(s, j + 1)) {
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
  /** The pattern's `{`. */
  readonly open: number;
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

/** One element of an object pattern: `key`, `key: local`, either with a default. */
const PATTERN_ELEMENT = new RegExp(
  String.raw`^\s*(${IDENT})\s*(?::\s*(${IDENT}))?\s*(?:=[\s\S]*)?$`,
);

function parsePattern(s: string, open: number): Binding[] {
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
function isSimplePattern(s: string, open: number): boolean {
  return splitGroup(s, open).every(([a, b]) => PATTERN_ELEMENT.test(s.slice(a, b)));
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
      open,
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

/**
 * After `function name` (at `i`): the parameter list's `(` and the body's `{`, past any type
 * parameters and return type — or null when what follows is not a function with a body.
 */
function functionHeadAt(s: string, i: number): { paramsOpen: number; bodyStart: number } | null {
  const paramsOpen = s.charAt(i) === "<" ? skipWs(s, skipAngles(s, i)) : i;
  if (paramsOpen < 0 || s.charAt(paramsOpen) !== "(") return null;
  const paramsClose = matchForward(s, paramsOpen);
  if (paramsClose < 0) return null;
  const j = skipWs(s, paramsClose + 1);
  const bodyStart = s.charAt(j) === ":" ? skipReturnTypeToBody(s, j + 1) : j;
  return bodyStart >= 0 && s.charAt(bodyStart) === "{" ? { paramsOpen, bodyStart } : null;
}

/** A declaration `function name` is bound to `name`, exported when `export` precedes it. */
function namedFunctionContext(
  s: string,
  at: number,
  name: string,
): Omit<FnInfo, "params" | "bodyStart" | "bodyEnd"> {
  const before = s.slice(Math.max(0, at - 40), at);
  return {
    name,
    exported: /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(before),
    returned: false,
  };
}

function functionDeclarationsOf(s: string): FnInfo[] {
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
      bodyStart: head.bodyStart,
      bodyEnd: matchForward(s, head.bodyStart),
    });
  }
  return out;
}

/** End of a body starting at `b`: its matching `}` for a block, else the expression's end. */
function blockOrExpressionEnd(s: string, b: number): number {
  return s.charAt(b) === "{" ? matchForward(s, b) : expressionEnd(s, b);
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

/** Where an arrow's head starts: the `<` of `<T>(...)` when it is generic, else its `(`. */
function genericStart(s: string, open: number): number {
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

/** The parameters and head start of the arrow function whose `=>` is at `arrow`, or null. */
function arrowHead(s: string, arrow: number): { params: Param[]; headStart: number } | null {
  const open = arrowParamsOpen(s, arrow);
  if (open >= 0) return { params: parseParams(s, open), headStart: genericStart(s, open) };
  const single = new RegExp(`(${IDENT})\\s*$`).exec(s.slice(Math.max(0, arrow - 80), arrow));
  if (single?.[1] === undefined) return null;
  return { params: [{ name: single[1], pattern: [] }], headStart: arrow - single[0].length };
}

function arrowFunctionsOf(s: string): FnInfo[] {
  const out: FnInfo[] = [];
  for (let arrow = s.indexOf("=>"); arrow >= 0; arrow = s.indexOf("=>", arrow + 2)) {
    const head = arrowHead(s, arrow);
    if (head === null) continue;
    const b = skipWs(s, arrow + 2);
    out.push({
      ...headContext(s, head.headStart),
      params: head.params,
      bodyStart: b,
      bodyEnd: blockOrExpressionEnd(s, b),
    });
  }
  return out;
}

/** A for-of binding starting at `i`: a destructuring pattern or one identifier, and its end. */
function loopBinding(
  s: string,
  i: number,
  limit: number,
): { ident: string | null; pattern: Binding[]; end: number } | null {
  if (s.charAt(i) === "{")
    return { ident: null, pattern: parsePattern(s, i), end: matchForward(s, i) + 1 };
  const id = new RegExp(`^${IDENT}`).exec(s.slice(i, limit));
  return id === null ? null : { ident: id[0], pattern: [], end: i + id[0].length };
}

function forOfLoopsOf(s: string): ForOf[] {
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

/** Identifiers that START at bracket depth 0 of `s[start, end)`, with their offsets. */
function topLevelWords(s: string, start: number, end: number): Array<{ at: number; word: string }> {
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
  /**
   * Kit functions: functions a registration's id is built inside from an option EVERY CALLER
   * supplies (`registerEmailConnectorTools({ toolPrefix, registerWriteTool })`). The callers decide
   * the ids, so every use of a kit must be a call the scan reads.
   */
  readonly kits = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly byRel: ReadonlyMap<string, File>;

  constructor(
    readonly state: State,
    readonly files: readonly File[],
  ) {
    this.byRel = new Map(files.map((f) => [f.p.rel, f]));
  }

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

  /**
   * What a member access `.name` reaches: a registrar handed off under that key
   * (`opts.registerWriteTool`), or an exported registrar or forwarder read off its module — a
   * namespace or dynamic import (`kit.registerStatusTool`).
   */
  memberKind(name: string): RegistrarKind | undefined {
    return this.state.keys.has(name) ? "kit-alias" : this.state.exported.get(name);
  }

  /** Every name a member access can reach a registrar through. */
  memberNames(): Set<string> {
    return new Set([...this.state.keys, ...this.state.exported.keys()]);
  }

  // -- discovery ------------------------------------------------------------------------------

  /** Bind names to registrars: factory results, aliases, destructured or typed registrar keys. */
  discoverBindings(f: File): void {
    this.discoverTypedKeys(f);
    this.discoverDeclaredRegistrars(f);
    this.discoverDestructuredRegistrars(f);
    this.discoverHandOffKeys(f);
  }

  /** A property or parameter typed `*WriteToolRegistrar` names a registrar key, and a local. */
  discoverTypedKeys(f: File): void {
    const locals = this.localsOf(f);
    const typed = new RegExp(
      String.raw`(?<![\w$.])(${IDENT})\s*\??\s*:\s*(?:Readonly<\s*)?[A-Za-z_$]*WriteToolRegistrar\b`,
      "g",
    );
    for (const m of f.p.blank.matchAll(typed)) {
      const name = m[1] ?? "";
      this.state.keys.add(name);
      if (!locals.has(name)) locals.set(name, "kit-alias");
    }
  }

  /** `const name = <registrar-valued expression>`; an exported one is callable from any file. */
  discoverDeclaredRegistrars(f: File): void {
    for (const d of f.ix.declarations) {
      const kind = this.registrarValueKind(f, d.initStart, d.initEnd);
      if (kind === undefined) continue;
      const target = isExportedAt(f.p.blank, d.at) ? this.state.exported : this.localsOf(f);
      if (!target.has(d.name)) target.set(d.name, kind);
    }
  }

  /**
   * `const { registerWriteTool } = opts` and `({ registerWriteTool }) =>` take a registrar key;
   * `const { registerStatusTool: reopen } = await import("./status.ts")` takes an exported one.
   */
  discoverDestructuredRegistrars(f: File): void {
    const locals = this.localsOf(f);
    const patterns = [
      ...f.ix.destructurings.map((d) => d.bindings),
      ...f.ix.fns.flatMap((fn) => fn.params.map((p) => p.pattern)),
    ];
    for (const b of patterns.flat()) {
      const kind = this.memberKind(b.key);
      if (kind !== undefined && !locals.has(b.local)) locals.set(b.local, kind);
    }
  }

  /** Hand-offs: `{ registerWriteTool }` / `{ key: registerWriteTool }` make the key a registrar key. */
  discoverHandOffKeys(f: File): void {
    for (const name of this.registrarsIn(f).keys()) {
      const re = new RegExp(
        String.raw`(?:[{,]\s*${escapeRe(name)}\s*(?=[,}])|(?<![\w$.])(${IDENT})\s*:\s*${escapeRe(name)}\s*(?=[,}]))`,
        "g",
      );
      for (const m of f.p.blank.matchAll(re)) this.state.keys.add(m[1] ?? name);
    }
  }

  /**
   * The registrar kind an expression evaluates to at its top level: a factory call, a registrar
   * name, or a registrar key read off an object (`options.registerWriteTool ?? create...(...)`).
   */
  registrarValueKind(f: File, start: number, end: number): RegistrarKind | undefined {
    const registrars = this.registrarsIn(f);
    let found: RegistrarKind | undefined;
    for (const { at, word } of topLevelWords(f.p.blank, start, end)) {
      const hit = this.wordRegistrarKind(f.p.blank, at, word, registrars);
      if (hit?.call === true) return hit.kind; // a factory CALL decides it outright
      found ??= hit?.kind;
    }
    return found;
  }

  /**
   * What one top-level word contributes: a factory call (bare, or a member of a namespace or
   * dynamic import, `kit.createWriteToolRegistrar(...)`), a registrar value, or nothing.
   */
  wordRegistrarKind(
    s: string,
    at: number,
    word: string,
    registrars: ReadonlyMap<string, RegistrarKind>,
  ): { readonly call: boolean; readonly kind: RegistrarKind } | undefined {
    const next = s.charAt(skipWs(s, at + word.length));
    const factory = this.state.factories.get(word);
    if (factory !== undefined && (next === "(" || next === "<")) {
      return { call: true, kind: factory };
    }
    if (next === "(") return undefined; // calling a registrar yields no registrar
    const member = s.charAt(skipWsBack(s, at - 1)) === ".";
    const kind = member ? this.memberKind(word) : registrars.get(word);
    return kind === undefined ? undefined : { call: false, kind };
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
    for (const name of this.memberNames()) {
      const kind = this.memberKind(name) ?? "kit-alias";
      for (const call of callsOf(s, name, true)) visit(call, kind);
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
      this.kits.add(fn.name);
      const calls = this.kitCalls(f, fn);
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

  /**
   * Every call of the kit function `fn` (declared in `f`): bare calls in its own file and, when it is
   * exported, bare or member calls in any file (`mailKit.registerEmailConnectorTools(...)` through
   * a namespace import).
   */
  kitCalls(f: File, fn: FnInfo): Array<{ readonly g: File; readonly c: CallSite }> {
    const name = fn.name ?? "";
    return this.files.flatMap((g) => {
      if (g !== f && !fn.exported) return [];
      const members = fn.exported ? callsOf(g.p.blank, name, true) : [];
      return [...callsOf(g.p.blank, name, false), ...members].map((c) => ({ g, c }));
    });
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
    this.checkRegistrarEscapes(f);
    this.checkMemberEscapes(f);
    this.checkFactoryEscapes(f);
    this.checkKitEscapes(f);
    this.checkNameStrings(f);
  }

  /** Every bare use of a registrar name is a tracked use or a top-level alias. */
  checkRegistrarEscapes(f: File): void {
    const s = f.p.blank;
    for (const name of this.registrarsIn(f).keys()) {
      for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`, "g"))) {
        const o = m.index ?? 0;
        if (!isTrackedUse(s, o, name.length) && !this.isTopLevelOfInit(f, o)) {
          this.violation(f, o, `registrar \`${name}\` is used as a value the scan does not follow`);
        }
      }
    }
  }

  /**
   * Every `.name` read of a registrar key or of an exported registrar (off a namespace or dynamic
   * import) is a call or a top-level alias.
   */
  checkMemberEscapes(f: File): void {
    const s = f.p.blank;
    for (const name of this.memberNames()) {
      for (const m of s.matchAll(new RegExp(`\\.\\s*${escapeRe(name)}(?![\\w$])`, "g"))) {
        const o = (m.index ?? 0) + m[0].length - name.length;
        const next = s.charAt(skipWs(s, o + name.length));
        if (next !== "(" && next !== "<" && !this.isTopLevelOfInit(f, o)) {
          this.violation(
            f,
            o,
            `registrar property \`.${name}\` is read somewhere the scan does not follow`,
          );
        }
      }
    }
  }

  /**
   * A string spelling a registrar, forwarder, factory or registrar key is a computed member access
   * (`regs["registerWriteTool"]`, `kit["registerStatusTool"]`) the scan cannot follow. Only a
   * string that IS the name counts: a quote must open and close it in `blank` too.
   */
  checkNameStrings(f: File): void {
    const names = new Set([
      ...this.state.exported.keys(),
      ...this.state.factories.keys(),
      ...this.state.keys,
      ...this.kits,
    ]);
    for (const name of names) {
      for (const m of f.p.code.matchAll(new RegExp(`(["'\`])${escapeRe(name)}\\1`, "g"))) {
        const o = m.index ?? 0;
        if (isWholeStringLiteral(f.p, o, name.length)) {
          this.violation(f, o, `the string "${name}" names a registrar: a computed access`);
        }
      }
    }
  }

  /**
   * Every use of a kit function is a call the scan reads, its declaration, a plain (unaliased)
   * import of it, or a `typeof`. Its callers supply the ids it registers, so a caller reaching it
   * any other way — an aliased import, a hand-off as a value — would register ids nobody sees.
   */
  checkKitEscapes(f: File): void {
    for (const name of this.kits) {
      const re = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, "g");
      for (const m of f.p.blank.matchAll(re)) {
        const o = m.index ?? 0;
        if (!isKitUse(f, o, name)) {
          this.violation(
            f,
            o,
            `kit \`${name}\`, whose callers supply its write-tool ids, is used as a value the scan does not follow`,
          );
        }
      }
    }
  }

  /**
   * Every use of a registrar factory is a bound call, its definition, or a plain import — bare, or
   * read off a namespace or dynamic import (`kit.createWriteToolRegistrar`).
   */
  checkFactoryEscapes(f: File): void {
    for (const factory of this.state.factories.keys()) {
      const re = new RegExp(`(?<![\\w$])${escapeRe(factory)}(?![\\w$])`, "g");
      for (const m of f.p.blank.matchAll(re)) {
        const o = m.index ?? 0;
        const reason = this.factoryUseViolation(f, o, factory);
        if (reason !== undefined) this.violation(f, o, reason);
      }
    }
  }

  /** Why the factory name at `o` escapes the scan, or undefined when the use is followed. */
  factoryUseViolation(f: File, o: number, factory: string): string | undefined {
    const s = f.p.blank;
    const before = s.slice(Math.max(0, o - 40), o);
    const after = s.slice(o + factory.length, o + factory.length + 40);
    if (f.ix.imports.some(([x, y]) => x <= o && o < y)) {
      return /^\s+as\b/.test(after) ? `\`${factory}\` is imported under an alias` : undefined;
    }
    if (/\bfunction\s*\*?\s*$/.test(before) || /\btypeof\s+$/.test(before)) return undefined;
    if (!/^\s*[<(]/.test(after)) return `registrar factory \`${factory}\` is used as a value`;
    if (this.isTopLevelOfInit(f, o) || isKeyedValue(s, o)) return undefined;
    return `registrar factory \`${factory}\`'s result is not bound to a name`;
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

  // -- module shapes: how another file reaches an exported registrar --------------------------

  /** Default exports, namespace imports and re-exports, and dynamic imports. */
  checkModuleShapes(f: File): void {
    this.checkDefaultExports(f);
    this.checkNamespaceImports(f);
    this.checkDynamicImports(f);
  }

  /** An exported registrar or forwarder, a registrar factory, or a kit function. */
  isTrackedExport(name: string | null): boolean {
    return (
      name !== null &&
      (this.state.exported.has(name) || this.state.factories.has(name) || this.kits.has(name))
    );
  }

  /** `export default function NAME`: an importer calls NAME under a name of its own choosing. */
  checkDefaultExports(f: File): void {
    for (const m of f.p.blank.matchAll(DEFAULT_EXPORTED_FUNCTION)) {
      const name = m[1] ?? "";
      if (this.isTrackedExport(name)) {
        this.violation(
          f,
          m.index ?? 0,
          `registrar \`${name}\` is a default export, which an importer may bind under any name`,
        );
      }
    }
  }

  /**
   * `import * as kit from` a module that may export a registrar: `kit` may only be read as
   * `kit.member`, which the member flow follows. Re-exporting such a module as a namespace puts it
   * behind a name of the re-exporter's choosing, so that is refused outright.
   */
  checkNamespaceImports(f: File): void {
    const s = f.p.blank;
    for (const m of s.matchAll(NAMESPACE_IMPORT)) {
      const end = (m.index ?? 0) + m[0].length;
      if (this.mayExportRegistrar(f, stringLiteralAt(f.p, end)?.value ?? null)) {
        this.checkModuleObjectUses(f, m[1] ?? "", [m.index ?? 0, end]);
      }
    }
    for (const m of s.matchAll(NAMESPACE_REEXPORT)) {
      const end = (m.index ?? 0) + m[0].length;
      if (this.mayExportRegistrar(f, stringLiteralAt(f.p, end)?.value ?? null)) {
        this.violation(
          f,
          m.index ?? 0,
          `a module that may export a registrar is re-exported as the namespace \`${m[1] ?? ""}\``,
        );
      }
    }
  }

  /**
   * A runtime `import()` / `require()` of a module that may export a registrar must hand its module
   * object to a shape the member flow follows: a destructuring, a name read only as `m.member`, or
   * a `.member` taken on the spot. A discarded one, a side-effect import, reaches no export at all.
   */
  checkDynamicImports(f: File): void {
    const s = f.p.blank;
    for (const d of dynamicImportsOf(f.p)) {
      if (!this.mayExportRegistrar(f, d.spec)) continue;
      const v = dynamicImportValue(s, d);
      if ((v.module && isMemberRead(s, v.end)) || isDiscarded(s, v.start, v.end)) continue;
      const binding = v.module ? this.bindingOf(f, v.start, v.end) : undefined;
      if (binding === "destructuring") continue;
      if (binding === undefined) {
        this.violation(
          f,
          d.at,
          "a dynamic import of a module that may export a registrar is used in a shape the scan does not follow",
        );
      } else {
        this.checkModuleObjectUses(f, binding.name, binding.span);
      }
    }
  }

  /**
   * The declaration whose whole initializer is `[start, end)`: a name, or a destructuring whose
   * every element {@link discoverDestructuredRegistrars} reads. undefined for anything else — a
   * computed key or a rest element included.
   */
  bindingOf(
    f: File,
    start: number,
    end: number,
  ):
    | "destructuring"
    | { readonly name: string; readonly span: readonly [number, number] }
    | undefined {
    const s = f.p.blank;
    const isWhole = (x: number, y: number): boolean =>
      x <= start && end <= y && s.slice(x, start).trim() === "" && s.slice(end, y).trim() === "";
    const d = f.ix.declarations.find((x) => isWhole(x.initStart, x.initEnd));
    if (d !== undefined) return { name: d.name, span: [d.at, d.initStart] };
    const pattern = f.ix.destructurings.find((x) => isWhole(x.rhsStart, x.rhsEnd));
    return pattern !== undefined && isSimplePattern(s, pattern.open) ? "destructuring" : undefined;
  }

  /** Every read of the module object `ns` outside its binding `[from, to)` is `ns.member` or a `typeof`. */
  checkModuleObjectUses(f: File, ns: string, [from, to]: readonly [number, number]): void {
    const s = f.p.blank;
    for (const m of s.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(ns)}(?![\\w$])`, "g"))) {
      const o = m.index ?? 0;
      const binding = o >= from && o < to;
      if (!binding && !isMemberRead(s, o + ns.length) && !isTypeofOperand(s, o)) {
        this.violation(
          f,
          o,
          `module object \`${ns}\` may hold a registrar and is used other than as \`${ns}.member\``,
        );
      }
    }
  }

  /**
   * Whether the module a specifier names may export a registrar: a package file that does, or one
   * the scan cannot resolve (a non-literal specifier, a relative path it does not read, a subpath
   * import, the package's own name). Another package (`zod`, `@nimbus-dev/sdk/...`) cannot: the
   * write registrar is this package's consent kit.
   */
  mayExportRegistrar(f: File, spec: string | null): boolean {
    if (spec === null) return true;
    if (spec.startsWith(".")) {
      const target = this.resolveModule(f, spec);
      return target === undefined || this.exportsRegistrar(target);
    }
    return (
      spec.startsWith("#") ||
      spec === CONNECTORS_PACKAGE ||
      spec.startsWith(`${CONNECTORS_PACKAGE}/`)
    );
  }

  /** The scanned file a relative specifier names, trying the extensions Bun would. */
  resolveModule(from: File, spec: string): File | undefined {
    const base = posix.normalize(posix.join(posix.dirname(from.p.rel), spec));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    return (
      this.byRel.get(base) ?? this.byRel.get(`${stem}.ts`) ?? this.byRel.get(`${stem}/index.ts`)
    );
  }

  /** Whether `f` declares, with `export`, a registrar, forwarder, registrar factory or kit. */
  exportsRegistrar(f: File): boolean {
    return (
      f.ix.fns.some((fn) => fn.exported && this.isTrackedExport(fn.name)) ||
      f.ix.declarations.some((d) => this.isTrackedExport(d.name) && isExportedAt(f.p.blank, d.at))
    );
  }

  /**
   * Every exported registrar, forwarder and registrar factory is NAMED by some file outside its own
   * declaration. One that nothing names is either reached in a shape the scan cannot see — the
   * default import or computed access the checks above refuse, or one nobody anticipated — or dead.
   */
  checkNamed(): void {
    const names = new Set([...this.state.exported.keys(), ...this.state.factories.keys()]);
    for (const name of names) {
      if (this.files.some((g) => namedOutsideDeclaration(g, name))) continue;
      const reason = `registrar \`${name}\` is named nowhere outside its declaration — reached in a shape the scan cannot see, or dead`;
      const site = this.declarationSite(name);
      if (site === undefined) this.violations.push({ file: "(package)", line: 0, reason });
      else this.violation(site.f, site.at, reason);
    }
  }

  /** Where `name` is declared: the first `function name` / `const name` the scan reads. */
  declarationSite(name: string): { readonly f: File; readonly at: number } | undefined {
    const re = new RegExp(String.raw`${DECLARATION_LEAD}${escapeRe(name)}(?![\w$])`);
    for (const f of this.files) {
      const m = re.exec(f.p.blank);
      if (m !== null) return { f, at: m.index };
    }
    return undefined;
  }
}

/** What introduces a declared name: `function` (generators too) or `const` / `let` / `var`. */
const DECLARATION_LEAD = String.raw`\b(?:function\s*\*?\s*|(?:const|let|var)\s+)`;

/** `export default function NAME`, async and generator forms included. */
const DEFAULT_EXPORTED_FUNCTION = new RegExp(
  String.raw`\bexport\s+default\s+(?:async\s+)?function\s*\*?\s*(${IDENT})`,
  "g",
);

/** `import * as ns from ` (after an optional default binding), up to the specifier's quote. */
const NAMESPACE_IMPORT = new RegExp(
  String.raw`\bimport\s+(?:${IDENT}\s*,\s*)?\*\s*as\s+(${IDENT})\s+from\s*`,
  "g",
);

/** `export * as ns from `, up to the specifier's quote. */
const NAMESPACE_REEXPORT = new RegExp(String.raw`\bexport\s+\*\s*as\s+(${IDENT})\s+from\s*`, "g");

/** A runtime module load: `import(...)` or `require(...)`, never a member `.import(`. */
const DYNAMIC_IMPORT = /(?<![\w$.])(import|require)\s*\(/g;

/** The members a PROMISE has; anything else read off an unawaited `import(...)` is a type. */
const PROMISE_METHODS: ReadonlySet<string> = new Set(["then", "catch", "finally"]);

interface DynamicImport {
  /** Offset of `import` / `require`. */
  readonly at: number;
  /** Offset of the call's `)`. */
  readonly close: number;
  readonly callee: string;
  /** The first argument when it is a plain string literal, else null. */
  readonly spec: string | null;
}

/** Every runtime `import(...)` / `require(...)` in `p`, never a type (`let x: import("m").T`). */
function dynamicImportsOf(p: Prepared): DynamicImport[] {
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
function firstStringArgument(p: Prepared, open: number): string | null {
  const first = splitGroup(p.blank, open)[0];
  if (first === undefined) return null;
  const lit = stringLiteralAt(p, skipWs(p.blank, first[0]));
  return lit !== null && p.blank.slice(lit.end, first[1]).trim() === "" ? lit.value : null;
}

/**
 * `typeof import("m")`, or `import("m").T` read without an `await`: a TYPE, which loads nothing. A
 * runtime import is awaited, or chained with a promise method.
 */
function isTypeImport(s: string, at: number, close: number): boolean {
  if (isTypeofOperand(s, at)) return true;
  if (/\bawait\s*\(?\s*$/.test(s.slice(Math.max(0, at - 20), at))) return false;
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
function dynamicImportValue(
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
function isGroupingParen(s: string, open: number): boolean {
  return !/[\w$)\]]/.test(s.charAt(skipWsBack(s, open - 1)));
}

/** Whether `[start, end)` is a whole expression statement, its value discarded (`void` allowed). */
function isDiscarded(s: string, start: number, end: number): boolean {
  const lead = /\bvoid\s*$/.exec(s.slice(Math.max(0, start - 10), start));
  const prev = s.charAt(skipWsBack(s, start - (lead?.[0].length ?? 0) - 1));
  const next = s.charAt(skipWs(s, end));
  return (prev === "" || "{};".includes(prev)) && (next === "" || "};".includes(next));
}

/** Whether a `.member` (or `?.member`) read follows offset `end`. */
function isMemberRead(s: string, end: number): boolean {
  return /^\s*\??\.\s*[A-Za-z_$]/.test(s.slice(end, end + 40));
}

/** Whether the word at `o` is the operand of `typeof`. */
function isTypeofOperand(s: string, o: number): boolean {
  return /\btypeof\s+$/.test(s.slice(Math.max(0, o - 20), o));
}

/** Whether the declaration starting at `at` (its `const`, `let` or `var`) is `export`ed. */
function isExportedAt(s: string, at: number): boolean {
  return /\bexport\s+$/.test(s.slice(Math.max(0, at - 20), at));
}

/** Whether a string literal of exactly `len` characters opens at `o` — real quotes in `blank`. */
function isWholeStringLiteral(p: Prepared, o: number, len: number): boolean {
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
function isKitUse(f: File, o: number, name: string): boolean {
  const s = f.p.blank;
  const before = s.slice(Math.max(0, o - 20), o);
  const after = s.slice(o + name.length, o + name.length + 40);
  if (/^\s*[<(]/.test(after)) return true;
  if (/\.\s*$/.test(before)) return false;
  if (new RegExp(`${DECLARATION_LEAD}$`).test(before) || isTypeofOperand(s, o)) return true;
  return f.ix.imports.some(([x, y]) => x <= o && o < y) && !/^\s+as\b/.test(after);
}

/** Whether `g` names `name` anywhere but a declaration of it or an import binding it. */
function namedOutsideDeclaration(g: File, name: string): boolean {
  const s = g.p.blank;
  const lead = new RegExp(`${DECLARATION_LEAD}$`);
  for (const m of s.matchAll(new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, "g"))) {
    const o = m.index ?? 0;
    if (lead.test(s.slice(Math.max(0, o - 20), o))) continue;
    if (g.ix.imports.some(([x, y]) => x <= o && o < y)) continue;
    return true;
  }
  return false;
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
      analysis.checkModuleShapes(f);
    }
    analysis.checkNamed();
    return { registrations: analysis.registrations, violations: analysis.violations };
  }
  return {
    registrations: [],
    violations: [{ file: "(package)", line: 0, reason: "registrar discovery did not converge" }],
  };
}
