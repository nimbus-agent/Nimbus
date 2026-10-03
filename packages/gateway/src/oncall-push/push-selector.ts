import type { Database } from "bun:sqlite";
import { selectActiveAssignedIncidents } from "../agents/_lib/oncall-queries.ts";
import type { OncallIncident } from "../agents/_lib/oncall-types.ts";
import type { NimbusOncallPushToml } from "../config/oncall-push-toml.ts";

/** Absorbs PagerDuty↔host clock skew at the enable boundary (spec § 2.2, predicate 5). */
export const ENABLE_GRACE_MS = 5 * 60_000;

/**
 * `{"p1"} ∪ [pagerduty] severity_p1_aliases`, the same baseline `preflight/preflight.ts` uses — or
 * `[oncall.push] severities` when non-empty, which REPLACES it. No extra baseline is invented
 * (`sev1`, `critical`): PagerDuty priority names are org-defined, and an alias the owner did not
 * configure would make push disagree with preflight and DORA about what a P1 is.
 */
export function resolveSeveritySet(
  cfg: NimbusOncallPushToml,
  pagerdutyAliases: readonly string[],
): ReadonlySet<string> {
  if (cfg.severities.length > 0) return new Set(cfg.severities.map((s) => s.toLowerCase()));
  return new Set(["p1", ...pagerdutyAliases.map((s) => s.toLowerCase())]);
}

export type SelectInput = {
  readonly personId: string;
  readonly severities: ReadonlySet<string>;
  readonly enabledAtMs: number;
  readonly alreadyPushed: (incidentId: string) => boolean;
};

/**
 * Spec § 2.2. "Assigned to me, active" is `selectActiveAssignedIncidents` UNCHANGED, so what push
 * selects is by construction what `nimbus oncall` shows for "my incidents". Order is that query's
 * (newest first).
 */
export function selectPushCandidates(db: Database, input: SelectInput): OncallIncident[] {
  const floor = input.enabledAtMs - ENABLE_GRACE_MS;
  return selectActiveAssignedIncidents(db, input.personId).filter(
    (i) =>
      i.severity !== null &&
      input.severities.has(i.severity.toLowerCase()) &&
      i.openedAtMs !== null &&
      i.openedAtMs >= floor &&
      !input.alreadyPushed(i.id),
  );
}
