import type { Database } from "bun:sqlite";

import { upsertIncidentRecord } from "../incident-store.ts";
import { buildRecord } from "./record-builder.ts";

/**
 * Seeds the erasure scenario: two Slack-citing records (one cites Slack only in version 1), an unrelated
 * record, a pushed brief for each, and a pushed brief written by the old dispatch with no record.
 */
export function seedErasureScenario(db: Database): void {
  const put = (itemId: string, cited: string[], sha: string): void => {
    const service = itemId.slice(0, itemId.indexOf(":")) as "pagerduty";
    upsertIncidentRecord(db, {
      record: buildRecord({ itemId, service }),
      markdown: "md",
      recordSha256: sha,
      citedServices: cited,
      nowMs: 5_000,
    });
  };
  put("pagerduty:P1", ["pagerduty", "slack"], "a");
  put("jira:J1", ["jira", "slack"], "a");
  put("jira:J1", ["jira"], "b"); // version 2 no longer cites Slack; version 1 did
  put("sentry:S1", ["sentry"], "a");
  for (const id of ["pagerduty:P1", "jira:J1", "sentry:S1", "bigeye:OLD-NO-RECORD"]) {
    db.run(
      "INSERT INTO pushed_brief (incident_id, session_id, status, brief_markdown, created_at) VALUES (?, ?, 'ok', 'brief', 1)",
      [id, id.startsWith("bigeye") ? "agents-oncall-session" : `incident:${id}:v1`],
    );
  }
}

export function recordItems(db: Database): string[] {
  return (
    db.query("SELECT trigger_item_id AS t FROM incident_record ORDER BY t").all() as { t: string }[]
  ).map((r) => r.t);
}

export function briefItems(db: Database): string[] {
  return (
    db.query("SELECT incident_id AS t FROM pushed_brief ORDER BY t").all() as { t: string }[]
  ).map((r) => r.t);
}
