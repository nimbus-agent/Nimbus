import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import {
  type GoogleConnectorOAuthServiceId,
  getValidGoogleAccessToken,
  resolveGoogleOAuthVaultKey,
} from "../../auth/google-access-token.ts";
import { getValidMicrosoftAccessToken } from "../../auth/microsoft-access-token.ts";
import { getValidNotionAccessToken } from "../../auth/notion-access-token.ts";
import { readMicrosoftOAuthScopesForOutlookEnv } from "../../auth/oauth-vault-tokens.ts";
import { getValidSlackAccessToken } from "../../auth/slack-access-token.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { stripTrailingSlashes } from "../../string/strip-trailing-slashes.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { LAZY_MESH, mcpConnectorServerScript } from "./keys.ts";
import { buildPhase3Servers } from "./phase3-config.ts";
import type { MeshSpawnContext, ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

/**
 * I15 (T2 PR 1) — wrap a first-party ServerSpec via the sandbox-wrapper
 * script using the static `manifestForFirstParty(serviceId)` registry +
 * the context-supplied sandbox cwd. Every `servers: { id: spec }` literal
 * in this file routes through this helper so the I15 enforcement test
 * sees the wiring on every spawn site.
 */
function wrap(spec: ServerSpec, serviceId: string, ctx: MeshSpawnContext): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), ctx.sandboxCwd);
}

/**
 * Starts the Phase 3 MCP bundle (any of AWS / Azure / GCP / IaC / observability) when vault keys are present.
 */
export async function ensurePhase3BundleMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.phase3Bundle;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  // I15 (T2 PR 1) — `buildPhase3Servers` itself wraps each ServerSpec
  // via `wrapServerSpec(...)` before returning, so this call site holds
  // already-sandboxed specs. The `ctx.sandboxCwd` thread-through is
  // load-bearing: a regression that drops it leaves the phase3 servers
  // unwrapped and silently fails the I15 enforcement test.
  const servers = await buildPhase3Servers(ctx.vault, ctx.sandboxCwd);
  if (Object.keys(servers).length === 0) {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-phase3-${randomUUID()}`,
      servers,
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts Google Drive / Gmail / Google Photos MCP subprocesses for which a vault
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * token exists (per-service keys or legacy `google.oauth`). Each server gets its own access token.
 */
export async function ensureGoogleDriveMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.googleBundle;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const googleServers: Record<string, ServerSpec> = {};
  const ids: GoogleConnectorOAuthServiceId[] = ["google_drive", "gmail", "google_photos"];
  for (const id of ids) {
    const resolved = await resolveGoogleOAuthVaultKey(ctx.vault, id);
    if (resolved === null) {
      continue;
    }
    const token = await getValidGoogleAccessToken(ctx.vault, id);
    if (id === "google_drive") {
      googleServers["google_drive"] = wrap(
        {
          command: "bun",
          args: [mcpConnectorServerScript("google-drive")],
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
        "google_drive",
        ctx,
      );
    } else if (id === "gmail") {
      googleServers["gmail"] = wrap(
        {
          command: "bun",
          args: [mcpConnectorServerScript("gmail")],
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
        "gmail",
        ctx,
      );
    } else {
      googleServers["google_photos"] = wrap(
        {
          command: "bun",
          args: [mcpConnectorServerScript("google-photos")],
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
        "google_photos",
        ctx,
      );
    }
  }
  if (Object.keys(googleServers).length === 0) {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-google-${randomUUID()}`,
      servers: googleServers,
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts OneDrive + Outlook + Teams MCP subprocesses when `microsoft.oauth` is present (shared token).
 */
export async function ensureMicrosoftBundleMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.microsoftBundle;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const token = await getValidMicrosoftAccessToken(ctx.vault);
  const outlookScopes = await readMicrosoftOAuthScopesForOutlookEnv(ctx.vault);
  const outlookEnv = extensionProcessEnv({
    MICROSOFT_OAUTH_ACCESS_TOKEN: token,
    ...(outlookScopes === undefined ? {} : { MICROSOFT_OAUTH_SCOPES: outlookScopes }),
  });
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-ms-${randomUUID()}`,
      servers: {
        onedrive: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("onedrive")],
            env: extensionProcessEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: token }),
          },
          "onedrive",
          ctx,
        ),
        outlook: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("outlook")],
            env: outlookEnv,
          },
          "outlook",
          ctx,
        ),
        teams: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("teams")],
            env: extensionProcessEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: token }),
          },
          "teams",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts GitHub MCP when `github.pat` is present in the Vault.
 */
export async function ensureGithubMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.github;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const pat = await readConnectorSecret(ctx.vault, "github", "pat");
  if (pat === null || pat === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-github-${randomUUID()}`,
      servers: {
        github: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("github")],
            env: extensionProcessEnv({ GITHUB_PAT: pat }),
          },
          "github",
          ctx,
        ),
        github_actions: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("github-actions")],
            env: extensionProcessEnv({ GITHUB_PAT: pat }),
          },
          "github_actions",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts GitLab MCP when `gitlab.pat` is present in the Vault.
 */
export async function ensureGitlabMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.gitlab;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const pat = await readConnectorSecret(ctx.vault, "gitlab", "pat");
  if (pat === null || pat === "") {
    return;
  }
  const apiBase = await readConnectorSecret(ctx.vault, "gitlab", "api_base");
  const trimmedBase =
    apiBase !== null && apiBase.trim() !== "" ? stripTrailingSlashes(apiBase) : null;
  const gitlabServerEnv = extensionProcessEnv(
    trimmedBase === null
      ? { GITLAB_PAT: pat }
      : { GITLAB_PAT: pat, GITLAB_API_BASE_URL: trimmedBase },
  );
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-gitlab-${randomUUID()}`,
      servers: {
        gitlab: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("gitlab")],
            env: gitlabServerEnv,
          },
          "gitlab",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts Bitbucket Cloud MCP when `bitbucket.username` + `bitbucket.app_password` exist in the Vault.
 */
export async function ensureBitbucketMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.bitbucket;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const user = await readConnectorSecret(ctx.vault, "bitbucket", "username");
  const pass = await readConnectorSecret(ctx.vault, "bitbucket", "app_password");
  if (user === null || user === "" || pass === null || pass === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-bitbucket-${randomUUID()}`,
      servers: {
        bitbucket: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("bitbucket")],
            env: extensionProcessEnv({
              BITBUCKET_USERNAME: user,
              BITBUCKET_APP_PASSWORD: pass,
            }),
          },
          "bitbucket",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Slack MCP when `slack.oauth` is present in the Vault.
 */
export async function ensureSlackMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.slack;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  let token: string;
  try {
    token = await getValidSlackAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (token === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-slack-${randomUUID()}`,
      servers: {
        slack: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("slack")],
            env: extensionProcessEnv({ SLACK_USER_ACCESS_TOKEN: token }),
          },
          "slack",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Linear MCP when `linear.api_key` is present in the Vault.
 */
export async function ensureLinearMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.linear;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const apiKey = await readConnectorSecret(ctx.vault, "linear", "api_key");
  if (apiKey === null || apiKey === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-linear-${randomUUID()}`,
      servers: {
        linear: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("linear")],
            env: extensionProcessEnv({ LINEAR_API_KEY: apiKey }),
          },
          "linear",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts Jira MCP when `jira.api_token`, `jira.email`, and `jira.base_url` are present in the Vault.
 */
export async function ensureJiraMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.jira;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const token = await readConnectorSecret(ctx.vault, "jira", "api_token");
  const email = await readConnectorSecret(ctx.vault, "jira", "email");
  const baseUrl = await readConnectorSecret(ctx.vault, "jira", "base_url");
  if (
    token === null ||
    token === "" ||
    email === null ||
    email === "" ||
    baseUrl === null ||
    baseUrl === ""
  ) {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-jira-${randomUUID()}`,
      servers: {
        jira: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("jira")],
            env: extensionProcessEnv({
              JIRA_API_TOKEN: token,
              JIRA_EMAIL: email,
              JIRA_BASE_URL: baseUrl,
            }),
          },
          "jira",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Notion MCP when `notion.oauth` is present and a valid access token can be resolved.
 */
export async function ensureNotionMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.notion;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "notion", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidNotionAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-notion-${randomUUID()}`,
      servers: {
        notion: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("notion")],
            env: extensionProcessEnv({ NOTION_ACCESS_TOKEN: accessToken }),
          },
          "notion",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts Confluence MCP when Confluence vault keys are present.
 */
export async function ensureConfluenceMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.confluence;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const token = await readConnectorSecret(ctx.vault, "confluence", "api_token");
  const em = await readConnectorSecret(ctx.vault, "confluence", "email");
  const baseUrl = await readConnectorSecret(ctx.vault, "confluence", "base_url");
  if (
    token === null ||
    token === "" ||
    em === null ||
    em === "" ||
    baseUrl === null ||
    baseUrl === ""
  ) {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-confluence-${randomUUID()}`,
      servers: {
        confluence: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("confluence")],
            env: extensionProcessEnv({
              CONFLUENCE_API_TOKEN: token,
              CONFLUENCE_EMAIL: em,
              CONFLUENCE_BASE_URL: baseUrl,
            }),
          },
          "confluence",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts Discord MCP when `discord.enabled` is `1` and `discord.bot_token` is set (opt-in).
 */
export async function ensureDiscordMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.discord;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const enabled = await readConnectorSecret(ctx.vault, "discord", "enabled");
  const token = await readConnectorSecret(ctx.vault, "discord", "bot_token");
  if (enabled !== "1" || token === null || token === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-discord-${randomUUID()}`,
      servers: {
        discord: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("discord")],
            env: extensionProcessEnv({ DISCORD_BOT_TOKEN: token }),
          },
          "discord",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts Jenkins MCP when `jenkins.base_url`, `jenkins.username`, and `jenkins.api_token` are present in the Vault.
 */
export async function ensureJenkinsMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.jenkins;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const baseRaw = await readConnectorSecret(ctx.vault, "jenkins", "base_url");
  const user = await readConnectorSecret(ctx.vault, "jenkins", "username");
  const token = await readConnectorSecret(ctx.vault, "jenkins", "api_token");
  if (
    baseRaw === null ||
    baseRaw.trim() === "" ||
    user === null ||
    user.trim() === "" ||
    token === null ||
    token.trim() === ""
  ) {
    return;
  }
  const base = stripTrailingSlashes(baseRaw.trim());
  // I15 (T2 PR 1) — Jenkins is always user-configured; extend the static
  // (empty) network list with the hostname parsed from JENKINS_BASE_URL
  // so the sandbox lets the connector reach the user's CI server. If the
  // URL fails to parse we fall through with the base manifest — the
  // sandbox will reject the network call, which is the safe outcome.
  const jenkinsHost = hostnameFromUrl(base);
  const jenkinsManifest = manifestWithExtraNetworkHosts(
    "jenkins",
    jenkinsHost === null ? [] : [jenkinsHost],
  );
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-jenkins-${randomUUID()}`,
      servers: {
        jenkins: wrapServerSpec(
          {
            command: "bun",
            args: [mcpConnectorServerScript("jenkins")],
            env: extensionProcessEnv({
              JENKINS_BASE_URL: base,
              JENKINS_USERNAME: user.trim(),
              JENKINS_API_TOKEN: token.trim(),
            }),
          },
          jenkinsManifest,
          ctx.sandboxCwd,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts CircleCI MCP when `circleci.api_token` is present in the Vault.
 */
export async function ensureCircleciMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.circleci;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const tok = await readConnectorSecret(ctx.vault, "circleci", "api_token");
  if (tok === null || tok.trim() === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-circleci-${randomUUID()}`,
      servers: {
        circleci: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("circleci")],
            env: extensionProcessEnv({ CIRCLECI_API_TOKEN: tok.trim() }),
          },
          "circleci",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts PagerDuty MCP when `pagerduty.api_token` is present in the Vault.
 */
export async function ensurePagerdutyMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.pagerduty;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const tok = await readConnectorSecret(ctx.vault, "pagerduty", "api_token");
  if (tok === null || tok.trim() === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-pagerduty-${randomUUID()}`,
      servers: {
        pagerduty: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("pagerduty")],
            env: extensionProcessEnv({ PAGERDUTY_API_TOKEN: tok.trim() }),
          },
          "pagerduty",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts Kubernetes MCP when `kubernetes.kubeconfig` is set (path to kubeconfig file).
 */
export async function ensureKubernetesMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.kubernetes;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const kc = await readConnectorSecret(ctx.vault, "kubernetes", "kubeconfig");
  if (kc === null || kc.trim() === "") {
    return;
  }
  const ctxRaw = await readConnectorSecret(ctx.vault, "kubernetes", "context");
  const kubeExtra: Record<string, string> = { KUBECONFIG: kc.trim() };
  if (ctxRaw !== null && ctxRaw.trim() !== "") {
    kubeExtra["KUBE_CONTEXT"] = ctxRaw.trim();
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-kubernetes-${randomUUID()}`,
      servers: {
        kubernetes: wrap(
          {
            command: "bun",
            args: [mcpConnectorServerScript("kubernetes")],
            env: extensionProcessEnv(kubeExtra),
          },
          "kubernetes",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts the Obsidian MCP child when `[[filesystem.roots]]` are configured.
 * Obsidian indexing is purely local — the connector reads no vault credentials.
 * Vault paths are passed via `OBSIDIAN_VAULT_PATHS_JSON` (the MCP server then
 * discovers `.obsidian/` markers within those paths itself).
 */
export async function ensureObsidianMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.obsidian;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const vaultPaths = ctx.obsidianVaultPaths ?? [];
  if (vaultPaths.length === 0) {
    return;
  }
  // I15 (T2 PR 1) — Obsidian needs read access to user vault paths
  // (configured via `[[filesystem.roots]]`). Extend the base manifest's
  // `filesystem.read` at spawn time before wrapping. The connector has
  // no network — manifestForFirstParty("obsidian") declares
  // `network: []` and the wrap function preserves that.
  const obsidianBase = manifestForFirstParty("obsidian");
  const obsidianManifest = {
    ...obsidianBase,
    permissions: {
      ...obsidianBase.permissions,
      filesystem: {
        read: [...obsidianBase.permissions.filesystem.read, ...vaultPaths],
        write: [...obsidianBase.permissions.filesystem.write],
      },
    },
  };
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-obsidian-${randomUUID()}`,
      servers: {
        obsidian: wrapServerSpec(
          {
            command: "bun",
            args: [mcpConnectorServerScript("obsidian")],
            env: extensionProcessEnv({ OBSIDIAN_VAULT_PATHS_JSON: JSON.stringify(vaultPaths) }),
          },
          obsidianManifest,
          ctx.sandboxCwd,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}
