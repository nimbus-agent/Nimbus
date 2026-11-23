// Static invariant rules: embedding constructors, VLM and media grants, the capture table and the door approval table.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

// D22 (f), second allow-list: the CONSTRUCTOR, not just the decorator that wraps its result. The
// rule above sees only a file that already mentions `wrapLedgeredEmbedder` -- a NEW file that
// calls `createOpenAIEmbedder(...)` bare, never mentioning the decorator at all, spells nothing
// that rule matches and would put an unrecorded remote embed in the index pipeline while this
// audit stayed green. Confining the constructor itself to its definition plus today's three
// construction sites closes that: a fourth construction site trips THIS rule even if it never
// goes near `wrapLedgeredEmbedder`. Contrast D22(e), which confines `registerRoute` (the route
// table's entry point) rather than only `wrapLedgeredProvider` (its decorator) -- this mirrors
// that shape for the embedding pipeline.
//
// An earlier version of this rule skipped ALL checking inside the approved files once their path
// matched -- so a SECOND, unwrapped `createOpenAIEmbedder(...)` added to an approved file (as
// opposed to a brand-new file) was invisible to every guard: this rule skipped the whole file, and
// the decorator rule above only trips on `wrapLedgeredEmbedder`'s absence, never on a *second*,
// unrelated construction sharing the file with a legitimate wrapped one. That is the I29
// regression this rule exists to prevent, so "the file is approved" can no longer stand in for
// "this call is wrapped": an approved file's calls are now paren-matched against every
// `wrapLedgeredEmbedder(...)` call in the file, and a call is clean only when its
// `createOpenAIEmbedder(` sits inside one of those argument lists -- proving association, not
// mere co-occurrence. The definition site is exempted outright (see below), since
// `export async function createOpenAIEmbedder(` is a declaration, not an invocation, and would
// otherwise trip the same call-shaped regex.
const D22_EMBED_CTOR_CALL_RE = /\bcreateOpenAIEmbedder\s*\(/;
const D22_EMBED_WRAP_CALL_RE = /\bwrapLedgeredEmbedder\s*\(/;
/** Where `createOpenAIEmbedder` is DECLARED -- exempt outright; there is nothing to wrap here. */
const D22_EMBED_CTOR_DEFINITION = "packages/gateway/src/embedding/openai-embedder.ts";
/** The three known construction call sites -- checked for wrapping, never skipped wholesale. */
const D22_EMBED_CTOR_ALLOWED: readonly string[] = [
  "packages/gateway/src/embedding/create-routing-runtime.ts",
  "packages/gateway/src/embedding/create-embedding-runtime.ts",
  "packages/gateway/src/ipc/index-reembed-rpc.ts",
];

/**
 * Index of the `)` matching the `(` at `openIdx` in `src`, treating string/template-literal
 * contents as opaque so a stray `)` inside one can't desync the depth count. No AST needed: this
 * is the one relationship the rule cares about -- "is call A textually nested inside call B's
 * argument list" -- and a depth-tracked scan answers that exactly. Returns -1 if unterminated.
 */
function findMatchingParenClose(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        i += src[i] === "\\" ? 2 : 1;
      }
    }
  }
  return -1;
}

export function checkEmbeddingConstructorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D22_EMBED_CTOR_DEFINITION) continue;
    // Comments AND string/template literals blanked (length-preserving), so neither a comment
    // nor a string body can fake a match or desync the paren depth count below.
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const snippetAt = (index: number): Violation => {
      const line = code.slice(0, index).split("\n").length;
      return {
        rule: "embedding-constructor-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      };
    };

    const ctorRe = new RegExp(D22_EMBED_CTOR_CALL_RE.source, "g");
    const ctorMatches = [...code.matchAll(ctorRe)];
    if (ctorMatches.length === 0) continue;

    if (!D22_EMBED_CTOR_ALLOWED.includes(f.relPath)) {
      // A brand-new call site outside the allow-list trips regardless of wrapping -- it demands
      // a deliberate allow-list addition (and the review that goes with one), not a silent pass
      // just because it happens to already be wrapped.
      for (const m of ctorMatches) out.push(snippetAt(m.index ?? 0));
      continue;
    }

    // Approved call site: every `createOpenAIEmbedder(` must be textually nested inside a
    // `wrapLedgeredEmbedder(...)` call's argument list -- association, not co-occurrence.
    const wrapSpans: Array<[number, number]> = [];
    const wrapRe = new RegExp(D22_EMBED_WRAP_CALL_RE.source, "g");
    for (const m of code.matchAll(wrapRe)) {
      const openIdx = (m.index ?? 0) + m[0].length - 1;
      const closeIdx = findMatchingParenClose(code, openIdx);
      if (closeIdx !== -1) wrapSpans.push([openIdx, closeIdx]);
    }
    for (const m of ctorMatches) {
      const idx = m.index ?? 0;
      const wrapped = wrapSpans.some(([open, close]) => idx > open && idx < close);
      if (!wrapped) out.push(snippetAt(idx));
    }
  }
  return out;
}

// D22 (g): the VISION appender. `egress/vlm-egress.ts`'s `wrapLedgeredVlm` is the I29
// `model`-class appender for a `VlmProvider`. A file that constructs a VLM without it puts an
// unrecorded egress path in the understanding pass -- and the payload on that path is the image
// itself, which makes it the worst-shaped false zero in the ledger.
//
// Two allow-lists, mirroring D22(f): the DECORATOR (so a stray reference is caught) and the
// CONSTRUCTOR (so a new construction site that never mentions the decorator at all is caught
// too -- the gap that rule's second half exists to close). The constructor half mirrors
// `checkEmbeddingConstructorConfinement` exactly, for the same reason: an EARLIER version of
// this rule skipped an allow-listed file wholesale once its path matched, so a SECOND, unwrapped
// `createOllamaVlm(...)` planted beside a legitimate wrapped call in an already-approved file was
// invisible to every guard -- the decorator half above only trips on `wrapLedgeredVlm`'s
// ABSENCE, never on a second, unrelated construction sharing the file with a real one. That is
// the exact I29 regression D22(f)'s own second allow-list exists to prevent, so "the file is
// approved" can no longer stand in for "this call is wrapped": an approved file's calls are now
// paren-matched against every `wrapLedgeredVlm(...)` call in the file, and a call is clean only
// when its `createOllamaVlm(` sits inside one of those argument lists -- proving association, not
// mere co-occurrence.
const D22_VLM_WRAP_RE = /\bwrapLedgeredVlm\b/;
const D22_VLM_WRAP_ALLOWED: readonly string[] = [
  "packages/gateway/src/egress/vlm-egress.ts",
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
];
const D22_VLM_CTOR_CALL_RE = /\bcreateOllamaVlm\s*\(/;
const D22_VLM_WRAP_CALL_RE = /\bwrapLedgeredVlm\s*\(/;
/** Where `createOllamaVlm` is DECLARED -- exempt outright; there is nothing to wrap here. */
const D22_VLM_CTOR_DEFINITION = "packages/gateway/src/multimodal/vlm/ollama-vlm.ts";
/** The one known construction call site -- checked for wrapping, never skipped wholesale. */
const D22_VLM_CTOR_ALLOWED: readonly string[] = [
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
];

export function checkVlmAppenderConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const original = f.contents.split("\n");

    // DECORATOR half: a stray `wrapLedgeredVlm` reference (import or call) outside its two
    // allow-listed homes. Comments blanked only -- a bare identifier reference, not a call, is
    // what this half looks for, so string-literal stripping is not needed here.
    if (!D22_VLM_WRAP_ALLOWED.includes(f.relPath)) {
      const stripped = stripComments(f.contents);
      const re = new RegExp(D22_VLM_WRAP_RE.source, "g");
      for (const m of stripped.matchAll(re)) {
        const line = stripped.slice(0, m.index).split("\n").length;
        out.push({
          rule: "vlm-appender-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }

    // CONSTRUCTOR half. Comments AND string/template literals blanked (length-preserving), so
    // neither a comment nor a string body can fake a match or desync the paren depth count below.
    if (f.relPath === D22_VLM_CTOR_DEFINITION) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const snippetAt = (index: number): Violation => {
      const line = code.slice(0, index).split("\n").length;
      return {
        rule: "vlm-constructor-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      };
    };

    const ctorRe = new RegExp(D22_VLM_CTOR_CALL_RE.source, "g");
    const ctorMatches = [...code.matchAll(ctorRe)];
    if (ctorMatches.length === 0) continue;

    if (!D22_VLM_CTOR_ALLOWED.includes(f.relPath)) {
      // A brand-new call site outside the allow-list trips regardless of wrapping -- it demands
      // a deliberate allow-list addition (and the review that goes with one), not a silent pass
      // just because it happens to already be wrapped.
      for (const m of ctorMatches) out.push(snippetAt(m.index ?? 0));
      continue;
    }

    // Approved call site: every `createOllamaVlm(` must be textually nested inside a
    // `wrapLedgeredVlm(...)` call's argument list -- association, not co-occurrence.
    const wrapSpans: Array<[number, number]> = [];
    const wrapRe = new RegExp(D22_VLM_WRAP_CALL_RE.source, "g");
    for (const m of code.matchAll(wrapRe)) {
      const openIdx = (m.index ?? 0) + m[0].length - 1;
      const closeIdx = findMatchingParenClose(code, openIdx);
      if (closeIdx !== -1) wrapSpans.push([openIdx, closeIdx]);
    }
    for (const m of ctorMatches) {
      const idx = m.index ?? 0;
      const wrapped = wrapSpans.some(([open, close]) => idx > open && idx < close);
      if (!wrapped) out.push(snippetAt(idx));
    }
  }
  return out;
}

// D27 (a): the remote VLM CONSTRUCTOR. `wrapLedgeredVlm` (D22(g)) guarantees a remote describe is
// LEDGERED; it does not guarantee it was GATED. A ledgered-but-ungated describe satisfies I29 and
// still violates I37 -- the bytes go, the row is written, no grant was ever checked. This rule
// closes exactly that, by making a non-local provider unconstructible outside the one wiring site
// that consults the grant store.
//
// Confining the CONSTRUCTOR rather than the `.describe(` call follows D26(c): the capability
// travels as a function VALUE, and a method-name regex cannot follow a provider held in a variable
// and invoked through an alias.
//
// A SEPARATE rule from D22(g) rather than an extension of it: the two guard different properties
// -- D22(g) is egress COMPLETENESS (every remote describe is ledgered), D27(a) is GATING (every
// remote describe was consent-checked) -- and folding them into one function would mean a future
// change made for one property silently moves the other.
const D27_REMOTE_CTOR_CALL_RE = /\bcreateRemoteVlm\s*\(/;
const D27_REMOTE_CTOR_DEFINITION =
  "packages/gateway/src/multimodal/vlm/remote/remote-vlm-shared.ts";
const D27_REMOTE_CTOR_ALLOWED: readonly string[] = [
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
];

export function checkRemoteVlmConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D27_REMOTE_CTOR_DEFINITION) continue;

    // Comments AND string/template literals blanked length-preservingly, so neither can fake a
    // match nor desync the paren-depth count below.
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const ctorMatches = [...code.matchAll(new RegExp(D27_REMOTE_CTOR_CALL_RE.source, "g"))];
    if (ctorMatches.length === 0) continue;

    const snippetAt = (index: number): Violation => {
      const line = code.slice(0, index).split("\n").length;
      return {
        rule: "remote-vlm-constructor-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      };
    };

    if (!D27_REMOTE_CTOR_ALLOWED.includes(f.relPath)) {
      for (const m of ctorMatches) out.push(snippetAt(m.index ?? 0));
      continue;
    }

    // Approved site: every `createRemoteVlm(` must sit inside a `wrapLedgeredVlm(...)` argument
    // list -- association, not co-occurrence, checked per occurrence.
    const wrapSpans: Array<[number, number]> = [];
    for (const m of code.matchAll(new RegExp(D22_VLM_WRAP_CALL_RE.source, "g"))) {
      const openIdx = (m.index ?? 0) + m[0].length - 1;
      const closeIdx = findMatchingParenClose(code, openIdx);
      if (closeIdx !== -1) wrapSpans.push([openIdx, closeIdx]);
    }
    for (const m of ctorMatches) {
      const idx = m.index ?? 0;
      if (!wrapSpans.some(([open, close]) => idx > open && idx < close)) out.push(snippetAt(idx));
    }
  }
  return out;
}

// D27 (b): the `media_grant` TABLE. Keyed on the table name in SQL text rather than on a symbol,
// because the leak this prevents is a hand-written query somewhere else reading around the store's
// `revoked_at IS NULL` filter.
//
// The table name may be bare or SQLite-quoted (`"media_grant"`, `` `media_grant` ``,
// `[media_grant]` -- all three are valid SQLite identifier-quoting forms and all three are
// something a person types by hand, not merely a theoretical evasion), so the optional quote
// characters are matched on both sides. The trailing boundary is enforced with a negative
// lookahead for an identifier character rather than `\b`, because `\b` does not fire between two
// non-word characters (e.g. a closing quote followed by whitespace) -- so widening the match to
// cover a closing quote must not also widen it to swallow a longer identifier sharing this
// prefix, such as `media_grant_history` or `media_grantX`: the lookahead is what keeps that
// closed.
//
// What remains WEAKER than a symbol rule after that fix: a dynamically assembled identifier
// (string concatenation, a template literal building the query at runtime) still evades any text
// scan, as it evades every source scanner in this file -- that residual is closed the way the
// others are, by capability, not by this rule: only `media-grant-store.ts` is ever handed a
// `Database` for this table.
//
// THREE files are allow-listed, not one, and the comment says so plainly rather than overstating:
// `media-grant-store.ts` is the only module that WRITES `media_grant` (inserts, revokes, the
// orphan-sweep); `media-discovery.ts` READS it, once, through a correlated `EXISTS (SELECT ...
// FROM media_grant ...)` subquery on the candidate-selection hot path (added alongside the grant
// model itself) -- routing that read through the store would mean either one `hasActiveGrant`
// call per candidate row, or a store function hand-rolling a SQL fragment back to its caller,
// which is confinement in name only; the correlated subquery is the right shape, so the rule
// records the exception instead of the code contorting to avoid it. `media-grant-v59-sql.ts`
// defines the table (CREATE TABLE / indexes) and is exempted for the same reason every migration
// module is: DDL for the table is not a caller of it.
const D27_GRANT_TABLE_RE =
  /\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+[`"[]?media_grant[`"\]]?(?![A-Za-z0-9_])/i;
const D27_GRANT_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/multimodal/media-grant-store.ts",
  "packages/gateway/src/multimodal/media-discovery.ts",
  "packages/gateway/src/index/media-grant-v59-sql.ts",
];

export function checkMediaGrantStoreConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D27_GRANT_TABLE_ALLOWED.includes(f.relPath)) continue;
    // Comments blanked ONLY: the table name legitimately lives inside string literals here, which
    // is the whole point -- so literals must NOT be stripped for this rule.
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D27_GRANT_TABLE_RE.source, "gi"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "media-grant-table-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// ---- D32 (I28) — the MCP capture sink ------------------------------------------------------------
// (a) The `capture` table is named only by its store and its DDL. Same shape as D27(b): SQL keyword
//     + optional quote + the bare identifier + a non-identifier lookahead, so `capture_log` and
//     `tribalCapture` never match. Comments are stripped; string literals are NOT (SQL lives there).
//     Stated bound: a dynamically composed identifier evades a text scan; capability confinement —
//     only CaptureStore is ever handed queries against the table — is the real defense.
//     Widened beyond D27(b)'s shape: an `OR <conflict>` clause after UPDATE, an optional schema
//     qualifier (`main.capture`, `"main"."capture"`), `REFERENCES`, and a comma join after a FROM
//     list (`FROM item, capture`), and the `ON` target of a `CREATE INDEX` or `CREATE TRIGGER` (only
//     event words and a column list may sit between the trigger name and `ON`). Those two require the
//     `CREATE` keyword, so prose like "index rebuilt on capture" in a log string does not match.
/**
 * A SQL reference to `table`: keyword + optional quote + optional schema qualifier + the bare
 * identifier + a non-identifier lookahead (shape documented at D32(a) above).
 */
export function sqlTableReferenceRe(table: string): RegExp {
  const ident = `(?:[\`"[]?[A-Za-z_]\\w*[\`"\\]]?\\.)?[\`"[]?${table}[\`"\\]]?(?![A-Za-z0-9_])`;
  return new RegExp(
    `\\b(?:(?:FROM|INTO|UPDATE(?:\\s+OR\\s+\\w+)?|JOIN|REFERENCES)\\s+|TABLE\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?|FROM\\s+[^;()]*?,\\s*|CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\w"\`[\\].]+\\s+ON\\s+|CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\\w"\`[\\].]+\\s+[A-Za-z_,\\s]*?\\bON\\s+)${ident}`,
    "i",
  );
}

const D32_CAPTURE_TABLE_RE = sqlTableReferenceRe("capture");
const D32_CAPTURE_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-store.ts",
  "packages/gateway/src/index/capture-v67-sql.ts",
  "packages/gateway/src/index/capture-action-v69-sql.ts",
  // V97 rebuilds `capture` (the `legacy` flag, the relaxed error-code CHECK); DDL only.
  "packages/gateway/src/index/agent-door-v97-sql.ts",
];

export function checkTableConfinement(
  files: readonly FileEntry[],
  re: RegExp,
  allowed: readonly string[],
  rule: string,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (allowed.includes(f.relPath)) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(re.source, "gi"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
  }
  return out;
}

export function checkCaptureTableConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D32_CAPTURE_TABLE_RE,
    D32_CAPTURE_TABLE_ALLOWED,
    "capture-table-confined",
  );
}

// ---- D49 (the agent door's eligibility; sub-rule (b) lands with its table in AD3a-1) --------------
// (b) `connector_write_door_approval` (V97) is named only by its store and its DDL: a row is the
//     record of an owner's `connector.writes.enable --door agent` approval and the definition hash it
//     was approved at, so no other code may write one, clear a suspension or read around it. Same shape
//     and the same stated bound as D32(a): a dynamically composed identifier evades a text scan, and
//     capability confinement (only the store holds queries against the table) is the real defense.
//     D49's remaining clauses (a), (c)-(f) follow below.
const D49_DOOR_APPROVAL_TABLE_RE = sqlTableReferenceRe("connector_write_door_approval");
const D49_DOOR_APPROVAL_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/connectors/connector-writes/door-approval-store.ts",
  "packages/gateway/src/index/agent-door-v97-sql.ts",
];

export function checkDoorApprovalConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D49_DOOR_APPROVAL_TABLE_RE,
    D49_DOOR_APPROVAL_TABLE_ALLOWED,
    "door-approval-confined",
  );
}
