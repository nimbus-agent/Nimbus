import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import { addSimpleTokenServer, addUrlAndSecretMcp } from "./phase3-shared.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, sandboxCwd: string): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), sandboxCwd);
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

export async function phase3AddElasticsearchMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addUrlAndSecretMcp(vault, servers, sandboxCwd, {
    service: "elasticsearch",
    urlSecretKey: "url",
    credentialSecretKey: "api_key",
    urlEnvVar: "ELASTICSEARCH_URL",
    credentialEnvVar: "ELASTICSEARCH_API_KEY",
  });
}
