import {
  CANVA_OAUTH_CLIENT_ID_HELP,
  CANVA_OAUTH_CLIENT_SECRET_HELP,
  FIGMA_OAUTH_CLIENT_ID_HELP,
  FIGMA_OAUTH_CLIENT_SECRET_HELP,
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  HUBSPOT_OAUTH_CLIENT_ID_HELP,
  HUBSPOT_OAUTH_CLIENT_SECRET_HELP,
  MENDELEY_OAUTH_CLIENT_ID_HELP,
  MENDELEY_OAUTH_CLIENT_SECRET_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
  MIRO_OAUTH_CLIENT_ID_HELP,
  MIRO_OAUTH_CLIENT_SECRET_HELP,
  NOTION_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_CLIENT_SECRET_HELP,
  SALESFORCE_OAUTH_CLIENT_ID_HELP,
  SALESFORCE_OAUTH_CLIENT_SECRET_HELP,
  SLACK_OAUTH_CLIENT_ID_HELP,
  WORKDAY_OAUTH_CLIENT_ID_HELP,
  WORKDAY_OAUTH_CLIENT_SECRET_HELP,
  ZOOM_OAUTH_CLIENT_ID_HELP,
  ZOOM_OAUTH_CLIENT_SECRET_HELP,
} from "../../auth/oauth-env-help-messages.ts";
import { OAUTH_PROVIDERS } from "../../auth/oauth-registry.ts";
import { type PKCEOptions, runPKCEFlow } from "../../auth/pkce.ts";
import { Config } from "../../config.ts";
import {
  type ConnectorOAuthProfile,
  type ConnectorServiceId,
  defaultSyncIntervalMsForService,
  oauthProfileForService,
} from "../../connectors/connector-catalog.ts";
import {
  deleteConnectorSecret,
  sharedOAuthKey,
  writeConnectorSecret,
  writePerServiceOAuthKey,
} from "../../connectors/connector-vault.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import { stripTrailingSlashes } from "../../string/strip-trailing-slashes.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  ConnectorRpcError,
  parseAtlassianSiteCredentials,
  parseServiceArg,
  registerAtlassianApiConnectorAuth,
} from "../connector-rpc-shared.ts";
import type {
  ConnectorRpcHandlerContext,
  ConnectorRpcHit,
  OAuthClientConfig,
  OAuthClientConfigResolver,
} from "./context.ts";

/** Returns the trimmed string value of `raw`, or `""` if it is not a non-empty string. */
function extractStringField(raw: unknown): string {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "";
}

function oauthScopesFromConnectorRequest(
  rec: Record<string, unknown> | undefined,
  defaultScopes: readonly string[],
): string[] {
  const scopeParam = rec?.["scopes"];
  if (!Array.isArray(scopeParam)) {
    return [...defaultScopes];
  }
  const next: string[] = [];
  for (const s of scopeParam) {
    if (typeof s === "string" && s.trim() !== "") {
      next.push(s.trim());
    }
  }
  return next.length > 0 ? next : [...defaultScopes];
}

function oauthRedirectPortFromRec(rec: Record<string, unknown> | undefined): number | undefined {
  const portRaw = rec?.["port"];
  if (
    typeof portRaw === "number" &&
    Number.isInteger(portRaw) &&
    portRaw > 0 &&
    portRaw <= 65_535
  ) {
    return portRaw;
  }
  return undefined;
}

function authSuccess(id: ConnectorServiceId): ConnectorRpcHit {
  return {
    kind: "hit",
    value: {
      ok: true,
      serviceId: id,
      scopesGranted: [] as string[],
    },
  };
}

async function connectorAuthGithub(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing personalAccessToken for github");
  }
  await writeConnectorSecret(vault, "github", "pat", token);
  const now = Date.now();
  const interval = defaultSyncIntervalMsForService("github");
  localIndex.ensureConnectorSchedulerRegistration("github", interval, now);
  const ghaInterval = defaultSyncIntervalMsForService("github_actions");
  localIndex.ensureConnectorSchedulerRegistration("github_actions", ghaInterval, now);
  return authSuccess("github");
}

async function connectorAuthGitlab(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing personalAccessToken for gitlab");
  }
  await writeConnectorSecret(vault, "gitlab", "pat", token);
  const baseRaw = rec?.["apiBaseUrl"] ?? rec?.["api_base"];
  if (typeof baseRaw === "string" && baseRaw.trim() !== "") {
    await writeConnectorSecret(vault, "gitlab", "api_base", stripTrailingSlashes(baseRaw.trim()));
  } else {
    await deleteConnectorSecret(vault, "gitlab", "api_base");
  }
  const interval = defaultSyncIntervalMsForService("gitlab");
  localIndex.ensureConnectorSchedulerRegistration("gitlab", interval, Date.now());
  return authSuccess("gitlab");
}

async function connectorAuthLinear(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"] ?? rec?.["apiKey"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing API key for linear");
  }
  await writeConnectorSecret(vault, "linear", "api_key", token);
  const interval = defaultSyncIntervalMsForService("linear");
  localIndex.ensureConnectorSchedulerRegistration("linear", interval, Date.now());
  return authSuccess("linear");
}

async function connectorAuthDiscord(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const opt =
    rec?.["discordOptIn"] === true ||
    rec?.["discordOptIn"] === "true" ||
    rec?.["discordOptIn"] === "1";
  if (!opt) {
    throw new ConnectorRpcError(
      -32602,
      "Discord is opt-in: use CLI `nimbus connector auth discord --token <bot_token> --enable`",
    );
  }
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing bot token for discord");
  }
  await writeConnectorSecret(vault, "discord", "bot_token", token);
  await writeConnectorSecret(vault, "discord", "enabled", "1");
  const interval = defaultSyncIntervalMsForService("discord");
  localIndex.ensureConnectorSchedulerRegistration("discord", interval, Date.now());
  return authSuccess("discord");
}

async function connectorAuthCircleci(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing API token for circleci");
  }
  await writeConnectorSecret(vault, "circleci", "api_token", token);
  const interval = defaultSyncIntervalMsForService("circleci");
  localIndex.ensureConnectorSchedulerRegistration("circleci", interval, Date.now());
  return authSuccess("circleci");
}

async function persistAwsAccessKeyPair(
  vault: NimbusVault,
  ak: string,
  sk: string,
  reg: string,
  prof: string,
): Promise<void> {
  if (reg === "" && prof === "") {
    throw new ConnectorRpcError(
      -32602,
      "AWS key pair requires a default region or profile (connector.auth aws --region … or --profile …)",
    );
  }
  await writeConnectorSecret(vault, "aws", "access_key_id", ak);
  await writeConnectorSecret(vault, "aws", "secret_access_key", sk);
  if (reg === "") {
    await deleteConnectorSecret(vault, "aws", "default_region");
  } else {
    await writeConnectorSecret(vault, "aws", "default_region", reg);
  }
  if (prof === "") {
    await deleteConnectorSecret(vault, "aws", "profile");
  } else {
    await writeConnectorSecret(vault, "aws", "profile", prof);
  }
}

async function persistAwsProfileOnly(vault: NimbusVault, prof: string): Promise<void> {
  await deleteConnectorSecret(vault, "aws", "access_key_id");
  await deleteConnectorSecret(vault, "aws", "secret_access_key");
  await deleteConnectorSecret(vault, "aws", "default_region");
  await writeConnectorSecret(vault, "aws", "profile", prof);
}

async function connectorAuthAws(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const akRaw = rec?.["awsAccessKeyId"] ?? rec?.["accessKeyId"];
  const skRaw = rec?.["awsSecretAccessKey"] ?? rec?.["secretAccessKey"];
  const regRaw = rec?.["awsDefaultRegion"] ?? rec?.["defaultRegion"];
  const profRaw = rec?.["awsProfile"] ?? rec?.["profile"];
  const ak = typeof akRaw === "string" ? akRaw.trim() : "";
  const sk = typeof skRaw === "string" ? skRaw.trim() : "";
  const reg = typeof regRaw === "string" ? regRaw.trim() : "";
  const prof = typeof profRaw === "string" ? profRaw.trim() : "";

  const hasKeyPair = ak !== "" && sk !== "";
  if (hasKeyPair) {
    await persistAwsAccessKeyPair(vault, ak, sk, reg, prof);
  } else {
    if (prof === "") {
      throw new ConnectorRpcError(
        -32602,
        "Missing AWS credentials: access key + secret + region/profile, or profile-only (connector.auth aws …)",
      );
    }
    await persistAwsProfileOnly(vault, prof);
  }
  const interval = defaultSyncIntervalMsForService("aws");
  localIndex.ensureConnectorSchedulerRegistration("aws", interval, Date.now());
  return authSuccess("aws");
}

async function connectorAuthAzure(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tRaw = rec?.["azureTenantId"] ?? rec?.["tenantId"];
  const cRaw = rec?.["azureClientId"] ?? rec?.["clientId"];
  const sRaw = rec?.["azureClientSecret"] ?? rec?.["clientSecret"];
  const tenant = typeof tRaw === "string" ? tRaw.trim() : "";
  const clientId = typeof cRaw === "string" ? cRaw.trim() : "";
  const secret = typeof sRaw === "string" ? sRaw.trim() : "";
  if (tenant === "" || clientId === "" || secret === "") {
    throw new ConnectorRpcError(
      -32602,
      "Azure requires tenant id, client id, and client secret (connector.auth azure …)",
    );
  }
  await writeConnectorSecret(vault, "azure", "tenant_id", tenant);
  await writeConnectorSecret(vault, "azure", "client_id", clientId);
  await writeConnectorSecret(vault, "azure", "client_secret", secret);
  const interval = defaultSyncIntervalMsForService("azure");
  localIndex.ensureConnectorSchedulerRegistration("azure", interval, Date.now());
  return authSuccess("azure");
}

async function connectorAuthGcp(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const pathRaw = rec?.["gcpCredentialsJsonPath"] ?? rec?.["credentialsJsonPath"] ?? rec?.["path"];
  const path = extractStringField(pathRaw);
  if (path === "") {
    throw new ConnectorRpcError(
      -32602,
      "GCP requires a service account JSON key path (connector.auth gcp --credentials-json <path>)",
    );
  }
  await writeConnectorSecret(vault, "gcp", "credentials_json_path", path);
  const projRaw = rec?.["gcpProjectId"] ?? rec?.["projectId"];
  const proj = extractStringField(projRaw);
  if (proj === "") {
    await deleteConnectorSecret(vault, "gcp", "project_id");
  } else {
    await writeConnectorSecret(vault, "gcp", "project_id", proj);
  }
  const interval = defaultSyncIntervalMsForService("gcp");
  localIndex.ensureConnectorSchedulerRegistration("gcp", interval, Date.now());
  return authSuccess("gcp");
}

async function connectorAuthIac(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const opt =
    rec?.["iacOptIn"] === true || rec?.["iacOptIn"] === "true" || rec?.["iacOptIn"] === "1";
  if (!opt) {
    throw new ConnectorRpcError(
      -32602,
      "IaC connector is opt-in: nimbus connector auth iac --enable",
    );
  }
  await writeConnectorSecret(vault, "iac", "enabled", "1");
  const interval = defaultSyncIntervalMsForService("iac");
  localIndex.ensureConnectorSchedulerRegistration("iac", interval, Date.now());
  return authSuccess("iac");
}

async function connectorAuthGrafana(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const baseRaw = rec?.["apiBaseUrl"] ?? rec?.["grafanaUrl"] ?? rec?.["url"];
  const base =
    typeof baseRaw === "string" && baseRaw.trim() !== ""
      ? stripTrailingSlashes(baseRaw.trim())
      : "";
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (base === "") {
    throw new ConnectorRpcError(
      -32602,
      "Grafana requires base URL (connector.auth grafana --api-base https://grafana.example/)",
    );
  }
  if (token === "") {
    throw new ConnectorRpcError(
      -32602,
      "Grafana requires an API token (connector.auth grafana --token …)",
    );
  }
  await writeConnectorSecret(vault, "grafana", "url", base);
  await writeConnectorSecret(vault, "grafana", "api_token", token);
  const interval = defaultSyncIntervalMsForService("grafana");
  localIndex.ensureConnectorSchedulerRegistration("grafana", interval, Date.now());
  return authSuccess("grafana");
}

async function connectorAuthSentry(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  const orgRaw = rec?.["sentryOrgSlug"] ?? rec?.["orgSlug"];
  const org = extractStringField(orgRaw);
  if (token === "" || org === "") {
    throw new ConnectorRpcError(
      -32602,
      "Sentry requires auth token and org slug (connector.auth sentry --token … --org …)",
    );
  }
  await writeConnectorSecret(vault, "sentry", "auth_token", token);
  await writeConnectorSecret(vault, "sentry", "org_slug", org);
  const urlRaw = rec?.["sentryUrl"] ?? rec?.["apiBaseUrl"];
  const surl =
    typeof urlRaw === "string" && urlRaw.trim() !== "" ? stripTrailingSlashes(urlRaw.trim()) : "";
  if (surl === "") {
    await deleteConnectorSecret(vault, "sentry", "url");
  } else {
    await writeConnectorSecret(vault, "sentry", "url", surl);
  }
  const interval = defaultSyncIntervalMsForService("sentry");
  localIndex.ensureConnectorSchedulerRegistration("sentry", interval, Date.now());
  return authSuccess("sentry");
}

async function connectorAuthNewrelic(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(
      -32602,
      "New Relic requires a user API key (connector.auth newrelic --token …)",
    );
  }
  await writeConnectorSecret(vault, "newrelic", "api_key", token);
  const acctRaw = rec?.["newrelicAccountId"] ?? rec?.["accountId"];
  const acct = extractStringField(acctRaw);
  if (acct === "") {
    await deleteConnectorSecret(vault, "newrelic", "account_id");
  } else {
    await writeConnectorSecret(vault, "newrelic", "account_id", acct);
  }
  const interval = defaultSyncIntervalMsForService("newrelic");
  localIndex.ensureConnectorSchedulerRegistration("newrelic", interval, Date.now());
  return authSuccess("newrelic");
}

async function connectorAuthDatadog(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const apiRaw = rec?.["datadogApiKey"] ?? rec?.["apiKey"];
  const appRaw = rec?.["datadogAppKey"] ?? rec?.["appKey"];
  const api = extractStringField(apiRaw);
  const app = extractStringField(appRaw);
  if (api === "" || app === "") {
    throw new ConnectorRpcError(
      -32602,
      "Datadog requires API key and application key (connector.auth datadog …)",
    );
  }
  await writeConnectorSecret(vault, "datadog", "api_key", api);
  await writeConnectorSecret(vault, "datadog", "app_key", app);
  const siteRaw = rec?.["datadogSite"] ?? rec?.["site"];
  const site = extractStringField(siteRaw);
  if (site === "") {
    await deleteConnectorSecret(vault, "datadog", "site");
  } else {
    await writeConnectorSecret(vault, "datadog", "site", site);
  }
  const interval = defaultSyncIntervalMsForService("datadog");
  localIndex.ensureConnectorSchedulerRegistration("datadog", interval, Date.now());
  return authSuccess("datadog");
}

async function connectorAuthKubernetes(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const pathRaw = rec?.["kubeconfigPath"] ?? rec?.["kubeconfig"] ?? rec?.["path"];
  const kubePath = extractStringField(pathRaw);
  if (kubePath === "") {
    throw new ConnectorRpcError(
      -32602,
      "Kubernetes requires kubeconfig path: connector.auth kubernetes --kubeconfig <path>",
    );
  }
  await writeConnectorSecret(vault, "kubernetes", "kubeconfig", kubePath);
  const ctxRaw = rec?.["context"];
  if (typeof ctxRaw === "string" && ctxRaw.trim() !== "") {
    await writeConnectorSecret(vault, "kubernetes", "context", ctxRaw.trim());
  } else {
    await deleteConnectorSecret(vault, "kubernetes", "context");
  }
  const interval = defaultSyncIntervalMsForService("kubernetes");
  localIndex.ensureConnectorSchedulerRegistration("kubernetes", interval, Date.now());
  return authSuccess("kubernetes");
}

async function connectorAuthPagerduty(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing API token for pagerduty");
  }
  await writeConnectorSecret(vault, "pagerduty", "api_token", token);
  const interval = defaultSyncIntervalMsForService("pagerduty");
  localIndex.ensureConnectorSchedulerRegistration("pagerduty", interval, Date.now());
  return authSuccess("pagerduty");
}

async function connectorAuthJenkins(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const baseRaw = rec?.["apiBaseUrl"] ?? rec?.["baseUrl"];
  const base =
    typeof baseRaw === "string" && baseRaw.trim() !== ""
      ? stripTrailingSlashes(baseRaw.trim())
      : "";
  if (base === "") {
    throw new ConnectorRpcError(
      -32602,
      "Jenkins requires --api-base <url> (e.g. https://ci.example/)",
    );
  }
  const userRaw = rec?.["username"];
  const user = extractStringField(userRaw);
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (user === "") {
    throw new ConnectorRpcError(-32602, "Jenkins requires --username <jenkins_user>");
  }
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Jenkins requires --token <api_token>");
  }
  await writeConnectorSecret(vault, "jenkins", "base_url", base);
  await writeConnectorSecret(vault, "jenkins", "username", user);
  await writeConnectorSecret(vault, "jenkins", "api_token", token);
  const interval = defaultSyncIntervalMsForService("jenkins");
  localIndex.ensureConnectorSchedulerRegistration("jenkins", interval, Date.now());
  return authSuccess("jenkins");
}

async function connectorAuthBitbucket(
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<ConnectorRpcHit> {
  const userRaw = rec?.["bitbucketUsername"] ?? rec?.["username"];
  const user = extractStringField(userRaw);
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = extractStringField(tokenRaw);
  if (user === "") {
    throw new ConnectorRpcError(-32602, "Missing username for bitbucket (Atlassian account)");
  }
  if (token === "") {
    throw new ConnectorRpcError(-32602, "Missing app password for bitbucket (use token field)");
  }
  await writeConnectorSecret(vault, "bitbucket", "username", user);
  await writeConnectorSecret(vault, "bitbucket", "app_password", token);
  const interval = defaultSyncIntervalMsForService("bitbucket");
  localIndex.ensureConnectorSchedulerRegistration("bitbucket", interval, Date.now());
  return authSuccess("bitbucket");
}

/**
 * The `Config`-backed resolver: one arm per OAuth provider.
 *
 * Exported so the per-provider arms can be asserted directly. Reaching them through
 * `handleConnectorAuth` instead means relying on every client id being empty, which is
 * a property of the developer's environment rather than of this switch — and when it
 * does not hold, the call falls through into a real PKCE round-trip (issue #812).
 */
export function oauthClientConfigForProvider(profile: ConnectorOAuthProfile): OAuthClientConfig {
  switch (profile.provider) {
    case "google":
      return {
        clientId: Config.oauthGoogleClientId,
        emptyClientIdMessage: GOOGLE_OAUTH_CLIENT_ID_HELP,
        ...(Config.oauthGoogleClientSecret === ""
          ? {}
          : { clientSecret: Config.oauthGoogleClientSecret }),
      };
    case "microsoft":
      return {
        clientId: Config.oauthMicrosoftClientId,
        emptyClientIdMessage: MICROSOFT_OAUTH_CLIENT_ID_HELP,
      };
    case "slack":
      return {
        clientId: Config.oauthSlackClientId,
        emptyClientIdMessage: SLACK_OAUTH_CLIENT_ID_HELP,
      };
    case "notion":
      return {
        clientId: Config.oauthNotionClientId,
        emptyClientIdMessage: NOTION_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthNotionClientSecret,
        clientSecretMissingHelp: NOTION_OAUTH_CLIENT_SECRET_HELP,
      };
    case "zoom":
      return {
        clientId: Config.oauthZoomClientId,
        emptyClientIdMessage: ZOOM_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthZoomClientSecret,
        clientSecretMissingHelp: ZOOM_OAUTH_CLIENT_SECRET_HELP,
      };
    case "hubspot":
      return {
        clientId: Config.oauthHubspotClientId,
        emptyClientIdMessage: HUBSPOT_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthHubspotClientSecret,
        clientSecretMissingHelp: HUBSPOT_OAUTH_CLIENT_SECRET_HELP,
      };
    case "miro":
      return {
        clientId: Config.oauthMiroClientId,
        emptyClientIdMessage: MIRO_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthMiroClientSecret,
        clientSecretMissingHelp: MIRO_OAUTH_CLIENT_SECRET_HELP,
      };
    case "canva":
      return {
        clientId: Config.oauthCanvaClientId,
        emptyClientIdMessage: CANVA_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthCanvaClientSecret,
        clientSecretMissingHelp: CANVA_OAUTH_CLIENT_SECRET_HELP,
      };
    case "figma":
      return {
        clientId: Config.oauthFigmaClientId,
        emptyClientIdMessage: FIGMA_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthFigmaClientSecret,
        clientSecretMissingHelp: FIGMA_OAUTH_CLIENT_SECRET_HELP,
      };
    case "salesforce":
      return {
        clientId: Config.oauthSalesforceClientId,
        emptyClientIdMessage: SALESFORCE_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthSalesforceClientSecret,
        clientSecretMissingHelp: SALESFORCE_OAUTH_CLIENT_SECRET_HELP,
      };
    case "mendeley":
      return {
        clientId: Config.oauthMendeleyClientId,
        emptyClientIdMessage: MENDELEY_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthMendeleyClientSecret,
        clientSecretMissingHelp: MENDELEY_OAUTH_CLIENT_SECRET_HELP,
      };
    case "workday":
      return {
        clientId: Config.oauthWorkdayClientId,
        emptyClientIdMessage: WORKDAY_OAUTH_CLIENT_ID_HELP,
        clientSecret: Config.oauthWorkdayClientSecret,
        clientSecretMissingHelp: WORKDAY_OAUTH_CLIENT_SECRET_HELP,
      };
    default: {
      const _ex: never = profile.provider;
      throw new ConnectorRpcError(-32602, `Unsupported OAuth provider: ${_ex}`);
    }
  }
}

async function connectorAuthOAuthPkce(
  id: ConnectorServiceId,
  rec: Record<string, unknown> | undefined,
  vault: NimbusVault,
  localIndex: LocalIndex,
  openUrl: (url: string) => Promise<void>,
  // Required, not defaulted. `handleConnectorAuth` is the only caller and already resolves the
  // fallback; a default here would duplicate that and be permanently unreachable — dead code
  // that reads like a safety net.
  resolveClientConfig: OAuthClientConfigResolver,
): Promise<ConnectorRpcHit> {
  const profile = oauthProfileForService(id);
  const config = resolveClientConfig(profile);
  if (config.clientId === "") {
    throw new ConnectorRpcError(-32602, config.emptyClientIdMessage);
  }
  if (
    OAUTH_PROVIDERS[profile.provider].clientSecret === "required" &&
    (config.clientSecret === undefined || config.clientSecret === "")
  ) {
    throw new ConnectorRpcError(
      -32602,
      config.clientSecretMissingHelp ?? `Missing OAuth client secret for ${profile.provider}`,
    );
  }
  const scopes = oauthScopesFromConnectorRequest(rec, profile.defaultScopes);
  const redirectPort = oauthRedirectPortFromRec(rec);

  const pkceBase: PKCEOptions = {
    clientId: config.clientId,
    scopes,
    provider: profile.provider,
    vault,
    openUrl,
  };
  const merged: PKCEOptions =
    config.clientSecret !== undefined && config.clientSecret !== ""
      ? { ...pkceBase, oauthClientSecret: config.clientSecret }
      : pkceBase;
  const pkceFlowInput: PKCEOptions =
    redirectPort === undefined ? merged : { ...merged, redirectPort };
  const tokens = await runPKCEFlow(pkceFlowInput);

  let sharedKey: string | undefined;
  if (profile.provider === "google") {
    sharedKey = sharedOAuthKey("google");
  } else if (profile.provider === "microsoft") {
    sharedKey = sharedOAuthKey("microsoft");
  }
  if (sharedKey !== undefined) {
    await writePerServiceOAuthKey(vault, id, sharedKey);
  }

  const interval = defaultSyncIntervalMsForService(id);
  localIndex.ensureConnectorSchedulerRegistration(id, interval, Date.now());

  return {
    kind: "hit",
    value: {
      ok: true,
      serviceId: id,
      scopesGranted: tokens.scopes,
    },
  };
}

type PatConnectorAuthHandler = (ctx: ConnectorRpcHandlerContext) => Promise<ConnectorRpcHit>;

const PAT_CONNECTOR_AUTH_HANDLERS: Partial<Record<ConnectorServiceId, PatConnectorAuthHandler>> = {
  github: (c) => connectorAuthGithub(c.rec, c.vault, c.localIndex),
  gitlab: (c) => connectorAuthGitlab(c.rec, c.vault, c.localIndex),
  linear: (c) => connectorAuthLinear(c.rec, c.vault, c.localIndex),
  bitbucket: (c) => connectorAuthBitbucket(c.rec, c.vault, c.localIndex),
  discord: (c) => connectorAuthDiscord(c.rec, c.vault, c.localIndex),
  jenkins: (c) => connectorAuthJenkins(c.rec, c.vault, c.localIndex),
  circleci: (c) => connectorAuthCircleci(c.rec, c.vault, c.localIndex),
  pagerduty: (c) => connectorAuthPagerduty(c.rec, c.vault, c.localIndex),
  kubernetes: (c) => connectorAuthKubernetes(c.rec, c.vault, c.localIndex),
  aws: (c) => connectorAuthAws(c.rec, c.vault, c.localIndex),
  azure: (c) => connectorAuthAzure(c.rec, c.vault, c.localIndex),
  gcp: (c) => connectorAuthGcp(c.rec, c.vault, c.localIndex),
  iac: (c) => connectorAuthIac(c.rec, c.vault, c.localIndex),
  grafana: (c) => connectorAuthGrafana(c.rec, c.vault, c.localIndex),
  sentry: (c) => connectorAuthSentry(c.rec, c.vault, c.localIndex),
  newrelic: (c) => connectorAuthNewrelic(c.rec, c.vault, c.localIndex),
  datadog: (c) => connectorAuthDatadog(c.rec, c.vault, c.localIndex),
  jira: async (c) => {
    const creds = parseAtlassianSiteCredentials(c.rec, {
      missingEmail: "Missing Atlassian account email for jira (atlassianEmail)",
      missingToken: "Missing API token for jira",
      missingBase:
        "Missing Jira site base URL for jira (apiBaseUrl), e.g. https://your-domain.atlassian.net",
    });
    const value = await registerAtlassianApiConnectorAuth({
      vault: c.vault,
      localIndex: c.localIndex,
      serviceId: "jira",
      creds,
    });
    return { kind: "hit", value };
  },
  confluence: async (c) => {
    const creds = parseAtlassianSiteCredentials(c.rec, {
      missingEmail: "Missing Atlassian account email for confluence (atlassianEmail)",
      missingToken: "Missing API token for confluence",
      missingBase:
        "Missing Confluence site base URL (apiBaseUrl), e.g. https://your-domain.atlassian.net",
    });
    const value = await registerAtlassianApiConnectorAuth({
      vault: c.vault,
      localIndex: c.localIndex,
      serviceId: "confluence",
      creds,
    });
    return { kind: "hit", value };
  },
};

export async function handleConnectorAuth(
  ctx: ConnectorRpcHandlerContext,
): Promise<ConnectorRpcHit> {
  const { rec, vault, localIndex, openUrl } = ctx;
  const id = parseServiceArg(rec);
  const patHandler = PAT_CONNECTOR_AUTH_HANDLERS[id];
  if (patHandler !== undefined) {
    return patHandler(ctx);
  }
  return connectorAuthOAuthPkce(
    id,
    rec,
    vault,
    localIndex,
    openUrl,
    ctx.resolveOAuthClientConfig ?? oauthClientConfigForProvider,
  );
}
