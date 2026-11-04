// packages/gateway/src/connectors/connector-writes/incident.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const INCIDENT_ROWS: readonly ConnectorWriteRow[] = [
  row("pd_incident_acknowledge", "pagerduty.incident.acknowledge", "mesh", 3),
  row("pd_incident_resolve", "pagerduty.incident.resolve", "mesh", 3),
  row("pd_incident_escalate", "pagerduty.incident.escalate", "mesh", 3),
];
