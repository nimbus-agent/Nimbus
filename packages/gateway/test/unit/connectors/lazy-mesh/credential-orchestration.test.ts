/**
 * Unit tests for credential-orchestration.ts
 *
 * Strategy: mock `connector-spawns.ts` so that each ensureXxxMcp function is
 * replaced with a lightweight spy that records calls. The `anyGoogleOAuthVaultPresent`
 * helper (from `auth/google-access-token.ts`) is also mocked so Google OAuth tests
 * don't need real OAuth JSON payloads.
 *
 * `ensureObsidianMcp` and `ensurePhase3BundleMcp` are called unconditionally by
 * `ensureCredentialConnectorsRunning` — the mocks let us confirm they always fire.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { MeshSpawnContext } from "../../../../src/connectors/lazy-mesh/slot.ts";
import { createMockVault } from "../../../../src/vault/mock.ts";

// ─── Spawn-call recorder ──────────────────────────────────────────────────────

const spawnCalls: Array<string> = [];

// Mock google-access-token so anyGoogleOAuthVaultPresent is fully controllable.
// We set this flag in tests that need Google OAuth to appear present.
let googleOAuthPresent = false;

mock.module("../../../../src/auth/google-access-token.ts", () => ({
  anyGoogleOAuthVaultPresent: async (): Promise<boolean> => googleOAuthPresent,
  // resolveGoogleOAuthVaultKey / getValidGoogleAccessToken are not called by
  // credential-orchestration.ts directly (only ensureGoogleDriveMcp calls them,
  // and that function is replaced by the connector-spawns mock below).
  resolveGoogleOAuthVaultKey: async () => null,
  getValidGoogleAccessToken: async () => "fake-google-token",
}));

// Mock connector-spawns so every ensureXxxMcp is a lightweight recorder.
// The list must exactly match the named exports imported by credential-orchestration.ts.
mock.module("../../../../src/connectors/lazy-mesh/connector-spawns.ts", () => {
  const make =
    (name: string) =>
    async (_ctx: unknown): Promise<void> => {
      spawnCalls.push(name);
    };
  return {
    ensureBitbucketMcp: make("bitbucket"),
    ensureCircleciMcp: make("circleci"),
    ensureConfluenceMcp: make("confluence"),
    ensureDiscordMcp: make("discord"),
    ensureGithubMcp: make("github"),
    ensureGitlabMcp: make("gitlab"),
    ensureGoogleDriveMcp: make("google-drive"),
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
  };
});

// Dynamic import AFTER mock.module — bun:test resolves mocks at import time.
const { ensureCredentialConnectorsRunning } = await import(
  "../../../../src/connectors/lazy-mesh/credential-orchestration.ts"
);

// ─── Context factory ──────────────────────────────────────────────────────────

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

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

beforeEach(() => {
  spawnCalls.length = 0;
  googleOAuthPresent = false;
});

afterEach(() => {
  spawnCalls.length = 0;
  googleOAuthPresent = false;
});

// ─── Completion sentinel ──────────────────────────────────────────────────────

/**
 * `ensureCredentialConnectorsRunning` calls `ensureObsidianMcp` and
 * `ensurePhase3BundleMcp` UNCONDITIONALLY — no vault check guards them.
 * Asserting that both appeared in `spawnCalls` proves the function ran to
 * completion rather than throwing or returning early before any credential
 * check happened.  Call this BEFORE every `.not.toContain()` absence assertion.
 */
function expectRanToCompletion(): void {
  const names = spawnCalls.map((c) => c);
  expect(names).toContain("obsidian");
  expect(names).toContain("phase3");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ensureCredentialConnectorsRunning — empty vault", () => {
  it("spawns only the unconditional connectors (obsidian + phase3) when vault is empty", async () => {
    const { ctx } = makeCtx();
    await ensureCredentialConnectorsRunning(ctx);
    // obsidian and phase3 are always called; all others require vault keys
    expect(spawnCalls).toContain("obsidian");
    expect(spawnCalls).toContain("phase3");
    // credential-gated connectors must NOT fire
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

// ─── Single-secret connectors ─────────────────────────────────────────────────

describe("single-secret connectors", () => {
  describe("github — github.pat", () => {
    it("spawns github when github.pat is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("github.pat", "ghp_test");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("github");
    });

    it("does not spawn github when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("github");
    });

    it("does not spawn github when github.pat is empty string", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("github.pat", "");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("github");
    });
  });

  describe("gitlab — gitlab.pat", () => {
    it("spawns gitlab when gitlab.pat is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("gitlab.pat", "glpat_test");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("gitlab");
    });

    it("does not spawn gitlab when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("gitlab");
    });
  });

  describe("linear — linear.api_key", () => {
    it("spawns linear when linear.api_key is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("linear.api_key", "lin_test_key");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("linear");
    });

    it("does not spawn linear when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("linear");
    });
  });

  describe("circleci — circleci.api_token", () => {
    it("spawns circleci when circleci.api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("circleci.api_token", "cci_token");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("circleci");
    });

    it("does not spawn circleci when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("circleci");
    });

    it("does not spawn circleci when api_token is whitespace-only (trim defense)", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("circleci.api_token", "   ");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("circleci");
    });
  });

  describe("pagerduty — pagerduty.api_token", () => {
    it("spawns pagerduty when pagerduty.api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("pagerduty.api_token", "pd_token");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("pagerduty");
    });

    it("does not spawn pagerduty when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("pagerduty");
    });

    it("does not spawn pagerduty when api_token is whitespace-only (trim defense)", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("pagerduty.api_token", "  ");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("pagerduty");
    });
  });

  describe("kubernetes — kubernetes.kubeconfig", () => {
    it("spawns kubernetes when kubernetes.kubeconfig is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("kubernetes.kubeconfig", "/home/u/.kube/config");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("kubernetes");
    });

    it("does not spawn kubernetes when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("kubernetes");
    });

    it("does not spawn kubernetes when kubeconfig is whitespace-only", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("kubernetes.kubeconfig", "   ");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("kubernetes");
    });
  });

  describe("slack — slack.oauth", () => {
    it("spawns slack when slack.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("slack.oauth", "xoxp-token");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("slack");
    });

    it("does not spawn slack when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("slack");
    });
  });

  describe("notion — notion.oauth", () => {
    it("spawns notion when notion.oauth is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("notion.oauth", '{"access_token":"raw"}');
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("notion");
    });

    it("does not spawn notion when vault is empty", async () => {
      const { ctx } = makeCtx();
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("notion");
    });
  });
});

// ─── Multi-secret AND-logic connectors ───────────────────────────────────────

describe("multi-secret connectors require ALL keys", () => {
  describe("bitbucket — username + app_password", () => {
    it("does not spawn when only username is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("bitbucket.username", "alice");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("bitbucket");
    });

    it("does not spawn when only app_password is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("bitbucket.app_password", "secret");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("bitbucket");
    });

    it("spawns when both username and app_password are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("bitbucket.username", "alice");
      await vault.set("bitbucket.app_password", "bb_secret");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("bitbucket");
    });
  });

  describe("jira — api_token + email + base_url", () => {
    it("does not spawn when only api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jira.api_token", "jira_tok");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jira");
    });

    it("does not spawn when api_token + email set but no base_url", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jira.api_token", "jira_tok");
      await vault.set("jira.email", "alice@acme.com");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jira");
    });

    it("spawns when all three keys are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jira.api_token", "jira_tok");
      await vault.set("jira.email", "alice@acme.com");
      await vault.set("jira.base_url", "https://acme.atlassian.net");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("jira");
    });
  });

  describe("confluence — api_token + email + base_url", () => {
    it("does not spawn when only api_token is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("confluence.api_token", "conf_tok");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("confluence");
    });

    it("does not spawn when api_token + email set but no base_url", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("confluence.api_token", "conf_tok");
      await vault.set("confluence.email", "alice@acme.com");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("confluence");
    });

    it("spawns when all three keys are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("confluence.api_token", "conf_tok");
      await vault.set("confluence.email", "alice@acme.com");
      await vault.set("confluence.base_url", "https://acme.atlassian.net/wiki");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("confluence");
    });
  });

  describe("jenkins — base_url + username + api_token", () => {
    it("does not spawn when only base_url is set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "https://jenkins.local");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jenkins");
    });

    it("does not spawn when base_url + username set but no api_token", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "https://jenkins.local");
      await vault.set("jenkins.username", "ops");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jenkins");
    });

    it("spawns when all three keys are set", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "https://jenkins.local");
      await vault.set("jenkins.username", "ops");
      await vault.set("jenkins.api_token", "jenkins_tok");
      await ensureCredentialConnectorsRunning(ctx);
      expect(spawnCalls).toContain("jenkins");
    });

    it("does not spawn when all three keys are whitespace-only", async () => {
      const { ctx, vault } = makeCtx();
      await vault.set("jenkins.base_url", "  ");
      await vault.set("jenkins.username", "  ");
      await vault.set("jenkins.api_token", "  ");
      await ensureCredentialConnectorsRunning(ctx);
      expectRanToCompletion();
      expect(spawnCalls).not.toContain("jenkins");
    });
  });
});

// ─── Discord opt-in ───────────────────────────────────────────────────────────

describe("discord opt-in gate", () => {
  it("does not spawn when neither enabled nor bot_token is set", async () => {
    const { ctx } = makeCtx();
    await ensureCredentialConnectorsRunning(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });

  it("does not spawn when bot_token is set but enabled is not '1'", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.bot_token", "discord_tok");
    await vault.set("discord.enabled", "true"); // any value other than "1"
    await ensureCredentialConnectorsRunning(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });

  it("does not spawn when enabled='1' but bot_token is missing", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.enabled", "1");
    await ensureCredentialConnectorsRunning(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });

  it("spawns when enabled='1' AND bot_token is set", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.enabled", "1");
    await vault.set("discord.bot_token", "discord_tok");
    await ensureCredentialConnectorsRunning(ctx);
    expect(spawnCalls).toContain("discord");
  });

  it("does not spawn when enabled='0' even with bot_token set (explicit opt-out)", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.enabled", "0");
    await vault.set("discord.bot_token", "discord_tok");
    await ensureCredentialConnectorsRunning(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("discord");
  });
});

// ─── Google OAuth fan-out ─────────────────────────────────────────────────────

describe("Google OAuth — anyGoogleOAuthVaultPresent", () => {
  it("does not spawn google-drive when no Google OAuth key is present", async () => {
    googleOAuthPresent = false;
    const { ctx } = makeCtx();
    await ensureCredentialConnectorsRunning(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("google-drive");
  });

  it("spawns google-drive when anyGoogleOAuthVaultPresent returns true", async () => {
    googleOAuthPresent = true;
    const { ctx } = makeCtx();
    await ensureCredentialConnectorsRunning(ctx);
    expect(spawnCalls).toContain("google-drive");
  });
});

// ─── Microsoft OAuth ─────────────────────────────────────────────────────────

describe("Microsoft OAuth — microsoft.oauth", () => {
  it("spawns microsoft bundle when microsoft.oauth is set", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("microsoft.oauth", '{"access_token":"x"}');
    await ensureCredentialConnectorsRunning(ctx);
    expect(spawnCalls).toContain("microsoft");
  });

  it("does not spawn microsoft bundle when microsoft.oauth is not set", async () => {
    const { ctx } = makeCtx();
    await ensureCredentialConnectorsRunning(ctx);
    expectRanToCompletion();
    expect(spawnCalls).not.toContain("microsoft");
  });
});

// ─── Multi-connector composite ───────────────────────────────────────────────

describe("multi-connector composite — multiple creds spawn all matching connectors", () => {
  it("spawns github, linear, pagerduty when all three vault keys are set", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("github.pat", "ghp_test");
    await vault.set("linear.api_key", "lin_key");
    await vault.set("pagerduty.api_token", "pd_token");
    await ensureCredentialConnectorsRunning(ctx);
    const sorted = [...spawnCalls].sort();
    expect(sorted).toContain("github");
    expect(sorted).toContain("linear");
    expect(sorted).toContain("pagerduty");
    // obsidian + phase3 also always fire
    expect(sorted).toContain("obsidian");
    expect(sorted).toContain("phase3");
  });

  it("unconditional connectors (obsidian + phase3) always appear regardless of vault state", async () => {
    const { ctx } = makeCtx();
    await ensureCredentialConnectorsRunning(ctx);
    expect(spawnCalls).toContain("obsidian");
    expect(spawnCalls).toContain("phase3");
  });
});
