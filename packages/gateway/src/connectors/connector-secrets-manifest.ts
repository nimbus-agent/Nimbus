import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ConnectorServiceId } from "./connector-catalog.ts";

export const CONNECTOR_VAULT_SECRET_KEYS = {
  google_drive: [],
  gmail: [],
  google_photos: [],
  google_meet: [],
  onedrive: [],
  outlook: [],
  teams: ["teams.bot_app_id", "teams.bot_app_password"],
  slack: ["slack.oauth", "slack.bot_token", "slack.app_token"],
  github: ["github.pat"],
  github_actions: [],
  gitlab: ["gitlab.pat", "gitlab.api_base"],
  bitbucket: ["bitbucket.username", "bitbucket.app_password"],
  linear: ["linear.api_key"],
  jira: ["jira.api_token", "jira.email", "jira.base_url"],
  notion: ["notion.oauth"],
  confluence: ["confluence.api_token", "confluence.email", "confluence.base_url"],
  discord: ["discord.bot_token", "discord.enabled"],
  jenkins: ["jenkins.base_url", "jenkins.username", "jenkins.api_token"],
  circleci: ["circleci.api_token"],
  pagerduty: ["pagerduty.api_token"],
  kubernetes: ["kubernetes.kubeconfig", "kubernetes.context"],
  aws: ["aws.access_key_id", "aws.secret_access_key", "aws.default_region", "aws.profile"],
  azure: ["azure.tenant_id", "azure.client_id", "azure.client_secret"],
  // `gcp.region` is an OPTIONAL non-secret config key (Vertex AI is regional;
  // default us-central1). It is listed here so it is a known/allowed gcp vault
  // key and is cleared when the gcp connector is removed — it is never required.
  gcp: ["gcp.credentials_json_path", "gcp.project_id", "gcp.region"],
  iac: ["iac.enabled"],
  grafana: ["grafana.url", "grafana.api_token"],
  sentry: ["sentry.auth_token", "sentry.org_slug", "sentry.url"],
  newrelic: ["newrelic.api_key", "newrelic.account_id"],
  datadog: ["datadog.api_key", "datadog.app_key", "datadog.site"],
  snyk: ["snyk.token"],
  bitrise: ["bitrise.token"],
  codemagic: ["codemagic.token"],
  testflight: ["testflight.issuer_id", "testflight.key_id", "testflight.private_key"],
  firebase: ["firebase.service_account_json", "firebase.app_ids"],
  sonarqube: ["sonarqube.token", "sonarqube.url", "sonarqube.organization"],
  semgrep: ["semgrep.token", "semgrep.deployment_slug"],
  wiz: ["wiz.client_id", "wiz.client_secret", "wiz.api_url", "wiz.auth_url"],
  launchdarkly: ["launchdarkly.token", "launchdarkly.base_url", "launchdarkly.project_key"],
  flagsmith: ["flagsmith.token", "flagsmith.api_base"],
  argocd: ["argocd.url", "argocd.token"],
  flux: ["flux.api_url", "flux.token"],
  dbt: ["dbt.token", "dbt.api_base", "dbt.account_id"],
  metabase: ["metabase.url", "metabase.api_key"],
  superset: ["superset.url", "superset.username", "superset.password"],
  databricks: ["databricks.host", "databricks.token"],
  mlflow: ["mlflow.host", "mlflow.token"],
  vercel: ["vercel.token", "vercel.team_id"],
  netlify: ["netlify.token"],
  stripe: ["stripe.api_key"],
  mercury: ["mercury.token"],
  readwise: ["readwise.token"],
  raindrop: ["raindrop.token"],
  intercom: ["intercom.token"],
  zendesk: ["zendesk.url", "zendesk.email", "zendesk.api_token"],
  lever: ["lever.api_key"],
  greenhouse: ["greenhouse.api_key"],
  pipedrive: ["pipedrive.token"],
  stackoverflow: ["stackoverflow.token", "stackoverflow.team"],
  zotero: ["zotero.api_key", "zotero.library"],
  // Mendeley (Elsevier) reference manager. Uses the OAuth2 authorization-code
  // flow (api.mendeley.com); the access/refresh token bundle is stored under
  // the single `mendeley.oauth` vault key, mirroring the other OAuth connectors.
  mendeley: ["mendeley.oauth"],
  dependencytrack: ["dependencytrack.base_url", "dependencytrack.api_key"],
  elasticsearch: ["elasticsearch.url", "elasticsearch.api_key"],
  airflow: ["airflow.base_url", "airflow.username", "airflow.password"],
  prefect: ["prefect.api_url", "prefect.api_key"],
  dagster: ["dagster.base_url", "dagster.api_token"],
  ramp: ["ramp.client_id", "ramp.client_secret"],
  zoom: ["zoom.oauth"],
  hubspot: ["hubspot.oauth"],
  miro: ["miro.oauth"],
  canva: ["canva.oauth"],
  figma: ["figma.oauth", "figma.team_id"],
  salesforce: ["salesforce.oauth"],
  // BigQuery (Tier-3 no-row-data warehouse) reuses the existing GCP credentials —
  // `gcp.credentials_json_path` + `gcp.project_id` — via the gcloud CLI. It has no
  // BigQuery-specific vault secret, so its own key list is intentionally empty.
  bigquery: [],
  // Athena (Tier-3 no-row-data warehouse) reuses the existing AWS credentials —
  // `aws.access_key_id` + `aws.secret_access_key` + `aws.default_region`/`aws.profile`
  // — via the aws CLI. It has no Athena-specific vault secret, so its own key list
  // is intentionally empty.
  athena: [],
  // CloudWatch (Tier-3 no-row-data logging) reuses the existing AWS credentials —
  // `aws.access_key_id` + `aws.secret_access_key` + `aws.default_region`/`aws.profile`
  // — via the aws CLI. It has no CloudWatch-specific vault secret, so its own key
  // list is intentionally empty.
  cloudwatch: [],
  // SageMaker (Tier-3 no-row-data ML registry) reuses the existing AWS credentials —
  // `aws.access_key_id` + `aws.secret_access_key` + `aws.default_region`/`aws.profile`
  // — via the aws CLI. It has no SageMaker-specific vault secret, so its own key
  // list is intentionally empty.
  sagemaker: [],
  // Cloud Logging (Tier-3 no-row-data logging) reuses the existing GCP credentials —
  // `gcp.credentials_json_path` + `gcp.project_id` — via the gcloud CLI. It has no
  // Cloud-Logging-specific vault secret, so its own key list is intentionally empty.
  cloud_logging: [],
  // Vertex AI (Tier-3 no-row-data ML model registry) reuses the existing GCP
  // credentials — `gcp.credentials_json_path` + `gcp.project_id` — via the gcloud
  // CLI. Region is an OPTIONAL non-secret `gcp.region` config key (default
  // us-central1), NOT a Vertex-AI-specific secret, so its own key list is empty.
  vertex_ai: [],
  // Great Expectations (Tier-3 no-row-data) has NO network and NO live
  // credential — it reads GX validation-result JSON artefacts from a configured
  // local directory. `great_expectations.results_dir` is a non-secret PATH, not
  // a credential, but it is listed here so it is a known/allowed vault key
  // (D11), is cleared on connector removal, and gates the sync/spawn when unset.
  great_expectations: ["great_expectations.results_dir"],
  imap: [
    "imap.host",
    "imap.port",
    "imap.username",
    "imap.password",
    "imap.mailbox",
    "imap.smtp_host",
    "imap.smtp_port",
    "imap.smtp_username",
    "imap.smtp_password",
  ],
  // Fastmail JMAP: a secret API token + an optional non-secret base URL
  // (listed so it is a known/allowed vault key (D11) and is cleared on removal).
  fastmail: ["fastmail.api_token", "fastmail.base_url"],
  // ProtonMail Bridge: Bridge-generated IMAP/SMTP credentials. Host/port default
  // to the Bridge loopback listener (127.0.0.1:1143 / :1025); SMTP is optional.
  protonmail: [
    "protonmail.username",
    "protonmail.password",
    "protonmail.imap_host",
    "protonmail.imap_port",
    "protonmail.mailbox",
    "protonmail.smtp_host",
    "protonmail.smtp_port",
    "protonmail.smtp_username",
    "protonmail.smtp_password",
  ],
  // Local DB Schema Indexing: a single non-secret PATH to the local DB-tool
  // scripts dir (listed so it is a known/allowed vault key (D11) + cleared on
  // removal + gates the sync/spawn when unset). No live credential.
  localdb: ["localdb.scripts_dir"],
  // Storybook: a single non-secret PATH to the local Storybook output dir
  // (containing index.json / stories.json). No live credential.
  storybook: ["storybook.dir"],
  // Local data profiling: a single non-secret PATH to the dir holding local data
  // files (.parquet/.csv/.jsonl/.json) to schema-profile. No live credential.
  dataprofile: ["dataprofile.dir"],
  // Snowflake (Tier-3 no-row-data warehouse). Uses OAuth token or key-pair JWT
  // for auth against the Snowflake SQL REST API. Indexes schema/table metadata
  // (column names + tags, row-count estimates) only — NEVER row data.
  snowflake: ["snowflake.account", "snowflake.oauth_token", "snowflake.key_pair_jwt"],
  // Tableau (Tier-3 no-row-data BI). Uses a Personal Access Token (PAT name +
  // secret) against the Tableau REST API. Indexes dashboards/views as metadata
  // only — NEVER row data or underlying cell values.
  tableau: ["tableau.url", "tableau.pat_name", "tableau.pat_secret"],
  // Looker (Tier-3 no-row-data BI). Uses OAuth2 client-credentials
  // (client_id + client_secret) against the Looker API 4.0. Indexes dashboards
  // and LookML views as metadata only — NEVER row data or underlying cell values.
  // LookML view sql_table_name fields are normalized via normalizeDataModelKey
  // to produce cross-connector lineage edges (Looker→dbt).
  looker: ["looker.base_url", "looker.client_id", "looker.client_secret"],
  // Power BI (Tier-3 no-row-data BI). Uses Azure AD client-credentials
  // (tenant_id + client_id + client_secret) against the Power BI REST API.
  // Indexes reports/dashboards as metadata only — NEVER row data or cell values.
  // Dataset table names are normalized via normalizeDataModelKey to produce
  // cross-connector lineage edges (Power BI → data warehouse).
  powerbi: ["powerbi.tenant_id", "powerbi.client_id", "powerbi.client_secret"],
  // Monte Carlo (Tier-3 data-quality observability). Uses an API key pair
  // (api_id + api_token) against the Monte Carlo GraphQL API at the fixed static
  // host api.getmontecarlo.com. Indexes data-quality incidents as
  // data_quality_test items with monitoredDataModelKeys lineage edges.
  montecarlo: ["montecarlo.api_id", "montecarlo.api_token"],
  // Bigeye (Tier-3 data-quality observability). Uses an API key (Bearer token)
  // against a per-tenant Bigeye instance (base_url + api_key). Indexes
  // data-quality issues as data_quality_test items with monitoredDataModelKeys
  // lineage edges. base_url is per-tenant (like Looker/Tableau).
  bigeye: ["bigeye.base_url", "bigeye.api_key"],
  // Workday HR. OAuth2 authorization-code flow against the tenant-specific
  // /ccx/oauth2/<tenant>/token endpoint; only the token bundle is vaulted.
  // Tenant host/name + client id/secret are env vars (see config.ts).
  workday: ["workday.oauth"],
  // Apple iCloud Mail + iCloud Calendar. The single app-specific password
  // (generated under Apple ID → Sign-In & Security → App-Specific Passwords)
  // authenticates IMAP + SMTP + CalDAV. Endpoints are fixed constants.
  // `apple.mailbox` is an OPTIONAL non-secret config key (default INBOX); listed
  // so it is a known/allowed vault key (D11) and is cleared on connector removal.
  apple: ["apple.icloud_email", "apple.icloud_app_password", "apple.mailbox"],
} as const satisfies {
  readonly [K in ConnectorServiceId]: readonly string[];
};

/**
 * Alternative-auth groups for the I19 team-secret presence check (`team-tool-invoke.ts`). A connector
 * listed here accepts ANY ONE of the keys in each group in place of requiring them all — mirroring what
 * the connector spawner actually consumes. Snowflake authenticates with `account` plus EITHER an OAuth
 * token OR a key-pair JWT, never both (see `phase3AddSnowflakeMcp`), so requiring all three keys would
 * make every real Snowflake team entry fail closed with `team_secret_missing`. Keys NOT in any group
 * stay individually required (AND). All keys remain in `CONNECTOR_VAULT_SECRET_KEYS` (D11 + redaction).
 */
export const TEAM_SECRET_ANYOF_GROUPS: Partial<
  Record<ConnectorServiceId, readonly (readonly string[])[]>
> = {
  snowflake: [["snowflake.oauth_token", "snowflake.key_pair_jwt"]],
  // Phase 6 Slice 9 W1 — the bearer token is the team-shareable auth secret for the GitOps/ML write
  // connectors (the endpoint url/host stays AND-required alongside it). Enrolling marks the token as
  // the credential a team entry must carry for the I19 team-write path.
  argocd: [["argocd.token"]],
  flux: [["flux.token"]],
  mlflow: [["mlflow.token"]],
};

export async function clearConnectorVaultSecretKeys(
  vault: NimbusVault,
  id: ConnectorServiceId,
): Promise<string[]> {
  const keys = CONNECTOR_VAULT_SECRET_KEYS[id];
  await Promise.all(keys.map((k) => vault.delete(k)));
  return [...keys];
}
