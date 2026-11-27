// packages/gateway/src/connectors/connector-writes/index.ts
// The one row table for every connector write. Must not import the chatops or tribal gates: the
// structure audit imports this module.
import { BITBUCKET_COMMENT_ROWS } from "./bitbucket-comment-rows.ts";
import { CLOUD_INFRA_ROWS } from "./cloud-infra.ts";
import { DEPLOY_MOBILE_ROWS } from "./deploy-mobile.ts";
import { FILES_ROWS } from "./files.ts";
import { FLAGS_ROWS } from "./flags.ts";
import { GITHUB_PR_REVIEW_ROWS } from "./github-pr-review-rows.ts";
import { GITOPS_ML_ROWS } from "./gitops-ml.ts";
import { INCIDENT_ROWS } from "./incident.ts";
import { ISSUE_EDIT_ROWS } from "./issue-edit-rows.ts";
import { KNOWLEDGE_ROWS } from "./knowledge.ts";
import { MAIL_CALENDAR_ROWS } from "./mail-calendar.ts";
import { MESSAGING_ROWS } from "./messaging.ts";
import { applyReversibility } from "./reversibility.ts";
import { TICKETS_ROWS } from "./tickets.ts";
import type { ConnectorWriteRow } from "./types.ts";
import { VCS_CI_ROWS } from "./vcs-ci.ts";
import { WAREHOUSE_BI_ROWS } from "./warehouse-bi.ts";

export const CONNECTOR_WRITE_ROWS: readonly ConnectorWriteRow[] = applyReversibility([
  ...MESSAGING_ROWS,
  ...TICKETS_ROWS,
  ...ISSUE_EDIT_ROWS,
  ...KNOWLEDGE_ROWS,
  ...MAIL_CALENDAR_ROWS,
  ...FILES_ROWS,
  ...VCS_CI_ROWS,
  ...BITBUCKET_COMMENT_ROWS,
  ...GITHUB_PR_REVIEW_ROWS,
  ...INCIDENT_ROWS,
  ...FLAGS_ROWS,
  ...CLOUD_INFRA_ROWS,
  ...DEPLOY_MOBILE_ROWS,
  ...WAREHOUSE_BI_ROWS,
  ...GITOPS_ML_ROWS,
]);
