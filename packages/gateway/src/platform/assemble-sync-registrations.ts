import { createArgocdSyncable } from "../connectors/argocd-sync.ts";
import { createAwsSyncable } from "../connectors/aws-sync.ts";
import { createAzureSyncable } from "../connectors/azure-sync.ts";
import { createBitbucketSyncable } from "../connectors/bitbucket-sync.ts";
import { createBitriseSyncable } from "../connectors/bitrise-sync.ts";
import { createCircleciSyncable } from "../connectors/circleci-sync.ts";
import { createConfluenceSyncable } from "../connectors/confluence-sync.ts";
import { createDatabricksSyncable } from "../connectors/databricks-sync.ts";
import { createDatadogSyncable } from "../connectors/datadog-sync.ts";
import { createDbtSyncable } from "../connectors/dbt-sync.ts";
import { createDependencytrackSyncable } from "../connectors/dependencytrack-sync.ts";
import { createDiscordSyncable } from "../connectors/discord-sync.ts";
import { createFlagsmithSyncable } from "../connectors/flagsmith-sync.ts";
import { createFluxSyncable } from "../connectors/flux-sync.ts";
import { createGcpSyncable } from "../connectors/gcp-sync.ts";
import { createGithubActionsSyncable } from "../connectors/github-actions-sync.ts";
import { createGithubSyncable } from "../connectors/github-sync.ts";
import { createGitlabSyncable } from "../connectors/gitlab-sync.ts";
import { createGmailSyncable } from "../connectors/gmail-sync.ts";
import { createGoogleDriveSyncable } from "../connectors/google-drive-sync.ts";
import { createGooglePhotosSyncable } from "../connectors/google-photos-sync.ts";
import { createGrafanaSyncable } from "../connectors/grafana-sync.ts";
import { createGreenhouseSyncable } from "../connectors/greenhouse-sync.ts";
import { createIacSyncable } from "../connectors/iac-sync.ts";
import { createIntercomSyncable } from "../connectors/intercom-sync.ts";
import { createJenkinsSyncable } from "../connectors/jenkins-sync.ts";
import { createJiraSyncable } from "../connectors/jira-sync.ts";
import { createKubernetesSyncable } from "../connectors/kubernetes-sync.ts";
import { createLaunchdarklySyncable } from "../connectors/launchdarkly-sync.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import { createLeverSyncable } from "../connectors/lever-sync.ts";
import { createLinearSyncable } from "../connectors/linear-sync.ts";
import { createMercurySyncable } from "../connectors/mercury-sync.ts";
import { createMetabaseSyncable } from "../connectors/metabase-sync.ts";
import { createMlflowSyncable } from "../connectors/mlflow-sync.ts";
import { createNetlifySyncable } from "../connectors/netlify-sync.ts";
import { createNewrelicSyncable } from "../connectors/newrelic-sync.ts";
import { createNotionSyncable } from "../connectors/notion-sync.ts";
import { createOneDriveSyncable } from "../connectors/onedrive-sync.ts";
import { createOutlookSyncable } from "../connectors/outlook-sync.ts";
import { createPagerdutySyncable } from "../connectors/pagerduty-sync.ts";
import { createPipedriveSyncable } from "../connectors/pipedrive-sync.ts";
import { createRaindropSyncable } from "../connectors/raindrop-sync.ts";
import { createReadwiseSyncable } from "../connectors/readwise-sync.ts";
import { createSemgrepSyncable } from "../connectors/semgrep-sync.ts";
import { createSentrySyncable } from "../connectors/sentry-sync.ts";
import { createSlackSyncable } from "../connectors/slack-sync.ts";
import { createSnykSyncable } from "../connectors/snyk-sync.ts";
import { createSonarqubeSyncable } from "../connectors/sonarqube-sync.ts";
import { createStackOverflowSyncable } from "../connectors/stackoverflow-sync.ts";
import { createStripeSyncable } from "../connectors/stripe-sync.ts";
import { createSupersetSyncable } from "../connectors/superset-sync.ts";
import { createTeamsSyncable } from "../connectors/teams-sync.ts";
import { createVercelSyncable } from "../connectors/vercel-sync.ts";
import { createWizSyncable } from "../connectors/wiz-sync.ts";
import { createZendeskSyncable } from "../connectors/zendesk-sync.ts";
import { createZoomSyncable } from "../connectors/zoom-sync.ts";
import { createZoteroSyncable } from "../connectors/zotero-sync.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";

export type ConnectorMeshSyncableOptions = {
  pagerdutyMaxPagesPerSync: number;
};

export function registerConnectorMeshSyncables(
  syncScheduler: SyncScheduler,
  connectorMesh: LazyConnectorMesh,
  options: ConnectorMeshSyncableOptions,
): void {
  syncScheduler.register(
    createGoogleDriveSyncable({
      ensureGoogleDriveRunning: () => connectorMesh.ensureGoogleDriveRunning(),
    }),
  );
  syncScheduler.register(
    createGmailSyncable({
      ensureGoogleMcpRunning: () => connectorMesh.ensureGoogleDriveRunning(),
    }),
  );
  syncScheduler.register(
    createGooglePhotosSyncable({
      ensureGoogleMcpRunning: () => connectorMesh.ensureGoogleDriveRunning(),
    }),
  );
  syncScheduler.register(
    createOneDriveSyncable({
      ensureMicrosoftMcpRunning: () => connectorMesh.ensureMicrosoftBundleRunning(),
    }),
  );
  syncScheduler.register(
    createOutlookSyncable({
      ensureMicrosoftMcpRunning: () => connectorMesh.ensureMicrosoftBundleRunning(),
    }),
  );
  syncScheduler.register(
    createGithubSyncable({
      ensureGithubMcpRunning: () => connectorMesh.ensureGithubRunning(),
    }),
  );
  syncScheduler.register(
    createGithubActionsSyncable({
      ensureGithubMcpRunning: () => connectorMesh.ensureGithubRunning(),
    }),
  );
  syncScheduler.register(
    createGitlabSyncable({
      ensureGitlabMcpRunning: () => connectorMesh.ensureGitlabRunning(),
    }),
  );
  syncScheduler.register(
    createBitbucketSyncable({
      ensureBitbucketMcpRunning: () => connectorMesh.ensureBitbucketRunning(),
    }),
  );
  syncScheduler.register(
    createSlackSyncable({
      ensureSlackMcpRunning: () => connectorMesh.ensureSlackRunning(),
    }),
  );
  syncScheduler.register(
    createTeamsSyncable({
      ensureMicrosoftMcpRunning: () => connectorMesh.ensureMicrosoftBundleRunning(),
    }),
  );
  syncScheduler.register(
    createLinearSyncable({
      ensureLinearMcpRunning: () => connectorMesh.ensureLinearRunning(),
    }),
  );
  syncScheduler.register(
    createJiraSyncable({
      ensureJiraMcpRunning: () => connectorMesh.ensureJiraRunning(),
    }),
  );
  syncScheduler.register(
    createNotionSyncable({
      ensureNotionMcpRunning: () => connectorMesh.ensureNotionRunning(),
    }),
  );
  syncScheduler.register(
    createConfluenceSyncable({
      ensureConfluenceMcpRunning: () => connectorMesh.ensureConfluenceRunning(),
    }),
  );
  syncScheduler.register(
    createDiscordSyncable({
      ensureDiscordMcpRunning: () => connectorMesh.ensureDiscordRunning(),
    }),
  );
  syncScheduler.register(
    createJenkinsSyncable({
      ensureJenkinsMcpRunning: () => connectorMesh.ensureJenkinsRunning(),
    }),
  );
  syncScheduler.register(
    createCircleciSyncable({
      ensureCircleciMcpRunning: () => connectorMesh.ensureCircleciRunning(),
    }),
  );
  syncScheduler.register(
    createPagerdutySyncable({
      ensurePagerdutyMcpRunning: () => connectorMesh.ensurePagerdutyRunning(),
      maxPagesPerSync: options.pagerdutyMaxPagesPerSync,
    }),
  );
  syncScheduler.register(
    createKubernetesSyncable({
      ensureKubernetesMcpRunning: () => connectorMesh.ensureKubernetesRunning(),
    }),
  );
  syncScheduler.register(
    createAwsSyncable({
      ensureAwsMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createAzureSyncable({
      ensureAzureMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createGcpSyncable({
      ensureGcpMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createIacSyncable({
      ensureIacMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createGrafanaSyncable({
      ensureGrafanaMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createSentrySyncable({
      ensureSentryMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createNewrelicSyncable({
      ensureNewrelicMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createDatadogSyncable({
      ensureDatadogMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createSnykSyncable({
      ensureSnykMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createBitriseSyncable({
      ensureBitriseMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createSonarqubeSyncable({
      ensureSonarqubeMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createSemgrepSyncable({
      ensureSemgrepMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createWizSyncable({
      ensureWizMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createLaunchdarklySyncable({
      ensureLaunchdarklyMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createFlagsmithSyncable({
      ensureFlagsmithMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createArgocdSyncable({
      ensureArgocdMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createFluxSyncable({
      ensureFluxMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createDbtSyncable({
      ensureDbtMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createMetabaseSyncable({
      ensureMetabaseMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createSupersetSyncable({
      ensureSupersetMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createDatabricksSyncable({
      ensureDatabricksMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createMlflowSyncable({
      ensureMlflowMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createVercelSyncable({
      ensureVercelMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createNetlifySyncable({
      ensureNetlifyMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createStripeSyncable({
      ensureStripeMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createMercurySyncable({
      ensureMercuryMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createReadwiseSyncable({
      ensureReadwiseMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createRaindropSyncable({
      ensureRaindropMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createIntercomSyncable({
      ensureIntercomMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createZendeskSyncable({
      ensureZendeskMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createLeverSyncable({
      ensureLeverMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createGreenhouseSyncable({
      ensureGreenhouseMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createPipedriveSyncable({
      ensurePipedriveMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createStackOverflowSyncable({
      ensureStackOverflowMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createZoomSyncable({
      ensureZoomMcpRunning: () => connectorMesh.ensureZoomRunning(),
    }),
  );
  syncScheduler.register(
    createZoteroSyncable({
      ensureZoteroMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
  syncScheduler.register(
    createDependencytrackSyncable({
      ensureDependencytrackMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
}
