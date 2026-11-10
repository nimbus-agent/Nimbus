import { HITL_REQUIRED } from "../engine/executor.ts";
import { serviceOf } from "../engine/service-of.ts";
import { USER_MCP_SERVICE_ID_PATTERN, userMcpToolKeyForActionType } from "./user-mcp-store.ts";

/**
 * The act door's gateway-owned tables (spec 2026-10-15 § 6, invariant I28).
 *
 * `ACTION_PROPOSABILITY` classifies EVERY HITL frozen-set type (a test makes it total), so a type
 * added to the set later is UNKNOWN — refused — until someone classifies it: broad minus a
 * denylist, implemented fail-closed. `PROPOSABLE_WRITE_TOOLS` is the routing table: the mesh lists a
 * first-party write as `<server>_<underscored tool>`, which no action type spells, so the act door
 * dispatches the tool named HERE as the payload `mcpToolId` — never one an agent supplied.
 * `proposable-actions.sync.test.ts` proves every row against the installed connectors package.
 */
export type DeniedClass =
  | "file"
  | "calendar_delete"
  | "vcs"
  | "pipeline"
  | "cloud"
  | "iac"
  | "k8s"
  | "deployment"
  | "incident"
  | "data_platform"
  | "mobile_release"
  | "tribal_kb"
  | "chatops_confined"
  | "unroutable"
  /**
   * A real, routable first-party connector write (a row in `connectors/connector-writes/`, in the
   * I2 frozen set, D20-refused over federation) whose MCP proposal is withheld. Eight members, ONE
   * reason: the write's value is its before-state, and the act door runs no before-read (B0b), so
   * the owner would approve it without the state it changes. `jira.issue.transition` (owner ruling
   * OR-B2-4: a bare numeric transition id); the two VCS updates `github.pr.update` and
   * `gitlab.mr.update` (C2: not recoverable, and the owner would see no current title or base);
   * and the five writes of connectors 0.6.0 that C3 templated for the model door
   * (`launchdarkly.flag.{toggle,rollout.set}`, `flagsmith.feature.state.set`,
   * `jira.ops.alert.{acknowledge,close}`): a variation id or an alert id is opaque and a flag flip
   * is its current state, so a queued production change could not be checked on the act door.
   * Revisit the whole class together if the act door ever gets a before-read.
   * Unlike `unroutable`, a tool DOES resolve: the refusal is a review decision, not a routing fact.
   */
  | "not_yet_offered"
  | "gateway_internal";

export type Proposability =
  | { readonly kind: "proposable" }
  | { readonly kind: "denied"; readonly class: DeniedClass };

export type ActionClassification =
  | { readonly kind: "proposable" }
  | {
      readonly kind: "denied";
      readonly class: DeniedClass | "user_mcp_no_model_access" | "user_mcp_policy";
    }
  | { readonly kind: "unknown" };

export interface ClassifyContext {
  /** Service ids registered with `--model` (`model_access = 1`), unfiltered by policy. */
  modelAccessServices(): ReadonlySet<string>;
  /** `user_mcp_model_access` per the LIVE resolved policy; false when the accessor is absent. */
  userMcpModelAccessAllowed(): boolean;
}

const P: Proposability = Object.freeze({ kind: "proposable" });
function denied(cls: DeniedClass, types: readonly string[]): Array<[string, Proposability]> {
  const v: Proposability = Object.freeze({ kind: "denied", class: cls });
  return types.map((t) => [t, v]);
}

/** actionType → bare tool id, as registered by `@nimbus-dev/connectors` (spec § 6.3). */
export const PROPOSABLE_WRITE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  "slack.message.post": "slack_message_post",
  "teams.message.post": "teams_message_post",
  "teams.message.postChat": "teams_message_post_chat",
  "gmail.draft.create": "gmail_draft_create",
  "gmail.draft.send": "gmail_draft_send",
  "gmail.message.send": "gmail_message_send",
  "outlook.mail.send": "outlook_mail_send",
  "fastmail.mail.send": "fastmail_mail_send",
  "imap.mail.send": "imap_mail_send",
  "protonmail.mail.send": "protonmail_mail_send",
  "apple.mail.send": "apple_mail_send",
  "apple.mail.draft.create": "apple_mail_draft_create",
  "outlook.calendar.create": "outlook_calendar_create",
  "apple.calendar.event.create": "apple_calendar_event_create",
  "linear.issue.create": "linear_issue_create",
  "linear.issue.update": "linear_issue_update",
  "linear.comment.create": "linear_comment_create",
  "jira.issue.create": "jira_issue_create",
  "jira.issue.update": "jira_issue_update",
  "jira.comment.add": "jira_comment_add",
  "github.issue.create": "github_issue_create",
  // Phase 9.7 C2: the branch, pull request and merge request creates. Every text field is scanned
  // by the refusals the act door runs first (broadcast mention, forge Markdown remote content,
  // GitLab quick actions in a description), the typed preview shows every field sent, and each is
  // recoverable. The two updates stay withheld (see `not_yet_offered` below).
  "github.branch.create": "github_branch_create",
  "github.pr.create": "github_pr_create",
  "gitlab.branch.create": "gitlab_branch_create",
  "gitlab.mr.create": "gitlab_mr_create",
  // Phase 9.7 B1: the comment and Discord posts, each with a typed preview template.
  "github.issue.comment.create": "github_issue_comment_create",
  "gitlab.issue.note.create": "gitlab_issue_note_create",
  "gitlab.mr.note.create": "gitlab_mr_note_create",
  "discord.message.post": "discord_message_post",
  // Phase 9.7 B2: the issue writes, each with a typed preview template (labels and assignees add
  // only; a GitLab scoped label and a Linear reassignment are refused by `actDoorRefusal`).
  "github.issue.labels.add": "github_issue_labels_add",
  "github.issue.assignees.add": "github_issue_assignees_add",
  "github.issue.state.set": "github_issue_state_set",
  "gitlab.issue.create": "gitlab_issue_create",
  "gitlab.issue.labels.add": "gitlab_issue_labels_add",
  "gitlab.issue.assignees.add": "gitlab_issue_assignees_add",
  "gitlab.issue.state.set": "gitlab_issue_state_set",
  "notion.page.create": "notion_page_create",
  "notion.page.update": "notion_page_update",
  "notion.block.append": "notion_block_append",
  "notion.comment.create": "notion_comment_create",
  "confluence.page.create": "confluence_page_create",
  "confluence.page.update": "confluence_page_update",
  "confluence.comment.add": "confluence_comment_add",
  // Phase 9.7 B3: the Outlook draft and the Confluence append, each with a typed preview template.
  // While a KB destination is configured, `actDoorRefusal` refuses a page write to it and every
  // Notion/Confluence page update or append (OR-B3-1, OR-B3-3).
  "outlook.draft.create": "outlook_draft_create",
  "confluence.page.append": "confluence_page_append",
  "google_drive.file.create": "gdrive_file_create",
  // `obsidian` is a mesh-only server (lazy-mesh/tool-map.ts MESH_ONLY_SERVER_IDS), not a catalog id.
  "obsidian.note.append": "obsidian_append_to_daily_note",
});

export const ACTION_PROPOSABILITY: Readonly<Record<string, Proposability>> = Object.freeze(
  Object.fromEntries([
    ...Object.keys(PROPOSABLE_WRITE_TOOLS).map((t): [string, Proposability] => [t, P]),
    ...denied("file", [
      "file.delete",
      "file.move",
      "file.rename",
      "file.create",
      "photo.delete",
      "onedrive.delete",
      "onedrive.move",
      "onedrive.item.delete",
      "onedrive.item.move",
      "google_drive.file.move",
      "google_drive.file.rename",
      "google_drive.file.trash",
    ]),
    ...denied("calendar_delete", [
      "calendar.event.delete",
      "outlook.calendar.delete",
      "apple.calendar.event.delete",
    ]),
    ...denied("vcs", [
      "repo.pr.merge",
      "repo.pr.close",
      "repo.branch.delete",
      "repo.tag.create",
      "repo.commit.push",
      "github.pr.merge",
      "github.pr.close",
      "github.branch.delete",
      "github.tag.create",
      "bitbucket.pr.merge",
      "gitlab.mr.merge",
      "github.file.commit",
      "gitlab.commit.create",
    ]),
    ...denied("pipeline", [
      "pipeline.trigger",
      "pipeline.cancel",
      "pipeline.rerun",
      "jenkins.build.trigger",
      "jenkins.build.abort",
      "github_actions.run.trigger",
      "github_actions.run.cancel",
      "circleci.pipeline.trigger",
      "circleci.job.cancel",
      "gitlab.pipeline.retry",
      "gitlab.pipeline.cancel",
      "bitrise.build.trigger",
      "codemagic.build.trigger",
    ]),
    // D3b: a build sent to testers (or a public-link group) cannot be unsent.
    ...denied("mobile_release", ["testflight.build.distribute", "firebase.release.distribute"]),
    ...denied("cloud", [
      "aws.ecs.service.update",
      "aws.lambda.invoke",
      "aws.ec2.instance.stop",
      "aws.ec2.instance.start",
      "azure.app_service.restart",
      "azure.aks.node_pool.scale",
      "gcp.cloud_run.deploy",
      "gcp.gke.workload.restart",
      "cloud.resource.scale",
      "cloud.resource.stop",
    ]),
    ...denied("iac", [
      "iac.terraform.apply",
      "iac.terraform.destroy",
      "iac.cloudformation.deploy",
      "iac.cloudformation.changeset.discard",
      "iac.pulumi.up",
      "infra.apply",
      "infra.destroy",
    ]),
    ...denied("k8s", [
      "kubernetes.rollout.restart",
      "kubernetes.pod.delete",
      "kubernetes.deployment.scale",
      "kubernetes.manifest.apply",
      "k8s.apply",
      "k8s.delete",
      "k8s.rollout.restart",
    ]),
    ...denied("deployment", [
      "deployment.apply",
      "deployment.rollback",
      "argocd.app.sync",
      "argocd.app.rollback",
      "flux.kustomization.reconcile",
      "flux.helmrelease.reconcile",
      "mlflow.model.promote",
      "mlflow.model.transition_stage",
      // D3b: a production deploy cannot be taken back by this tool, so none is proposable.
      "vercel.deployment.redeploy",
      "vercel.deployment.promote",
      "netlify.build.trigger",
    ]),
    ...denied("incident", [
      "pagerduty.incident.acknowledge",
      "pagerduty.incident.resolve",
      "pagerduty.incident.escalate",
      "alert.acknowledge",
      "alert.silence",
      "incident.escalate",
      "incident.resolve",
      "montecarlo.incident.acknowledge",
      "montecarlo.incident.resolve",
      "bigeye.issue.acknowledge",
      "bigeye.issue.resolve",
    ]),
    ...denied("data_platform", [
      "snowflake.tag.set",
      "snowflake.comment.set",
      "tableau.datasource.refresh",
      "tableau.workbook.refresh",
      "looker.datagroup.trigger",
      "looker.schedule.run_once",
      "powerbi.dataset.refresh",
      "powerbi.dataflow.refresh",
    ]),
    // I25/D19: destination config-pinned; tool ids confined to the tribal write gate.
    ...denied("tribal_kb", ["notion.knowledge.write", "confluence.knowledge.write"]),
    // I23/D17: these tool literals are confined to the ChatOps reply surface.
    ...denied("chatops_confined", ["slack.chat.post", "teams.chat.post"]),
    // No connector server is named `email`/`calendar`: no tool can resolve, and
    // `isConnectorConfigured` would answer true vacuously for an unknown service.
    ...denied("unroutable", [
      "email.send",
      "email.draft.send",
      "email.draft.create",
      "calendar.event.create",
    ]),
    // A routable write not offered to MCP clients. `jira.issue.transition` is withheld by owner
    // ruling OR-B2-4: before-reads run on the model door only (B0b), so an MCP proposal would ask
    // the owner to approve a bare numeric transition id, with no From or To, on a write that can be
    // one-way.
    // `github.pr.update` and `gitlab.mr.update` (C2) are templated for the model door but withheld
    // here: they are not recoverable (the connector overwrites the old text or retargets the base)
    // and the act door runs no before-read, so the owner would approve an edit with no current
    // title or base to compare (the same reason as the Jira transition). The three flag writes and
    // the two Jira Operations alert writes (C3) are templated for the model door and withheld here
    // for the same reason: a rollout's `weights` are opaque variation ids, an alert id is opaque,
    // and a flag flip is its current state, none of which the act door can show the owner.
    ...denied("not_yet_offered", [
      "jira.issue.transition",
      "github.pr.update",
      "gitlab.mr.update",
      "launchdarkly.flag.toggle",
      "launchdarkly.flag.rollout.set",
      "flagsmith.feature.state.set",
      "jira.ops.alert.acknowledge",
      "jira.ops.alert.close",
    ]),
    ...denied("gateway_internal", [
      "data.delete",
      "data.export",
      "connector.remove",
      "connector.adoptLocalAuth",
      "connector.addMcp",
      "connector.reindex",
      "extension.autoUpdate",
      "extension.downgrade",
      "extension.install",
      "extension.run",
      "extension.migrate",
      "extension.eval",
      "registry.add",
      "pack.install",
      "connector.writes.enable",
      "vault.set",
      "vault.delete",
      "teamvault.put",
      "teamvault.delete",
      // Derived, not spelled: D21 confines the share-publish literal to its allow-listed files.
      ...[...HITL_REQUIRED].filter((t) => serviceOf(t) === "share"),
      "egress.prune",
      "tool.save",
    ]),
  ]),
);

function isUserMcpType(actionType: string): boolean {
  return USER_MCP_SERVICE_ID_PATTERN.test(serviceOf(actionType));
}

/**
 * The tool half of a user-MCP action type (after the first `.`): the same alphabet and length the
 * engine allows a model-facing user-MCP tool name (`engine/user-mcp-agent-tools.ts`
 * MODEL_TOOL_NAME_PATTERN / USER_MCP_TOOL_NAME_MAX). Anything else names no tool the owner could
 * have meant and is rendered nowhere: it is UNKNOWN, refused.
 */
const USER_MCP_TOOL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function userMcpToolSegmentOk(actionType: string): boolean {
  return USER_MCP_TOOL_SEGMENT_PATTERN.test(actionType.slice(actionType.indexOf(".") + 1));
}

export function classifyActionType(actionType: string, ctx: ClassifyContext): ActionClassification {
  if (isUserMcpType(actionType)) {
    if (
      userMcpToolKeyForActionType(actionType) === undefined ||
      !userMcpToolSegmentOk(actionType)
    ) {
      return { kind: "unknown" };
    }
    if (!ctx.userMcpModelAccessAllowed()) return { kind: "denied", class: "user_mcp_policy" };
    if (!ctx.modelAccessServices().has(serviceOf(actionType))) {
      return { kind: "denied", class: "user_mcp_no_model_access" };
    }
    return { kind: "proposable" };
  }
  return Object.hasOwn(ACTION_PROPOSABILITY, actionType)
    ? (ACTION_PROPOSABILITY[actionType] as Proposability)
    : { kind: "unknown" };
}

/** The ONE tool id the act door dispatches for a first-party proposable type (spec § 6.3). */
export function proposableWriteTool(actionType: string): string | undefined {
  return Object.hasOwn(PROPOSABLE_WRITE_TOOLS, actionType)
    ? PROPOSABLE_WRITE_TOOLS[actionType]
    : undefined;
}

/**
 * What `capture.status` advertises (spec § 10): first-party proposables whose service is
 * configured, plus one `mcp_<id>.*` pattern per `--model` server while policy allows. A pattern,
 * not a tool list: listing tools would spawn every `--model` server on each status call.
 */
export async function listProposableActionTypes(
  ctx: ClassifyContext & { isServiceConfigured(service: string): Promise<boolean> },
): Promise<string[]> {
  const out: string[] = [];
  const configured = new Map<string, boolean>();
  // Sequential on purpose: a configured-ness check is a Vault read, and on Linux each Vault read
  // spawns a `secret-tool` process, so one check per service at once would be a process burst.
  for (const type of Object.keys(PROPOSABLE_WRITE_TOOLS)) {
    const svc = serviceOf(type);
    if (!configured.has(svc)) configured.set(svc, await ctx.isServiceConfigured(svc)); // NOSONAR S9382: each check is a Vault read (a secret-tool spawn on Linux)
    if (configured.get(svc) === true) out.push(type);
  }
  if (ctx.userMcpModelAccessAllowed()) {
    for (const id of ctx.modelAccessServices()) out.push(`${id}.*`);
  }
  return out.toSorted((a, b) => a.localeCompare(b)).slice(0, 200);
}
