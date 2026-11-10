// Phase 9.7 D3a A8: the exact consent prompt of the Kubernetes apply (CLI and desktop show the same
// text; the CLI prints it verbatim). Built by the real settler, the real preview builder and the
// real prompt formatter, compared as a whole: the cluster and counts first, the objects, the diff in
// full, ONE footer, then the fixed typed-confirm line carrying the DERIVED target.
import { describe, expect, test } from "bun:test";
import { formatConsentPrompt } from "../../engine/executor.ts";
import { planReply } from "../../engine/k8s-plan-reply.test-helpers.ts";
import { settleK8sManifest } from "../../engine/k8s-settle.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { confirmPromptLine, renderConfirmText } from "./confirm.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { buildConnectorWritePreview, type ConnectorWritePreview } from "./preview.ts";

const CONTEXT = "prod-east";
const NS = "shop";
const SERVER = "api.prod.example.com:6443";
const ONE = [
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: cfg",
  "data:",
  "  k: v",
  "",
].join("\n");
const TWO = [
  ONE.trimEnd(),
  "---",
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: api",
  "",
].join("\n");

function build(manifest: string): { prompt: string; confirm: string; action: PlannedAction } {
  const input = { context: CONTEXT, namespace: NS, manifest };
  const action: PlannedAction = {
    type: "kubernetes.manifest.apply",
    origin: "model",
    payload: { mcpToolId: "kubernetes_k8s_manifest_apply", input },
  };
  const settled = settleK8sManifest({
    input,
    reply: planReply(manifest, NS, CONTEXT),
    server: SERVER,
  });
  const built = buildConnectorWritePreview(action);
  if (built === undefined) throw new Error("no preview");
  const preview: ConnectorWritePreview = {
    ...built,
    prepared: { status: "ok", fields: [...settled.fields] },
    ...(settled.plan === undefined ? {} : { plan: settled.plan }),
  };
  const row = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === "k8s_manifest_apply");
  if (row === undefined) throw new Error("no row");
  const text = renderConfirmText(row, input);
  if (!text.ok) throw new Error(text.reason);
  return {
    prompt: `${formatConsentPrompt(action, undefined, preview)}\n\n${confirmPromptLine(text.text)}`,
    confirm: text.text,
    action,
  };
}

describe("the consent prompt of the Kubernetes apply", () => {
  test("one object: cluster and counts, the diff, one footer, then the derived typed line", () => {
    const { prompt, confirm } = build(ONE);
    expect(confirm).toBe(`kubernetes/apply ${CONTEXT}/${NS} ConfigMap/cfg`);
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("Action requires your approval");
    expect(lines).toContain("Type: kubernetes.manifest.apply");
    expect(lines).toContain("Requested by: the model");
    expect(lines).toContain(`Target:  ${CONTEXT}/${NS}`);
    // The cluster the OWNER approved (context and host:port) comes from the settler, not the child.
    expect(lines).toContain(`  Cluster: ${CONTEXT} (${SERVER})`);
    // Counts and the object list come before the diff; the footer is the last plan line.
    expect(lines.indexOf("Objects: 1")).toBeLessThan(lines.findIndex((l) => l.startsWith("+")));
    expect(lines.filter((l) => l.startsWith("End of "))).toHaveLength(1);
    expect(lines.at(-3)).toBe("End of plan: 1 objects");
    expect(lines.at(-1)).toBe(`To approve, type exactly: ${confirm}`);
    // The manifest the owner approves is on screen above the typed line, in full.
    expect(prompt).toContain("kind: ConfigMap");
    expect(prompt).toContain("Differences: yes");
  });

  test("several objects: the typed line carries the count and a hash prefix; the whole prompt as a golden", () => {
    const { prompt, confirm } = build(TWO);
    expect(confirm).toMatch(
      new RegExp(`^kubernetes/apply ${CONTEXT}/${NS} 2 objects [0-9a-f]{12}$`),
    );
    expect(prompt.split("\n").at(-1)).toBe(`To approve, type exactly: ${confirm}`);
    const HASH = "6da80fed9dcb768d9e943cd62b2ba98b1b34a029768283410dbb2770afc204bb";
    expect(prompt).toBe(
      [
        "Action requires your approval",
        "",
        "Type: kubernetes.manifest.apply",
        "Requested by: the model",
        "",
        "Service: kubernetes",
        "Target:  prod-east/shop",
        "Apply the manifest below to namespace shop of context prod-east",
        "",
        '  Context: "prod-east"',
        '  Namespace: "shop"',
        `  Manifest: ${JSON.stringify(TWO)}`,
        "",
        "Prepared:",
        "  Cluster: prod-east (api.prod.example.com:6443)",
        "  Namespace: shop",
        "  Objects: 2",
        "  Differences: yes",
        `  Plan hash: ${HASH}`,
        "",
        "Objects: 2",
        "ConfigMap/cfg (v1)",
        "Deployment/api (apps/v1)",
        "Differences: yes",
        "--- live configmap/cfg",
        "+++ planned configmap/cfg",
        "@@ -1,1 +1,11 @@",
        "-(absent: will be created)",
        "+{",
        '+  "apiVersion": "v1",',
        '+  "data": {',
        '+    "k": "v"',
        "+  },",
        '+  "kind": "ConfigMap",',
        '+  "metadata": {',
        '+    "name": "cfg",',
        '+    "namespace": "shop"',
        "+  }",
        "+}",
        "--- live deployment.apps/api",
        "+++ planned deployment.apps/api",
        "@@ -1,1 +1,8 @@",
        "-(absent: will be created)",
        "+{",
        '+  "apiVersion": "apps/v1",',
        '+  "kind": "Deployment",',
        '+  "metadata": {',
        '+    "name": "api",',
        '+    "namespace": "shop"',
        "+  }",
        "+}",
        "End of plan: 2 objects",
        "",
        `To approve, type exactly: kubernetes/apply prod-east/shop 2 objects ${HASH.slice(0, 12)}`,
      ].join("\n"),
    );
  });
});
