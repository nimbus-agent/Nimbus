// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-cloud-env.ts
// The granted clouds' credential environment for a Terraform child (invariants I1, I15; static
// D43(d)). Split out of `iac-runner.ts` with no behaviour change: it reads the Vault and returns
// plain variables, it builds no profile and no spawn; the runner passes the result into its one
// `extensionProcessEnv` call.
import type { NimbusVault } from "../../../vault/nimbus-vault.ts";
import { gcloudKeyFileEnv, loadGcpAuthFromVault } from "../../_lib/gcp-auth.ts";
import { readConnectorSecret } from "../../connector-vault.ts";
import type { IacGrants } from "../../connector-writes/iac-grants.ts";
import { loadAwsCreds } from "../phase3-shared.ts";

/** The granted clouds' credential environment and the credential files the child must read. */
export async function loadIacCloudEnv(
  vault: NimbusVault,
  grants: IacGrants,
): Promise<{ env: Record<string, string>; files: string[] }> {
  const env: Record<string, string> = {};
  const files: string[] = [];
  if (grants.clouds.includes("aws")) {
    const creds = await loadAwsCreds(vault);
    if (creds.ok) Object.assign(env, creds.env);
  }
  if (grants.clouds.includes("azure")) {
    const t = (await readConnectorSecret(vault, "azure", "tenant_id"))?.trim() ?? "";
    const c = (await readConnectorSecret(vault, "azure", "client_id"))?.trim() ?? "";
    const s = (await readConnectorSecret(vault, "azure", "client_secret"))?.trim() ?? "";
    if (t !== "" && c !== "" && s !== "") {
      env["ARM_TENANT_ID"] = t;
      env["ARM_CLIENT_ID"] = c;
      env["ARM_CLIENT_SECRET"] = s;
    }
  }
  if (grants.clouds.includes("gcp")) {
    const auth = await loadGcpAuthFromVault(vault);
    if (auth?.kind === "key") {
      Object.assign(env, gcloudKeyFileEnv(auth.credPath));
      files.push(auth.credPath);
    }
  }
  return { env, files };
}
