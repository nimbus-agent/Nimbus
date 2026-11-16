/**
 * The closed registry of incident trigger sources (Phase 10 IC3, incident-engine spec § 5.3). A trigger item is
 * an item of one of these five `(service, type)` pairs. This is the only place the five pairs are written in
 * the incident engine; `incident_record.trigger_service` has no CHECK (SQLite cannot alter one in place), so a
 * sixth source is a change here plus a test, not a migration.
 */
export type TriggerService = "pagerduty" | "jira" | "sentry" | "montecarlo" | "bigeye";

export type TriggerSource = {
  readonly service: TriggerService;
  readonly type: string;
};

export const TRIGGER_SOURCES: readonly TriggerSource[] = Object.freeze([
  Object.freeze({ service: "pagerduty", type: "incident" }),
  Object.freeze({ service: "jira", type: "alert" }),
  Object.freeze({ service: "sentry", type: "error_issue" }),
  Object.freeze({ service: "montecarlo", type: "data_quality_test" }),
  Object.freeze({ service: "bigeye", type: "data_quality_test" }),
] as const);

export const TRIGGER_SERVICES: readonly TriggerService[] = Object.freeze(
  TRIGGER_SOURCES.map((s) => s.service),
);

export function isTriggerService(service: string): service is TriggerService {
  return TRIGGER_SOURCES.some((s) => s.service === service);
}

/** The item `type` of a trigger service. */
export function triggerTypeOf(service: TriggerService): string {
  const found = TRIGGER_SOURCES.find((s) => s.service === service);
  // The registry holds every TriggerService member, so a miss is unreachable.
  return found === undefined ? "" : found.type;
}

export function isTriggerPair(service: string, type: string): service is TriggerService {
  return TRIGGER_SOURCES.some((s) => s.service === service && s.type === type);
}

/** The item types of every trigger source, de-duplicated (`data_quality_test` is shared). */
export const TRIGGER_TYPES: readonly string[] = Object.freeze([
  ...new Set(TRIGGER_SOURCES.map((s) => s.type)),
]);
