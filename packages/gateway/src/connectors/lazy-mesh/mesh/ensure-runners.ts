import { readConnectorSecret } from "../../connector-vault.ts";
import { resolveGithubBase } from "../../github-api-base.ts";
import {
  ensureAppleMcp,
  ensureBitbucketMcp,
  ensureCanvaMcp,
  ensureCircleciMcp,
  ensureConfluenceMcp,
  ensureDiscordMcp,
  ensureFigmaMcp,
  ensureGithubMcp,
  ensureGitlabMcp,
  ensureGoogleDriveMcp,
  ensureHubspotMcp,
  ensureJenkinsMcp,
  ensureJiraMcp,
  ensureKubernetesMcp,
  ensureLinearMcp,
  ensureMendeleyMcp,
  ensureMicrosoftBundleMcp,
  ensureMiroMcp,
  ensureNotionMcp,
  ensureObsidianMcp,
  ensurePagerdutyMcp,
  ensurePhase3BundleMcp,
  ensureSalesforceMcp,
  ensureSlackMcp,
  ensureWorkdayMcp,
  ensureZoomMcp,
} from "../connector-spawns.ts";
import { LAZY_MESH } from "../keys.ts";
import type { MeshSpawnContext } from "../slot.ts";
import { MeshCore } from "./core.ts";

/**
 * The second layer of the mesh's class chain: the per-service `ensure*Running` delegators (each one
 * hands the spawn context to its spawner in `connector-spawns.ts`) and the credential-change
 * restarts of the PagerDuty, Jira and GitHub children. Moved verbatim out of `mesh.ts`.
 */
export abstract class MeshEnsureRunners extends MeshCore {
  protected abstract readonly spawnContext: MeshSpawnContext;
  /** The GitHub Enterprise Server host the GitHub child was (or will next be) started with. */
  private githubInstanceHost: string | null = null;
  /** Bumped by every spawn record, so an older {@link primeGithubInstance} read cannot overwrite it. */
  private githubInstanceSeq = 0;

  async ensurePhase3BundleRunning(): Promise<void> {
    return ensurePhase3BundleMcp(this.spawnContext);
  }

  async ensureGoogleDriveRunning(): Promise<void> {
    // The value is deliberately dropped here. `ensureGoogleDriveMcp` reports which connectors
    // it registered so a test can observe fault isolation without reaching into `MCPClient`;
    // the MESH delegator's contract is "make it running", shared with eight sibling methods
    // that all resolve to nothing, and widening one of them would be noise at every call site.
    await ensureGoogleDriveMcp(this.spawnContext);
  }

  async ensureMicrosoftBundleRunning(): Promise<void> {
    return ensureMicrosoftBundleMcp(this.spawnContext);
  }

  async ensureGithubRunning(): Promise<void> {
    return ensureGithubMcp(this.spawnContext);
  }

  async ensureGitlabRunning(): Promise<void> {
    return ensureGitlabMcp(this.spawnContext);
  }

  async ensureBitbucketRunning(): Promise<void> {
    return ensureBitbucketMcp(this.spawnContext);
  }

  async ensureSlackRunning(): Promise<void> {
    return ensureSlackMcp(this.spawnContext);
  }

  async ensureLinearRunning(): Promise<void> {
    return ensureLinearMcp(this.spawnContext);
  }

  async ensureJiraRunning(): Promise<void> {
    return ensureJiraMcp(this.spawnContext);
  }

  async ensureNotionRunning(): Promise<void> {
    return ensureNotionMcp(this.spawnContext);
  }

  async ensureMendeleyRunning(): Promise<void> {
    return ensureMendeleyMcp(this.spawnContext);
  }

  async ensureWorkdayRunning(): Promise<void> {
    return ensureWorkdayMcp(this.spawnContext);
  }

  async ensureAppleRunning(): Promise<void> {
    return ensureAppleMcp(this.spawnContext);
  }

  async ensureObsidianRunning(): Promise<void> {
    return ensureObsidianMcp(this.spawnContext);
  }

  /**
   * Retire the PagerDuty child so the next use respawns it with the credentials now in the Vault
   * (`PAGERDUTY_API_TOKEN` and `PAGERDUTY_FROM_EMAIL` are read at spawn only). Bumps the slot
   * generation, so a model write offered before the change refuses "ask again". Never rejects; an
   * in-flight call finishes on the old child first (the detach drain).
   */
  restartPagerduty(): void {
    void this.detachLazyClient(LAZY_MESH.pagerduty);
  }

  /**
   * Retire the Jira child so the next use respawns it with the credentials now in the Vault
   * (`JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_BASE_URL` and `JIRA_CLOUD_ID` are read at spawn only).
   * Called after EVERY successful `connector.auth jira`. Same contract as
   * {@link LazyConnectorMesh.restartPagerduty}.
   */
  restartJira(): void {
    void this.detachLazyClient(LAZY_MESH.jira);
  }

  /**
   * Called after EVERY `connector.auth github`, successful or not past validation. The child reads
   * `GITHUB_PAT` and `GITHUB_API_BASE_URL` at spawn only, so a changed PAT or a changed (or
   * removed) GitHub Enterprise Server base would otherwise keep serving the old credential and host
   * until an idle disconnect. Both children (`github`, `github_actions`) share this one slot.
   * Same contract as {@link LazyConnectorMesh.restartPagerduty}.
   */
  restartGithub(): void {
    void this.detachLazyClient(LAZY_MESH.github);
    // The next spawn reads the Vault again; show the same instance until then.
    void this.primeGithubInstance();
  }

  /** The GitHub Enterprise Server host[:port] the consent preview names; undefined for github.com. */
  githubInstance(): string | undefined {
    return this.githubInstanceHost ?? undefined;
  }

  /** Called by the GitHub spawn with the host it started the child with (`null`: github.com). */
  recordGithubInstance(host: string | null): void {
    this.githubInstanceSeq += 1;
    this.githubInstanceHost = host;
  }

  /**
   * Reads `github.api_base` once and snapshots its host, so a write previewed BEFORE the lazy child
   * first spawns still names the instance. A spawn's own record (above) wins over an older read that
   * finishes later; a read or validation failure shows no instance (never a raw value). Never rejects.
   */
  async primeGithubInstance(): Promise<void> {
    const seq = this.githubInstanceSeq;
    let host: string | null = null;
    try {
      const resolved = resolveGithubBase(
        await readConnectorSecret(this.vault, "github", "api_base"),
      );
      host = resolved.ok ? resolved.host : null;
    } catch {
      host = null;
    }
    if (seq === this.githubInstanceSeq) this.githubInstanceHost = host;
  }

  async ensureConfluenceRunning(): Promise<void> {
    return ensureConfluenceMcp(this.spawnContext);
  }

  async ensureDiscordRunning(): Promise<void> {
    return ensureDiscordMcp(this.spawnContext);
  }

  async ensureJenkinsRunning(): Promise<void> {
    return ensureJenkinsMcp(this.spawnContext);
  }

  async ensureCircleciRunning(): Promise<void> {
    return ensureCircleciMcp(this.spawnContext);
  }

  async ensurePagerdutyRunning(): Promise<void> {
    return ensurePagerdutyMcp(this.spawnContext);
  }

  async ensureKubernetesRunning(): Promise<void> {
    return ensureKubernetesMcp(this.spawnContext);
  }

  async ensureZoomRunning(): Promise<void> {
    return ensureZoomMcp(this.spawnContext);
  }

  async ensureHubspotRunning(): Promise<void> {
    return ensureHubspotMcp(this.spawnContext);
  }

  async ensureMiroRunning(): Promise<void> {
    return ensureMiroMcp(this.spawnContext);
  }

  async ensureCanvaRunning(): Promise<void> {
    return ensureCanvaMcp(this.spawnContext);
  }

  async ensureFigmaRunning(): Promise<void> {
    return ensureFigmaMcp(this.spawnContext);
  }

  async ensureSalesforceRunning(): Promise<void> {
    return ensureSalesforceMcp(this.spawnContext);
  }
}
