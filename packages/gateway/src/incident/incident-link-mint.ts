import type { Database } from "bun:sqlite";

import { assertIncidentLink, type IncidentLink } from "../engine/incident-link.ts";
import { IncidentError } from "./assemble.ts";

/**
 * The ONLY constructor of an {@link IncidentLink} (Phase 10 IC4, static D46(e)): the link names a record
 * that exists and the version it holds NOW, so a replay shows what was known when the action ran. A
 * read of `incident_record` and nothing else (the module has no write path, no network and no import of
 * `egress/`). Nothing in IC4 calls it from production code: IC5's remediation module is its first
 * importer (and is added to the rule's allowed list in the commit that creates it).
 */
export function mintIncidentLink(db: Database, recordId: string): IncidentLink {
  const row = db.query("SELECT id, version FROM incident_record WHERE id = ?").get(recordId) as {
    id: string;
    version: number;
  } | null;
  if (row === null) {
    throw new IncidentError("ERR_INCIDENT_NOT_FOUND", "no incident record has that id");
  }
  const link: IncidentLink = { id: row.id, version: row.version };
  assertIncidentLink(link);
  return Object.freeze(link);
}
