import type { ExtensionManifest } from "../../extensions/manifest.ts";

const DEFAULT_DENY: ExtensionManifest["permissions"] = {
  network: [],
  filesystem: { read: [], write: [] },
};

function baseManifest(
  id: string,
  permissions: ExtensionManifest["permissions"],
): ExtensionManifest {
  return {
    id,
    version: "1.0.0",
    permissions,
    updateChannel: "stable",
  };
}

export const FIRST_PARTY_MANIFESTS: Record<string, ExtensionManifest> = {
  filesystem: baseManifest("com.nimbus.filesystem", DEFAULT_DENY),

  github: baseManifest("com.nimbus.github", {
    network: ["api.github.com", "uploads.github.com", "raw.githubusercontent.com"],
    filesystem: { read: [], write: [] },
  }),
  github_actions: baseManifest("com.nimbus.github-actions", {
    network: ["api.github.com"],
    filesystem: { read: [], write: [] },
  }),
  gitlab: baseManifest("com.nimbus.gitlab", {
    network: ["gitlab.com"],
    filesystem: { read: [], write: [] },
  }),
  bitbucket: baseManifest("com.nimbus.bitbucket", {
    network: ["api.bitbucket.org", "bitbucket.org"],
    filesystem: { read: [], write: [] },
  }),

  slack: baseManifest("com.nimbus.slack", {
    network: ["slack.com", "api.slack.com", "wss-primary.slack.com", "wss-backup.slack.com"],
    filesystem: { read: [], write: [] },
  }),
  discord: baseManifest("com.nimbus.discord", {
    network: ["discord.com", "gateway.discord.gg", "cdn.discordapp.com"],
    filesystem: { read: [], write: [] },
  }),

  linear: baseManifest("com.nimbus.linear", {
    network: ["api.linear.app"],
    filesystem: { read: [], write: [] },
  }),
  jira: baseManifest("com.nimbus.jira", {
    network: ["api.atlassian.com"],
    filesystem: { read: [], write: [] },
  }),
  notion: baseManifest("com.nimbus.notion", {
    network: ["api.notion.com"],
    filesystem: { read: [], write: [] },
  }),
  confluence: baseManifest("com.nimbus.confluence", {
    network: ["api.atlassian.com"],
    filesystem: { read: [], write: [] },
  }),

  google_drive: baseManifest("com.nimbus.google-drive", {
    network: ["www.googleapis.com", "oauth2.googleapis.com", "accounts.google.com"],
    filesystem: { read: [], write: [] },
  }),
  gmail: baseManifest("com.nimbus.gmail", {
    network: ["www.googleapis.com", "gmail.googleapis.com", "oauth2.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),
  google_photos: baseManifest("com.nimbus.google-photos", {
    network: ["www.googleapis.com", "photoslibrary.googleapis.com", "oauth2.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),
  google_meet: baseManifest("com.nimbus.google-meet", {
    network: ["www.googleapis.com", "meet.googleapis.com", "oauth2.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),

  onedrive: baseManifest("com.nimbus.onedrive", {
    network: ["graph.microsoft.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),
  outlook: baseManifest("com.nimbus.outlook", {
    network: ["graph.microsoft.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),
  teams: baseManifest("com.nimbus.teams", {
    network: ["graph.microsoft.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),

  jenkins: baseManifest("com.nimbus.jenkins", {
    network: [],
    filesystem: { read: [], write: [] },
  }),
  circleci: baseManifest("com.nimbus.circleci", {
    network: ["circleci.com", "api.circleci.com"],
    filesystem: { read: [], write: [] },
  }),
  pagerduty: baseManifest("com.nimbus.pagerduty", {
    network: ["api.pagerduty.com", "events.pagerduty.com"],
    filesystem: { read: [], write: [] },
  }),

  aws: baseManifest("com.nimbus.aws", {
    network: [
      "sts.amazonaws.com",
      "iam.amazonaws.com",
      "s3.amazonaws.com",
      "ec2.amazonaws.com",
      "cloudfront.amazonaws.com",
    ],
    filesystem: { read: [], write: [] },
  }),
  azure: baseManifest("com.nimbus.azure", {
    network: ["management.azure.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),
  gcp: baseManifest("com.nimbus.gcp", {
    network: ["cloudresourcemanager.googleapis.com", "oauth2.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),
  // BigQuery (Tier-3, metadata-only). Execs `gcloud` to mint an access token, then
  // calls the BigQuery REST metadata endpoints. Mirrors the gcp manifest's empty
  // filesystem shape (the sandbox permits exec of the wrapped command itself).
  bigquery: baseManifest("com.nimbus.bigquery", {
    network: ["bigquery.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),
  // Athena (Tier-3, metadata-only). Execs the `aws` CLI (which talks to the
  // regional `athena.<region>.amazonaws.com` endpoint + sts.amazonaws.com for
  // credential resolution). The Athena regional host is a concrete RFC-1123
  // hostname added per-region at spawn via manifestWithExtraNetworkHosts (the
  // RFC-1123 validator rejects the `athena.*.amazonaws.com` wildcard, like
  // Salesforce's per-tenant host). Mirrors the aws manifest's empty filesystem
  // shape (the sandbox permits exec of the wrapped `aws` command itself).
  athena: baseManifest("com.nimbus.athena", {
    network: ["sts.amazonaws.com"],
    filesystem: { read: [], write: [] },
  }),
  // CloudWatch (Tier-3, metadata-only). Execs the `aws` CLI (which talks to the
  // regional `logs.<region>.amazonaws.com` endpoint + sts.amazonaws.com for
  // credential resolution). The regional Logs host is a concrete RFC-1123 hostname
  // added per-region at spawn via manifestWithExtraNetworkHosts (the validator
  // rejects the `logs.*.amazonaws.com` wildcard, like Athena). Mirrors the aws
  // manifest's empty filesystem shape (the sandbox permits exec of the wrapped
  // `aws` command itself).
  cloudwatch: baseManifest("com.nimbus.cloudwatch", {
    network: ["sts.amazonaws.com"],
    filesystem: { read: [], write: [] },
  }),
  // SageMaker (Tier-3, metadata-only). Execs the `aws` CLI (which talks to the
  // regional `api.sagemaker.<region>.amazonaws.com` endpoint + sts.amazonaws.com
  // for credential resolution). The regional SageMaker host is a concrete RFC-1123
  // hostname added per-region at spawn via manifestWithExtraNetworkHosts (the
  // validator rejects the `api.sagemaker.*.amazonaws.com` wildcard, like Athena).
  // Mirrors the aws manifest's empty filesystem shape (the sandbox permits exec of
  // the wrapped `aws` command itself).
  sagemaker: baseManifest("com.nimbus.sagemaker", {
    network: ["sts.amazonaws.com"],
    filesystem: { read: [], write: [] },
  }),
  // Cloud Logging (Tier-3, metadata-only). Execs the `gcloud` CLI, which talks to
  // the Cloud Logging API to list routing SINK config metadata (NEVER log entries).
  // Mirrors the bigquery manifest's GCP network shape (logging.googleapis.com for
  // the API, oauth2/www.googleapis.com for credential resolution + discovery) and
  // the empty filesystem shape (the sandbox permits exec of the wrapped command).
  cloud_logging: baseManifest("com.nimbus.cloud-logging", {
    network: ["logging.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),
  iac: baseManifest("com.nimbus.iac", DEFAULT_DENY),

  grafana: baseManifest("com.nimbus.grafana", {
    network: [],
    filesystem: { read: [], write: [] },
  }),
  sentry: baseManifest("com.nimbus.sentry", {
    network: ["sentry.io"],
    filesystem: { read: [], write: [] },
  }),
  newrelic: baseManifest("com.nimbus.newrelic", {
    network: ["api.newrelic.com", "api.eu.newrelic.com"],
    filesystem: { read: [], write: [] },
  }),
  datadog: baseManifest("com.nimbus.datadog", {
    network: ["api.datadoghq.com"],
    filesystem: { read: [], write: [] },
  }),

  snyk: baseManifest("com.nimbus.snyk", {
    network: ["api.snyk.io"],
    filesystem: { read: [], write: [] },
  }),

  bitrise: baseManifest("com.nimbus.bitrise", {
    network: ["api.bitrise.io"],
    filesystem: { read: [], write: [] },
  }),

  sonarqube: baseManifest("com.nimbus.sonarqube", {
    network: ["sonarcloud.io"],
    filesystem: { read: [], write: [] },
  }),

  semgrep: baseManifest("com.nimbus.semgrep", {
    network: ["semgrep.dev"],
    filesystem: { read: [], write: [] },
  }),

  wiz: baseManifest("com.nimbus.wiz", {
    network: ["api.app.wiz.io", "auth.app.wiz.io"],
    filesystem: { read: [], write: [] },
  }),

  launchdarkly: baseManifest("com.nimbus.launchdarkly", {
    network: ["app.launchdarkly.com"],
    filesystem: { read: [], write: [] },
  }),

  flagsmith: baseManifest("com.nimbus.flagsmith", {
    network: ["api.flagsmith.com"],
    filesystem: { read: [], write: [] },
  }),

  argocd: baseManifest("com.nimbus.argocd", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  flux: baseManifest("com.nimbus.flux", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  dbt: baseManifest("com.nimbus.dbt", {
    network: ["cloud.getdbt.com"],
    filesystem: { read: [], write: [] },
  }),

  metabase: baseManifest("com.nimbus.metabase", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  superset: baseManifest("com.nimbus.superset", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  databricks: baseManifest("com.nimbus.databricks", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  mlflow: baseManifest("com.nimbus.mlflow", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  vercel: baseManifest("com.nimbus.vercel", {
    network: ["api.vercel.com"],
    filesystem: { read: [], write: [] },
  }),

  netlify: baseManifest("com.nimbus.netlify", {
    network: ["api.netlify.com"],
    filesystem: { read: [], write: [] },
  }),

  stripe: baseManifest("com.nimbus.stripe", {
    network: ["api.stripe.com"],
    filesystem: { read: [], write: [] },
  }),

  mercury: baseManifest("com.nimbus.mercury", {
    network: ["api.mercury.com"],
    filesystem: { read: [], write: [] },
  }),

  readwise: baseManifest("com.nimbus.readwise", {
    network: ["readwise.io"],
    filesystem: { read: [], write: [] },
  }),

  raindrop: baseManifest("com.nimbus.raindrop", {
    network: ["api.raindrop.io"],
    filesystem: { read: [], write: [] },
  }),

  intercom: baseManifest("com.nimbus.intercom", {
    network: ["api.intercom.io"],
    filesystem: { read: [], write: [] },
  }),

  zendesk: baseManifest("com.nimbus.zendesk", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  lever: baseManifest("com.nimbus.lever", {
    network: ["api.lever.co"],
    filesystem: { read: [], write: [] },
  }),

  greenhouse: baseManifest("com.nimbus.greenhouse", {
    network: ["harvest.greenhouse.io"],
    filesystem: { read: [], write: [] },
  }),

  pipedrive: baseManifest("com.nimbus.pipedrive", {
    network: ["api.pipedrive.com"],
    filesystem: { read: [], write: [] },
  }),

  stackoverflow: baseManifest("com.nimbus.stackoverflow", {
    network: ["api.stackoverflowteams.com"],
    filesystem: { read: [], write: [] },
  }),

  zotero: baseManifest("com.nimbus.zotero", {
    network: ["api.zotero.org"],
    filesystem: { read: [], write: [] },
  }),

  dependencytrack: baseManifest("com.nimbus.dependencytrack", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  elasticsearch: baseManifest("com.nimbus.elasticsearch", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  airflow: baseManifest("com.nimbus.airflow", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  prefect: baseManifest("com.nimbus.prefect", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  dagster: baseManifest("com.nimbus.dagster", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  ramp: baseManifest("com.nimbus.ramp", {
    network: ["api.ramp.com"],
    filesystem: { read: [], write: [] },
  }),

  kubernetes: baseManifest("com.nimbus.kubernetes", {
    network: [],
    filesystem: { read: [], write: [] },
  }),

  zoom: baseManifest("com.nimbus.zoom", {
    network: ["api.zoom.us", "zoom.us"],
    filesystem: { read: [], write: [] },
  }),

  hubspot: baseManifest("com.nimbus.hubspot", {
    network: ["api.hubapi.com"],
    filesystem: { read: [], write: [] },
  }),

  miro: baseManifest("com.nimbus.miro", {
    network: ["api.miro.com"],
    filesystem: { read: [], write: [] },
  }),

  canva: baseManifest("com.nimbus.canva", {
    network: ["api.canva.com"],
    filesystem: { read: [], write: [] },
  }),

  figma: baseManifest("com.nimbus.figma", {
    network: ["api.figma.com"],
    filesystem: { read: [], write: [] },
  }),

  salesforce: baseManifest("com.nimbus.salesforce", {
    // The per-tenant instance host (e.g. acme.my.salesforce.com) is discovered
    // at OAuth time and added to this manifest at spawn via
    // manifestWithExtraNetworkHosts. login.salesforce.com is the fixed
    // authorize/token host base.
    network: ["login.salesforce.com"],
    filesystem: { read: [], write: [] },
  }),

  obsidian: baseManifest("com.nimbus.obsidian", {
    network: [],
    filesystem: { read: [], write: [] },
  }),
};

export function manifestForFirstParty(serviceId: string): ExtensionManifest {
  const known = FIRST_PARTY_MANIFESTS[serviceId];
  if (known !== undefined) return known;
  return baseManifest(`com.nimbus.${serviceId}`, DEFAULT_DENY);
}

export function hostnameFromUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

export function manifestWithExtraNetworkHosts(
  serviceId: string,
  extraNetworkHosts: readonly string[],
): ExtensionManifest {
  const base = manifestForFirstParty(serviceId);
  if (extraNetworkHosts.length === 0) return base;
  const existing = new Set(base.permissions.network);
  const merged = [...base.permissions.network];
  for (const host of extraNetworkHosts) {
    const lower = host.toLowerCase().trim();
    if (lower === "" || existing.has(lower)) continue;
    existing.add(lower);
    merged.push(lower);
  }
  return {
    ...base,
    permissions: {
      network: merged,
      filesystem: {
        read: [...base.permissions.filesystem.read],
        write: [...base.permissions.filesystem.write],
      },
    },
  };
}
