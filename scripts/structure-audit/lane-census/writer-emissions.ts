import { stripComments } from "../lib.ts";

/**
 * One production WRITE site: an object literal, found anywhere in a connector (or the deployment
 * annotation path), that carries both a `service:` and a `type:` property — the shape every
 * `ctx.upsertItem({...})` call site (and every helper that builds and returns the object one of
 * those calls passes through) uses. This is the write-side counterpart to `read-sites.ts`'s
 * `ReadTriple`: Task 1.6 diffs the two to find a read predicate no writer ever emits.
 */
export type WriterEmission = {
  readonly service: string;
  readonly itemType: string;
  readonly metadataKeys: readonly string[];
  readonly file: string;
  readonly line: number;
};

/** Marks a `service`/`type` value this extractor could not resolve to a literal — see module doc below. */
const UNRESOLVED = "__UNRESOLVED__";

/**
 * The only two places a real item write can originate: the first-party connectors (one package,
 * bundled into the compiled binary — see `CLAUDE.md` § Subsystems) and the one non-connector path
 * that also inserts directly into `item`, `deployment/annotate.ts`.
 */
export const WRITER_INCLUDE: readonly string[] = [
  "packages/gateway/src/connectors/",
  "packages/gateway/src/deployment/annotate.ts",
];

/**
 * **This list is the one place the whole gate's correctness rests on a human decision no scanner
 * validates — read it that way, not as tidiness.**
 *
 * `packages/gateway/src/demo/corpus/acme.ts` writes a `github_actions:ci_run` whose `metadata` is
 * `{ conclusion, repo, headSha }` — including the `repo` key the REAL `github-actions-sync.ts`
 * does not write. If the demo corpus were in the writer corpus, the census would see `repo`
 * "emitted" for `ci_run`, conclude DORA's read of it is satisfied, and report that bug CLEAN. It
 * is not clean — `repo` has no production writer at all. Excluding `/demo/` is what keeps that
 * bug visible to Task 1.6 instead of papering over it with fixture data that merely resembles a
 * write. `/perf/`, `/agents/`, and `/test/fixtures/` are the same shape: synthetic or fixture data
 * that can carry a key production code never sets, manufacturing a false "this lane is covered."
 */
export const WRITER_EXCLUDE: readonly string[] = [
  "/demo/",
  "/perf/",
  "/agents/",
  "/test/fixtures/",
];

/** A single top-level property of an object literal, in whichever of the three real syntactic forms it took. */
type ObjectProp = { readonly key: string; readonly valueText: string | null };

/**
 * Extracts every production write site in `contents`: every object literal carrying both a
 * `service:` and a `type:` property, with `service`/`type` resolved to their literal string
 * value(s) and `metadata:` resolved to its top-level key names. Callers select which files to pass
 * in using `WRITER_INCLUDE`/`WRITER_EXCLUDE` — this function does no path filtering of its own, it
 * only parses whatever `contents` it is given.
 *
 * Anything that cannot be resolved is recorded as `itemType: "__UNRESOLVED__"` rather than
 * dropped — an unresolved writer must stay visible in the artifact, never silently vanish from it.
 */
export function extractWriterEmissions(file: string, contents: string): readonly WriterEmission[] {
  const src = stripComments(contents);
  const out: WriterEmission[] = [];

  for (const literal of findObjectLiterals(src)) {
    const props = parseTopLevelProps(literal.body);
    const serviceProp = props.find((p) => p.key === "service");
    const typeProp = props.find((p) => p.key === "type");
    if (serviceProp === undefined || typeProp === undefined) {
      continue;
    }

    const serviceValues = resolveStringValues(propValueExpr(serviceProp), src);
    const itemTypeValues = resolveStringValues(propValueExpr(typeProp), src);
    const metadataProp = props.find((p) => p.key === "metadata");
    const metadataKeys =
      metadataProp === undefined ? [] : resolveMetadataKeys(propValueExpr(metadataProp), src);
    const line = lineAt(src, literal.start);

    for (const service of serviceValues) {
      for (const itemType of itemTypeValues) {
        out.push({ service, itemType, metadataKeys, file, line });
      }
    }
  }

  return out;
}

/** A shorthand prop's "value" is an identifier of the same name as the key (`{ service }` ≡ `{ service: service }`). */
function propValueExpr(prop: ObjectProp): string {
  return prop.valueText ?? prop.key;
}

// ---------------------------------------------------------------------------------------------
// Object-literal discovery
// ---------------------------------------------------------------------------------------------

type ObjectLiteralSpan = { readonly start: number; readonly end: number; readonly body: string };

/**
 * A stack frame while scanning for `{ … }` spans. `skip` is inherited by every nested brace once
 * set, since none of a TypeScript `interface`/`type` body's nested shapes are a real value write
 * either — an `interface Foo { type: string }` reads exactly like a real write to a naive
 * key-scanner, and this is what keeps it from becoming a phantom `__UNRESOLVED__` row. The same
 * inheritance covers a destructuring pattern's own nested defaults.
 */
type BraceFrame = { readonly start: number; readonly skip: boolean };

/**
 * Finds every `{ … }` span in `src`, skipping the body of any TypeScript `interface`/`type` alias
 * declaration and any `const`/`let`/`var` destructuring pattern — neither is a value being
 * written, both are shaped exactly like one. Built fresh per call and iterative (no shared
 * module-level regex, no recursion) — Task 1.2's hazard: a shared `g`-flagged RegExp across
 * nested/recursive scans hangs `bun test` rather than failing it.
 */
function findObjectLiterals(src: string): readonly ObjectLiteralSpan[] {
  const out: ObjectLiteralSpan[] = [];
  const stack: BraceFrame[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(src, i);
      continue;
    }
    if (ch === "{") {
      const parent = stack[stack.length - 1];
      const skip = (parent?.skip ?? false) || isNonLiteralBraceContext(src, i);
      stack.push({ start: i, skip });
      i++;
      continue;
    }
    if (ch === "}") {
      const frame = stack.pop();
      if (frame !== undefined && !frame.skip) {
        out.push({ start: frame.start, end: i, body: src.slice(frame.start + 1, i) });
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/** `interface Name … {`, `type Name … = {`, or `const`/`let`/`var {` (destructuring) immediately before `bracePos`. */
function isNonLiteralBraceContext(src: string, bracePos: number): boolean {
  const windowStart = Math.max(0, bracePos - 400);
  const before = src.slice(windowStart, bracePos);
  if (
    /(?:^|[;{}\n])\s*(?:export\s+)?interface\s+[A-Za-z_$][\w$]*(?:<[^{]*>)?\s*(?:extends\s+[^{]*)?$/.test(
      before,
    )
  ) {
    return true;
  }
  if (/(?:^|[;{}\n])\s*(?:export\s+)?type\s+[A-Za-z_$][\w$]*(?:<[^=]*>)?\s*=\s*$/.test(before)) {
    return true;
  }
  if (/\b(?:const|let|var)\s*$/.test(before)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Object-literal property parsing — the three forms connectors actually use
// ---------------------------------------------------------------------------------------------

/**
 * Splits an object literal's body into its top-level properties and classifies each into one of
 * the three real syntactic shapes: explicit (`key: value`), quoted (`"key": value`), or shorthand
 * (`key` alone). Anything else at top level — a spread, a computed key, a method shorthand — is
 * silently skipped: none of those are a `service`/`type`/`metadata` property this gate cares about.
 */
function parseTopLevelProps(body: string): readonly ObjectProp[] {
  const out: ObjectProp[] = [];
  for (const raw of splitTopLevelCommas(body)) {
    const part = raw.trim();
    if (part === "" || part.startsWith("...")) {
      continue;
    }
    const quoted = /^(['"])((?:\\.|(?!\1)[\s\S])*)\1\s*:\s*([\s\S]*)$/.exec(part);
    if (quoted !== null) {
      out.push({ key: quoted[2] ?? "", valueText: (quoted[3] ?? "").trim() });
      continue;
    }
    const explicit = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]*)$/.exec(part);
    if (explicit !== null) {
      out.push({ key: explicit[1] ?? "", valueText: (explicit[2] ?? "").trim() });
      continue;
    }
    const shorthand = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part);
    if (shorthand !== null) {
      out.push({ key: shorthand[1] ?? "", valueText: null });
    }
  }
  return out;
}

/** Splits `text` on top-level commas only — depth tracked across `(){}[]`, strings/templates skipped whole. */
function splitTopLevelCommas(text: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(text, i);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
      i++;
      continue;
    }
    i++;
  }
  parts.push(text.slice(last));
  return parts;
}

// ---------------------------------------------------------------------------------------------
// `service:` / `type:` resolution
// ---------------------------------------------------------------------------------------------

/**
 * Resolves one `service:`/`type:` property value to its literal string form(s), in the order the
 * spec fixes: a string literal wins outright; failing that, a ternary of two string literals
 * yields BOTH branches; failing that, a bare identifier is looked up as a `const` declared
 * anywhere in the same file (module-level or local — a module-level `const NAME = "…" as const`
 * and a plain local `const name = "…";` are both just "a const" to this lookup, since the
 * presence of `as const` changes nothing about the resolved value) and resolved the same way,
 * recursively, one level. Anything still unresolved after that is `["__UNRESOLVED__"]` — recorded,
 * never dropped, so an unresolvable writer stays visible in the artifact.
 */
function resolveStringValues(exprTextRaw: string, src: string, depth = 0): readonly string[] {
  const exprText = stripTrailingAsConst(exprTextRaw.trim());

  const literal = matchStringLiteral(exprText);
  if (literal !== undefined) {
    return [literal];
  }

  const ternary = matchTernaryOfLiterals(exprText);
  if (ternary !== undefined) {
    return ternary;
  }

  if (depth === 0) {
    const ident = matchBareIdentifier(exprText);
    if (ident !== undefined) {
      const declExpr = findConstDeclarationExpr(ident, src);
      if (declExpr !== undefined) {
        return resolveStringValues(declExpr, src, depth + 1);
      }
    }
  }

  return [UNRESOLVED];
}

/** Strips a trailing ` as const` (TypeScript's const-assertion), which never changes the resolved value. */
function stripTrailingAsConst(text: string): string {
  return text.replace(/\s+as\s+const\s*$/, "").trim();
}

/** Whole-string match: is `text` exactly one quoted string literal? Returns its (raw, unescaped) contents. */
function matchStringLiteral(text: string): string | undefined {
  const m = /^(['"])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(text);
  if (m !== null) {
    return m[2] ?? "";
  }
  const tpl = /^`((?:\\.|[^`])*)`$/.exec(text);
  if (tpl !== null && !tpl[1]?.includes("${")) {
    return tpl[1] ?? "";
  }
  return undefined;
}

/** Whole-string match: is `text` exactly `<cond> ? "<a>" : "<b>"`? Returns `[a, b]`. */
function matchTernaryOfLiterals(text: string): readonly [string, string] | undefined {
  const m =
    /^[\s\S]+?\?\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1\s*:\s*(['"])((?:\\.|(?!\3)[\s\S])*)\3$/.exec(
      text,
    );
  if (m === null) {
    return undefined;
  }
  return [m[2] ?? "", m[4] ?? ""];
}

/** Whole-string match: is `text` exactly a bare identifier? */
function matchBareIdentifier(text: string): string | undefined {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text) ? text : undefined;
}

/** Whole-string match: is `text` exactly `calleeName(args…)`? Returns `calleeName`. */
function matchCallExpression(text: string): string | undefined {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\([\s\S]*\)$/.exec(text);
  return m?.[1];
}

/**
 * Finds the first `const NAME = <expr>;` in `text` (module-level or local — this is a whole-text
 * search, not scope-aware, which is the deliberate approximation this whole file makes: precise
 * enough for the flat, mostly-single-scope shape real connector files use, and consistent with
 * `alias-binding.ts`/`read-sites.ts`'s own regex-over-text approach rather than a real parser) and
 * returns the RHS expression text, up to the `;` that closes the statement at bracket depth 0 (so
 * an object/array/call literal's own internal `;`-free structure — or, for `metadata:`, simply the
 * lack of one — never truncates the capture early).
 */
function findConstDeclarationExpr(name: string, text: string): string | undefined {
  const re = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\b\\s*(?::[^=;]*)?=\\s*`);
  const m = re.exec(text);
  if (m === null) {
    return undefined;
  }
  const start = m.index + m[0].length;
  const end = findTopLevelSemicolon(text, start);
  return text.slice(start, end).trim();
}

/** Index of the first `;` at bracket depth 0 from `start`, or `text.length` if the statement never closes. */
function findTopLevelSemicolon(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(text, i);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (ch === ";" && depth === 0) {
      return i;
    }
    i++;
  }
  return text.length;
}

// ---------------------------------------------------------------------------------------------
// `metadata:` resolution — inline object, one-hop identifier, one-hop same-file call
// ---------------------------------------------------------------------------------------------

/**
 * Resolves a `metadata:` property value to its object literal's top-level key names. Three forms,
 * all confirmed in the real tree:
 *  - an inline object literal (`{ workflowName: name, conclusion, headSha }`) — read directly;
 *  - a bare identifier (`meta`) — one hop to `const meta = { … }` anywhere in the same file;
 *  - a call whose callee is defined in the same file (`buildPagerdutyMetadata(row, id, …)`) — one
 *    hop into the callee's body, reading either what it directly returns as an object literal, or
 *    (the shape `pagerduty-sync.ts` actually uses) a local variable the body assigns the object to
 *    and then returns by name — resolved by the SAME identifier lookup, scoped to the callee's own
 *    body first so it does not pick up an unrelated same-named const elsewhere in the file.
 * Anything else (a property-access expression, `a ?? b`, …) resolves to no keys — `[]`, not
 * `__UNRESOLVED__`: `__UNRESOLVED__` is reserved for `itemType`, since a writer with an
 * unresolvable TYPE cannot be attributed to any read lane at all, where a writer with unresolvable
 * metadata keys is still a real, attributable write with (as far as this extractor can tell) no
 * metadata — the same "record it as empty rather than invent a key" posture the spec calls out.
 */
function resolveMetadataKeys(exprTextRaw: string, src: string): readonly string[] {
  const exprText = exprTextRaw.trim();

  const direct = tryObjectLiteralTopLevelKeys(exprText);
  if (direct !== undefined) {
    return direct;
  }

  const ident = matchBareIdentifier(exprText);
  if (ident !== undefined) {
    const declExpr = findConstDeclarationExpr(ident, src);
    const keys = declExpr === undefined ? undefined : tryObjectLiteralTopLevelKeys(declExpr);
    return keys ?? [];
  }

  const callee = matchCallExpression(exprText);
  if (callee !== undefined) {
    return resolveMetadataKeysFromCall(callee, src);
  }

  return [];
}

/** If `text` (trimmed) is itself an object literal, its top-level key names; else `undefined`. */
function tryObjectLiteralTopLevelKeys(text: string): readonly string[] | undefined {
  const t = stripTrailingAsConst(text.trim());
  if (!t.startsWith("{")) {
    return undefined;
  }
  const close = findMatchingBrace(t, 0);
  if (close === -1) {
    return undefined;
  }
  return parseTopLevelProps(t.slice(1, close)).map((p) => p.key);
}

/**
 * One hop into `calleeName`'s own definition (function declaration or arrow, in `src`), reading
 * what it returns: an implicit-return object literal, an explicit `return { … };`, or — the shape
 * `pagerduty-sync.ts`'s `buildPagerdutyMetadata` uses — a `return name;` whose `name` is a `const`
 * declared inside that SAME function body (checked before falling back to a whole-file lookup, so
 * this does not accidentally resolve to an unrelated same-named const elsewhere in the file).
 */
function resolveMetadataKeysFromCall(calleeName: string, src: string): readonly string[] {
  const body = findFunctionBodyOrExpr(calleeName, src);
  if (body === undefined) {
    return [];
  }

  const direct = tryObjectLiteralTopLevelKeys(body);
  if (direct !== undefined) {
    return direct;
  }

  const returned = /\breturn\s+([\s\S]*?);/.exec(body)?.[1];
  if (returned === undefined) {
    return [];
  }
  const returnedTrimmed = returned.trim();

  const directReturn = tryObjectLiteralTopLevelKeys(returnedTrimmed);
  if (directReturn !== undefined) {
    return directReturn;
  }

  const ident = matchBareIdentifier(returnedTrimmed);
  if (ident === undefined) {
    return [];
  }
  const localDecl = findConstDeclarationExpr(ident, body) ?? findConstDeclarationExpr(ident, src);
  if (localDecl === undefined) {
    return [];
  }
  return tryObjectLiteralTopLevelKeys(localDecl) ?? [];
}

/**
 * Finds `name`'s function body text: for `function name(...) { … }` or a block-bodied arrow
 * `const name = (...) => { … }`, the block's contents; for an expression-bodied arrow with an
 * implicit object return (`const name = (...) => ({ … })`), the parenthesized expression itself.
 */
function findFunctionBodyOrExpr(name: string, src: string): string | undefined {
  const fnRe = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(`);
  const fnMatch = fnRe.exec(src);
  if (fnMatch !== null) {
    const parenOpen = fnMatch.index + fnMatch[0].length - 1;
    const parenClose = findMatchingParen(src, parenOpen);
    const braceOpen = parenClose === -1 ? -1 : src.indexOf("{", parenClose);
    const braceClose = braceOpen === -1 ? -1 : findMatchingBrace(src, braceOpen);
    return braceOpen !== -1 && braceClose !== -1 ? src.slice(braceOpen + 1, braceClose) : undefined;
  }

  const arrowRe = new RegExp(
    `\\bconst\\s+${escapeRegExp(name)}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?\\(`,
  );
  const arrowMatch = arrowRe.exec(src);
  if (arrowMatch === null) {
    return undefined;
  }
  const parenOpen = arrowMatch.index + arrowMatch[0].length - 1;
  const parenClose = findMatchingParen(src, parenOpen);
  if (parenClose === -1) {
    return undefined;
  }
  const afterParams = src.slice(parenClose + 1);
  const arrowHead = /^\s*(?::[\s\S]*?)?=>\s*/.exec(afterParams);
  if (arrowHead === null) {
    return undefined;
  }
  const bodyStart = parenClose + 1 + arrowHead[0].length;
  if (src[bodyStart] === "{") {
    const braceClose = findMatchingBrace(src, bodyStart);
    return braceClose === -1 ? undefined : src.slice(bodyStart + 1, braceClose);
  }
  if (src[bodyStart] === "(") {
    const pClose = findMatchingParen(src, bodyStart);
    return pClose === -1 ? undefined : src.slice(bodyStart + 1, pClose);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Low-level scanning primitives — local to this file, matching this directory's convention of
// each file carrying its own (rather than a shared, more-tempting-to-misuse-across-scopes) copy.
// ---------------------------------------------------------------------------------------------

/** Index one past the end of the single-/double-quoted string or backtick template starting at `i`. */
function skipStringOrTemplate(src: string, i: number): number {
  const quote = src[i];
  if (quote === "`") {
    const end = findTemplateEnd(src, i);
    return end === -1 ? src.length : end + 1;
  }
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) {
      return j + 1;
    }
    if (ch === "\n") {
      return i + 1;
    }
    j++;
  }
  return src.length;
}

/** Index of the backtick that closes the template literal opened at `start`, respecting nested `${ … }`. */
function findTemplateEnd(src: string, start: number): number {
  let i = start + 1;
  let interpDepth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (interpDepth === 0) {
      if (ch === "`") return i;
      if (ch === "$" && src[i + 1] === "{") {
        interpDepth = 1;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "{") interpDepth++;
    else if (ch === "}") interpDepth--;
    i++;
  }
  return -1;
}

/** Index of the `}` matching the `{` at `openIndex`, respecting strings/templates. */
function findMatchingBrace(src: string, openIndex: number): number {
  return findMatchingDelimiter(src, openIndex, "{", "}");
}

/** Index of the `)` matching the `(` at `openIndex`, respecting strings/templates. */
function findMatchingParen(src: string, openIndex: number): number {
  return findMatchingDelimiter(src, openIndex, "(", ")");
}

function findMatchingDelimiter(
  src: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(src, i);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 1-indexed line of `index`, counted as newlines seen before it, plus one. */
function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
