import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import { getValidCanvaAccessToken } from "../../auth/canva-access-token.ts";
import { getValidFigmaAccessToken } from "../../auth/figma-access-token.ts";
import {
  type GoogleConnectorOAuthServiceId,
  getValidGoogleAccessToken,
  resolveGoogleOAuthVaultKey,
} from "../../auth/google-access-token.ts";
import { getValidHubspotAccessToken } from "../../auth/hubspot-access-token.ts";
import { getValidMendeleyAccessToken } from "../../auth/mendeley-access-token.ts";
import { getValidMicrosoftAccessToken } from "../../auth/microsoft-access-token.ts";
import { getValidMiroAccessToken } from "../../auth/miro-access-token.ts";
import { getValidNotionAccessToken } from "../../auth/notion-access-token.ts";
import { readMicrosoftOAuthScopesForOutlookEnv } from "../../auth/oauth-vault-tokens.ts";
import { getValidSalesforceAuth } from "../../auth/salesforce-access-token.ts";
import { getValidSlackAccessToken } from "../../auth/slack-access-token.ts";
import { getValidWorkdayAccessToken } from "../../auth/workday-access-token.ts";
import { getValidZoomAccessToken } from "../../auth/zoom-access-token.ts";
import { Config } from "../../config.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { stripTrailingSlashes } from "../../string/strip-trailing-slashes.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { connectorSpawn, LAZY_MESH } from "./keys.ts";
import { buildPhase3Servers } from "./phase3-config.ts";
import type { MeshSpawnContext, ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, ctx: MeshSpawnContext): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), ctx.sandboxCwd);
}

export async function ensurePhase3BundleMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.phase3Bundle;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
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
  const ids: GoogleConnectorOAuthServiceId[] = [
    "google_drive",
    "gmail",
    "google_photos",
    "google_meet",
  ];
  for (const id of ids) {
    const resolved = await resolveGoogleOAuthVaultKey(ctx.vault, id);
    if (resolved === null) {
      continue;
    }
    const token = await getValidGoogleAccessToken(ctx.vault, id);
    if (id === "google_drive") {
      googleServers["google_drive"] = wrap(
        {
          ...connectorSpawn("google-drive"),
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
        "google_drive",
        ctx,
      );
    } else if (id === "gmail") {
      googleServers["gmail"] = wrap(
        {
          ...connectorSpawn("gmail"),
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
        "gmail",
        ctx,
      );
    } else if (id === "google_photos") {
      googleServers["google_photos"] = wrap(
        {
          ...connectorSpawn("google-photos"),
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
        "google_photos",
        ctx,
      );
    } else {
      googleServers["google_meet"] = wrap(
        {
          ...connectorSpawn("google-meet"),
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
        "google_meet",
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
            ...connectorSpawn("onedrive"),
            env: extensionProcessEnv({ MICROSOFT_OAUTH_ACCESS_TOKEN: token }),
          },
          "onedrive",
          ctx,
        ),
        outlook: wrap(
          {
            ...connectorSpawn("outlook"),
            env: outlookEnv,
          },
          "outlook",
          ctx,
        ),
        teams: wrap(
          {
            ...connectorSpawn("teams"),
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
            ...connectorSpawn("github"),
            env: extensionProcessEnv({ GITHUB_PAT: pat }),
          },
          "github",
          ctx,
        ),
        github_actions: wrap(
          {
            ...connectorSpawn("github-actions"),
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
            ...connectorSpawn("gitlab"),
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
            ...connectorSpawn("bitbucket"),
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
            ...connectorSpawn("slack"),
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
            ...connectorSpawn("linear"),
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
            ...connectorSpawn("jira"),
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
            ...connectorSpawn("notion"),
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
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Mendeley MCP when `mendeley.oauth` is present and a valid access token can be resolved.
 */
export async function ensureMendeleyMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.mendeley;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "mendeley", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidMendeleyAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-mendeley-${randomUUID()}`,
      servers: {
        mendeley: wrap(
          {
            ...connectorSpawn("mendeley"),
            env: extensionProcessEnv({ MENDELEY_ACCESS_TOKEN: accessToken }),
          },
          "mendeley",
          ctx,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

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
            ...connectorSpawn("confluence"),
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
            ...connectorSpawn("discord"),
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
            ...connectorSpawn("jenkins"),
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
            ...connectorSpawn("circleci"),
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
            ...connectorSpawn("pagerduty"),
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
            ...connectorSpawn("kubernetes"),
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
            ...connectorSpawn("obsidian"),
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

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Zoom MCP when `zoom.oauth` is present and a valid access token can be resolved.
 */
export async function ensureZoomMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.zoom;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "zoom", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidZoomAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-zoom-${randomUUID()}`,
      servers: {
        zoom: wrap(
          {
            ...connectorSpawn("zoom"),
            env: extensionProcessEnv({ ZOOM_TOKEN: accessToken }),
          },
          "zoom",
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
 * Starts HubSpot MCP when `hubspot.oauth` is present and a valid access token can be resolved.
 */
export async function ensureHubspotMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.hubspot;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "hubspot", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidHubspotAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-hubspot-${randomUUID()}`,
      servers: {
        hubspot: wrap(
          {
            ...connectorSpawn("hubspot"),
            env: extensionProcessEnv({ HUBSPOT_TOKEN: accessToken }),
          },
          "hubspot",
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
 * Starts Miro MCP when `miro.oauth` is present and a valid access token can be resolved.
 */
export async function ensureMiroMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.miro;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "miro", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidMiroAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-miro-${randomUUID()}`,
      servers: {
        miro: wrap(
          {
            ...connectorSpawn("miro"),
            env: extensionProcessEnv({ MIRO_TOKEN: accessToken }),
          },
          "miro",
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
 * Starts Canva MCP when `canva.oauth` is present and a valid access token can be resolved.
 */
export async function ensureCanvaMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.canva;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "canva", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidCanvaAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-canva-${randomUUID()}`,
      servers: {
        canva: wrap(
          {
            ...connectorSpawn("canva"),
            env: extensionProcessEnv({ CANVA_TOKEN: accessToken }),
          },
          "canva",
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
 * Starts Figma MCP when BOTH `figma.oauth` (a resolvable access token) AND the
 * non-secret `figma.team_id` are present in the Vault.
 */
export async function ensureFigmaMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.figma;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "figma", "oauth");
  const teamId = (await readConnectorSecret(ctx.vault, "figma", "team_id"))?.trim() ?? "";
  if (raw === null || raw === "" || teamId === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidFigmaAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-figma-${randomUUID()}`,
      servers: {
        figma: wrap(
          {
            ...connectorSpawn("figma"),
            env: extensionProcessEnv({ FIGMA_TOKEN: accessToken, FIGMA_TEAM_ID: teamId }),
          },
          "figma",
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
 * Starts Salesforce MCP when `salesforce.oauth` is present and a valid access
 * token + instance_url can be resolved. The instance_url is a per-tenant API
 * host discovered at OAuth time, so it is added to the sandbox manifest at spawn
 * via the Jenkins-style extra-hosts pattern (direct wrapServerSpec, not wrap()).
 */
export async function ensureSalesforceMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.salesforce;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "salesforce", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  let auth: { accessToken: string; instanceUrl: string };
  try {
    auth = await getValidSalesforceAuth(ctx.vault);
  } catch {
    return;
  }
  if (auth.accessToken === "" || auth.instanceUrl === "") {
    return;
  }
  const sfHost = hostnameFromUrl(auth.instanceUrl);
  const manifest = manifestWithExtraNetworkHosts("salesforce", sfHost === null ? [] : [sfHost]);
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-salesforce-${randomUUID()}`,
      servers: {
        salesforce: wrapServerSpec(
          {
            ...connectorSpawn("salesforce"),
            env: extensionProcessEnv({
              SALESFORCE_ACCESS_TOKEN: auth.accessToken,
              SALESFORCE_INSTANCE_URL: auth.instanceUrl,
            }),
          },
          manifest,
          ctx.sandboxCwd,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * Starts Workday MCP when `workday.oauth` is present, a valid access token can
 * be resolved, and the tenant host + tenant name are configured. The per-tenant
 * host is added to the sandbox manifest at spawn via the Salesforce-style
 * extra-hosts pattern (direct wrapServerSpec, not wrap()).
 */
export async function ensureWorkdayMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.workday;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const raw = await readConnectorSecret(ctx.vault, "workday", "oauth");
  if (raw === null || raw === "") {
    return;
  }
  const tenantHost = Config.workdayTenantHost.trim();
  const tenant = Config.workdayTenant.trim();
  if (tenantHost === "" || tenant === "") {
    return;
  }
  let accessToken: string;
  try {
    accessToken = await getValidWorkdayAccessToken(ctx.vault);
  } catch {
    return;
  }
  if (accessToken === "") {
    return;
  }
  const host = hostnameFromUrl(tenantHost);
  const manifest = manifestWithExtraNetworkHosts("workday", host === null ? [] : [host]);
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-workday-${randomUUID()}`,
      servers: {
        workday: wrapServerSpec(
          {
            ...connectorSpawn("workday"),
            env: extensionProcessEnv({
              WORKDAY_ACCESS_TOKEN: accessToken,
              WORKDAY_TENANT_HOST: tenantHost,
              WORKDAY_TENANT: tenant,
            }),
          },
          manifest,
          ctx.sandboxCwd,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}

/**
 * Starts the iCloud Mail (IMAP/SMTP) + iCloud Calendar (CalDAV) MCP when BOTH
 * `apple.icloud_email` AND `apple.icloud_app_password` are present in the Vault
 * (the single app-specific password authenticates all three protocols). The
 * iCloud IMAP (993) / SMTP (587) hosts are on non-443 ports, so their concrete
 * `imap.mail.me.com:993` / `smtp.mail.me.com:587` host:port entries are added to
 * the sandbox network allow-list at spawn time, mirroring phase3AddImapMcp;
 * `caldav.icloud.com` is declared statically in the apple manifest. (The
 * per-account `p##-caldav.icloud.com` partition host is resolved at runtime
 * inside server.ts; under strict per-host gating CalDAV degrades — see the apple
 * manifest note.)
 */
export async function ensureAppleMcp(ctx: MeshSpawnContext): Promise<void> {
  const slotKey = LAZY_MESH.apple;
  ctx.clearLazyIdle(slotKey);
  if (ctx.getLazyClient(slotKey) !== undefined) {
    ctx.scheduleLazyDisconnect(slotKey);
    return;
  }
  const email = await readConnectorSecret(ctx.vault, "apple", "icloud_email");
  const appPw = await readConnectorSecret(ctx.vault, "apple", "icloud_app_password");
  if (email === null || email === "" || appPw === null || appPw === "") {
    return;
  }
  // iCloud IMAP/SMTP are fixed, non-443 host:port endpoints (993 / 587); add
  // them to the apple manifest's network allow-list at spawn.
  const appleManifest = manifestWithExtraNetworkHosts("apple", [
    "imap.mail.me.com:993",
    "smtp.mail.me.com:587",
  ]);
  ctx.setLazyClient(
    slotKey,
    new MCPClient({
      id: `nimbus-apple-${randomUUID()}`,
      servers: {
        apple: wrapServerSpec(
          {
            ...connectorSpawn("apple"),
            env: extensionProcessEnv({
              APPLE_ICLOUD_EMAIL: email,
              APPLE_ICLOUD_APP_PASSWORD: appPw,
            }),
          },
          appleManifest,
          ctx.sandboxCwd,
        ),
      },
    }),
  );
  ctx.bumpToolsEpoch();
  ctx.scheduleLazyDisconnect(slotKey);
}
