import type { GapNote } from "@nimbus-dev/sdk";

import type { IncidentRecordV1 } from "../../incident/incident-record-types.ts";
import type { Investigation } from "../../incident/investigate.ts";

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

/**
 * The `incident_investigation` brief (Phase 10 IC9a, `--synthesize`). The investigation of one record, built
 * from the local index only (`incident/investigate.ts`), carried as a brief KIND so the I31 machinery can hold
 * its disclosures while a model, asked by the owner (`nimbus incident investigate --synthesize`), rewrites the
 * prose. `gaps` mirrors the investigation's own gap list (detail only); the investigation is carried whole. It
 * is built only outside `incident/**` (static D46(a): no runner reaches an incident record from there).
 */
export type IncidentInvestigationBrief = {
  readonly kind: "incident_investigation";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly investigation: Investigation;
};

/**
 * The `incident_update` brief (Phase 10 IC9b, `--synthesize`; owner ruling OR-S4-SCRIBE). The deterministic
 * update text (`renderIncidentUpdate`, facts and disclosure footer included) carried as a brief KIND, so the I31
 * machinery can hold that text verbatim while a model, asked by the owner (`nimbus incident update --synthesize`),
 * writes ONE short lead paragraph. `gaps` is empty in production. Built only outside `incident/**` and outside
 * `incident-update/**` (static D46(a); the IC9b confinement pin), in `update-synthesis/`.
 */
export type IncidentUpdateBrief = {
  readonly kind: "incident_update";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly recordId: string;
  readonly version: number;
  readonly audience: string;
  /** The deterministic update text, exactly as `incident.update` returns it. */
  readonly text: string;
};
