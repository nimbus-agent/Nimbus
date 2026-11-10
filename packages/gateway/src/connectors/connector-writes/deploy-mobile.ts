// packages/gateway/src/connectors/connector-writes/deploy-mobile.ts
// Phase 9.7 D3b: the seven Wave 4 deploy-trigger and mobile-release writes (connectors 0.10.0).
// Each has a typed preview, a before-state reader and a type-to-confirm text, and each is offered
// to the model only after the owner enabled the service at Wave 4 and approved the write by name
// (`max_wave` defaults to 3). The model door adds the refusals of `deploy-refusals.ts`; the MCP act
// door denies all seven (classes `deployment`, `pipeline`, `mobile_release`).
import {
  bitriseLatestReadArgs,
  codemagicLatestReadArgs,
  firebaseReleaseReadArgs,
  NETLIFY_PRODUCTION_BRANCH_GUARD,
  netlifyDeploysReadArgs,
  netlifySiteReadArgs,
  selectBitriseLatest,
  selectCodemagicLatest,
  selectFirebaseRelease,
  selectNetlifyBuild,
  selectTestflightDistribute,
  selectVercelPromote,
  selectVercelRedeploy,
  TESTFLIGHT_PUBLIC_LINK_GUARD,
  testflightBuildGroupsReadArgs,
  testflightGroupsReadArgs,
  vercelPromoteDeploymentReadArgs,
  vercelPromoteReadArgs,
  vercelRedeployReadArgs,
} from "./deploy-readers.ts";
import {
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withConfirm,
  withPreview,
} from "./types.ts";

export const DEPLOY_MOBILE_ROWS: readonly ConnectorWriteRow[] = [
  // A redeploy builds a NEW deployment from an old one. `target` is required and always sent by
  // the connector. The request names no project, so the deployment a production redeploy replaces
  // cannot be read first; the prompt says so.
  withConfirm(
    withBefore(
      withPreview(row("vercel_deployment_redeploy", "vercel.deployment.redeploy", "mesh", 4), {
        target: "{deploymentId}",
        summary: "Redeploy Vercel deployment {deploymentId} as a NEW {target} build",
        fields: [
          textField("deploymentId", "Deployment"),
          textField("target", "Target"),
          textField("withLatestCommit", "With latest commit", "(not set: the source's commit)"),
        ],
      }),
      {
        tool: "vercel_get",
        // `target` is declared for the selection (the effect line), never sent to the read.
        argKeys: ["deploymentId", "target"],
        args: vercelRedeployReadArgs,
        select: selectVercelRedeploy,
      },
    ),
    { template: "redeploy {deploymentId:tail8} {target}" },
  ),
  // A promote makes an existing deployment production WITHOUT a rebuild. The current production
  // deployment is read from the project; the deployment to promote is read beside it.
  withConfirm(
    withBefore(
      withPreview(row("vercel_deployment_promote", "vercel.deployment.promote", "mesh", 4), {
        target: "{projectId}",
        summary:
          "Promote Vercel deployment {deploymentId} to production for project {projectId} (no rebuild)",
        fields: [textField("projectId", "Project"), textField("deploymentId", "Deployment")],
      }),
      {
        tool: "vercel_project_production_get",
        argKeys: ["projectId"],
        args: vercelPromoteReadArgs,
        also: {
          tool: "vercel_get",
          argKeys: ["deploymentId"],
          args: vercelPromoteDeploymentReadArgs,
        },
        select: selectVercelPromote,
      },
    ),
    { template: "promote {projectId:tail8} {deploymentId:tail8}" },
  ),
  // A build with no branch is a PRODUCTION publish (Netlify's documented behaviour): the connector
  // refuses "neither or both of branch and production" only after the prompt, the model door
  // before it, and the guard refuses a branch that IS the site's production branch.
  withConfirm(
    withBefore(
      withPreview(row("netlify_build_trigger", "netlify.build.trigger", "mesh", 4), {
        target: "{siteId}",
        summary: "Start a Netlify build of site {siteId}",
        fields: [
          textField("siteId", "Site"),
          textField("branch", "Branch", "(none: the production site)"),
          textField("production", "Publishes to PRODUCTION", "(no: branch build)"),
          textField("clearCache", "Clear the build cache", "(not set: no)"),
        ],
      }),
      {
        tool: "netlify_get",
        // `branch` and `production` are declared for the selection and the guard, never sent.
        argKeys: ["siteId", "branch", "production"],
        args: netlifySiteReadArgs,
        also: { tool: "netlify_deploy_list", argKeys: ["siteId"], args: netlifyDeploysReadArgs },
        select: selectNetlifyBuild,
        guard: NETLIFY_PRODUCTION_BRANCH_GUARD,
      },
    ),
    {
      // `branch` is optional in the tool's schema, so it cannot be a placeholder; the preview shows it.
      template: "build {siteId:tail8}",
      whenUnset: { field: "branch", template: "publish production {siteId:tail8}" },
    },
  ),
  withConfirm(
    withBefore(
      withPreview(row("bitrise_build_trigger", "bitrise.build.trigger", "mesh", 4), {
        target: "{appSlug}/{branch}",
        summary: "Start Bitrise workflow {workflow} on branch {branch} of app {appSlug}",
        fields: [
          textField("appSlug", "App"),
          textField("branch", "Branch"),
          textField("workflow", "Workflow"),
        ],
      }),
      {
        tool: "bitrise_build_latest",
        argKeys: ["appSlug", "branch", "workflow"],
        args: bitriseLatestReadArgs,
        select: selectBitriseLatest,
      },
    ),
    { template: "build {appSlug:tail8} {branch} {workflow}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("codemagic_build_trigger", "codemagic.build.trigger", "mesh", 4), {
        target: "{appId}/{branch}",
        summary: "Start Codemagic workflow {workflowId} on branch {branch} of app {appId}",
        fields: [
          textField("appId", "App"),
          textField("workflowId", "Workflow"),
          textField("branch", "Branch"),
        ],
      }),
      {
        tool: "codemagic_build_latest",
        argKeys: ["appId", "workflowId", "branch"],
        args: codemagicLatestReadArgs,
        select: selectCodemagicLatest,
      },
    ),
    { template: "build {appId:tail8} {workflowId} {branch}" },
  ),
  // Every target group id is shown in full, and the before-state shows each group's name, kind and
  // PUBLIC LINK state. The groups are in the preview, not in the typed text: twenty ids would
  // exceed the 200-character cap.
  withConfirm(
    withBefore(
      withPreview(row("testflight_build_distribute", "testflight.build.distribute", "mesh", 4), {
        target: "{appId}/{buildId}",
        summary: "Add TestFlight build {buildId} of app {appId} to beta groups {betaGroupIds}",
        fields: [
          textField("appId", "App"),
          textField("buildId", "Build"),
          textField("betaGroupIds", "Beta groups (every id in full)"),
        ],
      }),
      {
        tool: "testflight_beta_groups_list",
        // `betaGroupIds` is declared for the selection and the guard, never sent to the read.
        argKeys: ["appId", "betaGroupIds"],
        args: testflightGroupsReadArgs,
        also: {
          tool: "testflight_build_groups_get",
          argKeys: ["buildId"],
          args: testflightBuildGroupsReadArgs,
        },
        select: selectTestflightDistribute,
        guard: TESTFLIGHT_PUBLIC_LINK_GUARD,
      },
    ),
    { template: "distribute {appId} {buildId:tail8}" },
  ),
  // Both lists are shown in full as compact JSON. An address that is not yet a tester becomes one
  // and is emailed an invitation; the model door refuses `testerEmails` altogether.
  withConfirm(
    withBefore(
      withPreview(
        row("firebase_app_distribution_distribute", "firebase.release.distribute", "mesh", 4),
        {
          target: "{appId}/{releaseId}",
          summary:
            "Send Firebase App Distribution release {releaseId} of app {appId} to the groups and testers below",
          fields: [
            textField("appId", "App"),
            textField("releaseId", "Release"),
            textField("groupAliases", "Group aliases", "(none)"),
            textField(
              "testerEmails",
              "Tester emails (an address not yet a tester is created and emailed an invitation)",
              "(none)",
            ),
          ],
        },
      ),
      {
        tool: "firebase_get",
        argKeys: ["appId", "releaseId"],
        args: firebaseReleaseReadArgs,
        select: selectFirebaseRelease,
      },
    ),
    { template: "distribute {appId} {releaseId}" },
  ),
];
