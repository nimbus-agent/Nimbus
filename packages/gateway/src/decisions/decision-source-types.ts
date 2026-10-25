import { sourceTypesFor } from "../sources/source-kinds.ts";

/**
 * Which indexed item types feed decision mining: every `service:type` whose kind the decisions
 * pass reads (`sources/source-kinds.ts`, which also carries the service-qualified-key and the
 * no-email/calendar reasoning).
 */
export const DECISION_SOURCE_TYPES: ReadonlySet<string> = new Set(sourceTypesFor("decisions"));

/** The table MUST be aliased `i`. */
const DECISION_SOURCE_MATCH_SQL = "(i.service || ':' || i.type)";

export function decisionSourceFilter(): { sql: string; params: string[] } {
  const keys = [...DECISION_SOURCE_TYPES];
  const placeholders = keys.map(() => "?").join(", ");
  return { sql: `${DECISION_SOURCE_MATCH_SQL} IN (${placeholders})`, params: keys };
}
