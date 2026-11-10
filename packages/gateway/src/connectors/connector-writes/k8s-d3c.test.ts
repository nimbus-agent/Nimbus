// Phase 9.7 D3c (A10): the Kubernetes restart and scale. Typed previews, the deployment's current
// state as the before-state (`k8s_deployment_get`), and a confirm that names the context, namespace
// and deployment. Declared keys come from the INSTALLED connector's source, not from this file.
import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  declaredInputKeys,
  withSchemaArgumentDeclarations,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { isDeploymentResourceType } from "./cloud-readers.ts";
import { renderConfirmText } from "./confirm.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { buildConnectorWritePreviewFrom, renderConnectorWritePreviewLines } from "./preview.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const codeByFile = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));

function declaredKeys(toolId: string): string[] {
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined) throw new Error(`${toolId}: not a registered write`);
  const code = codeByFile.get(reg.file) ?? "";
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return declaredInputKeys(withSchemaArgumentDeclarations(sources, code, call)).sort();
}

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

const RESTART = { context: "prod", namespace: "shop", resourceType: "deployment", name: "api" };
const SCALE = { context: "prod", namespace: "shop", deploymentName: "api", replicas: 5 };
const DEPLOYMENT_REPLY = (name: string, namespace: string) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        name,
        namespace,
        replicas: 3,
        readyReplicas: 2,
        generation: 7,
        observedGeneration: 7,
        restartedAt: "2026-11-01T10:00:00Z",
        images: ["ghcr.io/acme/api:1.4.0"],
      }),
    },
  ],
});

describe("the two D3c rows (restart, scale)", () => {
  test("typed preview, before-state, confirm; offerable; Wave 4; pod delete stays classified-only", () => {
    for (const id of ["k8s_rollout_restart", "k8s_deployment_scale"]) {
      const r = rowOf(id);
      expect(r.wave, id).toBe(4);
      expect(r.preview, id).toBeDefined();
      expect(r.before?.tool, id).toBe("k8s_deployment_get");
      expect(r.confirm, id).toBeDefined();
      expect(r.bound, id).toBeUndefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
    const pod = rowOf("k8s_pod_delete");
    expect(pod.preview).toBeUndefined();
    expect(isModelOfferableRow(pod)).toBe(false);
  });

  test("the preview keys equal the installed connector's declared keys (both require context and namespace)", () => {
    for (const id of ["k8s_rollout_restart", "k8s_deployment_scale", "k8s_pod_delete"]) {
      const preview = rowOf(id).preview;
      if (id === "k8s_pod_delete") {
        expect(declaredKeys(id)).toEqual(["context", "namespace", "podName"]);
        continue;
      }
      if (preview === undefined) throw new Error(id);
      expect([...previewTemplateKeys(preview)].sort(), id).toEqual(declaredKeys(id));
    }
  });

  test("the confirm text names context, namespace and deployment (and the count for a scale)", () => {
    const restart = renderConfirmText(rowOf("k8s_rollout_restart"), RESTART);
    const scale = renderConfirmText(rowOf("k8s_deployment_scale"), SCALE);
    const del = renderConfirmText(rowOf("k8s_pod_delete"), {
      context: "prod",
      namespace: "shop",
      podName: "api-0",
    });
    expect(restart).toEqual({ ok: true, text: "kubernetes/restart prod/shop/api" });
    expect(scale).toEqual({ ok: true, text: "kubernetes/scale prod/shop/api to 5" });
    expect(del).toEqual({ ok: true, text: "kubernetes/delete prod/shop/api-0" });
    // The count is part of what is typed: a scale to 5 does not approve a scale to 0.
    const zero = renderConfirmText(rowOf("k8s_deployment_scale"), { ...SCALE, replicas: 0 });
    expect(zero).toEqual({ ok: true, text: "kubernetes/scale prod/shop/api to 0" });
  });

  test("a restart reads a deployment only; any other resource type has no reader, so no before-state", () => {
    const reader = rowOf("k8s_rollout_restart").before;
    if (reader === undefined) throw new Error("no reader");
    expect(reader.args(RESTART)).toEqual({ context: "prod", namespace: "shop", name: "api" });
    for (const type of ["deployments", "deploy"]) {
      expect(reader.args({ ...RESTART, resourceType: type }), type).toBeDefined();
    }
    for (const type of ["statefulset", "daemonset", "deployment.apps", "Deployment", "", 5]) {
      expect(reader.args({ ...RESTART, resourceType: type }), String(type)).toBeUndefined();
    }
    expect(isDeploymentResourceType("deployment")).toBe(true);
    expect(isDeploymentResourceType(undefined)).toBe(false);
    // A missing name, namespace or context reads nothing.
    for (const key of ["context", "namespace", "name"]) {
      expect(reader.args({ ...RESTART, [key]: "" }), key).toBeUndefined();
    }
  });

  test("a scale reads the deployment it names, by `deploymentName`", () => {
    const reader = rowOf("k8s_deployment_scale").before;
    if (reader === undefined) throw new Error("no reader");
    expect(reader.args(SCALE)).toEqual({ context: "prod", namespace: "shop", name: "api" });
    expect(reader.args({ ...SCALE, deploymentName: undefined })).toBeUndefined();
  });

  test("the before-state shows the current replicas and, for a scale, the change", () => {
    const restart = rowOf("k8s_rollout_restart").before;
    const scale = rowOf("k8s_deployment_scale").before;
    if (restart === undefined || scale === undefined) throw new Error("no reader");
    expect(restart.select(DEPLOYMENT_REPLY("api", "shop"), RESTART, undefined)).toEqual([
      { label: "Deployment", value: "api" },
      { label: "Namespace", value: "shop" },
      { label: "Replicas", value: "3" },
      { label: "Ready replicas", value: "2" },
      { label: "Last restarted", value: "2026-11-01T10:00:00Z" },
      { label: "Images", value: "ghcr.io/acme/api:1.4.0" },
    ]);
    expect(
      scale
        .select(DEPLOYMENT_REPLY("api", "shop"), SCALE, undefined)
        .map((f) => [f.label, f.value]),
    ).toContainEqual(["Replicas (now -> new)", "3 -> 5"]);
  });

  test("a reply for another deployment or namespace is refused, never shown as this one's", () => {
    const scale = rowOf("k8s_deployment_scale").before;
    if (scale === undefined) throw new Error("no reader");
    expect(() => scale.select(DEPLOYMENT_REPLY("other", "shop"), SCALE, undefined)).toThrow();
    expect(() => scale.select(DEPLOYMENT_REPLY("api", "kube-system"), SCALE, undefined)).toThrow();
    expect(() =>
      scale.select({ content: [{ type: "text", text: "{}" }] }, SCALE, undefined),
    ).toThrow();
  });

  test("the prompt preview names the context and namespace", () => {
    const action: PlannedAction = {
      type: "kubernetes.deployment.scale",
      origin: "model",
      payload: {
        mcpToolId: mcpClientToolKey(
          serviceOf("kubernetes.deployment.scale"),
          "k8s_deployment_scale",
        ),
        input: SCALE,
      },
    };
    const p = buildConnectorWritePreviewFrom(action, CONNECTOR_WRITE_ROWS, () => "personal");
    if (p === undefined) throw new Error("no preview");
    const lines = renderConnectorWritePreviewLines(p).join("\n");
    expect(lines).toContain("prod/shop/api");
    expect(lines).toContain("Scale deployment api in namespace shop of context prod to 5 replicas");
  });
});
