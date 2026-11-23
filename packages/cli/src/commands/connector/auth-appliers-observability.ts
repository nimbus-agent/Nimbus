import { stripTrailingSlashes } from "../../lib/strip-trailing-slashes.ts";
import { type ConnectorAuthParams, firstEnvTrimmed } from "./auth-env.ts";

export function applyGrafanaConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  apiBase: string | undefined,
): void {
  const base = apiBase?.trim() || firstEnvTrimmed(["NIMBUS_GRAFANA_URL", "GRAFANA_URL"]);
  const tok = token?.trim() || firstEnvTrimmed(["NIMBUS_GRAFANA_API_TOKEN", "GRAFANA_API_TOKEN"]);
  if (base === "") {
    throw new Error(
      "Grafana requires base URL: nimbus connector auth grafana --api-base https://grafana.example/ --token <api_token>",
    );
  }
  if (tok === "") {
    throw new Error("Grafana requires an API token (--token or NIMBUS_GRAFANA_API_TOKEN)");
  }
  p.apiBaseUrl = stripTrailingSlashes(base);
  p.personalAccessToken = tok;
}

export function applySentryConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  flags: { sentryOrg?: string; sentryUrl?: string },
): void {
  const tok = token?.trim() || firstEnvTrimmed(["NIMBUS_SENTRY_AUTH_TOKEN", "SENTRY_AUTH_TOKEN"]);
  const org = flags.sentryOrg?.trim() || firstEnvTrimmed(["NIMBUS_SENTRY_ORG", "SENTRY_ORG"]);
  if (tok === "" || org === "") {
    throw new Error(
      "Sentry requires --token and --sentry-org <slug> (or env NIMBUS_SENTRY_AUTH_TOKEN / NIMBUS_SENTRY_ORG)",
    );
  }
  p.personalAccessToken = tok;
  p.sentryOrgSlug = org;
  const surl = flags.sentryUrl?.trim() || firstEnvTrimmed(["NIMBUS_SENTRY_URL"]);
  if (surl !== "") {
    p.sentryUrl = stripTrailingSlashes(surl);
  }
}

export function applyNewrelicConnectorAuth(
  p: ConnectorAuthParams,
  token: string | undefined,
  flags: { newrelicAccountId?: string },
): void {
  const tok = token?.trim() || firstEnvTrimmed(["NIMBUS_NEW_RELIC_API_KEY", "NEW_RELIC_API_KEY"]);
  if (tok === "") {
    throw new Error("New Relic requires --token (or NIMBUS_NEW_RELIC_API_KEY / NEW_RELIC_API_KEY)");
  }
  p.personalAccessToken = tok;
  const acct = flags.newrelicAccountId?.trim() || firstEnvTrimmed(["NIMBUS_NEW_RELIC_ACCOUNT_ID"]);
  if (acct !== "") {
    p.newrelicAccountId = acct;
  }
}

export function applyDatadogConnectorAuth(
  p: ConnectorAuthParams,
  flags: {
    datadogApiKey?: string;
    datadogAppKey?: string;
    datadogSite?: string;
  },
): void {
  const api =
    flags.datadogApiKey?.trim() || firstEnvTrimmed(["NIMBUS_DATADOG_API_KEY", "DD_API_KEY"]);
  const app =
    flags.datadogAppKey?.trim() || firstEnvTrimmed(["NIMBUS_DATADOG_APP_KEY", "DD_APP_KEY"]);
  if (api === "" || app === "") {
    throw new Error(
      "Datadog requires --datadog-api-key and --datadog-app-key (or DD_API_KEY / DD_APP_KEY)",
    );
  }
  p.datadogApiKey = api;
  p.datadogAppKey = app;
  const site = flags.datadogSite?.trim() || firstEnvTrimmed(["NIMBUS_DATADOG_SITE", "DD_SITE"]);
  if (site !== "") {
    p.datadogSite = site;
  }
}
