import type { OAuthProvider } from "../auth/pkce.ts";

export const CONNECTOR_SERVICE_IDS = [
  "google_drive",
  "gmail",
  "google_photos",
  "google_meet",
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
  "codemagic",
  "testflight",
  "firebase",
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
  "pipedrive",
  "stackoverflow",
  "zotero",
  "mendeley",
  "dependencytrack",
  "airflow",
  "prefect",
  "dagster",
  "ramp",
  "zoom",
  "hubspot",
  "miro",
  "canva",
  "figma",
  "salesforce",
  "bigquery",
  "athena",
  "cloudwatch",
  "sagemaker",
  "cloud_logging",
  "vertex_ai",
  "elasticsearch",
  "great_expectations",
  "imap",
  "fastmail",
  "protonmail",
  "localdb",
  "storybook",
  "dataprofile",
  "snowflake",
  "tableau",
  "looker",
  "powerbi",
  "montecarlo",
  "bigeye",
  "workday",
  // Apple iCloud Mail (IMAP) + iCloud Calendar (CalDAV). Uses an Apple ID
  // e-mail address + app-specific password (not the Apple ID password) stored
  // under `apple.icloud_email` + `apple.icloud_app_password`.
  "apple",
] as const;

export type ConnectorServiceId = (typeof CONNECTOR_SERVICE_IDS)[number];

export const GOOGLE_CONNECTOR_SERVICES: ReadonlySet<string> = new Set([
  "google_drive",
  "gmail",
  "google_photos",
  "google_meet",
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
  google_meet: HOUR6,
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
  codemagic: MIN10,
  testflight: MIN10,
  firebase: MIN10,
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
  pipedrive: MIN10,
  stackoverflow: MIN10,
  zotero: MIN10,
  mendeley: MIN10,
  dependencytrack: MIN10,
  airflow: MIN10,
  prefect: MIN10,
  dagster: MIN10,
  ramp: MIN10,
  zoom: MIN10,
  hubspot: MIN10,
  miro: MIN10,
  canva: MIN10,
  figma: MIN10,
  salesforce: MIN10,
  bigquery: MIN10,
  athena: MIN10,
  cloudwatch: MIN10,
  sagemaker: MIN10,
  cloud_logging: MIN10,
  vertex_ai: MIN10,
  elasticsearch: MIN10,
  great_expectations: MIN10,
  imap: MIN5,
  fastmail: MIN5,
  protonmail: MIN5,
  localdb: MIN10,
  storybook: MIN10,
  dataprofile: MIN10,
  snowflake: MIN10,
  tableau: MIN10,
  looker: MIN10,
  powerbi: MIN10,
  montecarlo: MIN10,
  bigeye: MIN10,
  workday: MIN10,
  apple: MIN5,
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
  throw new Error(`oauthProfileForService: ${serviceId} does not use OAuth — it ${detail}`);
}

/**
 * Services with no credential of their own: they sync with the credential another service stores.
 * Setting one of these up means authenticating the service named here.
 */
const CREDENTIALS_REUSED_FROM: Partial<Record<ConnectorServiceId, ConnectorServiceId>> = {
  github_actions: "github",
  bigquery: "gcp",
  cloud_logging: "gcp",
  vertex_ai: "gcp",
  athena: "aws",
  cloudwatch: "aws",
  sagemaker: "aws",
};

/** The service whose stored credential `serviceId` syncs with, when it has none of its own. */
export function credentialsReusedFrom(
  serviceId: ConnectorServiceId,
): ConnectorServiceId | undefined {
  return CREDENTIALS_REUSED_FROM[serviceId];
}

/**
 * How a non-OAuth service authenticates, in plain words ("uses a secret API key"), or `undefined`
 * for a service with an OAuth profile. Descriptive only: it never names a command, because the
 * command that applies depends on which setup path the service has, and the IPC layer decides that.
 */
export function oauthUnsupportedDetail(serviceId: ConnectorServiceId): string | undefined {
  return OAUTH_UNSUPPORTED_DETAILS[serviceId];
}

const OAUTH_UNSUPPORTED_DETAILS: Partial<Record<ConnectorServiceId, string>> = {
  github: "uses a PAT",
  github_actions: "uses the same PAT as github",
  gitlab: "uses a PAT",
  bitbucket: "uses app password",
  linear: "uses an API key",
  jira: "uses email + API token + base URL",
  confluence: "uses email + API token + base URL",
  discord: "uses a bot token + opt-in",
  jenkins: "uses base URL + username + API token",
  circleci: "uses a personal API token",
  pagerduty: "uses a REST API token",
  kubernetes: "uses a kubeconfig file path",
  aws: "uses access key + secret + region or profile",
  azure: "uses service principal tenant + client id + secret",
  gcp: "uses a service account JSON key path",
  iac: "is opt-in for local CLIs",
  grafana: "uses base URL + API token",
  sentry: "uses auth token + org slug",
  newrelic: "uses a user API key",
  datadog: "uses API + application keys",
  snyk: "uses a REST API token",
  bitrise: "uses a personal access token",
  codemagic: "uses an API token sent in the x-auth-token header",
  testflight:
    "uses an App Store Connect ES256 JWT minted from issuer id + key id + .p8 private key",
  firebase: "uses a Google service-account key JSON + comma-separated app ids",
  sonarqube: "uses an API token",
  semgrep: "uses a Semgrep PAT",
  wiz: "uses OAuth client_credentials",
  launchdarkly: "uses an API token",
  flagsmith: "uses an admin API token",
  argocd: "uses a bearer API token",
  flux: "uses a Kubernetes ServiceAccount token",
  dbt: "uses a dbt Cloud API token",
  metabase: "uses a Metabase API key",
  superset: "uses Superset username/password",
  databricks: "uses a Databricks PAT",
  mlflow: "uses an MLflow API token",
  vercel: "uses an access token + optional team id",
  netlify: "uses a personal access token",
  stripe: "uses a secret API key",
  mercury: "uses a Mercury API token",
  readwise: "uses a Readwise API token",
  raindrop: "uses a Raindrop.io API token",
  intercom: "uses an Intercom access token",
  zendesk: "uses email + API token Basic auth",
  lever: "uses a Lever API key",
  greenhouse: "uses a Greenhouse Harvest API key",
  pipedrive: "uses a Pipedrive API token",
  stackoverflow: "uses a Stack Overflow for Teams PAT + team slug",
  zotero: "uses a Zotero API key + library spec",
  dependencytrack: "uses a Dependency-Track API key + base URL",
  airflow: "uses HTTP Basic auth — username + password + base URL",
  prefect: "uses a Prefect API key (Bearer) + workspace API URL",
  dagster: "uses a Dagster Cloud API token + host base URL",
  ramp: "uses OAuth2 client-credentials — client id + client secret",
  bigquery:
    "reuses the existing GCP service-account JSON key path + project id — no separate BigQuery credential",
  athena:
    "reuses the existing AWS access key + secret + region or profile — no separate Athena credential",
  cloudwatch:
    "reuses the existing AWS access key + secret + region or profile — no separate CloudWatch credential",
  sagemaker:
    "reuses the existing AWS access key + secret + region or profile — no separate SageMaker credential",
  cloud_logging:
    "reuses the existing GCP service-account JSON key path + project id — no separate Cloud Logging credential",
  vertex_ai:
    "reuses the existing GCP service-account JSON key path + project id — no separate Vertex AI credential; optional gcp.region selects the region (default us-central1)",
  elasticsearch: "uses an Elasticsearch API key + cluster URL",
  great_expectations:
    "reads Great Expectations validation-result JSON artefacts from the configured great_expectations.results_dir — no live credentials",
  imap: "uses per-tenant IMAP/SMTP host + port + username + password",
  fastmail: "uses a Fastmail JMAP API token",
  protonmail:
    "uses ProtonMail Bridge's local IMAP/SMTP credentials (ProtonMail Bridge must be running)",
  localdb:
    "reads saved SQL script files from a configured local DB-tool scripts dir — no live credentials",
  storybook: "reads a local Storybook manifest from a configured output dir — no live credentials",
  dataprofile:
    "profiles local data files (parquet/csv/jsonl/json) in a configured dir for schema only — no live credentials",
  snowflake: "uses an OAuth token or key-pair JWT + account identifier — no PKCE flow",
  tableau: "uses a Personal Access Token (PAT name + secret) + server URL — no PKCE flow",
  looker:
    "uses OAuth2 client-credentials (client id + client secret) + instance base URL — no PKCE flow",
  powerbi:
    "uses Azure AD client-credentials (tenant id + client id + client secret) against the Power BI REST API — no PKCE flow",
  montecarlo:
    "uses an API key pair (api_id + api_token) against the Monte Carlo GraphQL API — no PKCE flow",
  bigeye: "uses a Bearer API key + per-tenant base URL — no PKCE flow",
  apple: "uses an Apple ID + app-specific password for iCloud Mail (IMAP/SMTP) + Calendar (CalDAV)",
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
    case "google_meet":
      return {
        provider: "google",
        defaultScopes: ["https://www.googleapis.com/auth/meetings.space.readonly"],
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
    case "mendeley":
      return { provider: "mendeley", defaultScopes: ["all"] };
    case "zoom":
      return {
        provider: "zoom",
        defaultScopes: [
          "user:read:user",
          "meeting:read:list_meetings",
          "cloud_recording:read:list_user_recordings",
        ],
      };
    case "hubspot":
      return {
        provider: "hubspot",
        defaultScopes: ["crm.objects.deals.read", "oauth"],
      };
    case "miro":
      return {
        provider: "miro",
        defaultScopes: ["boards:read"],
      };
    case "canva":
      return {
        provider: "canva",
        defaultScopes: ["design:meta:read"],
      };
    case "figma":
      return {
        provider: "figma",
        defaultScopes: ["files:read"],
      };
    case "salesforce":
      return {
        provider: "salesforce",
        defaultScopes: ["api", "refresh_token"],
      };
    case "workday":
      return { provider: "workday", defaultScopes: ["system"] };
    default:
      return oauthUnsupported(
        serviceId,
        "is missing both an OAuth branch and an unsupported entry",
      );
  }
}
