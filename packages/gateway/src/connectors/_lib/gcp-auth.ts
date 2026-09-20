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
