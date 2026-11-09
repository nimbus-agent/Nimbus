// packages/gateway/src/connectors/connector-writes/iac-door-workdirs.test.ts
// D2 whole-branch review finding 2: gateway-main builds the model's write source with
// `createModelWriteToolSource({...})` and NO `approvedWorkdirs`, so the Terraform apply was never
// offered in production. This drives that exact call shape (no `approvedWorkdirs`) over a real V85
// database holding a real workdir grant, through the real agent-tool builder, and shows the grant
// is read live: gone after `disable iac`, replaced by a re-enable.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { buildConnectorWriteAgentTools } from "../../engine/connector-write-agent-tools.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { removeModelWriteEnablement, setModelWriteEnablement } from "./enablement-store.ts";
import { removeIacGrants, setIacGrants } from "./iac-grants.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;
const APPLY = "iac__iac_terraform_apply";

const schema = (keys: readonly string[]) =>
  toStandardSchema({
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, {}])),
    required: [...keys],
  } as Parameters<typeof toStandardSchema>[0]);

function listing(): Record<string, unknown> {
  const tools: Record<string, readonly string[]> = {
    iac_terraform_apply: ["workingDirectory", "planFile", "planSha256"],
    iac_terraform_plan: ["workingDirectory"],
    iac_terraform_show_json: ["workingDirectory", "planFile"],
  };
  const out: Record<string, unknown> = {};
  for (const [id, keys] of Object.entries(tools)) {
    out[mcpClientToolKey("iac", id)] = {
      description: `the connector's ${id}`,
      inputSchema: schema(keys),
    };
  }
  return out;
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 85);
});
afterEach(() => db.close());

/** The call gateway-main makes: NO `approvedWorkdirs`. */
async function offeredTools() {
  const src = createModelWriteToolSource({
    db,
    enforcedPolicy: () => ALLOWED,
    listServerTools: async (service) => (service === "iac" ? listing() : undefined),
    toolsEpoch: () => 0,
    warn: () => {},
    getTribalKbConfig: () => undefined,
  });
  return await buildConnectorWriteAgentTools(
    src,
    () => undefined as never,
    (_s, _t, d) => d,
    new Set(),
  );
}

describe("the Terraform apply is offered from the stored V85 workdir grant", () => {
  test("a stored workdir grant offers the apply and names the directory; disable removes it", async () => {
    setIacGrants(db, { workdirs: ["/srv/infra/prod"], clouds: [], regions: [], net: [] }, 1);
    setModelWriteEnablement(db, "iac", 4, 1, ["iac_terraform_apply"]);
    const tools = await offeredTools();
    expect(Object.keys(tools)).toEqual([APPLY]);
    expect((tools[APPLY] as { description: string }).description).toContain("/srv/infra/prod");

    // `nimbus connector writes disable iac` drops the enablement and the grants.
    removeModelWriteEnablement(db, "iac");
    removeIacGrants(db);
    expect(Object.keys(await offeredTools())).toEqual([]);
  });

  test("the grant is read fresh on every listing: a re-enable with another directory replaces the first", async () => {
    setIacGrants(db, { workdirs: ["/srv/infra/prod"], clouds: [], regions: [], net: [] }, 1);
    setModelWriteEnablement(db, "iac", 4, 1, ["iac_terraform_apply"]);
    expect((await offeredTools())[APPLY]).toBeDefined();
    setIacGrants(db, { workdirs: ["/srv/infra/other"], clouds: [], regions: [], net: [] }, 2);
    const text = ((await offeredTools())[APPLY] as { description: string }).description;
    expect(text).toContain("/srv/infra/other");
    expect(text).not.toContain("/srv/infra/prod");
  });

  test("an enabled apply with no stored directory is not offered", async () => {
    setModelWriteEnablement(db, "iac", 4, 1, ["iac_terraform_apply"]);
    expect(Object.keys(await offeredTools())).toEqual([]);
  });
});
