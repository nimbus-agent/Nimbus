import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { ConnectorServiceId } from "../connector-catalog.ts";
import { type ConnectorSecretKeyOf, readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
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
    if ((value.codePointAt(i) ?? 0x20) < 0x20) {
      return false;
    }
  }
  return true;
}

/**
 * Shared argv flag-smuggling guard for host-identifier-style values (Snowflake
 * account identifiers, Power BI tenant ids, etc.) before they are interpolated
 * into URLs or spawned-MCP env vars. A value that is empty, over-long, `-`-prefixed,
 * or carries control characters is rejected so the caller noops.
 */
function isSafeHostIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if ((value.codePointAt(i) ?? 0x20) < 0x20) {
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

/** Read + trim an optional connector secret, defaulting to "" when unset. */
async function readSecret<S extends ConnectorServiceId>(
  vault: NimbusVault,
  serviceId: S,
  key: ConnectorSecretKeyOf<S>,
): Promise<string> {
  return (await readConnectorSecret(vault, serviceId, key))?.trim() ?? "";
}

interface SimpleTokenSpec<S extends ConnectorServiceId> {
  /** Service id, used as the `servers` key, the manifest id, and the secret namespace. */
  readonly serviceId: S;
  /** MCP server script name passed to {@link connectorSpawn}. */
  readonly script: string;
  /** Vault secret suffix (e.g. `"token"`, `"api_key"`) — validated against the service. */
  readonly secretKey: ConnectorSecretKeyOf<S>;
  /** Environment variable name the spawned connector reads the secret from. */
  readonly envKey: string;
}

/**
 * Register a single-secret connector: read one token/key, noop when unset, then
 * wrap + register the spawn. Collapses the ~12 token-only connector bodies that
 * differ only in their service id / script / secret key / env var name.
 */
async function addSimpleTokenServer<S extends ConnectorServiceId>(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
  spec: SimpleTokenSpec<S>,
): Promise<void> {
  const value = await readSecret(vault, spec.serviceId, spec.secretKey);
  if (value === "") {
    return;
  }
  servers[spec.serviceId] = wrap(
    {
      ...connectorSpawn(spec.script),
      env: extensionProcessEnv({ [spec.envKey]: value }),
    },
    spec.serviceId,
    sandboxCwd,
  );
}

/**
 * Register a local, no-network connector that reads files from a configured
 * directory: extend the first-party manifest's `filesystem.read` with the dir at
 * spawn time, noop when the dir is unset. Shared by the Tier-5 local connectors
 * (localdb, dataprofile, storybook) and great_expectations.
 */
async function addDirManifestServer<S extends ConnectorServiceId>(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
  spec: SimpleTokenSpec<S>,
): Promise<void> {
  const dir = await readSecret(vault, spec.serviceId, spec.secretKey);
  if (dir === "") {
    return;
  }
  const base = manifestForFirstParty(spec.serviceId);
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
  servers[spec.serviceId] = wrapServerSpec(
    {
      ...connectorSpawn(spec.script),
      env: extensionProcessEnv({ [spec.envKey]: dir }),
    },
    manifest,
    sandboxCwd,
  );
}

interface AwsCreds {
  /** Whether enough of the AWS credential set is present to spawn. */
  readonly ok: boolean;
  /** The configured default region ("" when unset) — needed for regional hosts. */
  readonly region: string;
  /** The connector env subset (only the keys that were actually configured). */
  readonly env: Record<string, string>;
}

/**
 * Read the shared AWS credential set (key / secret / region / profile) once and
 * build the connector env subset. Reused by the AWS-family connectors (aws,
 * athena, cloudwatch, sagemaker) that all authenticate the same way.
 */
async function loadAwsCreds(vault: NimbusVault): Promise<AwsCreds> {
  const ak = await readSecret(vault, "aws", "access_key_id");
  const sk = await readSecret(vault, "aws", "secret_access_key");
  const reg = await readSecret(vault, "aws", "default_region");
  const prof = await readSecret(vault, "aws", "profile");
  const ok = (ak !== "" && sk !== "" && (reg !== "" || prof !== "")) || (prof !== "" && ak === "");
  const env: Record<string, string> = {};
  if (ak !== "") {
    env["AWS_ACCESS_KEY_ID"] = ak;
  }
  if (sk !== "") {
    env["AWS_SECRET_ACCESS_KEY"] = sk;
  }
  if (reg !== "") {
    env["AWS_DEFAULT_REGION"] = reg;
  }
  if (prof !== "") {
    env["AWS_PROFILE"] = prof;
  }
  return { ok, region: reg, env };
}

export async function phase3AddAwsMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const creds = await loadAwsCreds(vault);
  if (!creds.ok) {
    return;
  }
  servers["aws"] = wrap(
    {
      ...connectorSpawn("aws"),
      env: extensionProcessEnv(creds.env),
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
      ...connectorSpawn("azure"),
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
      ...connectorSpawn("gcp"),
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
      ...connectorSpawn("bigquery"),
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
  // Athena (Tier-3, metadata-only) reuses the existing AWS credentials.
  const creds = await loadAwsCreds(vault);
  if (!creds.ok) {
    return;
  }
  // Add the regional Athena endpoint host for the configured region — the
  // RFC-1123 validator rejects the `athena.*.amazonaws.com` wildcard, so the
  // concrete per-region host is added here (sts.amazonaws.com is the fixed base).
  const athenaManifest = manifestWithExtraNetworkHosts(
    "athena",
    creds.region === "" ? [] : [`athena.${creds.region}.amazonaws.com`],
  );
  servers["athena"] = wrapServerSpec(
    {
      ...connectorSpawn("athena"),
      env: extensionProcessEnv(creds.env),
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
  // CloudWatch (Tier-3, metadata-only) reuses the existing AWS credentials.
  const creds = await loadAwsCreds(vault);
  if (!creds.ok) {
    return;
  }
  // Add the regional CloudWatch Logs endpoint host for the configured region —
  // the RFC-1123 validator rejects the `logs.*.amazonaws.com` wildcard, so the
  // concrete per-region host is added here (sts.amazonaws.com is the fixed base).
  const cloudwatchManifest = manifestWithExtraNetworkHosts(
    "cloudwatch",
    creds.region === "" ? [] : [`logs.${creds.region}.amazonaws.com`],
  );
  servers["cloudwatch"] = wrapServerSpec(
    {
      ...connectorSpawn("cloudwatch"),
      env: extensionProcessEnv(creds.env),
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
  // SageMaker (Tier-3, metadata-only) reuses the existing AWS credentials.
  const creds = await loadAwsCreds(vault);
  if (!creds.ok) {
    return;
  }
  // Add the regional SageMaker endpoint host for the configured region — the
  // RFC-1123 validator rejects the `api.sagemaker.*.amazonaws.com` wildcard, so
  // the concrete per-region host is added here (sts.amazonaws.com is the fixed
  // base).
  const sagemakerManifest = manifestWithExtraNetworkHosts(
    "sagemaker",
    creds.region === "" ? [] : [`api.sagemaker.${creds.region}.amazonaws.com`],
  );
  servers["sagemaker"] = wrapServerSpec(
    {
      ...connectorSpawn("sagemaker"),
      env: extensionProcessEnv(creds.env),
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
      ...connectorSpawn("cloud-logging"),
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
      ...connectorSpawn("vertex-ai"),
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
      ...connectorSpawn("iac"),
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
      ...connectorSpawn("grafana"),
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
      ...connectorSpawn("sentry"),
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
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "newrelic",
    script: "newrelic",
    secretKey: "api_key",
    envKey: "NEW_RELIC_API_KEY",
  });
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
      ...connectorSpawn("datadog"),
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
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "snyk",
    script: "snyk",
    secretKey: "token",
    envKey: "SNYK_TOKEN",
  });
}

export async function phase3AddBitriseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "bitrise",
    script: "bitrise",
    secretKey: "token",
    envKey: "BITRISE_TOKEN",
  });
}

export async function phase3AddCodemagicMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "codemagic", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  servers["codemagic"] = wrap(
    {
      ...connectorSpawn("codemagic"),
      env: extensionProcessEnv({ CODEMAGIC_TOKEN: tok }),
    },
    "codemagic",
    sandboxCwd,
  );
}

export async function phase3AddTestflightMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const issuerId = (await readConnectorSecret(vault, "testflight", "issuer_id"))?.trim() ?? "";
  const keyId = (await readConnectorSecret(vault, "testflight", "key_id"))?.trim() ?? "";
  const privateKey = (await readConnectorSecret(vault, "testflight", "private_key")) ?? "";
  if (issuerId === "" || keyId === "" || privateKey.trim() === "") {
    return;
  }
  servers["testflight"] = wrap(
    {
      ...connectorSpawn("testflight"),
      env: extensionProcessEnv({
        TESTFLIGHT_ISSUER_ID: issuerId,
        TESTFLIGHT_KEY_ID: keyId,
        TESTFLIGHT_PRIVATE_KEY: privateKey,
      }),
    },
    "testflight",
    sandboxCwd,
  );
}

export async function phase3AddFirebaseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const serviceAccountJson =
    (await readConnectorSecret(vault, "firebase", "service_account_json")) ?? "";
  const appIds = (await readConnectorSecret(vault, "firebase", "app_ids"))?.trim() ?? "";
  if (serviceAccountJson.trim() === "" || appIds === "") {
    return;
  }
  servers["firebase"] = wrap(
    {
      ...connectorSpawn("firebase"),
      env: extensionProcessEnv({
        FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
        FIREBASE_APP_IDS: appIds,
      }),
    },
    "firebase",
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
      ...connectorSpawn("sonarqube"),
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
      ...connectorSpawn("semgrep"),
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
      ...connectorSpawn("wiz"),
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
      ...connectorSpawn("launchdarkly"),
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
      ...connectorSpawn("flagsmith"),
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
      ...connectorSpawn("argocd"),
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
      ...connectorSpawn("flux"),
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
      ...connectorSpawn("dbt"),
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
      ...connectorSpawn("metabase"),
      env: extensionProcessEnv({ METABASE_URL: url, METABASE_API_KEY: apiKey }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddSnowflakeMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const account = (await readConnectorSecret(vault, "snowflake", "account"))?.trim() ?? "";
  const oauth = (await readConnectorSecret(vault, "snowflake", "oauth_token"))?.trim();
  const jwt = (await readConnectorSecret(vault, "snowflake", "key_pair_jwt"))?.trim();
  // Use empty-string check (not ??) so a blank vault value falls through to the next option.
  let token = "";
  if (oauth !== undefined && oauth !== "") {
    token = oauth;
  } else if (jwt !== undefined && jwt !== "") {
    token = jwt;
  }
  if (account === "" || token === "" || !isSafeHostIdentifier(account)) {
    return;
  }
  const host = `${account}.snowflakecomputing.com`;
  const manifest = manifestWithExtraNetworkHosts("snowflake", [host]);
  servers["snowflake"] = wrapServerSpec(
    {
      ...connectorSpawn("snowflake"),
      env: extensionProcessEnv({ SNOWFLAKE_ACCOUNT: account, SNOWFLAKE_TOKEN: token }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddTableauMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "tableau", "url"))?.trim() ?? "";
  const patName = (await readConnectorSecret(vault, "tableau", "pat_name"))?.trim() ?? "";
  const patSecret = (await readConnectorSecret(vault, "tableau", "pat_secret"))?.trim() ?? "";
  if (url === "" || patName === "" || patSecret === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("tableau", host === null ? [] : [host]);
  servers["tableau"] = wrapServerSpec(
    {
      ...connectorSpawn("tableau"),
      env: extensionProcessEnv({
        TABLEAU_URL: url,
        TABLEAU_PAT_NAME: patName,
        TABLEAU_PAT_SECRET: patSecret,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddLookerMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const baseUrl = (await readConnectorSecret(vault, "looker", "base_url"))?.trim() ?? "";
  const clientId = (await readConnectorSecret(vault, "looker", "client_id"))?.trim() ?? "";
  const clientSecret = (await readConnectorSecret(vault, "looker", "client_secret"))?.trim() ?? "";
  if (baseUrl === "" || clientId === "" || clientSecret === "") {
    return;
  }
  const host = hostnameFromUrl(baseUrl);
  const manifest = manifestWithExtraNetworkHosts("looker", host === null ? [] : [host]);
  servers["looker"] = wrapServerSpec(
    {
      ...connectorSpawn("looker"),
      env: extensionProcessEnv({
        LOOKER_BASE_URL: baseUrl,
        LOOKER_CLIENT_ID: clientId,
        LOOKER_CLIENT_SECRET: clientSecret,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddPowerBiMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tenantId = (await readConnectorSecret(vault, "powerbi", "tenant_id"))?.trim() ?? "";
  const clientId = (await readConnectorSecret(vault, "powerbi", "client_id"))?.trim() ?? "";
  const clientSecret = (await readConnectorSecret(vault, "powerbi", "client_secret"))?.trim() ?? "";
  if (
    tenantId === "" ||
    clientId === "" ||
    clientSecret === "" ||
    !isSafeHostIdentifier(tenantId)
  ) {
    return;
  }
  servers["powerbi"] = wrap(
    {
      ...connectorSpawn("powerbi"),
      env: extensionProcessEnv({
        POWERBI_TENANT_ID: tenantId,
        POWERBI_CLIENT_ID: clientId,
        POWERBI_CLIENT_SECRET: clientSecret,
      }),
    },
    "powerbi",
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
      ...connectorSpawn("superset"),
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
      ...connectorSpawn("databricks"),
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
      ...connectorSpawn("mlflow"),
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
      ...connectorSpawn("vercel"),
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
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "netlify",
    script: "netlify",
    secretKey: "token",
    envKey: "NETLIFY_TOKEN",
  });
}

export async function phase3AddStripeMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "stripe",
    script: "stripe",
    secretKey: "api_key",
    envKey: "STRIPE_API_KEY",
  });
}

export async function phase3AddMercuryMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "mercury",
    script: "mercury",
    secretKey: "token",
    envKey: "MERCURY_TOKEN",
  });
}

export async function phase3AddReadwiseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "readwise",
    script: "readwise",
    secretKey: "token",
    envKey: "READWISE_TOKEN",
  });
}

export async function phase3AddRaindropMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "raindrop",
    script: "raindrop",
    secretKey: "token",
    envKey: "RAINDROP_TOKEN",
  });
}

export async function phase3AddIntercomMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "intercom",
    script: "intercom",
    secretKey: "token",
    envKey: "INTERCOM_TOKEN",
  });
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
      ...connectorSpawn("zendesk"),
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
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "lever",
    script: "lever",
    secretKey: "api_key",
    envKey: "LEVER_API_KEY",
  });
}

export async function phase3AddGreenhouseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "greenhouse",
    script: "greenhouse",
    secretKey: "api_key",
    envKey: "GREENHOUSE_API_KEY",
  });
}

export async function phase3AddPipedriveMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "pipedrive",
    script: "pipedrive",
    secretKey: "token",
    envKey: "PIPEDRIVE_TOKEN",
  });
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
      ...connectorSpawn("stackoverflow"),
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
      ...connectorSpawn("zotero"),
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
      ...connectorSpawn("ramp"),
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
      ...connectorSpawn("dependencytrack"),
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
      ...connectorSpawn("elasticsearch"),
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
      ...connectorSpawn("airflow"),
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
      ...connectorSpawn("prefect"),
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
      ...connectorSpawn("dagster"),
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
      ...connectorSpawn("imap"),
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
      ...connectorSpawn("protonmail"),
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
      ...connectorSpawn("fastmail"),
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
  await addDirManifestServer(vault, servers, sandboxCwd, {
    serviceId: "localdb",
    script: "localdb",
    secretKey: "scripts_dir",
    envKey: "LOCALDB_SCRIPTS_DIR",
  });
}

export async function phase3AddDataprofileMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Local data profiling (Tier-5 local, no-row-data) has NO network and NO live
  // credential — it schema-profiles local data files from a configured dir.
  // `dataprofile.dir` is a non-secret PATH; noop when unset.
  await addDirManifestServer(vault, servers, sandboxCwd, {
    serviceId: "dataprofile",
    script: "dataprofile",
    secretKey: "dir",
    envKey: "DATAPROFILE_DIR",
  });
}

export async function phase3AddStorybookMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Storybook (Tier-5 local) has NO network and NO live credential — it reads
  // the local Storybook manifest (index.json / stories.json) from a configured
  // output dir. `storybook.dir` is a non-secret PATH; noop when unset.
  await addDirManifestServer(vault, servers, sandboxCwd, {
    serviceId: "storybook",
    script: "storybook",
    secretKey: "dir",
    envKey: "STORYBOOK_DIR",
  });
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
  await addDirManifestServer(vault, servers, sandboxCwd, {
    serviceId: "great_expectations",
    script: "great-expectations",
    secretKey: "results_dir",
    envKey: "GREAT_EXPECTATIONS_RESULTS_DIR",
  });
}

export async function phase3AddMonteCarloMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const apiId = (await readConnectorSecret(vault, "montecarlo", "api_id"))?.trim() ?? "";
  const apiToken = (await readConnectorSecret(vault, "montecarlo", "api_token"))?.trim() ?? "";
  if (apiId === "" || apiToken === "") {
    return;
  }
  servers["montecarlo"] = wrap(
    {
      ...connectorSpawn("monte-carlo"),
      env: extensionProcessEnv({
        MONTECARLO_API_ID: apiId,
        MONTECARLO_API_TOKEN: apiToken,
      }),
    },
    "montecarlo",
    sandboxCwd,
  );
}

export async function phase3AddBigeyeMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const baseUrl = (await readConnectorSecret(vault, "bigeye", "base_url"))?.trim() ?? "";
  const apiKey = (await readConnectorSecret(vault, "bigeye", "api_key"))?.trim() ?? "";
  if (baseUrl === "" || apiKey === "") {
    return;
  }
  const host = hostnameFromUrl(baseUrl);
  const manifest = manifestWithExtraNetworkHosts("bigeye", host === null ? [] : [host]);
  servers["bigeye"] = wrapServerSpec(
    {
      ...connectorSpawn("bigeye"),
      env: extensionProcessEnv({
        BIGEYE_BASE_URL: baseUrl,
        BIGEYE_API_KEY: apiKey,
      }),
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
  await phase3AddCodemagicMcp(vault, servers, sandboxCwd);
  await phase3AddTestflightMcp(vault, servers, sandboxCwd);
  await phase3AddFirebaseMcp(vault, servers, sandboxCwd);
  await phase3AddSonarqubeMcp(vault, servers, sandboxCwd);
  await phase3AddSemgrepMcp(vault, servers, sandboxCwd);
  await phase3AddWizMcp(vault, servers, sandboxCwd);
  await phase3AddLaunchdarklyMcp(vault, servers, sandboxCwd);
  await phase3AddFlagsmithMcp(vault, servers, sandboxCwd);
  await phase3AddArgocdMcp(vault, servers, sandboxCwd);
  await phase3AddFluxMcp(vault, servers, sandboxCwd);
  await phase3AddDbtMcp(vault, servers, sandboxCwd);
  await phase3AddMetabaseMcp(vault, servers, sandboxCwd);
  await phase3AddSnowflakeMcp(vault, servers, sandboxCwd);
  await phase3AddTableauMcp(vault, servers, sandboxCwd);
  await phase3AddLookerMcp(vault, servers, sandboxCwd);
  await phase3AddPowerBiMcp(vault, servers, sandboxCwd);
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
  await phase3AddStorybookMcp(vault, servers, sandboxCwd);
  await phase3AddDataprofileMcp(vault, servers, sandboxCwd);
  await phase3AddGreatExpectationsMcp(vault, servers, sandboxCwd);
  await phase3AddMonteCarloMcp(vault, servers, sandboxCwd);
  await phase3AddBigeyeMcp(vault, servers, sandboxCwd);
  return servers;
}
