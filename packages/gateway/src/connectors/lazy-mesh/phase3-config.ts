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

// Vertex AI is regional; this is the default when the optional `gcp.region`
// config key is unset.
const VERTEX_AI_DEFAULT_REGION = "us-central1";

/**
 * Inline argv flag-smuggling guard for the optional Vertex AI region before it
 * is interpolated into the spawned MCP's `VERTEX_AI_REGION` env and the per-region
 * network host (the gateway package cannot import `mcp-connectors/shared`). A value
 * that is empty, over-long, `-`-prefixed, or carries control characters is rejected
 * so the caller falls back to the safe default.
 */
function isSafeRegion(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) {
      return false;
    }
  }
  return true;
}

/**
 * Parse a per-tenant IMAP/SMTP port string into a valid TCP port, falling back
 * to `fallback` when empty or out of range. Mirrors the validator's 1..65535
 * bound so the spawned host:port network entry is always well-formed.
 */
function imapPortOrDefault(raw: string, fallback: number): number {
  if (raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? Math.trunc(n) : fallback;
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

export async function phase3AddBigqueryMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // BigQuery (Tier-3, metadata-only) reuses the existing GCP credentials.
  const gcpPath = (await readConnectorSecret(vault, "gcp", "credentials_json_path"))?.trim() ?? "";
  if (gcpPath === "") {
    return;
  }
  const projectId = (await readConnectorSecret(vault, "gcp", "project_id"))?.trim() ?? "";
  servers["bigquery"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("bigquery")],
      env: extensionProcessEnv({
        GOOGLE_APPLICATION_CREDENTIALS: gcpPath,
        ...(projectId === "" ? {} : { BIGQUERY_PROJECT: projectId }),
      }),
    },
    "bigquery",
    sandboxCwd,
  );
}

export async function phase3AddAthenaMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Athena (Tier-3, metadata-only) reuses the existing AWS credentials — mirror
  // phase3AddAwsMcp's inline cred reads.
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
  // Add the regional Athena endpoint host for the configured region — the
  // RFC-1123 validator rejects the `athena.*.amazonaws.com` wildcard, so the
  // concrete per-region host is added here (sts.amazonaws.com is the fixed base).
  const athenaManifest = manifestWithExtraNetworkHosts(
    "athena",
    reg === "" ? [] : [`athena.${reg}.amazonaws.com`],
  );
  servers["athena"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("athena")],
      env: extensionProcessEnv(extra),
    },
    athenaManifest,
    sandboxCwd,
  );
}

export async function phase3AddCloudwatchMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // CloudWatch (Tier-3, metadata-only) reuses the existing AWS credentials —
  // mirror phase3AddAwsMcp's inline cred reads.
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
  // Add the regional CloudWatch Logs endpoint host for the configured region —
  // the RFC-1123 validator rejects the `logs.*.amazonaws.com` wildcard, so the
  // concrete per-region host is added here (sts.amazonaws.com is the fixed base).
  const cloudwatchManifest = manifestWithExtraNetworkHosts(
    "cloudwatch",
    reg === "" ? [] : [`logs.${reg}.amazonaws.com`],
  );
  servers["cloudwatch"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("cloudwatch")],
      env: extensionProcessEnv(extra),
    },
    cloudwatchManifest,
    sandboxCwd,
  );
}

export async function phase3AddSagemakerMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // SageMaker (Tier-3, metadata-only) reuses the existing AWS credentials —
  // mirror phase3AddCloudwatchMcp's inline cred reads.
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
  // Add the regional SageMaker endpoint host for the configured region — the
  // RFC-1123 validator rejects the `api.sagemaker.*.amazonaws.com` wildcard, so
  // the concrete per-region host is added here (sts.amazonaws.com is the fixed
  // base).
  const sagemakerManifest = manifestWithExtraNetworkHosts(
    "sagemaker",
    reg === "" ? [] : [`api.sagemaker.${reg}.amazonaws.com`],
  );
  servers["sagemaker"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("sagemaker")],
      env: extensionProcessEnv(extra),
    },
    sagemakerManifest,
    sandboxCwd,
  );
}

export async function phase3AddCloudLoggingMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Cloud Logging (Tier-3, metadata-only) reuses the existing GCP credentials —
  // mirror phase3AddBigqueryMcp's gcp cred gate.
  const gcpPath = (await readConnectorSecret(vault, "gcp", "credentials_json_path"))?.trim() ?? "";
  if (gcpPath === "") {
    return;
  }
  const projectId = (await readConnectorSecret(vault, "gcp", "project_id"))?.trim() ?? "";
  servers["cloud_logging"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("cloud-logging")],
      env: extensionProcessEnv({
        GOOGLE_APPLICATION_CREDENTIALS: gcpPath,
        ...(projectId === "" ? {} : { GOOGLE_CLOUD_PROJECT: projectId }),
      }),
    },
    "cloud_logging",
    sandboxCwd,
  );
}

export async function phase3AddVertexAiMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Vertex AI (Tier-3, metadata-only) reuses the existing GCP credentials —
  // mirror phase3AddCloudLoggingMcp's gcp cred gate.
  const gcpPath = (await readConnectorSecret(vault, "gcp", "credentials_json_path"))?.trim() ?? "";
  if (gcpPath === "") {
    return;
  }
  const projectId = (await readConnectorSecret(vault, "gcp", "project_id"))?.trim() ?? "";
  // Region is an OPTIONAL non-secret gcp config key; default to us-central1.
  // Vertex AI is regional — the per-region host `<region>-aiplatform.googleapis.com`
  // is added to the manifest at spawn-time. The base aiplatform.googleapis.com host
  // is in the static manifest; the RFC-1123 validator rejects a `*-aiplatform...`
  // wildcard, so the concrete per-region host is merged in here.
  const rawRegion = (await readConnectorSecret(vault, "gcp", "region"))?.trim() ?? "";
  const region = rawRegion === "" ? VERTEX_AI_DEFAULT_REGION : rawRegion;
  const safeRegion = isSafeRegion(region) ? region : VERTEX_AI_DEFAULT_REGION;
  const manifest = manifestWithExtraNetworkHosts("vertex_ai", [
    `${safeRegion}-aiplatform.googleapis.com`,
  ]);
  servers["vertex_ai"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("vertex-ai")],
      env: extensionProcessEnv({
        GOOGLE_APPLICATION_CREDENTIALS: gcpPath,
        VERTEX_AI_REGION: safeRegion,
        ...(projectId === "" ? {} : { GOOGLE_CLOUD_PROJECT: projectId }),
      }),
    },
    manifest,
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

export async function phase3AddZoteroMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const apiKey = (await readConnectorSecret(vault, "zotero", "api_key"))?.trim() ?? "";
  const library = (await readConnectorSecret(vault, "zotero", "library"))?.trim() ?? "";
  if (apiKey === "" || library === "") {
    return;
  }
  servers["zotero"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("zotero")],
      env: extensionProcessEnv({
        ZOTERO_API_KEY: apiKey,
        ZOTERO_LIBRARY: library,
      }),
    },
    "zotero",
    sandboxCwd,
  );
}

export async function phase3AddRampMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const clientId = (await readConnectorSecret(vault, "ramp", "client_id"))?.trim() ?? "";
  const clientSecret = (await readConnectorSecret(vault, "ramp", "client_secret"))?.trim() ?? "";
  if (clientId === "" || clientSecret === "") {
    return;
  }
  servers["ramp"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("ramp")],
      env: extensionProcessEnv({
        RAMP_CLIENT_ID: clientId,
        RAMP_CLIENT_SECRET: clientSecret,
      }),
    },
    "ramp",
    sandboxCwd,
  );
}

export async function phase3AddDependencytrackMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "dependencytrack", "base_url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(vault, "dependencytrack", "api_key"))?.trim() ?? "";
  if (url === "" || apiKey === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("dependencytrack", host === null ? [] : [host]);
  servers["dependencytrack"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("dependencytrack")],
      env: extensionProcessEnv({ DEPENDENCYTRACK_URL: url, DEPENDENCYTRACK_API_KEY: apiKey }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddElasticsearchMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "elasticsearch", "url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(vault, "elasticsearch", "api_key"))?.trim() ?? "";
  if (url === "" || apiKey === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("elasticsearch", host === null ? [] : [host]);
  servers["elasticsearch"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("elasticsearch")],
      env: extensionProcessEnv({ ELASTICSEARCH_URL: url, ELASTICSEARCH_API_KEY: apiKey }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddAirflowMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "airflow", "base_url"))?.trim() ?? "";
  const username = (await readConnectorSecret(vault, "airflow", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(vault, "airflow", "password"))?.trim() ?? "";
  if (url === "" || username === "" || password === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("airflow", host === null ? [] : [host]);
  servers["airflow"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("airflow")],
      env: extensionProcessEnv({
        AIRFLOW_URL: url,
        AIRFLOW_USERNAME: username,
        AIRFLOW_PASSWORD: password,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddPrefectMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const apiUrl = (await readConnectorSecret(vault, "prefect", "api_url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(vault, "prefect", "api_key"))?.trim() ?? "";
  if (apiUrl === "" || apiKey === "") {
    return;
  }
  const host = hostnameFromUrl(apiUrl);
  const manifest = manifestWithExtraNetworkHosts("prefect", host === null ? [] : [host]);
  servers["prefect"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("prefect")],
      env: extensionProcessEnv({
        PREFECT_API_URL: apiUrl,
        PREFECT_API_KEY: apiKey,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddDagsterMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const baseUrl = (await readConnectorSecret(vault, "dagster", "base_url"))?.trim() ?? "";
  const apiToken = (await readConnectorSecret(vault, "dagster", "api_token"))?.trim() ?? "";
  if (baseUrl === "" || apiToken === "") {
    return;
  }
  const host = hostnameFromUrl(baseUrl);
  const manifest = manifestWithExtraNetworkHosts("dagster", host === null ? [] : [host]);
  servers["dagster"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("dagster")],
      env: extensionProcessEnv({
        DAGSTER_BASE_URL: baseUrl,
        DAGSTER_API_TOKEN: apiToken,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddImapMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // IMAP/SMTP (Tier-4 EMAIL) is per-tenant. Gate on the IMAP read credentials
  // (host + username + password); SMTP creds are optional (send tool).
  const host = (await readConnectorSecret(vault, "imap", "host"))?.trim() ?? "";
  const username = (await readConnectorSecret(vault, "imap", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(vault, "imap", "password"))?.trim() ?? "";
  if (host === "" || username === "" || password === "") {
    return;
  }
  const portRaw = (await readConnectorSecret(vault, "imap", "port"))?.trim() ?? "";
  const port = imapPortOrDefault(portRaw, 993);
  const mailbox = (await readConnectorSecret(vault, "imap", "mailbox"))?.trim() ?? "";

  const smtpHost = (await readConnectorSecret(vault, "imap", "smtp_host"))?.trim() ?? "";
  const smtpUser = (await readConnectorSecret(vault, "imap", "smtp_username"))?.trim() ?? "";
  const smtpPass = (await readConnectorSecret(vault, "imap", "smtp_password"))?.trim() ?? "";
  const smtpPortRaw = (await readConnectorSecret(vault, "imap", "smtp_port"))?.trim() ?? "";
  const smtpPort = imapPortOrDefault(smtpPortRaw, 465);

  // The IMAP host (and SMTP host, if configured) are on non-443 ports — add the
  // concrete host:port entries to the sandbox network allow-list at spawn time.
  const extraHosts: string[] = [`${host}:${String(port)}`];
  if (smtpHost !== "") {
    extraHosts.push(`${smtpHost}:${String(smtpPort)}`);
  }
  const manifest = manifestWithExtraNetworkHosts("imap", extraHosts);

  const env: Record<string, string> = {
    IMAP_HOST: host,
    IMAP_PORT: String(port),
    IMAP_USERNAME: username,
    IMAP_PASSWORD: password,
  };
  if (mailbox !== "") {
    env["IMAP_MAILBOX"] = mailbox;
  }
  if (smtpHost !== "") {
    env["IMAP_SMTP_HOST"] = smtpHost;
    env["IMAP_SMTP_PORT"] = String(smtpPort);
  }
  if (smtpUser !== "") {
    env["IMAP_SMTP_USERNAME"] = smtpUser;
  }
  if (smtpPass !== "") {
    env["IMAP_SMTP_PASSWORD"] = smtpPass;
  }

  servers["imap"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("imap")],
      env: extensionProcessEnv(env),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddProtonmailMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // ProtonMail via Bridge (Tier-4 EMAIL). Gate on the Bridge IMAP credentials;
  // SMTP creds are optional (send tool). Host/port default to the Bridge
  // loopback listeners (127.0.0.1:1143 IMAP / :1025 SMTP).
  const username = (await readConnectorSecret(vault, "protonmail", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(vault, "protonmail", "password"))?.trim() ?? "";
  if (username === "" || password === "") {
    return;
  }
  const host = (await readConnectorSecret(vault, "protonmail", "imap_host"))?.trim() || "127.0.0.1";
  const portRaw = (await readConnectorSecret(vault, "protonmail", "imap_port"))?.trim() ?? "";
  const port = imapPortOrDefault(portRaw, 1143);
  const mailbox = (await readConnectorSecret(vault, "protonmail", "mailbox"))?.trim() ?? "";

  const smtpHost =
    (await readConnectorSecret(vault, "protonmail", "smtp_host"))?.trim() || "127.0.0.1";
  const smtpUser = (await readConnectorSecret(vault, "protonmail", "smtp_username"))?.trim() ?? "";
  const smtpPass = (await readConnectorSecret(vault, "protonmail", "smtp_password"))?.trim() ?? "";
  const smtpPortRaw = (await readConnectorSecret(vault, "protonmail", "smtp_port"))?.trim() ?? "";
  const smtpPort = imapPortOrDefault(smtpPortRaw, 1025);

  // Bridge IMAP/SMTP are on non-443 loopback ports — add the concrete host:port
  // entries to the sandbox network allow-list at spawn time. SMTP host is only
  // added when send credentials are configured.
  const extraHosts: string[] = [`${host}:${String(port)}`];
  if (smtpUser !== "" && smtpPass !== "") {
    extraHosts.push(`${smtpHost}:${String(smtpPort)}`);
  }
  const manifest = manifestWithExtraNetworkHosts("protonmail", extraHosts);

  const env: Record<string, string> = {
    PROTONMAIL_HOST: host,
    PROTONMAIL_PORT: String(port),
    PROTONMAIL_USERNAME: username,
    PROTONMAIL_PASSWORD: password,
  };
  if (mailbox !== "") {
    env["PROTONMAIL_MAILBOX"] = mailbox;
  }
  if (smtpUser !== "" && smtpPass !== "") {
    env["PROTONMAIL_SMTP_HOST"] = smtpHost;
    env["PROTONMAIL_SMTP_PORT"] = String(smtpPort);
    env["PROTONMAIL_SMTP_USERNAME"] = smtpUser;
    env["PROTONMAIL_SMTP_PASSWORD"] = smtpPass;
  }

  servers["protonmail"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("protonmail")],
      env: extensionProcessEnv(env),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddFastmailMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Fastmail (Tier-4 EMAIL via JMAP) — gate on the API token. The base URL is an
  // optional non-secret override (default api.fastmail.com); the static manifest
  // host covers the JMAP session/api endpoints, so no extra-host merge is needed.
  const apiToken = (await readConnectorSecret(vault, "fastmail", "api_token"))?.trim() ?? "";
  if (apiToken === "") {
    return;
  }
  const baseUrl = (await readConnectorSecret(vault, "fastmail", "base_url"))?.trim() ?? "";

  const env: Record<string, string> = { FASTMAIL_API_TOKEN: apiToken };
  if (baseUrl !== "") {
    env["FASTMAIL_BASE_URL"] = baseUrl;
  }

  servers["fastmail"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("fastmail")],
      env: extensionProcessEnv(env),
    },
    "fastmail",
    sandboxCwd,
  );
}

export async function phase3AddLocaldbMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Local DB Schema Indexing (Tier-5 local) has NO network and NO live
  // credential — it reads saved `.sql` files from a configured local directory.
  // `localdb.scripts_dir` is a non-secret PATH; noop when unset.
  const dir = (await readConnectorSecret(vault, "localdb", "scripts_dir"))?.trim() ?? "";
  if (dir === "") {
    return;
  }
  // Extend the connector manifest's filesystem.read with the configured scripts
  // dir at spawn time, mirroring phase3AddGreatExpectationsMcp / ensureObsidianMcp.
  const base = manifestForFirstParty("localdb");
  const manifest = {
    ...base,
    permissions: {
      ...base.permissions,
      filesystem: {
        read: [...base.permissions.filesystem.read, dir],
        write: [...base.permissions.filesystem.write],
      },
    },
  };
  servers["localdb"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("localdb")],
      env: extensionProcessEnv({ LOCALDB_SCRIPTS_DIR: dir }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddGreatExpectationsMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Great Expectations (Tier-3, no-row-data) has NO network and NO live
  // credential — it reads GX validation-result JSON artefacts from a configured
  // local directory. `great_expectations.results_dir` is a non-secret PATH; noop
  // when unset.
  const dir = (await readConnectorSecret(vault, "great_expectations", "results_dir"))?.trim() ?? "";
  if (dir === "") {
    return;
  }
  // Extend the connector manifest's filesystem.read with the configured results
  // dir at spawn time, mirroring ensureObsidianMcp's inline manifest extension.
  const base = manifestForFirstParty("great_expectations");
  const manifest = {
    ...base,
    permissions: {
      ...base.permissions,
      filesystem: {
        read: [...base.permissions.filesystem.read, dir],
        write: [...base.permissions.filesystem.write],
      },
    },
  };
  servers["great_expectations"] = wrapServerSpec(
    {
      command: "bun",
      args: [mcpConnectorServerScript("great-expectations")],
      env: extensionProcessEnv({ GREAT_EXPECTATIONS_RESULTS_DIR: dir }),
    },
    manifest,
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
  await phase3AddBigqueryMcp(vault, servers, sandboxCwd);
  await phase3AddAthenaMcp(vault, servers, sandboxCwd);
  await phase3AddCloudwatchMcp(vault, servers, sandboxCwd);
  await phase3AddSagemakerMcp(vault, servers, sandboxCwd);
  await phase3AddCloudLoggingMcp(vault, servers, sandboxCwd);
  await phase3AddVertexAiMcp(vault, servers, sandboxCwd);
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
  await phase3AddZoteroMcp(vault, servers, sandboxCwd);
  await phase3AddDependencytrackMcp(vault, servers, sandboxCwd);
  await phase3AddElasticsearchMcp(vault, servers, sandboxCwd);
  await phase3AddAirflowMcp(vault, servers, sandboxCwd);
  await phase3AddPrefectMcp(vault, servers, sandboxCwd);
  await phase3AddDagsterMcp(vault, servers, sandboxCwd);
  await phase3AddRampMcp(vault, servers, sandboxCwd);
  await phase3AddImapMcp(vault, servers, sandboxCwd);
  await phase3AddFastmailMcp(vault, servers, sandboxCwd);
  await phase3AddProtonmailMcp(vault, servers, sandboxCwd);
  await phase3AddLocaldbMcp(vault, servers, sandboxCwd);
  await phase3AddGreatExpectationsMcp(vault, servers, sandboxCwd);
  return servers;
}
