import type { OAuthProvider } from "../auth/pkce.ts";

/** Normalised connector `service_id` values (Q2 plan / scheduler_state). */
export const CONNECTOR_SERVICE_IDS = [
  "google_drive",
  "gmail",
  "google_photos",
  "onedrive",
  "outlook",
  "teams",
  "slack",
  "github",
  "github_actions",
  "gitlab",
  "bitbucket",
  "linear",
  "jira",
  "notion",
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
  "snyk",
  "bitrise",
  "sonarqube",
  "semgrep",
  "wiz",
  "launchdarkly",
  "flagsmith",
  "argocd",
  "flux",
  "dbt",
  "metabase",
  "superset",
  "databricks",
  "mlflow",
  "vercel",
  "netlify",
  "stripe",
  "mercury",
  "readwise",
  "raindrop",
  "intercom",
  "zendesk",
  "lever",
  "greenhouse",
] as const;

export type ConnectorServiceId = (typeof CONNECTOR_SERVICE_IDS)[number];

export const GOOGLE_CONNECTOR_SERVICES: ReadonlySet<string> = new Set([
  "google_drive",
  "gmail",
  "google_photos",
]);

export const MICROSOFT_CONNECTOR_SERVICES: ReadonlySet<string> = new Set([
  "onedrive",
  "outlook",
  "teams",
]);

const MIN1 = 60 * 1000;
const MIN5 = 5 * 60 * 1000;
const MIN10 = 10 * 60 * 1000;
const MIN30 = 30 * 60 * 1000;
const SEC90 = 90 * 1000;
const MIN120 = 120 * 1000;
const HOUR6 = 6 * 60 * 60 * 1000;

/** Default scheduler interval per service (must list every {@link ConnectorServiceId}). */
const CONNECTOR_SYNC_INTERVAL_MS: { readonly [K in ConnectorServiceId]: number } = {
  google_drive: MIN30,
  onedrive: MIN30,
  gmail: MIN5,
  outlook: MIN5,
  teams: MIN5,
  slack: MIN5,
  notion: MIN5,
  confluence: MIN10,
  google_photos: HOUR6,
  github: MIN1,
  github_actions: MIN1,
  gitlab: MIN1,
  bitbucket: MIN1,
  linear: MIN1,
  jira: MIN1,
  discord: MIN5,
  jenkins: MIN120,
  circleci: SEC90,
  pagerduty: MIN120,
  kubernetes: MIN120,
  aws: MIN120,
  azure: MIN120,
  gcp: MIN120,
  iac: MIN120,
  grafana: MIN120,
  sentry: MIN120,
  newrelic: MIN120,
  datadog: MIN120,
  snyk: MIN10,
  bitrise: MIN10,
  sonarqube: MIN10,
  semgrep: MIN10,
  wiz: MIN10,
  launchdarkly: MIN10,
  flagsmith: MIN10,
  argocd: MIN10,
  flux: MIN10,
  dbt: MIN10,
  metabase: MIN10,
  superset: MIN10,
  databricks: MIN10,
  mlflow: MIN10,
  vercel: MIN10,
  netlify: MIN10,
  stripe: MIN10,
  mercury: MIN10,
  readwise: MIN10,
  raindrop: MIN10,
  intercom: MIN10,
  zendesk: MIN10,
  lever: MIN10,
  greenhouse: MIN10,
};

export function normalizeConnectorServiceId(raw: string): ConnectorServiceId | null {
  const s = raw.trim().toLowerCase().replaceAll("-", "_");
  if ((CONNECTOR_SERVICE_IDS as readonly string[]).includes(s)) {
    return s as ConnectorServiceId;
  }
  return null;
}

export function defaultSyncIntervalMsForService(serviceId: ConnectorServiceId): number {
  return CONNECTOR_SYNC_INTERVAL_MS[serviceId];
}

export type ConnectorOAuthProfile = {
  provider: OAuthProvider;
  defaultScopes: string[];
};

function oauthUnsupported(serviceId: ConnectorServiceId, detail: string): never {
  throw new Error(`oauthProfileForService: ${serviceId} ${detail}`);
}

/**
 * Services that authenticate via a PAT / API token / kubeconfig / service-account
 * key rather than OAuth. Calling `oauthProfileForService` for one of these is a
 * misuse — callers should read the connector's vault keys directly via
 * `readConnectorSecret`. The detail string explains the correct auth shape.
 *
 * Adding a new non-OAuth connector: add an entry here. Adding a new OAuth
 * connector: add a branch in the `switch` below.
 */
const OAUTH_UNSUPPORTED_DETAILS: Partial<Record<ConnectorServiceId, string>> = {
  github: "uses a PAT (connector.auth personalAccessToken)",
  github_actions: "uses the same PAT as github (connector.auth github)",
  gitlab: "uses a PAT (connector.auth personalAccessToken)",
  bitbucket: "uses app password (connector.auth username + token)",
  linear: "uses an API key (connector.auth personalAccessToken)",
  jira: "uses email + API token + base URL (connector.auth)",
  confluence: "uses email + API token + base URL (connector.auth)",
  discord: "uses a bot token + opt-in (connector.auth --enable)",
  jenkins: "uses base URL + username + API token (connector.auth)",
  circleci: "uses a personal API token (connector.auth circleci)",
  pagerduty: "uses a REST API token (connector.auth pagerduty)",
  kubernetes: "uses a kubeconfig file path (connector.auth kubernetes)",
  aws: "uses access key + secret + region or profile (connector.auth aws)",
  azure: "uses service principal tenant + client id + secret (connector.auth azure)",
  gcp: "uses a service account JSON key path (connector.auth gcp)",
  iac: "is opt-in for local CLIs (connector.auth iac --enable)",
  grafana: "uses base URL + API token (connector.auth grafana)",
  sentry: "uses auth token + org slug (connector.auth sentry)",
  newrelic: "uses a user API key (connector.auth newrelic)",
  datadog: "uses API + application keys (connector.auth datadog)",
  snyk: "uses a REST API token (connector.auth snyk)",
  bitrise: "uses a personal access token (connector.auth bitrise)",
  sonarqube: "uses an API token (connector.auth sonarqube)",
  semgrep: "uses a Semgrep PAT (connector.auth semgrep)",
  wiz: "uses OAuth client_credentials (connector.auth wiz)",
  launchdarkly: "uses an API token (connector.auth launchdarkly)",
  flagsmith: "uses an admin API token (connector.auth flagsmith)",
  argocd: "uses a bearer API token (connector.auth argocd)",
  flux: "uses a Kubernetes ServiceAccount token (connector.auth flux)",
  dbt: "uses a dbt Cloud API token (connector.auth dbt)",
  metabase: "uses a Metabase API key (connector.auth metabase)",
  superset: "uses Superset username/password (connector.auth superset)",
  databricks: "uses a Databricks PAT (connector.auth databricks)",
  mlflow: "uses an MLflow API token (connector.auth mlflow)",
  vercel: "uses an access token + optional team id (connector.auth vercel)",
  netlify: "uses a personal access token (connector.auth netlify)",
  stripe: "uses a secret API key (connector.auth stripe)",
  mercury: "uses a Mercury API token (connector.auth mercury)",
  readwise: "uses a Readwise API token (connector.auth readwise)",
  raindrop: "uses a Raindrop.io API token (connector.auth raindrop)",
  intercom: "uses an Intercom access token (connector.auth intercom)",
  zendesk: "uses email + API token Basic auth (connector.auth zendesk)",
  lever: "uses a Lever API key (connector.auth lever)",
  greenhouse: "uses a Greenhouse Harvest API key (connector.auth greenhouse)",
};

export function oauthProfileForService(serviceId: ConnectorServiceId): ConnectorOAuthProfile {
  const unsupported = OAUTH_UNSUPPORTED_DETAILS[serviceId];
  if (unsupported !== undefined) {
    oauthUnsupported(serviceId, unsupported);
  }
  switch (serviceId) {
    case "google_drive":
      return {
        provider: "google",
        defaultScopes: ["https://www.googleapis.com/auth/drive.readonly"],
      };
    case "gmail":
      return {
        provider: "google",
        defaultScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
      };
    case "google_photos":
      return {
        provider: "google",
        defaultScopes: [
          "https://www.googleapis.com/auth/photoslibrary.readonly",
          "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
        ],
      };
    case "onedrive":
      return {
        provider: "microsoft",
        defaultScopes: ["Files.Read.All", "offline_access", "openid", "profile"],
      };
    case "outlook":
      return {
        provider: "microsoft",
        defaultScopes: [
          "Mail.Read",
          "Mail.Send",
          "Calendars.Read",
          "Calendars.ReadWrite",
          "Contacts.Read",
          "offline_access",
          "openid",
          "profile",
        ],
      };
    case "teams":
      return {
        provider: "microsoft",
        defaultScopes: [
          "Team.ReadBasic.All",
          "Channel.ReadBasic.All",
          "ChannelMessage.Read.All",
          "ChannelMessage.Send",
          "Chat.Read",
          "ChatMessage.Send",
          "User.Read",
          "offline_access",
          "openid",
          "profile",
        ],
      };
    case "slack":
      return {
        provider: "slack",
        defaultScopes: [
          "channels:read",
          "channels:history",
          "groups:read",
          "groups:history",
          "im:read",
          "im:history",
          "mpim:read",
          "mpim:history",
          "users:read",
          "users:read.email",
          "search:read",
          "chat:write",
        ],
      };
    case "notion":
      return { provider: "notion", defaultScopes: [] };
    default:
      // All remaining ids are in `OAUTH_UNSUPPORTED_DETAILS` and threw above.
      // The throw is the actual control-flow exit; this branch only exists so
      // TypeScript's exhaustiveness check passes for the OAuth-supported switch.
      return oauthUnsupported(
        serviceId,
        "is missing both an OAuth branch and an unsupported entry",
      );
  }
}
