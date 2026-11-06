// packages/gateway/src/connectors/connector-writes/incident.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const INCIDENT_ROWS: readonly ConnectorWriteRow[] = [
  row("pd_incident_acknowledge", "pagerduty.incident.acknowledge", "mesh", 3),
  row("pd_incident_resolve", "pagerduty.incident.resolve", "mesh", 3),
  row("pd_incident_escalate", "pagerduty.incident.escalate", "mesh", 3),
  // Connectors 0.6.0 (spec 15.3, OR-W34-7): Jira Service Management Operations alerts, instead of
  // Opsgenie. The alert is incident-style; JSM Operations has no incident-resolve write, so only
  // acknowledge and close exist. Not recoverable (the connector marks both `recoverable: false`).
  row("jira_ops_alert_acknowledge", "jira.ops.alert.acknowledge", "mesh", 3),
  row("jira_ops_alert_close", "jira.ops.alert.close", "mesh", 3),
];
