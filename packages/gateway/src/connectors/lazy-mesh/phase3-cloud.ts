import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { manifestForFirstParty, manifestWithExtraNetworkHosts } from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import { isSafeRegion, loadAwsCreds, VERTEX_AI_DEFAULT_REGION } from "./phase3-shared.ts";
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
