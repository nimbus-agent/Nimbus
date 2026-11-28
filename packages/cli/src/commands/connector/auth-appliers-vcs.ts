import { stripTrailingSlashes } from "../../lib/strip-trailing-slashes.ts";
import {
  type ConnectorAuthParams,
  firstEnvTrimmed,
  requirePatFromFlagsOrEnv,
  resolveAtlassianSiteCredentials,
} from "./auth-env.ts";

type AtlassianConnectorSiteConfig = {
  readonly emailEnvKeys: readonly string[];
  readonly tokenEnvKeys: readonly string[];
  readonly baseEnvKeys: readonly string[];
  readonly errEmail: string;
  readonly errToken: string;
  readonly errBase: string;
};

const JIRA_CONNECTOR_SITE: AtlassianConnectorSiteConfig = {
  emailEnvKeys: ["NIMBUS_JIRA_EMAIL", "ATLASSIAN_EMAIL"],
  tokenEnvKeys: ["NIMBUS_JIRA_API_TOKEN"],
  baseEnvKeys: ["NIMBUS_JIRA_BASE_URL", "JIRA_BASE_URL"],
  errEmail:
    "Jira requires your Atlassian account email: nimbus connector auth jira --username <email> --token <api_token> --api-base https://your-domain.atlassian.net  (or set NIMBUS_JIRA_EMAIL)",
  errToken:
    "Jira requires an API token: nimbus connector auth jira --username <email> --token <api_token> --api-base <url>  (or set NIMBUS_JIRA_API_TOKEN)",
  errBase:
    "Jira requires the site URL: nimbus connector auth jira ... --api-base https://your-domain.atlassian.net  (or set NIMBUS_JIRA_BASE_URL)",
};

const CONFLUENCE_CONNECTOR_SITE: AtlassianConnectorSiteConfig = {
  emailEnvKeys: ["NIMBUS_CONFLUENCE_EMAIL", "ATLASSIAN_EMAIL"],
  tokenEnvKeys: ["NIMBUS_CONFLUENCE_API_TOKEN"],
  baseEnvKeys: ["NIMBUS_CONFLUENCE_BASE_URL", "CONFLUENCE_BASE_URL"],
  errEmail:
    "Confluence requires your Atlassian account email: nimbus connector auth confluence --username <email> --token <api_token> --api-base https://your-domain.atlassian.net  (or set NIMBUS_CONFLUENCE_EMAIL)",
  errToken:
    "Confluence requires an API token: nimbus connector auth confluence ... (or set NIMBUS_CONFLUENCE_API_TOKEN)",
  errBase:
    "Confluence requires the site URL: ... --api-base https://your-domain.atlassian.net  (or set NIMBUS_CONFLUENCE_BASE_URL)",
};

function applyAtlassianSiteConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
  apiBase: string | undefined,
  site: AtlassianConnectorSiteConfig,
): void {
  const {
    email,
    token: apiTok,
    base,
  } = resolveAtlassianSiteCredentials({
    username,
    token,
    apiBase,
    emailEnvKeys: site.emailEnvKeys,
    tokenEnvKeys: site.tokenEnvKeys,
    baseEnvKeys: site.baseEnvKeys,
    errEmail: site.errEmail,
    errToken: site.errToken,
    errBase: site.errBase,
  });
  p.atlassianEmail = email;
  p.personalAccessToken = apiTok;
  p.apiBaseUrl = base;
}

export function applyLinearConnectorAuth(p: ConnectorAuthParams, token: string | undefined): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_LINEAR_API_KEY"],
    "Linear requires an API key: nimbus connector auth linear --token <key>  (or set NIMBUS_LINEAR_API_KEY)",
  );
}

export function applyGithubConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  apiBase: string | undefined,
): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_GITHUB_PAT"],
    "GitHub requires a PAT: nimbus connector auth github --token <pat>  (or set NIMBUS_GITHUB_PAT in the environment)",
  );
  // A GitHub Enterprise Server base. The gateway validates it (https only, no credentials, ...)
  // before anything is probed or stored, and a re-auth without it returns to github.com.
  if (apiBase !== undefined) {
    p.apiBaseUrl = apiBase;
  }
}

export function applyCircleciConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_CIRCLECI_API_TOKEN", "CIRCLECI_TOKEN"],
    "CircleCI requires an API token: nimbus connector auth circleci --token <token>  (or set NIMBUS_CIRCLECI_API_TOKEN)",
  );
}

export function applyPagerdutyConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_PAGERDUTY_API_TOKEN", "PAGERDUTY_API_TOKEN"],
    "PagerDuty requires an API token: nimbus connector auth pagerduty --token <token> [--username <email>]  (or set NIMBUS_PAGERDUTY_API_TOKEN)",
  );
  // PagerDuty requires the e-mail of a valid user as the `From` header on every incident write.
  // Optional here: without it the connector reads, but acknowledge/resolve/escalate refuse.
  const fromEmail = username?.trim() || firstEnvTrimmed(["NIMBUS_PAGERDUTY_FROM_EMAIL"]);
  if (fromEmail !== "") {
    p.fromEmail = fromEmail;
  }
}

export function applyDiscordConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  enable: boolean | undefined,
): void {
  if (enable !== true) {
    throw new Error(
      "Discord is off by default: nimbus connector auth discord --token <bot_token> --enable  (or set NIMBUS_DISCORD_BOT_TOKEN and pass --enable)",
    );
  }
  p.discordOptIn = true;
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_DISCORD_BOT_TOKEN"],
    "Discord requires a bot token: nimbus connector auth discord --token <bot_token> --enable  (or set NIMBUS_DISCORD_BOT_TOKEN)",
  );
}

export function applyGitlabConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  apiBase: string | undefined,
): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_GITLAB_PAT"],
    "GitLab requires a PAT: nimbus connector auth gitlab --token <pat>  (or set NIMBUS_GITLAB_PAT in the environment)",
  );
  if (apiBase !== undefined) {
    p.apiBaseUrl = apiBase;
  }
}

export function applyBitbucketConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
): void {
  const u =
    username ??
    process.env["NIMBUS_BITBUCKET_EMAIL"]?.trim() ??
    process.env["NIMBUS_BITBUCKET_USERNAME"]?.trim() ??
    process.env["BITBUCKET_USERNAME"]?.trim();
  if (u === undefined || u === "") {
    throw new Error(
      "Bitbucket requires your Atlassian email: nimbus connector auth bitbucket --username <atlassian_email> --token <api_token>  (or set NIMBUS_BITBUCKET_EMAIL)",
    );
  }
  const appPass =
    token ??
    process.env["NIMBUS_BITBUCKET_API_TOKEN"]?.trim() ??
    process.env["NIMBUS_BITBUCKET_APP_PASSWORD"]?.trim();
  if (appPass === undefined || appPass === "") {
    throw new Error(
      "Bitbucket requires an Atlassian API token (app passwords stopped working on 2026-07-28): nimbus connector auth bitbucket --username <atlassian_email> --token <api_token>  (or set NIMBUS_BITBUCKET_API_TOKEN)",
    );
  }
  p.bitbucketUsername = u;
  p.personalAccessToken = appPass;
}

/**
 * An Atlassian cloud id: 36 characters of hex digits and hyphens. The gateway's `isAtlassianCloudId`
 * is the authority and refuses the same values with this message; the CLI repeats it so a typo fails
 * before a request, and imports nothing from the gateway.
 */
function isJiraCloudId(v: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(v);
}

export function applyJiraConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
  apiBase: string | undefined,
  cloudIdFlag: string | undefined,
): void {
  applyAtlassianSiteConnectorAuth(p, token, username, apiBase, JIRA_CONNECTOR_SITE);
  const cloudId = cloudIdFlag?.trim() || firstEnvTrimmed(["NIMBUS_JIRA_CLOUD_ID"]);
  if (cloudId === "") return;
  if (!isJiraCloudId(cloudId)) {
    throw new Error("jira cloudId must be an Atlassian cloud id (a UUID)");
  }
  p.cloudId = cloudId;
}

export function applyConfluenceConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
  apiBase: string | undefined,
): void {
  applyAtlassianSiteConnectorAuth(p, token, username, apiBase, CONFLUENCE_CONNECTOR_SITE);
}

export function applyJenkinsConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
  apiBase: string | undefined,
): void {
  const user = username?.trim() || firstEnvTrimmed(["NIMBUS_JENKINS_USERNAME", "JENKINS_USERNAME"]);
  if (user === "") {
    throw new Error(
      "Jenkins requires --username <user>: nimbus connector auth jenkins --username <user> --token <api_token> --api-base https://ci.example/  (or set NIMBUS_JENKINS_USERNAME)",
    );
  }
  const apiTok =
    token?.trim() || firstEnvTrimmed(["NIMBUS_JENKINS_API_TOKEN", "JENKINS_API_TOKEN"]);
  if (apiTok === "") {
    throw new Error(
      "Jenkins requires an API token: nimbus connector auth jenkins ... --token <api_token>  (or set NIMBUS_JENKINS_API_TOKEN)",
    );
  }
  const baseRaw =
    apiBase?.trim() || firstEnvTrimmed(["NIMBUS_JENKINS_BASE_URL", "JENKINS_BASE_URL"]);
  if (baseRaw === "") {
    throw new Error(
      "Jenkins requires --api-base <url>: nimbus connector auth jenkins ... --api-base https://ci.example/  (or set NIMBUS_JENKINS_BASE_URL)",
    );
  }
  p.username = user;
  p.personalAccessToken = apiTok;
  p.apiBaseUrl = stripTrailingSlashes(baseRaw);
}
