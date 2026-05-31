import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

export function prunePeopleAfterServiceRemoval(db: Database, serviceId: string): void {
  switch (serviceId) {
    case "github":
      dbRun(db, "UPDATE person SET github_login = NULL");
      break;
    case "gitlab":
      dbRun(db, "UPDATE person SET gitlab_login = NULL");
      break;
    case "slack":
      dbRun(db, "UPDATE person SET slack_handle = NULL");
      break;
    case "linear":
      dbRun(db, "UPDATE person SET linear_member_id = NULL");
      break;
    case "jira":
      dbRun(db, "UPDATE person SET jira_account_id = NULL");
      break;
    case "notion":
      dbRun(db, "UPDATE person SET notion_user_id = NULL");
      break;
    case "bitbucket":
      dbRun(db, "UPDATE person SET bitbucket_uuid = NULL");
      break;
    case "discord":
      dbRun(db, "UPDATE person SET discord_user_id = NULL");
      break;
    default:
      break;
  }
  dbRun(
    db,
    `DELETE FROM person WHERE id NOT IN (
      SELECT DISTINCT author_id FROM item WHERE author_id IS NOT NULL
    )`,
  );
}
