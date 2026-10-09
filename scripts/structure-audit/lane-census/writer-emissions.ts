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
 * The only places a real item write can originate: the first-party connectors (one package,
 * bundled into the compiled binary — see `CLAUDE.md` § Subsystems) and the two non-connector
 * paths that also insert directly into `item`, `deployment/annotate.ts` and `clips/`.
 *
 * `index/item-store.ts` is deliberately NOT here (A3 Ruling R2): its own `mime_type`/
 * `size_bytes`/`parent_id`/`created_at` writes are reached only through `LocalIndex.upsert`, which
 * has no production caller, so crediting them would manufacture coverage for keys nothing writes.
 */
export const WRITER_INCLUDE: readonly string[] = [
  "packages/gateway/src/connectors/",
  "packages/gateway/src/deployment/annotate.ts",
  // `clip-ingest.ts` writes `nimbus:web_clip` through `upsertIndexedItem`.
  "packages/gateway/src/clips/",
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
      metadataProp === undefined
        ? []
        : resolveMetadataKeys(propValueExpr(metadataProp), src, literal.start);
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
    const quoted = /^(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*:\s*([\s\S]*)$/.exec(part);
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

/**
 * Whole-string match: is `text` exactly one quoted string literal? Returns its (raw, unescaped)
 * contents.
 *
 * The two alternatives in each escape-aware group are kept disjoint (a backslash-escape `\\[\s\S]`
 * vs. "any other char" with backslash excluded) so the engine can never re-split the same input two
 * ways — an overlapping pair (e.g. `\\.` alongside a lookahead-only alternative that also accepts a
 * backslash) is exponential-backtracking-prone on a long run of unmatched escapes.
 */
function matchStringLiteral(text: string): string | undefined {
  const m = /^(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1$/.exec(text);
  if (m !== null) {
    return m[2] ?? "";
  }
  const tpl = /^`((?:\\[\s\S]|[^\\`])*)`$/.exec(text);
  if (tpl !== null && !tpl[1]?.includes("${")) {
    return tpl[1] ?? "";
  }
  return undefined;
}

/** Whole-string match: is `text` exactly `<cond> ? "<a>" : "<b>"`? Returns `[a, b]`. */
function matchTernaryOfLiterals(text: string): readonly [string, string] | undefined {
  const m =
    /^[\s\S]+?\?\s*(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*:\s*(['"])((?:\\[\s\S]|(?!\3)[^\\])*)\3$/.exec(
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

/** A `const NAME = <expr>;` match: the RHS text, plus where the statement ends (just past its `;`). */
type ConstDeclaration = { readonly exprText: string; readonly declEnd: number };

/**
 * Finds the first (given `before`, the nearest preceding) `const NAME = <expr>;` in `text` (module-level or local — this is a whole-text
 * search, not scope-aware, which is the deliberate approximation this whole file makes: precise
 * enough for the flat, mostly-single-scope shape real connector files use, and consistent with
 * `alias-binding.ts`/`read-sites.ts`'s own regex-over-text approach rather than a real parser),
 * returning both the RHS expression text — up to the `;` that closes the statement at bracket
 * depth 0, so an object/array/call literal's own internal `;`-free structure never truncates the
 * capture early — and the index right after that `;`, which `resolveTopLevelIdentifierMetadataKeys`
 * / `resolveInBodyIdentifierMetadataKeys` use to look for further bracket/dot-assignment statements
 * in the same enclosing scope.
 */
function findConstDeclaration(
  name: string,
  text: string,
  before?: number,
): ConstDeclaration | undefined {
  const re = new RegExp(`\\bconst\\s+${escapeRegExp(name)}\\b\\s*(?::[^=;]*)?=\\s*`, "g");
  let m: RegExpExecArray | null = re.exec(text);
  if (m === null) {
    return undefined;
  }
  // With a `before` position (the write site), prefer the NEAREST declaration preceding it: two
  // functions in one file each declaring their own `const meta` (`github-sync.ts`'s `upsertPr` and
  // its issue writer) must not both resolve to the file's first one. No preceding match keeps
  // today's first-match behaviour.
  if (before !== undefined) {
    let next: RegExpExecArray | null = re.exec(text);
    while (next !== null && next.index < before) {
      m = next;
      next = re.exec(text);
    }
  }
  const start = m.index + m[0].length;
  const semi = findTopLevelSemicolon(text, start);
  return { exprText: text.slice(start, semi).trim(), declEnd: Math.min(semi + 1, text.length) };
}

/** `findConstDeclaration`, RHS text only — the `service:`/`type:` resolution path never needs `declEnd`. */
function findConstDeclarationExpr(name: string, text: string): string | undefined {
  return findConstDeclaration(name, text)?.exprText;
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
 *  - an inline object literal (`{ workflowName: name, conclusion, headSha }`) — read directly,
 *    plus the keys of every top-level `...sameFileBuilder(…)` spread in it (`spreadCallees`);
 *  - a bare identifier (`meta`) — one hop to `const meta = { … }` anywhere in the same file, or
 *    to `const meta = build(…)` resolved through the call (`resolveDeclInitKeys`);
 *  - a call whose callee is defined in the same file (`buildPagerdutyMetadata(row, id, …)`) — one
 *    hop into the callee's body, reading either what it directly returns as an object literal, or
 *    (the shape `pagerduty-sync.ts` actually uses) a local variable the body assigns the object to
 *    and then returns by name — resolved by the SAME identifier lookup, scoped to the callee's own
 *    body first so it does not pick up an unrelated same-named const elsewhere in the file.
 * In both of the identifier cases, the literal's keys are extended with any `name["literalKey"] =
 * …` / `name.literalKey = …` assignment found LATER IN THE SAME ENCLOSING SCOPE as the
 * declaration — the shape `pagerduty-sync.ts`'s `buildPagerdutyMetadata` uses to set
 * `opened_at_ms`/`pagerduty_service_id`/`severity`/`urgency` conditionally, after building the base
 * object literal. A conditional assignment still counts: the key is emitted on at least some writer
 * rows, and a read scoped to it is not reading a dead lane. `findAssignedKeys` also credits keys set
 * through a same-file mutator and a literal-array `for…of`; see `findDirectAssignedKeys` for what
 * is deliberately NOT chased (a computed key, an object spread) and why.
 * Anything else (a property-access expression, `a ?? b`, …) resolves to no keys — `[]`, not
 * `__UNRESOLVED__`: `__UNRESOLVED__` is reserved for `itemType`, since a writer with an
 * unresolvable TYPE cannot be attributed to any read lane at all, where a writer with unresolvable
 * metadata keys is still a real, attributable write with (as far as this extractor can tell) no
 * metadata — the same "record it as empty rather than invent a key" posture the spec calls out.
 */
function resolveMetadataKeys(
  exprTextRaw: string,
  src: string,
  writeAt?: number,
): readonly string[] {
  const exprText = exprTextRaw.trim();

  const direct = tryObjectLiteralTopLevelKeys(exprText);
  if (direct !== undefined) {
    let keys = direct;
    for (const callee of spreadCallees(exprText)) {
      keys = mergeUniqueKeys(keys, resolveMetadataKeysFromCall(callee, src));
    }
    return keys;
  }

  const ident = matchBareIdentifier(exprText);
  if (ident !== undefined) {
    return resolveTopLevelIdentifierMetadataKeys(ident, src, new Set(), writeAt);
  }

  const callee = matchCallExpression(exprText);
  if (callee !== undefined) {
    return resolveMetadataKeysFromCall(callee, src);
  }

  return [];
}

/**
 * For a `metadata: identifier` value resolved at file scope (not through a same-file call): finds
 * `identifier`'s `const` declaration anywhere in the file, then extends its literal keys with any
 * bracket/dot assignment to that same identifier found later in the SMALLEST enclosing `{ … }`
 * block the declaration itself sits in — realistically its own function body, but found
 * structurally (the smallest brace pair containing the declaration) rather than assumed, so a
 * declaration nested one level deeper (inside an `if`, say) is not over-scoped to the whole
 * function.
 */
function resolveTopLevelIdentifierMetadataKeys(
  ident: string,
  src: string,
  seen: ReadonlySet<string> = new Set(),
  writeAt?: number,
): readonly string[] {
  const decl = findConstDeclaration(ident, src, writeAt);
  if (decl === undefined) {
    return [];
  }
  const initKeys = resolveDeclInitKeys(decl.exprText, src, seen);
  if (initKeys === undefined) {
    return [];
  }
  const enclosing = findEnclosingBraceRange(src, decl.declEnd) ?? { start: 0, end: src.length };
  const tail = src.slice(decl.declEnd, enclosing.end);
  return mergeUniqueKeys(initKeys, findAssignedKeys(ident, tail, src));
}

/**
 * For a `metadata: callee(...)` value whose callee's `return name;` names a local `const`: the
 * SAME literal-plus-extra-assignments resolution as `resolveTopLevelIdentifierMetadataKeys`, but
 * scoped to `body` (the callee's OWN function body, already the exact right scope — no enclosing-
 * block lookup needed) when the declaration is found there, falling back to the pre-existing
 * whole-file lookup (unscoped extra-assignment scan included) only when it is not.
 */
function resolveInBodyIdentifierMetadataKeys(
  ident: string,
  body: string,
  src: string,
  seen: ReadonlySet<string> = new Set(),
): readonly string[] {
  const declInBody = findConstDeclaration(ident, body);
  if (declInBody !== undefined) {
    const initKeys = resolveDeclInitKeys(declInBody.exprText, src, seen);
    if (initKeys === undefined) {
      return [];
    }
    const tail = body.slice(declInBody.declEnd);
    return mergeUniqueKeys(initKeys, findAssignedKeys(ident, tail, src));
  }
  return resolveTopLevelIdentifierMetadataKeys(ident, src, seen);
}

/**
 * The keys a metadata `const`'s INITIALISER contributes, before any later assignment: an object
 * literal's top-level keys, or — when the initialiser is a call (`const meta = build(…)`) — the
 * same-file callee's resolved keys UNIONED with those of every same-file call sitting directly in
 * that call's argument list. The second half is the real `github-sync.ts` shape,
 * `const meta = mergeForwardPrStats(ctx.itemMetadata, extractPrMetadataForIndex(…), externalId)`:
 * the wrapper only returns (a spread of) its parameter, so the keys live in the nested builder
 * argument, not in the wrapper (A3 review 2.3).
 *
 * Deliberately only ONE level of arguments, and only arguments that are themselves a whole call
 * expression — an identifier or property-access argument (`ctx.itemMetadata`) carries no key set
 * this file can see. `undefined` (not `[]`) for any other initialiser, so callers keep today's
 * "unresolvable declaration contributes nothing, not even later assignments" posture.
 */
function resolveDeclInitKeys(
  exprText: string,
  src: string,
  seen: ReadonlySet<string>,
): readonly string[] | undefined {
  const literalKeys = tryObjectLiteralTopLevelKeys(exprText);
  if (literalKeys !== undefined) {
    return literalKeys;
  }
  const init = stripTrailingAsConst(exprText.trim());
  const callee = matchCallExpression(init);
  if (callee === undefined) {
    return undefined;
  }
  let keys = resolveMetadataKeysFromCall(callee, src, seen);
  for (const arg of callArguments(init)) {
    const argCallee = matchCallExpression(arg.trim());
    if (argCallee !== undefined) {
      keys = mergeUniqueKeys(keys, resolveMetadataKeysFromCall(argCallee, src, seen));
    }
  }
  return keys;
}

/** The top-level argument texts of a whole call expression `callee(a, b(c), d)` — `[]` when it is not one. */
function callArguments(callText: string): readonly string[] {
  const open = callText.indexOf("(");
  if (open === -1) {
    return [];
  }
  const close = findMatchingParen(callText, open);
  if (close === -1) {
    return [];
  }
  return splitTopLevelCommas(callText.slice(open + 1, close)).filter((a) => a.trim() !== "");
}

/**
 * Callee names of every top-level `...callee(args)` spread in an object literal's text — the shape
 * `jira-sync.ts` / `linear-sync.ts` use (`{ jiraId, key, ...jiraDepthMetadata(fields) }`), where
 * the ticket-depth keys live entirely in the same-file builder. `parseTopLevelProps` skips every
 * spread; this recovers only the CALL form. A spread of an identifier or a property access
 * (`...apiResponse`, `...row.fields`) is open-world — its keys are whatever a vendor sent — and
 * stays unchased, for the same reason `findAssignedKeys` does not chase a computed key.
 */
function spreadCallees(objectText: string): readonly string[] {
  const t = stripTrailingAsConst(objectText.trim());
  if (!t.startsWith("{")) {
    return [];
  }
  const close = findMatchingBrace(t, 0);
  if (close === -1) {
    return [];
  }
  const out: string[] = [];
  for (const raw of splitTopLevelCommas(t.slice(1, close))) {
    const m = /^\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(raw.trim());
    if (m?.[1] !== undefined) {
      out.push(m[1]);
    }
  }
  return out;
}

/** `a` with every `b` entry appended that is not already present, order preserved. */
function mergeUniqueKeys(a: readonly string[], b: readonly string[]): readonly string[] {
  const out = [...a];
  for (const key of b) {
    if (!out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

/**
 * Finds every `varName["literalKey"] = …` / `varName.literalKey = …` assignment in `scopeText` —
 * the metadata-authoring shape a connector uses to add keys CONDITIONALLY after building the base
 * object literal. `(?!=)` after the `=` excludes `==`/`===`/`!==` reads, so `if (meta["k"] !==
 * undefined)` is never mistaken for a write. Built fresh per call, no shared module-level regex —
 * Task 1.2's hazard (a shared `g`-flagged RegExp across nested/recursive scans hangs `bun test`
 * rather than failing it) applies here too.
 *
 * Deliberately NOT chased, per feasibility: a computed key (`metadata[someExpr] = …`) and an
 * object spread (`{ ...apiResponse }`) are genuinely open-world — the key set depends on runtime
 * data or another service's response shape, not on anything sitting in the source as a literal —
 * unlike a literal key already sitting right there in the assignment.
 */
function findDirectAssignedKeys(varName: string, scopeText: string): readonly string[] {
  const re = new RegExp(
    `\\b${escapeRegExp(varName)}\\s*(?:\\[\\s*(['"])([A-Za-z0-9_]+)\\1\\s*\\]|\\.([A-Za-z_$][A-Za-z0-9_$]*))\\s*=(?!=)`,
    "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(scopeText);
  while (m !== null) {
    const key = m[2] ?? m[3];
    if (key !== undefined) {
      out.push(key);
    }
    m = re.exec(scopeText);
  }
  return out;
}

/**
 * Every literal key `scopeText` sets on `varName`, through any of three shapes:
 *  - a direct `varName["k"] = …` / `varName.k = …` (`findDirectAssignedKeys`);
 *  - a SAME-FILE mutator called with `varName` as its first argument — `jira-sync.ts`'s
 *    `putIfNonEmpty(meta, "issue_type", …)` and `github-sync.ts`'s `applyMergeCommitSha(out, pr)`
 *    (`findMutatorAssignedKeys`);
 *  - a `for (const k of ["a", "b"]) { varName[k] = … }` loop over a literal array
 *    (`findForOfAssignedKeys`) — `github-sync.ts`'s PR size-stat loop.
 * `src` is the whole file, where a mutator's declaration is looked up. Each shape resolves only
 * keys sitting in the source as a string literal; see the per-helper docs for what is not chased.
 */
function findAssignedKeys(varName: string, scopeText: string, src: string): readonly string[] {
  return mergeUniqueKeys(
    mergeUniqueKeys(
      findDirectAssignedKeys(varName, scopeText),
      findMutatorAssignedKeys(varName, scopeText, src),
    ),
    findForOfAssignedKeys(varName, scopeText),
  );
}

/**
 * For every call `callee(varName, …)` in `scopeText` whose `callee` is a same-file `function`
 * declaration with first parameter `P0` (and second `P1`), credits (a) every literal key the
 * callee's body assigns on `P0` (`P0["k"] =` / `P0.k =`), and (b) the call's own string-literal
 * second argument when the body assigns `P0[P1] =` — `putIfNonEmpty(meta, "issue_type", v)`, whose
 * body is `meta[key] = v`. One hop only: a mutator that hands `P0` on to a further mutator is not
 * followed, and an arrow-function mutator or a cross-file one (an import) is not resolved — the
 * real connector mutators are all same-file `function` declarations.
 */
function findMutatorAssignedKeys(
  varName: string,
  scopeText: string,
  src: string,
): readonly string[] {
  const re = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*\\(\\s*${escapeRegExp(varName)}\\s*(?=[,)])(?:,\\s*(['"])([A-Za-z0-9_]+)\\2)?`,
    "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(scopeText);
  while (m !== null) {
    const callee = m[1];
    const fn = callee === undefined ? undefined : findFunctionDeclaration(callee, src);
    const p0 = fn?.params[0];
    if (fn !== undefined && p0 !== undefined && p0 !== "") {
      for (const key of findDirectAssignedKeys(p0, fn.body)) {
        if (!out.includes(key)) out.push(key);
      }
      const p1 = fn.params[1];
      const keyArg = m[3];
      if (p1 !== undefined && p1 !== "" && keyArg !== undefined && !out.includes(keyArg)) {
        const computed = new RegExp(
          `\\b${escapeRegExp(p0)}\\s*\\[\\s*${escapeRegExp(p1)}\\s*\\]\\s*=(?!=)`,
        );
        if (computed.test(fn.body)) {
          out.push(keyArg);
        }
      }
    }
    m = re.exec(scopeText);
  }
  return out;
}

/**
 * For every `for (const K of [ "a", "b", … ] …) { … }` in `scopeText` whose block assigns
 * `varName[K] =`, every string literal in the array. Only a braced block, and only an array made
 * of nothing but string literals — a loop over a variable or a spread is open-world (its elements
 * are runtime data), the same reason a computed key is not chased.
 */
function findForOfAssignedKeys(varName: string, scopeText: string): readonly string[] {
  const re = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+\[([^\]]*)\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(scopeText);
  while (m !== null) {
    const loopVar = m[1];
    const elements = splitTopLevelCommas(m[2] ?? "")
      .map((e) => e.trim())
      .filter((e) => e !== "");
    const literals = elements.map((e) => /^(['"])([A-Za-z0-9_]+)\1$/.exec(e)?.[2]);
    const parenOpen = scopeText.indexOf("(", m.index);
    const parenClose = findMatchingParen(scopeText, parenOpen);
    const blockOpen =
      parenClose === -1 ? -1 : parenClose + 1 + leadingWhitespace(scopeText, parenClose + 1);
    if (
      loopVar !== undefined &&
      literals.length > 0 &&
      literals.every((l) => l !== undefined) &&
      blockOpen !== -1 &&
      scopeText[blockOpen] === "{"
    ) {
      const blockClose = findMatchingBrace(scopeText, blockOpen);
      const block = blockClose === -1 ? "" : scopeText.slice(blockOpen + 1, blockClose);
      const assigns = new RegExp(
        `\\b${escapeRegExp(varName)}\\s*\\[\\s*${escapeRegExp(loopVar)}\\s*\\]\\s*=(?!=)`,
      );
      if (assigns.test(block)) {
        for (const l of literals) {
          if (l !== undefined && !out.includes(l)) out.push(l);
        }
      }
    }
    m = re.exec(scopeText);
  }
  return out;
}

/** Count of whitespace characters in `text` starting at `from`. */
function leadingWhitespace(text: string, from: number): number {
  let n = 0;
  while (from + n < text.length && /\s/.test(text[from + n] ?? "")) n++;
  return n;
}

/**
 * The smallest `{ … }` span in `src` that strictly contains `pos` — the nearest enclosing block or
 * function body. A single full-source pass over every brace pair (not just object literals), kept
 * because it needs EVERY block (an `if`, a `for`, a function body), not just the value-literal
 * subset `findObjectLiterals` restricts itself to.
 */
function findEnclosingBraceRange(
  src: string,
  pos: number,
): { readonly start: number; readonly end: number } | undefined {
  const stack: number[] = [];
  let best: { start: number; end: number } | undefined;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(src, i);
      continue;
    }
    if (ch === "{") {
      stack.push(i);
      i++;
      continue;
    }
    if (ch === "}") {
      const start = stack.pop();
      if (start !== undefined && start < pos && i > pos) {
        if (best === undefined || i - start < best.end - best.start) {
          best = { start, end: i };
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return best;
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
function resolveMetadataKeysFromCall(
  calleeName: string,
  src: string,
  seenIn: ReadonlySet<string> = new Set(),
): readonly string[] {
  // A callee already being resolved further up this chain contributes nothing more: the
  // whole-file identifier fallback can otherwise loop (a wrapper's `return meta;` names its
  // PARAMETER, the fallback finds the caller's `const meta = wrapper(…)`, which calls the wrapper).
  if (seenIn.has(calleeName)) {
    return [];
  }
  const seen = new Set([...seenIn, calleeName]);
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
  if (ident !== undefined) {
    return resolveInBodyIdentifierMetadataKeys(ident, body, src, seen);
  }

  // `return f(…)`: a SAME-FILE `f` is resolved itself (one more hop, guarded by `seen`) — its
  // first argument is not passed through, since `f`'s own body says what it returns. Only a
  // cross-file wrapper passes its first argument's keys through, and only when that argument is a
  // `const` declared in THIS body: a parameter has no key set here, and the whole-file fallback
  // would credit an unrelated same-named declaration — over-crediting, the gate's dangerous
  // direction.
  const returnedCallee = matchCallExpression(returnedTrimmed);
  if (returnedCallee === undefined) {
    return [];
  }
  if (findFunctionBodyOrExpr(returnedCallee, src) !== undefined) {
    return resolveMetadataKeysFromCall(returnedCallee, src, seen);
  }
  const passed = passThroughReturnIdent(returnedTrimmed);
  if (passed === undefined || findConstDeclaration(passed, body) === undefined) {
    return [];
  }
  return resolveInBodyIdentifierMetadataKeys(passed, body, src, seen);
}

/**
 * For a `return wrapper(X, …)` expression, the bare identifier `X` — `github-sync.ts`'s
 * `return buildPrMetadata(out, { state, … })`, where the cross-file contract builder keeps every
 * non-canonical key of the raw map `out` it is handed. Crediting `X`'s keys is what this file can
 * see; the keys the wrapper ADDS (cross-file, here `pr-meta.ts`'s canonical set) are not chased,
 * since the wrapper's own definition lives in another file this per-file extractor never reads.
 * The flip side, stated: a wrapper that FILTERS `X` (as `buildPrMetadata` does for a raw key that
 * collides with a canonical one) is still credited with every key of `X`.
 */
function passThroughReturnIdent(returned: string): string | undefined {
  return /^[A-Za-z_$][\w$]*\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(returned)?.[1];
}

/**
 * A same-file `function name(P0, P1, …) { … }` declaration: its parameter NAMES (type annotations,
 * defaults and `?` stripped; a destructured parameter yields `""`) and its body text. Only the
 * `function` form — the mutator shape `findMutatorAssignedKeys` resolves; an arrow is not read here.
 */
function findFunctionDeclaration(
  name: string,
  src: string,
): { readonly params: readonly string[]; readonly body: string } | undefined {
  const fnRe = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*(?:<[^>(]*>)?\\s*\\(`);
  const fnMatch = fnRe.exec(src);
  if (fnMatch === null) {
    return undefined;
  }
  const parenOpen = fnMatch.index + fnMatch[0].length - 1;
  const parenClose = findMatchingParen(src, parenOpen);
  if (parenClose === -1) {
    return undefined;
  }
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = braceOpen === -1 ? -1 : findMatchingBrace(src, braceOpen);
  if (braceClose === -1) {
    return undefined;
  }
  const params = splitParamList(src.slice(parenOpen + 1, parenClose)).map(
    (p) => /^\s*([A-Za-z_$][\w$]*)/.exec(p)?.[1] ?? "",
  );
  return { params, body: src.slice(braceOpen + 1, braceClose) };
}

/**
 * Splits a parameter list on top-level commas — `splitTopLevelCommas` plus `<…>` depth, since a
 * parameter TYPE carries generic commas (`meta: Record<string, unknown>, key: string` is two
 * parameters, not three). The `>` of an arrow (`=>`, in a function-typed parameter) never closes
 * a generic. Used only on a parameter list, where `<` is never a less-than comparison.
 */
function splitParamList(text: string): readonly string[] {
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
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") {
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]" || (ch === ">" && text[i - 1] !== "=")) {
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
    i++;
  }
  parts.push(text.slice(last));
  return parts;
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
