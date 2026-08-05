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

const DB_RUN_EXEC_RE = /\b(?:this\.|ctx\.)?db\.(?:run|exec)\s*\(/;
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
    const strippedLines = stripComments(f.contents).split("\n");
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
// `appendEgressEntry` stays inside egress/, and `recordMcpBriefEgress` is named only by its
// definition and its single caller (rule (c), below). Test files are exempt.
const D22_DISPATCH_ALLOWED = "packages/gateway/src/engine/executor.ts";
const D22_DISPATCH_RE = /\bconnectors\.dispatch\b/;
const D22_APPEND_RE = /\bappendEgressEntry\b/;
const D22_APPEND_ALLOWED_PREFIX = "packages/gateway/src/egress/";

// (c) the MCP brief egress chokepoint must be TOTAL: `recordMcpBriefEgress` is CALLED from exactly
// one file. This mirrors (a) — it pins the caller, it does not merely permit an appender. Adding a
// file to an allowlist here would satisfy the checker while dissolving the property it protects.
const D22_MCP_RECORD_RE = /\brecordMcpBriefEgress\b/;
const D22_MCP_RECORD_CALLER = "packages/gateway/src/ipc/agents-rpc.ts";
const D22_MCP_RECORD_DEFINITION = "packages/gateway/src/egress/mcp-brief-egress.ts";

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
        D22_MCP_RECORD_RE.test(line) &&
        f.relPath !== D22_MCP_RECORD_CALLER &&
        f.relPath !== D22_MCP_RECORD_DEFINITION
      ) {
        out.push({
          rule: "D22-mcp-brief-egress",
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

async function run(): Promise<void> {
  const mode = parseArgs(Bun.argv);
  const files = await loadFiles();

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
        `::error file=${e.file},line=${e.line}::D22 egress chokepoint breach (connectors.dispatch outside executor.ts, appendEgressEntry outside egress/, or recordMcpBriefEgress outside agents-rpc.ts) — bypasses I29: ${e.snippet}`,
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
