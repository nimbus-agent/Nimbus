import {
  applyAwsConnectorAuth,
  applyAzureConnectorAuth,
  applyGcpConnectorAuth,
  applyIacConnectorAuth,
  applyKubernetesConnectorAuth,
} from "./auth-appliers-cloud.ts";
import {
  applyDatadogConnectorAuth,
  applyGrafanaConnectorAuth,
  applyNewrelicConnectorAuth,
  applySentryConnectorAuth,
} from "./auth-appliers-observability.ts";
import {
  applyBitbucketConnectorAuth,
  applyCircleciConnectorAuth,
  applyConfluenceConnectorAuth,
  applyDiscordConnectorAuth,
  applyGithubConnectorAuth,
  applyGitlabConnectorAuth,
  applyJenkinsConnectorAuth,
  applyJiraConnectorAuth,
  applyLinearConnectorAuth,
  applyPagerdutyConnectorAuth,
} from "./auth-appliers-vcs.ts";
import type { ConnectorAuthParams } from "./auth-env.ts";
import type { ConnectorFlags } from "./flags.ts";

type ConnectorPatAuthParamApplier = (p: ConnectorAuthParams, f: ConnectorFlags) => void;

const CONNECTOR_AUTH_PARAM_APPLIERS: Record<string, ConnectorPatAuthParamApplier> = {
  linear: (p, f) => applyLinearConnectorAuth(p, f.token),
  github: (p, f) => applyGithubConnectorAuth(p, f.token, f.apiBase),
  circleci: (p, f) => applyCircleciConnectorAuth(p, f.token),
  pagerduty: (p, f) => applyPagerdutyConnectorAuth(p, f.token, f.username),
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
  jira: (p, f) => applyJiraConnectorAuth(p, f.token, f.username, f.apiBase, f.cloudId),
  confluence: (p, f) => applyConfluenceConnectorAuth(p, f.token, f.username, f.apiBase),
  jenkins: (p, f) => applyJenkinsConnectorAuth(p, f.token, f.username, f.apiBase),
};

export function applyConnectorAuthParamsForService(
  normalized: string,
  params: ConnectorAuthParams,
  f: ConnectorFlags,
): void {
  const applier = CONNECTOR_AUTH_PARAM_APPLIERS[normalized];
  if (applier !== undefined) {
    applier(params, f);
  }
}
