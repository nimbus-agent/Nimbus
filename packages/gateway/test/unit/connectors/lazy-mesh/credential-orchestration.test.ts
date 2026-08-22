import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  type CredentialSpawners,
  ensureCredentialConnectorsRunning,
} from "../../../../src/connectors/lazy-mesh/credential-orchestration.ts";
import type { MeshSpawnContext } from "../../../../src/connectors/lazy-mesh/slot.ts";
import { createMockVault } from "../../../../src/vault/mock.ts";

const spawnCalls: Array<string> = [];

function makeRecorderSpawners(): CredentialSpawners {
  const make =
    (name: string) =>
    async (_ctx: MeshSpawnContext): Promise<void> => {
      spawnCalls.push(name);
    };
  return {
    ensureAppleMcp: make("apple"),
    ensureBitbucketMcp: make("bitbucket"),
    ensureCircleciMcp: make("circleci"),
    ensureConfluenceMcp: make("confluence"),
    ensureDiscordMcp: make("discord"),
    ensureGithubMcp: make("github"),
    ensureGitlabMcp: make("gitlab"),
    // Returns the ids it registered (F11 fault isolation), unlike its 24 siblings, so it needs
    // its own recorder rather than the void-returning `make`.
    ensureGoogleDriveMcp: async (_ctx: MeshSpawnContext): Promise<readonly string[]> => {
      spawnCalls.push("google-drive");
      return [];
    },
    ensureJenkinsMcp: make("jenkins"),
    ensureJiraMcp: make("jira"),
    ensureKubernetesMcp: make("kubernetes"),
    ensureLinearMcp: make("linear"),
    ensureMicrosoftBundleMcp: make("microsoft"),
    ensureNotionMcp: make("notion"),
    ensureObsidianMcp: make("obsidian"),
    ensurePagerdutyMcp: make("pagerduty"),
    ensurePhase3BundleMcp: make("phase3"),
    ensureSlackMcp: make("slack"),
    ensureZoomMcp: make("zoom"),
    ensureHubspotMcp: make("hubspot"),
    ensureMiroMcp: make("miro"),
    ensureCanvaMcp: make("canva"),
    ensureFigmaMcp: make("figma"),
  };
}

const recorderSpawners: CredentialSpawners = makeRecorderSpawners();

async function runOrchestration(ctx: MeshSpawnContext): Promise<void> {
  await ensureCredentialConnectorsRunning(ctx, recorderSpawners);
}

function makeCtx(): {
  ctx: MeshSpawnContext;
  vault: ReturnType<typeof createMockVault>;
} {
  const vault = createMockVault();
  const ctx: MeshSpawnContext = {
    vault,
    sandboxCwd: "/tmp/nimbus-test-sandbox",
    clearLazyIdle: () => undefined,
    getLazyClient: () => undefined,
    setLazyClient: () => undefined,
    bumpToolsEpoch: () => undefined,
    scheduleLazyDisconnect: () => undefined,
  };
  return { ctx, vault };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

afterEach(() => {
  spawnCalls.length = 0;
});

function expectRanToCompletion(): void {
  const names = spawnCalls.map((c) => c);
  expect(names).toContain("obsidian");
  expect(names).toContain("phase3");
}

describe("ensureCredentialConnectorsRunning — empty vault", () => {
  it("spawns only the unconditional connectors (obsidian + phase3) when vault is empty", async () => {
    const { ctx } = makeCtx();
    await runOrchestration(ctx);
    expect(spawnCalls).toContain("obsidian");
    expect(spawnCalls).toContain("phase3");
    const credGated = [
      "github",
      "gitlab",
      "bitbucket",
      "slack",
      "linear",
      "jira",
      "notion",
      "confluence",
      "discord",
      "jenkins",
      "circleci",
      "pagerduty",
      "kubernetes",
      "google-drive",
      "microsoft",
    ];
    for (const name of credGated) {
      expect(spawnCalls).not.toContain(name);
    }
  });
});

describe("single-secret connectors", () => {
  describe("github — github.pat", () => {
    it("spawns github when github.pat is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("github.pat", "ghp_test");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("github");
    });

    it("does not spawn github when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("github");
    });

    it("does not spawn github when github.pat is empty string", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("github.pat", "");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("github");
    });
  });

  describe("gitlab — gitlab.pat", () => {
    it("spawns gitlab when gitlab.pat is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("gitlab.pat", "glpat_test");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("gitlab");
    });

    it("does not spawn gitlab when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("gitlab");
    });
  });

  describe("linear — linear.api_key", () => {
    it("spawns linear when linear.api_key is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("linear.api_key", "lin_test_key");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("linear");
    });

    it("does not spawn linear when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("linear");
    });
  });

  describe("circleci — circleci.api_token", () => {
    it("spawns circleci when circleci.api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("circleci.api_token", "cci_token");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("circleci");
    });

    it("does not spawn circleci when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("circleci");
    });

    it("does not spawn circleci when api_token is whitespace-only (trim defense)", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("circleci.api_token", "   ");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("circleci");
    });
  });

  describe("pagerduty — pagerduty.api_token", () => {
    it("spawns pagerduty when pagerduty.api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("pagerduty.api_token", "pd_token");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("pagerduty");
    });

    it("does not spawn pagerduty when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("pagerduty");
    });

    it("does not spawn pagerduty when api_token is whitespace-only (trim defense)", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("pagerduty.api_token", "  ");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("pagerduty");
    });
  });

  describe("kubernetes — kubernetes.kubeconfig", () => {
    it("spawns kubernetes when kubernetes.kubeconfig is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("kubernetes.kubeconfig", "/home/u/.kube/config");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("kubernetes");
    });

    it("does not spawn kubernetes when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("kubernetes");
    });

    it("does not spawn kubernetes when kubeconfig is whitespace-only", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("kubernetes.kubeconfig", "   ");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("kubernetes");
    });
  });

  describe("slack — slack.oauth", () => {
    it("spawns slack when slack.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("slack.oauth", "xoxp-token");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("slack");
    });

    it("does not spawn slack when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("slack");
    });
  });

  describe("notion — notion.oauth", () => {
    it("spawns notion when notion.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("notion.oauth", '{"access_token":"raw"}');
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("notion");
    });

    it("does not spawn notion when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("notion");
    });
  });

  describe("hubspot — hubspot.oauth", () => {
    it("spawns hubspot when hubspot.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("hubspot.oauth", '{"accessToken":"a","refreshToken":"r","expiresAt":1}');
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("hubspot");
    });

    it("does not spawn hubspot when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("hubspot");
    });
  });

  describe("miro — miro.oauth", () => {
    it("spawns miro when miro.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("miro.oauth", '{"accessToken":"a","refreshToken":"r","expiresAt":1}');
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("miro");
    });

    it("does not spawn miro when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("miro");
    });
  });

  describe("canva — canva.oauth", () => {
    it("spawns canva when canva.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("canva.oauth", '{"accessToken":"a","refreshToken":"r","expiresAt":1}');
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("canva");
    });

    it("does not spawn canva when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("canva");
    });
  });

  describe("apple — apple.icloud_app_password", () => {
    it("spawns apple when apple.icloud_app_password is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("apple.icloud_app_password", "abcd-efgh-ijkl-mnop");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("apple");
    });

    it("does not spawn apple when vault is empty", async () => {
      const { ctx } = makeCtx();
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("apple");
    });

    it("does not spawn apple when icloud_app_password is empty string", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("apple.icloud_app_password", "");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("apple");
    });
  });
});

describe("multi-secret connectors require ALL keys", () => {
  describe("bitbucket — username + app_password", () => {
    it("does not spawn when only username is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("bitbucket.username", "alice");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("bitbucket");
    });

    it("does not spawn when only app_password is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("bitbucket.app_password", "secret");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("bitbucket");
    });

    it("spawns when both username and app_password are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("bitbucket.username", "alice");
      await vault.set("bitbucket.app_password", "bb_secret");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("bitbucket");
    });
  });

  describe("jira — api_token + email + base_url", () => {
    it("does not spawn when only api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jira.api_token", "jira_tok");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jira");
    });

    it("does not spawn when api_token + email set but no base_url", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jira.api_token", "jira_tok");
      await vault.set("jira.email", "alice@acme.com");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jira");
    });

    it("spawns when all three keys are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jira.api_token", "jira_tok");
      await vault.set("jira.email", "alice@acme.com");
      await vault.set("jira.base_url", "https://acme.atlassian.net");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("jira");
    });
  });

  describe("confluence — api_token + email + base_url", () => {
    it("does not spawn when only api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("confluence.api_token", "conf_tok");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("confluence");
    });

    it("does not spawn when api_token + email set but no base_url", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("confluence.api_token", "conf_tok");
      await vault.set("confluence.email", "alice@acme.com");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("confluence");
    });

    it("spawns when all three keys are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("confluence.api_token", "conf_tok");
      await vault.set("confluence.email", "alice@acme.com");
      await vault.set("confluence.base_url", "https://acme.atlassian.net/wiki");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("confluence");
    });
  });

  describe("figma — oauth + team_id (token + non-secret second key)", () => {
    it("does not spawn when only figma.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("figma.oauth", '{"accessToken":"a","refreshToken":"r","expiresAt":1}');
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("figma");
    });

    it("does not spawn when only figma.team_id is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("figma.team_id", "1234567890");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("figma");
    });

    it("does not spawn when team_id is whitespace-only", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("figma.oauth", '{"accessToken":"a","refreshToken":"r","expiresAt":1}');
      await vault.set("figma.team_id", "   ");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("figma");
    });

    it("spawns when both figma.oauth and figma.team_id are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("figma.oauth", '{"accessToken":"a","refreshToken":"r","expiresAt":1}');
      await vault.set("figma.team_id", "1234567890");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("figma");
    });
  });

  describe("jenkins — base_url + username + api_token", () => {
    it("does not spawn when only base_url is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "https://jenkins.local");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jenkins");
    });

    it("does not spawn when base_url + username set but no api_token", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "https://jenkins.local");
      await vault.set("jenkins.username", "ops");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jenkins");
    });

    it("spawns when all three keys are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "https://jenkins.local");
      await vault.set("jenkins.username", "ops");
      await vault.set("jenkins.api_token", "jenkins_tok");
      await runOrchestration(ctx);
      expect(spawnCalls).toContain("jenkins");
    });

    it("does not spawn when all three keys are whitespace-only", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "  ");
      await vault.set("jenkins.username", "  ");
      await vault.set("jenkins.api_token", "  ");
      await runOrchestration(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jenkins");
    });
  });
});

describe("discord opt-in gate", () => {
  it("does not spawn when neither enabled nor bot_token is set", async () => {
    const { ctx } = makeCtx();
    await runOrchestration(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });

  it("does not spawn when bot_token is set but enabled is not '1'", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.bot_token", "discord_tok");
    await vault.set("discord.enabled", "true");
    await runOrchestration(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });

  it("does not spawn when enabled='1' but bot_token is missing", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.enabled", "1");
    await runOrchestration(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });

  it("spawns when enabled='1' AND bot_token is set", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.enabled", "1");
    await vault.set("discord.bot_token", "discord_tok");
    await runOrchestration(ctx);
    expect(spawnCalls).toContain("discord");
  });

  it("does not spawn when enabled='0' even with bot_token set (explicit opt-out)", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.enabled", "0");
    await vault.set("discord.bot_token", "discord_tok");
    await runOrchestration(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });
});

describe("Google OAuth — anyGoogleOAuthVaultPresent", () => {
  it("does not spawn google-drive when no Google OAuth key is present", async () => {
    const { ctx } = makeCtx();
    await runOrchestration(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("google-drive");
  });

  it("spawns google-drive when any Google OAuth vault key is set", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("google_drive.oauth", '{"access_token":"ya29.test"}');
    await runOrchestration(ctx);
    expect(spawnCalls).toContain("google-drive");
  });
});

describe("Microsoft OAuth — microsoft.oauth", () => {
  it("spawns microsoft bundle when microsoft.oauth is set", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("microsoft.oauth", '{"access_token":"x"}');
    await runOrchestration(ctx);
    expect(spawnCalls).toContain("microsoft");
  });

  it("does not spawn microsoft bundle when microsoft.oauth is not set", async () => {
    const { ctx } = makeCtx();
    await runOrchestration(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("microsoft");
  });
});

describe("multi-connector composite — multiple creds spawn all matching connectors", () => {
  it("spawns github, linear, pagerduty when all three vault keys are set", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("github.pat", "ghp_test");
    await vault.set("linear.api_key", "lin_key");
    await vault.set("pagerduty.api_token", "pd_token");
    await runOrchestration(ctx);
    const sorted = [...spawnCalls].sort((a, b) => a.localeCompare(b));
    expect(sorted).toContain("github");
    expect(sorted).toContain("linear");
    expect(sorted).toContain("pagerduty");
    expect(sorted).toContain("obsidian");
    expect(sorted).toContain("phase3");
  });

  it("unconditional connectors (obsidian + phase3) always appear regardless of vault state", async () => {
    const { ctx } = makeCtx();
    await runOrchestration(ctx);
    expect(spawnCalls).toContain("obsidian");
    expect(spawnCalls).toContain("phase3");
  });
});
