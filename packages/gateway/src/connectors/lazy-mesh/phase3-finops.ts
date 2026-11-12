import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

/**
 * Vantage (Phase 10 FinOps FO2): the read-only cost and recommendation connector. A blank
 * `vantage.api_token` registers nothing. The three optional keys (cost report, workspace, grouping)
 * reach the child only when stored, through `extensionProcessEnv` (I1), and the child is sandboxed
 * to the fixed host `api.vantage.sh` by `wrapServerSpec` (I15, static D10). The host is a vendor
 * constant: no wildcard and no owner-configured entry.
 */
export async function phase3AddVantageMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const token = (await readConnectorSecret(vault, "vantage", "api_token"))?.trim() ?? "";
  if (token === "") {
    return;
  }
  const options = [
    ["VANTAGE_COST_REPORT_TOKEN", "cost_report_token"],
    ["VANTAGE_WORKSPACE_TOKEN", "workspace_token"],
    ["VANTAGE_GROUP_BY", "group_by"],
  ] as const;
  const values = await Promise.all(
    options.map(
      async ([, key]) => (await readConnectorSecret(vault, "vantage", key))?.trim() ?? "",
    ),
  );
  const optional: Record<string, string> = {};
  options.forEach(([envName], i) => {
    const value = values[i] ?? "";
    if (value !== "") {
      optional[envName] = value;
    }
  });
  servers["vantage"] = wrapServerSpec(
    {
      ...connectorSpawn("vantage"),
      env: extensionProcessEnv({ VANTAGE_API_TOKEN: token, ...optional }),
    },
    manifestForFirstParty("vantage"),
    sandboxCwd,
  );
}
