// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-refusals.ts
// The fixed refusal texts of the iac runner (invariant I15; static D43(d)). Split out of
// `iac-runner.ts` with no behaviour change.
import { IAC_PREFLIGHT_REFUSALS } from "../../connector-writes/iac-limits.ts";
import { K8S_PREFLIGHT_REFUSALS } from "../../connector-writes/k8s-limits.ts";

/** The reasons a call is refused before any child exists; fixed text, never the path or the input. */
export const IAC_RUNNER_REFUSALS = Object.freeze({
  noRun: IAC_PREFLIGHT_REFUSALS.noRun,
  notApproved: IAC_PREFLIGHT_REFUSALS.notApprovedDirectory,
  badPlanFile: "iac: the plan file is not in this gateway's approved plan directory",
  noBinary: "iac: the required command line tool was not found",
  noCredential: IAC_PREFLIGHT_REFUSALS.noCloudCredential,
  notOurChangeSet: "iac: that change set is not one this gateway created",
  stopping: IAC_PREFLIGHT_REFUSALS.stopping,
  regionNotApproved: IAC_PREFLIGHT_REFUSALS.regionNotApproved,
  kubeNoRun: "kubernetes: this call is not part of an approved run",
  kubeNoBinary: K8S_PREFLIGHT_REFUSALS.noCommandLineTool,
  kubeNotApproved: K8S_PREFLIGHT_REFUSALS.notApprovedNamespace,
  kubeDrift: K8S_PREFLIGHT_REFUSALS.kubeconfigDrift,
  kubeBusy: K8S_PREFLIGHT_REFUSALS.busy,
  kubeStopping: K8S_PREFLIGHT_REFUSALS.stopping,
  kubeNoContext: "kubernetes: name the context; more than one is approved",
});
