// packages/gateway/src/connectors/connector-writes/iac-refresh-only-row.test.ts
// OR-S4-DRIFT: the accept-drift row (`iac_terraform_apply_refresh_only`) as the production table and
// the production capabilities declare it. The settle itself is tested in
// `engine/iac-refresh-only.test.ts`; here the row, its typed text, the door verdicts and the
// registry's choice of the refresh-only settle for it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREPARE_REFUSALS } from "../../engine/prepare-step.ts";
import { buildBoundWriteCapabilities } from "../registry.ts";
import { agentApprovableRows } from "./agent-door.ts";
import { renderConfirmText } from "./confirm.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_REASONS } from "./model-offerable.ts";
import { isPrepareToolId } from "./prepare-tools.ts";

const TOOL = "iac_terraform_apply_refresh_only";
const row = CONNECTOR_WRITE_ROWS.find((r) => r.toolId === TOOL);

describe("the accept-drift row", () => {
  test("is a wave 4 mesh row bound to the refresh-only plan, settled by the Terraform settler", () => {
    expect(row?.actionType).toBe("iac.terraform.apply_refresh_only");
    expect(row?.wave).toBe(4);
    expect(row?.transport).toBe("mesh");
    expect(row?.bound?.prepare.tool).toBe("iac_terraform_plan_refresh_only");
    expect(isPrepareToolId("iac_terraform_plan_refresh_only")).toBe(true);
    expect(row?.bound?.prepare.settle).toBe("iac-terraform");
    expect(row?.bound?.prepare.settleTool).toBe("iac_terraform_show_json");
    expect(row?.bound?.prepare.preflight).toBe("iac");
    expect(row?.bound?.binds.map((b) => b.field).sort()).toEqual(["planFile", "planSha256"]);
  });

  test("its preview names the directory and never a bound field", () => {
    const text = JSON.stringify(row?.preview);
    expect(text).toContain("workingDirectory");
    expect(text).not.toContain("planFile");
    expect(text).not.toContain("planSha256");
    expect(row?.preview?.summary).toContain("ACCEPT DRIFT");
  });

  test("the owner types iac/accept-drift <dir>", () => {
    expect(renderConfirmText(row as never, { workingDirectory: "/srv/infra/prod" })).toEqual({
      ok: true,
      text: "iac/accept-drift /srv/infra/prod",
    });
  });

  test("is never offered to the model, with a reason, and so is refused to an outside agent", () => {
    expect(isModelOfferableRow(row as never)).toBe(false);
    expect(MODEL_NEVER_OFFERED_REASONS[TOOL]).toContain("OR-S4-DRIFT");
    const [approvable] = agentApprovableRows("iac", 4, {
      approvedWorkdirs: ["/srv/infra/prod"],
      approvedK8sPairs: [],
      obsidianModelGrant: false,
      grantedScopes: undefined,
      rows: [row as never],
      listed: {},
    } as never);
    expect(approvable?.state).toBe("not_approvable");
    expect(approvable?.state === "not_approvable" ? approvable.reason : "").toBe(
      MODEL_NEVER_OFFERED_REASONS[TOOL] ?? "?",
    );
  });
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PLAN_ID = "0123456789abcdef0123456789abcdef";
const BYTES = Buffer.from("refresh-bytes");
let root: string;
let staging: string;
let approvedRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iac-refresh-row-"));
  staging = join(root, "staging");
  approvedRoot = join(root, "approved");
  mkdirSync(join(staging, PLAN_ID), { recursive: true });
});

function makeTreeRemovable(dir: string): void {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (lstatSync(child).isDirectory()) makeTreeRemovable(child);
  }
}

afterEach(() => {
  makeTreeRemovable(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const PLAN_JSON = (action: string) => ({
  format_version: "1.2",
  terraform_version: "1.9.5",
  applyable: true,
  errored: false,
  resource_drift: [
    {
      address: "aws_instance.web",
      type: "aws_instance",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: { actions: ["update"], before: { ami: "a" }, after: { ami: "b" } },
    },
  ],
  resource_changes: [
    {
      address: "aws_instance.web",
      type: "aws_instance",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: { actions: [action], before: { ami: "a" }, after: { ami: "b" } },
    },
  ],
});

function capabilities() {
  return buildBoundWriteCapabilities({
    preflight: async () => ({ ok: true as const, release: () => undefined }),
    recheckGit: () => undefined,
    terraformRunDirs: () => ({ stagingDir: staging, approvedRoot }),
  });
}

async function settleWith(rowToolId: string, fileName: string, action: string) {
  const planFile = join(staging, PLAN_ID, fileName);
  writeFileSync(planFile, BYTES);
  return capabilities().settle(rowToolId, {
    settle: "iac-terraform",
    input: { workingDirectory: "/srv/infra/prod" },
    workingDirectory: "/srv/infra/prod",
    reply: { planId: PLAN_ID, planFile, planSha256: "f".repeat(64), hasChanges: true },
    showPlan: async (args) => ({
      planJson: JSON.stringify(PLAN_JSON(action)),
      planSha256: sha(Buffer.from(BYTES)),
      echoed: args.planFile,
    }),
  });
}

describe("the production capabilities settle the row as a refresh-only plan", () => {
  test("a no-op plan named refresh.tfplan is settled and shows the drift", async () => {
    const out = await settleWith(TOOL, "refresh.tfplan", "no-op");
    expect(out.values["planFile"]?.endsWith("refresh.tfplan")).toBe(true);
    expect(out.fields.map((f) => f.label)).toEqual(["Plan SHA-256", "Workdir", "Accepts"]);
    await out.cleanup();
  });

  test("a plan that would update infrastructure is refused", async () => {
    await expect(settleWith(TOOL, "refresh.tfplan", "update")).rejects.toMatchObject({
      reason: PREPARE_REFUSALS.notRefreshOnly,
    });
  });

  test("the ordinary apply row refuses refresh.tfplan", async () => {
    await expect(
      settleWith("iac_terraform_apply", "refresh.tfplan", "no-op"),
    ).rejects.toMatchObject({ reason: PREPARE_REFUSALS.unbound });
  });

  test("this row refuses plan.tfplan", async () => {
    await expect(settleWith(TOOL, "plan.tfplan", "no-op")).rejects.toMatchObject({
      reason: PREPARE_REFUSALS.unbound,
    });
  });
});
