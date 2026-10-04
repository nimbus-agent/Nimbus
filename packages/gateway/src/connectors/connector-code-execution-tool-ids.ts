import { matchesBareOrNamespacedToolId } from "./namespaced-tool-id.ts";

/**
 * Connector tools that run CALLER-DIRECTED CODE on the machine executing them (I26).
 *
 * The class is defined by what a tool does with its arguments, not by whether it mutates anything:
 * each tool here takes a caller-supplied `workingDirectory` and hands it to a program that
 * EVALUATES the code it finds there. Planning a Terraform configuration loads it and runs its
 * provider plugins and any `external` data source program; a Pulumi preview runs the stack program
 * itself. So `iac_terraform_plan` and `iac_pulumi_preview` — registered as READS, because they
 * change no infrastructure — still let whoever names the directory decide what code runs. Through
 * `answerFederatedInvoke` that is a federated peer, on the trust anchor's machine, with no owner
 * approval of that code: `federation/invoke-gate.ts` refuses every id here before the grant is
 * read, fail-closed and opaque.
 *
 * NOT in the class, as reviewed in `connector-code-execution-sync.test.ts`: a fixed CLI (`aws`,
 * `az`, `gcloud`, `kubectl`) whose caller values ride flag-value slots or `isSafeCliArg`-guarded
 * positionals, where the caller picks a RESOURCE but never the code; and remote execution (a Lambda
 * invoke, a CloudFormation deploy, a CI trigger), which runs on a cloud's machines, not this one.
 * The mutating tools among those are writes, already refused under I26 by
 * `isConnectorWriteToolId`.
 *
 * The three iac WRITES that evaluate the same caller-named directory are listed too, deliberately.
 * The write predicate refuses them first (so the gate audits them `write_forbidden`); naming them
 * here keeps the code-execution classification true on its own, whatever happens to the write list.
 *
 * Kept honest by `connector-code-execution-sync.test.ts`, which reads the INSTALLED connectors
 * package: every id here must still be registered by a connector that can start a process, and
 * every tool such a connector registers must be refused here, refused as a write, or reviewed.
 */
export const CONNECTOR_CODE_EXECUTION_TOOL_IDS: ReadonlySet<string> = new Set([
  // Reads that evaluate the caller-named directory.
  "iac_terraform_plan",
  "iac_pulumi_preview",
  // Writes that evaluate it too — also refused by the I26 write predicate, which runs first.
  "iac_terraform_apply",
  "iac_terraform_destroy",
  "iac_pulumi_up",
]);

/** The longest listed id: no suffix longer than this can name one. */
const LONGEST_CODE_EXECUTION_TOOL_ID = Math.max(
  ...[...CONNECTOR_CODE_EXECUTION_TOOL_IDS].map((id) => id.length),
);

/**
 * I26: true for any connector tool that runs caller-directed code — bare, or in the
 * `<server>_<tool>` form a federated session executes (`iac_iac_terraform_plan`), matched exactly as
 * `isConnectorWriteToolId` matches a write (`matchesBareOrNamespacedToolId`). The federated peer
 * invoke gate rejects these fail-closed; the local owner's own paths do not consult it.
 */
export function isConnectorCodeExecutionToolId(toolId: string): boolean {
  return matchesBareOrNamespacedToolId(
    toolId,
    (id) => CONNECTOR_CODE_EXECUTION_TOOL_IDS.has(id),
    LONGEST_CODE_EXECUTION_TOOL_ID,
  );
}
