// How each non-OAuth connector authenticates, in plain words (moved out of `connector-catalog.ts`, which is
// size-baselined; `oauthUnsupportedDetail` and `oauthProfileForService` there read it).
import type { ConnectorServiceId } from "./connector-catalog.ts";
import * as finops from "./finops-connector-catalog.ts";

export const OAUTH_UNSUPPORTED_DETAILS: Partial<Record<ConnectorServiceId, string>> = {
  github: "uses a PAT",
  github_actions: "uses the same PAT as github",
  github_billing: "uses the same PAT as github",
  openai_billing:
    "uses an OpenAI organization admin key (Vault only; read for the costs endpoint alone)",
  anthropic_billing:
    "uses an Anthropic organization admin key (Vault only; read for the cost report alone)",
  gitlab: "uses a PAT",
  gitlab_billing: "uses the same PAT as gitlab",
  bitbucket: "uses an Atlassian API token (app passwords are deprecated)",
  bitbucket_billing: "uses the same credential as bitbucket",
  linear: "uses an API key",
  jira: "uses email + API token + base URL",
  confluence: "uses email + API token + base URL",
  discord: "uses a bot token + opt-in",
  jenkins: "uses base URL + username + API token",
  circleci: "uses a personal API token",
  pagerduty: "uses a REST API token, plus the e-mail of a PagerDuty user for writes",
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
  unleash: "uses an admin or personal access token",
  split: "uses an Admin API key",
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
  ...finops.FINOPS_CREDENTIAL_HINTS,
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
