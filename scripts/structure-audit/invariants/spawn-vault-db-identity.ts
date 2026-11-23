// Static invariant rules: D10-D15: spawn env scoping, ServerSpec wrapping, Vault key allow-list, direct db.run/db.exec, federation, identity and team-vault confinement.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { CONNECTOR_VAULT_SECRET_KEYS } from "../../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import { stripComments } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

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

export function escapeRegex(s: string): string {
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
