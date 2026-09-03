import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import { addDirManifestServer, addSimpleTokenServer } from "./phase3-shared.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, sandboxCwd: string): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), sandboxCwd);
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
