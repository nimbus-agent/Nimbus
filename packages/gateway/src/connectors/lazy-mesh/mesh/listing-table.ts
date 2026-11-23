import type { NimbusVault } from "../../../vault/nimbus-vault.ts";
import { LAZY_MESH } from "../keys.ts";
import {
  phase3AddArgocdMcp,
  phase3AddAwsMcp,
  phase3AddAzureMcp,
  phase3AddBigeyeMcp,
  phase3AddBitriseMcp,
  phase3AddCodemagicMcp,
  phase3AddFirebaseMcp,
  phase3AddFlagsmithMcp,
  phase3AddFluxMcp,
  phase3AddGcpMcp,
  phase3AddIacMcp,
  phase3AddLaunchdarklyMcp,
  phase3AddLookerMcp,
  phase3AddMlflowMcp,
  phase3AddMonteCarloMcp,
  phase3AddNetlifyMcp,
  phase3AddPowerBiMcp,
  phase3AddSnowflakeMcp,
  phase3AddTableauMcp,
  phase3AddTestflightMcp,
  phase3AddVantageMcp,
  phase3AddVercelMcp,
} from "../phase3-config.ts";
import { isServiceCredentialConfigured } from "../service-credential.ts";
import type { MeshSpawnContext, ServerSpec } from "../slot.ts";
import type { MeshEnsureRunners } from "./ensure-runners.ts";

type Phase3ServerAdder = (
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
) => Promise<void>;

/**
 * The phase-3 bundle services, each with the SPAWNER's own credential check: the `phase3Add*`
 * function registers the server only when the service's own vault secrets are present.
 */
const PHASE3_LISTING_ADDERS: Readonly<Record<string, Phase3ServerAdder>> = {
  snowflake: phase3AddSnowflakeMcp,
  tableau: phase3AddTableauMcp,
  looker: phase3AddLookerMcp,
  powerbi: phase3AddPowerBiMcp,
  montecarlo: phase3AddMonteCarloMcp,
  bigeye: phase3AddBigeyeMcp,
  vantage: phase3AddVantageMcp,
  argocd: phase3AddArgocdMcp,
  flux: phase3AddFluxMcp,
  launchdarkly: phase3AddLaunchdarklyMcp,
  flagsmith: phase3AddFlagsmithMcp,
  mlflow: phase3AddMlflowMcp,
  aws: phase3AddAwsMcp,
  azure: phase3AddAzureMcp,
  gcp: phase3AddGcpMcp,
  // D2: the iac server, LISTED in its no-network bundle slot so the model door can read the write
  // and prepare tools' schemas; the plan, show, apply and CloudFormation children run in their own
  // per-call profiles, never in this slot.
  iac: phase3AddIacMcp,
  // D3b: the deploy triggers and mobile release. Each adder is the SPAWNER's own credential check
  // (a token, or the TestFlight key trio, or the Firebase service account and app ids).
  vercel: phase3AddVercelMcp,
  netlify: phase3AddNetlifyMcp,
  bitrise: phase3AddBitriseMcp,
  codemagic: phase3AddCodemagicMcp,
  testflight: phase3AddTestflightMcp,
  firebase: phase3AddFirebaseMcp,
};

/**
 * The per-service slots (the name is historical: it began as the wave-2 services; C1 added
 * `onedrive` and `pagerduty`, and D1 `bitbucket`, `jenkins`, `circleci` and `github_actions`): the slot each one's server runs in and the mesh method that ensures
 * exactly that slot, in ONE row so the two cannot drift. Their credential check is
 * {@link isServiceCredentialConfigured} (per SERVICE, never per slot: the Google and Microsoft
 * bundles host siblings).
 */
const WAVE2_LISTING: Readonly<
  Record<string, { readonly slot: string; readonly ensure: keyof MeshEnsureRunners }>
> = {
  gmail: { slot: LAZY_MESH.googleBundle, ensure: "ensureGoogleDriveRunning" },
  google_drive: { slot: LAZY_MESH.googleBundle, ensure: "ensureGoogleDriveRunning" },
  outlook: { slot: LAZY_MESH.microsoftBundle, ensure: "ensureMicrosoftBundleRunning" },
  teams: { slot: LAZY_MESH.microsoftBundle, ensure: "ensureMicrosoftBundleRunning" },
  onedrive: { slot: LAZY_MESH.microsoftBundle, ensure: "ensureMicrosoftBundleRunning" },
  pagerduty: { slot: LAZY_MESH.pagerduty, ensure: "ensurePagerdutyRunning" },
  github: { slot: LAZY_MESH.github, ensure: "ensureGithubRunning" },
  gitlab: { slot: LAZY_MESH.gitlab, ensure: "ensureGitlabRunning" },
  // GitHub Actions is a second server in the github client: the same slot, the same PAT.
  github_actions: { slot: LAZY_MESH.github, ensure: "ensureGithubRunning" },
  bitbucket: { slot: LAZY_MESH.bitbucket, ensure: "ensureBitbucketRunning" },
  jenkins: { slot: LAZY_MESH.jenkins, ensure: "ensureJenkinsRunning" },
  circleci: { slot: LAZY_MESH.circleci, ensure: "ensureCircleciRunning" },
  slack: { slot: LAZY_MESH.slack, ensure: "ensureSlackRunning" },
  linear: { slot: LAZY_MESH.linear, ensure: "ensureLinearRunning" },
  jira: { slot: LAZY_MESH.jira, ensure: "ensureJiraRunning" },
  notion: { slot: LAZY_MESH.notion, ensure: "ensureNotionRunning" },
  confluence: { slot: LAZY_MESH.confluence, ensure: "ensureConfluenceRunning" },
  discord: { slot: LAZY_MESH.discord, ensure: "ensureDiscordRunning" },
  apple: { slot: LAZY_MESH.apple, ensure: "ensureAppleRunning" },
  obsidian: { slot: LAZY_MESH.obsidian, ensure: "ensureObsidianRunning" },
  // D3a: the listing slot (no network) only LISTS the nine k8s tools; the runner executes them.
  kubernetes: { slot: LAZY_MESH.kubernetes, ensure: "ensureKubernetesRunning" },
};

/** One {@link LazyConnectorMesh.listFirstPartyServerTools} entry: its slot, credential and ensure. */
export interface FirstPartyListingEntry {
  readonly slot: string;
  /** The SERVICE's own credential is stored. Reads the Vault/context only: no refresh, no network. */
  configured(): Promise<boolean>;
  /** Ensures exactly {@link slot}; never another slot. */
  ensure(): Promise<void>;
}

/**
 * The explicit listing map: the 15 phase-3 services on the phase-3 bundle (the 11 of C1 plus aws, azure and gcp, and iac for D2) (today's spawner probe)
 * and each per-service-slot service (`WAVE2_LISTING`) on its own slot. Each `ensure` calls the mesh's own `ensure*Running`
 * method at call time (a test seam), and names exactly that service's slot.
 */
export function buildFirstPartyListing(
  vault: NimbusVault,
  spawnContext: MeshSpawnContext,
  mesh: MeshEnsureRunners,
): Readonly<Record<string, FirstPartyListingEntry>> {
  const out: Record<string, FirstPartyListingEntry> = {};
  for (const [service, adder] of Object.entries(PHASE3_LISTING_ADDERS)) {
    out[service] = {
      slot: LAZY_MESH.phase3Bundle,
      configured: async () => {
        const probe: Record<string, ServerSpec> = {};
        await adder(vault, probe, spawnContext.sandboxCwd);
        return Object.hasOwn(probe, service);
      },
      ensure: () => mesh.ensurePhase3BundleRunning(),
    };
  }
  for (const [service, row] of Object.entries(WAVE2_LISTING)) {
    out[service] = {
      slot: row.slot,
      configured: () => isServiceCredentialConfigured(vault, service, spawnContext),
      // Looked up at call time (a test seam), not captured.
      ensure: () => (mesh[row.ensure] as () => Promise<void>)(),
    };
  }
  return out;
}
