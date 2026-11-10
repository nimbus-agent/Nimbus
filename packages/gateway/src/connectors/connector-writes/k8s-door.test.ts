// packages/gateway/src/connectors/connector-writes/k8s-door.test.ts
// D3a: the Kubernetes apply on the model door. The call shape is gateway-main's (the production
// `createModelWriteToolSource`, no approvedK8sPairs seam) over a real V86 database and the real
// agent-tool builder. The apply is offered only while the owner approved a (context, namespace)
// pair AND approved the tool by name, re-checked per call; the offered schema omits both bound
// hashes; the description lists the approved pairs; the model-door refusals reach the model as
// fixed texts.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { buildConnectorWriteAgentTools } from "../../engine/connector-write-agent-tools.ts";
import { readListedJsonSchema } from "../../engine/user-mcp-agent-tools.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { removeModelWriteEnablement, setModelWriteEnablement } from "./enablement-store.ts";
import { type K8sGrant, removeK8sGrants, setK8sGrants } from "./k8s-grants.ts";
import { K8S_MODEL_REFUSALS } from "./k8s-limits.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;
const APPLY = "kubernetes__k8s_manifest_apply";

const schema = (keys: readonly string[]) =>
  toStandardSchema({
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, {}])),
    required: [...keys],
  } as Parameters<typeof toStandardSchema>[0]);

function listing(omit: readonly string[] = []): Record<string, unknown> {
  const tools: Record<string, readonly string[]> = {
    k8s_manifest_apply: ["context", "namespace", "manifest", "planSha256", "diffSha256"],
    k8s_manifest_plan: ["context", "namespace", "manifest"],
    k8s_rollout_restart: ["context", "namespace", "resourceType", "name"],
    k8s_deployment_scale: ["context", "namespace", "deploymentName", "replicas"],
    k8s_deployment_get: ["context", "namespace", "name"],
  };
  const out: Record<string, unknown> = {};
  for (const [id, keys] of Object.entries(tools)) {
    if (omit.includes(id)) continue;
    out[mcpClientToolKey("kubernetes", id)] = {
      description: `the connector's ${id}`,
      inputSchema: schema(keys),
    };
  }
  return out;
}

const PROD: K8sGrant = {
  context: "prod-east",
  namespace: "shop",
  server: "api.prod.example.com:6443",
  credentialForm: "token",
};
const STAGE: K8sGrant = { ...PROD, context: "stage", server: "api.stage.example.com:443" };

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 86);
});
afterEach(() => db.close());

/** The call gateway-main makes: NO `approvedK8sPairs`. */
async function offeredTools(
  over: { omit?: readonly string[]; executor?: () => { execute: () => Promise<unknown> } } = {},
) {
  const src = createModelWriteToolSource({
    db,
    enforcedPolicy: () => ALLOWED,
    listServerTools: async (service) =>
      service === "kubernetes" ? listing(over.omit ?? []) : undefined,
    toolsEpoch: () => 0,
    warn: () => {},
    getTribalKbConfig: () => undefined,
  });
  return await buildConnectorWriteAgentTools(
    src,
    (over.executor ?? (() => undefined)) as never,
    (_s, _t, d) => d,
    new Set(),
  );
}

type OfferedTool = {
  description: string;
  inputSchema: unknown;
  execute: (input: unknown) => Promise<unknown>;
};

describe("the Kubernetes apply is offered from the stored V86 grants", () => {
  test("a stored pair and the owner's approval by name offer it; the description names the pairs", async () => {
    setK8sGrants(db, [PROD, STAGE], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    const tools = await offeredTools();
    expect(Object.keys(tools)).toEqual([APPLY]);
    const text = (tools[APPLY] as OfferedTool).description;
    expect(text).toContain("prod-east/shop");
    expect(text).toContain("stage/shop");
    // Never a hash, a server address or the connector's own words about the hashes.
    expect(text).not.toContain("api.prod.example.com");
    expect(text).not.toContain("planSha256");
    expect(text).toContain("Secrets, RBAC objects");
  });

  test("the offered input schema omits BOTH bound hashes and keeps the three real inputs", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    const tool = (await offeredTools())[APPLY] as OfferedTool;
    const json = readListedJsonSchema(tool.inputSchema) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(json.properties).sort()).toEqual(["context", "manifest", "namespace"]);
    expect(json.required ?? []).not.toContain("planSha256");
    expect(JSON.stringify(json)).not.toContain("diffSha256");
  });

  test("disable removes the offer; the grant is read fresh, a re-enable replaces the pairs", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    expect((await offeredTools())[APPLY]).toBeDefined();
    setK8sGrants(db, [STAGE], 2);
    const text = ((await offeredTools())[APPLY] as OfferedTool).description;
    expect(text).toContain("stage/shop");
    expect(text).not.toContain("prod-east");
    removeModelWriteEnablement(db, "kubernetes");
    removeK8sGrants(db);
    expect(Object.keys(await offeredTools())).toEqual([]);
  });

  test("enabled with no stored pair: not offered", async () => {
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    expect(Object.keys(await offeredTools())).toEqual([]);
  });

  test("a pair stored but the tool not approved by name (an earlier opt-in): not offered", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, []);
    expect(Object.keys(await offeredTools())).toEqual([]);
  });

  test("max_wave 3 offers nothing of a wave-4 row", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 3, 1, ["k8s_manifest_apply"]);
    expect(Object.keys(await offeredTools())).toEqual([]);
  });

  test("the prepare tool missing from the live listing: not offered (real ids)", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    expect(Object.keys(await offeredTools({ omit: ["k8s_manifest_plan"] }))).toEqual([]);
  });
});

describe("the restart and the scale (D3c) are offered from the same grants", () => {
  const RESTART = "kubernetes__k8s_rollout_restart";
  const SCALE = "kubernetes__k8s_deployment_scale";

  test("with a pair and each approved by name, both are offered and name the approved pairs", async () => {
    setK8sGrants(db, [PROD, STAGE], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, [
      "k8s_rollout_restart",
      "k8s_deployment_scale",
    ]);
    const tools = await offeredTools();
    expect(Object.keys(tools).sort()).toEqual([SCALE, RESTART]);
    for (const name of [RESTART, SCALE]) {
      const text = (tools[name] as OfferedTool).description;
      expect(text).toContain("prod-east/shop");
      expect(text).toContain("stage/shop");
    }
  });

  test("with no approved pair, neither is offered", async () => {
    setModelWriteEnablement(db, "kubernetes", 4, 1, [
      "k8s_rollout_restart",
      "k8s_deployment_scale",
    ]);
    expect(Object.keys(await offeredTools())).toEqual([]);
  });

  test("the reader is part of the offer: no k8s_deployment_get in the listing, no restart or scale", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, [
      "k8s_rollout_restart",
      "k8s_deployment_scale",
    ]);
    expect(Object.keys(await offeredTools({ omit: ["k8s_deployment_get"] }))).toEqual([]);
  });

  test("only the rows approved by name are offered", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_deployment_scale"]);
    expect(Object.keys(await offeredTools())).toEqual([SCALE]);
  });
});

describe("per-call re-checks and the model-door refusals", () => {
  const ok = { execute: async () => ({ status: "ok", result: { ok: true } }) };
  const MANIFEST = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: c", ""].join("\n");

  test("a grant removed after the listing refuses the call before the executor", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    let reached = 0;
    const tool = (
      await offeredTools({
        executor: () => ({
          execute: async () => {
            reached += 1;
            return { status: "ok", result: {} };
          },
        }),
      })
    )[APPLY] as OfferedTool;
    removeK8sGrants(db);
    const out = await tool.execute({ context: "prod-east", namespace: "shop", manifest: MANIFEST });
    expect(out).toEqual({ refused: "this connector write is no longer enabled; ask again" });
    expect(reached).toBe(0);
  });

  test("RBAC kinds and host-access settings reach the model as the fixed refusals", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    const tool = (await offeredTools({ executor: () => ok }))[APPLY] as OfferedTool;
    const role = [
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: Role",
      "metadata:",
      "  name: r",
      "",
    ].join("\n");
    const hostNet = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: d",
      "spec:",
      "  template:",
      "    spec:",
      "      hostNetwork: true",
      "",
    ].join("\n");
    expect(await tool.execute({ context: "prod-east", namespace: "shop", manifest: role })).toEqual(
      { refused: K8S_MODEL_REFUSALS.rbacKind },
    );
    expect(
      await tool.execute({ context: "prod-east", namespace: "shop", manifest: hostNet }),
    ).toEqual({ refused: K8S_MODEL_REFUSALS.hostAccess });
  });

  test("an allowed manifest reaches the executor as an origin: model action", async () => {
    setK8sGrants(db, [PROD], 1);
    setModelWriteEnablement(db, "kubernetes", 4, 1, ["k8s_manifest_apply"]);
    const seen: unknown[] = [];
    const tool = (
      await offeredTools({
        executor: () => ({
          execute: async (a?: unknown) => {
            seen.push(a);
            return { status: "ok", result: { ok: true } };
          },
        }),
      })
    )[APPLY] as OfferedTool;
    const input = { context: "prod-east", namespace: "shop", manifest: MANIFEST };
    expect(await tool.execute(input)).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({
      type: "kubernetes.manifest.apply",
      origin: "model",
      payload: { mcpToolId: "kubernetes_k8s_manifest_apply", input },
    });
  });
});
