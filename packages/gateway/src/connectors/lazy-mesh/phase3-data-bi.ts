import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import { addDirManifestServer, addUrlAndSecretMcp, isSafeHostIdentifier } from "./phase3-shared.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, sandboxCwd: string): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), sandboxCwd);
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

/**
 * The url-plus-one-secret connector shape, registered once.
 *
 * Five connectors — metabase, databricks, mlflow, dependencytrack,
 * elasticsearch — had byte-identical bodies differing only in the service id,
 * which vault keys hold the URL and credential, and the two env-var names. They
 * were the single largest duplication cluster in the gateway (70 lines across 5
 * blocks).
 *
 * Consolidating STRENGTHENS invariant I15 rather than weakening it. D10's static
 * check is file-scoped — a lazy-mesh file mentioning `Record<string, ServerSpec>`
 * must also contain `wrapServerSpec(` — so this file still satisfies it. More to
 * the point, the intent of I15 is that no `ServerSpec` reaches the mesh
 * unsandboxed, and a shared registrar makes that structural for this whole
 * family: a sixth url+secret connector added through it CANNOT forget the wrap,
 * whereas a sixth hand-written copy could.
 *
 * The blank-credential early return is preserved exactly: an unconfigured
 * connector registers NO server rather than a server that would fail at spawn.
 */

export async function phase3AddMetabaseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addUrlAndSecretMcp(vault, servers, sandboxCwd, {
    service: "metabase",
    urlSecretKey: "url",
    credentialSecretKey: "api_key",
    urlEnvVar: "METABASE_URL",
    credentialEnvVar: "METABASE_API_KEY",
  });
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
  await addUrlAndSecretMcp(vault, servers, sandboxCwd, {
    service: "databricks",
    urlSecretKey: "host",
    credentialSecretKey: "token",
    urlEnvVar: "DATABRICKS_HOST",
    credentialEnvVar: "DATABRICKS_TOKEN",
  });
}

export async function phase3AddMlflowMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addUrlAndSecretMcp(vault, servers, sandboxCwd, {
    service: "mlflow",
    urlSecretKey: "host",
    credentialSecretKey: "token",
    urlEnvVar: "MLFLOW_HOST",
    credentialEnvVar: "MLFLOW_TOKEN",
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
