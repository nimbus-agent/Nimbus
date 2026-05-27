import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ConnectorServiceId } from "./connector-catalog.ts";

/** PAT / API keys cleared when removing a connector (OAuth keys use provider-wide clear elsewhere). */
export const CONNECTOR_VAULT_SECRET_KEYS = {
  google_drive: [],
  gmail: [],
  google_photos: [],
  onedrive: [],
  outlook: [],
  teams: [],
  slack: ["slack.oauth"],
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
  gcp: ["gcp.credentials_json_path", "gcp.project_id"],
  iac: ["iac.enabled"],
  grafana: ["grafana.url", "grafana.api_token"],
  sentry: ["sentry.auth_token", "sentry.org_slug", "sentry.url"],
  newrelic: ["newrelic.api_key", "newrelic.account_id"],
  datadog: ["datadog.api_key", "datadog.app_key", "datadog.site"],
  snyk: ["snyk.token"],
  bitrise: ["bitrise.token"],
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
