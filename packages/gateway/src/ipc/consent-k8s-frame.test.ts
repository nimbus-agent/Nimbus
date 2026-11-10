// packages/gateway/src/ipc/consent-k8s-frame.test.ts
// D3a A8 (plan risk): a Kubernetes apply travels its manifest AND its rendered plan twice in one
// `consent.request` frame (the prompt text and the structured details). The worst cases the caps
// allow (a 48 KiB manifest, a 96 KiB rendered plan, both of the characters JSON doubles) are built
// with the real preview builder and prompt formatter and MEASURED against the NDJSON line limit.
import { afterEach, describe, expect, test } from "bun:test";
import { confirmPromptLine } from "../connectors/connector-writes/confirm.ts";
import { renderedText } from "../connectors/connector-writes/iac-plan-preview.ts";
import { K8S_LIMITS } from "../connectors/connector-writes/k8s-limits.ts";
import { buildConnectorWritePreview } from "../connectors/connector-writes/preview.ts";
import { consentDisplayPayload, formatConsentPrompt } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";
import { IPC_MAX_LINE_BYTES, type JsonRpcNotification } from "./jsonrpc.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

const NL = "\n";
const KIB = 1024;

/** A rendered plan of the largest size the renderer allows, in lines of `lineChars` quotes. */
function worstPlan(lineChars: number) {
  const lines: string[] = [];
  let bytes = 0;
  for (;;) {
    const next = '"'.repeat(lineChars);
    const add = next.length + (lines.length === 0 ? 0 : 1);
    if (bytes + add > K8S_LIMITS.maxRenderedBytes) break;
    lines.push(next);
    bytes += add;
  }
  return renderedText(lines);
}

/** A manifest of the largest size the gateway accepts, nearly all of it characters JSON doubles. */
function worstManifest(): string {
  const head = ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: big", "data:", ""].join(
    NL,
  );
  const lines: string[] = [];
  let bytes = Buffer.byteLength(head, "utf8");
  for (let i = 0; ; i++) {
    const line = `  k${String(i)}: '${'"'.repeat(900)}'${NL}`;
    if (bytes + Buffer.byteLength(line, "utf8") > K8S_LIMITS.maxManifestBytes) break;
    lines.push(line);
    bytes += Buffer.byteLength(line, "utf8");
  }
  return `${head}${lines.join("")}`;
}

function frameBytes(plan: ReturnType<typeof worstPlan>): number {
  const manifest = worstManifest();
  expect(Buffer.byteLength(manifest, "utf8")).toBeGreaterThan(K8S_LIMITS.maxManifestBytes - 1200);
  expect(Buffer.byteLength(manifest, "utf8")).toBeLessThanOrEqual(K8S_LIMITS.maxManifestBytes);
  const action: PlannedAction = {
    type: "kubernetes.manifest.apply",
    origin: "model",
    payload: {
      mcpToolId: "kubernetes_k8s_manifest_apply",
      input: { context: "c".repeat(60), namespace: "n".repeat(60), manifest },
    },
  };
  const built = buildConnectorWritePreview(action);
  if (built === undefined) throw new Error("no preview");
  const preview = {
    ...built,
    prepared: {
      status: "ok" as const,
      fields: [
        { label: "Cluster", value: `${"c".repeat(60)} (host.example.com:6443)` },
        { label: "Plan hash", value: "a".repeat(64) },
      ],
    },
    plan,
  };
  const confirmText = `kubernetes/apply ${"c".repeat(60)}/${"n".repeat(60)} 50 objects ${"a".repeat(12)}`;
  const prompt = `${formatConsentPrompt(action, undefined, preview)}${NL}${NL}${confirmPromptLine(confirmText)}`;
  const details = consentDisplayPayload(action, undefined, preview);
  const sent: JsonRpcNotification[] = [];
  const c = new ConsentCoordinatorImpl(() => (n) => sent.push(n));
  c.requestConfirmedConsent("a", {
    requestId: "r1",
    prompt,
    details,
    actionType: action.type,
    confirmText,
  }).catch(() => undefined);
  c.rejectAllPending("test", "test");
  return new TextEncoder().encode(`${JSON.stringify(sent[0])}${NL}`).length;
}

describe("the consent.request frame of a worst-case Kubernetes apply", () => {
  test.each([
    ["one long line of quotes (JSON doubles each)", 4000],
    ["the most lines the cap allows (one quote each)", 1],
  ] as const)(
    "a 48 KiB quote-heavy manifest AND the largest plan, %s: under 80% of the IPC line cap",
    (_name, lineChars) => {
      const plan = worstPlan(lineChars);
      expect(plan.bytes).toBeGreaterThan(K8S_LIMITS.maxRenderedBytes - 5000);
      const bytes = frameBytes(plan);
      // The manifest travels twice (prompt and details) and the plan twice, each doubled by JSON:
      // measured well under the line cap, with room for the hostile worst case of every field.
      expect(bytes, `measured ${String(bytes)} bytes`).toBeLessThan(IPC_MAX_LINE_BYTES * 0.8);
      expect(bytes).toBeGreaterThan(100 * KIB);
    },
  );
});
