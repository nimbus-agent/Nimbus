// packages/gateway/src/connectors/connector-writes/remediation-catalog.ts
// Phase 10 IC5a (incident-engine spec § 5.5): the write tools the incident engine may PROPOSE. The proposal
// derivation (`incident/proposals.ts`, inert under static D46(a)) names no tool id itself; `incident/remediation.ts`
// hands it this catalogue. Every id here is a row of the write table (pinned by `remediation-catalog.test.ts`), so a
// renamed or removed row fails a test rather than a proposal.

export type AlertToolSet = {
  /** The tool that acknowledges the alert. */
  readonly ack: string;
  /** The tool that resolves or closes it. */
  readonly close: string;
  /** The input field that names the alert (its provider id). */
  readonly field: string;
};

export type RemediationCatalog = {
  /** The Argo CD rollback (input `{ name, id }`). */
  readonly argoRollback: string;
  /** Tools whose stored input is not specific to one incident, so "what was done last time" may offer them again. */
  readonly repeatable: readonly string[];
  /** The acknowledge and close tools of each alert source. */
  readonly alerts: Readonly<Record<"pagerduty" | "jira", AlertToolSet>>;
};

export const REMEDIATION_CATALOG: RemediationCatalog = Object.freeze({
  argoRollback: "argocd_app_rollback",
  repeatable: Object.freeze([
    "launchdarkly_flag_toggle",
    "flagsmith_feature_state_set",
    "aws_ec2_instance_start",
    "aws_ec2_instance_stop",
  ]),
  alerts: Object.freeze({
    pagerduty: Object.freeze({
      ack: "pd_incident_acknowledge",
      close: "pd_incident_resolve",
      field: "incidentId",
    }),
    jira: Object.freeze({
      ack: "jira_ops_alert_acknowledge",
      close: "jira_ops_alert_close",
      field: "alertId",
    }),
  }),
});
