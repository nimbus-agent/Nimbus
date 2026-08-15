import { confirm, isCancel } from "@clack/prompts";

import type { IPCClient } from "../ipc-client/index.ts";
import {
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_ENV_HELP,
  printConnectorAuthHelpPointer,
  printConnectorAuthPatOnlyHelp,
  SLACK_OAUTH_CLIENT_ID_HELP,
} from "../lib/connector-oauth-env-help.ts";
import {
  registerAutoApproveConsentHandler,
  registerConsentPromptHandler,
} from "../lib/interactive-ipc-handlers.ts";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { stripTrailingSlashes } from "../lib/strip-trailing-slashes.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

type SyncStatus = {
  serviceId: string;
  status: string;
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  intervalMs: number;
  itemCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  healthState?: string;
  healthRetryAfterMs?: number | null;
};

type SyncTelemetryEntry = {
  startedAt: number;
  durationMs: number;
  itemsUpserted: number;
  itemsDeleted: number;
  bytesTransferred: number | null;
  hadMore: boolean;
  errorMsg: string | null;
};

type SyncStatusWithTelemetry = SyncStatus & { telemetry?: SyncTelemetryEntry[] };

type ConnectorFlags = {
  rest: string[];
  port?: number;
  scopes?: string[];
  token?: string;
  username?: string;
  apiBase?: string;
  kubeconfig?: string;
  kubeContext?: string;
  full?: boolean;
  enable?: boolean;
  help?: boolean;
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsRegion?: string;
  awsProfile?: string;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientSecret?: string;
  gcpCredentialsJson?: string;
  gcpProjectId?: string;
  sentryOrg?: string;
  sentryUrl?: string;
  newrelicAccountId?: string;
  datadogApiKey?: string;
  datadogAppKey?: string;
  datadogSite?: string;
};

/**
 * Connect, run, disconnect — delegating to the shared `withGatewayIpc`.
 *
 * Kept as a thin local wrapper only because this file has eleven call sites using the
 * positional `(fn, onConnect, timeout)` shape; the lifecycle itself lives in one place
 * now. Anything calling a HITL-gated method MUST pass `onConnect` to register a
 * `consent.request` handler — the Gateway blocks on `consent.respond`, and a client that
 * never answers just times out.
 */
async function withIpc<T>(
  fn: (c: IPCClient) => Promise<T>,
  onConnect?: (c: IPCClient) => void,
  requestTimeoutMs?: number,
): Promise<T> {
  return withGatewayIpc(fn, undefined, {
    ...(onConnect === undefined ? {} : { onConnect }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
}

function relTime(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) {
    return `${String(sec)}s ago`;
  }
  if (sec < 3600) {
    return `${String(Math.floor(sec / 60))}m ago`;
  }
  if (sec < 86400) {
    return `${String(Math.floor(sec / 3600))}h ago`;
  }
  return `${String(Math.floor(sec / 86400))}d ago`;
}

function fmtNextSync(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  const delta = ms - Date.now();
  if (delta <= 0) {
    return "due";
  }
  const sec = Math.floor(delta / 1000);
  if (sec < 60) {
    return `in ${String(sec)}s`;
  }
  if (sec < 3600) {
    return `in ${String(Math.floor(sec / 60))}m`;
  }
  if (sec < 86400) {
    return `in ${String(Math.floor(sec / 3600))}h`;
  }
  return `in ${String(Math.floor(sec / 86400))}d`;
}

function truncateText(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  if (maxLen <= 1) {
    return "…";
  }
  return `${s.slice(0, maxLen - 1)}…`;
}

function takeFlagValue(q: string[], flagLabel: string): string {
  const v = q.shift();
  if (v === undefined) {
    throw new Error(`Missing value for ${flagLabel}`);
  }
  return v;
}

type FlagAction = (queue: string[], target: ConnectorFlags) => void;

function takeTrimmed(q: string[], label: string): string {
  return takeFlagValue(q, label).trim();
}
function takeNonEmptyTrimmed(q: string[], label: string): string {
  const v = takeTrimmed(q, label);
  if (v === "") {
    throw new Error(`Invalid ${label} (empty)`);
  }
  return v;
}
function takePort(q: string[]): number {
  const v = takeFlagValue(q, "--port");
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error("Invalid --port");
  }
  return n;
}
function takeScopes(q: string[]): string[] {
  return takeFlagValue(q, "--scopes")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function makeTrimmedAssign(label: string, key: keyof ConnectorFlags): FlagAction {
  return (q, target) => {
    (target as Record<string, unknown>)[key] = takeTrimmed(q, label);
  };
}

const FLAG_ACTIONS: Readonly<Record<string, FlagAction>> = {
  "--help": (_q, t) => {
    t.help = true;
  },
  "-h": (_q, t) => {
    t.help = true;
  },
  "--port": (q, t) => {
    t.port = takePort(q);
  },
  "-p": (q, t) => {
    t.port = takePort(q);
  },
  "--scopes": (q, t) => {
    t.scopes = takeScopes(q);
  },
  "-s": (q, t) => {
    t.scopes = takeScopes(q);
  },
  "--token": (q, t) => {
    t.token = takeNonEmptyTrimmed(q, "--token");
  },
  "-t": (q, t) => {
    t.token = takeNonEmptyTrimmed(q, "--token");
  },
  "--username": (q, t) => {
    t.username = takeNonEmptyTrimmed(q, "--username");
  },
  "-u": (q, t) => {
    t.username = takeNonEmptyTrimmed(q, "--username");
  },
  "--full": (_q, t) => {
    t.full = true;
  },
  "--force": (_q, t) => {
    t.full = true;
  },
  "--enable": (_q, t) => {
    t.enable = true;
  },
  "--api-base": (q, t) => {
    t.apiBase = stripTrailingSlashes(takeNonEmptyTrimmed(q, "--api-base"));
  },
  "--kubeconfig": (q, t) => {
    t.kubeconfig = takeNonEmptyTrimmed(q, "--kubeconfig");
  },
  "--context": (q, t) => {
    t.kubeContext = takeNonEmptyTrimmed(q, "--context");
  },
  "--aws-access-key": makeTrimmedAssign("--aws-access-key", "awsAccessKey"),
  "--aws-secret-key": makeTrimmedAssign("--aws-secret-key", "awsSecretKey"),
  "--aws-region": makeTrimmedAssign("--aws-region", "awsRegion"),
  "--aws-profile": makeTrimmedAssign("--aws-profile", "awsProfile"),
  "--azure-tenant-id": makeTrimmedAssign("--azure-tenant-id", "azureTenantId"),
  "--azure-client-id": makeTrimmedAssign("--azure-client-id", "azureClientId"),
  "--azure-client-secret": makeTrimmedAssign("--azure-client-secret", "azureClientSecret"),
  "--gcp-credentials-json": makeTrimmedAssign("--gcp-credentials-json", "gcpCredentialsJson"),
  "--gcp-project-id": makeTrimmedAssign("--gcp-project-id", "gcpProjectId"),
  "--sentry-org": makeTrimmedAssign("--sentry-org", "sentryOrg"),
  "--sentry-url": makeTrimmedAssign("--sentry-url", "sentryUrl"),
  "--newrelic-account-id": makeTrimmedAssign("--newrelic-account-id", "newrelicAccountId"),
  "--datadog-api-key": makeTrimmedAssign("--datadog-api-key", "datadogApiKey"),
  "--datadog-app-key": makeTrimmedAssign("--datadog-app-key", "datadogAppKey"),
  "--datadog-site": makeTrimmedAssign("--datadog-site", "datadogSite"),
};

function parseFlags(args: string[]): ConnectorFlags {
  const out: ConnectorFlags = { rest: [] };
  const q = [...args];
  while (q.length > 0) {
    const a = q.shift();
    if (a === undefined) {
      break;
    }
    const action = FLAG_ACTIONS[a];
    if (action === undefined) {
      out.rest.push(a);
    } else {
      action(q, out);
    }
  }
  return out;
}

function printConnectorAuthServiceHelp(normalized: string): void {
  switch (normalized) {
    case "google_drive":
    case "gmail":
    case "google_photos":
    case "google_meet":
      console.log(GOOGLE_OAUTH_CLIENT_ID_HELP);
      return;
    case "onedrive":
    case "outlook":
    case "teams":
      console.log(MICROSOFT_OAUTH_CLIENT_ID_HELP);
      return;
    case "slack":
      console.log(SLACK_OAUTH_CLIENT_ID_HELP);
      return;
    case "notion":
      console.log(NOTION_OAUTH_ENV_HELP);
      return;
    default:
      printConnectorAuthPatOnlyHelp(normalized);
  }
}

function padField(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function repeatChar(ch: string, n: number): string {
  return ch.repeat(Math.max(0, n));
}

function firstEnvTrimmed(keys: readonly string[]): string {
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (v !== undefined && v !== "") {
      return v;
    }
  }
  return "";
}

function resolveAtlassianSiteCredentials(opts: {
  username: string | undefined;
  token: string | undefined;
  apiBase: string | undefined;
  emailEnvKeys: readonly string[];
  tokenEnvKeys: readonly string[];
  baseEnvKeys: readonly string[];
  errEmail: string;
  errToken: string;
  errBase: string;
}): { email: string; token: string; base: string } {
  const mail = opts.username?.trim() || firstEnvTrimmed(opts.emailEnvKeys);
  if (mail === "") {
    throw new Error(opts.errEmail);
  }
  const apiTok = opts.token?.trim() || firstEnvTrimmed(opts.tokenEnvKeys);
  if (apiTok === "") {
    throw new Error(opts.errToken);
  }
  const baseRaw = opts.apiBase?.trim() || firstEnvTrimmed(opts.baseEnvKeys);
  if (baseRaw === "") {
    throw new Error(opts.errBase);
  }
  return { email: mail, token: apiTok, base: stripTrailingSlashes(baseRaw) };
}

function requirePatFromFlagsOrEnv(
  token: string | undefined,
  envKeys: readonly string[],
  errMsg: string,
): string {
  const pat = token?.trim() || firstEnvTrimmed(envKeys);
  if (pat === "") {
    throw new Error(errMsg);
  }
  return pat;
}

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

type ConnectorAuthParams = {
  service: string;
  port?: number;
  scopes?: string[];
  personalAccessToken?: string;
  bitbucketUsername?: string;
  username?: string;
  atlassianEmail?: string;
  apiBaseUrl?: string;
  kubeconfigPath?: string;
  context?: string;
  discordOptIn?: boolean;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsDefaultRegion?: string;
  awsProfile?: string;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientSecret?: string;
  gcpCredentialsJsonPath?: string;
  gcpProjectId?: string;
  iacOptIn?: boolean;
  sentryOrgSlug?: string;
  sentryUrl?: string;
  newrelicAccountId?: string;
  datadogApiKey?: string;
  datadogAppKey?: string;
  datadogSite?: string;
};

function applyLinearConnectorAuth(p: ConnectorAuthParams, token: string | undefined): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_LINEAR_API_KEY"],
    "Linear requires an API key: nimbus connector auth linear --token <key>  (or set NIMBUS_LINEAR_API_KEY)",
  );
}

function applyGithubConnectorAuth(p: ConnectorAuthParams, token: string | undefined): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_GITHUB_PAT"],
    "GitHub requires a PAT: nimbus connector auth github --token <pat>  (or set NIMBUS_GITHUB_PAT in the environment)",
  );
}

function applyCircleciConnectorAuth(p: ConnectorAuthParams, token: string | undefined): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_CIRCLECI_API_TOKEN", "CIRCLECI_TOKEN"],
    "CircleCI requires an API token: nimbus connector auth circleci --token <token>  (or set NIMBUS_CIRCLECI_API_TOKEN)",
  );
}

function applyPagerdutyConnectorAuth(p: ConnectorAuthParams, token: string | undefined): void {
  p.personalAccessToken = requirePatFromFlagsOrEnv(
    token,
    ["NIMBUS_PAGERDUTY_API_TOKEN", "PAGERDUTY_API_TOKEN"],
    "PagerDuty requires an API token: nimbus connector auth pagerduty --token <token>  (or set NIMBUS_PAGERDUTY_API_TOKEN)",
  );
}

function applyAwsConnectorAuth(
  p: ConnectorAuthParams,
  flags: {
    awsAccessKey?: string;
    awsSecretKey?: string;
    awsRegion?: string;
    awsProfile?: string;
  },
): void {
  const ak =
    flags.awsAccessKey?.trim() ||
    firstEnvTrimmed(["NIMBUS_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"]);
  const sk =
    flags.awsSecretKey?.trim() ||
    firstEnvTrimmed(["NIMBUS_AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"]);
  const reg =
    flags.awsRegion?.trim() || firstEnvTrimmed(["NIMBUS_AWS_DEFAULT_REGION", "AWS_DEFAULT_REGION"]);
  const prof = flags.awsProfile?.trim() || firstEnvTrimmed(["NIMBUS_AWS_PROFILE", "AWS_PROFILE"]);
  const hasKeyPair = ak !== "" && sk !== "";
  if (hasKeyPair) {
    if (reg === "" && prof === "") {
      throw new Error(
        "AWS key pair requires --aws-region <r> or --aws-profile <p> (or set NIMBUS_AWS_DEFAULT_REGION / NIMBUS_AWS_PROFILE)",
      );
    }
    p.awsAccessKeyId = ak;
    p.awsSecretAccessKey = sk;
    if (reg !== "") {
      p.awsDefaultRegion = reg;
    }
    if (prof !== "") {
      p.awsProfile = prof;
    }
  } else {
    if (prof === "") {
      throw new Error(
        "AWS: use --aws-access-key + --aws-secret-key + region/profile, or --aws-profile only (or set env vars)",
      );
    }
    p.awsProfile = prof;
  }
}

function applyAzureConnectorAuth(
  p: ConnectorAuthParams,
  flags: {
    azureTenantId?: string;
    azureClientId?: string;
    azureClientSecret?: string;
  },
): void {
  const tenant =
    flags.azureTenantId?.trim() || firstEnvTrimmed(["NIMBUS_AZURE_TENANT_ID", "AZURE_TENANT_ID"]);
  const cid =
    flags.azureClientId?.trim() || firstEnvTrimmed(["NIMBUS_AZURE_CLIENT_ID", "AZURE_CLIENT_ID"]);
  const sec =
    flags.azureClientSecret?.trim() ||
    firstEnvTrimmed(["NIMBUS_AZURE_CLIENT_SECRET", "AZURE_CLIENT_SECRET"]);
  if (tenant === "" || cid === "" || sec === "") {
    throw new Error(
      "Azure requires tenant id, client id, and client secret (flags --azure-tenant-id, --azure-client-id, --azure-client-secret or env AZURE_*)",
    );
  }
  p.azureTenantId = tenant;
  p.azureClientId = cid;
  p.azureClientSecret = sec;
}

function applyGcpConnectorAuth(
  p: ConnectorAuthParams,
  flags: { gcpCredentialsJson?: string; gcpProjectId?: string },
): void {
  const pathRaw =
    flags.gcpCredentialsJson?.trim() ||
    firstEnvTrimmed(["NIMBUS_GCP_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS"]);
  if (pathRaw === "") {
    throw new Error(
      "GCP requires --gcp-credentials-json <path> (or set GOOGLE_APPLICATION_CREDENTIALS / NIMBUS_GCP_CREDENTIALS_JSON)",
    );
  }
  p.gcpCredentialsJsonPath = pathRaw;
  const proj =
    flags.gcpProjectId?.trim() ||
    firstEnvTrimmed(["NIMBUS_GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT"]);
  if (proj !== "") {
    p.gcpProjectId = proj;
  }
}

function applyIacConnectorAuth(p: ConnectorAuthParams, enable: boolean | undefined): void {
  if (enable !== true) {
    throw new Error("IaC connector is opt-in: nimbus connector auth iac --enable");
  }
  p.iacOptIn = true;
}

function applyGrafanaConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  apiBase: string | undefined,
): void {
  const base = apiBase?.trim() || firstEnvTrimmed(["NIMBUS_GRAFANA_URL", "GRAFANA_URL"]);
  const tok = token?.trim() || firstEnvTrimmed(["NIMBUS_GRAFANA_API_TOKEN", "GRAFANA_API_TOKEN"]);
  if (base === "") {
    throw new Error(
      "Grafana requires base URL: nimbus connector auth grafana --api-base https://grafana.example/ --token <api_token>",
    );
  }
  if (tok === "") {
    throw new Error("Grafana requires an API token (--token or NIMBUS_GRAFANA_API_TOKEN)");
  }
  p.apiBaseUrl = stripTrailingSlashes(base);
  p.personalAccessToken = tok;
}

function applySentryConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  flags: { sentryOrg?: string; sentryUrl?: string },
): void {
  const tok = token?.trim() || firstEnvTrimmed(["NIMBUS_SENTRY_AUTH_TOKEN", "SENTRY_AUTH_TOKEN"]);
  const org = flags.sentryOrg?.trim() || firstEnvTrimmed(["NIMBUS_SENTRY_ORG", "SENTRY_ORG"]);
  if (tok === "" || org === "") {
    throw new Error(
      "Sentry requires --token and --sentry-org <slug> (or env NIMBUS_SENTRY_AUTH_TOKEN / NIMBUS_SENTRY_ORG)",
    );
  }
  p.personalAccessToken = tok;
  p.sentryOrgSlug = org;
  const surl = flags.sentryUrl?.trim() || firstEnvTrimmed(["NIMBUS_SENTRY_URL"]);
  if (surl !== "") {
    p.sentryUrl = stripTrailingSlashes(surl);
  }
}

function applyNewrelicConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  flags: { newrelicAccountId?: string },
): void {
  const tok = token?.trim() || firstEnvTrimmed(["NIMBUS_NEW_RELIC_API_KEY", "NEW_RELIC_API_KEY"]);
  if (tok === "") {
    throw new Error("New Relic requires --token (or NIMBUS_NEW_RELIC_API_KEY / NEW_RELIC_API_KEY)");
  }
  p.personalAccessToken = tok;
  const acct = flags.newrelicAccountId?.trim() || firstEnvTrimmed(["NIMBUS_NEW_RELIC_ACCOUNT_ID"]);
  if (acct !== "") {
    p.newrelicAccountId = acct;
  }
}

function applyDatadogConnectorAuth(
  p: ConnectorAuthParams,
  flags: {
    datadogApiKey?: string;
    datadogAppKey?: string;
    datadogSite?: string;
  },
): void {
  const api =
    flags.datadogApiKey?.trim() || firstEnvTrimmed(["NIMBUS_DATADOG_API_KEY", "DD_API_KEY"]);
  const app =
    flags.datadogAppKey?.trim() || firstEnvTrimmed(["NIMBUS_DATADOG_APP_KEY", "DD_APP_KEY"]);
  if (api === "" || app === "") {
    throw new Error(
      "Datadog requires --datadog-api-key and --datadog-app-key (or DD_API_KEY / DD_APP_KEY)",
    );
  }
  p.datadogApiKey = api;
  p.datadogAppKey = app;
  const site = flags.datadogSite?.trim() || firstEnvTrimmed(["NIMBUS_DATADOG_SITE", "DD_SITE"]);
  if (site !== "") {
    p.datadogSite = site;
  }
}

function applyKubernetesConnectorAuth(
  p: ConnectorAuthParams,
  kubeconfig: string | undefined,
  context: string | undefined,
): void {
  const pathRaw = kubeconfig?.trim() || firstEnvTrimmed(["NIMBUS_KUBECONFIG", "KUBECONFIG"]);
  if (pathRaw === "") {
    throw new Error(
      "Kubernetes requires --kubeconfig <path> or env NIMBUS_KUBECONFIG / KUBECONFIG (vault key kubernetes.kubeconfig)",
    );
  }
  p.kubeconfigPath = pathRaw;
  if (context !== undefined && context.trim() !== "") {
    p.context = context.trim();
  }
}

function applyDiscordConnectorAuth(
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

function applyGitlabConnectorAuth(
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

function applyBitbucketConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
): void {
  const u =
    username ??
    process.env["NIMBUS_BITBUCKET_USERNAME"]?.trim() ??
    process.env["BITBUCKET_USERNAME"]?.trim();
  if (u === undefined || u === "") {
    throw new Error(
      "Bitbucket requires username: nimbus connector auth bitbucket --username <atlassian_username> --token <app_password>  (or set NIMBUS_BITBUCKET_USERNAME)",
    );
  }
  const appPass = token ?? process.env["NIMBUS_BITBUCKET_APP_PASSWORD"]?.trim();
  if (appPass === undefined || appPass === "") {
    throw new Error(
      "Bitbucket requires an app password: nimbus connector auth bitbucket --username ... --token <app_password>  (or set NIMBUS_BITBUCKET_APP_PASSWORD)",
    );
  }
  p.bitbucketUsername = u;
  p.personalAccessToken = appPass;
}

function applyJiraConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
  apiBase: string | undefined,
): void {
  applyAtlassianSiteConnectorAuth(p, token, username, apiBase, JIRA_CONNECTOR_SITE);
}

function applyConfluenceConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  username: string | undefined,
  apiBase: string | undefined,
): void {
  applyAtlassianSiteConnectorAuth(p, token, username, apiBase, CONFLUENCE_CONNECTOR_SITE);
}

function applyJenkinsConnectorAuth(
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

type ConnectorPatAuthParamApplier = (p: ConnectorAuthParams, f: ConnectorFlags) => void;

const CONNECTOR_AUTH_PARAM_APPLIERS: Record<string, ConnectorPatAuthParamApplier> = {
  linear: (p, f) => applyLinearConnectorAuth(p, f.token),
  github: (p, f) => applyGithubConnectorAuth(p, f.token),
  circleci: (p, f) => applyCircleciConnectorAuth(p, f.token),
  pagerduty: (p, f) => applyPagerdutyConnectorAuth(p, f.token),
  kubernetes: (p, f) => applyKubernetesConnectorAuth(p, f.kubeconfig, f.kubeContext),
  aws: (p, f) => {
    const awsFlags: {
      awsAccessKey?: string;
      awsSecretKey?: string;
      awsRegion?: string;
      awsProfile?: string;
    } = {};
    if (f.awsAccessKey !== undefined) {
      awsFlags.awsAccessKey = f.awsAccessKey;
    }
    if (f.awsSecretKey !== undefined) {
      awsFlags.awsSecretKey = f.awsSecretKey;
    }
    if (f.awsRegion !== undefined) {
      awsFlags.awsRegion = f.awsRegion;
    }
    if (f.awsProfile !== undefined) {
      awsFlags.awsProfile = f.awsProfile;
    }
    applyAwsConnectorAuth(p, awsFlags);
  },
  azure: (p, f) => {
    const azFlags: {
      azureTenantId?: string;
      azureClientId?: string;
      azureClientSecret?: string;
    } = {};
    if (f.azureTenantId !== undefined) {
      azFlags.azureTenantId = f.azureTenantId;
    }
    if (f.azureClientId !== undefined) {
      azFlags.azureClientId = f.azureClientId;
    }
    if (f.azureClientSecret !== undefined) {
      azFlags.azureClientSecret = f.azureClientSecret;
    }
    applyAzureConnectorAuth(p, azFlags);
  },
  gcp: (p, f) => {
    const gcpFlags: { gcpCredentialsJson?: string; gcpProjectId?: string } = {};
    if (f.gcpCredentialsJson !== undefined) {
      gcpFlags.gcpCredentialsJson = f.gcpCredentialsJson;
    }
    if (f.gcpProjectId !== undefined) {
      gcpFlags.gcpProjectId = f.gcpProjectId;
    }
    applyGcpConnectorAuth(p, gcpFlags);
  },
  iac: (p, f) => applyIacConnectorAuth(p, f.enable),
  grafana: (p, f) => applyGrafanaConnectorAuth(p, f.token, f.apiBase),
  sentry: (p, f) => {
    const seFlags: { sentryOrg?: string; sentryUrl?: string } = {};
    if (f.sentryOrg !== undefined) {
      seFlags.sentryOrg = f.sentryOrg;
    }
    if (f.sentryUrl !== undefined) {
      seFlags.sentryUrl = f.sentryUrl;
    }
    applySentryConnectorAuth(p, f.token, seFlags);
  },
  newrelic: (p, f) => {
    const nrFlags: { newrelicAccountId?: string } = {};
    if (f.newrelicAccountId !== undefined) {
      nrFlags.newrelicAccountId = f.newrelicAccountId;
    }
    applyNewrelicConnectorAuth(p, f.token, nrFlags);
  },
  datadog: (p, f) => {
    const ddFlags: {
      datadogApiKey?: string;
      datadogAppKey?: string;
      datadogSite?: string;
    } = {};
    if (f.datadogApiKey !== undefined) {
      ddFlags.datadogApiKey = f.datadogApiKey;
    }
    if (f.datadogAppKey !== undefined) {
      ddFlags.datadogAppKey = f.datadogAppKey;
    }
    if (f.datadogSite !== undefined) {
      ddFlags.datadogSite = f.datadogSite;
    }
    applyDatadogConnectorAuth(p, ddFlags);
  },
  gitlab: (p, f) => applyGitlabConnectorAuth(p, f.token, f.apiBase),
  bitbucket: (p, f) => applyBitbucketConnectorAuth(p, f.token, f.username),
  discord: (p, f) => applyDiscordConnectorAuth(p, f.token, f.enable),
  jira: (p, f) => applyJiraConnectorAuth(p, f.token, f.username, f.apiBase),
  confluence: (p, f) => applyConfluenceConnectorAuth(p, f.token, f.username, f.apiBase),
  jenkins: (p, f) => applyJenkinsConnectorAuth(p, f.token, f.username, f.apiBase),
};

function applyConnectorAuthParamsForService(
  normalized: string,
  params: ConnectorAuthParams,
  f: ConnectorFlags,
): void {
  const applier = CONNECTOR_AUTH_PARAM_APPLIERS[normalized];
  if (applier !== undefined) {
    applier(params, f);
  }
}

async function runConnectorAuth(tail: string[]): Promise<void> {
  const f = parseFlags(tail);
  const service = f.rest[0];

  if (f.help === true) {
    if (service === undefined) {
      printConnectorAuthHelpPointer();
      return;
    }
    const normalizedHelp = service.trim().toLowerCase().replaceAll("-", "_");
    printConnectorAuthServiceHelp(normalizedHelp);
    return;
  }

  if (service === undefined) {
    throw new Error(
      "Usage: nimbus connector auth <service> [--port <n>] [--scopes a,b] [--token <pat>] [--username <u>] [--api-base <url>] [--enable] [--help]",
    );
  }
  const params: ConnectorAuthParams = { service };
  if (f.port !== undefined) {
    params.port = f.port;
  }
  if (f.scopes !== undefined) {
    params.scopes = f.scopes;
  }
  const normalized = service.trim().toLowerCase().replaceAll("-", "_");
  applyConnectorAuthParamsForService(normalized, params, f);
  const res = await withIpc((c) =>
    c.call<{
      ok: boolean;
      serviceId: string;
      scopesGranted: string[];
      verified?: "verified" | "unverified" | null;
    }>("connector.auth", params),
  );
  // Report only what was actually checked. "Signed in" claimed more than the
  // command ever verified — for the connectors with no probe it would keep
  // claiming it.
  if (res.verified === "verified") {
    console.log(`Verified: ${res.serviceId}`);
  } else if (res.verified === "unverified") {
    console.log(`Stored: ${res.serviceId} (NOT verified — the provider did not confirm it)`);
    console.log(`Run \`nimbus connector auth ${res.serviceId}\` again to retry verification.`);
  } else {
    console.log(`Stored: ${res.serviceId} (not verified)`);
  }
  const vaultPatServices = new Set([
    "github",
    "gitlab",
    "bitbucket",
    "linear",
    "jira",
    "confluence",
    "discord",
    "jenkins",
    "circleci",
    "pagerduty",
    "kubernetes",
    "aws",
    "azure",
    "gcp",
    "iac",
    "grafana",
    "sentry",
    "newrelic",
    "datadog",
  ]);
  if (vaultPatServices.has(res.serviceId)) {
    console.log("Credential: stored in the OS vault (no OAuth scopes).");
  } else {
    console.log(`Scopes: ${res.scopesGranted.join(", ")}`);
  }
}

function fmtHealthRetry(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "—";
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return "—";
  }
  return d.toISOString();
}

async function runConnectorList(opts: { json?: boolean } = {}): Promise<void> {
  const rows = await withIpc((c) => c.call<SyncStatus[]>("connector.listStatus"));
  if (opts.json === true) {
    // Raw `connector.listStatus` array, unwrapped — the `nimbus query --json` convention. An empty
    // registry is `[]`, never the human "No connectors registered yet" line.
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No connectors registered yet. Use: nimbus connector auth <service>");
    return;
  }
  const errCap = 40;
  const wService = Math.max(10, "SERVICE".length, ...rows.map((r) => r.serviceId.length));
  const wStatus = Math.max(8, "STATUS".length, ...rows.map((r) => r.status.length));
  const wHealth = Math.max(8, "HEALTH".length, ...rows.map((r) => (r.healthState ?? "—").length));
  const wRetry = Math.max(
    14,
    "RETRY·AFTER·(UTC)".length,
    ...rows.map((r) => fmtHealthRetry(r.healthRetryAfterMs).length),
  );
  const wLast = Math.max(10, "LAST SYNC".length, ...rows.map((r) => relTime(r.lastSyncAt).length));
  const wNext = Math.max(
    10,
    "NEXT SYNC".length,
    ...rows.map((r) => fmtNextSync(r.nextSyncAt).length),
  );
  const wItems = Math.max(5, "ITEMS".length, ...rows.map((r) => String(r.itemCount).length));
  const wFail = Math.max(
    4,
    "FAIL".length,
    ...rows.map((r) => String(r.consecutiveFailures).length),
  );

  const head = `${padField("SERVICE", wService)}  ${padField("STATUS", wStatus)}  ${padField("HEALTH", wHealth)}  ${padField("RETRY·AFTER·(UTC)", wRetry)}  ${padField("LAST SYNC", wLast)}  ${padField("NEXT SYNC", wNext)}  ${padField("ITEMS", wItems)}  ${padField("FAIL", wFail)}  ERROR`;
  const ruleLen = head.length + errCap;
  console.log(head);
  console.log(repeatChar("─", ruleLen));
  for (const r of rows) {
    const errRaw = r.lastError ?? "—";
    const err = truncateText(errRaw, errCap);
    const h = r.healthState ?? "—";
    const ra = fmtHealthRetry(r.healthRetryAfterMs);
    const line = `${padField(r.serviceId, wService)}  ${padField(r.status, wStatus)}  ${padField(h, wHealth)}  ${padField(ra, wRetry)}  ${padField(relTime(r.lastSyncAt), wLast)}  ${padField(fmtNextSync(r.nextSyncAt), wNext)}  ${padField(String(r.itemCount), wItems)}  ${padField(String(r.consecutiveFailures), wFail)}  ${err}`;
    console.log(line);
  }
}

async function runConnectorPause(service: string): Promise<void> {
  await withIpc((c) => c.call("connector.pause", { serviceId: service }));
  console.log(`Paused: ${service}`);
}

async function runConnectorResume(service: string): Promise<void> {
  await withIpc((c) => c.call("connector.resume", { serviceId: service }));
  console.log(`Resumed: ${service}`);
}

function parseStatusArgs(tail: string[]): { service: string; stats: boolean } {
  let stats = false;
  const rest: string[] = [];
  for (const a of tail) {
    if (a === "--stats") {
      stats = true;
    } else {
      rest.push(a);
    }
  }
  const service = rest[0];
  if (service === undefined) {
    throw new Error("Usage: nimbus connector status <service> [--stats]");
  }
  return { service, stats };
}

async function runConnectorStatusParsed(service: string, stats: boolean): Promise<void> {
  const params: { serviceId: string; includeStats?: boolean } = { serviceId: service };
  if (stats) {
    params.includeStats = true;
  }
  const row = await withIpc((c) => c.call<SyncStatusWithTelemetry>("connector.status", params));
  console.log(JSON.stringify(row, null, 2));
}

async function runConnectorLifecycle(sub: string, tail: string[]): Promise<void> {
  if (sub === "status") {
    const { service, stats } = parseStatusArgs(tail);
    await runConnectorStatusParsed(service, stats);
    return;
  }
  const service = tail[0];
  if (service === undefined) {
    throw new Error(`Usage: nimbus connector ${sub} <service>`);
  }
  if (sub === "pause") {
    await runConnectorPause(service);
    return;
  }
  if (sub === "resume") {
    await runConnectorResume(service);
  }
}

async function runConnectorSetInterval(tail: string[]): Promise<void> {
  const service = tail[0];
  const dur = tail[1];
  if (service === undefined || dur === undefined) {
    throw new Error("Usage: nimbus connector set-interval <service> <duration>  (e.g. 5m, 1h)");
  }
  const ms = parseDurationToMs(dur);
  await withIpc((c) => c.call("connector.setInterval", { serviceId: service, intervalMs: ms }));
  console.log(`Interval set: ${service} → ${dur} (${String(ms)} ms)`);
}

async function runConnectorSync(tail: string[]): Promise<void> {
  const { rest, full } = parseFlags(tail);
  const service = rest[0];
  if (service === undefined) {
    throw new Error("Usage: nimbus connector sync <service> [--full | --force]");
  }
  let syncParams: { serviceId: string; full?: boolean };
  if (full === true) {
    syncParams = { serviceId: service, full: true };
  } else {
    syncParams = { serviceId: service };
  }
  // A sync run is awaited end-to-end by the Gateway (`forceSync` settles only when
  // the job finishes, queue wait included), so this needs the batch budget — on the
  // 30s default a first full sync reported failure for a sync that then completed.
  await withIpc((c) => c.call("connector.sync", syncParams), undefined, BATCH_RPC_TIMEOUT_MS);
  const suffix = full === true ? " (full)" : "";
  console.log(`Sync requested: ${service}${suffix}`);
}

async function runConnectorAddMcp(tail: string[]): Promise<void> {
  const id = tail[0]?.trim() ?? "";
  const commandLine = tail.slice(1).join(" ").trim();
  if (id === "" || commandLine === "") {
    throw new Error(
      "Usage: nimbus connector add --mcp <mcp_id> <command...>\nExample: nimbus connector add --mcp mcp_brave npx -y @some/mcp-server",
    );
  }
  await withIpc((c) => c.call("connector.addMcp", { serviceId: id, commandLine }));
  console.log(`Registered user MCP connector: ${id}`);
}

const REMOVE_YES_FLAGS: ReadonlySet<string> = new Set(["--yes", "-y"]);

type ConnectorRemoveResult = {
  ok: boolean;
  itemsDeleted: number;
  vaultKeysRemoved: string[];
};

/**
 * Shape the Gateway returns instead of {@link ConnectorRemoveResult} when the executor's HITL
 * gate rejects the action (`{ kind: "hit", value: { status: "rejected", reason } }` in
 * `ipc/connector-rpc.ts`). Detecting it keeps a declined removal from printing
 * `Removed index rows: undefined` and exiting 0.
 */
type ConnectorRemoveRejection = { status: "rejected"; reason?: string };

function isConnectorRemoveRejection(r: unknown): r is ConnectorRemoveRejection {
  return typeof r === "object" && r !== null && (r as { status?: unknown }).status === "rejected";
}

/**
 * `nimbus connector remove` is irreversible (Vault entries + index rows are deleted
 * atomically), so it is gated the same way `nimbus extension remove` is: an interactive
 * confirmation, `--yes`/`-y` to skip it for scripts, and a fail-closed refusal rather
 * than a hanging prompt when there is no TTY to prompt on.
 *
 * `connector.remove` is ALSO in the executor's frozen HITL set, so the Gateway pushes a
 * `consent.request` notification and blocks until `consent.respond` arrives. The two
 * confirmations are composed, not stacked: this CLI prompt is the single point of consent,
 * and the decision it produces is what answers the Gateway. A declined prompt returns before
 * any IPC connection is made, so the Gateway never sees the request at all; an accepted
 * prompt (or `--yes`) registers an auto-approve `consent.request` handler on the client that
 * `withIpc` builds, so the gate is answered programmatically with the decision the user
 * already gave. Without that handler nothing would ever answer and the call would die on the
 * client's 30s request timeout, removing nothing.
 */
async function runConnectorRemove(tail: string[]): Promise<void> {
  const accept = tail.some((a) => REMOVE_YES_FLAGS.has(a));
  const service = tail.find((a) => !REMOVE_YES_FLAGS.has(a));
  if (service === undefined) {
    throw new Error("Usage: nimbus connector remove <service> [--yes]");
  }
  if (!accept) {
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) {
      throw new Error(
        "Refusing to remove without confirmation in non-TTY mode. Pass --yes to proceed.",
      );
    }
    const ok = await confirm({
      message: `Remove connector "${service}"? This deletes its Vault credentials and index rows. This cannot be undone.`,
    });
    if (isCancel(ok) || ok !== true) {
      console.log("Cancelled.");
      return;
    }
  }
  const res = await withIpc(
    (c) =>
      c.call<ConnectorRemoveResult | ConnectorRemoveRejection>("connector.remove", {
        serviceId: service,
      }),
    (c) => {
      registerAutoApproveConsentHandler(c, accept ? "--yes" : "confirmed");
    },
  );
  if (isConnectorRemoveRejection(res)) {
    throw new Error(
      `Gateway rejected the removal of "${service}": ${res.reason ?? "no reason given"}`,
    );
  }
  console.log(`Removed index rows: ${String(res.itemsDeleted)}`);
  if (res.vaultKeysRemoved.length > 0) {
    console.log(`Cleared vault keys: ${res.vaultKeysRemoved.join(", ")}`);
  }
}

async function runConnectorReindex(args: string[]): Promise<void> {
  const service = args[0];
  if (service === undefined) {
    throw new Error(
      "Usage: nimbus connector reindex <name> [--depth <metadata_only|summary|full>]",
    );
  }
  const depthIdx = args.indexOf("--depth");
  const depth = depthIdx >= 0 ? (args[depthIdx + 1] ?? "metadata_only") : "metadata_only";
  // `--depth full` is HITL-gated (`ipc/reindex-rpc.ts` gates on `connector.reindex`
  // before doing any work), so this MUST register a `consent.request` handler: the
  // Gateway blocks on `consent.respond`, and a client that never answers just times
  // out. Without it `reindex --depth full` failed 100% of the time regardless of
  // index size — same defect, and same fix, as `connector remove` (#1013).
  //
  // The prompt handler is the right one rather than auto-approve: unlike `remove`,
  // reindex has no `--yes` flag, so no approval has been collected up front and the
  // user must be the one to answer. The batch budget then covers both the human's
  // think time at that prompt and the re-walk itself, which the Gateway awaits.
  const result = await withIpc(
    (c) => c.call<{ itemsAffected: number; mode: string }>("connector.reindex", { service, depth }),
    (c) => {
      registerConsentPromptHandler(c);
    },
    BATCH_RPC_TIMEOUT_MS,
  );
  console.log(
    `[ok] ${service} reindex ${result.mode} — ${String(result.itemsAffected)} items affected`,
  );
}

async function runConnectorHistory(tail: string[]): Promise<void> {
  const service = tail[0];
  if (service === undefined) {
    throw new Error("Usage: nimbus connector history <service> [--limit N]");
  }
  let limit = 100;
  const li = tail.indexOf("--limit");
  const limStr = li >= 0 ? tail[li + 1] : undefined;
  if (limStr !== undefined) {
    const n = Number.parseInt(limStr, 10);
    if (Number.isFinite(n) && n > 0) {
      limit = n;
    }
  }
  const rows = await withIpc((c) =>
    c.call<
      Array<{
        id: number;
        connectorId: string;
        fromState: string;
        toState: string;
        reason: string | null;
        occurredAtMs: number;
      }>
    >("connector.healthHistory", { serviceId: service, limit }),
  );
  console.log(JSON.stringify(rows, null, 2));
}

export async function runConnector(args: string[]): Promise<void> {
  const sub = args[0];
  const tail = args.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printConnectorHelp();
    return;
  }

  switch (sub) {
    case "auth":
      await runConnectorAuth(tail);
      return;
    case "add": {
      const mode = tail[0]?.trim() ?? "";
      if (mode === "--mcp") {
        await runConnectorAddMcp(tail.slice(1));
        return;
      }
      throw new Error("Usage: nimbus connector add --mcp <mcp_id> <command...>");
    }
    case "list":
      await runConnectorList({ json: tail.includes("--json") });
      return;
    case "history":
      await runConnectorHistory(tail);
      return;
    case "pause":
    case "resume":
    case "status":
      await runConnectorLifecycle(sub, tail);
      return;
    case "set-interval":
      await runConnectorSetInterval(tail);
      return;
    case "sync":
      await runConnectorSync(tail);
      return;
    case "remove":
      await runConnectorRemove(tail);
      return;
    case "reindex":
      await runConnectorReindex(tail);
      return;
    default:
      throw new Error(`Unknown connector subcommand: ${sub}. Try: nimbus connector help`);
  }
}

function printConnectorHelp(): void {
  console.log(`nimbus connector — cloud connector registration and sync (Q2)

Usage:
  nimbus connector auth <service> [--port <n>] [--scopes a,b] [--token <pat>] [--api-base <url>] [--help]
  nimbus connector add --mcp <mcp_id> <command...>   Register a user MCP server (id must be mcp_*)
  nimbus connector list [--json]
  nimbus connector history <service> [--limit N]
  nimbus connector status <service> [--stats]
  nimbus connector sync <service> [--full | --force]
  nimbus connector pause <service>
  nimbus connector resume <service>
  nimbus connector set-interval <service> <duration>
  nimbus connector remove <service> [--yes]         Irreversible; prompts unless --yes

Services (examples): google_drive, gmail, google_photos, onedrive, outlook, teams, github, gitlab, linear, jira, notion, confluence, jenkins, circleci, pagerduty, kubernetes

OAuth PKCE — set env vars before nimbus start, or run for setup steps:
  nimbus connector auth google_drive --help    (gmail, google_photos)
  nimbus connector auth onedrive --help        (outlook, teams)
  nimbus connector auth slack --help
  nimbus connector auth notion --help

Env vars: NIMBUS_OAUTH_GOOGLE_CLIENT_ID, NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET (Web OAuth clients only), NIMBUS_OAUTH_MICROSOFT_CLIENT_ID, NIMBUS_OAUTH_SLACK_CLIENT_ID,
  NIMBUS_OAUTH_NOTION_CLIENT_ID, NIMBUS_OAUTH_NOTION_CLIENT_SECRET
`);
  console.log(`GitHub: use --token or env NIMBUS_GITHUB_PAT (stored as vault key github.pat). Also registers GitHub Actions sync (service id github_actions) with the same PAT.
GitLab: use --token or env NIMBUS_GITLAB_PAT (gitlab.pat). Self-hosted: --api-base https://git.example.com/api/v4 (gitlab.api_base).
Linear: use --token or env NIMBUS_LINEAR_API_KEY (linear.api_key).
`);
  console.log(`Jira: use --username (Atlassian email), --token (API token), --api-base https://your-domain.atlassian.net
  or env NIMBUS_JIRA_EMAIL, NIMBUS_JIRA_API_TOKEN, NIMBUS_JIRA_BASE_URL (jira.email, jira.api_token, jira.base_url).
Notion: OAuth in the browser (notion.oauth); see auth notion --help for env setup.
Confluence: same flags/env pattern as Jira (NIMBUS_CONFLUENCE_* → confluence.email, confluence.api_token, confluence.base_url).
`);
  console.log(`Jenkins: --username, --token (API token), --api-base https://ci.example/  or env NIMBUS_JENKINS_USERNAME, NIMBUS_JENKINS_API_TOKEN, NIMBUS_JENKINS_BASE_URL (jenkins.username, jenkins.api_token, jenkins.base_url).
CircleCI: --token (personal API token) or env NIMBUS_CIRCLECI_API_TOKEN / CIRCLECI_TOKEN (vault key circleci.api_token). Indexes pipelines for GitHub repos already in the local index (project slug gh/owner/repo).
`);
  const pdEnv = "NIMBUS_PAGERDUTY_API_TOKEN";
  const pdAlt = "PAGERDUTY_API_TOKEN";
  console.log(
    `PagerDuty: --token (REST API token) or env ${pdEnv} / ${pdAlt} (vault key pagerduty.api_token). Indexes open incidents for search.`,
  );
  console.log(`Kubernetes: --kubeconfig <path> [--context <name>] or env NIMBUS_KUBECONFIG / KUBECONFIG (vault keys kubernetes.kubeconfig, optional kubernetes.context). Indexes cluster deployments.

Credentials are stored in the OS vault only (never printed here).
`);
}
