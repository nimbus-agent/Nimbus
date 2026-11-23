import { type ConnectorAuthParams, firstEnvTrimmed } from "./auth-env.ts";

export function applyAwsConnectorAuth(
  p: ConnectorAuthParams,
  flags: {
    awsAccessKey?: string;
    awsSecretKey?: string;
    awsRegion?: string;
    awsProfile?: string;
  },
): void {
  const ak =
    flags.awsAccessKey?.trim() ||
    firstEnvTrimmed(["NIMBUS_AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"]);
  const sk =
    flags.awsSecretKey?.trim() ||
    firstEnvTrimmed(["NIMBUS_AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"]);
  const reg =
    flags.awsRegion?.trim() || firstEnvTrimmed(["NIMBUS_AWS_DEFAULT_REGION", "AWS_DEFAULT_REGION"]);
  const prof = flags.awsProfile?.trim() || firstEnvTrimmed(["NIMBUS_AWS_PROFILE", "AWS_PROFILE"]);
  const hasKeyPair = ak !== "" && sk !== "";
  if (hasKeyPair) {
    if (reg === "" && prof === "") {
      throw new Error(
        "AWS key pair requires --aws-region <r> or --aws-profile <p> (or set NIMBUS_AWS_DEFAULT_REGION / NIMBUS_AWS_PROFILE)",
      );
    }
    p.awsAccessKeyId = ak;
    p.awsSecretAccessKey = sk;
    if (reg !== "") {
      p.awsDefaultRegion = reg;
    }
    if (prof !== "") {
      p.awsProfile = prof;
    }
  } else {
    if (prof === "") {
      throw new Error(
        "AWS: use --aws-access-key + --aws-secret-key + region/profile, or --aws-profile only (or set env vars)",
      );
    }
    p.awsProfile = prof;
    if (reg !== "") {
      p.awsDefaultRegion = reg;
    }
  }
}

export function applyAzureConnectorAuth(
  p: ConnectorAuthParams,
  flags: {
    azureTenantId?: string;
    azureClientId?: string;
    azureClientSecret?: string;
  },
): void {
  const tenant =
    flags.azureTenantId?.trim() || firstEnvTrimmed(["NIMBUS_AZURE_TENANT_ID", "AZURE_TENANT_ID"]);
  const cid =
    flags.azureClientId?.trim() || firstEnvTrimmed(["NIMBUS_AZURE_CLIENT_ID", "AZURE_CLIENT_ID"]);
  const sec =
    flags.azureClientSecret?.trim() ||
    firstEnvTrimmed(["NIMBUS_AZURE_CLIENT_SECRET", "AZURE_CLIENT_SECRET"]);
  if (tenant === "" || cid === "" || sec === "") {
    throw new Error(
      "Azure requires tenant id, client id, and client secret (flags --azure-tenant-id, --azure-client-id, --azure-client-secret or env AZURE_*)",
    );
  }
  p.azureTenantId = tenant;
  p.azureClientId = cid;
  p.azureClientSecret = sec;
}

export function applyGcpConnectorAuth(
  p: ConnectorAuthParams,
  flags: { gcpCredentialsJson?: string; gcpProjectId?: string },
): void {
  const pathRaw =
    flags.gcpCredentialsJson?.trim() ||
    firstEnvTrimmed(["NIMBUS_GCP_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS"]);
  if (pathRaw === "") {
    throw new Error(
      "GCP requires --gcp-credentials-json <path> (or set GOOGLE_APPLICATION_CREDENTIALS / NIMBUS_GCP_CREDENTIALS_JSON)",
    );
  }
  p.gcpCredentialsJsonPath = pathRaw;
  const proj =
    flags.gcpProjectId?.trim() ||
    firstEnvTrimmed(["NIMBUS_GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT"]);
  if (proj !== "") {
    p.gcpProjectId = proj;
  }
}

export function applyIacConnectorAuth(p: ConnectorAuthParams, enable: boolean | undefined): void {
  if (enable !== true) {
    throw new Error("IaC connector is opt-in: nimbus connector auth iac --enable");
  }
  p.iacOptIn = true;
}

export function applyKubernetesConnectorAuth(
  p: ConnectorAuthParams,
  kubeconfig: string | undefined,
  context: string | undefined,
): void {
  const pathRaw = kubeconfig?.trim() || firstEnvTrimmed(["NIMBUS_KUBECONFIG", "KUBECONFIG"]);
  if (pathRaw === "") {
    throw new Error(
      "Kubernetes requires --kubeconfig <path> or env NIMBUS_KUBECONFIG / KUBECONFIG (vault key kubernetes.kubeconfig)",
    );
  }
  p.kubeconfigPath = pathRaw;
  if (context !== undefined && context.trim() !== "") {
    p.context = context.trim();
  }
}
