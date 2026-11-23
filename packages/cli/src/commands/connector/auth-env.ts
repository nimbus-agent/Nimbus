import { stripTrailingSlashes } from "../../lib/strip-trailing-slashes.ts";

export function firstEnvTrimmed(keys: readonly string[]): string {
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (v !== undefined && v !== "") {
      return v;
    }
  }
  return "";
}

export function resolveAtlassianSiteCredentials(opts: {
  username: string | undefined;
  token: string | undefined;
  apiBase: string | undefined;
  emailEnvKeys: readonly string[];
  tokenEnvKeys: readonly string[];
  baseEnvKeys: readonly string[];
  errEmail: string;
  errToken: string;
  errBase: string;
}): { email: string; token: string; base: string } {
  const mail = opts.username?.trim() || firstEnvTrimmed(opts.emailEnvKeys);
  if (mail === "") {
    throw new Error(opts.errEmail);
  }
  const apiTok = opts.token?.trim() || firstEnvTrimmed(opts.tokenEnvKeys);
  if (apiTok === "") {
    throw new Error(opts.errToken);
  }
  const baseRaw = opts.apiBase?.trim() || firstEnvTrimmed(opts.baseEnvKeys);
  if (baseRaw === "") {
    throw new Error(opts.errBase);
  }
  return { email: mail, token: apiTok, base: stripTrailingSlashes(baseRaw) };
}

export function requirePatFromFlagsOrEnv(
  token: string | undefined,
  envKeys: readonly string[],
  errMsg: string,
): string {
  const pat = token?.trim() || firstEnvTrimmed(envKeys);
  if (pat === "") {
    throw new Error(errMsg);
  }
  return pat;
}

export type ConnectorAuthParams = {
  service: string;
  port?: number;
  scopes?: string[];
  personalAccessToken?: string;
  bitbucketUsername?: string;
  username?: string;
  atlassianEmail?: string;
  /** PagerDuty: the e-mail of a valid PagerDuty user, sent as the `From` header on every write. */
  fromEmail?: string;
  /** Jira: the Atlassian cloud id the Operations alert tools need; optional on a cloud site. */
  cloudId?: string;
  apiBaseUrl?: string;
  kubeconfigPath?: string;
  context?: string;
  discordOptIn?: boolean;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsDefaultRegion?: string;
  awsProfile?: string;
  azureTenantId?: string;
  azureClientId?: string;
  azureClientSecret?: string;
  gcpCredentialsJsonPath?: string;
  gcpProjectId?: string;
  iacOptIn?: boolean;
  sentryOrgSlug?: string;
  sentryUrl?: string;
  newrelicAccountId?: string;
  datadogApiKey?: string;
  datadogAppKey?: string;
  datadogSite?: string;
};
