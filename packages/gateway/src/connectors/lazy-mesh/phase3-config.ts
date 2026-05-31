import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { mcpConnectorServerScript } from "./keys.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, sandboxCwd: string): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), sandboxCwd);
}

export async function phase3AddAwsMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const ak = (await readConnectorSecret(vault, "aws", "access_key_id"))?.trim() ?? "";
  const sk = (await readConnectorSecret(vault, "aws", "secret_access_key"))?.trim() ?? "";
  const reg = (await readConnectorSecret(vault, "aws", "default_region"))?.trim() ?? "";
  const prof = (await readConnectorSecret(vault, "aws", "profile"))?.trim() ?? "";
  const awsOk =
    (ak !== "" && sk !== "" && (reg !== "" || prof !== "")) || (prof !== "" && ak === "");
  if (!awsOk) {
    return;
  }
  const extra: Record<string, string> = {};
  if (ak !== "") {
    extra["AWS_ACCESS_KEY_ID"] = ak;
  }
  if (sk !== "") {
    extra["AWS_SECRET_ACCESS_KEY"] = sk;
  }
  if (reg !== "") {
    extra["AWS_DEFAULT_REGION"] = reg;
  }
  if (prof !== "") {
    extra["AWS_PROFILE"] = prof;
  }
  servers["aws"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("aws")],
      env: extensionProcessEnv(extra),
    },
    "aws",
    sandboxCwd,
  );
}

export async function phase3AddAzureMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const azT = (await readConnectorSecret(vault, "azure", "tenant_id"))?.trim() ?? "";
  const azC = (await readConnectorSecret(vault, "azure", "client_id"))?.trim() ?? "";
  const azS = (await readConnectorSecret(vault, "azure", "client_secret"))?.trim() ?? "";
  if (azT === "" || azC === "" || azS === "") {
    return;
  }
  servers["azure"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("azure")],
      env: extensionProcessEnv({
        AZURE_TENANT_ID: azT,
        AZURE_CLIENT_ID: azC,
        AZURE_CLIENT_SECRET: azS,
      }),
    },
    "azure",
    sandboxCwd,
  );
}

export async function phase3AddGcpMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const gcpPath = (await readConnectorSecret(vault, "gcp", "credentials_json_path"))?.trim() ?? "";
  if (gcpPath === "") {
    return;
  }
  servers["gcp"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("gcp")],
      env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: gcpPath }),
    },
    "gcp",
    sandboxCwd,
  );
}

export async function phase3AddIacMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const iacEn = await readConnectorSecret(vault, "iac", "enabled");
  if (iacEn !== "1") {
    return;
  }
  servers["iac"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("iac")],
      env: extensionProcessEnv({}),
    },
    "iac",
    sandboxCwd,
  );
}

export async function phase3AddGrafanaMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const gfu = (await readConnectorSecret(vault, "grafana", "url"))?.trim() ?? "";
  const gtk = (await readConnectorSecret(vault, "grafana", "api_token"))?.trim() ?? "";
  if (gfu === "" || gtk === "") {
    return;
  }
  const grafanaHost = hostnameFromUrl(gfu);
  const grafanaManifest = manifestWithExtraNetworkHosts(
    "grafana",
    grafanaHost === null ? [] : [grafanaHost],
  );
  servers["grafana"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("grafana")],
      env: extensionProcessEnv({ GRAFANA_URL: gfu, GRAFANA_API_TOKEN: gtk }),
    },
    grafanaManifest,
    sandboxCwd,
  );
}

export async function phase3AddSentryMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const sentTok = (await readConnectorSecret(vault, "sentry", "auth_token"))?.trim() ?? "";
  const sentOrg = (await readConnectorSecret(vault, "sentry", "org_slug"))?.trim() ?? "";
  if (sentTok === "" || sentOrg === "") {
    return;
  }
  const extra: Record<string, string> = {
    SENTRY_AUTH_TOKEN: sentTok,
    SENTRY_ORG_SLUG: sentOrg,
  };
  const surl = (await readConnectorSecret(vault, "sentry", "url"))?.trim() ?? "";
  if (surl !== "") {
    extra["SENTRY_URL"] = surl;
  }
  servers["sentry"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("sentry")],
      env: extensionProcessEnv(extra),
    },
    "sentry",
    sandboxCwd,
  );
}

export async function phase3AddNewrelicMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const nrKey = (await readConnectorSecret(vault, "newrelic", "api_key"))?.trim() ?? "";
  if (nrKey === "") {
    return;
  }
  servers["newrelic"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("newrelic")],
      env: extensionProcessEnv({ NEW_RELIC_API_KEY: nrKey }),
    },
    "newrelic",
    sandboxCwd,
  );
}

export async function phase3AddDatadogMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const ddKey = (await readConnectorSecret(vault, "datadog", "api_key"))?.trim() ?? "";
  const ddApp = (await readConnectorSecret(vault, "datadog", "app_key"))?.trim() ?? "";
  if (ddKey === "" || ddApp === "") {
    return;
  }
  const extra: Record<string, string> = {
    DD_API_KEY: ddKey,
    DD_APP_KEY: ddApp,
  };
  const site = (await readConnectorSecret(vault, "datadog", "site"))?.trim() ?? "";
  if (site !== "") {
    extra["DD_SITE"] = site;
  }
  servers["datadog"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("datadog")],
      env: extensionProcessEnv(extra),
    },
    "datadog",
    sandboxCwd,
  );
}

export async function phase3AddSnykMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "snyk", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  servers["snyk"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("snyk")],
      env: extensionProcessEnv({ SNYK_TOKEN: tok }),
    },
    "snyk",
    sandboxCwd,
  );
}

export async function phase3AddBitriseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "bitrise", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  servers["bitrise"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("bitrise")],
      env: extensionProcessEnv({ BITRISE_TOKEN: tok }),
    },
    "bitrise",
    sandboxCwd,
  );
}

export async function phase3AddSonarqubeMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "sonarqube", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  const url = (await readConnectorSecret(vault, "sonarqube", "url"))?.trim() ?? "";
  const organization =
    (await readConnectorSecret(vault, "sonarqube", "organization"))?.trim() ?? "";
  servers["sonarqube"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("sonarqube")],
      env: extensionProcessEnv({
        SONARQUBE_TOKEN: tok,
        ...(url === "" ? {} : { SONARQUBE_URL: url }),
        ...(organization === "" ? {} : { SONARQUBE_ORGANIZATION: organization }),
      }),
    },
    "sonarqube",
    sandboxCwd,
  );
}

export async function phase3AddSemgrepMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "semgrep", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  const slug = (await readConnectorSecret(vault, "semgrep", "deployment_slug"))?.trim() ?? "";
  servers["semgrep"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("semgrep")],
      env: extensionProcessEnv({
        SEMGREP_TOKEN: tok,
        ...(slug === "" ? {} : { SEMGREP_DEPLOYMENT_SLUG: slug }),
      }),
    },
    "semgrep",
    sandboxCwd,
  );
}

export async function phase3AddWizMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const clientId = (await readConnectorSecret(vault, "wiz", "client_id"))?.trim() ?? "";
  const clientSecret = (await readConnectorSecret(vault, "wiz", "client_secret"))?.trim() ?? "";
  if (clientId === "" || clientSecret === "") {
    return;
  }
  const apiUrl = (await readConnectorSecret(vault, "wiz", "api_url"))?.trim() ?? "";
  const authUrl = (await readConnectorSecret(vault, "wiz", "auth_url"))?.trim() ?? "";
  servers["wiz"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("wiz")],
      env: extensionProcessEnv({
        WIZ_CLIENT_ID: clientId,
        WIZ_CLIENT_SECRET: clientSecret,
        ...(apiUrl === "" ? {} : { WIZ_API_URL: apiUrl }),
        ...(authUrl === "" ? {} : { WIZ_AUTH_URL: authUrl }),
      }),
    },
    "wiz",
    sandboxCwd,
  );
}

export async function phase3AddLaunchdarklyMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "launchdarkly", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  const baseUrl = (await readConnectorSecret(vault, "launchdarkly", "base_url"))?.trim() ?? "";
  servers["launchdarkly"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("launchdarkly")],
      env: extensionProcessEnv({
        LAUNCHDARKLY_TOKEN: tok,
        ...(baseUrl === "" ? {} : { LAUNCHDARKLY_BASE_URL: baseUrl }),
      }),
    },
    "launchdarkly",
    sandboxCwd,
  );
}

export async function phase3AddFlagsmithMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "flagsmith", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  const apiBase = (await readConnectorSecret(vault, "flagsmith", "api_base"))?.trim() ?? "";
  servers["flagsmith"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("flagsmith")],
      env: extensionProcessEnv({
        FLAGSMITH_TOKEN: tok,
        ...(apiBase === "" ? {} : { FLAGSMITH_API_BASE: apiBase }),
      }),
    },
    "flagsmith",
    sandboxCwd,
  );
}

export async function phase3AddArgocdMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "argocd", "url"))?.trim() ?? "";
  const tok = (await readConnectorSecret(vault, "argocd", "token"))?.trim() ?? "";
  if (url === "" || tok === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("argocd", host === null ? [] : [host]);
  servers["argocd"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("argocd")],
      env: extensionProcessEnv({ ARGOCD_URL: url, ARGOCD_TOKEN: tok }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddFluxMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const apiUrl = (await readConnectorSecret(vault, "flux", "api_url"))?.trim() ?? "";
  const tok = (await readConnectorSecret(vault, "flux", "token"))?.trim() ?? "";
  if (apiUrl === "" || tok === "") {
    return;
  }
  const host = hostnameFromUrl(apiUrl);
  const manifest = manifestWithExtraNetworkHosts("flux", host === null ? [] : [host]);
  servers["flux"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("flux")],
      env: extensionProcessEnv({ FLUX_API_URL: apiUrl, FLUX_TOKEN: tok }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddDbtMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "dbt", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  const apiBase = (await readConnectorSecret(vault, "dbt", "api_base"))?.trim() ?? "";
  servers["dbt"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("dbt")],
      env: extensionProcessEnv({
        DBT_TOKEN: tok,
        ...(apiBase === "" ? {} : { DBT_API_BASE: apiBase }),
      }),
    },
    "dbt",
    sandboxCwd,
  );
}

export async function phase3AddMetabaseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "metabase", "url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(vault, "metabase", "api_key"))?.trim() ?? "";
  if (url === "" || apiKey === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("metabase", host === null ? [] : [host]);
  servers["metabase"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("metabase")],
      env: extensionProcessEnv({ METABASE_URL: url, METABASE_API_KEY: apiKey }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddSupersetMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "superset", "url"))?.trim() ?? "";
  const user = (await readConnectorSecret(vault, "superset", "username"))?.trim() ?? "";
  const pass = (await readConnectorSecret(vault, "superset", "password"))?.trim() ?? "";
  if (url === "" || user === "" || pass === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("superset", host === null ? [] : [host]);
  servers["superset"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("superset")],
      env: extensionProcessEnv({
        SUPERSET_URL: url,
        SUPERSET_USERNAME: user,
        SUPERSET_PASSWORD: pass,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddDatabricksMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const hostUrl = (await readConnectorSecret(vault, "databricks", "host"))?.trim() ?? "";
  const tok = (await readConnectorSecret(vault, "databricks", "token"))?.trim() ?? "";
  if (hostUrl === "" || tok === "") {
    return;
  }
  const host = hostnameFromUrl(hostUrl);
  const manifest = manifestWithExtraNetworkHosts("databricks", host === null ? [] : [host]);
  servers["databricks"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("databricks")],
      env: extensionProcessEnv({ DATABRICKS_HOST: hostUrl, DATABRICKS_TOKEN: tok }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddMlflowMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const hostUrl = (await readConnectorSecret(vault, "mlflow", "host"))?.trim() ?? "";
  const tok = (await readConnectorSecret(vault, "mlflow", "token"))?.trim() ?? "";
  if (hostUrl === "" || tok === "") {
    return;
  }
  const host = hostnameFromUrl(hostUrl);
  const manifest = manifestWithExtraNetworkHosts("mlflow", host === null ? [] : [host]);
  servers["mlflow"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("mlflow")],
      env: extensionProcessEnv({ MLFLOW_HOST: hostUrl, MLFLOW_TOKEN: tok }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddVercelMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "vercel", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  const teamId = (await readConnectorSecret(vault, "vercel", "team_id"))?.trim() ?? "";
  servers["vercel"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("vercel")],
      env: extensionProcessEnv({
        VERCEL_TOKEN: tok,
        ...(teamId === "" ? {} : { VERCEL_TEAM_ID: teamId }),
      }),
    },
    "vercel",
    sandboxCwd,
  );
}

export async function phase3AddNetlifyMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "netlify", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  servers["netlify"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("netlify")],
      env: extensionProcessEnv({
        NETLIFY_TOKEN: tok,
      }),
    },
    "netlify",
    sandboxCwd,
  );
}

export async function phase3AddStripeMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "stripe", "api_key"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["stripe"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("stripe")],
      env: extensionProcessEnv({
        STRIPE_API_KEY: key,
      }),
    },
    "stripe",
    sandboxCwd,
  );
}

export async function phase3AddMercuryMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "mercury", "token"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["mercury"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("mercury")],
      env: extensionProcessEnv({
        MERCURY_TOKEN: key,
      }),
    },
    "mercury",
    sandboxCwd,
  );
}

export async function phase3AddReadwiseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "readwise", "token"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["readwise"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("readwise")],
      env: extensionProcessEnv({
        READWISE_TOKEN: key,
      }),
    },
    "readwise",
    sandboxCwd,
  );
}

export async function phase3AddRaindropMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "raindrop", "token"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["raindrop"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("raindrop")],
      env: extensionProcessEnv({
        RAINDROP_TOKEN: key,
      }),
    },
    "raindrop",
    sandboxCwd,
  );
}

export async function phase3AddIntercomMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "intercom", "token"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["intercom"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("intercom")],
      env: extensionProcessEnv({
        INTERCOM_TOKEN: key,
      }),
    },
    "intercom",
    sandboxCwd,
  );
}

export async function phase3AddZendeskMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "zendesk", "url"))?.trim() ?? "";
  const email = (await readConnectorSecret(vault, "zendesk", "email"))?.trim() ?? "";
  const apiToken = (await readConnectorSecret(vault, "zendesk", "api_token"))?.trim() ?? "";
  if (url === "" || email === "" || apiToken === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("zendesk", host === null ? [] : [host]);
  servers["zendesk"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("zendesk")],
      env: extensionProcessEnv({
        ZENDESK_URL: url,
        ZENDESK_EMAIL: email,
        ZENDESK_API_TOKEN: apiToken,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddLeverMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "lever", "api_key"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["lever"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("lever")],
      env: extensionProcessEnv({
        LEVER_API_KEY: key,
      }),
    },
    "lever",
    sandboxCwd,
  );
}

export async function phase3AddGreenhouseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "greenhouse", "api_key"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["greenhouse"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("greenhouse")],
      env: extensionProcessEnv({
        GREENHOUSE_API_KEY: key,
      }),
    },
    "greenhouse",
    sandboxCwd,
  );
}

export async function phase3AddPipedriveMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const key = (await readConnectorSecret(vault, "pipedrive", "token"))?.trim() ?? "";
  if (key === "") {
    return;
  }
  servers["pipedrive"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("pipedrive")],
      env: extensionProcessEnv({
        PIPEDRIVE_TOKEN: key,
      }),
    },
    "pipedrive",
    sandboxCwd,
  );
}

export async function phase3AddStackoverflowMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const token = (await readConnectorSecret(vault, "stackoverflow", "token"))?.trim() ?? "";
  const team = (await readConnectorSecret(vault, "stackoverflow", "team"))?.trim() ?? "";
  if (token === "" || team === "") {
    return;
  }
  servers["stackoverflow"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("stackoverflow")],
      env: extensionProcessEnv({
        STACKOVERFLOW_TOKEN: token,
        STACKOVERFLOW_TEAM: team,
      }),
    },
    "stackoverflow",
    sandboxCwd,
  );
}

export async function buildPhase3Servers(
  vault: NimbusVault,
  sandboxCwd: string,
): Promise<Record<string, ServerSpec>> {
  const servers: Record<string, ServerSpec> = {};
  await phase3AddAwsMcp(vault, servers, sandboxCwd);
  await phase3AddAzureMcp(vault, servers, sandboxCwd);
  await phase3AddGcpMcp(vault, servers, sandboxCwd);
  await phase3AddIacMcp(vault, servers, sandboxCwd);
  await phase3AddGrafanaMcp(vault, servers, sandboxCwd);
  await phase3AddSentryMcp(vault, servers, sandboxCwd);
  await phase3AddNewrelicMcp(vault, servers, sandboxCwd);
  await phase3AddDatadogMcp(vault, servers, sandboxCwd);
  await phase3AddSnykMcp(vault, servers, sandboxCwd);
  await phase3AddBitriseMcp(vault, servers, sandboxCwd);
  await phase3AddSonarqubeMcp(vault, servers, sandboxCwd);
  await phase3AddSemgrepMcp(vault, servers, sandboxCwd);
  await phase3AddWizMcp(vault, servers, sandboxCwd);
  await phase3AddLaunchdarklyMcp(vault, servers, sandboxCwd);
  await phase3AddFlagsmithMcp(vault, servers, sandboxCwd);
  await phase3AddArgocdMcp(vault, servers, sandboxCwd);
  await phase3AddFluxMcp(vault, servers, sandboxCwd);
  await phase3AddDbtMcp(vault, servers, sandboxCwd);
  await phase3AddMetabaseMcp(vault, servers, sandboxCwd);
  await phase3AddSupersetMcp(vault, servers, sandboxCwd);
  await phase3AddDatabricksMcp(vault, servers, sandboxCwd);
  await phase3AddMlflowMcp(vault, servers, sandboxCwd);
  await phase3AddVercelMcp(vault, servers, sandboxCwd);
  await phase3AddNetlifyMcp(vault, servers, sandboxCwd);
  await phase3AddStripeMcp(vault, servers, sandboxCwd);
  await phase3AddMercuryMcp(vault, servers, sandboxCwd);
  await phase3AddReadwiseMcp(vault, servers, sandboxCwd);
  await phase3AddRaindropMcp(vault, servers, sandboxCwd);
  await phase3AddIntercomMcp(vault, servers, sandboxCwd);
  await phase3AddZendeskMcp(vault, servers, sandboxCwd);
  await phase3AddLeverMcp(vault, servers, sandboxCwd);
  await phase3AddGreenhouseMcp(vault, servers, sandboxCwd);
  await phase3AddPipedriveMcp(vault, servers, sandboxCwd);
  await phase3AddStackoverflowMcp(vault, servers, sandboxCwd);
  return servers;
}
