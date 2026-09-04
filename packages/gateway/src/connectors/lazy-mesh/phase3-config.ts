// Phase-3 lazy-mesh spawn configuration.
//
// The 63 `phase3Add<Service>Mcp` functions live in `phase3-<group>.ts` siblings; this file
// keeps the composition root and re-exports them so the spawn surface has one name to import.

import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  phase3AddAthenaMcp,
  phase3AddAwsMcp,
  phase3AddAzureMcp,
  phase3AddBigqueryMcp,
  phase3AddCloudLoggingMcp,
  phase3AddCloudwatchMcp,
  phase3AddGcpMcp,
  phase3AddSagemakerMcp,
  phase3AddVertexAiMcp,
} from "./phase3-cloud.ts";
import {
  phase3AddAirflowMcp,
  phase3AddBigeyeMcp,
  phase3AddDagsterMcp,
  phase3AddDatabricksMcp,
  phase3AddDataprofileMcp,
  phase3AddDbtMcp,
  phase3AddGreatExpectationsMcp,
  phase3AddLocaldbMcp,
  phase3AddLookerMcp,
  phase3AddMetabaseMcp,
  phase3AddMlflowMcp,
  phase3AddMonteCarloMcp,
  phase3AddPowerBiMcp,
  phase3AddPrefectMcp,
  phase3AddSnowflakeMcp,
  phase3AddSupersetMcp,
  phase3AddTableauMcp,
} from "./phase3-data-bi.ts";
import {
  phase3AddArgocdMcp,
  phase3AddBitriseMcp,
  phase3AddCodemagicMcp,
  phase3AddFirebaseMcp,
  phase3AddFlagsmithMcp,
  phase3AddFluxMcp,
  phase3AddIacMcp,
  phase3AddLaunchdarklyMcp,
  phase3AddNetlifyMcp,
  phase3AddStorybookMcp,
  phase3AddTestflightMcp,
  phase3AddVercelMcp,
} from "./phase3-delivery.ts";
import {
  phase3AddDatadogMcp,
  phase3AddElasticsearchMcp,
  phase3AddGrafanaMcp,
  phase3AddNewrelicMcp,
  phase3AddSentryMcp,
} from "./phase3-observability.ts";
import {
  phase3AddDependencytrackMcp,
  phase3AddSemgrepMcp,
  phase3AddSnykMcp,
  phase3AddSonarqubeMcp,
  phase3AddWizMcp,
} from "./phase3-security-quality.ts";
import {
  phase3AddFastmailMcp,
  phase3AddGreenhouseMcp,
  phase3AddImapMcp,
  phase3AddIntercomMcp,
  phase3AddLeverMcp,
  phase3AddMercuryMcp,
  phase3AddPipedriveMcp,
  phase3AddProtonmailMcp,
  phase3AddRaindropMcp,
  phase3AddRampMcp,
  phase3AddReadwiseMcp,
  phase3AddStackoverflowMcp,
  phase3AddStripeMcp,
  phase3AddZendeskMcp,
  phase3AddZoteroMcp,
} from "./phase3-workplace.ts";
import type { ServerSpec } from "./slot.ts";

export {
  phase3AddAirflowMcp,
  phase3AddArgocdMcp,
  phase3AddAthenaMcp,
  phase3AddAwsMcp,
  phase3AddAzureMcp,
  phase3AddBigeyeMcp,
  phase3AddBigqueryMcp,
  phase3AddBitriseMcp,
  phase3AddCloudLoggingMcp,
  phase3AddCloudwatchMcp,
  phase3AddCodemagicMcp,
  phase3AddDagsterMcp,
  phase3AddDatabricksMcp,
  phase3AddDatadogMcp,
  phase3AddDataprofileMcp,
  phase3AddDbtMcp,
  phase3AddDependencytrackMcp,
  phase3AddElasticsearchMcp,
  phase3AddFastmailMcp,
  phase3AddFirebaseMcp,
  phase3AddFlagsmithMcp,
  phase3AddFluxMcp,
  phase3AddGcpMcp,
  phase3AddGrafanaMcp,
  phase3AddGreatExpectationsMcp,
  phase3AddGreenhouseMcp,
  phase3AddIacMcp,
  phase3AddImapMcp,
  phase3AddIntercomMcp,
  phase3AddLaunchdarklyMcp,
  phase3AddLeverMcp,
  phase3AddLocaldbMcp,
  phase3AddLookerMcp,
  phase3AddMercuryMcp,
  phase3AddMetabaseMcp,
  phase3AddMlflowMcp,
  phase3AddMonteCarloMcp,
  phase3AddNetlifyMcp,
  phase3AddNewrelicMcp,
  phase3AddPipedriveMcp,
  phase3AddPowerBiMcp,
  phase3AddPrefectMcp,
  phase3AddProtonmailMcp,
  phase3AddRaindropMcp,
  phase3AddRampMcp,
  phase3AddReadwiseMcp,
  phase3AddSagemakerMcp,
  phase3AddSemgrepMcp,
  phase3AddSentryMcp,
  phase3AddSnowflakeMcp,
  phase3AddSnykMcp,
  phase3AddSonarqubeMcp,
  phase3AddStackoverflowMcp,
  phase3AddStorybookMcp,
  phase3AddStripeMcp,
  phase3AddSupersetMcp,
  phase3AddTableauMcp,
  phase3AddTestflightMcp,
  phase3AddVercelMcp,
  phase3AddVertexAiMcp,
  phase3AddWizMcp,
  phase3AddZendeskMcp,
  phase3AddZoteroMcp,
};

export async function buildPhase3Servers(
  vault: NimbusVault,
  sandboxCwd: string,
): Promise<Record<string, ServerSpec>> {
  const servers: Record<string, ServerSpec> = {};
  await phase3AddAwsMcp(vault, servers, sandboxCwd);
  await phase3AddAzureMcp(vault, servers, sandboxCwd);
  await phase3AddGcpMcp(vault, servers, sandboxCwd);
  await phase3AddBigqueryMcp(vault, servers, sandboxCwd);
  await phase3AddAthenaMcp(vault, servers, sandboxCwd);
  await phase3AddCloudwatchMcp(vault, servers, sandboxCwd);
  await phase3AddSagemakerMcp(vault, servers, sandboxCwd);
  await phase3AddCloudLoggingMcp(vault, servers, sandboxCwd);
  await phase3AddVertexAiMcp(vault, servers, sandboxCwd);
  await phase3AddIacMcp(vault, servers, sandboxCwd);
  await phase3AddGrafanaMcp(vault, servers, sandboxCwd);
  await phase3AddSentryMcp(vault, servers, sandboxCwd);
  await phase3AddNewrelicMcp(vault, servers, sandboxCwd);
  await phase3AddDatadogMcp(vault, servers, sandboxCwd);
  await phase3AddSnykMcp(vault, servers, sandboxCwd);
  await phase3AddBitriseMcp(vault, servers, sandboxCwd);
  await phase3AddCodemagicMcp(vault, servers, sandboxCwd);
  await phase3AddTestflightMcp(vault, servers, sandboxCwd);
  await phase3AddFirebaseMcp(vault, servers, sandboxCwd);
  await phase3AddSonarqubeMcp(vault, servers, sandboxCwd);
  await phase3AddSemgrepMcp(vault, servers, sandboxCwd);
  await phase3AddWizMcp(vault, servers, sandboxCwd);
  await phase3AddLaunchdarklyMcp(vault, servers, sandboxCwd);
  await phase3AddFlagsmithMcp(vault, servers, sandboxCwd);
  await phase3AddArgocdMcp(vault, servers, sandboxCwd);
  await phase3AddFluxMcp(vault, servers, sandboxCwd);
  await phase3AddDbtMcp(vault, servers, sandboxCwd);
  await phase3AddMetabaseMcp(vault, servers, sandboxCwd);
  await phase3AddSnowflakeMcp(vault, servers, sandboxCwd);
  await phase3AddTableauMcp(vault, servers, sandboxCwd);
  await phase3AddLookerMcp(vault, servers, sandboxCwd);
  await phase3AddPowerBiMcp(vault, servers, sandboxCwd);
  await phase3AddSupersetMcp(vault, servers, sandboxCwd);
  await phase3AddDatabricksMcp(vault, servers, sandboxCwd);
  await phase3AddMlflowMcp(vault, servers, sandboxCwd);
  await phase3AddVercelMcp(vault, servers, sandboxCwd);
  await phase3AddNetlifyMcp(vault, servers, sandboxCwd);
  await phase3AddStripeMcp(vault, servers, sandboxCwd);
  await phase3AddMercuryMcp(vault, servers, sandboxCwd);
  await phase3AddReadwiseMcp(vault, servers, sandboxCwd);
  await phase3AddRaindropMcp(vault, servers, sandboxCwd);
  await phase3AddIntercomMcp(vault, servers, sandboxCwd);
  await phase3AddZendeskMcp(vault, servers, sandboxCwd);
  await phase3AddLeverMcp(vault, servers, sandboxCwd);
  await phase3AddGreenhouseMcp(vault, servers, sandboxCwd);
  await phase3AddPipedriveMcp(vault, servers, sandboxCwd);
  await phase3AddStackoverflowMcp(vault, servers, sandboxCwd);
  await phase3AddZoteroMcp(vault, servers, sandboxCwd);
  await phase3AddDependencytrackMcp(vault, servers, sandboxCwd);
  await phase3AddElasticsearchMcp(vault, servers, sandboxCwd);
  await phase3AddAirflowMcp(vault, servers, sandboxCwd);
  await phase3AddPrefectMcp(vault, servers, sandboxCwd);
  await phase3AddDagsterMcp(vault, servers, sandboxCwd);
  await phase3AddRampMcp(vault, servers, sandboxCwd);
  await phase3AddImapMcp(vault, servers, sandboxCwd);
  await phase3AddFastmailMcp(vault, servers, sandboxCwd);
  await phase3AddProtonmailMcp(vault, servers, sandboxCwd);
  await phase3AddLocaldbMcp(vault, servers, sandboxCwd);
  await phase3AddStorybookMcp(vault, servers, sandboxCwd);
  await phase3AddDataprofileMcp(vault, servers, sandboxCwd);
  await phase3AddGreatExpectationsMcp(vault, servers, sandboxCwd);
  await phase3AddMonteCarloMcp(vault, servers, sandboxCwd);
  await phase3AddBigeyeMcp(vault, servers, sandboxCwd);
  return servers;
}
