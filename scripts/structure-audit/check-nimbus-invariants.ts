#!/usr/bin/env bun

import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import { CO_OWNED_ENTITY_TYPES } from "../../packages/gateway/src/graph/relationship-graph.ts";
import { auditOutputPath, iterateSourceFiles, stripComments, stripStringLiterals } from "./lib.ts";

export type FileEntry = { relPath: string; contents: string };
export type Violation = { rule: string; file: string; line: number; snippet: string };

export const VAULT_KEY_ALLOW_LIST = [
  "packages/gateway/src/connectors/connector-vault.ts",
  "packages/gateway/src/auth/google-access-token.ts",
  "packages/gateway/src/auth/pkce.ts",
  "packages/gateway/src/auth/oauth-vault-tokens.ts",
  "packages/gateway/src/auth/oauth-registry.ts",
  "packages/gateway/src/auth/zoom-access-token.ts",
  "packages/gateway/src/embedding/create-embedding-runtime.ts",
  "packages/gateway/src/connectors/connector-secrets-manifest.ts",
  "packages/gateway/src/extensions/publisher-keys.ts",
  // The SOLE vendor-key exemption. The four cloud adapters do NOT need one: they receive an
  // injected `ApiKeyResolver` and never name a `<vendor>.api_key` literal themselves, so
  // exempting them would widen the audit surface for nothing.
  "packages/gateway/src/llm/vendor-vault-keys.ts",
];

/**
 * Non-connector Vault keys that are part of the platform keyspace (I22 org-policy signing
 * material). Registered here so the keyspace is documented in one place; these live in the
 * Vault only and never appear in logs/IPC/config (Non-Negotiable #3).
 */
export const PLATFORM_VAULT_KEYS = [
  "policy.signing.privkey",
  "policy.signing.pubkey",
  "http_api.deployment_token",
  "http_api.web_clipper_tokens",
  // Slice 2b cloud vendors, read per call by the four `llm/*-provider.ts` adapters and by
  // `platform/assemble.ts`'s vendor resolution. NEVER read from the environment: an env var must
  // not be able to satisfy a vendor nobody opted into, which is the hole the per-vendor
  // `[llm.remote.<vendor>] enabled` flag exists to close.
  //
  // `openai.api_key` is DELIBERATELY REUSED from the embedding runtime rather than minted as a
  // second OpenAI key: same credential, same vendor, and a second key for one vendor invites
  // drift. It is also the sharpest test of the opt-in — an existing embeddings user already has
  // this key, so a capability that turned itself on because a credential exists would light up
  // for them without their asking.
  "anthropic.api_key",
  "openai.api_key",
  "gemini.api_key",
  "xai.api_key",
  "chatops.channel.salt",
] as const;

const SPAWN_RE = /\b(?:Bun\.spawn|Bun\.spawnSync|child_process\.spawn|spawn)\s*\(/;

export function checkSpawnInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith("packages/gateway/src/connectors/")) continue;
    const lines = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!SPAWN_RE.test(line)) continue;
      const window = lines.slice(i, Math.min(i + 6, lines.length)).join("\n");
      if (window.includes("extensionProcessEnv")) continue;
      out.push({
        rule: "D10-spawn",
        file: f.relPath,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
  return out;
}

export const LAZY_MESH_DIR = "packages/gateway/src/connectors/lazy-mesh";
export const I15_EXEMPT: readonly string[] = [
  `${LAZY_MESH_DIR}/wrap-server-spec.ts`,
  `${LAZY_MESH_DIR}/slot.ts`,
  `${LAZY_MESH_DIR}/tool-map.ts`,
  `${LAZY_MESH_DIR}/first-party-manifests.ts`,
];

/**
 * A `ServerSpec` literal. Every spawn site under lazy-mesh opens with this spread — 78 of them
 * across `connector-spawns.ts`, `phase3-config.ts` and `chatops-bot-spawn.ts` — which makes it
 * the marker a PER-SITE rule can key on.
 */
const I15_SPEC_LITERAL_RE = /\.\.\.\s*connectorSpawn\s*\(/g;
/** The wrapper itself — always accepted, wherever it appears. */
const I15_WRAPPER_CALLEE = "wrapServerSpec";
/**
 * The file-local alias, accepted ONLY in a file that defines it as a delegation to the wrapper.
 *
 * `connector-spawns.ts` and `phase3-config.ts` each declare
 * `function wrap(spec, serviceId, ctx) { return wrapServerSpec(spec, …); }` and route their specs
 * through it, so the alias has to be accepted or the rule is unusable. But accepting the NAME
 * alone means a new file declaring `function wrap(s: ServerSpec) { return s; }` makes every site
 * in that file compliant — the guard would be checking that a call is spelled `wrap`, not that the
 * spec reaches the sandbox. So the alias is bound to the reason it exists: the delegation must be
 * present in the same file.
 */
const I15_ALIAS_CALLEE = "wrap";
const I15_ALIAS_DELEGATES_RE =
  /function\s+wrap\s*\([^)]{0,200}\)\s*:?[^{]{0,80}\{\s*return\s+wrapServerSpec\s*\(/;

/**
 * Which call, if any, lexically encloses the offset — the callee name of the nearest `(` that is
 * still open at that point. `wrap({ ...connectorSpawn("slack"), env: … }, "slack", ctx)` answers
 * `wrap`; the same literal sitting bare inside `new MCPClient({ servers: { slack: {…} } })`
 * answers `MCPClient`, which is exactly the difference the rule needs to see.
 */
function enclosingCallee(stripped: string, offset: number): string | undefined {
  let depth = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const c = stripped[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "[" || c === "{") {
      if (depth === 0) continue; // an object/array literal is not a call boundary
      depth--;
    } else if (c === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const before = stripped.slice(Math.max(0, i - 96), i);
      return /([A-Za-z_$][\w$]{0,64})\s*$/.exec(before)?.[1];
    }
  }
  return undefined;
}

export function checkWrapServerSpecInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith(`${LAZY_MESH_DIR}/`)) continue;
    if (I15_EXEMPT.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents);
    const lines = stripped.split("\n");
    // Earned per file, not granted by name: see I15_ALIAS_DELEGATES_RE.
    const aliasIsReal = I15_ALIAS_DELEGATES_RE.test(stripped);
    I15_SPEC_LITERAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null = I15_SPEC_LITERAL_RE.exec(stripped);
    while (m !== null) {
      const callee = enclosingCallee(stripped, m.index);
      const wrapped = callee === I15_WRAPPER_CALLEE || (callee === I15_ALIAS_CALLEE && aliasIsReal);
      if (!wrapped) {
        const line = stripped.slice(0, m.index).split("\n").length;
        out.push({
          rule: "D10-wrap-spec",
          file: f.relPath,
          line,
          snippet: (lines[line - 1] ?? "").trim(),
        });
      }
      m = I15_SPEC_LITERAL_RE.exec(stripped);
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function buildVaultKeyRegex(): RegExp {
  const keys = Object.values(CONNECTOR_VAULT_SECRET_KEYS).flat();
  const suffixes = Array.from(new Set(keys.map((k) => k.split(".")[1] ?? "")));
  const literalAlt = keys.map(escapeRegex).join("|");
  const suffixAlt = suffixes.map(escapeRegex).join("|");
  return new RegExp(`['"\`](${literalAlt})['"\`]|\\$\\{[^}]+\\}\\.(${suffixAlt})`);
}

const VAULT_KEY_RE = buildVaultKeyRegex();

export function checkVaultKeyAllowList(
  files: readonly FileEntry[],
  allowList: readonly string[] = VAULT_KEY_ALLOW_LIST,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (allowList.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] as string;
      const prevLine = originalLines[i - 1] ?? "";
      if (prevLine.includes("audit-ignore-next-line D11-vault-key")) continue;
      if (!VAULT_KEY_RE.test(line)) continue;
      out.push({
        rule: "D11-vault-key",
        file: f.relPath,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
  return out;
}

export type DbRunHit = {
  file: string;
  line: number;
  function: string;
  snippet: string;
};

export const DB_RUN_EXEC_ALLOW_LIST: readonly string[] = ["packages/gateway/src/db/write.ts"];

/**
 * A raw SQLite write is only caught if the rule can SEE it, and this pattern used to pin the
 * receiver to the literal name `db` (`/\b(?:this\.|ctx\.)?db\.(?:run|exec)\s*\(/`). `\b` cannot
 * match between the `w` and the `D` of `rawDb`, so `input.index.rawDb.run(...)` was invisible —
 * and `commands/data-delete.ts` has been executing two unwrapped DELETEs through exactly that
 * spelling, on the production `data.delete` IPC path, with D12 exiting 0 the whole time.
 *
 * The receiver is now any identifier ENDING in `db`/`Db`/`DB`, which is what this repo actually
 * names a `Database` handle: `db`, `this.db`, `ctx.db`, `rawDb`, `input.index.rawDb`. Surveyed
 * against every `.run(`/`.exec(` in production source first — 71 sites, of which the only ones
 * with a db-suffixed receiver are the real database handles, so the widening adds no false
 * positives. (The rest are overwhelmingly `RegExp.exec`, plus `coordinator.run` and
 * `AsyncLocalStorage.run`, none of which this can match.)
 *
 * Bounded quantifier, not `[\w$]*`: an unbounded prefix before a required literal backtracks
 * quadratically on a long word-character run, and this scans every line of every source file.
 *
 * Known bound, stated rather than papered over: a `Database` bound to a name that does not end
 * in `db` stays invisible — `embedding/embedding-worker.ts:26` binds one to `d`. A text scan
 * cannot resolve types. What it can do is cover the naming convention and say where it stops.
 */
const DB_RUN_EXEC_RE = /\b[\w$]{0,64}[dD][bB]\s*\.\s*(?:run|exec)\s*\(/;

/**
 * The prepared-statement form: `db.query(sql).run(...)` / `db.prepare(sql).run(...)`.
 *
 * `docs/SECURITY-INVARIANTS.md` has named `stmt.run(` an I14 anti-pattern since the invariant was
 * written, and `db/write.ts` exports `dbStmtRun` as its wrapper — but no rule ever looked for it,
 * and `index/local-index.ts` has been running an `UPDATE sync_state` through `.query(...).run(...)`
 * three lines above a compliant `dbRun` INSERT. Whole-file rather than per-line because the two
 * halves routinely sit on different lines once the SQL is long enough to wrap.
 */
const DB_STMT_RUN_RE = /\.\s*(?:query|prepare)\s*\([\s\S]{0,400}?\)\s*\.\s*run\s*\(/g;
const FN_DECL_RE = /(?:function|async\s+function)\s+([A-Za-z_$][\w$]{0,127})/;
const FN_CALL_RE = /([A-Za-z_$][\w$]{0,127})\s{0,8}\([^)]{0,500}\)\s{0,8}[:{=]/;

function findEnclosingFunction(lines: readonly string[], from: number): string {
  for (let j = from; j >= Math.max(0, from - 30); j--) {
    const candidate = lines[j] as string;
    const decl = FN_DECL_RE.exec(candidate);
    if (decl) return decl[1] ?? "<unknown>";
    const call = FN_CALL_RE.exec(candidate);
    if (call) return call[1] ?? "<unknown>";
  }
  return "<top-level>";
}

export function findDirectDbRunExec(
  files: readonly FileEntry[],
  allowList: readonly string[] = DB_RUN_EXEC_ALLOW_LIST,
): DbRunHit[] {
  const out: DbRunHit[] = [];
  for (const f of files) {
    if (allowList.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents);
    const strippedLines = stripped.split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] as string;
      if (!DB_RUN_EXEC_RE.test(line)) continue;
      out.push({
        file: f.relPath,
        line: i + 1,
        function: findEnclosingFunction(originalLines, i),
        snippet: (originalLines[i] as string).trim(),
      });
    }
    for (const hit of findStatementRunHits(f, stripped, originalLines)) out.push(hit);
  }
  return out;
}

/** The `.query(sql).run(...)` / `.prepare(sql).run(...)` half of D12, which spans lines. */
function findStatementRunHits(
  f: FileEntry,
  stripped: string,
  originalLines: readonly string[],
): DbRunHit[] {
  const out: DbRunHit[] = [];
  // Fresh lastIndex per file: the pattern is /g and module-level, so a shared one would skip
  // matches in whichever file happened to be scanned next.
  DB_STMT_RUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null = DB_STMT_RUN_RE.exec(stripped);
  while (m !== null) {
    const line = stripped.slice(0, m.index).split("\n").length;
    out.push({
      file: f.relPath,
      line,
      function: findEnclosingFunction(originalLines, line - 1),
      snippet: (originalLines[line - 1] ?? "").trim(),
    });
    m = DB_STMT_RUN_RE.exec(stripped);
  }
  return out;
}

export function collectDbRunCensus(files: readonly FileEntry[]): DbRunHit[] {
  return findDirectDbRunExec(files, []);
}

export function checkFederationImportInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const DIR = "packages/gateway/src/federation/";
  const ALLOWED = "packages/gateway/src/federation/query-gate.ts";
  for (const f of files) {
    if (!f.relPath.startsWith(DIR) || f.relPath === ALLOWED || f.relPath.endsWith(".test.ts")) {
      continue;
    }
    const lines = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/from\s+["'][^"']*item-list-query/.test(line)) {
        out.push({
          rule: "D13-federation-import",
          file: f.relPath,
          line: i + 1,
          snippet: line.trim(),
        });
      }
    }
  }
  return out;
}

const IDENTITY_TOKEN_KEYS = [
  "identity.oidc.id_token",
  "identity.oidc.refresh_token",
  "identity.scim.bearer",
];
const IDENTITY_DIR = "packages/gateway/src/identity/";
// Match a token key wrapped in any of the three string-literal quote styles (a backtick literal
// is just as much a leak as a single/double-quoted one).
const IDENTITY_TOKEN_LITERAL_RE = IDENTITY_TOKEN_KEYS.map(
  (k) => new RegExp(String.raw`['"\`]${escapeRegex(k)}['"\`]`),
);

/**
 * D14 (I18) — raw IdP tokens live only in the Vault, inside identity/.
 * Flags any non-identity, non-test file that references one of the identity token
 * Vault keys as a quoted string literal (a leak vector onto IPC/wire/logs/config).
 * Comments are stripped first so a mention in a doc-comment can't false-fail CI.
 */
export function checkIdentityTokenVaultInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.startsWith(IDENTITY_DIR) || f.relPath.endsWith(".test.ts")) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (IDENTITY_TOKEN_LITERAL_RE.some((re) => re.test(line))) {
        out.push({
          rule: "D14-identity-token",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D15 (I19) — the team-vault Vault keyspace prefix `teamvault.` is composed ONLY in
// team-vault-keys.ts (the single home for team secret-key derivation). Any other file that writes
// the exact literal `"teamvault."` is constructing a team-secret vault key out of band — a leak /
// keyspace-corruption vector. Matches the exact prefix literal (a trailing-dot then quote), so the
// audit action-type `teamvault.invoke.<decision>` and the `teamvault.*` IPC method names do NOT
// false-fail (they never close the quote immediately after the first dot).
const TEAM_VAULT_KEYS_HOME = "packages/gateway/src/teamvault/team-vault-keys.ts";
const TEAM_VAULT_PREFIX_LITERAL_RE = /['"`]teamvault\.['"`]/;

export function checkTeamVaultPrefixInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath === TEAM_VAULT_KEYS_HOME || f.relPath.endsWith(".test.ts")) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      // `startsWith("teamvault.")` is IPC method-name routing, not a vault-key construction — the
      // method namespace and the key prefix happen to share the literal. Only key construction leaks.
      if (line.includes("startsWith")) continue;
      if (TEAM_VAULT_PREFIX_LITERAL_RE.test(line)) {
        out.push({
          rule: "D15-teamvault-prefix",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

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

// D17 (I23) — the connector operational-post tools (`slack_chat_post` / `teams_chat_post`) may be
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
const CHATOPS_POST_RE = /\b(?:slack_chat_post|teams_chat_post)\b/;

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
const UNWRAPPED_POST_RE = /\bbuildConnectorPost\s*\(/g;
const WRAPPER_RE = /\bbuildLedgeredChatPosts\s*\(/g;

/** Byte offset -> 1-based line, so a per-offset finding can name a line. */
function lineOfOffset(text: string, offset: number): number {
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
function wrapperSpans(stmt: string): { open: number; close: number }[] {
  const spans: { open: number; close: number }[] = [];
  const re = new RegExp(WRAPPER_RE.source, "g");
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
      const spans = wrapperSpans(stmt);
      for (const m of stmt.matchAll(UNWRAPPED_POST_RE)) {
        const post = m.index ?? 0;
        // Safe ONLY when directly contained in SOME wrapper's own argument list — not merely
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

// D20 (I26): connector write tool ids (warehouse/BI ∪ GitOps/ML) may be NAMED only in the SSoT
// modules, the connector servers, and the gateway transport/dispatch sites. Any other reference could
// route a write outside the local executor I2 gate. Also requires answerFederatedInvoke
// (federation/invoke-gate.ts) to consult the write-id predicate (isWriteForbiddenToolId) so a
// federated peer can never trigger a connector write.
// The nine connector definition sites that used to need an exemption here
// (`packages/mcp-connectors/{snowflake,tableau,looker,powerbi,monte-carlo,bigeye,argocd,flux,mlflow}/src/server.ts`)
// left this repo in the v3.0.0 extraction to nimbus-mcp-servers, so only the gateway-side
// registry, transport and dispatch sites remain to exempt.
const CONNECTOR_WRITE_ALLOWED = [
  "packages/gateway/src/connectors/warehouse-write-tools.ts",
  "packages/gateway/src/connectors/gitops-ml-write-tools.ts",
  "packages/gateway/src/connectors/connector-write-transport.ts",
  "packages/gateway/src/connectors/connector-write-dispatch.ts",
];
const CONNECTOR_WRITE_RE =
  /\b(?:snowflake_tag_set|snowflake_comment_set|tableau_datasource_refresh|tableau_workbook_refresh|looker_datagroup_trigger|looker_schedule_run_once|powerbi_dataset_refresh|powerbi_dataflow_refresh|montecarlo_incident_acknowledge|montecarlo_incident_resolve|bigeye_issue_acknowledge|bigeye_issue_resolve|argocd_app_sync|argocd_app_rollback|flux_kustomization_reconcile|flux_helmrelease_reconcile|mlflow_model_promote|mlflow_model_transition_stage)\b/;

export function checkConnectorWriteConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath === "packages/gateway/src/federation/invoke-gate.ts") {
      if (!/isWriteForbiddenToolId/.test(stripComments(f.contents))) {
        out.push({
          rule: "D20-invoke-gate-predicate",
          file: f.relPath,
          line: 1,
          snippet: "answerFederatedInvoke must consult isWriteForbiddenToolId (I26)",
        });
      }
      continue;
    }
    if (CONNECTOR_WRITE_ALLOWED.some((p) => f.relPath === p)) continue;
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

// D21 (I27) extension: `createShare` — the share-gate chokepoint that runs the owner-HITL approval +
// sign + persist — may be CALLED only from share-gate.ts (its home) and the single wiring file
// share-rpc.ts. AND the boot site that builds createShare's `requestApproval` dependency
// (platform/assemble.ts) MUST supply the owner consent broker (`shareConsent.request`) — not an
// arbitrary always-true approval thunk. This binds the HITL set-membership (the executor frozen set,
// I2) to the actual gating call so they cannot silently drift: the share-gate's requestApproval IS
// the owner-HITL approval (a broadcast to the local owner), distinct from the executor gate() path.
// Mirrors D18 (PREFLIGHT_RUNNER_ALLOWED) / D19 (TRIBAL_KB_WRITE_ALLOWED). Test files are exempt.
const D21_CREATESHARE_ALLOWED = [
  "packages/gateway/src/share/share-gate.ts",
  "packages/gateway/src/ipc/share-rpc.ts",
];
const D21_CREATESHARE_RE = /\bcreateShare\b/;
const D21_CONSENT_WIRING_FILE = "packages/gateway/src/platform/assemble.ts";
// Require `shareConsent.request` to be wired AS the `requestApproval` dependency (not merely
// mentioned somewhere) — so an unrelated/dead `shareConsent.request` reference can't satisfy the
// check while the real approval thunk is an always-true stub.
const D21_CONSENT_RE = /requestApproval\s*:[\s\S]{0,400}?shareConsent\.request\b/;

export function checkShareConsentBrokerConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // (B) the boot site must feed the owner broker, not an arbitrary approval thunk.
    if (f.relPath === D21_CONSENT_WIRING_FILE) {
      if (!D21_CONSENT_RE.test(stripComments(f.contents))) {
        out.push({
          rule: "D21-share-consent-broker",
          file: f.relPath,
          line: 1,
          snippet:
            "assemble.ts must supply shareConsent.request as createShare's requestApproval (I27)",
        });
      }
      continue;
    }
    // (A) createShare may not be NAMED outside the gate + the one wiring file.
    if (D21_CREATESHARE_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D21_CREATESHARE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D21-createshare-callsite",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D24: a SYNCABLE may not reach a raw `vault` or `db` handle through its `SyncContext`.
//
// Before the narrowing, `SyncContext` carried both, so any of ~90 connectors could read any other
// connector's credentials and write any table. They are gone from the type, which makes a
// reintroduction a compile error — but only for as long as nobody adds them back, and a cast
// (`as unknown as SyncContext`) defeats the compiler entirely. That cast is not hypothetical: it
// was the ONE site in the 122-file migration the type system could not catch.
//
// Rule ids here are short kebab naming the PROPERTY, never the `D<N>` label — `db-run`,
// `wrap-spec`, `vault-key` — which is the docs-side name. The two coexist by design.
//
// `sync/sync-capabilities.ts` is the sole exemption: it is where a capability is minted, and it
// holds the handles so that nothing else has to.
const D24_SYNC_HANDLE_ALLOWED = [
  // Where a capability is minted. It holds the handles so nothing else has to.
  "packages/gateway/src/sync/sync-capabilities.ts",
  // FALSE POSITIVE, exempted knowingly: its `ctx` is a `ConnectorWriteContext` — the executor's
  // gateway-side write path with its own vault — not a `SyncContext`. A textual rule cannot tell
  // two identically-named parameters apart, and narrowing it by type would mean parsing. The
  // exemption is the honest form of that limit; the same reasoning applies to any future file
  // whose `ctx` is not a syncable's.
  "packages/gateway/src/connectors/connector-write-transport.ts",
];
// Written as a constructor rather than a literal: an earlier version of this line was authored
// through a script and its leading `\b` became a literal BACKSPACE byte, so the rule matched
// nothing and passed silently. Red-proving it — reintroducing `ctx.vault` and expecting a
// violation — is what caught that; a gate that cannot fail is worse than no gate.
const D24_SYNC_HANDLE_PATTERN = String.raw`\bctx\s*\.\s*(?:vault|db)\b`;
const D24_SYNC_HANDLE_RE = new RegExp(D24_SYNC_HANDLE_PATTERN);

export function checkSyncContextNoRawHandles(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // SYNCABLES only. `connectors/lazy-mesh/*` is the gateway-side spawn and credential path: it
    // holds a real vault by design and is what MINTS the environment a connector runs in, so it is
    // out of scope. The rule flagged it on its first working run — which is also the first evidence
    // the rule works at all.
    const isSyncable =
      f.relPath.startsWith("packages/gateway/src/connectors/") &&
      !f.relPath.startsWith("packages/gateway/src/connectors/lazy-mesh/");
    if (!isSyncable) continue;
    if (D24_SYNC_HANDLE_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D24_SYNC_HANDLE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "sync-context-no-raw-handles",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D25: a CONNECTOR SYNCABLE may not call `Bun.spawn` — it must go through
// `platform/spawn-capture.ts`, which spawns with `windowsHide`.
//
// The Gateway runs DETACHED, so on Windows a console-subsystem child with no console to inherit
// gets a brand-new one allocated, plus a `conhost.exe` to host it — i.e. a visible window that
// opens and closes for the lifetime of every CLI call. That is not a rare event at connector
// rates: `cloudwatch` and `sagemaker` spawn one `aws` process PER INDEXED ITEM through
// `runAwsCliPaginatedWalk`'s `processEntry`, and `aws` re-lists Lambda functions every 120 s, so
// the unhidden version flashed dozens of windows per sync tick on an otherwise idle machine.
//
// This is a STATIC rule because the failure is invisible to every test and to CI: it reproduces
// only on Windows, only when the parent has no console, and it breaks nothing — the sync still
// works. A reviewer on macOS or Linux cannot see it, and neither can the 3-OS matrix, whose
// Windows leg runs tests from a shell that HAS a console.
//
// `blame-index-sync.ts` and `filesystem-v2-sync.ts` are exempted: they take `Bun.spawn` as an
// INJECTED default parameter (`spawn: SpawnFn = Bun.spawn`) rather than calling it inline, and
// converting that seam is a wider change than this rule's subject. They spawn `git`, which is
// equally affected — tracked separately rather than silently blessed.
const D25_BUN_SPAWN_RE = /\bBun\s*\.\s*spawn\b/;
const D25_BUN_SPAWN_ALLOWED: readonly string[] = [
  "packages/gateway/src/connectors/blame-index-sync.ts",
  "packages/gateway/src/connectors/filesystem-v2-sync.ts",
];

export function checkConnectorSpawnIsHidden(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/connectors/")) continue;
    if (f.relPath.startsWith("packages/gateway/src/connectors/lazy-mesh/")) continue;
    if (D25_BUN_SPAWN_ALLOWED.includes(f.relPath)) continue;
    // Scans the WHOLE stripped source, not line by line. `Bun` and `.spawn` may sit on
    // different lines — `Bun` then a newline then `.spawn(...)` is valid TypeScript, and a
    // per-line test matches NEITHER line, so the rule would silently miss it. `stripComments`
    // preserves length, so a match offset maps 1:1 onto the original's line numbering.
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");
    const re = new RegExp(D25_BUN_SPAWN_RE.source, "g");
    for (const m of stripped.matchAll(re)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "connector-spawn-must-be-hidden",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D23 (I33): `runConfined` — the confined-spawn primitive that turns user-supplied code into a
// running process — may be CALLED only from the exec gate (which performs the config/policy checks,
// the sandbox-posture assertion and the owner-HITL approval first) plus its own definition file.
// A second caller would be a second path from arbitrary code to a process, bypassing every one of
// those, which is precisely what I33 forbids. Mirrors D21's createShare/forwardShare confinement.
// Test files are exempt.
const D23_RUNCONFINED_ALLOWED = [
  "packages/gateway/src/exec/exec-gate.ts",
  "packages/gateway/src/exec/exec-run.ts",
];
const D23_RUNCONFINED_RE = /\brunConfined\s*\(/;

export function checkRunConfinedConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D23_RUNCONFINED_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D23_RUNCONFINED_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D23-runconfined-callsite",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D26(a) (I35): `performActuation` — the primitive that turns a model-proposed action into a real
// interaction with the host — may be CALLED only from the computer-use gate (which performs the
// config/policy checks, the sandbox assertion, the envelope check, the structural classification,
// the ledger append and the owner-HITL approval first) plus its own definition file. A second
// caller would be a second path from a model proposal to the host, bypassing every one of those.
// Mirrors D23's runConfined confinement. Test files are exempt.
// The gate is the one legitimate CALLER. `cu-actuate.ts` is the definition file, not a caller
// exemption: a wholesale file allow-list (the earlier shape) let ANY occurrence of
// `performActuation(` inside `cu-actuate.ts` through, including a second, illegitimate direct
// invocation added below the real declaration — undetected, because the whole file was skipped.
// Only the DECLARATION line is exempt there now; any call-shaped occurrence elsewhere in that
// file (or anywhere outside `cu-gate.ts`) is a violation, matching D23's tighter shape.
const D26_ACTUATE_GATE_FILE = "packages/gateway/src/computer-use/cu-gate.ts";
const D26_ACTUATE_DEFINITION_FILE = "packages/gateway/src/computer-use/cu-actuate.ts";
const D26_ACTUATE_RE = /\bperformActuation\s*\(/;
const D26_ACTUATE_DECLARATION_RE = /\bfunction\s+performActuation\s*\(/;

// Review finding: a call-text scan alone is defeated by an ALIASED import --
// `import { performActuation as invoke }` followed by `invoke(...)` contains no `performActuation(`
// call-shaped text anywhere, so the scan above stays silent while a second, unauthorized path to
// the host exists. Closed at the IMPORT, not the call: no file other than the gate may import
// `performActuation` under ANY local name -- if the symbol can never enter scope outside cu-gate.ts,
// there is no alias left to call it through. `[^}]*` deliberately allows other named imports on the
// same line/braces; this only cares whether `performActuation` appears as one of the specifiers.
const D26_ACTUATE_IMPORT_RE = /\bimport\s*\{[^}]*\bperformActuation\b[^}]*\}\s*from/;

export function checkActuationConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath === D26_ACTUATE_GATE_FILE) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      const isImport = D26_ACTUATE_IMPORT_RE.test(line);
      const isCall = D26_ACTUATE_RE.test(line);
      if (!isImport && !isCall) continue;
      if (f.relPath === D26_ACTUATE_DEFINITION_FILE && D26_ACTUATE_DECLARATION_RE.test(line)) {
        continue; // the declaration itself, not a call or an import
      }
      out.push({
        rule: isImport ? "D26-actuation-import" : "D26-actuation-callsite",
        file: f.relPath,
        line: i + 1,
        snippet: (original[i] ?? "").trim(),
      });
    }
  }
  return out;
}

// D26(b) (I35): the browser-driving CAPABILITY may live only under `computer-use/cu-lanes/`.
// Confining the actuation primitive alone does not carry the invariant — a new file could open its
// own channel to a browser and dispatch clicks directly, reaching the host without passing the
// gate's envelope check, classifier, consent round-trip or audit append.
//
// TWO patterns, because the library check ALONE was the wrong guard for the driver that shipped.
// It matched `playwright`/`playwright-core` only, and the real driver is raw CDP over a WebSocket
// with no dependency at all — a file opening its own CDP socket passed this rule silently, which
// was disclosed in `SECURITY-INVARIANTS.md` and is now closed:
//
//   1. `D26_DRIVER_LIB_RE` — importing a browser-automation library, static or dynamic form
//      (matching D22(d)). Kept and widened past the one library this repo tried and rejected: the
//      rule should not have to be re-widened the day someone adds `puppeteer`.
//   2. `D26_CDP_METHOD_RE` — naming a CDP `Domain.method` string literal (`"Page.navigate"`,
//      `"Input.dispatchMouseEvent"`, `"Runtime.evaluate"`, …). This is the one that actually
//      catches "a new file opens a raw socket and clicks", because a CDP client cannot do anything
//      WITHOUT naming a protocol method, whatever transport it reaches the browser over. Verified
//      to have ZERO matches across `packages/gateway/src`, `packages/cli/src` and `scripts/`
//      outside `cu-lanes/`, so the false-positive rate is not merely low, it is measured.
const D26_DRIVER_DIR = "packages/gateway/src/computer-use/cu-lanes/";
const D26_DRIVER_LIB_RE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:playwright(?:-core)?|puppeteer(?:-core)?|chrome-remote-interface|selenium-webdriver|chrome-launcher)["']/;
const D26_CDP_METHOD_RE =
  /["'`](?:Page|DOM|DOMDebugger|Runtime|Input|Target|Fetch|Network|Browser|Emulation|Security|Storage|Overlay|Accessibility)\.[A-Za-z][A-Za-z0-9]*["'`]/;

// D26(c) (I35): a LANE CONSTRUCTOR — `openBrowserLane`, `openTerminalLane` — may be named only by
// its own definition file and by the single wiring site that injects it into `CuGateDeps.lanes`.
//
// (b) confines the driver capability to `cu-lanes/`, but a wiring layer has to reach into that
// directory once to hand the constructor to the gate, and that one legitimate import is enough for
// a second, illegitimate one to hide beside it: any file importing `openBrowserLane` gets a live
// `BrowserLane` and can call `lane.click()` on it, with no envelope, no classification, no consent
// and no audit row — while (a) sees no `performActuation(` and (b) sees no driver capability,
// because the capability arrived as a function value rather than as protocol text.
//
// Exactly the shape D22(f) uses for `wrapLedgeredEmbedder` and its three construction sites, and
// the counterpart of the `CuRunDeps` split in `cu-gate.ts` — that split removes the constructor
// from the deps object the model-facing tool layer holds; this rule removes it from every module
// that could import it directly. Test files are exempt.
/**
 * KNOWN LIMIT of (b), stated rather than papered over: its two patterns — an automation-library
 * import and a CDP `Domain.method` literal — have NO TERMINAL ANALOGUE. The terminal lane's
 * capability is "spawn a process and write to its stdin", and `SandboxRunner.spawn` is used
 * legitimately by every connector and by `exec/`, so any regex over it would be noise or theatre.
 * What confines the terminal lane is (a), the rule below, and CAPABILITY REMOVAL (`CuRunDeps`
 * carries no lane constructor, so the model-facing tool layer cannot name one) — the same posture
 * D26 already records: capability removal is the primary defense, the static rules are the
 * backstop, and the runtime tests stay authoritative.
 */
const D26_LANE_CONSTRUCTORS: readonly { name: string; allowed: readonly string[] }[] = [
  {
    name: "openBrowserLane",
    allowed: [
      "packages/gateway/src/computer-use/cu-lanes/browser.ts", // the definition
      "packages/gateway/src/platform/assemble.ts", // the sole production wiring site
    ],
  },
  {
    name: "openTerminalLane",
    allowed: [
      "packages/gateway/src/computer-use/cu-lanes/terminal.ts", // the definition
      "packages/gateway/src/platform/assemble.ts", // the sole production wiring site
    ],
  },
];

function checkLaneConstructorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const { name, allowed } of D26_LANE_CONSTRUCTORS) {
    const re = new RegExp(`\\b${name}\\b`);
    for (const f of files) {
      if (f.relPath.endsWith(".test.ts")) continue;
      if (allowed.includes(f.relPath)) continue;
      const stripped = stripComments(f.contents).split("\n");
      const original = f.contents.split("\n");
      for (let i = 0; i < stripped.length; i++) {
        if (re.test(stripped[i] ?? "")) {
          out.push({
            rule: "D26-lane-constructor",
            file: f.relPath,
            line: i + 1,
            snippet: (original[i] ?? "").trim(),
          });
        }
      }
    }
  }
  return out;
}

export function checkDriverImportConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath.startsWith(D26_DRIVER_DIR)) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      if (D26_DRIVER_LIB_RE.test(line) || D26_CDP_METHOD_RE.test(line)) {
        out.push({
          rule: "D26-driver-import",
          file: f.relPath,
          line: i + 1,
          snippet: (original[i] ?? "").trim(),
        });
      }
    }
  }
  out.push(...checkLaneConstructorConfinement(files));
  return out;
}

// D21 (I27) extension: `forwardShare` — the re-forward chokepoint (owner-HITL + hop-append + emit) —
// may be CALLED only from its home (share-forward.ts) and the single wiring file federation-rpc.ts.
// Mirrors the createShare confinement so the SECOND outbound-share emit path cannot be invoked out of
// band, bypassing the owner's share.publish HITL gate (I27). Test files are exempt.
const D21_FORWARDSHARE_ALLOWED = [
  "packages/gateway/src/share/share-forward.ts",
  "packages/gateway/src/ipc/federation-rpc.ts",
];
const D21_FORWARDSHARE_RE = /\bforwardShare\b/;

export function checkForwardShareConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D21_FORWARDSHARE_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D21_FORWARDSHARE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D21-forwardshare-callsite",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D22 — the egress chokepoint confinement.
//
// SCOPE, stated precisely because the previous comment overstated it: this rule matches the literal string
// `connectors.dispatch` line by line. It CANNOT see a dispatcher decorator that calls
// `inner.dispatch(action)` (see connectors/connector-write-dispatch.ts), a façade that re-exposes
// execution under another name, or a raw `tool.execute()` on a lazy-mesh tool record. Those paths
// are addressed by removing the capability (Phase 2 of the I29 security spec), not by this regex.
//
// What it does enforce: no NEW site may spell `connectors.dispatch` outside engine/executor.ts,
// `appendEgressEntry` stays inside egress/, and `recordAgentBriefEgress` is named only by its
// definition and its single caller (rule (c), below). Test files are exempt.
const D22_DISPATCH_ALLOWED = "packages/gateway/src/engine/executor.ts";
const D22_DISPATCH_RE = /\bconnectors\.dispatch\b/;
const D22_APPEND_RE = /\bappendEgressEntry\b/;
const D22_APPEND_ALLOWED_PREFIX = "packages/gateway/src/egress/";

// (c) the agent brief egress chokepoint must be TOTAL: `recordAgentBriefEgress` is CALLED from
// exactly one file. This mirrors (a) — it pins the caller, it does not merely permit an appender.
// Adding a file to an allowlist here would satisfy the checker while dissolving the property it
// protects.
//
// The symbol was `recordMcpBriefEgress` until agent briefs became reachable over HTTP as well as
// stdio. The rule moved with it IN THE SAME COMMIT: a rule pinning a symbol that no longer exists
// passes vacuously, which is indistinguishable from a rule that is working.
const D22_AGENT_RECORD_RE = /\brecordAgentBriefEgress\b/;
const D22_AGENT_RECORD_CALLER = "packages/gateway/src/ipc/agents-rpc.ts";
const D22_AGENT_RECORD_DEFINITION = "packages/gateway/src/egress/agent-brief-egress.ts";

// (e) the ROUTE-TABLE chokepoint. `LlmRegistry.addRoute` is where a provider is passed
// through `wrapLedgeredProvider` (the I29 `model`-class appender). A file that calls
// `LlmRouter.registerRoute` directly puts an UNWRAPPED provider in the route table, which
// then generates with no ledger row -- the `model` class silently incomplete while this
// audit stays green.
//
// `registry.ts` is permitted twice over: `addRoute` (which wraps) and `refreshProviderMeta`
// (which re-registers an ALREADY-wrapped provider to update its meta, and must NOT wrap
// again or every generate would append twice). `router.ts` holds the definition.
const D22_REGISTER_ROUTE_RE = /\bregisterRoute\b/;
const D22_REGISTER_ROUTE_ALLOWED: readonly string[] = [
  "packages/gateway/src/llm/registry.ts",
  "packages/gateway/src/llm/router.ts",
];

// (d) the EMITTER chokepoint. Rule (c) pins the caller of the appender, which catches a second file
// acquiring the appender — but NOT a second file that serves a brief without calling it at all.
// That path spells nothing (c) matches: it would append no row, serve the brief, and leave
// audit:invariants green. docs/SECURITY-INVARIANTS.md recorded that gap in prose, naming a
// browser-reachable agent route as the surface that would hit it; this rule closes it before that
// surface can.
//
// The property: only ipc/agents-rpc.ts may import an agent EMITTER module. Emitters are
// `packages/gateway/src/agents/<name>.ts`; `agents/_lib/` is excluded because it holds types and
// shared helpers (findings.ts, demo-symbol.ts) that federation/ and ipc/ legitimately consume.
//
// ALL THREE module-resolution forms are matched. A static-only regex is defeated by the
// one-character change from `import x from "…"` to `await import("…")`, and BOTH are defeated by
// `require("…")` — which is not theoretical here: Bun resolves `require("../agents/why.ts")` from a
// TypeScript module and hands back the live emitter, verified by running it. An enumeration of
// import forms is only as good as its completeness, so adding a fourth spelling must add a fourth
// pattern rather than assume the existing ones generalise.
//
// KNOWN LIMIT, stated because D22's existing weakness is exactly this: a regex over import
// specifiers does not follow re-export chains. An emitter re-exported through `agents/_lib/` could
// be imported from the excluded path and this rule would miss. That is closed by an assertion in
// security-invariants.test.ts ("agents/_lib re-exports no emitter"), not by this regex — the same
// answer as the wrapper/façade limit above: address the capability, do not pretend the regex sees it.
const D22_EMITTER_ALLOWED = "packages/gateway/src/ipc/agents-rpc.ts";
const D22_EMITTER_DIR = "packages/gateway/src/agents/";
// SUBDIRECTORIES. All three patterns below carry `(?:\/[\w-]+)*` after the first path segment,
// because `[\w-]` cannot cross a `/`: the earlier `[A-Za-z][\w-]*\.ts` form matched
// `../agents/why.ts` and missed `../agents/briefs/summary.ts` outright, so nesting emitters one
// directory deep — an ordinary refactor once there are more than a handful — would have silently
// taken every emitter back out of this rule's sight.
//
// This is the SAME defect #1216 fixed for D17/I23, in the sibling rule, one commit earlier. Two
// rules written in the same style shared the same blind spot, which is the argument for the
// subdirectory case being part of the pattern rather than something each rule remembers.
//
// The `_lib/` exclusion still holds under nesting: the lookahead sits immediately after
// `/agents/`, so `agents/_lib/x/y.ts` is excluded by the same token as `agents/_lib/y.ts`.
//
// No catastrophic backtracking: each `(?:\/[\w-]+)` iteration must consume a literal `/`, which
// `[\w-]` cannot, so the split between the segments is unambiguous. Pinned by a time-bounded test
// rather than by argument — a correctness test cannot tell linear from quadratic.

/** `from ".../agents/<name>.ts"` or `.../agents/<sub>/<name>.ts` — any quote style, not `_lib/`. */
const D22_EMITTER_STATIC_RE =
  /\bfrom\s+["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*(?:\/[\w-]+)*\.ts["'`]/;
/** `import(".../agents/<name>.ts")` — the dynamic form. */
const D22_EMITTER_DYNAMIC_RE =
  /\bimport\s*\(\s*["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*(?:\/[\w-]+)*\.ts["'`]/;
/** `require(".../agents/<name>.ts")` — the CommonJS form, which Bun honours from a .ts module. */
const D22_EMITTER_REQUIRE_RE =
  /\brequire\s*\(\s*["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*(?:\/[\w-]+)*\.ts["'`]/;

export function checkAgentEmitterImportConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // An emitter importing a sibling emitter is internal to the agents package, not a second entry
    // point. The rule is about who can reach IN from outside.
    if (f.relPath.startsWith(D22_EMITTER_DIR)) continue;
    if (f.relPath === D22_EMITTER_ALLOWED) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (
        D22_EMITTER_STATIC_RE.test(line) ||
        D22_EMITTER_DYNAMIC_RE.test(line) ||
        D22_EMITTER_REQUIRE_RE.test(line)
      ) {
        out.push({
          rule: "D22-agent-emitter-import",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D22 (f): the EMBEDDING appender. `egress/embedding-egress.ts`'s `wrapLedgeredEmbedder` is
// the I29 `model`-class appender for embeddings. A file that constructs a remote embedder
// without it puts an unrecorded egress path in the index pipeline -- the exact false zero
// `nimbus prove` would then report a clean window over.
const D22_EMBED_WRAP_RE = /\bwrapLedgeredEmbedder\b/;
const D22_EMBED_WRAP_ALLOWED: readonly string[] = [
  "packages/gateway/src/egress/embedding-egress.ts",
  "packages/gateway/src/embedding/create-routing-runtime.ts",
  "packages/gateway/src/embedding/create-embedding-runtime.ts",
  "packages/gateway/src/ipc/index-reembed-rpc.ts",
];

export function checkEmbeddingAppenderConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D22_EMBED_WRAP_ALLOWED.includes(f.relPath)) continue;
    // Whole-source scan, not per-line: `stripComments` preserves length, so a match offset
    // maps 1:1 onto the original line numbering.
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");
    const re = new RegExp(D22_EMBED_WRAP_RE.source, "g");
    for (const m of stripped.matchAll(re)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "embedding-appender-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

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

export function checkEgressChokepointConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (D22_DISPATCH_RE.test(line) && f.relPath !== D22_DISPATCH_ALLOWED) {
        out.push({
          rule: "D22-connectors-dispatch",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
      if (D22_APPEND_RE.test(line) && !f.relPath.startsWith(D22_APPEND_ALLOWED_PREFIX)) {
        out.push({
          rule: "D22-egress-append",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
      if (
        D22_AGENT_RECORD_RE.test(line) &&
        f.relPath !== D22_AGENT_RECORD_CALLER &&
        f.relPath !== D22_AGENT_RECORD_DEFINITION
      ) {
        out.push({
          rule: "D22-agent-brief-egress",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
      if (D22_REGISTER_ROUTE_RE.test(line) && !D22_REGISTER_ROUTE_ALLOWED.includes(f.relPath)) {
        out.push({
          rule: "D22-register-route",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// graph-entity flat/co-owned confinement — NOT a numbered security invariant and not a new one:
// this rule enforces a data-integrity property (Task 4 of the graph-entity-metadata-namespacing
// plan), not a docs/SECURITY-INVARIANTS.md row, so it deliberately does not take a "D2x" number —
// taking one would misstate what CLAUDE.md's "Static complement" line documents (D10 through D22
// map 1:1 onto specific I-numbers). It follows the D20–D22 SHAPE — a named regex plus an
// allowed-path constant — without claiming their provenance.
//
// WHAT IT PROTECTS: `graph_entity.metadata` is namespaced per-writer for the co-owned types
// named by `CO_OWNED_ENTITY_TYPES` — imported directly from relationship-graph.ts rather than
// restated here, so the two lists cannot drift (this script already imports other production
// constants, e.g. CONNECTOR_VAULT_SECRET_KEYS above). The membership rule, and which entries are
// live collisions versus defensive or uniformity inclusions, is documented at that constant and
// deliberately NOT duplicated here — a copy would be one more thing to keep true.
// The flat `upsertGraphEntity` REPLACES the whole `metadata` column; calling it with a co-owned
// type is exactly the bug Tasks 1–3 fixed (a code-symbol sync wiping the ownership-pass's owner
// counts). Step 1's `NonCoOwnedType<T>` already rejects a LITERAL co-owned type at compile time;
// this rule is the second, independent layer, covering literals in any file — including a file
// the compiler guard cannot see if the call site widens its type parameter, and including files
// added after this commit.
//
// A NEW co-owned type must be added to `CO_OWNED_ENTITY_TYPES` in relationship-graph.ts, in the
// SAME commit it becomes co-owned; this rule reads that constant directly and needs no edit of its
// own, but the commit must still convert every new co-owned write site to
// `upsertGraphEntityNamespaced` or this rule (and the compiler guard) will start catching them.
//
// MATCH SHAPE: the real call site is always multi-line —
//   upsertGraphEntity(db, {
//     type: "source_file",
// — never on one line — so a same-line regex would miss every real occurrence and pass vacuously.
// `[\s\S]{0,120}?` (lazy) spans from the `(` the regex just consumed to the `type:` literal,
// across newlines. 120 is bounded deliberately: re-measured against every real
// `upsertGraphEntity(` call site in graph-populator.ts on 2026-08-19, `type:` is always the FIRST
// field and starts 10–12 characters after that `(` (`db, {`, a newline, then a four- or
// six-space indent). 120 is therefore an order of magnitude of slack without being able to reach
// a SUBSEQUENT call, whose own `upsertGraphEntity(` starts hundreds of characters later in every
// measured case. This bound is asserted directly in this file's tests — a `type:` pushed past the
// window is NOT matched — rather than inferred from how fast the scan runs.
//
// `\bupsertGraphEntity\s*\(` does not match `upsertGraphEntityNamespaced`, and the reason is the
// `\s*\(`, NOT a trailing `\b`: the shipped pattern below has a LEADING `\b` only. In
// `upsertGraphEntityNamespaced(` the character right after `...Entity` is `N` — neither
// whitespace nor `(` — so the pattern cannot complete there. (A trailing `\b` would separate the
// two names as well, since `y`→`N` is word-to-word and no boundary exists; it simply is not what
// the code does, and this comment claimed it was.) No explicit exclusion of the namespaced name
// is needed either way.
//
// EXEMPTION: `.test.ts` files, matching every other rule in this file (D20/D21/D22). Tasks 1 and 3
// established that fixture-only test writes — `upsertGraphEntity<string>(db, { type: "person", ... })`
// with no `metadata`, existing only to materialise a node so a relation has an endpoint — correctly
// keep the flat call: neither "ownership" nor "symbols" describes a test fixture, and converting
// them would write a namespace nobody reads. The exemption is by FILE PATH, not by the presence of
// an explicit `<string>` type argument: trusting that argument as an opt-out marker would let ANY
// caller — including a future production writer — silence this rule by adding one type parameter,
// which is exactly the kind of escape hatch a "what cannot pass" rule must not offer. In the real
// `bun run audit:invariants` run this exemption is defense-in-depth rather than load-bearing:
// `iterateSourceFiles()` (scripts/structure-audit/lib.ts) already excludes every `.test.ts` file
// before any rule sees it. It matters when a check function here is exercised directly against a
// synthetic `FileEntry[]`, which is exactly how this file's own tests — and the fixture files named
// above — are exercised.
//
// LIMIT, stated rather than implied: like Step 1's `NonCoOwnedType<T>` compiler guard, this rule
// resolves LITERALS only. `upsertGraphEntity(db, { type: someVariable, ... })` evades both layers
// no matter what `someVariable` holds at runtime — neither layer can see through a `string`-typed
// binding to the value it carries. Together the two layers close every literal shape present in
// the tree today; a call site that computes its type dynamically evades both, and nothing here
// claims otherwise.
const GRAPH_ENTITY_FLAT_DEFINITION_SITE = "packages/gateway/src/graph/relationship-graph.ts";
const GRAPH_ENTITY_COOWNED_TYPE_ALT = CO_OWNED_ENTITY_TYPES.join("|");
// The optional `<...>` segment is LOAD-BEARING, not defensive tidiness. `upsertGraphEntity` is
// generic, so `upsertGraphEntity<string>(db, { type: "person", … })` instantiates `T` as `string`
// explicitly; `NonCoOwnedType<string>` collapses back to `string` (a non-union never distributes),
// so the compiler guard accepts it. Without this segment the regex did not match that shape
// either, which left a production caller able to defeat BOTH layers by adding one type argument —
// re-creating, by accident, exactly the caller-controlled opt-out the path-based exemption below
// was chosen to avoid. Red-proved in both directions before and after this change: a probe file
// using `<string>` passed `audit:invariants` AND `typecheck` beforehand, and fails the audit now.
// Bounded (`{0,120}`) and `(`-free so it cannot run past the call it is matching.
const GRAPH_ENTITY_COOWNED_FLAT_RE = new RegExp(
  `\\bupsertGraphEntity(?:\\s*<[^()]{0,120}>)?\\s*\\([\\s\\S]{0,120}?type:\\s*["'\`](?:${GRAPH_ENTITY_COOWNED_TYPE_ALT})["'\`]`,
  "g",
);

export function checkFlatUpsertGraphEntityCoOwnedTypes(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath === GRAPH_ENTITY_FLAT_DEFINITION_SITE) continue;
    const stripped = stripComments(f.contents);
    const lines = stripped.split("\n");
    GRAPH_ENTITY_COOWNED_FLAT_RE.lastIndex = 0;
    let m: RegExpExecArray | null = GRAPH_ENTITY_COOWNED_FLAT_RE.exec(stripped);
    while (m !== null) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "graph-entity-flat-coowned",
        file: f.relPath,
        line,
        snippet: (lines[line - 1] ?? "").trim(),
      });
      m = GRAPH_ENTITY_COOWNED_FLAT_RE.exec(stripped);
    }
  }
  return out;
}

type Mode = "spawn" | "wrap-spec" | "vault-key" | "db-run" | "db-run-exec" | "binary-only" | "all";

function parseArgs(argv: readonly string[]): Mode {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rule") {
      const r = argv[++i];
      if (
        r === "spawn" ||
        r === "wrap-spec" ||
        r === "vault-key" ||
        r === "db-run" ||
        r === "db-run-exec"
      ) {
        return r;
      }
      console.error(`unknown rule: ${r}`);
      process.exit(2);
    }
    if (a === "--binary-only") return "binary-only";
  }
  return "all";
}

async function loadFiles(): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for await (const f of iterateSourceFiles()) {
    out.push({ relPath: f.relPath, contents: f.contents });
  }
  return out;
}

/**
 * The production site each static rule below confines something TO.
 *
 * Every check in `run()` has the same shape — scan `files`, report what is out of place — so
 * every one of them reports "clean" when `files` is empty or has lost the package it polices.
 * There is no floor anywhere in this file, which means a single upstream breakage (a moved
 * package, a widened exclusion in `iterateGlob`, a glob that stops matching after a layout
 * change) would silently turn D10 through D22 into fourteen no-ops that exit 0 — and this
 * auditor runs BEFORE the test suite specifically so it fails first.
 *
 * A raw file count would catch the empty case but not the interesting one: a scan that still
 * finds a thousand files while the gateway subtree it is policing has dropped out. So the floor
 * is the anchors themselves. If the file a rule confines `connectors.dispatch` to is not in the
 * scanned set, that rule is not enforcing anything, whatever it reports.
 */
export const RULE_ANCHORS: readonly string[] = [
  "packages/gateway/src/engine/executor.ts", // D22 — connectors.dispatch chokepoint
  "packages/gateway/src/ipc/agents-rpc.ts", // D22(d) — agent emitter confinement
  "packages/gateway/src/db/write.ts", // D12 — bound-param SQL writes
  "packages/gateway/src/federation/query-gate.ts", // D13
  "packages/gateway/src/federation/invoke-gate.ts", // D15, D20
  "packages/gateway/src/federation/preflight-gate.ts", // D18
  "packages/gateway/src/identity/verifier.ts", // D14
  "packages/gateway/src/policy/policy-gate.ts", // D16
  "packages/gateway/src/chatops/reply-dispatcher.ts", // D17
  "packages/gateway/src/tribal/tribal-write-gate.ts", // D19
  "packages/gateway/src/connectors/connector-write-registry.ts", // D20
  "packages/gateway/src/share/share-gate.ts", // D21
  "packages/gateway/src/share/share-forward.ts", // D21 second emit path
  // graph-entity-flat-coowned. Anchored on a file the rule SCANS, not on relationship-graph.ts:
  // that file is the rule's own skip target (GRAPH_ENTITY_FLAT_DEFINITION_SITE), so its presence
  // in the scanned set proves nothing about whether the rule can see anything. ownership-pass.ts
  // is one of the two converted co-owned writers and is scanned normally.
  "packages/gateway/src/ownership/ownership-pass.ts",
  // D23 — anchored on the confined-spawn primitive's own home, a file the rule SCANS (it is on the
  // allow-list, so it is read and then permitted) rather than on some file the rule skips. Without
  // an anchor of its own, D23 would report clean while scanning nothing the moment
  // `iterateSourceFiles()` stopped loading `exec/`, and the D10–D22 anchors would still be present
  // to make the run look healthy.
  "packages/gateway/src/exec/exec-run.ts",
  // D22(f) — anchored on one of the three embedding-appender construction sites, a file the
  // rule SCANS (it is on the allow-list, so it is read and then permitted) rather than the
  // definition file the rule also permits. Same shape as the D23 anchor above.
  "packages/gateway/src/embedding/create-routing-runtime.ts",
  // D17-chatops-unwrapped-post — anchored on `chatops-boot.ts`, the ONE file that legitimately
  // contains a `buildLedgeredChatPosts(..., buildConnectorPost(...), ...)` call and so the one
  // file whose content this rule must actually parse to enforce anything. The reply-dispatcher.ts
  // anchor above is for the OLDER, separate D17-chatops-reply-surface rule (literal
  // slack_chat_post/teams_chat_post tool-id references) — that rule allow-lists
  // reply-dispatcher.ts, so its presence in the scanned set proves nothing about whether THIS
  // rule (the unwrapped-`buildConnectorPost` check) can see anything, since reply-dispatcher.ts
  // never calls buildConnectorPost. Without an anchor of its own, D17-chatops-unwrapped-post would
  // report clean while scanning nothing the moment `iterateSourceFiles()` stopped loading
  // `chatops/` — the exact inert-guard failure mode D22(f)/D23 exist to catch.
  "packages/gateway/src/chatops/chatops-boot.ts",
  // D26(a) (I35) — anchored on the actuation primitive's own home, a file the rule SCANS (it is
  // on the allow-list, so it is read and then permitted) rather than on cu-gate.ts, the other
  // allowed caller. Same shape as the D23 anchor above. D26(b) has no anchor: its confined
  // directory, `computer-use/cu-lanes/`, now holds the raw-CDP driver, so
  // there is no allowed file on disk to point at — see the rule's own comment.
  "packages/gateway/src/computer-use/cu-actuate.ts",
];

/** Fail loudly when the scanned set cannot support the rules about to run. */
export function assertScanIsMeaningful(files: readonly FileEntry[]): string[] {
  const present = new Set(files.map((f) => f.relPath));
  return RULE_ANCHORS.filter((a) => !present.has(a));
}

async function run(): Promise<void> {
  const mode = parseArgs(Bun.argv);
  const files = await loadFiles();

  // Before any rule runs, not after: a rule that examined nothing must not get the chance to
  // report clean. Exits 2 rather than 1 so "this auditor is broken" stays distinguishable from
  // "this auditor found a violation" — the same split `--db-run`'s exit codes already make.
  const missing = assertScanIsMeaningful(files);
  if (missing.length > 0) {
    console.error(
      `::error::structure audit scanned ${String(files.length)} file(s) but ${String(missing.length)} rule anchor(s) are absent, so D10-D22 would report clean without enforcing anything: ${missing.join(", ")}`,
    );
    console.error(
      "::error::Either a policed file moved (update RULE_ANCHORS in the same commit) or iterateSourceFiles() stopped reaching it (fix the glob/exclusions in scripts/structure-audit/lib.ts).",
    );
    process.exit(2);
  }

  let exit = 0;

  if (mode === "spawn" || mode === "binary-only" || mode === "all") {
    const v = checkSpawnInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D10 spawn not via extensionProcessEnv: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "wrap-spec" || mode === "binary-only" || mode === "all") {
    const v = checkWrapServerSpecInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::I15 lazy-mesh file constructs ServerSpec without wrapServerSpec — I15 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "vault-key" || mode === "binary-only" || mode === "all") {
    const v = checkVaultKeyAllowList(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D11 vault-key constructed outside allow-list: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "db-run-exec" || mode === "binary-only" || mode === "all") {
    const v = findDirectDbRunExec(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D12 direct db.run/db.exec outside allow-list: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkFederationImportInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D13 federation file imports item-list-query outside query-gate.ts — I17 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkIdentityTokenVaultInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D14 identity token key used outside identity/ — I18 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkTeamVaultPrefixInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D15 teamvault. prefix composed outside team-vault-keys.ts — I19 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkPolicyTomlImportInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D16 parsePolicyToml imported outside policy/ — read EnforcedPolicy via policy-gate.ts; I22 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkChatopsReplySurfaceInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D17 chatops post tool referenced outside reply-dispatcher/transport — bypasses I23: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkChatopsUnwrappedPost(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D17 buildConnectorPost called without buildLedgeredChatPosts — bypasses the I29 chatops egress ledger: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkPreflightRunnerInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D18 runPreflightCommand referenced outside preflight-gate/preflight-runner — bypasses I24: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkTribalKbWriteInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D19 tribal KB-write tool referenced outside the write-gate/connector sites — bypasses I25: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkConnectorWriteConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D20 connector write tool referenced/wired outside allowed sites — bypasses I26: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkSharePublishConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D21 share.publish action-type / share.signing.privkey vault-key referenced outside the gate/keypair sites — bypasses I27: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkShareConsentBrokerConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D21 createShare called outside the gate/share-rpc sites, or assemble.ts does not wire shareConsent.request as the approval dep — bypasses I27: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkForwardShareConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D21 forwardShare called outside share-forward.ts/federation-rpc.ts — bypasses I27 second emit chokepoint: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const handleViolations = checkSyncContextNoRawHandles(files);
    for (const e of handleViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D24 a syncable reached a raw vault/db handle — capabilities are the only route: ${e.snippet}`,
      );
    }
    if (handleViolations.length > 0) exit = 1;
    const spawnViolations = checkConnectorSpawnIsHidden(files);
    for (const e of spawnViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D25 a connector called Bun.spawn — use platform/spawn-capture.ts, which passes windowsHide (the detached Gateway pops a console window otherwise): ${e.snippet}`,
      );
    }
    if (spawnViolations.length > 0) exit = 1;
    const v = checkRunConfinedConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D23 runConfined called outside exec-gate.ts/exec-run.ts — bypasses the I33 code-execution gate: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const actuationViolations = checkActuationConfinement(files);
    for (const e of actuationViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D26 performActuation called outside cu-gate.ts/cu-actuate.ts — bypasses the I35 computer-use actuation gate: ${e.snippet}`,
      );
    }
    if (actuationViolations.length > 0) exit = 1;
    const driverImportViolations = checkDriverImportConfinement(files);
    for (const e of driverImportViolations) {
      console.error(
        e.rule === "D26-lane-constructor"
          ? `::error file=${e.file},line=${e.line}::D26(c) a computer-use lane constructor (openBrowserLane/openTerminalLane) is named outside its own definition file and platform/assemble.ts — a live lane obtained here can be driven with no envelope, classification, consent or audit row (I35): ${e.snippet}`
          : `::error file=${e.file},line=${e.line}::D26(b) browser-driving capability (automation library import, or a CDP Domain.method literal) outside computer-use/cu-lanes/ — a second path to the host that never passes the I35 gate: ${e.snippet}`,
      );
    }
    if (driverImportViolations.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEgressChokepointConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22 egress chokepoint breach (connectors.dispatch outside executor.ts, appendEgressEntry outside egress/, recordAgentBriefEgress outside agents-rpc.ts, or registerRoute outside llm/registry.ts) — bypasses I29: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkAgentEmitterImportConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(d) agent emitter imported outside ipc/agents-rpc.ts — a second entry point would serve a brief with no egress row; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEmbeddingAppenderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(f) wrapLedgeredEmbedder referenced outside the three construction sites/embedding-egress.ts — an unrecorded remote embed; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEmbeddingConstructorConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(f) createOpenAIEmbedder constructed outside the three construction sites/its own definition — a NEW remote embedder built without the wrapLedgeredEmbedder decorator; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkFlatUpsertGraphEntityCoOwnedTypes(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::flat upsertGraphEntity called with a co-owned type (${CO_OWNED_ENTITY_TYPES.join("/")}) — use upsertGraphEntityNamespaced instead, or the flat write wipes the other owner's namespace: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "db-run" || mode === "all") {
    const census = collectDbRunCensus(files);
    const outPath = auditOutputPath("db-run-census.json");
    await Bun.write(outPath, `${JSON.stringify(census, null, 2)}\n`);
    console.log(`db-run census: ${census.length} hits → ${outPath}`);
    // db-run always exits 0 — it's a census, not a gate.
  }

  process.exit(exit);
}

if (import.meta.main) await run();
