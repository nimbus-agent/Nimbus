import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { runCliOkThrowing } from "../../shared/run-cli-json.ts";

const mcp = new McpServer({ name: "nimbus-iac", version: "0.1.0" });

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

/**
 * Every MUTATING iac tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(mcp, {
  connector: "iac",
  scopeEnv: "NIMBUS_MCP_IAC_WRITE_SCOPE",
  scopeKinds: ["dir", "stack"],
});

const processEnv = process.env as Record<string, string | undefined>;

reg(
  "iac_terraform_plan",
  "Run terraform plan in a directory.",
  z.object({ workingDirectory: z.string().min(1) }),
  async (p) => {
    await runCliOkThrowing(["terraform", "-chdir", p.workingDirectory, "plan", "-input=false"], {
      ...processEnv,
    });
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "iac_terraform_apply",
  {
    mutates: "iac.terraform.apply",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "dir", value: p.workingDirectory }),
  },
  "Run terraform apply.",
  z.object({ workingDirectory: z.string().min(1) }),
  async (p) => {
    await runCliOkThrowing(
      ["terraform", "-chdir", p.workingDirectory, "apply", "-auto-approve", "-input=false"],
      { ...processEnv },
    );
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "iac_terraform_destroy",
  {
    mutates: "iac.terraform.destroy",
    // Destroying infrastructure cannot be undone from its own result, and there is nothing
    // queryable to snapshot, so the identifying parameters ARE the pre-state: a record naming
    // WHICH directory was destroyed still beats silence.
    recoverable: false,
    capturePreState: (p) => Promise.resolve({ workingDirectory: p.workingDirectory }),
    scopeTargetOf: (p) => ({ kind: "dir", value: p.workingDirectory }),
  },
  "Run terraform destroy.",
  z.object({ workingDirectory: z.string().min(1) }),
  async (p) => {
    await runCliOkThrowing(
      ["terraform", "-chdir", p.workingDirectory, "destroy", "-auto-approve", "-input=false"],
      { ...processEnv },
    );
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "iac_cloudformation_deploy",
  {
    mutates: "iac.cloudformation.deploy",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "stack", value: p.stackName }),
  },
  "Deploy a CloudFormation stack via AWS CLI.",
  z.object({
    stackName: z.string().min(1),
    templateBody: z.string().min(1),
  }),
  async (p) => {
    await runCliOkThrowing(
      [
        "aws",
        "cloudformation",
        "deploy",
        "--stack-name",
        p.stackName,
        "--template-body",
        p.templateBody,
        "--capabilities",
        "CAPABILITY_IAM",
      ],
      { ...processEnv },
    );
    return jsonResult({ ok: true });
  },
);

reg(
  "iac_pulumi_preview",
  "Run pulumi preview in a stack directory.",
  z.object({ workingDirectory: z.string().min(1) }),
  async (p) => {
    await runCliOkThrowing(
      ["pulumi", "preview", "--cwd", p.workingDirectory, "--non-interactive"],
      { ...processEnv },
    );
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "iac_pulumi_up",
  {
    mutates: "iac.pulumi.up",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "dir", value: p.workingDirectory }),
  },
  "Run pulumi up.",
  z.object({ workingDirectory: z.string().min(1) }),
  async (p) => {
    await runCliOkThrowing(
      ["pulumi", "up", "--yes", "--cwd", p.workingDirectory, "--non-interactive"],
      { ...processEnv },
    );
    return jsonResult({ ok: true });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
