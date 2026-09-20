/**
 * Config-LOCATION variables forwarded from the gateway's environment into a local CLI's child
 * env, on top of `extensionProcessEnv`'s baseline (I1).
 *
 * Why this exists: the baseline strips every variable but a fixed dozen, so a user whose
 * `AWS_CONFIG_FILE` or `GH_CONFIG_DIR` points somewhere non-default would get a detection that
 * finds their profile and a sync that cannot — a reference that detects but does not work.
 *
 * The list is CLOSED and names only paths and bus addresses. No credential variable (`GH_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY`, …) is ever on it; a test pins that with sentinels. `kubectl` has no
 * entry: detection resolves the kubeconfig value itself and passes it as `KUBECONFIG`, the same
 * value the sync later passes.
 *
 * Stated bound: these are read from the GATEWAY's environment — the shell that ran
 * `nimbus start`. A gateway started some other way may not see a variable the user's interactive
 * shell sets; detection then reports what the gateway can actually use.
 */
const PASSTHROUGH: Readonly<Record<"gh" | "aws" | "gcloud", readonly string[]>> = Object.freeze({
  gh: ["GH_CONFIG_DIR", "XDG_CONFIG_HOME"],
  aws: ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"],
  gcloud: ["CLOUDSDK_CONFIG"],
});

/** Newer gh keeps its token in the Secret Service on Linux; `gh auth token` needs the bus. */
const GH_KEYRING: readonly string[] = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];

export function cliEnvFor(
  source: "gh" | "aws" | "gcloud",
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly keyring?: boolean } = {},
): Record<string, string> {
  const names =
    source === "gh" && opts.keyring === true
      ? [...PASSTHROUGH[source], ...GH_KEYRING]
      : PASSTHROUGH[source];
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = env[name];
    if (v !== undefined && v.trim() !== "") out[name] = v;
  }
  return out;
}
