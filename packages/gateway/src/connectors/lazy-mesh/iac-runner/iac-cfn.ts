// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-cfn.ts
// The CloudFormation side of the IaC runner (Phase 9.7 D2, invariant I15; static D43(d)): the
// region a `cfn` child talks to, and which CloudFormation tools are reads. Split out of
// `iac-runner.ts` (file-size ratchet).
import { IAC_RUNNER_REFUSALS } from "./iac-refusals.ts";

/**
 * The three CloudFormation reads (connectors 0.21.0). The `iac` listing slot has no network, so
 * they run in a `cfn` child too, as every `k8s_*` read runs in a `kube` one (D3a). A read gets the
 * `cfn` profile's network and credential and NOTHING writable: no scratch directory (the connector
 * hands the CLI no file for a read), no workdir and no run lock, and none of the write-only checks
 * (the discard's `isOurChangeSet`, the deploy's preflight).
 */
export const CFN_READ_TOOLS: ReadonlySet<string> = new Set([
  "iac_cloudformation_stack_get",
  "iac_cloudformation_changesets_list",
  "iac_cloudformation_changeset_get",
]);

/**
 * The region a CloudFormation child uses: the Vault credential's own region, else the first
 * approved one, and ONLY when it is an approved region, so the child never reaches a host the
 * owner's enable prompt did not list. `undefined` refuses the call.
 */
export function cfnRegionFor(
  credentialRegion: string,
  approved: readonly string[],
): string | undefined {
  const region = credentialRegion !== "" ? credentialRegion : (approved[0] ?? "");
  return region !== "" && approved.includes(region) ? region : undefined;
}

const ENABLE_AWS = "`nimbus connector writes enable iac --wave 4 --cloud aws --region <region>`";

/**
 * A CloudFormation read's own refusals: fixed text that says what the read needs and the command
 * that grants it (a write's texts speak of "this change"). `enable iac` replaces the whole approved
 * scope, so the text says to repeat the approved directories.
 */
export const CFN_READ_REFUSALS = Object.freeze({
  noCloud: `iac: the CloudFormation reads run only once the aws cloud is approved for iac; approve it with ${ENABLE_AWS}, repeating any --workdir you approved before (enabling replaces the approved scope)`,
  noCredential:
    "iac: the CloudFormation reads need a stored AWS credential; store the aws access key id and secret access key (or a profile) with `nimbus vault set`, as for the aws connector",
  regionNotApproved: `iac: the CloudFormation reads use the AWS credential's region, which is not an approved region; approve it with ${ENABLE_AWS}`,
});

/** The fixed refusal of a cfn call: a read's own text, else the write's. */
export function cfnRefusal(toolId: string, reason: keyof typeof CFN_READ_REFUSALS): string {
  if (CFN_READ_TOOLS.has(toolId)) return CFN_READ_REFUSALS[reason];
  return reason === "regionNotApproved"
    ? IAC_RUNNER_REFUSALS.regionNotApproved
    : IAC_RUNNER_REFUSALS.noCredential;
}
