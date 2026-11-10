// packages/gateway/src/connectors/connector-writes/iac-bound.ts
// The bound declarations of the plan-bound IaC writes (Phase 9.7 D2, invariant I54): Terraform
// apply, Terraform destroy and the CloudFormation deploy. Each is bound to the identity of the plan
// or change set its PREPARE tool made, but never to what that tool SAYS about it: a row names a
// `settle` tag, and the gateway's settler (`engine/iac-settle.ts`, reached through the dispatcher's
// `boundWriteCapabilities`) fixes the identity itself (a plan file it moved and hashed and had
// `terraform show -json` render in a child with no network and no credential; a change set it
// cross-checked against the caller's own input) and renders what the owner approves. The `from`
// readers below are therefore only the SHAPE check of the connector's reply (a row's binds must
// name the settler's value keys, `SETTLE_VALUE_KEYS`); the values bound are the settler's.
//
// What the connectors reply (read from the installed 0.9.0 source, `connectors/iac/src/tools.ts`):
//  - `iac_terraform_plan` / `iac_terraform_destroy_plan`: `{planId, planFile, planSha256, hasChanges}`;
//  - `iac_cloudformation_changeset_create`: `{changeSetId (ARN), changeSetName, stackId, stackName,
//    changeSetType, templateSha256, capabilities, changes: [...]}`.
// Imported BY `cloud-infra.ts`; imports nothing from the row table or the executor.

import { beforeReplyJson, nonEmptyString } from "./before-select.ts";
import {
  CFN_INPUT_KEYS,
  cfnInputRefusal,
  IAC_LIMITS,
  TERRAFORM_INPUT_KEYS,
  terraformInputRefusal,
} from "./iac-limits.ts";
import type { BoundField, BoundWrite, PrepareRead } from "./types.ts";

/**
 * A string of the connector's reply, or `undefined`: only the shape is read, the settler decides.
 * Only a real string counts (`stringAt` would turn a number into text).
 */
export function replyString(key: string): BoundField["from"] {
  return (reply) => {
    try {
      const json = beforeReplyJson(reply);
      if (typeof json !== "object" || json === null || !Object.hasOwn(json, key)) return undefined;
      const v: unknown = (json as Record<string, unknown>)[key];
      return typeof v === "string" ? nonEmptyString(v) : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The write input's keys a prepare read depends on, picked and nothing else. */
function pickKeys(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(input, key) && input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/**
 * The prepared facts of a settled row come from its settler, never from `select` (the prepare step
 * does not call it for a row with a `settle` tag); it is declared because every prepare read has
 * one, and it shows nothing.
 */
export const NO_REPLY_FACTS: PrepareRead["select"] = () => [];

function terraformBound(destroy: boolean): BoundWrite {
  return {
    prepare: {
      tool: destroy ? "iac_terraform_destroy_plan" : "iac_terraform_plan",
      argKeys: TERRAFORM_INPUT_KEYS,
      args: (input) => {
        const workingDirectory = input["workingDirectory"];
        return typeof workingDirectory === "string" ? { workingDirectory } : undefined;
      },
      select: NO_REPLY_FACTS,
      settle: "iac-terraform",
      settleTool: "iac_terraform_show_json",
      preflight: "iac",
      budgetMs: IAC_LIMITS.terraform.budgetMs,
      maxInputBytes: IAC_LIMITS.terraform.maxInputChars,
      maxReplyBytes: IAC_LIMITS.terraform.maxReplyChars,
      inputRefusal: terraformInputRefusal,
    },
    binds: [
      { field: "planFile", from: replyString("planFile") },
      { field: "planSha256", from: replyString("planSha256") },
    ],
  };
}

/** `iac_terraform_apply`: bound to the plan `iac_terraform_plan` saved, as the gateway settled it. */
export const TERRAFORM_APPLY_BOUND: BoundWrite = terraformBound(false);

/** `iac_terraform_destroy`: bound to the destroy plan `iac_terraform_destroy_plan` saved. */
export const TERRAFORM_DESTROY_BOUND: BoundWrite = terraformBound(true);

/**
 * `iac_cloudformation_deploy`: bound to the change set `iac_cloudformation_changeset_create` made
 * for exactly this stack, template and capabilities. The prepare read takes the write's own keys
 * minus `changeSetId`, which the gateway binds.
 */
export const CFN_DEPLOY_BOUND: BoundWrite = {
  prepare: {
    tool: "iac_cloudformation_changeset_create",
    argKeys: CFN_INPUT_KEYS,
    args: (input) => {
      if (typeof input["stackName"] !== "string" || typeof input["templateBody"] !== "string") {
        return undefined;
      }
      return pickKeys(input, CFN_INPUT_KEYS);
    },
    select: NO_REPLY_FACTS,
    settle: "iac-cfn",
    preflight: "iac",
    budgetMs: IAC_LIMITS.cfn.budgetMs,
    maxInputBytes: IAC_LIMITS.cfn.maxInputChars,
    maxReplyBytes: IAC_LIMITS.cfn.maxReplyChars,
    inputRefusal: cfnInputRefusal,
  },
  binds: [{ field: "changeSetId", from: replyString("changeSetId") }],
};
