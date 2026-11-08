// packages/gateway/src/connectors/connector-writes/iac-bound.test.ts
// Phase 9.7 D2: the declarations of the three plan-bound IaC rows, against the INSTALLED connector
// source (fixtures are what the connector's writer returns, not what the gateway assumes), and the
// row-level Pulumi refusal.
import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import {
  declaredInputKeys,
  matchingClose,
  registrationCallOf,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { CFN_DEPLOY_BOUND, TERRAFORM_APPLY_BOUND, TERRAFORM_DESTROY_BOUND } from "./iac-bound.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { PREPARE_TOOL_IDS } from "./prepare-tools.ts";
import {
  type BoundWrite,
  previewTemplateKeys,
  row,
  SETTLE_VALUE_KEYS,
  withBound,
  withConfirm,
  withPreview,
  withRefusal,
} from "./types.ts";

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const iacCode = stripComments(
  sources.find((s) => s.rel === "connectors/iac/src/tools.ts")?.text ?? "",
);
const rowOf = (id: string) => {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
};

/** The write tool's input keys, read from the installed source (the Terraform applies share one shape). */
function writeKeys(toolId: string): string[] {
  if (toolId === "iac_terraform_apply" || toolId === "iac_terraform_destroy") {
    const at = iacCode.indexOf("const applyShape = {");
    const open = iacCode.indexOf("{", at);
    return declaredInputKeys(`z.object(${iacCode.slice(open, matchingClose(iacCode, open) + 1)})`);
  }
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined) throw new Error(`${toolId}: not a registered write`);
  const code = stripComments(sources.find((s) => s.rel === reg.file)?.text ?? "");
  return declaredInputKeys(code.slice(reg.span[0], reg.span[1] + 1));
}

function prepareKeys(toolId: string): string[] {
  const call = registrationCallOf(iacCode, toolId);
  if (call === undefined) throw new Error(`${toolId}: not registered`);
  return declaredInputKeys(call);
}

const BOUND_BY_ROW: ReadonlyArray<readonly [string, BoundWrite, string, readonly string[]]> = [
  ["iac_terraform_apply", TERRAFORM_APPLY_BOUND, "iac_terraform_plan", ["planFile", "planSha256"]],
  [
    "iac_terraform_destroy",
    TERRAFORM_DESTROY_BOUND,
    "iac_terraform_destroy_plan",
    ["planFile", "planSha256"],
  ],
  [
    "iac_cloudformation_deploy",
    CFN_DEPLOY_BOUND,
    "iac_cloudformation_changeset_create",
    ["changeSetId"],
  ],
];

describe("the three bound iac rows are the production bound rows beside the two commits (D2)", () => {
  test("exactly five bound rows, each Wave 4 with a typed preview and a confirm target", () => {
    const bound = CONNECTOR_WRITE_ROWS.filter((r) => r.bound !== undefined);
    expect(bound.map((r) => r.toolId).sort()).toEqual(
      [
        "gitlab_commit_create",
        "github_file_commit",
        "iac_cloudformation_deploy",
        "iac_terraform_apply",
        "iac_terraform_destroy",
      ].sort(),
    );
    for (const r of bound) {
      expect(r.wave, r.toolId).toBe(4);
      expect(r.preview, r.toolId).toBeDefined();
      expect(r.confirm, r.toolId).toBeDefined();
    }
  });

  for (const [toolId, bound, prepareTool, boundKeys] of BOUND_BY_ROW) {
    describe(toolId, () => {
      const r = rowOf(toolId);

      test("the row carries its declaration, and the prepare tool is a declared prepare tool", () => {
        expect(r.bound).toBe(bound);
        expect(bound.prepare.tool).toBe(prepareTool);
        expect(PREPARE_TOOL_IDS.has(prepareTool)).toBe(true);
        expect(bound.prepare.preflight).toBe("iac");
      });

      test("it binds exactly the settler's value keys (from/settle agreement)", () => {
        const settle = bound.prepare.settle;
        expect(settle).toBeDefined();
        const expected = SETTLE_VALUE_KEYS[settle ?? "iac-cfn"];
        expect(bound.binds.map((b) => b.field).sort()).toEqual([...expected].sort());
        expect(bound.binds.map((b) => b.field).sort()).toEqual([...boundKeys].sort());
        expect(bound.prepare.settleTool === undefined).toBe(settle === "iac-cfn");
      });

      test("the preview names the write tool's input keys minus the gateway-bound ones, and never a bound key", () => {
        const named = [...previewTemplateKeys(r.preview as never)].sort();
        const real = writeKeys(toolId);
        expect(real, "schema shape recognised").not.toEqual([]);
        for (const k of boundKeys) expect(real, k).toContain(k);
        expect(named).toEqual(real.filter((k) => !boundKeys.includes(k)).sort());
      });

      test("the prepare read depends on keys the connector's prepare tool takes", () => {
        const takes = prepareKeys(prepareTool);
        expect(takes, "schema shape recognised").not.toEqual([]);
        for (const k of bound.prepare.argKeys) expect(takes, k).toContain(k);
      });

      test("the caps are the iac limits table's and positive", () => {
        for (const n of [
          bound.prepare.budgetMs,
          bound.prepare.maxInputBytes,
          bound.prepare.maxReplyBytes,
        ]) {
          expect(Number.isInteger(n) && n > 0).toBe(true);
        }
      });
    });
  }
});

describe("the prepare reads' arguments and the reply shape readers", () => {
  test("the Terraform read takes the directory and nothing else", () => {
    for (const b of [TERRAFORM_APPLY_BOUND, TERRAFORM_DESTROY_BOUND]) {
      expect(b.prepare.args({ workingDirectory: "/w" })).toEqual({ workingDirectory: "/w" });
      expect(b.prepare.args({})).toBeUndefined();
      expect(b.prepare.args({ workingDirectory: 7 })).toBeUndefined();
      expect(b.prepare.select({})).toEqual([]);
    }
  });

  test("the CloudFormation read takes the write's keys minus changeSetId; capabilities only when set", () => {
    const a = CFN_DEPLOY_BOUND.prepare.args;
    expect(a({ stackName: "s", templateBody: "t", capabilities: ["CAPABILITY_IAM"] })).toEqual({
      stackName: "s",
      templateBody: "t",
      capabilities: ["CAPABILITY_IAM"],
    });
    expect(a({ stackName: "s", templateBody: "t" })).toEqual({ stackName: "s", templateBody: "t" });
    expect(a({ stackName: "s", templateBody: "t", capabilities: undefined })).toEqual({
      stackName: "s",
      templateBody: "t",
    });
    expect(a({ stackName: "s", templateBody: "t", changeSetId: "x" })).not.toHaveProperty(
      "changeSetId",
    );
    expect(a({ templateBody: "t" })).toBeUndefined();
    expect(a({ stackName: "s", templateBody: 3 })).toBeUndefined();
  });

  test("the shape readers read a plain object or an MCP result, and nothing else", () => {
    const [file, hash] = TERRAFORM_APPLY_BOUND.binds;
    const [cs] = CFN_DEPLOY_BOUND.binds;
    const reply = { planId: "p", planFile: "/p/plan.tfplan", planSha256: "ab", hasChanges: true };
    expect(file?.from(reply)).toBe("/p/plan.tfplan");
    expect(hash?.from({ content: [{ type: "text", text: JSON.stringify(reply) }] })).toBe("ab");
    expect(cs?.from({ changeSetId: "arn:x" })).toBe("arn:x");
    for (const bad of [{}, { planFile: "" }, { planFile: 4 }, "text", null, { content: [] }]) {
      expect(file?.from(bad)).toBeUndefined();
    }
  });
});

describe("what the model may be offered (D2)", () => {
  test("apply and deploy are offerable; destroy, Pulumi, the discard and Kubernetes apply never are", () => {
    expect(isModelOfferableRow(rowOf("iac_terraform_apply"))).toBe(true);
    expect(isModelOfferableRow(rowOf("iac_cloudformation_deploy"))).toBe(true);
    for (const id of [
      "iac_terraform_destroy",
      "iac_pulumi_up",
      "iac_cloudformation_changeset_discard",
      "k8s_manifest_apply",
    ]) {
      expect(isModelOfferableRow(rowOf(id)), id).toBe(false);
    }
  });

  test("destroy would be offerable but for the never-offered list: it is bound, previewed and confirmed", () => {
    const destroy = rowOf("iac_terraform_destroy");
    expect(destroy.bound).toBeDefined();
    expect(destroy.preview).toBeDefined();
    expect(destroy.confirm).toBeDefined();
  });
});

describe("withRefusal and the Pulumi row (D2)", () => {
  test("only the Pulumi apply carries a row-level refusal, and it is a Wave 4 row with nothing to show", () => {
    const refused = CONNECTOR_WRITE_ROWS.filter((r) => r.refuse !== undefined);
    expect(refused.map((r) => r.toolId)).toEqual(["iac_pulumi_up"]);
    const pulumi = rowOf("iac_pulumi_up");
    expect(pulumi.refuse).toBe(
      "iac.pulumi.up: refused (saved update plans are experimental, OR-W34-2)",
    );
    expect(pulumi.wave).toBe(4);
    expect(pulumi.preview).toBeUndefined();
    expect(pulumi.bound).toBeUndefined();
    expect(pulumi.before).toBeUndefined();
  });

  test("declaration refuses a row that is not Wave 4, has something to show, or has a bad reason", () => {
    const base = row("x_y", "x.y", "mesh", 4);
    expect(withRefusal(base, "no").refuse).toBe("no");
    expect(() => withRefusal(row("x_y", "x.y", "mesh", 3), "no")).toThrow(/not Wave 4/);
    const previewed = withPreview(base, { target: "t", summary: "s", fields: [] });
    expect(() => withRefusal(previewed, "no")).toThrow(/preview, reader or prepare step/);
    const bound = withBound(withPreview(base, { target: "{a}", summary: "s", fields: [] }), {
      prepare: {
        tool: "iac_terraform_plan",
        argKeys: ["a"],
        args: () => ({}),
        select: () => [],
        budgetMs: 1,
        maxInputBytes: 1,
        maxReplyBytes: 1,
      },
      binds: [{ field: "b", from: () => "x" }],
    });
    expect(() => withRefusal(bound, "no")).toThrow(/preview, reader or prepare step/);
    expect(() => withRefusal(base, " ")).toThrow(/non-empty line/);
    expect(() => withRefusal(base, "a\nb")).toThrow(/non-empty line/);
    expect(() => withRefusal(base, "a\rb")).toThrow(/non-empty line/);
    // The refusal does not remove a confirm target already set.
    expect(withRefusal(withConfirm(base, { template: "x {a}" }), "no").confirm).toBeDefined();
  });
});
