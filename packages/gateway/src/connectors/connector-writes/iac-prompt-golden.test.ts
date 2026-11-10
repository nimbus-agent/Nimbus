// Phase 9.7 D2 Task 10: the exact consent prompt a plan-bound write puts in front of the owner
// (CLI and desktop show the same text; the CLI prints it verbatim, `interactive-ipc-handlers`).
// Built by the real renderers and the real prompt formatter, compared as a whole: counts first, the
// plan hash, the plan in full, ONE footer last, then the fixed typed-confirm line.
import { describe, expect, test } from "bun:test";
import { formatConsentPrompt } from "../../engine/executor.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { confirmPromptLine } from "./confirm.ts";
import { renderPlanPreview } from "./iac-plan-preview.ts";
import { buildConnectorWritePreview, type ConnectorWritePreview } from "./preview.ts";

const SHA = "a".repeat(64);
const WD = "/srv/infra/prod";

const planJson = {
  format_version: "1.2",
  terraform_version: "1.9.5",
  applyable: true,
  errored: false,
  resource_changes: [
    {
      address: "aws_instance.web",
      mode: "managed",
      type: "aws_instance",
      name: "web",
      provider_name: "registry.terraform.io/hashicorp/aws",
      action_reason: "replace_because_cannot_update",
      change: {
        actions: ["delete", "create"],
        before: { ami: "ami-1" },
        after: { ami: "ami-2" },
        after_unknown: {},
        before_sensitive: false,
        after_sensitive: {},
      },
    },
    {
      address: "aws_s3_bucket.new",
      mode: "managed",
      type: "aws_s3_bucket",
      name: "new",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: {
        actions: ["create"],
        before: null,
        after: { bucket: "new-bucket" },
        after_unknown: {},
        before_sensitive: false,
        after_sensitive: {},
      },
    },
  ],
};

function promptOf(action: PlannedAction, preview: ConnectorWritePreview, confirm: string): string {
  return `${formatConsentPrompt(action, undefined, preview)}\n\n${confirmPromptLine(confirm)}`;
}

describe("the consent prompt of a plan-bound write", () => {
  test("Terraform apply: counts first, the plan hash, the plan in full, one footer, then the typed line", () => {
    const rendered = renderPlanPreview(planJson, SHA);
    if (!rendered.ok) throw new Error(rendered.reason);
    const action: PlannedAction = {
      type: "iac.terraform.apply",
      origin: "model",
      payload: { mcpToolId: "iac_iac_terraform_apply", input: { workingDirectory: WD } },
    };
    const built = buildConnectorWritePreview(action);
    if (built === undefined) throw new Error("no preview");
    const preview: ConnectorWritePreview = {
      ...built,
      prepared: {
        status: "ok",
        fields: [
          { label: "Plan SHA-256", value: SHA },
          { label: "Workdir", value: WD },
        ],
      },
      plan: rendered.preview,
    };
    const prompt = promptOf(action, preview, `iac/apply ${WD}`);
    expect(prompt).toBe(
      [
        "Action requires your approval",
        "",
        "Type: iac.terraform.apply",
        "Requested by: the model",
        "",
        "Service: iac",
        `Target:  ${WD}`,
        `Apply the saved Terraform plan for ${WD} (the plan below, pinned by its hash)`,
        "",
        `  Working directory: "${WD}"`,
        "",
        "Prepared:",
        `  Plan SHA-256: ${SHA}`,
        `  Workdir: ${WD}`,
        "",
        "Deletes: 0, Replaces: 1, Creates: 1, Updates: 0",
        "Terraform 1.9.5",
        `Plan SHA-256: ${SHA}`,
        "Reads: 0",
        "[replace: delete, create] aws_instance.web (aws_instance, registry.terraform.io/hashicorp/aws)",
        "    reason: replace_because_cannot_update",
        '    ami: "ami-1" -> "ami-2"',
        "[create] aws_s3_bucket.new (aws_s3_bucket, registry.terraform.io/hashicorp/aws)",
        "End of plan: 2 changes (0 deletes, 1 replaces)",
        "",
        "To approve, type exactly: iac/apply /srv/infra/prod",
      ].join("\n"),
    );
    // Order, stated: counts first, the footer is the last plan line, the typed line follows it.
    const lines = prompt.split("\n");
    expect(lines.indexOf("Deletes: 0, Replaces: 1, Creates: 1, Updates: 0")).toBeLessThan(
      lines.indexOf(`Plan SHA-256: ${SHA}`),
    );
    expect(lines.filter((l) => l.startsWith("End of "))).toHaveLength(1);
    expect(lines.at(-3)).toBe("End of plan: 2 changes (0 deletes, 1 replaces)");
    expect(lines.at(-1)).toBe(`To approve, type exactly: iac/apply ${WD}`);
  });
});
