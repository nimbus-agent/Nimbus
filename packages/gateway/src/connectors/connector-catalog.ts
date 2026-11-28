import type { OAuthProvider } from "../auth/pkce.ts";
import { OAUTH_UNSUPPORTED_DETAILS } from "./connector-oauth-unsupported.ts";
import * as finops from "./finops-connector-catalog.ts";
import { GOOGLE_DEFAULT_SCOPES } from "./google-oauth-scopes.ts";

export const CONNECTOR_SERVICE_IDS = [
  "google_drive",
  "gmail",
  "google_photos",
  "google_meet",
  "google_calendar",
  "onedrive",
  "outlook",
  "teams",
  "slack",
  "github",
  "github_actions",
  "github_billing",
  "openai_billing",
  "anthropic_billing",
  "gitlab_billing",
  "aws_billing",
  "azure_billing",
  "gcp_billing",
  "gitlab",
  "bitbucket",
  "bitbucket_billing",
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
  "unleash",
  "split",
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
  ...finops.FINOPS_CONNECTOR_IDS,
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

/**
 * Connectors the `@nimbus-dev/connectors` package still exports but the gateway no longer bundles:
 * each ships as a signed extension from the official registry. Read by the registry generator and
 * the drift audit, which subtract it; every entry must stay a catalog id with a continuity entry.
 */
export const UNBUNDLED_CONNECTOR_IDS = [
  // Ships as the signed extension com.nimbus.readwise; the npm package keeps it for standalone users.
  "readwise",
] as const;

export const GOOGLE_CONNECTOR_SERVICES: ReadonlySet<string> = new Set([
  "google_drive",
  "gmail",
  "google_photos",
  "google_meet",
  "google_calendar",
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

const CONNECTOR_SYNC_INTERVAL_MS: { readonly [K in ConnectorServiceId]: number } = {
  google_drive: MIN30,
  onedrive: MIN30,
  gmail: MIN5,
  outlook: MIN5,
  teams: MIN5,
  slack: MIN5,
  notion: MIN5,
  confluence: MIN10,
  google_photos: finops.HOUR6,
  google_meet: finops.HOUR6,
  // A meeting moved this morning must be seen this morning: the briefing reads these rows.
  google_calendar: MIN5,
  github: MIN1,
  github_actions: MIN1,
  // Phase 7 slice 5: GitHub billing usage, a daily report (the cost lines of the current month).
  github_billing: 24 * 60 * MIN1,
  // Phase 7 slice 6: OpenAI and Anthropic organization costs, daily reports.
  openai_billing: 24 * 60 * MIN1,
  anthropic_billing: 24 * 60 * MIN1,
  // Phase 7 slice 8: GitLab compute minutes, daily.
  gitlab_billing: 24 * 60 * MIN1,
  // Phase 7 slice 11a: AWS cost from a FOCUS Data Export in S3, daily.
  aws_billing: 24 * 60 * MIN1,
  // Phase 7 slice 12a: Azure cost from a FOCUS Cost Management export in Blob Storage, daily.
  azure_billing: 24 * 60 * MIN1,
  // Phase 7 slice 13: GCP cost from the BigQuery billing export, daily.
  gcp_billing: 24 * 60 * MIN1,
  gitlab: MIN1,
  bitbucket: MIN1,
  // Phase 7 slice 9: Bitbucket Pipelines minutes, daily.
  bitbucket_billing: 24 * 60 * MIN1,
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
  unleash: MIN10,
  split: MIN10,
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
  // Read by the migration engine's paused state; the bound extension syncs on its manifest's
  // intervalSeconds instead (both 600 s).
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
  ...finops.FINOPS_SYNC_INTERVAL_MS,
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
  github_billing: "github",
  gitlab_billing: "gitlab",
  bitbucket_billing: "bitbucket",
  aws_billing: "aws",
  azure_billing: "azure",
  gcp_billing: "gcp",
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

export function oauthProfileForService(serviceId: ConnectorServiceId): ConnectorOAuthProfile {
  const unsupported = OAUTH_UNSUPPORTED_DETAILS[serviceId];
  if (unsupported !== undefined) {
    oauthUnsupported(serviceId, unsupported);
  }
  switch (serviceId) {
    case "google_drive":
    case "gmail":
    case "google_photos":
    case "google_meet":
    case "google_calendar":
      // The Google consents' scopes, and why each is requested: `google-oauth-scopes.ts`.
      return { provider: "google", defaultScopes: [...GOOGLE_DEFAULT_SCOPES[serviceId]] };
    case "onedrive":
      return {
        provider: "microsoft",
        defaultScopes: ["Files.Read.All", "offline_access", "openid", "profile"],
      };
    case "outlook":
      return {
        provider: "microsoft",
        // `Mail.ReadWrite` backs `outlook_draft_create` (connectors 0.4.0). Only a fresh
        // `nimbus connector auth outlook` requests it: a refresh sends no `scope` field
        // (`auth/oauth-registry.ts` `refreshViaRegistry`), so an existing connection keeps the
        // scopes it was granted, and the connector hides the draft tool while it lacks the scope.
        defaultScopes: [
          "Mail.Read",
          "Mail.ReadWrite",
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
