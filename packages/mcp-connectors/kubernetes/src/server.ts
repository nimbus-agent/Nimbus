import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { runCliJson, runCliOk } from "../../shared/run-cli-json.ts";

function requireKubeconfigPath(): string {
  const p = process.env["KUBECONFIG"]?.trim();
  if (p === undefined || p === "") {
    throw new Error("KUBECONFIG env must be set to a kubeconfig file path");
  }
  return p;
}

function kubectlBase(): string[] {
  const args = ["kubectl"];
  const ctx = process.env["KUBE_CONTEXT"]?.trim();
  if (ctx !== undefined && ctx !== "") {
    args.push("--context", ctx);
  }
  return args;
}

function kubeEnv(): Record<string, string | undefined> {
  return { KUBECONFIG: requireKubeconfigPath() };
}

async function kubectlJson(rest: string[]): Promise<unknown> {
  const cmd = [...kubectlBase(), ...rest, "-o", "json"];
  const r = await runCliJson(cmd, kubeEnv());
  if (!r.ok) {
    throw new Error(r.message);
  }
  return r.data;
}

const optionalNamespaceSchema = z.object({ namespace: z.string().min(1).optional() });

async function k8sListNamespacedResource(p: { namespace?: string | undefined }, resource: string) {
  const ns = p.namespace ?? "default";
  const data = await kubectlJson(["get", resource, "-n", ns]);
  return jsonResult(data ?? {});
}

const mcp = new McpServer({ name: "nimbus-kubernetes", version: "0.1.0" });

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

/**
 * Every MUTATING kubernetes tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(mcp, {
  connector: "kubernetes",
  scopeEnv: "NIMBUS_MCP_KUBERNETES_WRITE_SCOPE",
  scopeKinds: ["namespace"],
});

reg(
  "k8s_pod_list",
  "List pods in a namespace (default namespace: default).",
  optionalNamespaceSchema,
  (p) => k8sListNamespacedResource(p, "pods"),
);

reg("k8s_deployment_list", "List deployments in a namespace.", optionalNamespaceSchema, (p) =>
  k8sListNamespacedResource(p, "deployments"),
);

reg("k8s_event_list", "List events in a namespace.", optionalNamespaceSchema, (p) =>
  k8sListNamespacedResource(p, "events"),
);

registerWriteTool(
  "k8s_rollout_restart",
  {
    mutates: "kubernetes.rollout.restart",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace ?? "default" }),
  },
  "Restart a rollout (e.g. deployment).",
  z.object({
    namespace: z.string().min(1).optional(),
    resourceType: z.string().min(1),
    name: z.string().min(1),
  }),
  async (p) => {
    const ns = p.namespace ?? "default";
    const cmd = [...kubectlBase(), "rollout", "restart", p.resourceType, p.name, "-n", ns];
    const r = await runCliOk(cmd, kubeEnv());
    if (!r.ok) {
      throw new Error(r.message);
    }
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "k8s_pod_delete",
  {
    mutates: "kubernetes.pod.delete",
    // A deleted pod is not restorable; its identity is all that remains to record.
    recoverable: false,
    capturePreState: (p) => Promise.resolve({ namespace: p.namespace, podName: p.podName }),
    scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace ?? "default" }),
  },
  "Delete a pod.",
  z.object({
    namespace: z.string().min(1).optional(),
    podName: z.string().min(1),
  }),
  async (p) => {
    const ns = p.namespace ?? "default";
    const cmd = [...kubectlBase(), "delete", "pod", p.podName, "-n", ns];
    const r = await runCliOk(cmd, kubeEnv());
    if (!r.ok) {
      throw new Error(r.message);
    }
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "k8s_deployment_scale",
  {
    mutates: "kubernetes.deployment.scale",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "namespace", value: p.namespace ?? "default" }),
  },
  "Scale a deployment.",
  z.object({
    namespace: z.string().min(1).optional(),
    deploymentName: z.string().min(1),
    replicas: z.number().int().min(0),
  }),
  async (p) => {
    const ns = p.namespace ?? "default";
    const cmd = [
      ...kubectlBase(),
      "scale",
      "deployment",
      p.deploymentName,
      `-n`,
      ns,
      `--replicas=${String(p.replicas)}`,
    ];
    const r = await runCliOk(cmd, kubeEnv());
    if (!r.ok) {
      throw new Error(r.message);
    }
    return jsonResult({ ok: true });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
