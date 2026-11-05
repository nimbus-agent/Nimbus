import { anyGoogleOAuthVaultPresent } from "../../auth/google-access-token.ts";
import type { ConnectorServiceId } from "../connector-catalog.ts";
import {
  type ConnectorSecretKeyOf,
  readConnectorSecret,
  type SharedOAuthProvider,
  sharedOAuthKey,
} from "../connector-vault.ts";
import * as defaultSpawners from "./connector-spawns.ts";
import { isServiceCredentialConfigured } from "./service-credential.ts";
import type { MeshSpawnContext } from "./slot.ts";

export type CredentialSpawners = {
  readonly ensureAppleMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureBitbucketMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureCircleciMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureConfluenceMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureDiscordMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureGithubMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureGitlabMcp: (ctx: MeshSpawnContext) => Promise<void>;
  /**
   * Resolves to the connectors it registered, unlike its 24 siblings. The value is dropped by
   * every caller here; it exists so a test can observe WHICH Google connectors survived a bad
   * credential without reading an `MCPClient` internal that another test file mocks away.
   */
  readonly ensureGoogleDriveMcp: (ctx: MeshSpawnContext) => Promise<readonly string[]>;
  readonly ensureJenkinsMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureJiraMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureKubernetesMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureLinearMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureMicrosoftBundleMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureNotionMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureMendeleyMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureWorkdayMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureObsidianMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensurePagerdutyMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensurePhase3BundleMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureSlackMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureZoomMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureHubspotMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureMiroMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureCanvaMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureFigmaMcp: (ctx: MeshSpawnContext) => Promise<void>;
  readonly ensureSalesforceMcp: (ctx: MeshSpawnContext) => Promise<void>;
};

async function ensureIfConnectorSecretSet<S extends ConnectorServiceId>(
  ctx: MeshSpawnContext,
  serviceId: S,
  keyName: ConnectorSecretKeyOf<S>,
  run: () => Promise<void>,
): Promise<void> {
  const v = await readConnectorSecret(ctx.vault, serviceId, keyName);
  if (v !== null && v !== "") {
    await run();
  }
}

async function ensureIfProviderOAuthSet(
  ctx: MeshSpawnContext,
  provider: SharedOAuthProvider,
  run: () => Promise<void>,
): Promise<void> {
  const v = await ctx.vault.get(sharedOAuthKey(provider));
  if (v !== null && v !== "") {
    await run();
  }
}

async function ensureIfGoogleOAuthPresent(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners,
): Promise<void> {
  if (await anyGoogleOAuthVaultPresent(ctx.vault)) {
    await spawners.ensureGoogleDriveMcp(ctx);
  }
}

async function ensureBitbucketIfVaultCreds(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners,
): Promise<void> {
  const bbUser = await readConnectorSecret(ctx.vault, "bitbucket", "username");
  const bbPass = await readConnectorSecret(ctx.vault, "bitbucket", "app_password");
  if (bbUser !== null && bbUser !== "" && bbPass !== null && bbPass !== "") {
    await spawners.ensureBitbucketMcp(ctx);
  }
}

/**
 * Runs `run` when `service`'s own credential is stored: the same no-network predicate the
 * connector-write listing asks before it ensures a slot ({@link isServiceCredentialConfigured}).
 */
async function ensureIfServiceConfigured(
  ctx: MeshSpawnContext,
  service: string,
  run: () => Promise<void>,
): Promise<void> {
  if (await isServiceCredentialConfigured(ctx.vault, service, ctx)) {
    await run();
  }
}

async function ensureJenkinsIfVaultCreds(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners,
): Promise<void> {
  const jb = await readConnectorSecret(ctx.vault, "jenkins", "base_url");
  const ju = await readConnectorSecret(ctx.vault, "jenkins", "username");
  const jt = await readConnectorSecret(ctx.vault, "jenkins", "api_token");
  if (
    jb !== null &&
    jb.trim() !== "" &&
    ju !== null &&
    ju.trim() !== "" &&
    jt !== null &&
    jt.trim() !== ""
  ) {
    await spawners.ensureJenkinsMcp(ctx);
  }
}

async function ensureCircleciIfVaultCreds(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners,
): Promise<void> {
  const t = await readConnectorSecret(ctx.vault, "circleci", "api_token");
  if (t !== null && t.trim() !== "") {
    await spawners.ensureCircleciMcp(ctx);
  }
}

async function ensurePagerdutyIfVaultCreds(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners,
): Promise<void> {
  const t = await readConnectorSecret(ctx.vault, "pagerduty", "api_token");
  if (t !== null && t.trim() !== "") {
    await spawners.ensurePagerdutyMcp(ctx);
  }
}

async function ensureKubernetesIfVaultCreds(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners,
): Promise<void> {
  const k = await readConnectorSecret(ctx.vault, "kubernetes", "kubeconfig");
  if (k !== null && k.trim() !== "") {
    await spawners.ensureKubernetesMcp(ctx);
  }
}

async function ensureFigmaIfVaultCreds(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners,
): Promise<void> {
  // Figma needs BOTH the OAuth token and the non-secret team id (mirrors the
  // Stack Overflow token + team second-key pattern).
  const oauth = await readConnectorSecret(ctx.vault, "figma", "oauth");
  const teamId = await readConnectorSecret(ctx.vault, "figma", "team_id");
  if (oauth !== null && oauth !== "" && teamId !== null && teamId.trim() !== "") {
    await spawners.ensureFigmaMcp(ctx);
  }
}

export async function ensureCredentialConnectorsRunning(
  ctx: MeshSpawnContext,
  spawners: CredentialSpawners = defaultSpawners,
): Promise<void> {
  await ensureIfGoogleOAuthPresent(ctx, spawners);
  await ensureIfProviderOAuthSet(ctx, "microsoft", () => spawners.ensureMicrosoftBundleMcp(ctx));
  await ensureIfServiceConfigured(ctx, "github", () => spawners.ensureGithubMcp(ctx));
  await ensureIfServiceConfigured(ctx, "gitlab", () => spawners.ensureGitlabMcp(ctx));
  await ensureBitbucketIfVaultCreds(ctx, spawners);
  await ensureIfServiceConfigured(ctx, "slack", () => spawners.ensureSlackMcp(ctx));
  await ensureIfServiceConfigured(ctx, "linear", () => spawners.ensureLinearMcp(ctx));
  await ensureIfServiceConfigured(ctx, "jira", () => spawners.ensureJiraMcp(ctx));
  await ensureIfServiceConfigured(ctx, "notion", () => spawners.ensureNotionMcp(ctx));
  await ensureIfConnectorSecretSet(ctx, "mendeley", "oauth", () => spawners.ensureMendeleyMcp(ctx));
  await ensureIfConnectorSecretSet(ctx, "workday", "oauth", () => spawners.ensureWorkdayMcp(ctx));
  await ensureIfConnectorSecretSet(ctx, "apple", "icloud_app_password", () =>
    spawners.ensureAppleMcp(ctx),
  );
  await ensureIfConnectorSecretSet(ctx, "zoom", "oauth", () => spawners.ensureZoomMcp(ctx));
  await ensureIfConnectorSecretSet(ctx, "hubspot", "oauth", () => spawners.ensureHubspotMcp(ctx));
  await ensureIfConnectorSecretSet(ctx, "miro", "oauth", () => spawners.ensureMiroMcp(ctx));
  await ensureIfConnectorSecretSet(ctx, "canva", "oauth", () => spawners.ensureCanvaMcp(ctx));
  await ensureFigmaIfVaultCreds(ctx, spawners);
  await ensureIfConnectorSecretSet(ctx, "salesforce", "oauth", () =>
    spawners.ensureSalesforceMcp(ctx),
  );
  await ensureIfServiceConfigured(ctx, "confluence", () => spawners.ensureConfluenceMcp(ctx));
  await ensureIfServiceConfigured(ctx, "discord", () => spawners.ensureDiscordMcp(ctx));
  await ensureJenkinsIfVaultCreds(ctx, spawners);
  await ensureCircleciIfVaultCreds(ctx, spawners);
  await ensurePagerdutyIfVaultCreds(ctx, spawners);
  await ensureKubernetesIfVaultCreds(ctx, spawners);
  await spawners.ensureObsidianMcp(ctx);
  await spawners.ensurePhase3BundleMcp(ctx);
}
