import { stripTrailingSlashes } from "../../lib/strip-trailing-slashes.ts";

export type ConnectorFlags = {
  rest: string[];
  port?: number;
  scopes?: string[];
  token?: string;
  username?: string;
  apiBase?: string;
  /** Jira: the Atlassian cloud id (`--cloud-id`). */
  cloudId?: string;
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
  "--cloud-id": makeTrimmedAssign("--cloud-id", "cloudId"),
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

export function parseFlags(args: string[]): ConnectorFlags {
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
