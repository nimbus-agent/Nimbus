// packages/gateway/src/ipc/consent-plan-frame.test.ts
// D2 Task 10 (plan risk): a plan or change set travels TWICE in one `consent.request` frame, in the
// prompt text and in the structured details (its lines; the joined text is NOT sent a third time,
// the desktop renders the lines and the audit row keeps only the digest). The worst cases the caps
// allow are built with the real preview builder and prompt formatter, from the largest inputs the
// gateway lets through, and MEASURED against the NDJSON line limit.
import { afterEach, describe, expect, test } from "bun:test";
import { confirmPromptLine } from "../connectors/connector-writes/confirm.ts";
import { IAC_LIMITS } from "../connectors/connector-writes/iac-limits.ts";
import { renderedText } from "../connectors/connector-writes/iac-plan-preview.ts";
import { buildConnectorWritePreview } from "../connectors/connector-writes/preview.ts";
import { consentDisplayPayload, formatConsentPrompt } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";
import { IPC_MAX_LINE_BYTES, type JsonRpcNotification } from "./jsonrpc.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

const NL = "\n";
const KIB = 1024;

/** A rendered plan of exactly the largest size the renderer allows, in lines of `lineChars` quotes. */
function worstPlan(lineChars: number) {
  const lines: string[] = [];
  let bytes = 0;
  for (;;) {
    const next = '"'.repeat(lineChars);
    const add = next.length + (lines.length === 0 ? 0 : 1);
    if (bytes + add > IAC_LIMITS.maxRenderedBytes) break;
    lines.push(next);
    bytes += add;
  }
  return renderedText(lines);
}

function frameBytes(
  action: PlannedAction,
  confirmText: string,
  plan: ReturnType<typeof worstPlan>,
) {
  const built = buildConnectorWritePreview(action);
  if (built === undefined) throw new Error("no preview");
  const preview = {
    ...built,
    prepared: {
      status: "ok" as const,
      fields: [{ label: "Plan SHA-256", value: "a".repeat(64) }],
    },
    plan,
  };
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
  return {
    bytes: new TextEncoder().encode(`${JSON.stringify(sent[0])}${NL}`).length,
    details: JSON.stringify(details),
  };
}

const TF: PlannedAction = {
  type: "iac.terraform.apply",
  origin: "model",
  payload: {
    mcpToolId: "iac_iac_terraform_apply",
    input: { workingDirectory: `/${"d".repeat(IAC_LIMITS.maxWorkdirChars - 1)}` },
  },
};
const CFN: PlannedAction = {
  type: "iac.cloudformation.deploy",
  origin: "model",
  payload: {
    mcpToolId: "iac_iac_cloudformation_deploy",
    input: {
      stackName: "s".repeat(IAC_LIMITS.maxStackNameChars),
      templateBody: '"'.repeat(IAC_LIMITS.maxTemplateBytes),
      capabilities: ["CAPABILITY_AUTO_EXPAND"],
    },
  },
};

describe("the consent.request frame of a worst-case plan", () => {
  test.each([
    ["one long line of quotes (JSON doubles each)", 4000],
    ["the most lines the cap allows (one quote each)", 1],
  ] as const)("Terraform, %s: under 400 KiB", (_name, lineChars) => {
    const plan = worstPlan(lineChars);
    expect(plan.bytes).toBeGreaterThan(IAC_LIMITS.maxRenderedBytes - 5000);
    const { bytes } = frameBytes(TF, "iac/apply /dd", plan);
    expect(bytes, `measured ${String(bytes)} bytes`).toBeLessThan(400 * KIB);
  });

  test("the structured details carry the lines and digest, not the joined text a third time", () => {
    const plan = worstPlan(4000);
    const { details } = frameBytes(TF, "iac/apply /dd", plan);
    const parsed = JSON.parse(details) as { plan: Record<string, unknown> };
    expect(Object.keys(parsed.plan).sort()).toEqual(["bytes", "lines", "sha256"]);
    expect(parsed.plan["lines"]).toEqual(plan.lines);
    expect(parsed.plan["sha256"]).toBe(plan.sha256);
  });

  test.each([
    ["one long line of quotes", 4000],
    ["the most lines the cap allows", 1],
  ] as const)(
    "CloudFormation with a 50 KiB quote-heavy template AND the largest change set, %s: under 80% of the IPC line cap",
    (_name, lineChars) => {
      const { bytes } = frameBytes(CFN, "iac/deploy s", worstPlan(lineChars));
      // measured at about 707 KB for the lines shape and 668 KB for the long line: the template (about 100 KB once JSON-escaped) travels twice, as a field of the
      // prompt and of the details, beside the plan's two copies; this is the heaviest frame there is
      expect(bytes, `measured ${String(bytes)} bytes`).toBeLessThan(IPC_MAX_LINE_BYTES * 0.8);
    },
  );
});
