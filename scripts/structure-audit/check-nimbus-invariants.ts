#!/usr/bin/env bun

import { posix } from "node:path";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import { CONNECTOR_WRITE_ROWS } from "../../packages/gateway/src/connectors/connector-writes/index.ts";
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
  // D29(c). The keys are composed DYNAMICALLY (`toolgen.<toolId>.<hostSlug>`), so the audit's
  // literal scan cannot see them — capability confinement (only this file is handed the Vault for
  // that prefix) is the real defense and this entry documents the keyspace, exactly as D27(b)
  // states of the media_grant table.
  "packages/gateway/src/toolgen/toolgen-credentials.ts",
  // The toolgen SIGNING keys, unlike `toolgen-credentials.ts`'s per-host keys directly above, are
  // STATIC literals — the audit's literal scan genuinely sees them, so this entry is real
  // enforcement rather than documentation of a keyspace the scan cannot reach.
  "packages/gateway/src/toolgen/toolgen-keypair.ts",
  // An extension's OWN credential keyspace, `ext.<serviceId>.<name>` (Readwise unbundling, V72).
  // Composed dynamically like `toolgen-credentials.ts`'s, so the literal scan cannot see it; this
  // entry documents the keyspace, and the one function that composes it lives in this file.
  "packages/gateway/src/extensions/extension-credentials.ts",
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
  "toolgen.signing.privkey",
  "toolgen.signing.pubkey",
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
 * A `ServerSpec` literal. Every spawn site under lazy-mesh opens with this spread, which makes
 * it the marker a PER-SITE rule can key on. They live in `connector-spawns.ts`,
 * `chatops-bot-spawn.ts` and the `phase3-*.ts` spawn modules. The count is deliberately not
 * stated here: it moves with every connector, and the figure this comment used to carry
 * (78) was already three off when it was next checked.
 */
const I15_SPEC_LITERAL_RE = /\.\.\.\s*connectorSpawn\s*\(/g;
/** The wrapper itself — always accepted, wherever it appears. */
const I15_WRAPPER_CALLEE = "wrapServerSpec";
/** The iac runner's per-run wrapper (D2): `wrapServerSpecInCwd` plus the iac policy flag; still the sandbox. */
const I15_IAC_WRAPPER_CALLEE = "wrapIacServerSpec";
/**
 * The file-local alias, accepted ONLY in a file that defines it as a delegation to the wrapper.
 *
 * `connector-spawns.ts`, `phase3-shared.ts` and each `phase3-<group>.ts` declare
 * `function wrap(spec, serviceId, ctx) { return wrapServerSpec(spec, …); }` and route their specs
 * through it, so the alias has to be accepted or the rule is unusable. That per-file declaration
 * is also why splitting `phase3-config.ts` into group modules had to copy the delegation into
 * each one rather than import a shared `wrap`: an imported alias leaves every site in the
 * importing file unrecognised, and the rule would fail closed on all of them. But accepting the NAME
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
      const wrapped =
        callee === I15_WRAPPER_CALLEE ||
        callee === I15_IAC_WRAPPER_CALLEE ||
        (callee === I15_ALIAS_CALLEE && aliasIsReal);
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
// NAMED only in five gateway sites: the row table itself (and the manifest generated from the
// installed package), the write transport, the write dispatch, the act door's routing table
// (proposable-actions.ts) and the code-execution id classification. Any other reference could route
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
  "packages/gateway/src/connectors/proposable-actions.ts",
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

// ---- D24 extension: `work_snapshot` is written only by the capability's store (Phase 10 MB1) ------
//
// Rule `work-snapshot-confined`. A WRITE verb on `work_snapshot` may appear only in the store
// (`index/work-snapshot-store.ts`) and the V91 DDL file; the store's writer `replaceWorkSnapshotRows`
// may be NAMED only by the store and `sync/sync-capabilities.ts`. Reads are unrestricted (the morning
// briefing reads the table). So no syncable, agent, RPC or other store writes a snapshot: a syncable
// reaches it only through the `replaceWorkSnapshot` capability, which binds the service.
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says);
// confinement of the capability itself (scoped to jira, linear and github) is the real defense.
// `iterateGlob` skips every `-sql.ts` file, so the real scan never visits the DDL file; it stays in
// the allow-list only so a synthetic file set (which feeds files directly) can carry it.
const D24_WS_SRC = "packages/gateway/src/";
const D24_WS_STORE = `${D24_WS_SRC}index/work-snapshot-store.ts`;
const D24_WS_DDL = `${D24_WS_SRC}index/work-snapshot-v91-sql.ts`;
const D24_WS_CAPABILITY = `${D24_WS_SRC}sync/sync-capabilities.ts`;
// A constructor over `String.raw`, as the handle pattern above (a script-authored literal once lost
// its `\b`): the rule is red-proved against planted violations.
const D24_WS_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?work_snapshot\b/gi;
const D24_WS_NAME_RE = /\breplaceWorkSnapshotRows\b/g;

export function checkWorkSnapshotConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "work-snapshot-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D24_WS_SRC)) continue;
    const commentFree = stripComments(f.contents);
    if (f.relPath !== D24_WS_STORE && f.relPath !== D24_WS_DDL) {
      for (const m of commentFree.matchAll(D24_WS_WRITE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D24_WS_STORE && f.relPath !== D24_WS_CAPABILITY) {
      for (const m of commentFree.matchAll(D24_WS_NAME_RE)) add(f, commentFree, m.index);
    }
  }
  return out;
}

// ---- D24 extension: `chat_read_marker` is written only by its store (Phase 10 MB4) ---------------
//
// Rule `chat-read-marker-confined`. A WRITE verb on `chat_read_marker` may appear only in the store
// (`index/chat-read-marker-store.ts`) and the V92 DDL file; the store's upsert `setChatReadMarkerRows`
// may be NAMED only by the store and `sync/sync-capabilities.ts`, and its removal
// `deleteChatReadMarkersForService` only by the store and the two paths that delete a service's items
// (`index/local-index.ts`, `commands/data-delete.ts`). Reads are unrestricted (the briefing reads the
// table). So no syncable, agent, RPC or other store writes a marker: a syncable reaches it only
// through the `setChatReadMarkers` capability, which binds the service (and only `slack` may call it).
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says); the
// capability's confinement is the real defense. `iterateGlob` skips every `-sql.ts` file, so the real
// scan never visits the DDL file; it stays in the allow-list only so a synthetic file set can carry it.
const D24_CRM_STORE = `${D24_WS_SRC}index/chat-read-marker-store.ts`;
const D24_CRM_DDL = `${D24_WS_SRC}index/chat-read-marker-v92-sql.ts`;
const D24_CRM_REMOVERS: readonly string[] = [
  `${D24_WS_SRC}index/local-index.ts`,
  `${D24_WS_SRC}commands/data-delete.ts`,
];
const D24_CRM_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?chat_read_marker\b/gi;
const D24_CRM_SET_RE = /\bsetChatReadMarkerRows\b/g;
const D24_CRM_DELETE_RE = /\bdeleteChatReadMarkersForService\b/g;

export function checkChatReadMarkerConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "chat-read-marker-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D24_WS_SRC)) continue;
    const commentFree = stripComments(f.contents);
    if (f.relPath !== D24_CRM_STORE && f.relPath !== D24_CRM_DDL) {
      for (const m of commentFree.matchAll(D24_CRM_WRITE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D24_CRM_STORE && f.relPath !== D24_WS_CAPABILITY) {
      for (const m of commentFree.matchAll(D24_CRM_SET_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D24_CRM_STORE && !D24_CRM_REMOVERS.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D24_CRM_DELETE_RE)) add(f, commentFree, m.index);
    }
  }
  return out;
}

// D46(b) (Phase 10 IC1, incident-engine spec § 5.1): `item_history` is written only by its module.
// Rule `item-history-confined`. A WRITE verb on `item_history` may appear only in `index/item-history.ts`
// (and the V94 DDL file); `recordItemUpsertHistory` / `recordItemDeleteHistory` are named only there and in
// `index/item-store.ts` (`upsertIndexedItem`, `deleteItemByPrimaryKey`); `deleteItemHistoryForService` only
// there, in `index/item-store.ts` (`deleteAllItemsForService`, which `LocalIndex.removeConnectorIndexData`
// calls) and in `commands/data-delete.ts` (an owner erasure); `pruneItemHistory` only there and in
// `index/item-history-retention.ts`. Reads are unrestricted (the reconstruction and the incident assembly
// read the table). D46 has only sub-rule (b) after IC1: (a) and (c) are reserved by the incident-engine
// spec for IC3 and IC5.
//
// Stated bounds: a text scan, so a dynamically composed table name evades it (as D33(b) says). The retention
// module's batch DELETE lives in `item-history.ts`, which it only calls. `iterateGlob` skips every `-sql.ts`
// file, so the real scan never visits the DDL file; it stays in the allow-list only so a synthetic file set
// can carry it.
const D46_SRC = "packages/gateway/src/";
const D46_STORE = `${D46_SRC}index/item-history.ts`;
const D46_DDL = `${D46_SRC}index/item-history-v94-sql.ts`;
const D46_ITEM_STORE = `${D46_SRC}index/item-store.ts`;
const D46_RETENTION = `${D46_SRC}index/item-history-retention.ts`;
const D46_ERASERS: readonly string[] = [D46_ITEM_STORE, `${D46_SRC}commands/data-delete.ts`];
const D46_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE(?:\s+OR\s+\w+)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE)\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?item_history\b/gi;
const D46_RECORD_RE = /\brecordItem(?:Upsert|Delete)History\b/g;
const D46_ERASE_RE = /\bdeleteItemHistoryForService\b/g;
const D46_PRUNE_RE = /\bpruneItemHistory\b/g;

export function checkItemHistoryConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "item-history-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D46_SRC)) continue;
    const commentFree = stripComments(f.contents);
    if (f.relPath !== D46_STORE && f.relPath !== D46_DDL) {
      for (const m of commentFree.matchAll(D46_WRITE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D46_STORE && f.relPath !== D46_ITEM_STORE) {
      for (const m of commentFree.matchAll(D46_RECORD_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D46_STORE && !D46_ERASERS.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D46_ERASE_RE)) add(f, commentFree, m.index);
    }
    if (f.relPath !== D46_STORE && f.relPath !== D46_RETENTION) {
      for (const m of commentFree.matchAll(D46_PRUNE_RE)) add(f, commentFree, m.index);
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

// D28 (I38): the `fleet` ClientKind literal — the attribution that marks a call as unattended,
// owner-configured fleet work — may appear only where it is DEFINED, where its egress status is
// DECIDED, and in the one invoker that legitimately wears it. A second file naming it would be a
// second path able to file briefs under that attribution without passing the scheduler's config,
// policy, admission and I38 budget checks. Mirrors D23's runConfined confinement. Tests exempt.
//
// WHAT THIS RULE COVERS, and what it does not — stated plainly, in the style of D26(b), because a
// rule that implies completeness is worse than one that names its own edge. It matches the literal
// only where it is being ASSIGNED as a client kind:
//   * an object-literal property or a plain assignment — `kind: "fleet"`, `callerKind = "fleet"`
//     (any identifier ending in `kind`/`Kind`);
//   * a `ClientKind`-typed declaration — `const k: ClientKind = "fleet"`;
//   * a `ClientKind` assertion — `"fleet" as ClientKind`;
//   * a `ClientKindStore.declare(...)` second argument — `store.declare(id, "fleet")`;
//   * a quoted `"fleet":` map key whose value is `null` or a string, i.e. a second copy of the
//     egress classification.
// Each is checked against the line AND against that line joined with the next, so a formatter that
// breaks `kind:` from its literal does not slip past.
//
// It deliberately does NOT match a BARE `"fleet"` string. The word is a legitimate namespace token
// elsewhere — the LAN forbid-list (`ipc/lan-rpc.ts`) and the CLI command map both name it with no
// `ClientKind` involved — and a bare-string rule would false-positive on those, then be weakened or
// allow-listed until it caught nothing. A narrow rule that fires is worth more than a broad one
// that gets disarmed.
//
// WHAT THE ALLOW-LIST IMPLIES AND THE RULE DELIVERS — checked against the three files rather than
// inferred from the list's length. TWO of the three contain a shape this regex can see:
// `fleet-invoker.ts`'s `kind: "fleet"` and `egress-bearing-kinds.ts`'s `fleet: null`.
// `client-kind.ts` holds the union MEMBER (`| "fleet" |`), which matches no alternative above and
// is not meant to — a union member declares that the kind exists, it does not wear it.
//
// This paragraph previously said only ONE file was visible, and that a copy-paste of the REAL
// egress classification line would NOT be caught. That was true and is no longer: the map-key
// alternative required a QUOTED `"fleet":` while the shipped map writes it bare, so the rule caught
// a hand-written map and not this repo's own. Widening looked unsafe because `fleet:` is also how a
// CLI command map names the namespace — but the VALUE separates them exactly. An egress
// classification is `null`; a command-map entry is a function reference; a LAN forbid-list entry is
// a bare array element with no colon at all. Hence `\bfleet\s*:\s*null\b` and nothing wider.
//
// RESIDUAL BOUND: a regex cannot see every construction. An indirection
// (`const K = "fleet"; { kind: K }`), a computed key, or a value arriving from JSON all evade it —
// the same class of hole D23 carries and that D26(a) had to close at the import instead. The
// PRIMARY defense is capability confinement: the `ClientKind` value is only reachable where the
// scheduler builds its caller descriptor, and `RECOGNISED` in `client-kind.ts` independently
// refuses `fleet` as a client-DECLARED kind, so the socket path is closed by construction rather
// than by this scan. This rule is the backstop for the copy-paste case, not the boundary.
const D28_FLEET_KIND_ALLOWED = [
  "packages/gateway/src/ipc/server/client-kind.ts",
  "packages/gateway/src/egress/egress-bearing-kinds.ts",
  "packages/gateway/src/fleet/fleet-invoker.ts",
];
// The final alternative is the UNQUOTED map key, and it is pinned to a `null` VALUE on purpose.
// `fleet:` alone is how a CLI command map and a config object also name the namespace, which is why
// the rule previously stayed clear of the unquoted form altogether — but that left it unable to see
// the one line it most needs to: `egress-bearing-kinds.ts`'s real `fleet: null` classification, so a
// copy-paste of it into a fourth file passed. The value discriminates precisely: an egress
// classification is `null`, a command map entry is a function reference, and a forbid-list entry is
// a bare array element with no colon at all.
const D28_FLEET_KIND_RE =
  /\w*[Kk]ind\s*[:=]\s*["']fleet["']|:\s*ClientKind\s*=\s*["']fleet["']|["']fleet["']\s+as\s+ClientKind|\bdeclare\s*\([^)]*,\s*["']fleet["']|["']fleet["']\s*:\s*(?:null|["'])|\bfleet\s*:\s*null\b/;

export function checkFleetClientKindConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D28_FLEET_KIND_ALLOWED.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      const next = stripped[i + 1] ?? "";
      // The line alone, else the line joined with its successor. The joined form counts ONLY when
      // the successor does not match on its own: otherwise a violation sitting wholly on line i+1
      // would be reported twice — once here, at the wrong line number, and again at its own index.
      // The first line has to actually contribute for the window to mean anything.
      let matched = D28_FLEET_KIND_RE.test(line);
      if (!matched && !D28_FLEET_KIND_RE.test(next)) {
        matched = D28_FLEET_KIND_RE.test(`${line} ${next}`);
      }
      if (matched) {
        out.push({
          rule: "D28-fleet-client-kind",
          file: f.relPath,
          line: i + 1,
          snippet: (original[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

const D28_PUSH_KIND_ALLOWED = [
  "packages/gateway/src/ipc/server/client-kind.ts",
  "packages/gateway/src/egress/egress-bearing-kinds.ts",
  "packages/gateway/src/oncall-push/push-runner.ts",
];
// Same shapes as D28_FLEET_KIND_RE with "push" substituted. Both quote styles match in each rule:
// a single-quoted `kind: 'push'` is the same assignment, and a double-quote-only regex passed it. The bare unquoted key matches only a
// `null` VALUE, so OWNER_SCOPED_ONCALL_ALLOWED's `push: false` and every `arr.push(x)` stay clear.
const D28_PUSH_KIND_RE =
  /\w*[Kk]ind\s*[:=]\s*["']push["']|:\s*ClientKind\s*=\s*["']push["']|["']push["']\s+as\s+ClientKind|\bdeclare\s*\([^)]*,\s*["']push["']|["']push["']\s*:\s*(?:null|["'])|\bpush\s*:\s*null\b/;

export function checkPushClientKindConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D28_PUSH_KIND_ALLOWED.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      const next = stripped[i + 1] ?? "";
      // The line alone, else the line joined with its successor. The joined form counts ONLY when
      // the successor does not match on its own: otherwise a violation sitting wholly on line i+1
      // would be reported twice — once here, at the wrong line number, and again at its own index.
      // The first line has to actually contribute for the window to mean anything.
      let matched = D28_PUSH_KIND_RE.test(line);
      if (!matched && !D28_PUSH_KIND_RE.test(next)) {
        matched = D28_PUSH_KIND_RE.test(`${line} ${next}`);
      }
      if (matched) {
        out.push({
          rule: "D28-push-client-kind",
          file: f.relPath,
          line: i + 1,
          snippet: (original[i] ?? "").trim(),
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

// D22 (h): the REGISTRY appender and the registry fetch. `egress/registry-egress.ts`'s
// `recordRegistryEgress` is the I29 `registry`-class appender; its sole production caller is
// `extensions/registry/registry-fetch.ts`, the one function that fetches registry bytes. Two
// rules close the two ways to bypass it: (1) `recordRegistryEgress` named anywhere else is a
// second, unreviewed fetch path (or a forged row); (2) a bare `fetch(` call anywhere else under
// `extensions/` is a network request the registry ledger and its transport checks never saw.
// Stated bound: only the literal global `fetch(` is matched. An injected fetcher (`opts.fetcher(`,
// `deps.fetchFn(`) or an alias of `fetch` evades it, so capability confinement -- only
// `registry-fetch.ts` is ever handed the real `fetch` -- is the primary defense.
const D22_REGISTRY_APPENDER_RE = /\brecordRegistryEgress\b/;
const D22_REGISTRY_APPENDER_ALLOWED: readonly string[] = [
  "packages/gateway/src/egress/registry-egress.ts",
  "packages/gateway/src/extensions/registry/registry-fetch.ts",
];
const D22_REGISTRY_FETCH_RE = /\bfetch\s*\(/;
const D22_REGISTRY_FETCH_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/registry/registry-fetch.ts",
];

function scanRegistryRule(
  files: readonly FileEntry[],
  prefix: string,
  re: RegExp,
  allowed: readonly string[],
  rule: string,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith(prefix)) continue;
    if (allowed.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");
    const g = new RegExp(re.source, "g");
    for (const m of stripped.matchAll(g)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
  }
  return out;
}

export function checkRegistryAppenderConfinement(files: readonly FileEntry[]): Violation[] {
  return [
    ...scanRegistryRule(
      files,
      "packages/gateway/src/",
      D22_REGISTRY_APPENDER_RE,
      D22_REGISTRY_APPENDER_ALLOWED,
      "registry-appender-confined",
    ),
    ...scanRegistryRule(
      files,
      "packages/gateway/src/extensions/",
      D22_REGISTRY_FETCH_RE,
      D22_REGISTRY_FETCH_ALLOWED,
      "registry-fetch-confined",
    ),
  ];
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
function sqlTableReferenceRe(table: string): RegExp {
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
];

function checkTableConfinement(
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

// ---- D33 (extension runtime) ---------------------------------------------------------------------
// (b) `extension_run_grant` is named only by its store and its DDL — a grant is the record of an
//     owner's `extension.run` approval, so no other code may write one or read around it. Same
//     shape and same stated bound as D32(a): a dynamically composed identifier evades a text scan,
//     and capability confinement (only the store holds queries against the table) is the real
//     defense.
const D33_RUN_GRANT_TABLE_RE = sqlTableReferenceRe("extension_run_grant");
const D33_RUN_GRANT_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/run-grant-store.ts",
  "packages/gateway/src/index/extension-run-grant-v70-sql.ts",
  // V72 adds `credentials_json` to the same table; DDL only.
  "packages/gateway/src/index/extension-run-grant-credentials-v72-sql.ts",
];

export function checkRunGrantTableConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D33_RUN_GRANT_TABLE_RE,
    D33_RUN_GRANT_TABLE_ALLOWED,
    "run-grant-table-confined",
  );
}

// (a) The `__nimbus-extension` self-role sentinel is named only by `platform/runtime-layout.ts` (which
//     defines it); `selfSpawn("extension", …)` is called only from `extensions/extension-launch-command.ts`
//     (`extensionEntryCommand`, the UNWRAPPED launch command, in a dependency-free module). That
//     module spawns nothing itself: D38(b) confines its callers to the two builders that wrap it
//     through the sandbox — the run builder in `extension-runtime.ts`, which runs the entry from a
//     verified, re-digested per-spawn stage (`<sandboxDir>/ext-stage/<serviceId>/<uuid>`, also the
//     child's working directory), and the eval builder `eval/eval-spawn-spec.ts` (I49).
//     `index.ts` dispatches via `ROLE_SENTINELS.extension`, never the literal. Scans
//     comment-stripped source but NOT string-stripped (the sentinel IS a string literal, as with
//     D29(a)); test files and anything outside packages/gateway/src/ are not scanned. Stated bound: a
//     dynamically composed role string or `selfSpawn(role)` with a variable evades a text scan. That
//     gap is covered by tests rather than by this rule: I43's pin names the run's spec builders only
//     in `extension-runtime.ts` and builds the spec once, inside `prepareSpawn`, after the verifier
//     and the stage digest check; D38(a) names the eval builder only in its module and the eval runtime.
const D33_EXT_SENTINEL_RE = /__nimbus-extension/g;
const D33_EXT_SENTINEL_ALLOWED: readonly string[] = [
  "packages/gateway/src/platform/runtime-layout.ts",
];
const D33_EXT_SELFSPAWN_RE = /\bselfSpawn\s*\(\s*["'`]extension["'`]/g;
// The unwrapped launch command lives in a dependency-free module (so the eval role, which imports
// it through its spec builder, reaches no db/ module, I49); D38(b) confines ITS callers to the two
// builders that wrap it through the sandbox: `extension-runtime.ts` and `eval/eval-spawn-spec.ts`.
const D33_EXT_SELFSPAWN_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/extension-launch-command.ts",
];

export function checkExtensionRoleConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    const scans: Array<[RegExp, readonly string[]]> = [
      [D33_EXT_SENTINEL_RE, D33_EXT_SENTINEL_ALLOWED],
      [D33_EXT_SELFSPAWN_RE, D33_EXT_SELFSPAWN_ALLOWED],
    ];
    for (const [re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "extension-role-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// (c) D33(b) confines the TABLE; this confines who may CREATE or DELETE a grant through the store.
//     `upsertRunGrant` is named only by its definition and `extensions/approve-run.ts` (which calls
//     it after the owner's `extension.run` approval); `deleteRunGrant` additionally by
//     `automation/extension-store.ts` (uninstall drops the grant with the row, and `setExtensionKind`
//     drops it when an update turns the row into a starter pack). Any other mention — a
//     call or an import, aliased or not — is a violation, so a second door cannot be opened by
//     importing the function under another name. Comments and string literals are stripped first;
//     test files and anything outside packages/gateway/src/ are not scanned. Stated bound: a
//     dynamically composed call (`store["upsert" + "RunGrant"]`, a namespace import called through a
//     computed key) evades a text scan, and a second call INSIDE an allow-listed file is exempt
//     whole-file; capability confinement is the real defense, as with D32(d).
const D33_UPSERT_RE = /\bupsertRunGrant\b/g;
const D33_UPSERT_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/run-grant-store.ts",
  "packages/gateway/src/extensions/approve-run.ts",
];
const D33_DELETE_RE = /\bdeleteRunGrant\b/g;
const D33_DELETE_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/run-grant-store.ts",
  "packages/gateway/src/extensions/approve-run.ts",
  "packages/gateway/src/automation/extension-store.ts",
];

export function checkRunGrantWriters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const scans: Array<[RegExp, readonly string[]]> = [
      [D33_UPSERT_RE, D33_UPSERT_ALLOWED],
      [D33_DELETE_RE, D33_DELETE_ALLOWED],
    ];
    for (const [re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "run-grant-writers",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// ---- D37 (the trust store) -----------------------------------------------------------------------
// `trust_statement`, `trust_feed_state` and `trust_statement_source` (V77) are named only by the trust
// store and their DDL: what may enter the store (authority, admission, the per-registry cap), the
// sources a statement counts for, and the feed's anti-rollback floor are decided there, so no other
// code may write a statement or move the floor around them.
// Same shape and same stated bound as D33(b): a dynamically composed identifier evades a text scan,
// and capability confinement (only the store holds queries against the tables) is the real defense.
// Tied to no invariant in trust layer PR 2a; PR 2b's enforcement invariant binds it.
const D37_TRUST_TABLES_RE = new RegExp(
  `${sqlTableReferenceRe("trust_statement").source}|${sqlTableReferenceRe("trust_feed_state").source}|${sqlTableReferenceRe("trust_statement_source").source}`,
  "g",
);
const D37_TRUST_TABLES_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/trust/trust-store.ts",
  "packages/gateway/src/index/trust-layer-v76-sql.ts",
  "packages/gateway/src/index/trust-statement-source-v77-sql.ts",
];

export function checkTrustTableConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D37_TRUST_TABLES_RE,
    D37_TRUST_TABLES_ALLOWED,
    "trust-tables-confined",
  );
}

// ---- D38 (the eval runtime, I49) -----------------------------------------------------------------
// Extension code runs for evaluation only through `extensions/eval/eval-runtime.ts` under the spec
// `buildExtensionEvalSpawnSpec` builds: no network, baseline env only. Five clauses:
// (a) `buildExtensionEvalSpawnSpec` is named only by its module and the runtime that calls it;
// (b) `extensionEntryCommand` (the UNWRAPPED launch command of an extension entry) only by
//     `extensions/extension-launch-command.ts`, which defines it, `extensions/extension-runtime.ts`,
//     which wraps it for a run, and the eval spec module, which wraps it for an eval — a third holder could launch an entry outside both specs;
// (c) a file under `extensions/eval/` imports nothing — statically, as a type, or dynamically —
//     whose specifier has a `vault`, `egress`, `ipc` or `db` segment (a file under it, or the bare
//     directory) or names `engine/executor`;
// (d) `readCredentialEnv` is never named under `extensions/eval/`;
// (e) no file under `extensions/eval/` value-imports `@mastra/mcp` statically: the role imports it
//     only inside its run, after console output is routed to stderr (the one-document contract).
// Identifiers are matched as words after comments and string literals are stripped, so an aliased
// import is caught; the import clauses read comment-stripped source (a specifier IS a string).
// Test files and anything outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a
// dynamically composed name or specifier evades a text scan, and (c) reads direct imports only —
// the TRANSITIVE graph the role loads is pinned by I49's graph test in security-invariants.test.ts.
const D38_EVAL_DIR = "packages/gateway/src/extensions/eval/";
const D38_SPEC_BUILDER_RE = /\bbuildExtensionEvalSpawnSpec\b/g;
const D38_SPEC_BUILDER_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/eval/eval-spawn-spec.ts",
  "packages/gateway/src/extensions/eval/eval-runtime.ts",
];
const D38_ENTRY_COMMAND_RE = /\bextensionEntryCommand\b/g;
const D38_ENTRY_COMMAND_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/extension-launch-command.ts",
  "packages/gateway/src/extensions/extension-runtime.ts",
  "packages/gateway/src/extensions/eval/eval-spawn-spec.ts",
];
const D38_CREDENTIAL_RE = /\breadCredentialEnv\b/g;
/** Every module specifier: `from "x"`, bare `import "x"`, `import("x")`, `require("x")`. */
const D38_SPECIFIER_RE =
  /(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/gm;
// A segment, ending in `/` or at the end of the specifier: `../../db` (a directory import) is caught.
const D38_FORBIDDEN_SPECIFIER_RE = /(?:^|\/)(?:vault|egress|ipc|db)(?:\/|$)|engine\/executor/;
const D38_STATIC_MASTRA_RE =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\bfrom\s*)?["']@mastra\/mcp(?:\/[^"']*)?["']/gm;

export function checkEvalConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    const push = (rule: string, src: string, index: number | undefined): void => {
      const line = src.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    const scans: Array<[string, RegExp, readonly string[]]> = [
      ["eval-spec-builder-confined", D38_SPEC_BUILDER_RE, D38_SPEC_BUILDER_ALLOWED],
      ["eval-entry-command-confined", D38_ENTRY_COMMAND_RE, D38_ENTRY_COMMAND_ALLOWED],
    ];
    for (const [rule, re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push(rule, code, m.index);
    }
    if (!f.relPath.startsWith(D38_EVAL_DIR)) continue;
    for (const m of commentFree.matchAll(D38_SPECIFIER_RE)) {
      if (D38_FORBIDDEN_SPECIFIER_RE.test(m[1] ?? "")) {
        push("eval-imports-confined", commentFree, m.index);
      }
    }
    for (const m of code.matchAll(D38_CREDENTIAL_RE)) push("eval-no-credentials", code, m.index);
    for (const m of commentFree.matchAll(D38_STATIC_MASTRA_RE)) {
      push("eval-mcp-client-dynamic-only", commentFree, m.index);
    }
  }
  return out;
}

// ---- D39 (the model's connector-write door, I53) ------------------------------------------------
// A first-party connector write reaches the model only through `engine/connector-write-agent-tools.ts`,
// on an executor built without delegation, with every action carrying `origin: "model"`. Four clauses:
// (a) a non-test gateway file that VALUE-imports the write table (anything under
//     `connectors/connector-writes/`, or `connector-write-registry`) and also calls `createTool`
//     — including an aliased import (`createTool as ct`) or a namespace import's member — is the
//     door itself; no other file builds model tools from the write table. A type-only import is
//     ignored, so a file may name a row's TYPE. The importer of the door MODULE (`engine/agent.ts`)
//     is not a trigger: it imports the builder, never the rows;
// (b) `getAgentRequestConnectorWriteExecutor`, the read of the owner-turn executor, is named only by
//     `engine/agent-request-context.ts` (its definition), `engine/run-ask.ts`, `engine/agent.ts` and
//     the door;
//     The request-context FIELD `connectorWriteExecutor` (a read or a write of it) is named only by
//     `agent-request-context.ts` and `run-ask.ts`;
// (c) the door file names no transport: `invokeConnectorWrite`, `withConnectorSession`,
//     `createConnectorDispatcher`, `createConnectorWriteDispatcher` or a `dispatch(` call (a
//     destructured one included) — it runs an action through the turn's executor and nothing else;
// (e) `buildConnectorWriteAgentTools` is named only by `engine/agent.ts` and the door, and
//     `buildModelWriteExecutor` only by `engine/run-ask.ts`, and `buildWorkflowWriteExecutor` (SA2)
//     only by `engine/run-ask.ts` and `gateway-main.ts`;
// (d) the door file contains `origin: "model"`, the marker `tryDelegatedApproval` refuses to delegate.
// Comments and string literals are stripped before identifiers are matched (the import clauses read
// comment-stripped source, a specifier IS a string). Test files and anything outside
// packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a dynamically composed name or
// specifier evades a text scan; the executor's own construction (no delegation) and the door's
// per-call checks are pinned behaviourally by I53's tests.
const D39_DOOR = "packages/gateway/src/engine/connector-write-agent-tools.ts";
const D39_EXECUTOR_READ_RE = /\bgetAgentRequestConnectorWriteExecutor\b/g;
const D39_EXECUTOR_READ_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/agent-request-context.ts",
  "packages/gateway/src/engine/run-ask.ts",
  "packages/gateway/src/engine/agent.ts",
  D39_DOOR,
];
const D39_TRANSPORT_RE =
  /\b(?:invokeConnectorWrite|withConnectorSession|createConnectorDispatcher|createConnectorWriteDispatcher)\b|\bdispatch\s*\(/g;
const D39_CONTEXT_FIELD_RE = /\bconnectorWriteExecutor\b/g;
const D39_CONTEXT_FIELD_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/agent-request-context.ts",
  "packages/gateway/src/engine/run-ask.ts",
];
const D39_BUILDERS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [
    /\bbuildConnectorWriteAgentTools\b/g,
    [
      "packages/gateway/src/engine/agent.ts",
      "packages/gateway/src/engine/connector-write-agent-tools.ts",
    ],
  ],
  [/\bbuildModelWriteExecutor\b/g, ["packages/gateway/src/engine/run-ask.ts"]],
  // SA4: the scheduler's unattended executor is built by run-ask.ts and handed to the scheduler as a
  // factory by the boot file; the scheduler module never names it.
  [
    /\bbuildUnattendedWorkflowWriteExecutor\b/g,
    ["packages/gateway/src/engine/run-ask.ts", "packages/gateway/src/gateway-main.ts"],
  ],
  // SA2: the workflow write executor is built by run-ask.ts and handed to the runner by the boot file.
  [
    /\bbuildWorkflowWriteExecutor\b/g,
    ["packages/gateway/src/engine/run-ask.ts", "packages/gateway/src/gateway-main.ts"],
  ],
];
const D39_ORIGIN_RE = /\borigin\s*:\s*["']model["']/;
const D39_ROWS_SPECIFIER_RE = /connectors\/connector-writes\/|connector-write-registry/;
const D39_ROWS_DIR = "packages/gateway/src/connectors/connector-writes";

/**
 * Whether `spec`, imported from `importerRel`, names the write table or the registry. A relative
 * specifier is resolved against the importer's directory first, so `./connector-writes/index.ts`
 * from `connectors/` and `./index.ts` from inside `connector-writes/` both land in the table.
 */
function specifierNamesWriteTable(importerRel: string, spec: string): boolean {
  if (spec.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(importerRel), spec));
    return (
      resolved === D39_ROWS_DIR ||
      resolved.startsWith(`${D39_ROWS_DIR}/`) ||
      /(?:^|\/)connector-write-registry(?:\.ts)?$/.test(resolved)
    );
  }
  return D39_ROWS_SPECIFIER_RE.test(spec);
}
// `import <clause> from "x"` (static, comment-stripped); `export … from` re-exports count as values.
const D39_STATIC_IMPORT_RE =
  /^[ \t]*(?:import|export)\s+(type\s+)?([^;"']*?)\s*from\s*["']([^"']+)["']/gm;
const D39_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** True when an import clause names at least one value (not `type X` / `import type`). */
function clauseHasValue(typeOnly: boolean, clause: string): boolean {
  if (typeOnly) return false;
  const withoutTypes = clause.replace(/\btype\s+\w+(?:\s+as\s+\w+)?/g, "");
  return /[A-Za-z_$*]/.test(withoutTypes);
}

function importsWriteTableAsValue(importerRel: string, commentFree: string): boolean {
  for (const m of commentFree.matchAll(D39_STATIC_IMPORT_RE)) {
    if (!specifierNamesWriteTable(importerRel, m[3] ?? "")) continue;
    if (clauseHasValue(m[1] !== undefined, m[2] ?? "")) return true;
  }
  for (const m of commentFree.matchAll(D39_DYNAMIC_IMPORT_RE)) {
    if (specifierNamesWriteTable(importerRel, m[1] ?? "")) return true;
  }
  return false;
}

/** Every local name `createTool` is bound to, plus a namespace import's `t.createTool`. */
function createToolCallRe(commentFree: string): RegExp {
  const names = new Set<string>(["createTool"]);
  const namespaces = new Set<string>();
  for (const m of commentFree.matchAll(D39_STATIC_IMPORT_RE)) {
    if (!/@mastra\/core\/tools/.test(m[3] ?? "") || m[1] !== undefined) continue;
    const clause = m[2] ?? "";
    for (const a of clause.matchAll(/\bcreateTool\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      if (a[1] !== undefined) names.add(a[1]);
    }
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns?.[1] !== undefined) namespaces.add(ns[1]);
  }
  const alt = [...names, ...[...namespaces].map((n) => `${n}\\s*\\.\\s*createTool`)].join("|");
  return new RegExp(`(?<![.\\w$])(?:${alt})\\s*(?:<[^()]*>)?\\s*\\(|\\.\\s*createTool\\s*\\(`, "g");
}

// ---- D45 (the morning briefing delivers locally only, OR-10-11) ------------------------------------
// Rule ids `briefing-forbidden-import` and `briefing-no-network`. The briefing is read from the local index
// and delivered through two local sinks (the `briefing.ready` gateway event and the OS toast), both injected.
// Scope: every non-test file under `packages/gateway/src/briefing/` and every
// `packages/gateway/src/agents/_lib/briefing*.ts`. In scope:
//   - no import (static, side-effect `import "x"`, dynamic, `require`, or a re-export) of `chatops/`, `egress/`, `federation/` or
//     `share/`, even type-only; and none of `connectors/` unless it is a TYPE-only import;
//   - no network primitive: ANY reference to the global `fetch` (a call, an alias such as
//     `const f = fetch`, `fetch.bind`; only a `.fetch` property of another object is allowed), any use of
//     `globalThis`, `window` or `self`, `Bun.fetch`, `new WebSocket`, `XMLHttpRequest`, and no import of `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`,
//     `node:dgram` or `undici`.
// Stated bounds: a text scan of DIRECT imports. An indirect path through an allowed module (`llm/`,
// `index/`) is not followed; `synthesize.ts`, which the briefing imports, is no network path because no
// runner is ever passed (a source pin in security-invariants.test.ts). Tied to no invariant: it makes
// OR-10-11 structural rather than conventional.
const D45_DIR = "packages/gateway/src/briefing/";
const D45_LIB_RE = /^packages\/gateway\/src\/agents\/_lib\/briefing[\w.-]*\.ts$/;
const D45_FORBIDDEN_SEGMENT_RE = /(?:^|\/)(?:chatops|egress|federation|share)(?:\/|$)/;
const D45_CONNECTORS_SEGMENT_RE = /(?:^|\/)connectors(?:\/|$)/;
const D45_REQUIRE_RE = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const D45_NETWORK_MODULE_RE = /^(?:node:)?(?:http|https|http2|net|tls|dgram)$|^undici(?:\/|$)/;
const D45_NETWORK_CALL_RE = /\bBun\s*\.\s*fetch\b|\bnew\s+WebSocket\b|\bXMLHttpRequest\b/g;
// Any mention of the global `fetch` at all, not only a call: `const f = fetch`, `(fetch)`, `fetch.bind(...)`
// and a parameter default all alias it. A `.fetch` PROPERTY of some other object stays allowed (`db.fetch`).
const D45_FETCH_REF_RE = /(?<![.\w$])fetch(?![\w$])/g;
// The global objects a `fetch` can be reached through, by any spelling (`globalThis["fetch"]` has its name
// in a string, which is blanked): the briefing needs none of them.
const D45_GLOBAL_OBJECT_RE = /(?<![.\w$])(?:globalThis|window|self)(?![\w$])/g;
// `import "x";` (no `from`): runs the module for its effects, so it is an import like any other.
const D45_SIDE_EFFECT_IMPORT_RE = /(?:^|[;{}])[ \t]*import\s*["']([^"']+)["']/gm;

function inBriefingScope(relPath: string): boolean {
  if (relPath.endsWith(".test.ts")) return false;
  return relPath.startsWith(D45_DIR) || D45_LIB_RE.test(relPath);
}

export function checkBriefingConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!inBriefingScope(f.relPath)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    const push = (rule: string, src: string, index: number | undefined): void => {
      const line = src.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    const specifier = (spec: string, valueImport: boolean, index: number | undefined): void => {
      if (D45_FORBIDDEN_SEGMENT_RE.test(spec)) {
        push("briefing-forbidden-import", commentFree, index);
      } else if (D45_CONNECTORS_SEGMENT_RE.test(spec) && valueImport) {
        push("briefing-forbidden-import", commentFree, index);
      }
      if (D45_NETWORK_MODULE_RE.test(spec)) push("briefing-no-network", commentFree, index);
    };
    for (const m of commentFree.matchAll(D39_STATIC_IMPORT_RE)) {
      specifier(m[3] ?? "", clauseHasValue(m[1] !== undefined, m[2] ?? ""), m.index);
    }
    for (const m of commentFree.matchAll(D39_DYNAMIC_IMPORT_RE))
      specifier(m[1] ?? "", true, m.index);
    for (const m of commentFree.matchAll(D45_SIDE_EFFECT_IMPORT_RE)) {
      specifier(m[1] ?? "", true, m.index);
    }
    for (const m of commentFree.matchAll(D45_REQUIRE_RE)) specifier(m[1] ?? "", true, m.index);
    for (const re of [D45_NETWORK_CALL_RE, D45_FETCH_REF_RE, D45_GLOBAL_OBJECT_RE]) {
      for (const m of code.matchAll(re)) push("briefing-no-network", code, m.index);
    }
  }
  return out;
}

// ---- D47 (the v1 static-box LAN path, I56) -------------------------------------------------------
// Rule id `lan-box-path-confined`. The LAN's v1 wire seals every frame under the STATIC `nacl.box`
// secret of the two identity keys, which has no forward secrecy. Since LAN FS1 that path is reachable
// only through `ipc/lan-legacy.ts` (which refuses a peer already at protocol 2 and everything under
// `[lan] min_protocol = 2`); the primitives live in `ipc/lan-crypto.ts`. In every other non-test file of
// `packages/gateway/src/`, the identifiers `sealBoxFrame` and `openBoxFrame` (a call, an import,
// aliased or not) and a `nacl.box(` / `nacl.box.open(` call are violations, so a new federation module
// cannot seal a record under the static key and skip the Noise session. `nacl.box.keyPair` is not a
// seal and stays free (identity key creation). Comments and string literals are stripped first;
// `*.test.ts` and `*.test-helpers.ts` are not scanned.
// STATED BOUNDS (as D33(c)): a dynamically composed call evades a text scan, a second use INSIDE
// `lan-legacy.ts` or `lan-crypto.ts` is exempt whole-file, and a `box` imported by name from the
// library and called bare is not matched. After slice FS3 the legacy file is deleted and the
// allowance with it.
const D47_IDENT_RE = /\b(?:sealBoxFrame|openBoxFrame)\b/g;
const D47_NACL_BOX_RE = /\b(?:nacl|tweetnacl)\s*\.\s*box\s*(?:\.\s*open\s*)?\(/g;
const D47_ALLOWED: readonly string[] = [
  "packages/gateway/src/ipc/lan-crypto.ts",
  "packages/gateway/src/ipc/lan-legacy.ts",
];

export function checkLanBoxPathConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (/\.test(?:-helpers)?\.ts$/.test(f.relPath)) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D47_ALLOWED.includes(f.relPath)) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const re of [D47_IDENT_RE, D47_NACL_BOX_RE]) {
      for (const hit of code.matchAll(re)) {
        const line = code.slice(0, hit.index).split("\n").length;
        out.push({
          rule: "lan-box-path-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

export function checkModelWriteDoor(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    const push = (rule: string, src: string, index: number | undefined): void => {
      const line = src.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    const isDoor = f.relPath === D39_DOOR;
    if (!isDoor && importsWriteTableAsValue(f.relPath, commentFree)) {
      const m = createToolCallRe(commentFree).exec(code);
      if (m !== null) push("connector-write-tools-built-outside-door", code, m.index);
    }
    if (!D39_EXECUTOR_READ_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D39_EXECUTOR_READ_RE)) {
        push("connector-write-executor-read-confined", code, m.index);
      }
    }
    if (!D39_CONTEXT_FIELD_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D39_CONTEXT_FIELD_RE)) {
        push("connector-write-context-field-confined", code, m.index);
      }
    }
    for (const [re, allowed] of D39_BUILDERS) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push("connector-write-builders-confined", code, m.index);
    }
    if (isDoor) {
      for (const m of code.matchAll(D39_TRANSPORT_RE)) {
        push("connector-write-door-names-transport", code, m.index);
      }
      if (!D39_ORIGIN_RE.test(commentFree)) {
        out.push({
          rule: "connector-write-door-origin-model",
          file: f.relPath,
          line: 1,
          snippet: 'no origin: "model" in the door',
        });
      }
    }
  }
  return out;
}

// ---- D40 (the door's before-state read, I53 / spec § 5.4) ---------------------------------------
// A before-state read runs with no approval of its own, so three confinements keep it a read of
// the write's own connector, on the model door's executor only:
// (a) the `.before.read` action-type literal appears (in code or in a string, comments stripped)
//     only in `engine/before-state.ts`, which builds the type, and `connectors/registry.ts`, the
//     dispatcher guard. This confines the SPELLING, not the capability: a dynamically composed
//     type evades it, and what stops such an action is the gate refusal and the dispatcher guard;
// (b) `createBeforeStateRunner` is named only by `engine/before-state.ts` (its definition) and
//     `engine/run-ask.ts`, and inside run-ask.ts only on an import line or within the body of
//     `buildModelWriteExecutor` or `newWorkflowWriteExecutor` (SA2: the owner's own workflow
//     write step is the second carrier; it offers nothing to the model; SA4: the private function
//     both workflow builders call, so the attended and the unattended executor share it), and it is never imported
//     under an `as` alias (an alias would let
//     run-ask.ts call it outside that body unseen); a runner handed around as a value (an object
//     literal, a re-export under another name in another module) is outside a text scan;
// (c) `engine/executor.ts` (the structural refusal in `gate()`) and `connectors/registry.ts` (the
//     dispatch guard) each call `isBeforeReadActionType(`; a guard that disappears is a violation.
// Test files and anything outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c):
// a dynamically composed type (`".before" + ".read"`) evades a text scan; the guard and the gate
// refusal are pinned behaviourally (`connectors/registry.test.ts`, `engine/before-state.test.ts`).
const D40_LITERAL_RE = /\.before\.read\b/g;
const D40_LITERAL_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/before-state.ts",
  "packages/gateway/src/connectors/registry.ts",
];
const D40_RUNNER_RE = /\bcreateBeforeStateRunner\b/g;
const D40_RUNNER_ALIAS_RE = /\bcreateBeforeStateRunner\s+as\b/g;
const D40_RUNNER_DEF = "packages/gateway/src/engine/before-state.ts";
const D40_RUN_ASK = "packages/gateway/src/engine/run-ask.ts";
const D40_GUARD_RE = /\bisBeforeReadActionType\s*\(/;
const D40_GUARD_SITES: readonly string[] = [
  "packages/gateway/src/engine/executor.ts",
  "packages/gateway/src/connectors/registry.ts",
];

/** `[start, end)` of each permitted carrier's body (the door's and the workflow write step's). */
function d40CarrierSpans(code: string): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  for (const name of ["buildModelWriteExecutor", "newWorkflowWriteExecutor"]) {
    const at = code.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
    if (at === -1) continue;
    const end = code.indexOf("\n}\n", at);
    spans.push([at, end === -1 ? code.length : end]);
  }
  return spans;
}

/** Whether `index` sits inside an `import … from` statement (single- or multi-line). */
function d40InImportStatement(code: string, index: number): boolean {
  const statementStart = code.lastIndexOf(";", index - 1) + 1;
  return /^\s*import\b[^;]*$/.test(code.slice(statementStart, index));
}

export function checkBeforeStateRead(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const guardsSeen = new Set<string>();
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    const push = (rule: string, src: string, index: number | undefined): void => {
      const line = src.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    if (!D40_LITERAL_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D40_LITERAL_RE)) {
        push("before-read-literal-confined", commentFree, m.index);
      }
    }
    if (f.relPath !== D40_RUNNER_DEF) {
      const spans = f.relPath === D40_RUN_ASK ? d40CarrierSpans(code) : [];
      for (const m of code.matchAll(D40_RUNNER_RE)) {
        const i = m.index;
        const inDoorBuilder = spans.some(([start, end]) => i >= start && i < end);
        const allowed =
          f.relPath === D40_RUN_ASK && (inDoorBuilder || d40InImportStatement(code, i));
        if (!allowed) push("before-state-runner-confined", code, i);
      }
      for (const m of code.matchAll(D40_RUNNER_ALIAS_RE)) {
        push("before-state-runner-confined", code, m.index);
      }
    }
    if (D40_GUARD_SITES.includes(f.relPath) && D40_GUARD_RE.test(code)) guardsSeen.add(f.relPath);
  }
  for (const site of D40_GUARD_SITES) {
    if (!guardsSeen.has(site)) {
      out.push({
        rule: "before-read-guard-present",
        file: site,
        line: 1,
        snippet: "isBeforeReadActionType is not called here",
      });
    }
  }
  return out;
}

// ---- D41 (type-to-confirm, I53 / I20, Phase 9.7 D0a) ---------------------------------------------
// A Wave 4 connector write is approved only by the owner typing its confirm text, and ONE place
// decides whether what was typed is right: `engine/executor.ts`. Four clauses:
// (a) `requestConfirmedApproval` (the consent channel's typed-answer method) is named only by
//     `engine/executor.ts` (the gate, which is the only caller, and `bindConsentChannel`, which
//     defines the IPC channel), `engine/types.ts` (the interface), and `ipc/capture-rpc.ts`
//     inside `provenanceConsent` (the act door's wrapper, which forwards the call with its own
//     prompt and compares nothing). `requestConfirmedConsent` (the coordinator's half) is named
//     only by `engine/executor.ts` and `ipc/consent.ts`;
// (b) `renderConfirmText` is named only by `engine/executor.ts` (its one caller) and
//     `connectors/connector-writes/confirm.ts` (its definition);
// (c) the strict comparison of a typed answer with a confirm text — a `===` or `!==` with
//     `confirmText` or a `.typed` property on either side — occurs only in `engine/executor.ts`,
//     so `ConsentCoordinatorImpl`, the act-door wrapper and every other channel carry the text
//     and never judge it;
// (d) the order is pinned in `engine/executor.ts`: `resolveHitlApproval` calls
//     `captureBeforePhase`, then `renderConfirmPhase`, then `approvalPhase`; the plain
//     `this.consent.requestApproval(` call sits in `approvalPhase` after its `confirm.kind ===
//     "none"` guard and nowhere else, `requestConfirmedApproval(` is called only in
//     `confirmedOwnerPrompt`, and `renderConfirmPhase` reads the row's wave. A phase that is
//     reordered, or a Wave 4 write that reaches the plain prompt, is a violation.
// Comments and string literals are stripped before identifiers are matched; test files and anything
// outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a dynamically composed
// name evades a text scan, a second use inside an allow-listed file is exempt whole-file (the
// order pin and the wrapper's span narrow that for the two files that matter), and an ALIAS of the
// channel method is not followed. The behaviour is pinned by `engine/executor-confirm.test.ts`.
const D41_EXECUTOR = "packages/gateway/src/engine/executor.ts";
const D41_CHANNEL_RE = /\brequestConfirmedApproval\b/g;
const D41_CHANNEL_ALLOWED: readonly string[] = [
  D41_EXECUTOR,
  "packages/gateway/src/engine/types.ts",
  "packages/gateway/src/ipc/capture-rpc.ts",
];
const D41_WRAPPER_FILE = "packages/gateway/src/ipc/capture-rpc.ts";
const D41_COORDINATOR_RE = /\brequestConfirmedConsent\b/g;
const D41_COORDINATOR_ALLOWED: readonly string[] = [
  D41_EXECUTOR,
  "packages/gateway/src/ipc/consent.ts",
];
const D41_RENDER_RE = /\brenderConfirmText\b/g;
const D41_RENDER_ALLOWED: readonly string[] = [
  D41_EXECUTOR,
  "packages/gateway/src/connectors/connector-writes/confirm.ts",
];
// A comparison with `undefined` or `null` ("is there a confirm text") is a presence check, not a
// judgement of what was typed.
const D41_COMPARE_RE =
  /(?:\bconfirmText|\.typed)\b\s*[!=]==(?!\s*(?:undefined|null)\b)|(?<!\b(?:undefined|null)\s*)[!=]==\s*[\w.]*(?:\bconfirmText\b|\.typed\b)/g;

/** `[start, end)` of the method or function whose signature matches `sig` in `code`, or undefined. */
function d41Span(code: string, sig: RegExp, close: string): readonly [number, number] | undefined {
  const at = code.search(sig);
  if (at === -1) return undefined;
  const end = code.indexOf(close, at);
  return [at, end === -1 ? code.length : end];
}

export function checkConfirmComparison(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const push = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    if (!D41_CHANNEL_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D41_CHANNEL_RE))
        push(f, "confirm-channel-confined", code, m.index);
    } else if (f.relPath === D41_WRAPPER_FILE) {
      const span = d41Span(code, /\bfunction\s+provenanceConsent\s*\(/, "\n}\n");
      for (const m of code.matchAll(D41_CHANNEL_RE)) {
        const i = m.index;
        if (span === undefined || i < span[0] || i >= span[1]) {
          push(f, "confirm-channel-confined", code, i);
        }
      }
    }
    // A `*.test-helpers.ts` is test support (an inert coordinator stub), imported by tests only.
    if (!D41_COORDINATOR_ALLOWED.includes(f.relPath) && !f.relPath.endsWith(".test-helpers.ts")) {
      for (const m of code.matchAll(D41_COORDINATOR_RE)) {
        push(f, "confirm-coordinator-confined", code, m.index);
      }
    }
    if (!D41_RENDER_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D41_RENDER_RE))
        push(f, "confirm-render-confined", code, m.index);
    }
    if (f.relPath !== D41_EXECUTOR) {
      for (const m of code.matchAll(D41_COMPARE_RE)) {
        push(f, "confirm-comparison-confined", code, m.index);
      }
    }
    if (f.relPath === D41_EXECUTOR) {
      for (const v of d41OrderPin(f, code)) out.push(v);
    }
  }
  return out;
}

/** The index of the `}` that closes the block whose body starts at `from`, or -1. */
function d41BlockEnd(code: string, from: number): number {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Clause (d): the phase order and the two prompt call sites in `engine/executor.ts`. */
function d41OrderPin(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "confirm-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const resolve = d41Span(code, /\bprivate\s+async\s+resolveHitlApproval\s*\(/, "\n  }\n");
  const body = resolve === undefined ? "" : code.slice(resolve[0], resolve[1]);
  const before = body.indexOf("this.captureBeforePhase(");
  const render = body.indexOf("this.renderConfirmPhase(");
  const approve = body.indexOf("this.approvalPhase(");
  if (before === -1 || render === -1 || approve === -1 || !(before < render && render < approve)) {
    fail(
      "resolveHitlApproval must call captureBeforePhase, renderConfirmPhase, approvalPhase in that order",
    );
  }
  const phase = d41Span(code, /\bprivate\s+async\s+approvalPhase\s*\(/, "\n  }\n");
  const owner = d41Span(code, /\bprivate\s+async\s+confirmedOwnerPrompt\s*\(/, "\n  }\n");
  // Any receiver (an alias of the channel, `this.consent`, an optional call): exactly one call.
  const plainCalls = [...code.matchAll(/\.\s*requestApproval\s*(?:\?\.)?\s*\(/g)];
  const plainAt = plainCalls[0]?.index;
  // The guard must be `if (confirm.kind === "none") {` and the plain call must sit INSIDE its block:
  // reading the literal needs the string contents, which `code` has blanked; `stripStringLiterals`
  // keeps every offset, so the match index carries over to `code`, whose braces are reliable.
  const guard =
    phase === undefined
      ? null
      : /\bif\s*\(\s*confirm\.kind\s*===\s*"none"\s*\)\s*\{/.exec(
          stripComments(f.contents).slice(phase[0], phase[1]),
        );
  const blockStart =
    guard === null || phase === undefined ? -1 : phase[0] + guard.index + guard[0].length;
  const blockEnd = blockStart === -1 ? -1 : d41BlockEnd(code, blockStart);
  const plainOk =
    plainCalls.length === 1 &&
    plainAt !== undefined &&
    phase !== undefined &&
    plainAt > phase[0] &&
    plainAt < phase[1] &&
    blockStart !== -1 &&
    blockEnd !== -1 &&
    plainAt >= blockStart &&
    plainAt < blockEnd;
  if (!plainOk)
    fail(
      'the plain requestApproval call must sit once in approvalPhase, inside the if (confirm.kind === "none") block',
    );
  const typedCalls = [...code.matchAll(/\.\s*requestConfirmedApproval\s*(?:\?\.)?\s*\(/g)];
  const typedAt = typedCalls[0]?.index;
  if (
    typedCalls.length !== 1 ||
    typedAt === undefined ||
    owner === undefined ||
    typedAt < owner[0] ||
    typedAt >= owner[1]
  ) {
    fail("requestConfirmedApproval must be called once, in confirmedOwnerPrompt");
  }
  const renderPhase = d41Span(code, /\bprivate\s+renderConfirmPhase\s*\(/, "\n  }\n");
  if (
    renderPhase === undefined ||
    !/\bwave\s*===\s*4\b/.test(code.slice(renderPhase[0], renderPhase[1]))
  ) {
    fail("renderConfirmPhase must decide Wave 4 from the row's wave");
  }
  return out;
}

// ---- D42 (bound writes, I54, Phase 9.7 D0b) ------------------------------------------------------
// A BOUND connector write (a row that declares `bound`) is dispatched only with the values its own
// gate-run prepare step produced, injected by the gateway. Seven clauses keep that the only way in:
// (a) confinement of the spelling and the capability: the `.write.prepare` action-type literal only
//     in `engine/prepare-step.ts`; `injectBoundFields` and `runPrepareStep` only in that module and
//     `engine/executor.ts`; `isPrepareActionType` additionally in `connectors/registry.ts` (the
//     dispatcher guard); `isPrepareToolId` only in `connectors/connector-writes/prepare-tools.ts`,
//     the registry and `connectors/connector-write-registry.ts` (the one composed federation
//     predicate `isConnectorWriteOrPrepareToolId`, D1c; that file and that name only); `PREPARE_TOOL_IDS` only in prepare-tools.ts, `connectors/connector-writes/
//     types.ts` (the `withBound` default), the executor and the registry;
// (b) the order is pinned in `engine/executor.ts`: `resolveHitlApproval` calls `captureBeforePhase`,
//     then `preflightPhase` (D2: the refusals that must cost no child, before the prepare child
//     exists), then `preparePhase`, then `renderConfirmPhase`, then `approvalPhase` (a delegate can
//     never skip the prepare); `runPrepareStep(` is called once, in `preparePhase`; `injectBoundFields(`
//     once, in `dispatchBoundPhase`; and `execute` calls `gateWithin`, then `dispatchBoundPhase`,
//     then `connectors.dispatch`;
// (c) no production code replaces the write table: `writeTable`, `WriteTable` and `prepareToolIds`
//     are named only by the executor, the registry, `engine/prepare-step.ts`, prepare-tools.ts and
//     types.ts (test files, and a test-support `*.test-helpers.ts` that NO production file imports, are
//     exempt), no `new ToolExecutor(`
//     passes a ninth argument, no `createConnectorDispatcher(` options name `prepareToolIds` and no
//     `withBound(` passes a third argument;
// (d) `PREPARE_TOOL_IDS` is frozen (source pins on prepare-tools.ts: `Object.freeze(` and the three
//     throwing mutators) and nothing outside tests calls `.add(`, `.delete(` or `.clear(` on it;
// (e) the public `gate()` can never bind: it passes `{ bind: false }`, `execute()` passes
//     `{ bind: true }` (each once, in its own method), and `boundRefusal` tests `!scope.bind`
//     before it calls `boundInputRefusal(`;
// (f) a prepare action type is the step's own read: `prepareStep: true` is written once, in
//     `preparePhase`, and `runGateChecks` (the ordered checks `gateWithin` runs first) tests `isPrepareActionType(` together with
//     `scope.prepareStep` before it reaches `resolveHitlApproval(`, so a caller's `<svc>.write.prepare`
//     is refused whichever door sent it.
// (g) the unified diff an approver is shown is rendered only by the prepare step (D1c): the
//     `renderUnifiedDiff` name is confined to `engine/prepare-step.ts` and `connectors/connector-writes/
//     diff.ts` itself, so no other module can put a diff of its own making in front of an approver.
//     The executor only carries `prepared.diff` into the preview (a source pin on `withPrepared`).
// Comments and string literals are stripped before identifiers are matched; test files and anything
// outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c)/D41: a dynamically composed
// name evades a text scan, a second use inside an allow-listed file is exempt whole-file (the order
// pins narrow that for the executor), and an alias is not followed. The order pins are TEXTUAL: the
// behavioural tests are authoritative. The behaviour is pinned by
// `engine/executor-bound.test.ts`, `engine/prepare-step.test.ts` and `connectors/registry.test.ts`.
const D42_EXECUTOR = "packages/gateway/src/engine/executor.ts";
const D42_STEP = "packages/gateway/src/engine/prepare-step.ts";
const D42_REGISTRY = "packages/gateway/src/connectors/registry.ts";
const D42_TOOLS = "packages/gateway/src/connectors/connector-writes/prepare-tools.ts";
const D42_TYPES = "packages/gateway/src/connectors/connector-writes/types.ts";
const D42_WRITE_REGISTRY = "packages/gateway/src/connectors/connector-write-registry.ts";
const D42_DIFF = "packages/gateway/src/connectors/connector-writes/diff.ts";
const D42_LITERAL_RE = /\.write\.prepare\b/g;
const D42_NAMES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\binjectBoundFields\b/g, [D42_STEP, D42_EXECUTOR]],
  [/\brunPrepareStep\b/g, [D42_STEP, D42_EXECUTOR]],
  [/\bisPrepareActionType\b/g, [D42_STEP, D42_EXECUTOR, D42_REGISTRY]],
  [/\bisPrepareToolId\b/g, [D42_TOOLS, D42_REGISTRY, D42_WRITE_REGISTRY]],
  [/\brenderUnifiedDiff\b/g, [D42_STEP, D42_DIFF]],
  [/\bPREPARE_TOOL_IDS\b/g, [D42_TOOLS, D42_TYPES, D42_EXECUTOR, D42_REGISTRY]],
  [/\b(?:writeTable|WriteTable)\b/g, [D42_EXECUTOR]],
  [/\bprepareToolIds\b/g, [D42_STEP, D42_TOOLS, D42_TYPES, D42_EXECUTOR, D42_REGISTRY]],
];
const D42_MUTATOR_RE = /\bPREPARE_TOOL_IDS\s*\.\s*(?:add|delete|clear)\s*\(/g;

/** The top-level arguments of the call whose `(` is at `open` in `code` (strings already blanked). */
function d42CallArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        const last = code.slice(start, i).trim();
        if (last !== "") args.push(last);
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

/** The base names of the `*.test-helpers` modules a production file (not a test) imports. */
function d42ImportedHelpers(files: readonly FileEntry[]): ReadonlySet<string> {
  const names = new Set<string>();
  const re = /["'][^"']*?([\w.-]+\.test-helpers)(?:\.ts)?["']/g;
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    for (const m of stripComments(f.contents).matchAll(re)) names.add(m[1] ?? "");
  }
  return names;
}

export function checkBoundWrites(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const importedHelpers = d42ImportedHelpers(files);
  const push = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  const whole = (f: FileEntry, rule: string, what: string): void => {
    out.push({ rule, file: f.relPath, line: 1, snippet: what });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // A test-support helper is exempt only while no production file imports it.
    if (f.relPath.endsWith(".test-helpers.ts")) {
      const base = f.relPath.slice(f.relPath.lastIndexOf("/") + 1).replace(/\.ts$/, "");
      if (!importedHelpers.has(base)) continue;
    }
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (f.relPath !== D42_STEP) {
      for (const m of commentFree.matchAll(D42_LITERAL_RE)) {
        push(f, "bound-prepare-literal-confined", commentFree, m.index);
      }
    }
    for (const [re, allowed] of D42_NAMES) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push(f, "bound-name-confined", code, m.index);
    }
    for (const m of code.matchAll(/(?<!function\s+)\bnew\s+ToolExecutor\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (d42CallArgs(code, open).length > 8) push(f, "bound-seam-not-production", code, m.index);
    }
    for (const m of code.matchAll(/(?<!function\s+)\bcreateConnectorDispatcher\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (/\bprepareToolIds\b/.test(d42CallArgs(code, open)[1] ?? "")) {
        push(f, "bound-seam-not-production", code, m.index);
      }
    }
    for (const m of code.matchAll(/(?<!function\s+)\bwithBound\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (d42CallArgs(code, open).length > 2) push(f, "bound-seam-not-production", code, m.index);
    }
    if (f.relPath !== D42_TOOLS) {
      for (const m of code.matchAll(D42_MUTATOR_RE)) {
        push(f, "bound-prepare-set-frozen", code, m.index);
      }
    }
    if (f.relPath === D42_TOOLS) {
      const frozen =
        /\bObject\.freeze\s*\(/.test(code) &&
        /\badd\s*\([^)]*\)\s*:\s*never/.test(code) &&
        /\bdelete\s*\([^)]*\)\s*:\s*never/.test(code) &&
        /\bclear\s*\(\s*\)\s*:\s*never/.test(code);
      if (!frozen) whole(f, "bound-prepare-set-frozen", "PREPARE_TOOL_IDS is no longer frozen");
    }
    if (f.relPath === D42_EXECUTOR) {
      for (const v of d42ExecutorPins(f, code)) out.push(v);
    }
  }
  return out;
}

/** Clause (f): the prepare step's private gate scope, and the gate's refusal of a caller's prepare type. */
function d42PrepareScopePins(
  code: string,
  span: (sig: RegExp) => string,
  fail: (what: string) => void,
): void {
  const scoped = /\bprepareStep\s*:\s*true\b/g;
  const total = [...code.matchAll(scoped)].length;
  const within = [...span(/\bprivate\s+async\s+preparePhase\s*\(/).matchAll(scoped)].length;
  if (total !== 1 || within !== 1) fail("prepareStep: true must be written once, in preparePhase");
  const gate = span(/\bprivate\s+async\s+runGateChecks\s*\(/);
  const refusal = gate.search(/\bisPrepareActionType\s*\([^)]*\)\s*&&\s*scope\.prepareStep\b/);
  const hitl = gate.search(/\bthis\.resolveHitlApproval\s*\(/);
  if (refusal === -1 || hitl === -1 || refusal > hitl) {
    fail(
      "runGateChecks must refuse a prepare type unless scope.prepareStep, before resolveHitlApproval",
    );
  }
}

/** Clauses (b), (e) and (f): the phase order, the single injection site and the public gate's refusal. */
function d42ExecutorPins(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "bound-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const span = (sig: RegExp): string => {
    const s = d41Span(code, sig, "\n  }\n");
    return s === undefined ? "" : code.slice(s[0], s[1]);
  };
  const resolve = span(/\bprivate\s+async\s+resolveHitlApproval\s*\(/);
  const at = (needle: string): number => resolve.indexOf(needle);
  const phases = [
    at("this.captureBeforePhase("),
    at("this.preflightPhase("),
    at("this.preparePhase("),
    at("this.renderConfirmPhase("),
    at("this.approvalPhase("),
  ];
  if (phases.some((p, i) => p === -1 || (i > 0 && p < (phases[i - 1] ?? 0)))) {
    fail(
      "resolveHitlApproval must call captureBeforePhase, preflightPhase, preparePhase, renderConfirmPhase, approvalPhase in that order",
    );
  }
  const once = (needle: RegExp, inside: string, what: string): void => {
    const total = [...code.matchAll(needle)].length;
    const within = [...inside.matchAll(needle)].length;
    if (total !== 1 || within !== 1) fail(what);
  };
  once(
    /\brunPrepareStep\s*\(/g,
    span(/\bprivate\s+async\s+preparePhase\s*\(/),
    "runPrepareStep must be called once, in preparePhase",
  );
  once(
    /\binjectBoundFields\s*\(/g,
    span(/\bprivate\s+dispatchBoundPhase\s*\(/),
    "injectBoundFields must be called once, in dispatchBoundPhase",
  );
  const exec = span(/\basync\s+execute\s*\(/);
  const g = exec.indexOf("this.gateWithin(");
  const b = exec.indexOf("this.dispatchBoundPhase(");
  const d = exec.indexOf("this.connectors.dispatch(");
  if (g === -1 || b === -1 || d === -1 || !(g < b && b < d)) {
    fail("execute must call gateWithin, then dispatchBoundPhase, then connectors.dispatch");
  }
  const noBind = (code.match(/\{\s*bind\s*:\s*false\s*\}/g) ?? []).length;
  const yesBind = (code.match(/\{\s*bind\s*:\s*true\s*\}/g) ?? []).length;
  const gate = span(/\basync\s+gate\s*\(/);
  if (
    noBind !== 1 ||
    yesBind !== 1 ||
    !/\{\s*bind\s*:\s*false\s*\}/.test(gate) ||
    !/\{\s*bind\s*:\s*true\s*\}/.test(exec)
  ) {
    out.push({
      rule: "bound-public-gate-refuses",
      file: f.relPath,
      line: 1,
      snippet: "gate() must pass { bind: false } and execute() { bind: true }, once each",
    });
  }
  d42PrepareScopePins(code, span, fail);
  // Clause (g): the diff the approver is shown is the prepare step's own, carried unchanged.
  const carry = d41Span(code, /\bfunction\s+withPrepared\s*\(/, "\n}\n");
  const carried = carry === undefined ? "" : code.slice(carry[0], carry[1]);
  if (!/\bdiff\s*:\s*prepared\.diff\b/.test(carried)) {
    fail("withPrepared must carry only prepared.diff into the preview");
  }
  const refusal = span(/\bprivate\s+boundRefusal\s*\(/);
  const guard = refusal.search(/!\s*scope\.bind\b/);
  const input = refusal.search(/\bboundInputRefusal\s*\(/);
  if (guard === -1 || input === -1 || guard > input) {
    out.push({
      rule: "bound-public-gate-refuses",
      file: f.relPath,
      line: 1,
      snippet: "boundRefusal must test !scope.bind before it calls boundInputRefusal",
    });
  }
  return out;
}

// ---- D42(h) (the bound IaC capabilities, I54, Phase 9.7 D2) --------------------------------------
// The runtime capabilities of a bound IaC row (its settle step and its preflight) reach the gate only
// through the dispatcher's `boundWriteCapabilities` member (the production `ToolExecutor` keeps its
// constructor, D42(c)). Two pins keep that the only way in:
// (h1) the member `boundWriteCapabilities` is named only by `engine/executor.ts` (the reader),
//      `engine/types.ts` (the interface member) and `connectors/registry.ts` (the one place the
//      production dispatcher sets it), and a `BoundWriteCapabilities` VALUE is built (a typed
//      initialiser, a return type, `implements`, `as`/`satisfies`) only in `connectors/registry.ts`;
// (h2) in the executor the member is read exactly twice, once in `preflightPhase` and once in
//      `preparePhase`, `.preflight(` is called only in the first and `.settle(` only in the second,
//      so no other phase or method can reach a capability.
// Comments and string literals are stripped; test files are not scanned. STATED BOUND, as D42: a
// dynamically composed name or an alias evades a text scan; the behavioural tests are authoritative.
const D42H_PROP_RE = /\bboundWriteCapabilities\b/g;
const D42H_TYPES = "packages/gateway/src/engine/types.ts";
const D42H_PROP_ALLOWED: readonly string[] = [D42_EXECUTOR, D42H_TYPES, D42_REGISTRY];
// (h3) the Kubernetes settler (D3a) is named only by its own module and the registry, which reaches
// it through the capability's `settle`: no other production file can settle a plan on its own.
const D42H_K8S_SETTLER_RE = /\bsettleK8sManifest\b/g;
const D42H_K8S_SETTLER_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/k8s-settle.ts",
  D42_REGISTRY,
];
const D42H_BUILD_RE =
  /:\s*BoundWriteCapabilities(?:\s*\|\s*undefined)?\s*(?:=|\{)|\bimplements\s+BoundWriteCapabilities\b|\b(?:as|satisfies)\s+BoundWriteCapabilities\b/g;

export function checkBoundCapabilities(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    if (!D42H_PROP_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D42H_PROP_RE))
        add(f, "bound-capability-confined", code, m.index);
    }
    if (f.relPath !== D42_REGISTRY) {
      for (const m of code.matchAll(D42H_BUILD_RE))
        add(f, "bound-capability-confined", code, m.index);
    }
    if (!D42H_K8S_SETTLER_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D42H_K8S_SETTLER_RE))
        add(f, "bound-capability-confined", code, m.index);
    }
    if (f.relPath !== D42_EXECUTOR) continue;
    const span = (sig: RegExp): string => {
      const s = d41Span(code, sig, "\n  }\n");
      return s === undefined ? "" : code.slice(s[0], s[1]);
    };
    const preflight = span(/\bprivate\s+async\s+preflightPhase\s*\(/);
    const prepare = span(/\bprivate\s+async\s+preparePhase\s*\(/);
    const reads = (src: string): number => [...src.matchAll(D42H_PROP_RE)].length;
    const calls = (src: string, name: string): number =>
      [...src.matchAll(new RegExp(`\\.${name}\\s*\\(`, "g"))].length;
    const fail = (what: string): void => {
      out.push({ rule: "bound-capability-calls", file: f.relPath, line: 1, snippet: what });
    };
    if (reads(code) !== 2 || reads(preflight) !== 1 || reads(prepare) !== 1) {
      fail("boundWriteCapabilities must be read once in preflightPhase and once in preparePhase");
    }
    if (calls(code, "preflight") !== 1 || calls(preflight, "preflight") !== 1) {
      fail("a capability's preflight must be called once, in preflightPhase");
    }
    if (calls(code, "settle") !== 1 || calls(prepare, "settle") !== 1) {
      fail("a capability's settle must be called once, in preparePhase");
    }
  }
  return out;
}

// ---- D43 (the gateway-internal discard of an unused change set, I2's one stated exception) -------
// A CloudFormation deploy's prepare step CREATES a change set. When the owner then declines, mistypes
// or times out, the gateway removes what it made. `iac_cloudformation_changeset_discard` is a connector
// WRITE and its action type is in I2's frozen set, so the public gate still prompts for it; the only
// way it runs without a prompt is the executor's own `discardUnusedChangeSet`, in a private gate scope
// that names the one change set the same run's settle bound. Three clauses keep that exemption narrow:
// (a) `discardStep` (the scope member) is named only by `engine/executor.ts`;
// (b) in the executor: `discardStep:` is written once, in `discardUnusedChangeSet`; that method is
//     called once, in `finishScope`, under `if (!dispatched)`; `execute` sets `dispatched = true`
//     BEFORE `this.connectors.dispatch(` (so a dispatch error is never followed by a discard) and
//     calls `finishScope(` in its `finally`; and `runGateChecks` reaches the no-prompt branch only
//     under `scope.discardStep !== undefined`, after `isDiscardOf(` and before
//     `this.resolveHitlApproval(`;
// (c) the tool id, the action type and the `IAC_DISCARD` constant are named only by the row table
//     (`cloud-infra.ts`, `iac-limits.ts`), the executor (frozen set, the discard step), the registry
//     (the dispatcher pin), `proposable-actions.ts`, `manifest.generated.ts`, the model-offerable
//     never-offered table and the iac runner's routing table.
// Clause (d) (only `lazy-mesh/iac-runner.ts` builds an iac or kubernetes `ServerSpec`, and only
// through `wrapIacServerSpec`; D3a added the kubernetes `kube` profile to it) is below. Comments are stripped (strings kept for (c));
// test files are not scanned. The behaviour is pinned by `engine/executor-iac-discard.test.ts`.
const D43_BASE = "packages/gateway/src/connectors/";
const D43_NAME_RE = /iac_cloudformation_changeset_discard|iac\.cloudformation\.changeset\.discard/g;
const D43_NAME_ALLOWED: readonly string[] = [
  `${D43_BASE}connector-writes/cloud-infra.ts`,
  `${D43_BASE}connector-writes/iac-limits.ts`,
  `${D43_BASE}connector-writes/manifest.generated.ts`,
  `${D43_BASE}connector-writes/model-offerable.ts`,
  `${D43_BASE}proposable-actions.ts`,
  `${D43_BASE}lazy-mesh/iac-runner.ts`,
  D42_EXECUTOR,
];
const D43_CONSTANT_RE = /\bIAC_DISCARD\b/g;
// Clause (d) (the iac and kubernetes connectors' per-run spawns): only `lazy-mesh/iac-runner.ts`
// builds an iac or kubernetes `ServerSpec`, and only through `wrapIacServerSpec` (defined in
// `wrap-server-spec.ts`; the kubernetes listing slot in `connector-spawns.ts` keeps `wrapServerSpec`,
// no network, and so a second file wrapping `connectorSpawn("kubernetes")` with the flag is a
// `wrapIacServerSpec` violation); the routing table of the nine kubernetes tools
// (`KUBE_TOOL_PROFILE`) is named only by the runner; the policy
// flag `iacProfile` and the seccomp program that answers `pidfd_send_signal` with ENOSYS (OR-D2-5)
// are named only by the policy wire, the wrapper, the Linux runner and the wrap function.
const D43_SPAWN_BASE = "packages/gateway/src/";
const D43_RUNNER = `${D43_BASE}lazy-mesh/iac-runner.ts`;
const D43_WRAP = `${D43_BASE}lazy-mesh/wrap-server-spec.ts`;
const D43_SPAWN_RULES: ReadonlyArray<{
  readonly re: RegExp;
  readonly allowed: readonly string[];
  /** Match against comment-stripped source with strings kept (a string spelling is a spelling). */
  readonly keepStrings: boolean;
}> = [
  { re: /\bwrapIacServerSpec\b/g, allowed: [D43_WRAP, D43_RUNNER], keepStrings: false },
  {
    re: /\biacProfile\b/g,
    allowed: [
      D43_WRAP,
      `${D43_SPAWN_BASE}platform/sandbox/sandbox-policy.ts`,
      `${D43_SPAWN_BASE}platform/sandbox/sandbox-wrapper.ts`,
      `${D43_SPAWN_BASE}platform/sandbox/linux.ts`,
    ],
    keepStrings: true,
  },
  {
    re: /\b(?:buildIacSeccompFilter|IAC_ENOSYS_SYSCALLS)\b/g,
    allowed: [
      `${D43_SPAWN_BASE}platform/sandbox/seccomp-filter.ts`,
      `${D43_SPAWN_BASE}platform/sandbox/linux.ts`,
    ],
    keepStrings: false,
  },
  { re: /com\.nimbus\.iac-/g, allowed: [D43_RUNNER], keepStrings: true },
  { re: /\bKUBE_TOOL_PROFILE\b/g, allowed: [D43_RUNNER], keepStrings: false },
];
const D43_CONSTANT_ALLOWED: readonly string[] = [
  `${D43_BASE}connector-writes/iac-limits.ts`,
  D42_EXECUTOR,
  D42_REGISTRY,
];

export function checkIacDiscard(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (f.relPath !== D42_EXECUTOR) {
      for (const m of code.matchAll(/\bdiscardStep\b/g)) {
        add(f, "discard-step-confined", code, m.index);
      }
    }
    if (!D43_NAME_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D43_NAME_RE)) {
        add(f, "discard-name-confined", commentFree, m.index);
      }
    }
    if (!D43_CONSTANT_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D43_CONSTANT_RE)) {
        add(f, "discard-name-confined", commentFree, m.index);
      }
    }
    for (const rule of D43_SPAWN_RULES) {
      if (rule.allowed.includes(f.relPath)) continue;
      const src = rule.keepStrings ? commentFree : code;
      for (const m of src.matchAll(rule.re)) add(f, "iac-spawn-confined", src, m.index);
    }
    if (f.relPath === D42_EXECUTOR) {
      for (const v of d43ExecutorPins(f, code, commentFree)) out.push(v);
    }
  }
  return out;
}

/** Clause (b): the discard happens only at the end of a run that never dispatched, in a private scope. */
function d43ExecutorPins(f: FileEntry, code: string, commentFree: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "discard-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const span = (sig: RegExp): string => {
    const s = d41Span(code, sig, "\n  }\n");
    return s === undefined ? "" : code.slice(s[0], s[1]);
  };
  const count = (src: string, re: RegExp): number => [...src.matchAll(re)].length;
  const discarding = span(/\bprivate\s+async\s+discardUnusedChangeSet\s*\(/);
  const scopeKey = /\bdiscardStep\s*:/g;
  if (count(code, scopeKey) !== 1 || count(discarding, scopeKey) !== 1) {
    fail("discardStep: must be written once, in discardUnusedChangeSet");
  }
  // The scope member may be WRITTEN in no other form: shorthand, a member assignment, `Object.assign`
  // or a computed/quoted key would each set it without the `discardStep:` this rule counts.
  for (const re of [
    /[{,]\s*discardStep\s*[,}]/,
    /\.discardStep\s*=(?!=)/,
    /\bObject\s*\.\s*(?:assign|defineProperty|fromEntries)\b[^;]*discardStep/,
    /\[\s*["'`]discardStep["'`]\s*\]/,
    /["'`]discardStep["'`]\s*:/,
  ]) {
    if (re.test(commentFree))
      fail(`discardStep set by a form the rule does not count: ${re.source}`);
  }
  // `dispatched` only ever becomes true, once: a reset would let a discard follow a dispatch.
  if (
    count(code, /\bdispatched\s*=\s*false\b/g) !== 0 ||
    count(code, /\bdispatched\s*=\s*true\b/g) !== 1
  ) {
    fail("dispatched must never be assigned false and assigned true exactly once");
  }
  const finish = span(/\bprivate\s+async\s+finishScope\s*\(/);
  const caller = /\bthis\.discardUnusedChangeSet\s*\(/g;
  if (
    count(code, caller) !== 1 ||
    !/\bif\s*\(\s*!dispatched\s*\)\s*await\s+this\.discardUnusedChangeSet\s*\(/.test(finish)
  ) {
    fail("discardUnusedChangeSet must be called once, in finishScope, under if (!dispatched)");
  }
  const exec = span(/\basync\s+execute\s*\(/);
  const set = exec.search(/\bdispatched\s*=\s*true\b/);
  const send = exec.indexOf("this.connectors.dispatch(");
  const fin = exec.search(/\bfinally\s*\{[^}]*this\.finishScope\s*\(/);
  if (set === -1 || send === -1 || fin === -1 || !(set < send && send < fin)) {
    fail(
      "execute must set dispatched = true before connectors.dispatch, and call finishScope in finally",
    );
  }
  const checks = span(/\bprivate\s+async\s+runGateChecks\s*\(/);
  const branch = checks.search(/\brequiresHITL\s*&&\s*scope\.discardStep\s*!==\s*undefined\b/);
  const verify = checks.search(/\bisDiscardOf\s*\(/);
  const prompt = checks.search(/\bthis\.resolveHitlApproval\s*\(/);
  if (branch === -1 || verify === -1 || prompt === -1 || !(branch < verify && verify < prompt)) {
    fail(
      "runGateChecks must reach the no-prompt discard only under scope.discardStep, after isDiscardOf, before resolveHitlApproval",
    );
  }
  return out;
}

// ---- D44 (standing approvals, I55, Phase 10 SA3) -------------------------------------------------
// A standing rule approves a write without a prompt, so five things must stay the only way in:
// (a) the owner-workflow PROVENANCE is built only by `automation/workflow-write-step.ts`: the
//     `kind: "owner_workflow"` literal is written there and in the type (`engine/types.ts`); the
//     literal is READ (never constructed) only by `engine/standing-rule-step.ts`; the type and its
//     `fieldSources` member are named only by those files and `engine/executor.ts` (the audit row's
//     trimmed copy). No IPC method, door, payload, ChatOps, LAN or HTTP path can supply one;
// (b) the `standing_rule` and `standing_rule_fire` tables are referenced only by
//     `standing/standing-rule-store.ts` and their V88 DDL, and the store's writers (`insertRule`,
//     `resumeRule`, `pauseRule`, `revokeRule`) only by the store and the `standing.*` RPC handler
//     (`ipc/standing-rpc.ts`); the counter claim `claimFire` only by the store and the check;
// (c) the order, pinned in `engine/executor.ts`: `resolveHitlApproval` calls `renderConfirmPhase`
//     BEFORE `approvalPhase`; `standingRuleStep(` is called exactly once, inside `approvalPhase`,
//     BEFORE `tryDelegatedApproval(`; the name `standingRuleStep` is used only by the executor and
//     its own module; and the `kind: "standing_approved"` / `hitlStatus: "standing_approved"` literal
//     is constructed only by the executor, the check and the type;
// (d) the UNATTENDED executor (Phase 10 SA4, scheduled runs): the property name `unattended` appears
//     only in `engine/executor.ts` (the option's type, its field, and ONE read) and, as a value, only
//     inside `newWorkflowWriteExecutor` in `engine/run-ask.ts`; the read is a single `this.unattended`
//     test inside `approvalPhase`, AFTER `standingRuleStep(` and BEFORE `tryDelegatedApproval(`, so an
//     unattended executor consults a rule and then refuses without asking anyone; the refusal text
//     `UNATTENDED_NO_RULE_REASON` is returned only in `approvalPhase` (the workflow write step may
//     compare it, to block the run); and the trigger literal `trigger: "schedule"` is produced only
//     by `automation/workflow-scheduler.ts` (no IPC path can: `workflowTriggerOf` returns only
//     `owner_cli` / `owner_ui`). `buildUnattendedWorkflowWriteExecutor` is confined by D39;
// (e) the executor dependency `standingRules` is handed over only by the workflow write executors in
//     `engine/run-ask.ts`: the identifier is named only by the executor, run-ask and the standing
//     module that builds it, and run-ask writes `standingRules:` exactly once, inside the private
//     `newWorkflowWriteExecutor`, which only `buildWorkflowWriteExecutor` and
//     `buildUnattendedWorkflowWriteExecutor` call (once each). Every other executor therefore has
//     none and can never approve by a rule.
// (f) approval learning (Phase 10 SA5): the `standing_streak` and `standing_suggestion` tables are
//     referenced only by `standing/standing-suggestion-store.ts` and their V90 DDL, which also name
//     neither rule table (clause (b) covers that: the store is not exempt from it); the store's
//     streak and suggestion writers (`applyStepRun`, `openSuggestion`, `markStaleFor`) are named only by
//     the store and the learning pass (`standing/approval-learning.ts`); `learnFromStepRun` is named
//     only by that pass and the workflow runner (`automation/workflow-runner.ts`); and
//     `hasLiveRuleFor`, the pass's one question to the rule store, only by the rule store and the
//     pass. The pass may READ the `"owner_workflow"` literal (clause (a)) but never construct it.
// Comments are stripped before matching (string literals are kept for the literal clauses); test
// files, a test-support `*.test-helpers.ts` that no production file imports, and anything outside
// packages/gateway/src/ are not scanned. STATED BOUND, as D33(c)/D41/D42: a dynamically composed
// name evades a text scan, a second use inside an allow-listed file is exempt whole-file (the order
// pins narrow that for the executor), and an alias is not followed. The order pins are TEXTUAL:
// the behavioural tests in `security-invariants.test.ts` (I55) are authoritative.
const D44_SRC = "packages/gateway/src/";
const D44_EXECUTOR = `${D44_SRC}engine/executor.ts`;
const D44_STEP = `${D44_SRC}engine/standing-rule-step.ts`;
const D44_TYPES = `${D44_SRC}engine/types.ts`;
const D44_WRITE_STEP = `${D44_SRC}automation/workflow-write-step.ts`;
const D44_STORE = `${D44_SRC}standing/standing-rule-store.ts`;
const D44_V88 = `${D44_SRC}index/standing-rule-v88-sql.ts`;
const D44_RPC = `${D44_SRC}ipc/standing-rpc.ts`;
const D44_RUN_ASK = `${D44_SRC}engine/run-ask.ts`;
const D44_SCHEDULER = `${D44_SRC}automation/workflow-scheduler.ts`;
const D44_LEARNING = `${D44_SRC}standing/approval-learning.ts`;
const D44_SUGGESTION_STORE = `${D44_SRC}standing/standing-suggestion-store.ts`;
const D44_V90 = `${D44_SRC}index/standing-suggestion-v90-sql.ts`;
const D44_RUNNER = `${D44_SRC}automation/workflow-runner.ts`;
const D44_LEARNING_TABLE_RES: readonly RegExp[] = ["standing_streak", "standing_suggestion"].map(
  (t) => {
    const re = sqlTableReferenceRe(t);
    return new RegExp(re.source, "gi");
  },
);
const D44_TABLE_RES: readonly RegExp[] = ["standing_rule", "standing_rule_fire"].map((t) => {
  const re = sqlTableReferenceRe(t);
  return new RegExp(re.source, "gi");
});
const D44_NAME_RULES: ReadonlyArray<{
  readonly rule: string;
  readonly re: RegExp;
  readonly allowed: readonly string[];
  /** Match against comment-stripped source with strings kept (a string spelling is a spelling). */
  readonly keepStrings: boolean;
}> = [
  {
    rule: "standing-provenance-confined",
    re: /["']owner_workflow["']/g,
    // The learning pass READS the literal off a parsed audit row; the construction rule below is not widened.
    allowed: [D44_WRITE_STEP, D44_TYPES, D44_STEP, D44_LEARNING],
    keepStrings: true,
  },
  {
    rule: "standing-provenance-confined",
    // Construction in any spelling: `kind:`, a quoted key `"kind":`, or an assignment `p.kind =` /
    // `p["kind"] =` (never `===`, so a reader's comparison is not a construction).
    re: /(?:\bkind|["']kind["'])\s*:\s*["']owner_workflow["']|(?:\.\s*kind|\[\s*["']kind["']\s*\])\s*=(?!=)\s*["']owner_workflow["']/g,
    allowed: [D44_WRITE_STEP, D44_TYPES],
    keepStrings: true,
  },
  {
    rule: "standing-provenance-confined",
    re: /\bWorkflowProvenance\b|\bfieldSources\b/g,
    allowed: [D44_WRITE_STEP, D44_TYPES, D44_STEP, D44_EXECUTOR],
    keepStrings: false,
  },
  {
    rule: "standing-tables-confined",
    re: /\b(?:insertRule|resumeRule|pauseRule|revokeRule)\b/g,
    allowed: [D44_STORE, D44_RPC],
    keepStrings: false,
  },
  {
    rule: "standing-tables-confined",
    re: /\bclaimFire\b/g,
    allowed: [D44_STORE, D44_STEP],
    keepStrings: false,
  },
  {
    rule: "standing-outcome-confined",
    re: /\b(?:kind|hitlStatus)\s*:\s*["']standing_approved["']/g,
    allowed: [D44_EXECUTOR, D44_STEP, D44_TYPES],
    keepStrings: true,
  },
  {
    rule: "standing-outcome-confined",
    re: /\bstandingRuleStep\b/g,
    allowed: [D44_EXECUTOR, D44_STEP],
    keepStrings: false,
  },
  {
    rule: "standing-rules-dep-confined",
    re: /\bstandingRules\b/g,
    allowed: [D44_EXECUTOR, D44_RUN_ASK],
    keepStrings: false,
  },
  // (d) the property name; run-ask's own use is narrowed to one function by `d44RunAskPins`.
  {
    rule: "standing-unattended-confined",
    re: /\bunattended\b/g,
    allowed: [D44_EXECUTOR, D44_RUN_ASK],
    keepStrings: false,
  },
  // (d) the one producer of the trigger "schedule".
  {
    rule: "standing-unattended-confined",
    re: /\btrigger\s*:\s*["']schedule["']/g,
    allowed: [D44_SCHEDULER],
    keepStrings: true,
  },
  // (d) the refusal text: the executor returns it, the write step compares it.
  {
    rule: "standing-unattended-confined",
    re: /\bUNATTENDED_NO_RULE_REASON\b/g,
    allowed: [D44_EXECUTOR, D44_WRITE_STEP],
    keepStrings: false,
  },
  // (f) approval learning.
  {
    rule: "standing-learning-confined",
    re: /\blearnFromStepRun\b/g,
    allowed: [D44_LEARNING, D44_RUNNER],
    keepStrings: false,
  },
  {
    rule: "standing-learning-confined",
    re: /\b(?:applyStepRun|openSuggestion|markStaleFor)\b/g,
    allowed: [D44_SUGGESTION_STORE, D44_LEARNING],
    keepStrings: false,
  },
  {
    rule: "standing-learning-confined",
    re: /\bhasLiveRuleFor\b/g,
    allowed: [D44_STORE, D44_LEARNING],
    keepStrings: false,
  },
];

export function checkStandingApprovals(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D44_SRC)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (f.relPath !== D44_STORE && f.relPath !== D44_V88) {
      for (const re of D44_TABLE_RES) {
        for (const m of commentFree.matchAll(re))
          add(f, "standing-tables-confined", commentFree, m.index);
      }
    }
    if (f.relPath !== D44_SUGGESTION_STORE && f.relPath !== D44_V90) {
      for (const re of D44_LEARNING_TABLE_RES) {
        for (const m of commentFree.matchAll(re))
          add(f, "standing-learning-confined", commentFree, m.index);
      }
    }
    for (const r of D44_NAME_RULES) {
      if (r.allowed.includes(f.relPath)) continue;
      const src = r.keepStrings ? commentFree : code;
      for (const m of src.matchAll(r.re)) add(f, r.rule, src, m.index);
    }
    if (f.relPath === D44_EXECUTOR) for (const v of d44ExecutorPins(f, code)) out.push(v);
    if (f.relPath === D44_RUN_ASK) for (const v of d44RunAskPins(f, code)) out.push(v);
  }
  return out;
}

/** Clause (c): the order inside the executor. */
function d44ExecutorPins(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "standing-step-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const span = (sig: RegExp): string => {
    const s = d41Span(code, sig, "\n  }\n");
    return s === undefined ? "" : code.slice(s[0], s[1]);
  };
  const calls = [...code.matchAll(/\bstandingRuleStep\s*\(/g)];
  const approval = span(/\bprivate\s+async\s+approvalPhase\s*\(/);
  const stepAt = approval.search(/\bstandingRuleStep\s*\(/);
  const delegateAt = approval.search(/\bthis\.tryDelegatedApproval\s*\(/);
  if (calls.length !== 1 || stepAt === -1 || delegateAt === -1 || !(stepAt < delegateAt)) {
    fail(
      "standingRuleStep( must be called exactly once, in approvalPhase, before tryDelegatedApproval(",
    );
  }
  const resolve = span(/\bprivate\s+async\s+resolveHitlApproval\s*\(/);
  const renderAt = resolve.indexOf("this.renderConfirmPhase(");
  const approveAt = resolve.indexOf("this.approvalPhase(");
  if (renderAt === -1 || approveAt === -1 || !(renderAt < approveAt)) {
    fail("resolveHitlApproval must call renderConfirmPhase before approvalPhase");
  }
  for (const v of d44UnattendedPins(f, code, approval, stepAt, delegateAt)) out.push(v);
  return out;
}

/**
 * Clause (d), inside the executor: the `unattended` option is read once, in `approvalPhase`, after
 * the standing-rule step and before any delegate, and the refusal text is returned only there.
 */
function d44UnattendedPins(
  f: FileEntry,
  code: string,
  approval: string,
  stepAt: number,
  delegateAt: number,
): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "standing-unattended-confined", file: f.relPath, line: 1, snippet: what });
  };
  // A read is `this.unattended` not followed by an assignment.
  const readRe = /\bthis\.unattended\b(?!\s*=[^=])/;
  const reads = [...code.matchAll(new RegExp(readRe.source, "g"))];
  const readAt = approval.search(readRe);
  if (reads.length !== 1 || readAt === -1 || !(stepAt < readAt && readAt < delegateAt)) {
    fail(
      "this.unattended must be read exactly once, in approvalPhase, after standingRuleStep( and before tryDelegatedApproval(",
    );
  }
  const reasonInApproval = [...approval.matchAll(/\bUNATTENDED_NO_RULE_REASON\b/g)].length;
  const reasonAll = [...code.matchAll(/\bUNATTENDED_NO_RULE_REASON\b/g)].length;
  const definitions = [...code.matchAll(/\bconst\s+UNATTENDED_NO_RULE_REASON\b/g)].length;
  if (reasonInApproval === 0 || reasonAll - reasonInApproval !== definitions) {
    fail("UNATTENDED_NO_RULE_REASON must be returned in approvalPhase and used nowhere else");
  }
  return out;
}

/**
 * Clauses (d) and (e), in run-ask: `standingRules:` and the `unattended` value are written once,
 * inside the private `newWorkflowWriteExecutor`, which only the two public builders call (once each).
 */
function d44RunAskPins(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (rule: string, what: string): void => {
    out.push({ rule, file: f.relPath, line: 1, snippet: what });
  };
  const maker = d41Span(code, /\bfunction\s+newWorkflowWriteExecutor\s*\(/, "\n}\n");
  const inSpan = (span: readonly [number, number] | undefined, at: number | undefined): boolean =>
    span !== undefined && at !== undefined && at >= span[0] && at < span[1];
  const writes = [...code.matchAll(/\bstandingRules\s*:/g)];
  if (writes.length !== 1 || !inSpan(maker, writes[0]?.index)) {
    fail(
      "standing-rules-dep-confined",
      "standingRules: must be written once, inside newWorkflowWriteExecutor",
    );
  }
  for (const m of code.matchAll(/\bunattended\b/g)) {
    if (!inSpan(maker, m.index)) {
      fail(
        "standing-unattended-confined",
        "the unattended option may be named only inside newWorkflowWriteExecutor",
      );
      break;
    }
  }
  const calls = [...code.matchAll(/(?<!function\s)\bnewWorkflowWriteExecutor\s*\(/g)];
  const attended = d41Span(code, /\bexport\s+function\s+buildWorkflowWriteExecutor\s*\(/, "\n}\n");
  const unattended = d41Span(
    code,
    /\bexport\s+function\s+buildUnattendedWorkflowWriteExecutor\s*\(/,
    "\n}\n",
  );
  const within = (span: readonly [number, number] | undefined): number =>
    calls.filter((c) => inSpan(span, c.index)).length;
  // The attended builder passes `false` and the unattended one `true`, literally.
  const passes = (span: readonly [number, number] | undefined, flag: string): boolean =>
    calls.some((c) => {
      if (!inSpan(span, c.index)) return false;
      // The statement ends at its `;` (the arguments may nest calls and span lines).
      const statementEnd = code.indexOf(";", c.index);
      return new RegExp(String.raw`,\s*${flag}\s*,?\s*\)\s*$`).test(
        code.slice(c.index, statementEnd),
      );
    });
  if (
    calls.length !== 2 ||
    within(attended) !== 1 ||
    within(unattended) !== 1 ||
    !passes(attended, "false") ||
    !passes(unattended, "true")
  ) {
    fail(
      "standing-rules-dep-confined",
      "newWorkflowWriteExecutor must be called exactly once by each of buildWorkflowWriteExecutor and buildUnattendedWorkflowWriteExecutor, and by nothing else",
    );
  }
  return out;
}

// ---- D36 (role-pack layer writers, I47) ----------------------------------------------------------
// A role-pack layer changes the owner's effective config, so I47 lets `packs/pack-install.ts` write
// one only after the LOCAL owner approved `pack.install` over the pack's exact `defaults` text. The
// store's write half — `setPackLayer` and `removePackLayer` — is named only by its definition
// (`packs/pack-layer-store.ts`) and that one gate module. Any other mention — a call, a destructured
// alias, an import of a re-export — is a violation. Comments and string literals are stripped
// first; test files and anything outside packages/gateway/src/ are not scanned. Stated bound, as
// D33(c): a dynamically composed call (`store["set" + "PackLayer"]`) evades a text scan, and a
// second call inside an allow-listed file is exempt whole-file; capability confinement (only the
// gate module is ever handed the store's write half in production) is the real defense.
const D36_WRITER_RE = /\b(?:setPackLayer|removePackLayer)\b/g;
const D36_WRITER_ALLOWED: readonly string[] = [
  "packages/gateway/src/packs/pack-layer-store.ts",
  "packages/gateway/src/packs/pack-install.ts",
];

export function checkPackLayerWriters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D36_WRITER_ALLOWED.includes(f.relPath)) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const m of code.matchAll(D36_WRITER_RE)) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "pack-layer-writers",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// ---- D34 (connector migration) -------------------------------------------------------------------
// A connector migration (Readwise unbundling spec § 7.2) installs signed code, grants it a run and
// points it at the owner's existing Vault credential behind ONE `extension.migrate` approval. Three
// confinements keep that one approval the only way in, mirroring D33(b)/(c):
// (a) the `connector_migration` table is named only by its store and its V73 DDL — a row in
//     `awaiting_approval` is what `approveMigratedExtensionRun` requires, so writing one elsewhere
//     would forge the precondition for a prompt-less grant;
// (b) `approveMigratedExtensionRun` — the migration grant entry point, which takes no consent of
//     its own — is named only by its definition (`approve-run.ts`) and the migration engine, which
//     calls it only after the owner's `extension.migrate` answer;
// (c) the `extension.migrate` consent is raised only by the engine and the RPC path:
//     `migrationConsentViaGate` and `EXTENSION_MIGRATE_ACTION_TYPE` are named only by the engine and
//     `ipc/migration-rpc.ts`; the `"extension.migrate"` literal only by the engine, the I2 frozen set
//     (`engine/executor.ts`, which is what gates it) and the proposability table
//     (`connectors/proposable-actions.ts`, which denies it); `createMigrationEngine` only by the
//     engine and `platform/migration-boot.ts`, the one production constructor; and the
//     `migrationEngine` option that carries the built instance only by `platform/assemble.ts` (which
//     sets it), `ipc/server/options.ts` (which types it) and `ipc/server/dispatchers.ts` (which hands
//     it to `ipc/migration-rpc.ts`).
// Comments are stripped first; identifiers are matched as words after string literals are stripped
// too (so an aliased import is caught), the literal on comment-stripped source. Test files and
// anything outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a dynamically
// composed name (`options["migration" + "Engine"]`) evades a text scan, and a second use inside an
// allow-listed file is exempt whole-file. That matters for `dispatchers.ts`: every dispatcher there
// receives the `ServerCtx` that carries the engine, and a caller holding it could pass `accept` a
// consent callback of its own (`async () => true`). The rule cannot see which function in that file
// reads the option; an I44-block test in `security-invariants.test.ts` pins that exactly one place in
// `dispatchers.ts` does — `tryDispatchMigrationRpc` — and that `accept` is called only by
// `ipc/migration-rpc.ts`.
const D34_TABLE_RE = sqlTableReferenceRe("connector_migration");
const D34_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/migration/migration-store.ts",
  "packages/gateway/src/index/connector-migration-v73-sql.ts",
];
const D34_ENGINE = "packages/gateway/src/extensions/migration/migration-engine.ts";
const D34_IDENTIFIER_SCANS: ReadonlyArray<
  readonly [rule: string, re: RegExp, allowed: readonly string[]]
> = [
  [
    "migration-grant-callers",
    /\bapproveMigratedExtensionRun\b/g,
    ["packages/gateway/src/extensions/approve-run.ts", D34_ENGINE],
  ],
  [
    "migration-consent-raisers",
    /\b(?:migrationConsentViaGate|EXTENSION_MIGRATE_ACTION_TYPE)\b/g,
    [D34_ENGINE, "packages/gateway/src/ipc/migration-rpc.ts"],
  ],
  [
    "migration-consent-raisers",
    /\bcreateMigrationEngine\b/g,
    [D34_ENGINE, "packages/gateway/src/platform/migration-boot.ts"],
  ],
  [
    "migration-consent-raisers",
    /\bmigrationEngine\b/g,
    [
      "packages/gateway/src/platform/assemble.ts",
      "packages/gateway/src/ipc/server/options.ts",
      "packages/gateway/src/ipc/server/dispatchers.ts",
    ],
  ],
];
const D34_LITERAL_RE = /["'`]extension\.migrate["'`]/g;
const D34_LITERAL_ALLOWED: readonly string[] = [
  D34_ENGINE,
  "packages/gateway/src/engine/executor.ts",
  "packages/gateway/src/connectors/proposable-actions.ts",
];

export function checkMigrationConfinement(files: readonly FileEntry[]): Violation[] {
  const out = checkTableConfinement(
    files,
    D34_TABLE_RE,
    D34_TABLE_ALLOWED,
    "migration-table-confined",
  );
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    const push = (rule: string, src: string, index: number | undefined): void => {
      const line = src.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    for (const [rule, re, allowed] of D34_IDENTIFIER_SCANS) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push(rule, code, m.index);
    }
    if (!D34_LITERAL_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D34_LITERAL_RE)) {
        push("migration-consent-raisers", commentFree, m.index);
      }
    }
  }
  return out;
}

// ---- D35 (layered config reader) -----------------------------------------------------------------
// Tied to no invariant. Config is read through the layered reader (`config/layered-config.ts`) so
// every setting follows the active profile. Stated bound: a dynamically composed path or file name
// evades a text scan, as does a nested call such as join(getDir(), "nimbus.toml") (the [^()]* match
// cannot cross the inner parentheses).
const D35_PATH_RE = /\b(?:join|resolve)\s*\([^()]*["'`]nimbus\.toml["'`]/g;
const D35_PROFILE_RE = /\bresolveNimbusTomlForProfile\b/g;
const D35_FROM_PATH_RE = /(?<!function\s)\bload\w+FromPath\s*\(/g;
const D35_PATH_ALLOWED: readonly string[] = [
  "packages/gateway/src/config/layered-config.ts",
  "packages/gateway/src/config/active-profile.ts",
  "packages/gateway/src/demo/seed.ts",
];

export function checkConfigReaderConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    const push = (index: number | undefined): void => {
      const line = code.slice(0, index).split("\n").length;
      out.push({
        rule: "config-reader-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    };
    if (!D35_PATH_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D35_PATH_RE)) push(m.index);
      for (const m of code.matchAll(D35_PROFILE_RE)) push(m.index);
    }
    if (!f.relPath.startsWith("packages/gateway/src/config/")) {
      for (const m of code.matchAll(D35_FROM_PATH_RE)) push(m.index);
    }
  }
  return out;
}

// (b) The five gate entry points are CALLED only from ipc/capture-rpc.ts and DEFINED only in
//     capture-gate.ts. Any other mention — a call or an import (aliased or not) — is a violation, so
//     a second door cannot be opened by importing the function under another name.
const D32_GATE_FN_RE =
  /\b(?:submitCapture|acceptCapture|rejectCapture|revokeCapture|purgeCapture)\b/g;
const D32_GATE_ALLOWED: readonly string[] = [
  "packages/gateway/src/ipc/capture-rpc.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];

export function checkCaptureGateCallers(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D32_GATE_ALLOWED.includes(f.relPath)) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const m of code.matchAll(D32_GATE_FN_RE)) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "capture-gate-callers",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// (c) No module outside ipc/capture-rpc.ts may VALUE-import (or re-export, or dynamically import)
//     capture-gate.ts. (b) is an identifier scan, which a barrel `export * from ".../capture-gate.ts"`
//     or a namespace import called through a computed key evades; this closes it at the module edge.
//     `import type` / `export type` carry no runtime reference and are allowed anywhere. The span
//     between the keyword and `from` may not cross another `import`/`export` keyword or a completed
//     `from "…"` clause, so in semicolon-free code a match cannot start at an earlier `import type`
//     and carry that statement's exemption onto the value import after it. The last alternative
//     takes both a dynamic `import("…")` and a side-effect `import "…"`, which has no `from` clause.
const D32_GATE_MODULE_RE =
  /\b(?:import|export)\b(?:(?!\bfrom\s*["']|\b(?:import|export)\b)[^;])*?\bfrom\s*["'][^"']*capture-gate(?:\.ts)?["']|\bimport\s*\(?\s*["'][^"']*capture-gate(?:\.ts)?["']/g;

export function checkCaptureGateImporters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === "packages/gateway/src/ipc/capture-rpc.ts") continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(D32_GATE_MODULE_RE)) {
      if (/^(?:import|export)\s+type\b/.test(m[0])) continue;
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "capture-gate-importers",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// (d) Rows with 'agent' provenance arise ONLY from an owner-accepted capture. The four agent-row
//     writers are named only by their definitions and `mcp-sink/capture-native.ts`, and
//     capture-native's write/inverse entry points only by itself and `capture-gate.ts`, so the one
//     path to an 'agent' row is acceptCapture → writeCaptureNative. Stated bound: a hand-written
//     `INSERT … 'agent'` elsewhere, string-keyed access (`gs["upsertAgentTerm"](…)` — the literal is
//     stripped), a caller in a non-test file outside packages/gateway/src/ (scripts/, test helpers),
//     and a second caller INSIDE an allow-listed file (exempt whole-file) are all invisible to this
//     identifier scan; capability confinement (only the stores are handed those tables' writers) is
//     the real defense, as with D27(b).
const D32_AGENT_WRITER_RE =
  /\b(?:insertAgentDecision|deleteAgentDecision|upsertAgentTerm|deleteAgentTerm)\b/g;
const D32_AGENT_WRITER_ALLOWED: readonly string[] = [
  "packages/gateway/src/decisions/decision-store.ts",
  "packages/gateway/src/glossary/glossary-store.ts",
  "packages/gateway/src/mcp-sink/capture-native.ts",
];
const D32_CAPTURE_NATIVE_RE = /\b(?:writeCaptureNative|revokeCaptureNative)\b/g;
const D32_CAPTURE_NATIVE_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-native.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];

export function checkAgentProvenanceWriters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const scans: Array<[RegExp, readonly string[]]> = [
      [D32_AGENT_WRITER_RE, D32_AGENT_WRITER_ALLOWED],
      [D32_CAPTURE_NATIVE_RE, D32_CAPTURE_NATIVE_ALLOWED],
    ];
    for (const [re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "agent-provenance-writers",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// (e)(f)(g) The act door (spec 2026-10-15 § 12.2). (e) `acceptAction` is named only by its definition
//     (mcp-sink/capture-act.ts) and its one caller (mcp-sink/capture-gate.ts's acceptCapture); other
//     exports of capture-act.ts (e.g. `formatActionConsent`, imported by ipc/capture-rpc.ts) are not
//     covered. (f) No non-test `mcp-sink/` file imports, re-exports or dynamically imports
//     `engine/executor.ts` or anything under `connectors/` — TYPE imports included: execution,
//     classification and configured-ness reach the sink only as injected functions, built in
//     ipc/capture-rpc.ts and platform/assemble.ts. `engine/service-of.ts` is a pure string helper and
//     stays allowed. The import shape is D32(c)'s: the span between the keyword and `from` may not
//     cross another `import`/`export` keyword or a completed `from "…"` clause, so in semicolon-free
//     code an allowed import cannot swallow a forbidden one after it; the last alternative takes both
//     a dynamic `import("…")` and a side-effect `import "…"`. Separate passes catch `require("…")`
//     (incl. `import X = require("…")`) and a backtick `import(`…`)`, and the executor specifier
//     matches with any `.[cm]?[jt]s` extension or none (`../engine/executor.js` included). (g) The `mcpToolId` literal appears under
//     mcp-sink/ only in capture-validate.ts, where a key of that name is REFUSED — the gateway, never
//     the agent, chooses the tool (I42 pairing). Comments are stripped; strings are NOT (a key lives
//     there). Stated bound, as D32(a): a dynamically composed specifier or key evades a text scan, and
//     (e) exempts whole files, so a second caller inside capture-gate.ts is invisible; capability
//     confinement (the sink is never handed a dispatcher) is the real defence.
const D32E_ACCEPT_ACTION_RE = /\bacceptAction\b/g;
const D32E_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-act.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];
const D32F_MODULE_RE =
  /\b(?:import|export)\b(?:(?!\bfrom\s*["']|\b(?:import|export)\b)[^;])*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;
// A separate pass, so an `import … from` span can never swallow one: CommonJS `require("…")`,
// which also covers TypeScript's `import X = require("…")`.
const D32F_REQUIRE_RE = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g;
// A separate pass for a backtick dynamic `import(`…`)`, whose specifier may be a template.
const D32F_TEMPLATE_IMPORT_RE = /\bimport\s*\(\s*`([^`]+)`/g;
// Any emitted/source extension (`.ts`, `.js`, `.mjs`, `.cts`, …) or none.
const D32F_FORBIDDEN_SPEC_RE = /(?:^|\/)engine\/executor(?:\.[cm]?[jt]s)?$|(?:^|\/)connectors\//;
const D32G_LITERAL_RE = /mcpToolId/g;
const D32G_ALLOWED = "packages/gateway/src/mcp-sink/capture-validate.ts";
const MCP_SINK_PREFIX = "packages/gateway/src/mcp-sink/";

export function checkActDoorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    // stripComments and stripStringLiterals both preserve length, so a match offset in either maps
    // to the same line of the original source.
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    const push = (rule: string, index: number): void => {
      const line = code.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    if (!D32E_ALLOWED.includes(f.relPath)) {
      for (const m of stripStringLiterals(code).matchAll(D32E_ACCEPT_ACTION_RE)) {
        push("act-door-accept-action", m.index);
      }
    }
    if (!f.relPath.startsWith(MCP_SINK_PREFIX)) continue;
    for (const re of [D32F_MODULE_RE, D32F_REQUIRE_RE, D32F_TEMPLATE_IMPORT_RE]) {
      for (const m of code.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? "";
        if (D32F_FORBIDDEN_SPEC_RE.test(spec)) push("mcp-sink-no-executor-or-connectors", m.index);
      }
    }
    if (f.relPath !== D32G_ALLOWED) {
      for (const m of code.matchAll(D32G_LITERAL_RE)) push("mcp-sink-mcptoolid-literal", m.index);
    }
  }
  return out;
}

// D29 (a) (I39): the `nimbus/fetch` brokered-fetch METHOD LITERAL — the string a generated tool's
// stdio message and the broker's dispatch must agree on — is defined ONCE, in
// `toolgen/toolgen-types.ts`'s `BROKERED_FETCH_METHOD`, and confined there. A producer and a
// consumer that separately hardcode the same string are two copies that can drift invisibly, the
// exact failure the `SANDBOX_POLICY_ENV` comment warns about for its own wire; confining the single
// definition site is a stronger rule than allow-listing every file that would otherwise carry a
// copy.
//
// Comments are stripped before scanning, and that cuts BOTH ways: without stripping, a doc comment
// that merely MENTIONS the method (as this very comment does, in the paragraph above) would red the
// build; with stripping, the rule cannot see a literal hidden inside a comment -- accepted, because
// a comment does not execute and every real code path still goes through the exported constant.
//
// Only the QUOTED literal is matched (`"nimbus/fetch"` / `'nimbus/fetch'` / `` `nimbus/fetch` ``),
// with the same quote character on both sides, so the rule fires on the string's actual text
// rather than on any substring that happens to contain it.
const D29_FETCH_LITERAL_DEFINITION_FILE = "packages/gateway/src/toolgen/toolgen-types.ts";
const D29_FETCH_LITERAL_RE = /(["'`])nimbus\/fetch\1/;

export function checkBrokeredFetchLiteralConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D29_FETCH_LITERAL_DEFINITION_FILE) continue;
    // Comments blanked; string literals left intact -- the literal we are hunting FOR lives inside
    // a string, so stripping strings too would blind the rule to the exact thing it exists to see.
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D29_FETCH_LITERAL_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(a)-brokered-fetch-literal-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D29 (b) (I39): the GENERATED-MANIFEST CONSTRUCTOR — `buildGeneratedManifest`, the ONLY function
// that produces the `ExtensionManifest` a generated tool spawns under — is defined only in
// `toolgen/toolgen-stub.ts`, and that file may never assign `permissions.network` a non-empty
// array LITERAL. Two checks, one rule, because they guard the same property from two directions:
// a second definition elsewhere could return whatever `network:` it likes with nobody the wiser,
// and the ONE approved definition drifting to a non-empty literal would silently open the exact
// hole `permissions.network = []` exists to close (mirrors I33's `buildExecPolicy` rule, where a
// requested grant is REJECTED rather than dropped).
//
// The definition check matches on the `function` KEYWORD directly preceding the name, so an
// ordinary call (`buildGeneratedManifest(toolId)`), an import, or a `typeof buildGeneratedManifest`
// type query -- all of which appear legitimately elsewhere in this tree -- does not trip it; only a
// second DECLARATION would.
//
// The network-literal check is scoped to the one allowed file only: a non-empty ARRAY LITERAL after
// `network:` (`network: ["x"]`), never a bare `network: []` and never a non-literal expression such
// as `network: opts.network` (checked at runtime by `buildGeneratedManifest`'s own throw, not by
// this static rule).
//
// STATED BOUND, in D29(c)'s own style: keying on the `function` KEYWORD means a definition written
// as `const buildGeneratedManifest = (...) => {...}` or as a class method would evade this rule --
// this repo's one production definition is a `function` declaration today, but the regex is a text
// scan over ONE shape, not a symbol-confinement guarantee. Capability confinement (only this file
// is ever wired as the manifest constructor at every call site the toolgen chokepoint reaches) is
// the real defense; this rule is the backstop for the copy-paste/second-definition case, not the
// boundary, exactly as D29(c) says of the `toolgen.` Vault-key prefix.
const D29_MANIFEST_DEFINITION_FILE = "packages/gateway/src/toolgen/toolgen-stub.ts";
const D29_MANIFEST_DEFINITION_RE = /\bfunction\s+buildGeneratedManifest\s*\(/;
const D29_MANIFEST_NETWORK_RE = /\bnetwork\s*:\s*\[\s*(?!\])/;

export function checkGeneratedManifestConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");

    if (f.relPath !== D29_MANIFEST_DEFINITION_FILE) {
      const m = D29_MANIFEST_DEFINITION_RE.exec(code);
      if (m !== null) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "D29(b)-generated-manifest-definition-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
      continue;
    }

    for (const m of code.matchAll(new RegExp(D29_MANIFEST_NETWORK_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(b)-generated-manifest-network-nonempty",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D29 (c) (I39): the `toolgen.` VAULT-KEY prefix a generated tool's per-host credential lives under
// (`toolgen.<toolId>.<hostSlug>`) is composed only in `toolgen/toolgen-credentials.ts`'s
// `toolCredentialKey`. Matches the TEMPLATE-LITERAL SHAPE of the actual key -- a `toolgen.` prefix,
// an interpolation, a literal `.`, and a second interpolation -- rather than any string that merely
// starts with `toolgen.`: `toolgen-stub.ts` legitimately builds the unrelated single-segment
// extension id `` `toolgen.${toolId}` `` (no second `.${...}` segment), and a rule keyed on the
// bare prefix would false-positive on it. Written as what CANNOT pass: any file other than
// `toolgen-credentials.ts` composing a string with this exact two-segment shape is a second Vault
// keyspace producer that can drift from the escaping scheme `toolCredentialKey` implements (see
// that function's own comment on why the escape ORDER matters).
//
// STATED BOUND, matching D27(b)'s bound on `media_grant`: the keys are composed dynamically, so a
// prefix built through string concatenation or an indirection this regex cannot see still evades a
// text scan. Capability confinement -- only `toolgen-credentials.ts` is ever handed the Vault for
// that prefix -- is the real defense; this rule and the `VAULT_KEY_ALLOW_LIST` entry above both
// document the keyspace rather than fully enforcing it.
const D29_VAULT_KEY_DEFINITION_FILE = "packages/gateway/src/toolgen/toolgen-credentials.ts";
const D29_VAULT_KEY_RE = /`toolgen\.\$\{[^}]*\}\.\$\{[^}]*\}/;

export function checkToolgenVaultKeyConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D29_VAULT_KEY_DEFINITION_FILE) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D29_VAULT_KEY_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(c)-toolgen-vault-key-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D29 (d) (I40): there is no unverified read accessor for a saved generated-tool artifact.
// `toolgen-saved-store.ts`'s `readVerifiedSavedTool` is the ONLY function this codebase permits to
// hand a saved tool's body or fields to a caller, and it verifies the artifact's Ed25519 signature
// (I40) before returning anything -- see that file's own docstring, which calls this "the whole
// point of it existing".
//
// Keyed on IDENTIFIERS, not on the on-disk path text. A proposed form scanned file contents for
// `/toolgen[\\/]saved/`, and there are ZERO such literals anywhere in this tree -- the store
// composes every path from its own private constants (`join(configDir, STORE_DIR, SAVED_DIR,
// toolId)`), so that rule would match nothing and report green forever, which is worse than no
// rule at all: it reads as coverage.
//
// `SAVED_DIR` is the store's own private directory-segment constant (value `"saved"`). Deliberately
// NOT `STORE_DIR` (value `"toolgen"`): the unrelated ephemeral script store (`toolgen-script-store.ts`)
// declares its own module-private `STORE_DIR` of the same name for an unrelated purpose, so keying
// on that name would false-positive on a file this rule has no business flagging. `SAVED_DIR` names
// no other file's concept and is safe to key on without that collision.
// `readSavedToolUnverified` and `rawSavedArtifact` name no function that exists in this tree today;
// they are the SHAPE a future bypass would plausibly take (a "just peek at the JSON" helper, a
// debug dump, a fast path that trusts the row's cached health column because "it already says
// healthy") rather than a shape actually present anywhere yet. `readVerifiedSavedTool` itself is
// deliberately NOT matched -- it is the sanctioned door this rule exists to protect, not to flag.
//
// STATED BOUND, in D27(b)'s own style: a dynamically composed path, or a renamed local built by
// string concatenation or re-exported under an alias, still evades a text scan -- that residual is
// closed the way the others are, by capability, not by this rule: only `toolgen-saved-store.ts` is
// ever hard-coded with the saved-tool directory layout, and every other module reaches a saved
// artifact only through `readVerifiedSavedTool`. This rule is the backstop for a second definition
// or a leaked constant appearing in the wrong file, exactly as D27(b) says of `media_grant`.
const D29D_STORE = "packages/gateway/src/toolgen/toolgen-saved-store.ts";
const D29D_FORBIDDEN_RE = /\b(SAVED_DIR|readSavedToolUnverified|rawSavedArtifact)\b/;

export function checkSavedToolAccessorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D29D_STORE) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D29D_FORBIDDEN_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(d)-saved-tool-accessor-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D30: a file that can OPEN a SQLite database reaches the full-SQLite install first.
//
// `Database.setCustomSQLite(path)` is what makes `db.loadExtension()` — and therefore sqlite-vec,
// and therefore vector search, hybrid ranking and session-memory recall — work at all on macOS,
// where Bun links Apple's extension-less system SQLite. It is process-wide, it only works before
// the first database is opened, and a Bun `Worker` is a separate realm with its own `bun:sqlite`.
// So the install has to happen in EVERY process and realm that opens a database, ahead of the
// open. `platform/sqlite-runtime.ts`'s `ensureFullSqlite()` is that install (a no-op off darwin,
// and idempotent, so calling it in a realm that has already installed one costs nothing).
//
// Issue #1029 is what a missed call looks like: nobody ever made ONE of these calls, sqlite-vec
// has never loaded on macOS in CI or on a user's machine, and the symptom was 54 test sites
// quietly skipping themselves. A partial fix has the same shape and is harder to see, because the
// three entry points that WERE wired make the product look fixed.
//
// WRITTEN AS WHAT CANNOT PASS, not as an allow-list of what may. There is no allow-list at all:
// every file in the scanned set that can construct a `Database` names `ensureFullSqlite`. A new
// entry point added tomorrow is a violation on the day it is written, with no list for anyone to
// forget to update — this repo's recorded lesson is that allow-list guards fail silently.
//
// WHAT COUNTS AS "can open one": a VALUE import from `bun:sqlite`. `import type { Database }` is
// the overwhelmingly common form here (~200 files receive a handle they did not open) and binds
// nothing at runtime, so it is correctly invisible to this rule. Everything that DOES bind the
// constructor is caught, including the forms a `new Database(` text scan misses and that are
// already present in this tree: the alias (`db/snapshot.ts`'s
// `import { Database as BunDatabase, type Database }`) and the static factory
// (`index/migrated-db-template.ts`'s `Database.deserialize`). A namespace or default import is
// caught for the same reason.
//
// STATED BOUND: this proves the call is PRESENT in the file, never that it happens before the
// open — a text scan cannot order two statements, and a caller could always reach a database
// through a helper in another module. It is the backstop for the failure that actually happened
// (a whole entry point with no call at all), and the primary defense is the same one D27(b) and
// D29(c)/(d) rest on: only these files are ever handed the ability to open a connection.
const D30_INIT = "ensureFullSqlite";
/**
 * One `… from "bun:sqlite"` import statement, clause captured.
 *
 * `[^;]` cannot cross a statement terminator, so a lazy match anchored on the module specifier
 * cannot start at an earlier import and swallow it; `m` anchors the keyword at a line start, and
 * newlines inside the clause are fine because a multi-line import contains no `;`.
 *
 * THAT SEPARATION IS ENFORCED BY BIOME, NOT BY THIS REGEX. It holds because `biome.json` sets
 * `javascript.formatter.semicolons: "always"` and every file in the scanned set is formatted, so a
 * preceding import always ends in `;`. In a semicolon-free tree an `import { Database } from
 * "bun:sqlite"` on one line followed by a type-only import on the next would be captured as one
 * clause, and the value binding would make the pair report a violation. That is the FAIL-SAFE
 * direction — a false positive a reader can see, never a miss — but it is a property of the
 * formatter, and a change to that setting would need this rule revisited.
 */
const D30_IMPORT_RE = /^import\s+([^;]*?)\s*from\s*["']bun:sqlite["']/gm;

/** Does this `bun:sqlite` import clause bind anything at RUNTIME (as opposed to types only)? */
export function bunSqliteImportBindsValue(clause: string): boolean {
  const trimmed = clause.trim();
  // `import type { … } from "bun:sqlite"` — the whole statement is erased.
  if (/^type\b/.test(trimmed)) return false;
  const braces = /\{([\s\S]*)\}/.exec(trimmed);
  // No braces: a default or namespace import (`import sqlite from`, `import * as sqlite from`),
  // both of which hand the caller the constructor.
  if (braces === null) return true;
  // A side-effect-only import (`import "bun:sqlite"`) never reaches here — it has no clause and
  // so no ` from `. Anything before the braces (a default binding) is a value.
  if (trimmed.slice(0, trimmed.indexOf("{")).trim() !== "") return true;
  return (braces[1] ?? "")
    .split(",")
    .map((sp) => sp.trim())
    .filter((sp) => sp !== "")
    .some((sp) => !/^type\s/.test(sp));
}

export function checkSqliteRuntimeInit(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    const code = stripComments(f.contents);
    if (code.includes(D30_INIT)) continue;
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D30_IMPORT_RE.source, "gm"))) {
      if (!bunSqliteImportBindsValue(m[1] ?? "")) continue;
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D30-sqlite-runtime-init",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D31: a file that OPENS a listening socket registers it with the live `ListenerRegistry`
// (`locality/listener-registry.ts`), tied to no invariant, exactly as D30 is not.
//
// `nimbus wow`'s locality panel shows the owner which listeners are open RIGHT NOW and whether
// each is loopback, read live off `processListeners.live()`. That panel is only honest if the
// registry reflects what it claims to — a listen site among the three shapes below, added
// tomorrow with no `registerListener()` call, would make the panel silently incomplete rather than
// visibly broken, the same failure shape D30's `ensureFullSqlite()` gap was.
//
// STATED BOUND: this rule polices exactly the three CALL SHAPES named below, in a GATEWAY-PROCESS
// file (the scan goes by path, so it also covers `platform/sandbox/net-forward-host.ts`, which runs
// in the `__nimbus-sandbox` wrapper rather than the gateway) — it cannot see two other kinds of open socket. One: a socket a LIBRARY opens internally
// (today: `bonjour-service`'s `new Bonjour()` inside `federation/mdns-discovery-provider.ts`,
// which binds UDP 5353 multicast). That registration is by HAND, proven only by its own test, and
// is outside this rule's reach the same way D27(b)'s `media_grant` table confinement and D29(c)'s
// `toolgen.` Vault-key prefix are — capability confinement, not a text scan, is the real defense
// there. Two: a socket a gateway-SPAWNED CHILD PROCESS opens on its own — today,
// `computer-use/cu-lanes/browser-launch.ts` launches Chromium with `--remote-debugging-port=0`
// during a live `nimbus computer` browser session, a real loopback CDP listening socket no
// gateway file itself calls `Bun.serve`/`Bun.listen`/`net.createServer` for, so this rule never
// sees it either. That is why the locality panel's own heading reads "Listeners the gateway has
// open right now:" rather than an unqualified "Listeners" claim.
//
// THE EXEMPTION IS FILE-LEVEL, not call-level — the same granularity as D30's `ensureFullSqlite()`
// check: ONE `registerListener(` call anywhere in a file exempts EVERY `Bun.serve`/`Bun.listen`/
// `net.createServer` call in that same file from this scan, not only the call nearest it.
//
// WRITTEN AS WHAT CANNOT PASS, not as an allow-list of what may — same reasoning as D30: a new
// listen site among the three shapes below is a violation on the day it is written, with nothing
// for anyone to remember to add to a list.
//
// WHAT COUNTS AS "opens a listening socket": `Bun.serve(`, `Bun.listen(` (including a generic
// argument, `Bun.listen<State>(`) and `net.createServer(`. A `typeof Bun.listen<…>` / `typeof
// Bun.serve` TYPE QUERY — the shape `ipc/server/server.ts` carries at
// `ReturnType<typeof Bun.listen<BunSessionData>>` — opens nothing at runtime and must not force a
// registration; it is blanked out (character-for-character, so line numbers of a REAL call later
// in the same file are unaffected) before the main pattern is matched, so a file that carries only
// the type query is clean, and a file that carries BOTH the type query and a real
// `Bun.listen<State>({` call is still caught by the real call once the type query is blanked out
// from under it.
const D31_TYPEOF_QUERY_RE = /\btypeof\s+Bun\.(?:serve|listen)(?:\s*<[^<>]*>)?/g;
const D31_LISTEN_RE = /\bBun\.(?:serve|listen)\b|\bcreateServer\s*\(/g;
// Matches the CALL, anchored on a non-identifier character (or start of text) immediately
// before it — never a bare substring. `unregisterListener` (the handle every one of the five
// sites hands back to its own stop path) CONTAINS "registerListener" as a substring, so an
// earlier `stripped.includes("registerListener")` short-circuited the whole scan for any file
// that merely NAMES an unregister handle, without ever calling `registerListener(` itself —
// `server.ts` passed for the wrong reason (skipped before the `typeof` blanking below ever ran),
// and a future file that stores an unregister handle and opens a socket without registering
// would have been clean too. The negative lookbehind is what rules that out: `(?<!e)` on its own
// would also reject a real call written as `registerListener(` at the very start of a file, so it
// is scoped to identifier characters specifically.
const D31_REGISTER_CALL_RE = /(?<![A-Za-z0-9_$])registerListener\s*\(/;

/** Blank every match of `re` in `text`, replacing non-newline characters with spaces so every
 * later line number (and every later match offset) is unaffected. */
function blankMatches(text: string, re: RegExp): string {
  return text.replace(re, (m) => m.replace(/[^\n]/g, " "));
}

export function checkListenerRegistryConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const stripped = stripComments(f.contents);
    if (D31_REGISTER_CALL_RE.test(stripped)) continue;
    const scanned = blankMatches(stripped, D31_TYPEOF_QUERY_RE);
    const original = f.contents.split("\n");
    for (const m of scanned.matchAll(new RegExp(D31_LISTEN_RE.source, "g"))) {
      const line = scanned.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D31-listener-registry-registration",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
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
  "packages/gateway/src/briefing/briefing-runner.ts", // D45 — the briefing delivers locally only
  "packages/gateway/src/agents/_lib/briefing-build.ts", // D45
  "packages/gateway/src/ipc/lan-legacy.ts", // D47 — the only home of the v1 static-box LAN path
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
  // D22(g) — anchored on the ONE production construction site, a file the rule SCANS (it is on
  // both allow-lists, so it is read and then permitted) rather than `vlm/ollama-vlm.ts`, which the
  // constructor rule skips as its own definition and whose presence would therefore prove nothing.
  // Same shape as the D23 and D22(f) anchors above.
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
  // D28 — anchored on the ONE production file allowed to wear the `fleet` ClientKind, a file the
  // rule SCANS (it is on the allow-list, so it is read and then permitted). NOT client-kind.ts:
  // that file DEFINES the union, and its presence in the scanned set would prove nothing about
  // whether the rule can see the invoker. Same shape as the D23 and D22(f)/(g) anchors above —
  // without an anchor of its own, D28 would report clean while scanning nothing the moment
  // `iterateSourceFiles()` stopped reaching `fleet/`.
  "packages/gateway/src/fleet/fleet-invoker.ts",
  // D28 — second anchor, on `push-runner.ts`: the one file allowed to wear the `push` ClientKind
  // (`kind: "push"`), scanned by the rule and then permitted, so D28 cannot go blind to it.
  "packages/gateway/src/oncall-push/push-runner.ts",
  // D29 (a)/(b)/(c)/(d) — anchored on `toolgen-broker.ts`, a file all four rules SCAN (it names
  // none of `nimbus/fetch`, `buildGeneratedManifest`'s definition, a `toolgen.` vault-key template,
  // or a forbidden saved-tool identifier, so it is read and then reported clean) rather than on any
  // of the DEFINITION/allow-listed sites the rules themselves skip (`toolgen-types.ts`,
  // `toolgen-stub.ts`'s own file is scanned but for a different check, `toolgen-credentials.ts`,
  // `toolgen-saved-store.ts`). Without an anchor of its own, all four D29 rules would report clean
  // while scanning nothing the moment `iterateSourceFiles()` stopped reaching `toolgen/` — the same
  // inert-guard failure mode D23/D28 exist to catch.
  "packages/gateway/src/toolgen/toolgen-broker.ts",
  // D30 — anchored on the embedding worker, the entry point whose absence would be least visible
  // (a separate Bun `Worker` realm with its own connection, and the one that WRITES the vectors)
  // and a file the rule SCANS: it carries a real value-import of `Database`, so the rule has to
  // read it and check the init is there. Not `platform/sqlite-runtime.ts`, which the rule permits
  // by virtue of defining `ensureFullSqlite` and whose presence would therefore prove nothing.
  // Same shape as the D23/D28/D29 anchors above.
  "packages/gateway/src/embedding/embedding-worker.ts",
  // D31 — anchored on one of the six real listen sites, a file the rule SCANS: it carries a real
  // `Bun.serve(` call AND names `registerListener`, so the rule has to read it and confirm the
  // registration is there rather than reporting clean on an empty scan. Not
  // `locality/listener-registry.ts`, which the rule does not exempt by name (D31 has no
  // definition-file allow-list at all, unlike D22(f)/(g) and D29) but which contains no listen
  // call of its own and so would prove nothing about whether the rule can see one. Same shape as
  // the D23/D28/D29/D30 anchors above.
  "packages/gateway/src/ipc/http-server.ts",
  // D32(e)(f)(g) — anchored on capture-gate.ts, which (f) and (g) SCAN (it sits under mcp-sink/ and is
  // not capture-validate.ts) and (e) reads then permits. Without it, both rules would report clean
  // while scanning nothing the moment iterateSourceFiles() stopped loading mcp-sink/.
  "packages/gateway/src/mcp-sink/capture-gate.ts",
  "packages/gateway/src/extensions/approve-run.ts", // D33(b)(c) — scanned; the run-grant store's main caller
  // D34(a)(b)(c) — anchored on the RPC path, which (a) and (b) SCAN (it names neither the table nor
  // the grant entry point) and (c) reads then permits.
  "packages/gateway/src/ipc/migration-rpc.ts",
  // D36 — anchored on the pack RPC, which the rule SCANS (it is not allow-listed) and which sits
  // one call from the store's write half without naming it.
  "packages/gateway/src/ipc/pack-rpc.ts",
  // D37 — anchored on the trust feed module, which the rule SCANS (it is not allow-listed) and which
  // reaches the feed floor only through the store.
  "packages/gateway/src/extensions/trust/trust-feed.ts",
  // D38 — anchored on the eval role, which every clause SCANS: it sits under extensions/eval/ (so
  // (c)(d)(e) read it) and is allow-listed by neither (a) nor (b).
  "packages/gateway/src/extensions/eval/eval-role.ts",
  // D39 — the door itself: clauses (c) and (d) read ONLY this file, so a rule that cannot find it
  // would report clean while checking neither.
  "packages/gateway/src/engine/connector-write-agent-tools.ts",
  // D40 — the before-state module defines the literal and the runner, and (c) reads
  // connectors/registry.ts by name (engine/executor.ts is anchored above, for D22).
  "packages/gateway/src/engine/before-state.ts",
  "packages/gateway/src/connectors/registry.ts",
  // D41 — the act door's wrapper (the one non-executor file that may name the channel method, inside
  // provenanceConsent) and the consent coordinator (which must carry the text and never judge it);
  // engine/executor.ts is anchored above, for D22.
  "packages/gateway/src/ipc/capture-rpc.ts",
  "packages/gateway/src/ipc/consent.ts",
  // D42 — the prepare step (the injection and the `.write.prepare` spelling live there) and the
  // prepare-tool set (which must stay frozen); engine/executor.ts and connectors/registry.ts are
  // anchored above.
  "packages/gateway/src/engine/prepare-step.ts",
  "packages/gateway/src/connectors/connector-writes/prepare-tools.ts",
  // D44 — the check itself, the only store, and the one file that builds a provenance: each rule
  // reads these by name, and a rule that cannot find them would report clean while checking nothing.
  "packages/gateway/src/engine/standing-rule-step.ts",
  "packages/gateway/src/standing/standing-rule-store.ts",
  "packages/gateway/src/automation/workflow-write-step.ts",
  // D24 (work_snapshot-confined, Phase 10 MB1) — the only store and the only capability that names
  // its writer; either moving would leave the rule passing over nothing.
  "packages/gateway/src/index/work-snapshot-store.ts",
  // D24 (chat-read-marker-confined, Phase 10 MB4) — the only store of the marker table; it moving out
  // of the scan would leave the rule passing over nothing (sync-capabilities.ts is anchored above).
  "packages/gateway/src/index/chat-read-marker-store.ts",
  "packages/gateway/src/sync/sync-capabilities.ts",
  // D46(b) (item-history-confined, Phase 10 IC1) — the only writer, its one caller and the retention
  // module; any of them moving out of the scan would leave the rule passing over nothing.
  "packages/gateway/src/index/item-history.ts",
  "packages/gateway/src/index/item-store.ts",
  "packages/gateway/src/index/item-history-retention.ts",
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
        `::error file=${e.file},line=${e.line}::D17 buildConnectorPost/buildConnectorViewsOpen called without its ledgered wrapper (buildLedgeredChatPosts/buildLedgeredConfirmModal) — bypasses the I29 chatops egress ledger: ${e.snippet}`,
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
    const briefingViolations = checkBriefingConfinement(files);
    for (const e of briefingViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D45 the morning briefing reached outside its local sinks (rule ${e.rule}) — no ChatOps/egress/federation/share import, no connectors value import, no network primitive: ${e.snippet}`,
      );
    }
    if (briefingViolations.length > 0) exit = 1;
    const boxViolations = checkLanBoxPathConfinement(files);
    for (const e of boxViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D47 the LAN static-box seal (sealBoxFrame/openBoxFrame/nacl.box) used outside ipc/lan-legacy.ts and ipc/lan-crypto.ts — a record could be sealed under the static identity key, with no forward secrecy (I56): ${e.snippet}`,
      );
    }
    if (boxViolations.length > 0) exit = 1;
    const snapshotViolations = checkWorkSnapshotConfinement(files);
    for (const e of snapshotViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D24 work_snapshot written outside its store (rule work-snapshot-confined) — the replaceWorkSnapshot capability is the only route: ${e.snippet}`,
      );
    }
    if (snapshotViolations.length > 0) exit = 1;
    const markerViolations = checkChatReadMarkerConfinement(files);
    for (const e of markerViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D24 chat_read_marker written outside its store (rule chat-read-marker-confined) — the setChatReadMarkers capability is the only route: ${e.snippet}`,
      );
    }
    if (markerViolations.length > 0) exit = 1;
    const historyViolations = checkItemHistoryConfinement(files);
    for (const e of historyViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(b) item_history written outside its module (rule item-history-confined) — index/item-history.ts is the only writer: ${e.snippet}`,
      );
    }
    if (historyViolations.length > 0) exit = 1;
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
    const fleetKindViolations = checkFleetClientKindConfinement(files);
    for (const e of fleetKindViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D28 fleet ClientKind breach — the unattended-fleet attribution is named outside client-kind.ts/egress-bearing-kinds.ts/fleet-invoker.ts, a second path able to file briefs as fleet work without the scheduler's checks (I38): ${e.snippet}`,
      );
    }
    if (fleetKindViolations.length > 0) exit = 1;
    const pushKindViolations = checkPushClientKindConfinement(files);
    for (const e of pushKindViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D28 push ClientKind breach — the on-call push attribution is named outside client-kind.ts/egress-bearing-kinds.ts/push-runner.ts, a second path able to file briefs as pushed work without the runner's checks: ${e.snippet}`,
      );
    }
    if (pushKindViolations.length > 0) exit = 1;
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
    const v = checkRegistryAppenderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(h) ${e.rule}: recordRegistryEgress outside egress/registry-egress.ts + extensions/registry/registry-fetch.ts, or a bare fetch( under extensions/ outside registry-fetch.ts — an unrecorded registry request; I29 regression: ${e.snippet}`,
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
    const v = checkVlmAppenderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(g) a VlmProvider constructed or wrapped outside egress/vlm-egress.ts + build-media-pass-deps.ts — an unrecorded vision egress path; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkRemoteVlmConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D27(a) a non-local VlmProvider constructed outside build-media-pass-deps.ts, or not wrapped by wrapLedgeredVlm — an ungated remote describe; I37 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkMediaGrantStoreConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D27(b) media_grant reached outside media-grant-store.ts — a caller can synthesise a grant or read around the active-row filter; I37 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkExtensionRoleConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D33(a) the __nimbus-extension role (or selfSpawn("extension")) named outside platform/runtime-layout.ts and extensions/extension-launch-command.ts — an extension entry could be spawned without the sandbox and the run grant: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkRunGrantTableConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D33(b) extension_run_grant reached outside extensions/run-grant-store.ts — a run grant could be created without the owner's extension.run approval: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkRunGrantWriters(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D33(c) a run-grant writer (upsertRunGrant/deleteRunGrant) named outside the store and the approve/revoke path — a run grant could be created or removed without the owner's extension.run approval: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkTrustTableConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D37 trust_statement or trust_feed_state reached outside extensions/trust/trust-store.ts — a trust statement could be stored, or the trust feed's floor moved, without the store's authority and admission checks: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEvalConfinement(files);
    const D38_CLAUSE: Readonly<Record<string, string>> = {
      "eval-spec-builder-confined":
        "(a) buildExtensionEvalSpawnSpec named outside extensions/eval/eval-spawn-spec.ts and eval-runtime.ts",
      "eval-entry-command-confined":
        "(b) extensionEntryCommand named outside extensions/extension-launch-command.ts, extension-runtime.ts and eval/eval-spawn-spec.ts",
      "eval-imports-confined":
        "(c) a module under extensions/eval/ imports from vault/, egress/, ipc/, db/ or engine/executor",
      "eval-no-credentials": "(d) readCredentialEnv named under extensions/eval/",
      "eval-mcp-client-dynamic-only": "(e) @mastra/mcp imported statically under extensions/eval/",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D38${D38_CLAUSE[e.rule] ?? ""} — extension code could run for evaluation with network, credentials or gateway state, or the eval role's one stdout document could be corrupted (I49): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkModelWriteDoor(files);
    const D39_CLAUSE: Readonly<Record<string, string>> = {
      "connector-write-tools-built-outside-door":
        "(a) tools built from the connector-write table outside engine/connector-write-agent-tools.ts",
      "connector-write-executor-read-confined":
        "(b) getAgentRequestConnectorWriteExecutor named outside agent-request-context.ts, run-ask.ts, agent.ts and the door",
      "connector-write-context-field-confined":
        "(b) the request-context field connectorWriteExecutor named outside agent-request-context.ts and run-ask.ts",
      "connector-write-builders-confined":
        "(e) buildConnectorWriteAgentTools named outside agent.ts and the door, or buildModelWriteExecutor outside run-ask.ts, or buildWorkflowWriteExecutor outside run-ask.ts and gateway-main.ts",
      "connector-write-door-names-transport":
        "(c) the door names a connector transport (invokeConnectorWrite, withConnectorSession, createConnectorDispatcher, createConnectorWriteDispatcher or dispatch())",
      "connector-write-door-origin-model": '(d) the door carries no origin: "model"',
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D39${D39_CLAUSE[e.rule] ?? ""} — the model could reach a connector write outside the owner-turn door, or without the no-delegation marker (I53): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkBeforeStateRead(files);
    const D40_CLAUSE: Readonly<Record<string, string>> = {
      "before-read-literal-confined":
        "(a) the .before.read action-type literal outside engine/before-state.ts and connectors/registry.ts",
      "before-state-runner-confined":
        "(b) createBeforeStateRunner named outside engine/before-state.ts and run-ask.ts's buildModelWriteExecutor or newWorkflowWriteExecutor",
      "before-read-guard-present":
        "(c) isBeforeReadActionType no longer called by engine/executor.ts or connectors/registry.ts",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D40${D40_CLAUSE[e.rule] ?? ""} — a before-state read could skip its guard or run on an executor other than the model door's (I53): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkConfirmComparison(files);
    const D41_CLAUSE: Readonly<Record<string, string>> = {
      "confirm-channel-confined":
        "(a) requestConfirmedApproval named outside engine/executor.ts, engine/types.ts and ipc/capture-rpc.ts's provenanceConsent",
      "confirm-coordinator-confined":
        "(a) requestConfirmedConsent named outside engine/executor.ts and ipc/consent.ts",
      "confirm-render-confined":
        "(b) renderConfirmText named outside engine/executor.ts and connectors/connector-writes/confirm.ts",
      "confirm-comparison-confined":
        "(c) a confirmText or .typed comparison outside engine/executor.ts",
      "confirm-order-pinned":
        "(d) the executor's confirm phases are out of order or a Wave 4 write can reach the plain prompt",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D41${D41_CLAUSE[e.rule] ?? ""} — a Wave 4 write could be approved without the owner typing its confirm text, or the typed text could be judged somewhere other than the gate (I53, I20): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = [...checkBoundWrites(files), ...checkBoundCapabilities(files)];
    const D42_CLAUSE: Readonly<Record<string, string>> = {
      "bound-prepare-literal-confined":
        "(a) the .write.prepare action-type literal outside engine/prepare-step.ts",
      "bound-name-confined":
        "(a)/(c) a bound-write name (injectBoundFields, runPrepareStep, isPrepareActionType, isPrepareToolId, renderUnifiedDiff, PREPARE_TOOL_IDS, writeTable, prepareToolIds) outside its files",
      "bound-order-pinned":
        "(b) the executor's prepare phase is out of order, or the injection is called from anywhere but dispatchBoundPhase",
      "bound-seam-not-production":
        "(c) production code passes the write-table or prepare-tool test seam",
      "bound-prepare-set-frozen": "(d) PREPARE_TOOL_IDS is mutable or mutated",
      "bound-public-gate-refuses":
        "(e) the public gate() could bind, or boundRefusal no longer refuses it first",
      "bound-capability-confined":
        "(h) the bound-write capabilities are named or built outside connectors/registry.ts and the executor",
      "bound-capability-calls":
        "(h) a bound-write capability is read or called outside the preflight and prepare phases",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D42${D42_CLAUSE[e.rule] ?? ""} — a bound write could be dispatched with values its own gate-run prepare step did not produce, or a caller could supply them (I54): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkIacDiscard(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D43 (${e.rule}) the gateway-internal discard of an unused change set is named or reachable outside the executor's discard step — a change set could be deleted without the owner's approval, or after a dispatch (I2 exception): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkStandingApprovals(files);
    const D44_CLAUSE: Record<string, string> = {
      "standing-provenance-confined":
        "(a) an owner-workflow provenance is built, or its shape named, outside the workflow write step",
      "standing-tables-confined":
        "(b) a standing-rule table or one of its writers is reached outside the store",
      "standing-step-order-pinned":
        "(c) the standing-rule step is not called once in approvalPhase, after the confirm phase and before a delegate",
      "standing-outcome-confined":
        "(c) a standing_approved outcome is constructed, or the check named, outside the executor and the check",
      "standing-rules-dep-confined":
        "(e) the standing-rule dependencies are handed to an executor other than the workflow write executors",
      "standing-unattended-confined":
        "(d) the unattended executor option, its refusal text or the schedule trigger is used outside its confinement",
      "standing-learning-confined":
        "(f) a learning table, writer or the learning pass is reached outside the suggestion store, the pass and the workflow runner",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D44 ${D44_CLAUSE[e.rule] ?? e.rule} — a write could run with no prompt that a live, owner-approved standing rule does not exactly cover (I55): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkPackLayerWriters(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D36 a pack-layer writer (setPackLayer/removePackLayer) named outside packs/pack-layer-store.ts and packs/pack-install.ts — a role pack could change the owner's config without the owner's pack.install approval (I47): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkConfigReaderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D35 config read outside the layered reader (config/layered-config.ts) — a setting would ignore the active profile: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkMigrationConfinement(files);
    const D34_LETTER: Readonly<Record<string, string>> = {
      "migration-table-confined":
        "(a) connector_migration reached outside extensions/migration/migration-store.ts",
      "migration-grant-callers":
        "(b) approveMigratedExtensionRun named outside approve-run.ts and the migration engine",
      "migration-consent-raisers":
        "(c) the extension.migrate consent (migrationConsentViaGate / EXTENSION_MIGRATE_ACTION_TYPE / createMigrationEngine / the migrationEngine option / the literal) named outside the engine and the RPC path",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D34${D34_LETTER[e.rule] ?? ""} — a connector could be moved to an extension, or its grant written, without the owner's one extension.migrate approval: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const a = checkCaptureTableConfinement(files);
    for (const e of a) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(a) the capture table reached outside mcp-sink/capture-store.ts — I28 regression: ${e.snippet}`,
      );
    }
    const b = checkCaptureGateCallers(files);
    for (const e of b) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(b) a capture gate entry point named outside ipc/capture-rpc.ts — I28 regression: ${e.snippet}`,
      );
    }
    const c = checkCaptureGateImporters(files);
    for (const e of c) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(c) capture-gate.ts value-imported outside ipc/capture-rpc.ts — I28 regression: ${e.snippet}`,
      );
    }
    const d = checkAgentProvenanceWriters(files);
    for (const e of d) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(d) an agent-row writer reached outside the capture accept path — I28 regression: ${e.snippet}`,
      );
    }
    const e = checkActDoorConfinement(files);
    const D32_ACT_DOOR_LETTER: Readonly<Record<string, string>> = {
      "act-door-accept-action": "e) acceptAction named outside capture-act.ts/capture-gate.ts",
      "mcp-sink-no-executor-or-connectors":
        "f) an mcp-sink/ file imports engine/executor.ts or connectors/",
      "mcp-sink-mcptoolid-literal":
        "g) the mcpToolId literal under mcp-sink/ outside capture-validate.ts",
    };
    for (const v of e) {
      console.error(
        `::error file=${v.file},line=${v.line}::D32(${D32_ACT_DOOR_LETTER[v.rule] ?? v.rule} — act door confinement, I28 regression: ${v.snippet}`,
      );
    }
    if (a.length > 0 || b.length > 0 || c.length > 0 || d.length > 0 || e.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkBrokeredFetchLiteralConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D29(a) the nimbus/fetch method literal appears outside toolgen-types.ts — a producer/consumer copy that can drift; I39 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkGeneratedManifestConfinement(files);
    for (const e of v) {
      console.error(
        e.rule === "D29(b)-generated-manifest-network-nonempty"
          ? `::error file=${e.file},line=${e.line}::D29(b) toolgen-stub.ts assigns permissions.network a non-empty literal — a generated tool would spawn with network access; I39 regression: ${e.snippet}`
          : `::error file=${e.file},line=${e.line}::D29(b) buildGeneratedManifest defined outside toolgen-stub.ts — a second, unaudited manifest constructor; I39 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkToolgenVaultKeyConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D29(c) a toolgen. Vault-key prefix composed outside toolgen-credentials.ts — a second producer of the per-host credential keyspace; I39 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkSavedToolAccessorConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D29(d) a saved-tool private accessor/constant is named outside toolgen-saved-store.ts — a second, unverified read path for a saved artifact; I40 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkSqliteRuntimeInit(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D30 a file that can open a SQLite database does not call ensureFullSqlite() (platform/sqlite-runtime.ts). Database.setCustomSQLite is process-wide and only works before the first open, and a Worker is a separate realm — without the call, sqlite-vec cannot load on macOS and this process has no vector search, hybrid ranking or session-memory recall (issue #1029). Add the call before the open; in packages/cli or packages/ui the answer is that no database should be opened there at all: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkListenerRegistryConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D31 a listen site does not register with the live ListenerRegistry (locality/listener-registry.ts). The 'nimbus wow' locality panel reads processListeners.live() to show which listeners are open right now and whether each is loopback — a listen site that never registers makes that panel silently incomplete rather than visibly broken. Call registerListener() right after listen succeeds and unregister on every stop path: ${e.snippet}`,
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
