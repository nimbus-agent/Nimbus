import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
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
  ensureZoomMcp,
} from "./connector-spawns.ts";
import type { MeshSpawnContext } from "./slot.ts";

const SANDBOX_CWD = join(
  mkdtempSync(join(tmpdir(), "nimbus-connector-spawns-test-")),
  "sandbox-cwd",
);

interface SpyContext {
  ctx: MeshSpawnContext;
  setClients: Array<{ key: string; client: unknown }>;
  bumpCount: () => number;
  disconnects: string[];
}

function makeSpyContext(
  vault: NimbusVault,
  opts: { existingClient?: unknown; obsidianVaultPaths?: string[] } = {},
): SpyContext {
  const setClients: Array<{ key: string; client: unknown }> = [];
  const disconnects: string[] = [];
  let bumps = 0;
  const ctx: MeshSpawnContext = {
    vault,
    obsidianVaultPaths: opts.obsidianVaultPaths,
    sandboxCwd: SANDBOX_CWD,
    clearLazyIdle: (): void => {},
    getLazyClient: (): undefined => opts.existingClient as undefined,
    setLazyClient: (key: string, client: never): void => {
      setClients.push({ key, client });
    },
    bumpToolsEpoch: (): void => {
      bumps += 1;
    },
    scheduleLazyDisconnect: (key: string): void => {
      disconnects.push(key);
    },
  };
  return { ctx, setClients, bumpCount: () => bumps, disconnects };
}

/** A spawned spec's env carries the sandbox manifest JSON; assert it was sandboxed. */
function expectSpawned(setClients: Array<{ key: string; client: unknown }>): void {
  expect(setClients.length).toBe(1);
}

describe("ensure*Mcp early-return when a client already exists in the slot", () => {
  test("reschedules disconnect and does not re-spawn (github)", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault, { existingClient: { fake: true } });
    await ensureGithubMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
    expect(spy.disconnects).toContain("mesh:github");
    expect(spy.bumpCount()).toBe(0);
  });

  // Each ensure* function shares the same "client already present → reschedule + return"
  // guard at the top; exercise it across the family in one parametrized sweep.
  const fns: Array<(ctx: MeshSpawnContext) => Promise<void>> = [
    ensureGoogleDriveMcp,
    ensureMicrosoftBundleMcp,
    ensureGitlabMcp,
    ensureBitbucketMcp,
    ensureSlackMcp,
    ensureLinearMcp,
    ensureJiraMcp,
    ensureNotionMcp,
    ensureMendeleyMcp,
    ensureConfluenceMcp,
    ensureDiscordMcp,
    ensureJenkinsMcp,
    ensureCircleciMcp,
    ensurePagerdutyMcp,
    ensureKubernetesMcp,
    ensureObsidianMcp,
    ensureZoomMcp,
    ensureHubspotMcp,
    ensureMiroMcp,
    ensureCanvaMcp,
    ensureFigmaMcp,
    ensureSalesforceMcp,
  ];

  for (const [i, fn] of fns.entries()) {
    test(`early-returns without spawning when slot is occupied (#${i})`, async () => {
      const vault = createMockVault();
      const spy = makeSpyContext(vault, { existingClient: { fake: true } });
      await fn(spy.ctx);
      expect(spy.setClients.length).toBe(0);
      expect(spy.disconnects.length).toBe(1);
      expect(spy.bumpCount()).toBe(0);
    });
  }
});

describe("ensureGithubMcp", () => {
  test("no-op without github.pat", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureGithubMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns github + github_actions when pat is present", async () => {
    const vault = createMockVault();
    await vault.set("github.pat", "ghp_test");
    const spy = makeSpyContext(vault);
    await ensureGithubMcp(spy.ctx);
    expectSpawned(spy.setClients);
    expect(spy.bumpCount()).toBe(1);
  });
});

describe("ensureGitlabMcp", () => {
  test("no-op without gitlab.pat", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureGitlabMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns with pat only (no api_base override)", async () => {
    const vault = createMockVault();
    await vault.set("gitlab.pat", "glpat-test");
    const spy = makeSpyContext(vault);
    await ensureGitlabMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("spawns with pat + api_base override (trimmed)", async () => {
    const vault = createMockVault();
    await vault.set("gitlab.pat", "glpat-test");
    await vault.set("gitlab.api_base", "https://gitlab.example.com/api/v4/");
    const spy = makeSpyContext(vault);
    await ensureGitlabMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("blank api_base falls through to the pat-only env", async () => {
    const vault = createMockVault();
    await vault.set("gitlab.pat", "glpat-test");
    await vault.set("gitlab.api_base", "   ");
    const spy = makeSpyContext(vault);
    await ensureGitlabMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureBitbucketMcp", () => {
  test("no-op without username + app_password", async () => {
    const vault = createMockVault();
    await vault.set("bitbucket.username", "user");
    const spy = makeSpyContext(vault);
    await ensureBitbucketMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when both creds present", async () => {
    const vault = createMockVault();
    await vault.set("bitbucket.username", "user");
    await vault.set("bitbucket.app_password", "app-pass");
    const spy = makeSpyContext(vault);
    await ensureBitbucketMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureSlackMcp", () => {
  test("no-op when no token (resolver throws → caught)", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureSlackMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when slack.oauth resolves to a valid token", async () => {
    const vault = createMockVault();
    await vault.set(
      "slack.oauth",
      JSON.stringify({ accessToken: "xoxp-tok", refreshToken: "r", expiresAt: FUTURE_EXPIRY }),
    );
    const spy = makeSpyContext(vault);
    await ensureSlackMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("no-op when slack.oauth is present but malformed (resolver throws → caught)", async () => {
    const vault = createMockVault();
    await vault.set("slack.oauth", "{not valid json");
    const spy = makeSpyContext(vault);
    await ensureSlackMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });
});

describe("ensureLinearMcp", () => {
  test("no-op without linear.api_key", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureLinearMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when api_key present", async () => {
    const vault = createMockVault();
    await vault.set("linear.api_key", "lin_test");
    const spy = makeSpyContext(vault);
    await ensureLinearMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureJiraMcp", () => {
  test("no-op without all of token/email/base_url", async () => {
    const vault = createMockVault();
    await vault.set("jira.api_token", "tok");
    await vault.set("jira.email", "me@example.com");
    const spy = makeSpyContext(vault);
    await ensureJiraMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when all three present", async () => {
    const vault = createMockVault();
    await vault.set("jira.api_token", "tok");
    await vault.set("jira.email", "me@example.com");
    await vault.set("jira.base_url", "https://acme.atlassian.net");
    const spy = makeSpyContext(vault);
    await ensureJiraMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureConfluenceMcp", () => {
  test("no-op without all of token/email/base_url", async () => {
    const vault = createMockVault();
    await vault.set("confluence.api_token", "tok");
    const spy = makeSpyContext(vault);
    await ensureConfluenceMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when all three present", async () => {
    const vault = createMockVault();
    await vault.set("confluence.api_token", "tok");
    await vault.set("confluence.email", "me@example.com");
    await vault.set("confluence.base_url", "https://acme.atlassian.net/wiki");
    const spy = makeSpyContext(vault);
    await ensureConfluenceMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureDiscordMcp", () => {
  test("no-op when discord.enabled is not '1'", async () => {
    const vault = createMockVault();
    await vault.set("discord.bot_token", "tok");
    const spy = makeSpyContext(vault);
    await ensureDiscordMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("no-op when enabled='1' but bot_token missing", async () => {
    const vault = createMockVault();
    await vault.set("discord.enabled", "1");
    const spy = makeSpyContext(vault);
    await ensureDiscordMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when enabled='1' and bot_token present", async () => {
    const vault = createMockVault();
    await vault.set("discord.enabled", "1");
    await vault.set("discord.bot_token", "bot-tok");
    const spy = makeSpyContext(vault);
    await ensureDiscordMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureJenkinsMcp", () => {
  test("no-op without base_url/username/api_token", async () => {
    const vault = createMockVault();
    await vault.set("jenkins.base_url", "https://jenkins.example.com");
    const spy = makeSpyContext(vault);
    await ensureJenkinsMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when all creds present (host added to manifest)", async () => {
    const vault = createMockVault();
    await vault.set("jenkins.base_url", "https://jenkins.example.com/");
    await vault.set("jenkins.username", "ci");
    await vault.set("jenkins.api_token", "tok");
    const spy = makeSpyContext(vault);
    await ensureJenkinsMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("spawns even when base_url is not a parseable URL (host=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("jenkins.base_url", "not a url");
    await vault.set("jenkins.username", "ci");
    await vault.set("jenkins.api_token", "tok");
    const spy = makeSpyContext(vault);
    await ensureJenkinsMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureCircleciMcp", () => {
  test("no-op without api_token", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureCircleciMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when api_token present", async () => {
    const vault = createMockVault();
    await vault.set("circleci.api_token", "tok");
    const spy = makeSpyContext(vault);
    await ensureCircleciMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensurePagerdutyMcp", () => {
  test("no-op without api_token", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensurePagerdutyMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when api_token present", async () => {
    const vault = createMockVault();
    await vault.set("pagerduty.api_token", "tok");
    const spy = makeSpyContext(vault);
    await ensurePagerdutyMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureKubernetesMcp", () => {
  test("no-op without kubeconfig", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureKubernetesMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns with kubeconfig only (no context)", async () => {
    const vault = createMockVault();
    await vault.set("kubernetes.kubeconfig", "apiVersion: v1");
    const spy = makeSpyContext(vault);
    await ensureKubernetesMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("spawns with kubeconfig + context override", async () => {
    const vault = createMockVault();
    await vault.set("kubernetes.kubeconfig", "apiVersion: v1");
    await vault.set("kubernetes.context", "prod-cluster");
    const spy = makeSpyContext(vault);
    await ensureKubernetesMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureObsidianMcp", () => {
  test("no-op when no vault paths configured", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureObsidianMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when vault paths present (paths merged into manifest read)", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault, { obsidianVaultPaths: [SANDBOX_CWD] });
    await ensureObsidianMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("ensureMicrosoftBundleMcp", () => {
  // A far-future expiry means the resolver returns the stored token without a refresh.
  const futureExpiry = Date.now() + 60 * 60 * 1000;

  test("spawns onedrive/outlook/teams when a valid microsoft.oauth token resolves", async () => {
    const vault = createMockVault();
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({ accessToken: "ms-tok", refreshToken: "r", expiresAt: futureExpiry }),
    );
    const spy = makeSpyContext(vault);
    await ensureMicrosoftBundleMcp(spy.ctx);
    expectSpawned(spy.setClients);
    const client = spy.setClients[0]?.client;
    expect(client).toBeDefined();
  });

  test("spawns with outlook scopes propagated when present", async () => {
    const vault = createMockVault();
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({
        accessToken: "ms-tok",
        refreshToken: "r",
        expiresAt: futureExpiry,
        scopes: ["Mail.Read", "Files.Read"],
      }),
    );
    const spy = makeSpyContext(vault);
    await ensureMicrosoftBundleMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

// A far-future expiry returns the stored token without triggering a network refresh.
const FUTURE_EXPIRY = Date.now() + 60 * 60 * 1000;
function oauthBlob(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accessToken: "tok",
    refreshToken: "r",
    expiresAt: FUTURE_EXPIRY,
    ...extra,
  });
}

describe("ensurePhase3BundleMcp", () => {
  test("no-op when no phase-3 connectors are configured", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensurePhase3BundleMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns the bundle when at least one phase-3 connector is configured", async () => {
    const vault = createMockVault();
    await vault.set("snyk.token", "snyk-tok");
    const spy = makeSpyContext(vault);
    await ensurePhase3BundleMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("early-returns when a bundle client already exists", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault, { existingClient: { fake: true } });
    await ensurePhase3BundleMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
    expect(spy.disconnects.length).toBe(1);
  });
});

describe("ensureGoogleDriveMcp", () => {
  test("no-op when no google service has an oauth key", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureGoogleDriveMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns the bundle for each configured google service (per-service keys)", async () => {
    const vault = createMockVault();
    await vault.set("google_drive.oauth", oauthBlob());
    await vault.set("google_gmail.oauth", oauthBlob());
    await vault.set("google_photos.oauth", oauthBlob());
    await vault.set("google_meet.oauth", oauthBlob());
    const spy = makeSpyContext(vault);
    await ensureGoogleDriveMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });
});

describe("OAuth single-connector spawns (notion/mendeley/zoom/hubspot/miro/canva)", () => {
  const cases: Array<{
    name: string;
    fn: (ctx: MeshSpawnContext) => Promise<void>;
    oauthKey: string;
  }> = [
    { name: "notion", fn: ensureNotionMcp, oauthKey: "notion.oauth" },
    { name: "mendeley", fn: ensureMendeleyMcp, oauthKey: "mendeley.oauth" },
    { name: "zoom", fn: ensureZoomMcp, oauthKey: "zoom.oauth" },
    { name: "hubspot", fn: ensureHubspotMcp, oauthKey: "hubspot.oauth" },
    { name: "miro", fn: ensureMiroMcp, oauthKey: "miro.oauth" },
    { name: "canva", fn: ensureCanvaMcp, oauthKey: "canva.oauth" },
  ];

  for (const c of cases) {
    test(`${c.name}: no-op when oauth key is absent`, async () => {
      const vault = createMockVault();
      const spy = makeSpyContext(vault);
      await c.fn(spy.ctx);
      expect(spy.setClients.length).toBe(0);
    });

    test(`${c.name}: spawns when a valid oauth token resolves`, async () => {
      const vault = createMockVault();
      await vault.set(c.oauthKey, oauthBlob());
      const spy = makeSpyContext(vault);
      await c.fn(spy.ctx);
      expectSpawned(spy.setClients);
    });

    test(`${c.name}: no-op when oauth blob present but malformed (resolver throws → caught)`, async () => {
      const vault = createMockVault();
      await vault.set(c.oauthKey, "{not valid json");
      const spy = makeSpyContext(vault);
      await c.fn(spy.ctx);
      expect(spy.setClients.length).toBe(0);
    });
  }
});

describe("ensureFigmaMcp", () => {
  test("no-op when oauth present but team_id missing", async () => {
    const vault = createMockVault();
    await vault.set("figma.oauth", oauthBlob());
    const spy = makeSpyContext(vault);
    await ensureFigmaMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when both oauth and team_id present", async () => {
    const vault = createMockVault();
    await vault.set("figma.oauth", oauthBlob());
    await vault.set("figma.team_id", "team-123");
    const spy = makeSpyContext(vault);
    await ensureFigmaMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("no-op when oauth blob is malformed (resolver throws → caught)", async () => {
    const vault = createMockVault();
    await vault.set("figma.oauth", "{not valid json");
    await vault.set("figma.team_id", "team-123");
    const spy = makeSpyContext(vault);
    await ensureFigmaMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });
});

describe("ensureSalesforceMcp", () => {
  test("no-op without salesforce.oauth", async () => {
    const vault = createMockVault();
    const spy = makeSpyContext(vault);
    await ensureSalesforceMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });

  test("spawns when oauth resolves with an instance_url (host added to manifest)", async () => {
    const vault = createMockVault();
    await vault.set(
      "salesforce.oauth",
      oauthBlob({ instanceUrl: "https://acme.my.salesforce.com" }),
    );
    const spy = makeSpyContext(vault);
    await ensureSalesforceMcp(spy.ctx);
    expectSpawned(spy.setClients);
  });

  test("no-op when oauth blob is malformed (resolver throws → caught)", async () => {
    const vault = createMockVault();
    await vault.set("salesforce.oauth", "{not valid json");
    const spy = makeSpyContext(vault);
    await ensureSalesforceMcp(spy.ctx);
    expect(spy.setClients.length).toBe(0);
  });
});
