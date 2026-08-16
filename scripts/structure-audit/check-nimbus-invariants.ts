#!/usr/bin/env bun

import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import { auditOutputPath, iterateSourceFiles, stripComments } from "./lib.ts";

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

const I15_CONSTRUCTS_RE = /\bnew\s+MCPClient\s*\(|Record\s*<\s*string\s*,\s*ServerSpec\s*>/;
const I15_WRAP_RE = /\bwrapServerSpec\s*\(/;

export function checkWrapServerSpecInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith(`${LAZY_MESH_DIR}/`)) continue;
    if (I15_EXEMPT.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents);
    if (!I15_CONSTRUCTS_RE.test(stripped)) continue;
    if (I15_WRAP_RE.test(stripped)) continue;
    const lines = stripped.split("\n");
    let hitLine = 1;
    for (let i = 0; i < lines.length; i++) {
      if (I15_CONSTRUCTS_RE.test(lines[i] as string)) {
        hitLine = i + 1;
        break;
      }
    }
    out.push({
      rule: "D10-wrap-spec",
      file: f.relPath,
      line: hitLine,
      snippet: (lines[hitLine - 1] as string).trim(),
    });
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
// The connector server modules are the tools' DEFINITION home (the `reg("slack_chat_post", …)`
// registration) — exempt, since defining the tool is not the same as invoking it from the gateway.
const CHATOPS_POST_ALLOWED_PREFIXES = [
  "packages/gateway/src/chatops/reply-dispatcher.ts",
  "packages/gateway/src/chatops/transport/",
  "packages/mcp-connectors/slack/src/server.ts",
  "packages/mcp-connectors/teams/src/server.ts",
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
const TRIBAL_KB_WRITE_ALLOWED = [
  "packages/gateway/src/tribal/tribal-write-gate.ts",
  "packages/mcp-connectors/notion/src/server.ts",
  "packages/mcp-connectors/confluence/src/server.ts",
];
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
const CONNECTOR_WRITE_ALLOWED = [
  "packages/gateway/src/connectors/warehouse-write-tools.ts",
  "packages/gateway/src/connectors/gitops-ml-write-tools.ts",
  "packages/gateway/src/connectors/connector-write-transport.ts",
  "packages/gateway/src/connectors/connector-write-dispatch.ts",
  "packages/mcp-connectors/snowflake/src/server.ts",
  "packages/mcp-connectors/tableau/src/server.ts",
  "packages/mcp-connectors/looker/src/server.ts",
  "packages/mcp-connectors/powerbi/src/server.ts",
  "packages/mcp-connectors/monte-carlo/src/server.ts",
  "packages/mcp-connectors/bigeye/src/server.ts",
  "packages/mcp-connectors/argocd/src/server.ts",
  "packages/mcp-connectors/flux/src/server.ts",
  "packages/mcp-connectors/mlflow/src/server.ts",
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
    const v = checkEgressChokepointConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22 egress chokepoint breach (connectors.dispatch outside executor.ts, appendEgressEntry outside egress/, or recordAgentBriefEgress outside agents-rpc.ts) — bypasses I29: ${e.snippet}`,
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
