import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NULL_EGRESS_SINK } from "../../../src/egress/egress-ledger.ts";
import { HITL_REQUIRED, ToolExecutor } from "../../../src/engine/executor.ts";
import type {
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../../../src/engine/types.ts";

const Q2_WRITE_ACTIONS: ReadonlyArray<string> = [
  "file.create",
  "slack.message.post",
  "teams.message.post",
  "teams.message.postChat",
  "linear.issue.create",
  "linear.issue.update",
  "linear.comment.create",
  "jira.issue.create",
  "jira.issue.update",
  "jira.comment.add",
  "notion.page.create",
  "notion.page.update",
  "notion.block.append",
  "notion.comment.create",
  "confluence.page.create",
  "confluence.page.update",
  "confluence.comment.add",
  "jenkins.build.trigger",
  "jenkins.build.abort",
  "github_actions.run.trigger",
  "github_actions.run.cancel",
  "circleci.pipeline.trigger",
  "circleci.job.cancel",
  "gitlab.pipeline.retry",
  "gitlab.pipeline.cancel",
  "aws.ecs.service.update",
  "aws.lambda.invoke",
  "aws.ec2.instance.stop",
  "aws.ec2.instance.start",
  "azure.app_service.restart",
  "azure.aks.node_pool.scale",
  "gcp.cloud_run.deploy",
  "gcp.gke.workload.restart",
  "iac.terraform.apply",
  "iac.terraform.destroy",
  "iac.cloudformation.deploy",
  "iac.pulumi.up",
  "kubernetes.rollout.restart",
  "kubernetes.pod.delete",
  "kubernetes.deployment.scale",
  "pagerduty.incident.acknowledge",
  "pagerduty.incident.resolve",
  "pagerduty.incident.escalate",
];

const HITL_E2E_IAC_TF_DIR = mkdtempSync(join(tmpdir(), "nimbus-hitl-e2e-iac-tf-"));
const HITL_E2E_IAC_PU_DIR = mkdtempSync(join(tmpdir(), "nimbus-hitl-e2e-iac-pu-"));

const HITL_WRITE_PAYLOADS: Record<string, Record<string, unknown>> = {
  "file.create": { mcpToolId: "google_drive_gdrive_file_create", input: { name: "report.md" } },
  "slack.message.post": {
    mcpToolId: "slack_slack_message_post",
    input: { channel: "C123", text: "hello" },
  },
  "teams.message.post": {
    mcpToolId: "teams_teams_message_post",
    input: { teamId: "T1", channelId: "C1", content: "hi" },
  },
  "teams.message.postChat": {
    mcpToolId: "teams_teams_message_post_chat",
    input: { chatId: "CH1", content: "hi" },
  },
  "linear.issue.create": {
    mcpToolId: "linear_linear_issue_create",
    input: { teamId: "TEAM", title: "Bug: crash on startup" },
  },
  "linear.issue.update": {
    mcpToolId: "linear_linear_issue_update",
    input: { issueId: "ISS-1", stateId: "done" },
  },
  "linear.comment.create": {
    mcpToolId: "linear_linear_comment_create",
    input: { issueId: "ISS-1", body: "Fixed." },
  },
  "jira.issue.create": {
    mcpToolId: "jira_jira_issue_create",
    input: { projectKey: "NIM", summary: "Login fails" },
  },
  "jira.issue.update": {
    mcpToolId: "jira_jira_issue_update",
    input: { issueKey: "NIM-42", status: "In Progress" },
  },
  "jira.comment.add": {
    mcpToolId: "jira_jira_comment_add",
    input: { issueKey: "NIM-42", body: "Investigating." },
  },
  "notion.page.create": {
    mcpToolId: "notion_notion_page_create",
    input: { parentPageId: "PAGE1", title: "Q2 Retro" },
  },
  "notion.page.update": {
    mcpToolId: "notion_notion_page_update",
    input: { pageId: "PAGE1", propertiesJson: "{}" },
  },
  "notion.block.append": {
    mcpToolId: "notion_notion_block_append",
    input: { parentBlockId: "BLK1", childrenJson: "[]" },
  },
  "notion.comment.create": {
    mcpToolId: "notion_notion_comment_create",
    input: { pageId: "PAGE1", text: "LGTM" },
  },
  "confluence.page.create": {
    mcpToolId: "confluence_confluence_page_create",
    input: { spaceKey: "ENG", title: "Architecture Decision" },
  },
  "confluence.page.update": {
    mcpToolId: "confluence_confluence_page_update",
    input: { pageId: "PG1", title: "Architecture Decision v2" },
  },
  "confluence.comment.add": {
    mcpToolId: "confluence_confluence_comment_add",
    input: { pageId: "PG1", body: "Looks good." },
  },
  "jenkins.build.trigger": {
    mcpToolId: "jenkins_jenkins_build_trigger",
    input: { jobName: "my-folder/my-job" },
  },
  "jenkins.build.abort": {
    mcpToolId: "jenkins_jenkins_build_abort",
    input: { jobName: "my-folder/my-job", buildNumber: 7 },
  },
  "github_actions.run.trigger": {
    mcpToolId: "github_actions_gha_run_trigger",
    input: { owner: "org", repo: "svc", workflowId: "build.yml", ref: "main" },
  },
  "github_actions.run.cancel": {
    mcpToolId: "github_actions_gha_run_cancel",
    input: { owner: "org", repo: "svc", runId: 12345 },
  },
  "circleci.pipeline.trigger": {
    mcpToolId: "circleci_circleci_pipeline_trigger",
    input: { projectSlug: "gh/org/svc", branch: "main" },
  },
  "circleci.job.cancel": {
    mcpToolId: "circleci_circleci_job_cancel",
    input: { projectSlug: "gh/org/svc", jobNumber: 101 },
  },
  "gitlab.pipeline.retry": {
    mcpToolId: "gitlab_gitlab_pipeline_retry",
    input: { projectPath: "org/svc", pipelineId: 55 },
  },
  "gitlab.pipeline.cancel": {
    mcpToolId: "gitlab_gitlab_pipeline_cancel",
    input: { projectPath: "org/svc", pipelineId: 56 },
  },
  "aws.ecs.service.update": {
    mcpToolId: "aws_aws_ecs_service_update",
    input: { cluster: "c1", service: "svc1", taskDefinition: "td:1" },
  },
  "aws.lambda.invoke": {
    mcpToolId: "aws_aws_lambda_invoke",
    input: { functionName: "fn1", payloadJson: "{}" },
  },
  "aws.ec2.instance.stop": {
    mcpToolId: "aws_aws_ec2_instance_stop",
    input: { instanceIds: "i-1" },
  },
  "aws.ec2.instance.start": {
    mcpToolId: "aws_aws_ec2_instance_start",
    input: { instanceIds: "i-1" },
  },
  "azure.app_service.restart": {
    mcpToolId: "azure_azure_app_service_restart",
    input: { subscriptionId: "sub", resourceGroup: "rg", name: "app" },
  },
  "azure.aks.node_pool.scale": {
    mcpToolId: "azure_azure_aks_node_pool_scale",
    input: {
      subscriptionId: "sub",
      resourceGroup: "rg",
      clusterName: "aks",
      poolName: "default",
      nodeCount: 2,
    },
  },
  "gcp.cloud_run.deploy": {
    mcpToolId: "gcp_gcp_cloud_run_deploy",
    input: { projectId: "p", region: "us-central1", service: "svc", image: "gcr.io/x/img:1" },
  },
  "gcp.gke.workload.restart": {
    mcpToolId: "gcp_gcp_gke_workload_restart",
    input: {
      projectId: "p",
      location: "zone",
      cluster: "c",
      namespace: "default",
      deployment: "d",
    },
  },
  "iac.terraform.apply": {
    mcpToolId: "iac_iac_terraform_apply",
    input: { workingDirectory: HITL_E2E_IAC_TF_DIR },
  },
  "iac.terraform.destroy": {
    mcpToolId: "iac_iac_terraform_destroy",
    input: { workingDirectory: HITL_E2E_IAC_TF_DIR },
  },
  "iac.cloudformation.deploy": {
    mcpToolId: "iac_iac_cloudformation_deploy",
    input: { stackName: "s", templateBody: "{}" },
  },
  "iac.pulumi.up": {
    mcpToolId: "iac_iac_pulumi_up",
    input: { workingDirectory: HITL_E2E_IAC_PU_DIR },
  },
  "kubernetes.rollout.restart": {
    mcpToolId: "kubernetes_k8s_rollout_restart",
    input: { namespace: "default", resourceType: "deployment", name: "api" },
  },
  "kubernetes.pod.delete": {
    mcpToolId: "kubernetes_k8s_pod_delete",
    input: { namespace: "default", podName: "p1" },
  },
  "kubernetes.deployment.scale": {
    mcpToolId: "kubernetes_k8s_deployment_scale",
    input: { namespace: "default", deploymentName: "api", replicas: 2 },
  },
  "pagerduty.incident.acknowledge": {
    mcpToolId: "pagerduty_pd_incident_acknowledge",
    input: { incidentId: "Q123" },
  },
  "pagerduty.incident.resolve": {
    mcpToolId: "pagerduty_pd_incident_resolve",
    input: { incidentId: "Q123" },
  },
  "pagerduty.incident.escalate": {
    mcpToolId: "pagerduty_pd_incident_escalate",
    input: { incidentId: "Q123" },
  },
};

function payloadFor(actionType: string): Record<string, unknown> {
  return HITL_WRITE_PAYLOADS[actionType] ?? {};
}

function buildMocks(approve: boolean): {
  consentCalls: string[];
  dispatchCalls: PlannedAction[];
  executor: ToolExecutor;
} {
  const consentCalls: string[] = [];
  const dispatchCalls: PlannedAction[] = [];

  const consent: ConsentChannel = {
    requestApproval(prompt: string): Promise<boolean> {
      consentCalls.push(prompt);
      return Promise.resolve(approve);
    },
  };

  const audit: AuditSink = {
    recordAudit(): void {
      /* no-op */
    },
  };

  const connectors: ConnectorDispatcher = {
    dispatch(action: PlannedAction): Promise<unknown> {
      dispatchCalls.push(action);
      return Promise.resolve({ ok: true });
    },
  };

  // NOTE: packages/gateway/test/** is not covered by any tsconfig, so a change to ToolExecutor's
  // constructor signature is NOT caught by `bun run typecheck` here — it only fails at runtime.
  // Verify by running the suites under this directory directly (see CI regression that caught this).
  return {
    consentCalls,
    dispatchCalls,
    executor: new ToolExecutor(consent, audit, connectors, undefined, NULL_EGRESS_SINK),
  };
}

describe("HITL_REQUIRED covers every Q2 write action", () => {
  test("all Q2 write action types are in the frozen HITL_REQUIRED set", () => {
    for (const actionType of Q2_WRITE_ACTIONS) {
      expect(HITL_REQUIRED.has(actionType)).toBe(true);
    }
  });
});

describe("ToolExecutor — consent gate fires before dispatch (approved)", () => {
  for (const actionType of Q2_WRITE_ACTIONS) {
    test(`${actionType}: consent requested once, dispatch called once`, async () => {
      const { consentCalls, dispatchCalls, executor } = buildMocks(true);
      const action: PlannedAction = { type: actionType, payload: payloadFor(actionType) };

      const result = await executor.execute(action);

      expect(result.status).toBe("ok");
      expect(consentCalls).toHaveLength(1);
      expect(dispatchCalls).toHaveLength(1);
      expect(dispatchCalls[0]).toMatchObject({ type: actionType });
    });
  }
});

describe("ToolExecutor — consent gate fires before dispatch (rejected)", () => {
  for (const actionType of Q2_WRITE_ACTIONS) {
    test(`${actionType}: consent requested once, dispatch NOT called`, async () => {
      const { consentCalls, dispatchCalls, executor } = buildMocks(false);
      const action: PlannedAction = { type: actionType, payload: payloadFor(actionType) };

      const result = await executor.execute(action);

      expect(result.status).toBe("rejected");
      expect(consentCalls).toHaveLength(1);
      expect(dispatchCalls).toHaveLength(0);
    });
  }
});

describe("ToolExecutor — read-only actions bypass consent gate", () => {
  for (const readAction of ["file_search", "index_search", "filesystem_search_files"]) {
    test(`${readAction}: no consent call, dispatch called directly`, async () => {
      const { consentCalls, dispatchCalls, executor } = buildMocks(false);
      const action: PlannedAction = { type: readAction, payload: { query: "test" } };

      const result = await executor.execute(action);

      expect(result.status).toBe("ok");
      expect(consentCalls).toHaveLength(0);
      expect(dispatchCalls).toHaveLength(1);
    });
  }
});
