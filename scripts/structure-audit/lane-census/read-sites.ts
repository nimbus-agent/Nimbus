import { stripComments } from "../lib.ts";
import { bindAliases, type TableName } from "./alias-binding.ts";
import { extractSqlLiterals, type SqlLiteral } from "./sql-literals.ts";

/**
 * One production READ site: a SQL predicate that filters on `<table>.type` (equality or `IN`) or
 * on a `json_extract(metadata, '$.<key>')` key, resolved to the specific tracked table it reads
 * from. This is the shape the census compares against what connectors actually WRITE — a triple
 * that never shows up on the write side is a dead lane.
 */
export type ReadTriple = {
  readonly table: TableName;
  readonly kind: "type" | "metadata-key";
  readonly value: string;
  readonly file: string;
  readonly line: number;
};

/**
 * A JS-side `meta["k"]` / `metadata["k"]` read whose receiver was decided NOT to hold an `item`
 * row's metadata (R5: a vendor/config object — Slack's `response_metadata`, a Kubernetes object's
 * `metadata`, a SCIM resource's `meta`). Reported beside the census for visibility, never gated.
 */
export type NonItemRead = { readonly file: string; readonly line: number; readonly value: string };

/**
 * `[qualifier.]type = 'value'`. The qualifier group is optional so a bare `type = 'x'` (no table
 * alias in front) still matches — resolving *which* table that bare form means is `resolveTable`'s
 * job, not this regex's.
 */
function typeEqualityRegex(): RegExp {
  return /(?:\b([a-z_][a-z0-9_]*)\.)?\btype\s*=\s*'([a-z0-9_]+)'/gi;
}

/**
 * `[qualifier.]type IN (…)`. Not optional — `agents/impact.ts` and `agents/negotiate.ts` both
 * filter this way, and an equality-only extractor would silently omit them. The captured list is
 * whatever sits between the parens, unparsed; splitting it into individual literals is
 * `collectTypeIn`'s job.
 */
function typeInRegex(): RegExp {
  return /(?:\b([a-z_][a-z0-9_]*)\.)?\btype\s+in\s*\(\s*([^)]+)\)/gi;
}

/** `json_extract([qualifier.]metadata, '$.<key>')`. The qualifier group is optional, same reason as above. */
function metadataKeyRegex(): RegExp {
  return /json_extract\(\s*(?:([a-z_][a-z0-9_]*)\.)?metadata\s*,\s*'\$\.([A-Za-z0-9_]+)'/gi;
}

/** Matches a single quoted literal that fills an entire (trimmed) `TYPE_IN` list item. */
function quotedListItemRegex(): RegExp {
  return /^\s*'([a-z0-9_]+)'\s*$/i;
}

/**
 * `meta[...]` / `metadata[...]`, with or without the `?.` optional-chaining operator, keyed by a
 * single- or double-quoted literal — the JS-side counterpart to `metadataKeyRegex` above.
 * `metrics/dora.ts:110` reads `if (meta?.["conclusion"] !== "success") continue;`: optional
 * chaining, which a plain `meta\[` pattern does not match. `conclusion` is one of the keys the
 * DORA bug turns on, so a regex without the `(?:\?\.)?` alternation would miss the read on the
 * very lane this gate was built for. Built fresh per call, never module-level — Task 1.2's hazard
 * (a shared `g`-flagged RegExp across nested/recursive scans hangs `bun test` rather than failing).
 *
 * Groups: 1 = a leading `.` when the receiver is dotted (`row.metadata[...]`), 2 = the receiver
 * identifier (`meta` or `metadata`), 3 = the key. `metaOrigin` reads 1 and 2.
 */
function jsMetadataReadRegex(): RegExp {
  return /(\.)?\b(meta(?:data)?)(?:\?\.)?\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g;
}

/** Matches a `function <name>(` declaration head, exported or not. Built fresh per call, same reason. */
function functionHeadRegex(): RegExp {
  return /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
}

/**
 * Cross-file manifest of helper functions that read a metadata key on the caller's behalf.
 * `dora.ts:60`'s `repoLikeMatchesUrn` is how `repo` hides from a per-call-site window — a
 * same-file helper the census would otherwise never see the key of; `metrics/service-identity
 * .ts:68`'s `repoMetadataMatchesUrn` is a second binder with the same shape, found during
 * feasibility and not yet verified end to end. The manifest exists precisely so the extractor
 * never has to resolve which call site reaches which helper (that is a call graph, out of scope
 * here) — it scans the DEFINITION wherever one appears and attributes the keys there.
 *
 * **Currently subsumed, stated rather than left implicit:** `collectJsMetadataReads`'s whole-file
 * pass already scans every byte of a file, including a listed helper's own body, so today this
 * manifest does no work a plain whole-file scan would not already do on its own — the two named
 * helpers' bodies use the literal `metadata["key"]` shape the whole-file regex already matches.
 * It is retained, not because it is load-bearing yet, but because it becomes load-bearing the
 * moment the direct pass narrows to a bounded per-call-site window (the shape the design spec
 * describes, §4.2.2) instead of the whole file — at that point a same-file helper's keys stop
 * being visible except through this manifest. Until then, this is a defensive/forward-declared
 * mechanism, not an active one.
 */
export const METADATA_READER_HELPERS: readonly string[] = [
  "repoLikeMatchesUrn",
  "repoMetadataMatchesUrn",
];

/**
 * Extracts every `type`/`metadata` read predicate from `contents`, bound to the tracked table it
 * actually reads from. Composes `extractSqlLiterals` (1.1) for the raw SQL string literals and
 * `bindAliases` (1.2) for alias resolution — this file adds only the predicate regexes and the
 * ambiguity rule on top.
 */
export function extractReadTriples(file: string, contents: string): readonly ReadTriple[] {
  const out: ReadTriple[] = [];

  for (const literal of extractSqlLiterals(contents)) {
    const aliases = bindAliases(literal.sql);
    const distinctTables = distinctBoundTables(aliases);

    collectTypeEquality(literal, aliases, distinctTables, file, out);
    collectTypeIn(literal, aliases, distinctTables, file, out);
    collectMetadataKey(literal, aliases, distinctTables, file, out);
  }

  collectJsMetadataReads(contents, file, out, []);

  return out;
}

/**
 * The JS-side `meta["k"]` reads in `contents` that `extractReadTriples` drops as NOT `item`
 * metadata (R5) — the same scan, the other half of its verdict, so the dropped reads stay visible.
 */
export function extractNonItemJsReads(file: string, contents: string): readonly NonItemRead[] {
  const nonItem: NonItemRead[] = [];
  collectJsMetadataReads(contents, file, [], nonItem);
  return nonItem;
}

/** The set of distinct tables bound anywhere in an alias map — the ambiguity check reads its size, not the map's. */
function distinctBoundTables(aliases: ReadonlyMap<string, TableName>): ReadonlySet<TableName> {
  return new Set(aliases.values());
}

/**
 * Resolves a predicate's qualifier to a tracked table, or `undefined` when it should be skipped
 * rather than guessed at:
 * - a qualified name (`i.type`) resolves via the alias map, or is skipped if it binds to nothing;
 * - an unqualified name (`type`) resolves to the single bound table when exactly one is bound, and
 *   is skipped when more than one is — recording it anyway would reintroduce the exact cross-table
 *   conflation this gate exists to prevent.
 */
function resolveTable(
  qualifier: string | undefined,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
): TableName | undefined {
  if (qualifier !== undefined) {
    return aliases.get(qualifier);
  }
  if (distinctTables.size === 1) {
    const [only] = distinctTables;
    return only;
  }
  return undefined;
}

/** 1-indexed line of `indexInSql`, as the literal's start line plus the newline offset within it. */
function lineFor(literal: SqlLiteral, indexInSql: number): number {
  let offset = 0;
  for (let i = 0; i < indexInSql; i++) {
    if (literal.sql[i] === "\n") offset++;
  }
  return literal.line + offset;
}

function collectTypeEquality(
  literal: SqlLiteral,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
  file: string,
  out: ReadTriple[],
): void {
  const re = typeEqualityRegex();
  let m: RegExpExecArray | null = re.exec(literal.sql);
  while (m !== null) {
    const table = resolveTable(m[1], aliases, distinctTables);
    const value = m[2];
    if (table !== undefined && value !== undefined) {
      out.push({ table, kind: "type", value, file, line: lineFor(literal, m.index) });
    }
    m = re.exec(literal.sql);
  }
}

function collectTypeIn(
  literal: SqlLiteral,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
  file: string,
  out: ReadTriple[],
): void {
  const re = typeInRegex();
  let m: RegExpExecArray | null = re.exec(literal.sql);
  while (m !== null) {
    const table = resolveTable(m[1], aliases, distinctTables);
    const list = m[2] ?? "";
    if (table !== undefined) {
      const line = lineFor(literal, m.index);
      for (const item of list.split(",")) {
        const literalMatch = quotedListItemRegex().exec(item);
        const value = literalMatch?.[1];
        if (value !== undefined) {
          out.push({ table, kind: "type", value, file, line });
        }
      }
    }
    m = re.exec(literal.sql);
  }
}

function collectMetadataKey(
  literal: SqlLiteral,
  aliases: ReadonlyMap<string, TableName>,
  distinctTables: ReadonlySet<TableName>,
  file: string,
  out: ReadTriple[],
): void {
  const re = metadataKeyRegex();
  let m: RegExpExecArray | null = re.exec(literal.sql);
  while (m !== null) {
    const table = resolveTable(m[1], aliases, distinctTables);
    const value = m[2];
    if (table !== undefined && value !== undefined) {
      out.push({ table, kind: "metadata-key", value, file, line: lineFor(literal, m.index) });
    }
    m = re.exec(literal.sql);
  }
}

/**
 * Adds one `item`/`metadata-key` triple for every JS-side metadata read found anywhere in
 * comment-stripped `contents` — only `item` rows carry a JSON `metadata` column read this way in
 * v1 — plus every key read inside the body of a same-named function declaration listed in
 * `METADATA_READER_HELPERS`. A helper's own body is already part of `contents`, so the two passes
 * necessarily overlap; `addUniqueTriple` is what keeps that overlap from surfacing as duplicate
 * rows while still making the manifest's promise ("a helper contributes its keys at its definition
 * site") true by construction, not by accident of the whole-file pass's reach.
 *
 * **The blanket `item` attribution is a measured bound, not a structural guarantee.** `graph_entity`
 * and `graph_relation` both carry their own `metadata TEXT` column (`index/graph-v7-sql.ts:8,23`),
 * so a file that parses ONE of those rows' metadata the same way (`meta["key"]`/`metadata["key"]`,
 * with or without `?.`) would be misattributed to `item` here — the exact cross-table conflation
 * this whole gate exists to prevent, arriving through the JS door instead of the SQL one the rest
 * of this file guards against with `resolveTable`. Measured against every non-test file under
 * `packages/gateway/src`, not assumed: zero of them contain a JS metadata read that touches only
 * graph tables — every real match found (`negotiate.ts`, `graph-populator.ts`) reads `item.metadata`
 * (or an `IndexedItemGraphInput`'s `row.metadata`, itself an item field) even in files that are
 * otherwise all about `graph_entity`/`graph_relation`. This breaks the day someone parses a
 * `graph_entity.metadata` or `graph_relation.metadata` value with this same JS shape in a non-test
 * file — re-measure before trusting `item` attribution again if that ever happens, rather than
 * assuming this comment is still true.
 */
function collectJsMetadataReads(
  contents: string,
  file: string,
  out: ReadTriple[],
  nonItem: NonItemRead[],
): void {
  const stripped = stripComments(contents);
  const sink: JsReadSink = { file, out, nonItem, braces: undefined };

  scanJsMetadataReads(stripped, stripped, 0, sink);

  for (const helper of findHelperBodies(stripped)) {
    scanJsMetadataReads(stripped, helper.body, helper.start, sink);
  }
}

/**
 * Where one file's JS-side reads land: `out` for item reads, `nonItem` for R5's not-item verdicts.
 * `braces` is the file's `{…}` pair list, computed at most once (lazily, only when a declaration
 * actually needs a scope check) and shared by the whole-file and helper-body passes.
 */
type JsReadSink = {
  readonly file: string;
  readonly out: ReadTriple[];
  readonly nonItem: NonItemRead[];
  braces: readonly BracePair[] | undefined;
};

/** A named helper's body text plus the absolute index (into the comment-stripped file) it starts at. */
type HelperBody = { readonly body: string; readonly start: number };

/**
 * Locates every `function <name>(...) { ... }` declaration in `src` whose name is listed in
 * `METADATA_READER_HELPERS` and returns its body text plus where that body starts. Finding the
 * call site that *reaches* a helper is explicitly out of scope — that is a call graph — this only
 * has to find the DEFINITION, wherever it appears in the file.
 */
function findHelperBodies(src: string): readonly HelperBody[] {
  const out: HelperBody[] = [];
  const re = functionHeadRegex();
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    const name = m[1];
    if (name !== undefined && METADATA_READER_HELPERS.includes(name)) {
      const parenOpen = m.index + m[0].length - 1;
      const parenClose = findMatchingDelimiter(src, parenOpen, "(", ")");
      const braceOpen = parenClose === -1 ? -1 : src.indexOf("{", parenClose);
      const braceClose = braceOpen === -1 ? -1 : findMatchingDelimiter(src, braceOpen, "{", "}");
      if (braceOpen !== -1 && braceClose !== -1) {
        out.push({ body: src.slice(braceOpen + 1, braceClose), start: braceOpen + 1 });
      }
    }
    m = re.exec(src);
  }
  return out;
}

/**
 * Returns the index of the `close` delimiter matching the `open` delimiter at `openIndex`,
 * respecting single-, double-, and template-quoted strings so a stray brace/paren inside a string
 * literal never unbalances the count. Returns -1 if it never closes.
 */
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
      const end = findStringLiteralEnd(src, i, ch);
      if (end === -1) return -1;
      i = end + 1;
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

/**
 * Finds the index of the closing quote matching `quote` at `start`, skipping `\\` escapes. A
 * single-/double-quoted string cannot legitimately span an unescaped newline; a template literal
 * can.
 */
function findStringLiteralEnd(src: string, start: number, quote: string): number {
  if (quote === "`") return findTemplateEnd(src, start);
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    if (quote !== "`" && ch === "\n") return -1;
    i++;
  }
  return -1;
}

/**
 * Scans `text` (a slice of `fullStripped` starting at `baseIndex`) for JS-side metadata reads and
 * classifies each one before recording it, with a line number recovered from its absolute position
 * in `fullStripped`:
 * - an assignment TARGET (`meta["k"] = v`) is a write a builder performs, not a read — skipped;
 * - otherwise `metaOrigin` decides: `"item"` → an `item`/`metadata-key` triple in `sink.out`,
 *   `"not-item"` → a `NonItemRead` in `sink.nonItem` (visible, never gated).
 * One scanner feeds both `extractReadTriples` and `extractNonItemJsReads`, so the two can never
 * disagree about which matches exist.
 */
function scanJsMetadataReads(
  fullStripped: string,
  text: string,
  baseIndex: number,
  sink: JsReadSink,
): void {
  const re = jsMetadataReadRegex();
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const dotted = m[1] === ".";
    const receiver = m[2];
    const value = m[3];
    if (
      receiver !== undefined &&
      value !== undefined &&
      !isAssignmentTarget(text, m.index + m[0].length)
    ) {
      const receiverIndex = baseIndex + m.index + (dotted ? 1 : 0);
      const line = lineAtIndex(fullStripped, receiverIndex);
      const { file } = sink;
      if (metaOrigin(fullStripped, receiverIndex, receiver, dotted, sink) === "item") {
        addUniqueTriple(sink.out, { table: "item", kind: "metadata-key", value, file, line });
      } else if (!sink.nonItem.some((r) => r.line === line && r.value === value)) {
        sink.nonItem.push({ file, line, value });
      }
    }
    m = re.exec(text);
  }
}

/**
 * `X["k"]` followed by a plain `=` (not `==`, `===`, `=>`) is an assignment TARGET — a write. The
 * 40-char window tolerates aligned whitespace / a line break before `=`.
 */
function isAssignmentTarget(text: string, endIndex: number): boolean {
  return /^\s*=(?![=>])/.test(text.slice(endIndex, Math.min(text.length, endIndex + 40)));
}

export type MetaOrigin = "item" | "not-item";

/**
 * Initializer text that marks an `item` row's metadata: a `.metadata`/`.rawMeta` dereference or a
 * `…Metadata(` / `metadata(` parser call. Built fresh per call (this directory's convention).
 */
function itemOriginRegex(): RegExp {
  return /\.(?:metadata|rawMeta)\b|(?:^|[^A-Za-z0-9_$])metadata\s*\(|[A-Za-z0-9_$]Metadata\s*\(/;
}

/**
 * R5 (amended by controller Ruling B): decides whether the `meta`/`metadata` identifier read at
 * `index` holds an `item` row's metadata. Dotted receivers (`row.metadata[...]`) always do.
 * Otherwise the NEAREST preceding, still-in-scope `const|let|var <name> … = <init>` decides:
 * - an initializer showing item origin (`itemOriginRegex`) → item;
 * - an object/array LITERAL initializer (`{…}`/`[…]`, optionally `as …`) → item — a builder-local
 *   being read is item metadata being authored, and dropping it would be a silent miss;
 * - any other initializer → not-item.
 * No in-scope declaration, or one with no initializer (a parameter, `let x;`, `for (const x of …)`)
 * → item, so a real read is never dropped silently. A parameter list that rebinds `name` between
 * the declaration and the read (shadowing) also → item, for the same reason.
 */
function metaOrigin(
  src: string,
  index: number,
  name: string,
  dotted: boolean,
  sink: JsReadSink,
): MetaOrigin {
  if (dotted) return "item";
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b\\s*(?::[^=;]*)?(=)?`, "g");
  let last: RegExpExecArray | null = null;
  let m = declRe.exec(src);
  while (m !== null && m.index < index) {
    // Scope check: a declaration whose smallest enclosing `{…}` closed before `index` cannot
    // bind the name at `index` (a sibling function's local) — skip it.
    if (declStillInScope(braceCache(src, sink), m.index, index)) last = m;
    m = declRe.exec(src);
  }
  if (last === null || last[1] === undefined) return "item";
  if (parameterShadows(src, last.index, index, name)) return "item";
  const initStart = last.index + last[0].length;
  if (isLiteralInitializer(src, initStart)) return "item";
  const semi = src.indexOf(";", initStart);
  const init = src.slice(initStart, semi === -1 ? Math.min(src.length, initStart + 300) : semi);
  return itemOriginRegex().test(init) ? "item" : "not-item";
}

/**
 * Ruling B: whether the initializer starting at `initStart` is exactly an object/array literal,
 * optionally followed by an `as …` cast, up to its statement's `;`. `{} ?? x` or `[a].map(f)` is
 * NOT a bare literal — the expression's value is whatever the rest computes.
 */
function isLiteralInitializer(src: string, initStart: number): boolean {
  let i = initStart;
  while (i < src.length && /\s/.test(src[i] ?? "")) i++;
  const open = src[i];
  if (open !== "{" && open !== "[") return false;
  const close = findMatchingDelimiter(src, i, open, open === "{" ? "}" : "]");
  if (close === -1) return false;
  const semi = src.indexOf(";", close);
  const rest = src.slice(close + 1, semi === -1 ? src.length : semi).trim();
  return rest === "" || /^as\b/.test(rest);
}

/** One matched `{…}` pair: the absolute indices of its `{` and `}`. */
type BracePair = { readonly start: number; readonly end: number };

/** `sink.braces`, computed on first use. */
function braceCache(src: string, sink: JsReadSink): readonly BracePair[] {
  if (sink.braces === undefined) sink.braces = collectBracePairs(src);
  return sink.braces;
}

/**
 * Every matched `{…}` pair in `src`, skipping strings and templates (so a brace inside a literal
 * never unbalances the scan). The same brace walk as `writer-emissions.ts`'s
 * `findEnclosingBraceRange`, copied per this directory's convention and turned inside out: it
 * records every pair once, so each declaration's scope check is a list lookup, not a rescan.
 */
function collectBracePairs(src: string): readonly BracePair[] {
  const pairs: BracePair[] = [];
  const stack: number[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(src, i);
      continue;
    }
    if (ch === "{") stack.push(i);
    else if (ch === "}") {
      const start = stack.pop();
      if (start !== undefined) pairs.push({ start, end: i });
    }
    i++;
  }
  return pairs;
}

/**
 * Whether a declaration at `declIndex` can still bind its name at `useIndex`: true when no `{…}`
 * pair encloses the declaration (module scope), or the SMALLEST one that does closes after
 * `useIndex`. A sibling function's local closed before the read and so cannot reach it.
 */
function declStillInScope(
  pairs: readonly BracePair[],
  declIndex: number,
  useIndex: number,
): boolean {
  let best: BracePair | undefined;
  for (const p of pairs) {
    if (p.start < declIndex && p.end > declIndex) {
      if (best === undefined || p.end - p.start < best.end - best.start) best = p;
    }
  }
  return best === undefined || best.end > useIndex;
}

/** Control-flow keywords whose `(…) {` is a condition, not a parameter list. */
const NON_BINDING_PAREN_KEYWORDS: readonly string[] = ["if", "while", "for", "switch", "with"];

/**
 * Whether some function head opening between `declIndex` and `useIndex` names `name` among its
 * parameters AND its body contains `useIndex` — i.e. the read sees a parameter, not the earlier
 * declaration. Covers `function f(meta)` / a method `m(meta) {` / `catch (meta) {` / an arrow
 * `(meta) =>` or `(meta): T =>`, plus the paren-less arrow `meta =>`. Fail-safe: anything this
 * finds makes the read an item read.
 */
function parameterShadows(src: string, declIndex: number, useIndex: number, name: string): boolean {
  const nameRe = new RegExp(`\\b${name}\\b`);
  let i = declIndex;
  while (i < useIndex) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(src, i);
      continue;
    }
    if (ch === "(") {
      const close = findMatchingDelimiter(src, i, "(", ")");
      if (close !== -1 && close < useIndex && nameRe.test(src.slice(i + 1, close))) {
        const body = functionBodyAfter(src, close, precedingWord(src, i));
        if (body !== undefined && body.start <= useIndex && useIndex <= body.end) return true;
      }
    }
    i++;
  }
  const bareArrow = new RegExp(`(?:^|[^A-Za-z0-9_$.])${name}\\s*=>`, "g");
  bareArrow.lastIndex = declIndex;
  let m = bareArrow.exec(src);
  while (m !== null && m.index < useIndex) {
    const body = arrowBody(src, m.index + m[0].length);
    if (body.start <= useIndex && useIndex <= body.end) return true;
    m = bareArrow.exec(src);
  }
  return false;
}

/** The identifier immediately before `parenIndex` (whitespace skipped), or `""`. */
function precedingWord(src: string, parenIndex: number): string {
  let j = parenIndex - 1;
  while (j >= 0 && /\s/.test(src[j] ?? "")) j--;
  const end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j] ?? "")) j--;
  return src.slice(j + 1, end);
}

/**
 * The body span of the function whose parameter list closes at `closeParen`, or `undefined` when
 * that `(…)` is not a parameter list. After the `)`: an optional `: ReturnType`, then either `=>`
 * (an arrow — block or expression body) or `{` (a function/method/`catch` block). A `{` whose
 * closing `}` is followed by another `{` was an object-literal return TYPE; the next block is the
 * body.
 */
function functionBodyAfter(
  src: string,
  closeParen: number,
  keyword: string,
): BracePair | undefined {
  let i = skipWhitespace(src, closeParen + 1);
  const hasReturnType = src[i] === ":";
  if (hasReturnType) {
    const arrow = src.indexOf("=>", i);
    const brace = src.indexOf("{", i);
    if (arrow !== -1 && (brace === -1 || arrow < brace)) i = arrow;
    else if (brace !== -1) i = brace;
    else return undefined;
  }
  if (src.startsWith("=>", i)) return arrowBody(src, i + 2);
  if (src[i] !== "{" || NON_BINDING_PAREN_KEYWORDS.includes(keyword)) return undefined;
  const end = findMatchingDelimiter(src, i, "{", "}");
  if (end === -1) return undefined;
  const next = skipWhitespace(src, end + 1);
  if (hasReturnType && src[next] === "{") {
    const bodyEnd = findMatchingDelimiter(src, next, "{", "}");
    if (bodyEnd !== -1) return { start: next, end: bodyEnd };
  }
  return { start: i, end };
}

/**
 * An arrow's body starting at `from` (just past `=>`): a `{…}` block, or an expression running to
 * the first `;`, `,` or unmatched closer at its own depth.
 */
function arrowBody(src: string, from: number): BracePair {
  const start = skipWhitespace(src, from);
  if (src[start] === "{") {
    const end = findMatchingDelimiter(src, start, "{", "}");
    return { start, end: end === -1 ? src.length : end };
  }
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(src, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((ch === ";" || ch === ",") && depth === 0) break;
    i++;
  }
  return { start, end: i };
}

/** First non-whitespace index at or after `i`. */
function skipWhitespace(src: string, i: number): number {
  let j = i;
  while (j < src.length && /\s/.test(src[j] ?? "")) j++;
  return j;
}

/**
 * Index of the backtick that closes the template literal opened at `start`, respecting nested
 * `${ … }` (copied from `writer-emissions.ts`, per this directory's convention), so a backtick
 * inside an interpolation does not end the template early. -1 if it never closes.
 */
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

/**
 * Index just past the string/template literal opened at `i`. An unterminated single-/double-quoted
 * string (a stray quote) advances one character rather than swallowing the rest of the file.
 */
function skipStringOrTemplate(src: string, i: number): number {
  const quote = src[i] ?? "";
  const end = findStringLiteralEnd(src, i, quote);
  return end === -1 ? i + 1 : end + 1;
}

/** 1-indexed line of `index` within `src`, same counting rule as `sql-literals.ts`'s `lineAt`. */
function lineAtIndex(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

/**
 * Pushes `candidate` only if an identical triple is not already present. The whole-file JS pass
 * and the named-helper-body pass necessarily overlap (a helper's body is part of the whole file),
 * and this is what keeps that overlap from surfacing as duplicate rows.
 */
function addUniqueTriple(out: ReadTriple[], candidate: ReadTriple): void {
  const exists = out.some(
    (t) =>
      t.table === candidate.table &&
      t.kind === candidate.kind &&
      t.value === candidate.value &&
      t.file === candidate.file &&
      t.line === candidate.line,
  );
  if (!exists) out.push(candidate);
}
