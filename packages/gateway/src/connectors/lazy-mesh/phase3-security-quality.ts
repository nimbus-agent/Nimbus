import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import { addSimpleTokenServer, addUrlAndSecretMcp } from "./phase3-shared.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, sandboxCwd: string): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), sandboxCwd);
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

export async function phase3AddDependencytrackMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addUrlAndSecretMcp(vault, servers, sandboxCwd, {
    service: "dependencytrack",
    urlSecretKey: "base_url",
    credentialSecretKey: "api_key",
    urlEnvVar: "DEPENDENCYTRACK_URL",
    credentialEnvVar: "DEPENDENCYTRACK_API_KEY",
  });
}
