import type { GapNote } from "@nimbus-dev/sdk";

import type { IncidentRecordV1 } from "../../incident/incident-record-types.ts";

/**
 * The `incident` brief (Phase 10 IC3). A pure function of the index and a clock builds the record
 * (`incident/assemble.ts`); `incident-render.ts` renders it with no model (OR-10-8). It is a brief KIND for
 * the I31 machinery (reserved `## Gaps` and `## Data freshness`), not an `agents/` emitter: nothing here
 * answers an `agents.*` request (static D22(d)). Types only.
 */
export type IncidentBrief = {
  readonly kind: "incident";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly record: IncidentRecordV1;
};

/**
 * The `incident_data` brief (Phase 10 incident engine, the Data Incident Brief). The same stored record as
 * {@link IncidentBrief}, rendered for a DATA trigger (Monte Carlo, Bigeye): the monitored models and what they
 * feed on lead, in place of the general order. Built only by `incident/assemble.ts` when the record carries a
 * data lane; deterministic, no model (OR-10-8, I57 (a)). Types only.
 */
export type IncidentDataBrief = {
  readonly kind: "incident_data";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly record: IncidentRecordV1;
};
