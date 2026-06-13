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
} as const satisfies {
  readonly [K in ConnectorServiceId]: readonly string[];
};

export async function clearConnectorVaultSecretKeys(
  vault: NimbusVault,
  id: ConnectorServiceId,
): Promise<string[]> {
  const keys = CONNECTOR_VAULT_SECRET_KEYS[id];
  await Promise.all(keys.map((k) => vault.delete(k)));
  return [...keys];
}
