import {
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_CLIENT_SECRET_HELP,
  SLACK_OAUTH_CLIENT_ID_HELP,
  ZOOM_OAUTH_CLIENT_ID_HELP,
  ZOOM_OAUTH_CLIENT_SECRET_HELP,
} from "../../auth/oauth-env-help-messages.ts";
import { type PKCEOptions, runPKCEFlow } from "../../auth/pkce.ts";
import { Config } from "../../config.ts";
import {
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
import type { ConnectorRpcHandlerContext, ConnectorRpcHit } from "./context.ts";

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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const path = typeof pathRaw === "string" && pathRaw.trim() !== "" ? pathRaw.trim() : "";
  if (path === "") {
    throw new ConnectorRpcError(
      -32602,
      "GCP requires a service account JSON key path (connector.auth gcp --credentials-json <path>)",
    );
  }
  await writeConnectorSecret(vault, "gcp", "credentials_json_path", path);
  const projRaw = rec?.["gcpProjectId"] ?? rec?.["projectId"];
  const proj = typeof projRaw === "string" && projRaw.trim() !== "" ? projRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
  const orgRaw = rec?.["sentryOrgSlug"] ?? rec?.["orgSlug"];
  const org = typeof orgRaw === "string" && orgRaw.trim() !== "" ? orgRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
  if (token === "") {
    throw new ConnectorRpcError(
      -32602,
      "New Relic requires a user API key (connector.auth newrelic --token …)",
    );
  }
  await writeConnectorSecret(vault, "newrelic", "api_key", token);
  const acctRaw = rec?.["newrelicAccountId"] ?? rec?.["accountId"];
  const acct = typeof acctRaw === "string" && acctRaw.trim() !== "" ? acctRaw.trim() : "";
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
  const api = typeof apiRaw === "string" && apiRaw.trim() !== "" ? apiRaw.trim() : "";
  const app = typeof appRaw === "string" && appRaw.trim() !== "" ? appRaw.trim() : "";
  if (api === "" || app === "") {
    throw new ConnectorRpcError(
      -32602,
      "Datadog requires API key and application key (connector.auth datadog …)",
    );
  }
  await writeConnectorSecret(vault, "datadog", "api_key", api);
  await writeConnectorSecret(vault, "datadog", "app_key", app);
  const siteRaw = rec?.["datadogSite"] ?? rec?.["site"];
  const site = typeof siteRaw === "string" && siteRaw.trim() !== "" ? siteRaw.trim() : "";
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
  const kubePath = typeof pathRaw === "string" && pathRaw.trim() !== "" ? pathRaw.trim() : "";
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
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const user = typeof userRaw === "string" && userRaw.trim() !== "" ? userRaw.trim() : "";
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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
  const user = typeof userRaw === "string" && userRaw.trim() !== "" ? userRaw.trim() : "";
  const tokenRaw = rec?.["personalAccessToken"] ?? rec?.["token"];
  const token = typeof tokenRaw === "string" && tokenRaw.trim() !== "" ? tokenRaw.trim() : "";
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

function oauthClientConfigForProvider(profile: ReturnType<typeof oauthProfileForService>): {
  clientId: string;
  emptyClientIdMessage: string;
} {
  switch (profile.provider) {
    case "google":
      return {
        clientId: Config.oauthGoogleClientId,
        emptyClientIdMessage: GOOGLE_OAUTH_CLIENT_ID_HELP,
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
      };
    case "zoom":
      return {
        clientId: Config.oauthZoomClientId,
        emptyClientIdMessage: ZOOM_OAUTH_CLIENT_ID_HELP,
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
): Promise<ConnectorRpcHit> {
  const profile = oauthProfileForService(id);
  const { clientId, emptyClientIdMessage } = oauthClientConfigForProvider(profile);
  if (clientId === "") {
    throw new ConnectorRpcError(-32602, emptyClientIdMessage);
  }
  const notionSecret = profile.provider === "notion" ? Config.oauthNotionClientSecret : undefined;
  if (profile.provider === "notion" && (notionSecret === undefined || notionSecret === "")) {
    throw new ConnectorRpcError(-32602, NOTION_OAUTH_CLIENT_SECRET_HELP);
  }
  const zoomSecret = profile.provider === "zoom" ? Config.oauthZoomClientSecret : undefined;
  if (profile.provider === "zoom" && (zoomSecret === undefined || zoomSecret === "")) {
    throw new ConnectorRpcError(-32602, ZOOM_OAUTH_CLIENT_SECRET_HELP);
  }
  const scopes = oauthScopesFromConnectorRequest(rec, profile.defaultScopes);
  const redirectPort = oauthRedirectPortFromRec(rec);

  const pkceBase: PKCEOptions = {
    clientId,
    scopes,
    provider: profile.provider,
    vault,
    openUrl,
  };
  let merged: PKCEOptions = pkceBase;
  if (profile.provider === "notion" && notionSecret !== undefined && notionSecret !== "") {
    merged = { ...merged, oauthClientSecret: notionSecret };
  } else if (profile.provider === "zoom" && zoomSecret !== undefined && zoomSecret !== "") {
    merged = { ...merged, oauthClientSecret: zoomSecret };
  } else if (profile.provider === "google" && Config.oauthGoogleClientSecret !== "") {
    merged = { ...merged, oauthClientSecret: Config.oauthGoogleClientSecret };
  }
  const pkceFlowInput: PKCEOptions =
    redirectPort === undefined ? merged : { ...merged, redirectPort };
  const tokens = await runPKCEFlow(pkceFlowInput);

  // Mirror the token to the per-service vault key so each connector reads
  // only its own key (scope isolation).
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
  return connectorAuthOAuthPkce(id, rec, vault, localIndex, openUrl);
}
