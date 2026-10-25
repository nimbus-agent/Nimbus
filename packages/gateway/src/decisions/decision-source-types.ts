import { sourceTypesFor } from "../sources/source-kinds.ts";

/**
 * Which indexed item types feed decision mining: every `service:type` whose kind the decisions
 * pass reads (`sources/source-kinds.ts`, which also carries the service-qualified-key and the
 * no-email/calendar reasoning).
 */
export const DECISION_SOURCE_TYPES: ReadonlySet<string> = new Set(sourceTypesFor("decisions"));
