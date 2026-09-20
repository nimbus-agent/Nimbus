import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { cliEnvFor } from "../local-auth/local-auth-env.ts";

/**
 * The child environment that makes a `gcloud` spawn authenticate AS the configured
 * service-account key file.
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` alone does not do that. It is an Application Default
 * Credentials variable, read by Google's client LIBRARIES; the gcloud CLI ignores it for its own
 * auth (https://docs.cloud.google.com/sdk/docs/authenticate). Every gcloud spawn in this tree set
 * only that variable, so each one ran as whatever account `gcloud auth login` had last activated —
 * or failed when there was none — while `gcp.credentials_json_path` was required and had no
 * effect. `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` is the variable gcloud actually reads.
 *
 * Both are set: the ADC variable still serves any client library a spawned connector loads. This
 * is the ONE place the pair is built, so a future gcloud spawn cannot set one and forget the
 * other.
 */
export function gcloudKeyFileEnv(credPath: string): Record<string, string> {
  return {
    GOOGLE_APPLICATION_CREDENTIALS: credPath,
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: credPath,
  };
}

/** How a GCP connector authenticates. `key` = a service-account file; `gcloud` = the owner's login. */
export type GcpAuth =
  | { readonly kind: "key"; readonly credPath: string }
  | { readonly kind: "gcloud" };

/** A configured key path wins: it is the more specific instruction. */
export function resolveGcpAuth(credPath: string | null, authSource: string | null): GcpAuth | null {
  const p = credPath?.trim() ?? "";
  if (p !== "") return { kind: "key", credPath: p };
  return authSource?.trim() === "gcloud" ? { kind: "gcloud" } : null;
}

/**
 * The gcloud child env for either mode. `gcloud` mode sets NO credential variable, so gcloud uses
 * its own active login — which is the point; `CLOUDSDK_CONFIG` is forwarded so a non-default
 * gcloud config directory the detector saw is the one the sync uses.
 */
export function gcloudAuthEnv(
  auth: GcpAuth,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const passthrough = cliEnvFor("gcloud", env);
  return auth.kind === "key" ? { ...passthrough, ...gcloudKeyFileEnv(auth.credPath) } : passthrough;
}

export async function loadGcpAuthFromVault(vault: NimbusVault): Promise<GcpAuth | null> {
  const [credPath, authSource] = await Promise.all([
    readConnectorSecret(vault, "gcp", "credentials_json_path"),
    readConnectorSecret(vault, "gcp", "auth_source"),
  ]);
  return resolveGcpAuth(credPath, authSource);
}
