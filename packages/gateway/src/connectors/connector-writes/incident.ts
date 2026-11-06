// packages/gateway/src/connectors/connector-writes/incident.ts
import { beforeReplyJson, excerptHead, presentFields, stringAt } from "./before-select.ts";
import {
  type BeforeStateField,
  type BeforeStateReader,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

/** The incident object of a `pd_incident_get` reply (`{incident: {...}}`); absent throws. */
function incidentOf(reply: unknown): unknown {
  const j = beforeReplyJson(reply);
  const inc = typeof j === "object" && j !== null ? (j as { incident?: unknown }).incident : null;
  if (typeof inc !== "object" || inc === null || Array.isArray(inc)) {
    throw new TypeError("before reply: no incident");
  }
  return inc;
}

/** The assignees' display names, comma-joined (an assignment with no readable name is skipped). */
function assignees(inc: unknown): string | undefined {
  const list = (inc as { assignments?: unknown }).assignments;
  if (!Array.isArray(list)) return undefined;
  const names: string[] = [];
  for (const a of list as unknown[]) {
    const n = stringAt(a, ["assignee", "summary"]);
    if (n !== undefined) names.push(n);
  }
  return names.length === 0 ? "(nobody)" : names.join(", ");
}

/**
 * PagerDuty `pd_incident_get` (before-state), for the three incident writes: `Title` (the incident's
 * `title`, else its `summary`; neither throws, so the prompt reads `unavailable (failed)`), `Status`,
 * `Urgency`, `Service`, `Assigned to`, `Escalation policy`, `Escalation level` and `Priority`, each
 * only when the reply names it. A status that makes the write a no-op (already resolved) is shown,
 * not blocked: these are wave-3 writes with no guard.
 */
export function selectPagerdutyIncident(reply: unknown): readonly BeforeStateField[] {
  const inc = incidentOf(reply);
  const title = stringAt(inc, ["title"]) ?? stringAt(inc, ["summary"]);
  if (title === undefined) throw new Error("before reply: no title");
  const shown = (path: readonly string[]): string | undefined => {
    const v = stringAt(inc, path);
    return v === undefined ? undefined : excerptHead(v);
  };
  const assigned = assignees(inc);
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["Status", shown(["status"])],
      ["Urgency", shown(["urgency"])],
      ["Service", shown(["service", "summary"])],
      ["Assigned to", assigned === undefined ? undefined : excerptHead(assigned)],
      ["Escalation policy", shown(["escalation_policy", "summary"])],
      ["Escalation level", shown(["escalation_level"])],
      ["Priority", shown(["priority", "summary"])],
    ]),
  ];
}

/**
 * Jira Service Management Operations `jira_ops_alert_get` (before-state), for the alert acknowledge
 * and close writes: `Message` (required, else it throws and the prompt reads `unavailable
 * (failed)`), `Status`, `Acknowledged`, `Priority`, `Source` and `Count`, and a `Note` when the
 * status makes the write a no-op (already closed, already acknowledged): shown, not blocked. Never
 * the responders.
 */
export function selectJiraOpsAlert(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const message = stringAt(j, ["message"]);
  if (message === undefined) throw new Error("before reply: no message");
  const status = stringAt(j, ["status"]);
  const ack =
    typeof j === "object" && j !== null
      ? (j as { acknowledged?: unknown }).acknowledged
      : undefined;
  const shown = (path: readonly string[]): string | undefined => {
    const v = stringAt(j, path);
    return v === undefined ? undefined : excerptHead(v);
  };
  let note: string | undefined;
  if (status === "closed") {
    note = "Already closed: acknowledging or closing it again changes nothing";
  } else if (ack === true || status === "acked") {
    note = "Already acknowledged: acknowledging it again changes nothing (it can still be closed)";
  }
  return [
    { label: "Message", value: excerptHead(message) },
    ...presentFields([
      ["Status", shown(["status"])],
      ["Acknowledged", typeof ack === "boolean" ? (ack ? "yes" : "no") : undefined],
      ["Priority", shown(["priority"])],
      ["Source", shown(["source"])],
      ["Count", shown(["count"])],
      ["Note", note],
    ]),
  ];
}

const JSM_ALERT_BEFORE: BeforeStateReader = {
  tool: "jira_ops_alert_get",
  argKeys: ["alertId"],
  args: (input) => {
    const alertId = input["alertId"];
    return typeof alertId === "string" && alertId !== "" ? { alertId } : undefined;
  },
  select: selectJiraOpsAlert,
};

const PD_BEFORE: BeforeStateReader = {
  tool: "pd_incident_get",
  argKeys: ["incidentId"],
  args: (input) => {
    const incidentId = input["incidentId"];
    return typeof incidentId === "string" && incidentId !== "" ? { incidentId } : undefined;
  },
  select: selectPagerdutyIncident,
};

// PagerDuty incident writes (`PUT /incidents/{id}`). None can be undone through the connector
// (`recoverable: false`: there is no unacknowledge, reopen or de-escalate), and the preview says so.
// `pd_incident_escalate` takes a REQUIRED `escalationLevel` (an integer, 1 to 20), so its template
// is its own. Each row is spelled out so a grep for the tool id or the action type finds it.
export const INCIDENT_ROWS: readonly ConnectorWriteRow[] = [
  withBefore(
    withPreview(row("pd_incident_acknowledge", "pagerduty.incident.acknowledge", "mesh", 3), {
      target: "{incidentId}",
      summary:
        "Acknowledge PagerDuty incident {incidentId} (it cannot be un-acknowledged through Nimbus)",
      fields: [textField("incidentId", "Incident id")],
    }),
    PD_BEFORE,
  ),
  withBefore(
    withPreview(row("pd_incident_resolve", "pagerduty.incident.resolve", "mesh", 3), {
      target: "{incidentId}",
      summary: "Resolve PagerDuty incident {incidentId} (it cannot be reopened through Nimbus)",
      fields: [textField("incidentId", "Incident id")],
    }),
    PD_BEFORE,
  ),
  withBefore(
    withPreview(row("pd_incident_escalate", "pagerduty.incident.escalate", "mesh", 3), {
      target: "{incidentId}",
      summary:
        "Escalate PagerDuty incident {incidentId} to level {escalationLevel} (it cannot be de-escalated through Nimbus)",
      fields: [
        textField("incidentId", "Incident id"),
        textField("escalationLevel", "Escalation level (1 to 20)"),
      ],
    }),
    PD_BEFORE,
  ),
  // Connectors 0.6.0 (spec 15.3, OR-W34-7): Jira Service Management Operations alerts, instead of
  // Opsgenie. The alert is incident-style; JSM Operations has no incident-resolve write, so only
  // acknowledge and close exist. Not recoverable (the connector marks both `recoverable: false`).
  // The action is ASYNCHRONOUS: Atlassian answers `{status: "accepted", requestId}`, not completion,
  // and the gateway cannot poll the request (reads are not offered through the write door). The
  // summary therefore asks for the action and says Nimbus does not confirm it took effect, never
  // that the alert "was acknowledged" or "was closed".
  withBefore(
    withPreview(row("jira_ops_alert_acknowledge", "jira.ops.alert.acknowledge", "mesh", 3), {
      target: "{alertId}",
      summary:
        "Ask Jira Service Management Operations to acknowledge alert {alertId} (Atlassian accepts the request and runs it asynchronously; Nimbus does not confirm it took effect; it cannot be un-acknowledged through Nimbus)",
      fields: [textField("alertId", "Alert id (not a tinyId or alias)")],
    }),
    JSM_ALERT_BEFORE,
  ),
  withBefore(
    withPreview(row("jira_ops_alert_close", "jira.ops.alert.close", "mesh", 3), {
      target: "{alertId}",
      summary:
        "Ask Jira Service Management Operations to close alert {alertId} (Atlassian accepts the request and runs it asynchronously; Nimbus does not confirm it took effect; it cannot be reopened through Nimbus)",
      fields: [textField("alertId", "Alert id (not a tinyId or alias)")],
    }),
    JSM_ALERT_BEFORE,
  ),
];
