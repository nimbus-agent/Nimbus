// Static invariant rules: D16-D21: policy TOML, ChatOps reply surface, preflight runner, tribal KB write, connector write confinement, share.publish.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { CONNECTOR_WRITE_ROWS } from "../../../packages/gateway/src/connectors/connector-writes/index.ts";
import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

// D16 (I22) — `parsePolicyToml` (raw org-policy TOML parsing) may be imported ONLY by files under
// `packages/gateway/src/policy/`. Enforcement elsewhere must read the resolved `EnforcedPolicy` via
// `policy/policy-gate.ts`; re-parsing raw TOML at an enforcement site bypasses signature verification
// and the monotonic-stricter resolution (I22). Test files are exempt.
const POLICY_DIR = "packages/gateway/src/policy/";
const PARSE_POLICY_IMPORT_RE =
  /\bparsePolicyToml\b|from\s+["'][^"']*(?:\.\/policy-toml|policy\/policy-toml)["']/;

export function checkPolicyTomlImportInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.startsWith(POLICY_DIR) || f.relPath.endsWith(".test.ts")) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (PARSE_POLICY_IMPORT_RE.test(line)) {
        out.push({
          rule: "D16-policy-toml-import",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D17 (I23) — the connector operational-post tools (`slack_chat_post` / `teams_chat_post` and, since
// Phase 9.7 D0c, the typed-confirmation modal opener `slack_views_open`) may be
// referenced ONLY from `packages/gateway/src/chatops/reply-dispatcher.ts` and
// `packages/gateway/src/chatops/transport/`. Any other module posting directly would bypass the
// bounded-destination reply surface (I23) and could launder the HITL-gated `*.message.post` action.
// The connector server modules that used to need a DEFINITION-home exemption here
// (`packages/mcp-connectors/{slack,teams}/src/server.ts`) left this repo in the v3.0.0 extraction
// to nimbus-mcp-servers — `git ls-files packages/mcp-connectors` returns nothing — so there is
// nothing left in this repo to exempt them for.
const CHATOPS_POST_ALLOWED_PREFIXES = [
  "packages/gateway/src/chatops/reply-dispatcher.ts",
  "packages/gateway/src/chatops/transport/",
];
const CHATOPS_POST_RE = /\b(?:slack_chat_post|teams_chat_post|slack_views_open)\b/;

export function checkChatopsReplySurfaceInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (CHATOPS_POST_ALLOWED_PREFIXES.some((p) => f.relPath === p || f.relPath.startsWith(p)))
      continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (CHATOPS_POST_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D17-chatops-reply-surface",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D17(c) (I23) — `postWatcherNotice` is the one handle that turns a string into a channel post for a
// fired watcher. It may appear in production code ONLY in `chatops/chatops-boot.ts` (its home) and
// `platform/assemble.ts` and its `platform/assemble/chatops-boot.ts` (the one wiring site,
// `settleWatcherChatops`, which binds it to the owner's `[watcher.chatops]` namespace). The notifier module receives the poster by injection and imports
// nothing from `chatops/`, so no watcher, row or event can reach a destination through it.
const WATCHER_NOTICE_ALLOWED = new Set([
  "packages/gateway/src/chatops/chatops-boot.ts",
  "packages/gateway/src/platform/assemble.ts",
  "packages/gateway/src/platform/assemble/chatops-boot.ts",
]);
const WATCHER_NOTICE_RE = /\bpostWatcherNotice\b/;

export function checkChatopsWatcherNoticeCaller(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || WATCHER_NOTICE_ALLOWED.has(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (WATCHER_NOTICE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D17-chatops-watcher-notice-caller",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D17(d) (I23 amendment) — the owner-pinned watcher channel. The `watcherPinned` ReplyTarget kind,
// the boot's `watcherPinnedChannel` dependency and `postWatcherNoticePinned` may appear in
// production code ONLY in the four files that define, resolve and wire them: the kind (`types.ts`),
// the dispatcher that refuses it unless built with the resolver (`reply-dispatcher.ts`), the boot
// that builds the target and the resolver (`chatops-boot.ts`), and the one wiring site that hands the
// boot-time config value over (`assemble.ts` and, since the 2026-11 split, the `platform/assemble/`
// modules `chatops-boot.ts`, `scheduler-mesh.ts` and `scheduler-mesh-opts.ts` it delegates the config
// read, the hand-over and the option type to). No watcher, row, pack, IPC handler or other module can
// build or pass the target, so a channel never reaches the dispatcher from anywhere but the owner's
// own config.
const WATCHER_PINNED_ALLOWED = new Set([
  "packages/gateway/src/chatops/types.ts",
  "packages/gateway/src/chatops/reply-dispatcher.ts",
  "packages/gateway/src/chatops/chatops-boot.ts",
  "packages/gateway/src/platform/assemble.ts",
  "packages/gateway/src/platform/assemble/chatops-boot.ts",
  "packages/gateway/src/platform/assemble/scheduler-mesh.ts",
  "packages/gateway/src/platform/assemble/scheduler-mesh-opts.ts",
]);
const WATCHER_PINNED_RE =
  /\b(?:watcherPinnedChannel|postWatcherNoticePinned)\b|["'`]watcherPinned["'`]/;

export function checkChatopsWatcherPinned(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || WATCHER_PINNED_ALLOWED.has(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (WATCHER_PINNED_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D17-chatops-watcher-pinned",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D17 (I23/I29) — `buildConnectorPost(...)` produces an UNLEDGERED post function. It may be
// CALLED only as an argument to `buildLedgeredChatPosts(...)`, never bound to a name, so no
// consumer can reach an unwrapped post. Without this the ledger covers the consumers that exist
// and silently misses the next one added.
//
// PER OCCURRENCE, never per file. A file-level "does this file contain a wrapped call?"
// early-return skips the whole file once BOTH forms are present — and `chatops-boot.ts` is the one
// file that legitimately contains a wrapped call, so it is exactly the file where an added
// unwrapped call would go unseen. Token COUNTING has the same weakness from the other direction:
// `buildLedgeredChatPosts(db, somethingElse, salt)` keeps the counts equal while wrapping nothing.
//
// DIRECT CONTAINMENT, never ordinal pairing. An earlier version paired the Nth `buildConnectorPost(`
// with the Nth `buildLedgeredChatPosts(` in the statement — positional, not "is this call actually
// inside that one's argument list". That let a comma-separated statement with two wrapped calls
// plus one raw call through: the raw call's ordinal happened to line up with the SECOND wrapper's,
// which had already closed its own parens earlier in the same statement, so the raw call "paired"
// with a wrapper it sat entirely outside of. Direct containment closes this: a raw call is safe
// only when its offset falls strictly inside SOME wrapper's own balanced parenthesis span.
//
// Phase 9.7 D0c adds a second pair under the same rule: `buildConnectorViewsOpen(...)` (the raw
// `views.open` call for the confirmation modal) may be CALLED only inside
// `buildLedgeredConfirmModal(...)`. Each raw call is matched to ITS OWN wrapper, so a modal opener
// inside `buildLedgeredChatPosts(...)` (or a post inside `buildLedgeredConfirmModal(...)`) is still
// unwrapped for the ledger row it needs.
const RAW_WRAPPER_PAIRS: readonly { readonly raw: RegExp; readonly wrapper: RegExp }[] = [
  { raw: /\bbuildConnectorPost\s*\(/g, wrapper: /\bbuildLedgeredChatPosts\s*\(/g },
  { raw: /\bbuildConnectorViewsOpen\s*\(/g, wrapper: /\bbuildLedgeredConfirmModal\s*\(/g },
];

/** Byte offset -> 1-based line, so a per-offset finding can name a line. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Every `buildLedgeredChatPosts(` call's own argument-list span in `stmt`, as `[open, close)`
 * offsets of its opening and matching closing parenthesis. A balanced left-to-right scan over the
 * STRIPPED text (comments + string/template bodies already blanked to spaces, length-preserving),
 * so a stray `(`/`)` inside a blanked string or comment can never desync the depth count.
 */
function wrapperSpans(stmt: string, wrapper: RegExp): { open: number; close: number }[] {
  const spans: { open: number; close: number }[] = [];
  const re = new RegExp(wrapper.source, "g");
  for (let m = re.exec(stmt); m !== null; m = re.exec(stmt)) {
    const open = m.index + m[0].length - 1; // offset of the call's own "(" (the match ends in it)
    let depth = 1;
    let i = open + 1;
    for (; i < stmt.length && depth > 0; i++) {
      if (stmt[i] === "(") depth++;
      else if (stmt[i] === ")") depth--;
    }
    // An UNBALANCED span grants NO containment — it is dropped, not extended to end-of-statement.
    //
    // This is the fail direction that matters. `stripStringLiterals` has a documented KNOWN
    // LIMITATION (`lib.ts`): it is not regex-literal aware, so a `(` inside a regex body — `/[(]/`
    // — survives stripping and inflates `depth`, which then never returns to 0. Closing the span
    // at `stmt.length` (the previous behaviour) made every later raw `buildConnectorPost(` in that
    // statement land INSIDE the span and be accepted as wrapped: a silent false NEGATIVE in the
    // one guard whose entire job is to catch an unledgered post.
    //
    // Dropping the span inverts that into a loud false POSITIVE: a real raw call in such a
    // statement is flagged, and so is a legitimately wrapped one. That is the correct trade for a
    // security guard, and it needs no `/`-as-regex-vs-division lexer heuristics — which `lib.ts`
    // deliberately declines to hand-roll, since three other passing audits depend on that helper.
    if (depth === 0) {
      spans.push({ open, close: i - 1 });
    }
  }
  return spans;
}

export function checkChatopsUnwrappedPost(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath.endsWith("chatops/transport/connector-post.ts")) continue; // definition site
    // Comments AND string/template literals blanked (length-preserving, per stripStringLiterals's
    // own contract), so a `;` inside a string argument (e.g. a channel name) cannot fragment one
    // statement into two and produce a false positive. `${...}` substitutions stay live code, so
    // a call written inside one is still visible to the regexes below.
    const stripped = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");

    // Statement-scoped: a `;` ends the construct we care about, and the legal form is a single
    // statement. Splitting keeps offsets recoverable by accumulating the consumed length.
    let base = 0;
    for (const stmt of stripped.split(";")) {
      for (const pair of RAW_WRAPPER_PAIRS) {
        const spans = wrapperSpans(stmt, pair.wrapper);
        for (const m of stmt.matchAll(pair.raw)) {
          const post = m.index ?? 0;
          // Safe ONLY when directly contained in the argument list of ITS OWN wrapper — not merely
          // preceded by a wrapper opening earlier in the statement (see the D17 comment above).
          const contained = spans.some((s) => post > s.open && post < s.close);
          if (!contained) {
            const off = base + post;
            const line = lineOfOffset(stripped, off);
            out.push({
              rule: "D17-chatops-unwrapped-post",
              file: f.relPath,
              line,
              snippet: (original[line - 1] ?? "").trim(),
            });
          }
        }
      }
      base += stmt.length + 1; // + the `;` that split consumed
    }
  }
  return out;
}

// D18 (I24) — the preflight sandbox runner (`runPreflightCommand`) may be referenced ONLY from
// preflight-gate.ts (the gate) + preflight-runner.ts (its home). Any other module spawning the
// preflight command would bypass the local HITL gate and the downstream-config-only command (I24).
const PREFLIGHT_RUNNER_ALLOWED = [
  "packages/gateway/src/federation/preflight-gate.ts",
  "packages/gateway/src/federation/preflight-runner.ts",
];
const PREFLIGHT_RUNNER_RE = /\brunPreflightCommand\b/;

export function checkPreflightRunnerInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (PREFLIGHT_RUNNER_ALLOWED.some((p) => f.relPath === p)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (PREFLIGHT_RUNNER_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D18-preflight-runner",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D19 (I25): the tribal-knowledge KB-write tools may be NAMED only in the gateway write-gate (the
// sole gateway-side invocation, where the destination comes from local config) and the two
// connector definition sites. Any other reference would let a caller drive an arbitrary KB write,
// bypassing the local owner's HITL gate + config-only destination.
// The two connector definition sites that used to need an exemption here
// (`packages/mcp-connectors/{notion,confluence}/src/server.ts`) left this repo in the v3.0.0
// extraction to nimbus-mcp-servers, so the gateway write-gate is now the only site in this repo.
const TRIBAL_KB_WRITE_ALLOWED = ["packages/gateway/src/tribal/tribal-write-gate.ts"];
const TRIBAL_KB_WRITE_RE = /\b(?:notion_kb_append|confluence_kb_append)\b/;

export function checkTribalKbWriteInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (TRIBAL_KB_WRITE_ALLOWED.some((p) => f.relPath === p)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (TRIBAL_KB_WRITE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D19-tribal-kb-write",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D20 (I26): every connector write tool id in the row table (connectors/connector-writes) may be
// NAMED only in four gateway sites: the row table itself (and the manifest generated from the
// installed package), the write transport, the write dispatch and the code-execution id
// classification (the act door's routing table was deleted in AD3b). Any other reference could route
// a write outside the local executor I2 gate. The id set is DERIVED from CONNECTOR_WRITE_ROWS, so a
// new row is confined the moment it lands; there is no hand-spelled list to forget. A trailing
// slash in an allowed entry makes it a directory prefix (the shape D17 uses). Also requires
// answerFederatedInvoke (federation/invoke-gate.ts) to consult the write-id predicate
// (isWriteForbiddenToolId) so a federated peer can never trigger a connector write, and the
// code-execution predicate (isCodeExecutionForbiddenToolId) so it can never run caller-directed
// code on the anchor either. The gate-confined ids (D17/D19) are not rows and stay confined there.
const CONNECTOR_WRITE_ALLOWED = [
  "packages/gateway/src/connectors/connector-writes/",
  "packages/gateway/src/connectors/connector-write-transport.ts",
  "packages/gateway/src/connectors/connector-write-dispatch.ts",
  "packages/gateway/src/connectors/connector-code-execution-tool-ids.ts",
  // D2: the iac runner's routing table names the tools it runs in their own sandboxed children
  // (static D43(c)); the row table, not this file, decides that any of them is a write.
  "packages/gateway/src/connectors/lazy-mesh/iac-runner.ts",
];
const WRITE_ID_SHAPE = /^[a-z0-9_]+$/;
/** Build the D20 regex from the row tool ids; a malformed id throws rather than widening it. */
function buildConnectorWriteRe(ids: readonly string[]): RegExp {
  for (const id of ids) {
    if (!WRITE_ID_SHAPE.test(id)) {
      throw new Error(`D20: connector write row has a malformed tool id: ${JSON.stringify(id)}`);
    }
  }
  // The start is "no letter or digit before", not `\b`: `_` is a word character, so `\b` missed
  // the `<server>_<tool>` spelling a federated session executes (`jira_jira_issue_create`).
  // Every id is `[a-z0-9_]+` (checked above), so the alternation is literal and cannot backtrack.
  return new RegExp(`(?<![A-Za-z0-9])(?:${ids.join("|")})\\b`);
}
const CONNECTOR_WRITE_RE = buildConnectorWriteRe(CONNECTOR_WRITE_ROWS.map((r) => r.toolId));

const INVOKE_GATE_FILE = "packages/gateway/src/federation/invoke-gate.ts";
/** The predicates `answerFederatedInvoke` must consult, and the rule each one's absence breaks. */
const INVOKE_GATE_PREDICATES: readonly { readonly name: string; readonly rule: string }[] = [
  { name: "isWriteForbiddenToolId", rule: "D20-invoke-gate-predicate" },
  { name: "isCodeExecutionForbiddenToolId", rule: "D20-invoke-gate-code-execution" },
];

/**
 * Each predicate must be CALLED in code (`ctx.isWriteForbiddenToolId?.(...)`), not merely named:
 * the `InvokeGateCtx` interface declares both fields, so a name-only check passed with the call
 * deleted — it could not fail for the one regression it exists to catch.
 */
function invokeGatePredicateViolations(f: FileEntry): Violation[] {
  const code = stripStringLiterals(stripComments(f.contents));
  return INVOKE_GATE_PREDICATES.filter(
    (p) => !new RegExp(String.raw`\b${p.name}\s*(?:\?\.)?\s*\(`).test(code),
  ).map((p) => ({
    rule: p.rule,
    file: f.relPath,
    line: 1,
    snippet: `answerFederatedInvoke must call ${p.name} (I26)`,
  }));
}

export function checkConnectorWriteConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath === INVOKE_GATE_FILE) {
      out.push(...invokeGatePredicateViolations(f));
      continue;
    }
    if (
      CONNECTOR_WRITE_ALLOWED.some(
        (p) => f.relPath === p || (p.endsWith("/") && f.relPath.startsWith(p)),
      )
    ) {
      continue;
    }
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (CONNECTOR_WRITE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D20-connector-write",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D21 (I27): the outbound-share HITL action-type literal `share.publish` may be NAMED only in the
// executor (the HITL frozen-set membership, I2) and the share-gate (the sole gateway-side gating
// site). The share signing private-key Vault-key literal `share.signing.privkey` may be NAMED only
// in share-keypair.ts (its single home). Any other reference would let a caller register or gate a
// share publish out of band — bypassing the local owner's HITL gate (I27) — or compose the signing
// key outside the keypair module (a Vault-keyspace leak, Non-Negotiable #3). Test files are exempt.
const D21_PUBLISH_ALLOWED = [
  "packages/gateway/src/engine/executor.ts",
  "packages/gateway/src/share/share-gate.ts",
  "packages/gateway/src/share/share-forward.ts", // I27 second emit chokepoint (re-forward HITL)
];
const D21_PUBLISH_RE = /['"`]share\.publish['"`]/;
const D21_PRIVKEY_ALLOWED = ["packages/gateway/src/share/share-keypair.ts"];
const D21_PRIVKEY_RE = /['"`]share\.signing\.privkey['"`]/;

export function checkSharePublishConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (D21_PUBLISH_RE.test(line) && !D21_PUBLISH_ALLOWED.includes(f.relPath)) {
        out.push({
          rule: "D21-share-publish",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
      if (D21_PRIVKEY_RE.test(line) && !D21_PRIVKEY_ALLOWED.includes(f.relPath)) {
        out.push({
          rule: "D21-share-signing-privkey",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
