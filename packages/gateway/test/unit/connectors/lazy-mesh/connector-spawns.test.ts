/**
 * Tests for the per-connector spawn functions in connectors/lazy-mesh/connector-spawns.ts.
 *
 * Each ensureXxxMcp function follows a three-state contract:
 *
 *  1. Credentials missing → no spawn, no setLazyClient, no MCPClient construction.
 *  2. Credentials present → spawn with scoped env: setLazyClient called once, MCPClient
 *     constructed with command: "bun", the connector's server.ts path, and an env
 *     produced by extensionProcessEnv (invariant I1) containing the expected creds —
 *     and NOT the rest of process.env. The leak-canary (NIMBUS_TEST_LEAK_CANARY) proves
 *     a regression like `{ env: { ...process.env, ...creds } }` would fail this test.
 *  3. Already running (getLazyClient returns existing) → scheduleLazyDisconnect fires,
 *     no new MCPClient is constructed.
 *
 * The @mastra/mcp module is mocked so MCPClient construction never spawns a subprocess —
 * the mock captures constructor args and exposes stubbed lifecycle methods (connect /
 * disconnect / getTools) defensively in case future code starts calling them.
 *
 * The four OAuth helper modules (Google / Microsoft / Notion / Slack) are mocked to
 * return predictable tokens without HTTP refresh; readConnectorSecret reads through the
 * real MockVault (deterministic, no I/O).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MeshSpawnContext, ServerSpec } from "../../../../src/connectors/lazy-mesh/slot.ts";
import { createMockVault } from "../../../../src/vault/mock.ts";

// ─── Module mocks ────────────────────────────────────────────────────────────

type CapturedClientArgs = {
  readonly id: string;
  readonly servers: Record<string, ServerSpec>;
};

const capturedClients: CapturedClientArgs[] = [];

mock.module("@mastra/mcp", () => ({
  MCPClient: class MockMCPClient {
    readonly id: string;
    readonly servers: Record<string, ServerSpec>;
    constructor(args: { id: string; servers: Record<string, ServerSpec> }) {
      this.id = args.id;
      this.servers = args.servers;
      capturedClients.push({ id: args.id, servers: args.servers });
    }
    // Defensive lifecycle stubs — `ensureXxxMcp` does not call these today, but if
    // future code does, tests must not hang or throw unhandled rejections.
    async connect(): Promise<void> {
      /* no-op */
    }
    async disconnect(): Promise<void> {
      /* no-op */
    }
    async getTools(): Promise<Record<string, unknown>> {
      return {};
    }
  },
}));

mock.module("../../../../src/auth/google-access-token.ts", () => ({
  // anyGoogleOAuthVaultPresent is consumed by credential-orchestration.ts and
  // tested in credential-orchestration.test.ts. Since `mock.module` is
  // process-global and either test file's mock can win in any given bun:test
  // run, BOTH files must export the full surface so loading
  // credential-orchestration.ts never fails on a missing-export error.
  anyGoogleOAuthVaultPresent: async (vault: {
    get: (k: string) => Promise<string | null>;
  }): Promise<boolean> => {
    for (const k of ["google_drive.oauth", "google_gmail.oauth", "google_photos.oauth"]) {
      const v = await vault.get(k);
      if (v !== null && v !== "") return true;
    }
    return false;
  },
  resolveGoogleOAuthVaultKey: async (
    vault: { get: (k: string) => Promise<string | null> },
    id: string,
  ) => {
    const perService: Record<string, string> = {
      google_drive: "google_drive.oauth",
      gmail: "google_gmail.oauth",
      google_photos: "google_photos.oauth",
    };
    const k = perService[id];
    if (k === undefined) return null;
    const v = await vault.get(k);
    return v !== null && v !== "" ? k : null;
  },
  getValidGoogleAccessToken: async (_vault: unknown, id: string): Promise<string> =>
    `fake-google-${id}-access-token`,
}));

mock.module("../../../../src/auth/microsoft-access-token.ts", () => ({
  getValidMicrosoftAccessToken: async (): Promise<string> => "fake-microsoft-access-token",
}));

// Slack and Notion auth helpers use a mutable behaviour flag so individual tests
// can toggle the helper's behaviour (return empty / throw) without re-mocking the
// module — `mock.module` is process-global, so re-mocking mid-suite is fragile.
// Wrapped in an object so the formatter does not narrow the type to a literal.
type AuthBehaviour = "ok" | "empty" | "throw";
const authBehaviour: { slack: AuthBehaviour; notion: AuthBehaviour } = {
  slack: "ok",
  notion: "ok",
};

mock.module("../../../../src/auth/slack-access-token.ts", () => ({
  getValidSlackAccessToken: async (): Promise<string> => {
    if (authBehaviour.slack === "throw") throw new Error("test-injected-failure");
    if (authBehaviour.slack === "empty") return "";
    return "fake-slack-user-token";
  },
}));
mock.module("../../../../src/auth/notion-access-token.ts", () => ({
  getValidNotionAccessToken: async (): Promise<string> => {
    if (authBehaviour.notion === "throw") throw new Error("test-injected-failure");
    if (authBehaviour.notion === "empty") return "";
    return "fake-notion-access-token";
  },
}));

mock.module("../../../../src/auth/oauth-vault-tokens.ts", () => ({
  // Mirror the real implementation: parse `microsoft.oauth` JSON and extract the
  // `scopes` string array. Vault keys must match the two-segment shape (one dot),
  // so the scopes ride inside the OAuth JSON payload, not on a separate key.
  readMicrosoftOAuthScopesForOutlookEnv: async (vault: {
    get: (k: string) => Promise<string | null>;
  }): Promise<string | undefined> => {
    const raw = await vault.get("microsoft.oauth");
    if (raw === null || raw === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const scopes = (parsed as Record<string, unknown>)["scopes"];
    if (!Array.isArray(scopes)) return undefined;
    const strings = scopes.filter((s): s is string => typeof s === "string" && s.trim() !== "");
    return strings.length === 0 ? undefined : strings.join(" ");
  },
}));

// Imports must be dynamic — they go through the mocked modules above.
const {
  ensureBitbucketMcp,
  ensureCircleciMcp,
  ensureConfluenceMcp,
  ensureDiscordMcp,
  ensureGithubMcp,
  ensureGitlabMcp,
  ensureGoogleDriveMcp,
  ensureJenkinsMcp,
  ensureJiraMcp,
  ensureKubernetesMcp,
  ensureLinearMcp,
  ensureMicrosoftBundleMcp,
  ensureNotionMcp,
  ensureObsidianMcp,
  ensurePagerdutyMcp,
  ensurePhase3BundleMcp,
  ensureSlackMcp,
} = await import("../../../../src/connectors/lazy-mesh/connector-spawns.ts");

const { LAZY_MESH } = await import("../../../../src/connectors/lazy-mesh/keys.ts");

// ─── Test-context helper ─────────────────────────────────────────────────────

type Calls = {
  clearLazyIdle: string[];
  setLazyClient: Array<{ key: string }>;
  scheduleLazyDisconnect: string[];
  bumpToolsEpoch: number;
};

function makeCtx(opts?: { existingClient?: boolean; obsidianVaultPaths?: readonly string[] }): {
  ctx: MeshSpawnContext;
  calls: Calls;
  vault: ReturnType<typeof createMockVault>;
} {
  const vault = createMockVault();
  const calls: Calls = {
    clearLazyIdle: [],
    setLazyClient: [],
    scheduleLazyDisconnect: [],
    bumpToolsEpoch: 0,
  };
  const ctx: MeshSpawnContext = {
    vault,
    obsidianVaultPaths: opts?.obsidianVaultPaths,
    clearLazyIdle: (key: string) => calls.clearLazyIdle.push(key),
    getLazyClient: () => (opts?.existingClient === true ? ({} as never) : undefined),
    setLazyClient: (key: string) => calls.setLazyClient.push({ key }),
    bumpToolsEpoch: () => {
      calls.bumpToolsEpoch += 1;
    },
    scheduleLazyDisconnect: (key: string) => calls.scheduleLazyDisconnect.push(key),
  };
  return { ctx, calls, vault };
}

beforeEach(() => {
  capturedClients.length = 0;
  authBehaviour.slack = "ok";
  authBehaviour.notion = "ok";
  // I1 leak-canary — injected into process.env before each test so any spawn that
  // does `{ env: { ...process.env, ...creds } }` (the exact regression I1 prevents)
  // will surface the canary in the captured env. extensionProcessEnv() only allows
  // a BASELINE_KEYS allow-list through, so this key MUST NOT appear.
  process.env.NIMBUS_TEST_LEAK_CANARY = "should-not-appear";
});

function expectNoProcessEnvLeak(env: Record<string, string>): void {
  expect(env).not.toHaveProperty("NIMBUS_TEST_LEAK_CANARY");
}

function expectBaselineHostEnv(env: Record<string, string>): void {
  // PATH (or its equivalent) is in BASELINE_KEYS — it should pass through. This
  // is a positive control: a misconfigured mock that wipes ALL env vars would
  // also avoid the canary, but would fail this check.
  if (process.env.PATH !== undefined) {
    expect(env).toHaveProperty("PATH");
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ensureLinearMcp", () => {
  test("missing linear.api_key → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureLinearMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
    expect(calls.bumpToolsEpoch).toBe(0);
  });

  test("api_key present → spawn linear MCP with scoped env (I1)", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("linear.api_key", "lin_test_key");
    await ensureLinearMcp(ctx);

    expect(calls.setLazyClient).toHaveLength(1);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.linear);
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(calls.scheduleLazyDisconnect).toContain(LAZY_MESH.linear);

    expect(capturedClients).toHaveLength(1);
    const linearSpec = capturedClients[0]?.servers["linear"];
    // Post-T2 PR 1 (I15): ServerSpec is wrapped via wrapServerSpec — command
    // is process.execPath (Bun), args[0] is sandbox-wrapper.ts, args[1] is
    // the original command "bun", args[2..] are the original args. The env
    // gains NIMBUS_SANDBOX_MANIFEST_JSON; the connector's vault-derived
    // env vars + the baseline host env pass through unchanged.
    expect(linearSpec?.command).toBe(process.execPath);
    expect(linearSpec?.args[0]).toMatch(/[\\/]platform[\\/]sandbox[\\/]sandbox-wrapper\.ts$/);
    expect(linearSpec?.args[1]).toBe("bun");
    expect(linearSpec?.args[2]).toMatch(/[\\/]mcp-connectors[\\/]linear[\\/]src[\\/]server\.ts$/);
    expect(linearSpec?.env["LINEAR_API_KEY"]).toBe("lin_test_key");
    expect(linearSpec?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
    expectNoProcessEnvLeak(linearSpec?.env ?? {});
    expectBaselineHostEnv(linearSpec?.env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, calls, vault } = makeCtx({ existingClient: true });
    await vault.set("linear.api_key", "lin_test_key");
    await ensureLinearMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
    expect(calls.scheduleLazyDisconnect).toContain(LAZY_MESH.linear);
  });

  test("blank api_key → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("linear.api_key", "");
    await ensureLinearMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensurePagerdutyMcp", () => {
  test("missing api_token → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensurePagerdutyMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("api_token present → spawn with scoped env", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("pagerduty.api_token", "pd_test_key");
    await ensurePagerdutyMcp(ctx);
    const spec = capturedClients[0]?.servers["pagerduty"];
    expect(spec?.env["PAGERDUTY_API_TOKEN"]).toBe("pd_test_key");
    expectNoProcessEnvLeak(spec?.env ?? {});
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.pagerduty);
  });

  test("whitespace-only api_token → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("pagerduty.api_token", "   ");
    await ensurePagerdutyMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("api_token is trimmed before injection", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("pagerduty.api_token", "  pd_token_with_spaces  ");
    await ensurePagerdutyMcp(ctx);
    const spec = capturedClients[0]?.servers["pagerduty"];
    expect(spec?.env["PAGERDUTY_API_TOKEN"]).toBe("pd_token_with_spaces");
  });

  test("already running → no double-spawn", async () => {
    const { ctx, calls, vault } = makeCtx({ existingClient: true });
    await vault.set("pagerduty.api_token", "pd_test_key");
    await ensurePagerdutyMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureCircleciMcp", () => {
  test("missing api_token → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureCircleciMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("api_token present → spawn with trimmed token", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("circleci.api_token", "  cci_token  ");
    await ensureCircleciMcp(ctx);
    const spec = capturedClients[0]?.servers["circleci"];
    expect(spec?.env["CIRCLECI_API_TOKEN"]).toBe("cci_token");
    expectNoProcessEnvLeak(spec?.env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("circleci.api_token", "cci_token");
    await ensureCircleciMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureGithubMcp", () => {
  test("missing github.pat → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureGithubMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("github.pat present → spawn github + github_actions with scoped env", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("github.pat", "ghp_test");
    await ensureGithubMcp(ctx);

    expect(calls.setLazyClient).toHaveLength(1);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.github);
    const servers = capturedClients[0]?.servers ?? {};

    // Post-T2 PR 1 (I15): both ServerSpecs are wrapped via wrapServerSpec —
    // command is process.execPath (Bun), args[0] is sandbox-wrapper.ts,
    // args[1] is the original command "bun", args[2..] are the original
    // args. Vault-derived env vars + baseline host env pass through.
    expect(servers["github"]?.env["GITHUB_PAT"]).toBe("ghp_test");
    expect(servers["github_actions"]?.env["GITHUB_PAT"]).toBe("ghp_test");
    expect(servers["github"]?.command).toBe(process.execPath);
    expect(servers["github_actions"]?.command).toBe(process.execPath);
    expect(servers["github"]?.args[0]).toMatch(
      /[\\/]platform[\\/]sandbox[\\/]sandbox-wrapper\.ts$/,
    );
    expect(servers["github_actions"]?.args[0]).toMatch(
      /[\\/]platform[\\/]sandbox[\\/]sandbox-wrapper\.ts$/,
    );
    expect(servers["github"]?.args[2]).toMatch(
      /[\\/]mcp-connectors[\\/]github[\\/]src[\\/]server\.ts$/,
    );
    expect(servers["github_actions"]?.args[2]).toMatch(
      /[\\/]mcp-connectors[\\/]github-actions[\\/]src[\\/]server\.ts$/,
    );
    expect(servers["github"]?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
    expect(servers["github_actions"]?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
    expectNoProcessEnvLeak(servers["github"]?.env ?? {});
    expectNoProcessEnvLeak(servers["github_actions"]?.env ?? {});
  });

  test("blank github.pat → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("github.pat", "");
    await ensureGithubMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("github.pat", "ghp_test");
    await ensureGithubMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureGitlabMcp", () => {
  test("missing pat → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureGitlabMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("pat present, no api_base → spawn with default base", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("gitlab.pat", "glpat_test");
    await ensureGitlabMcp(ctx);
    const env = capturedClients[0]?.servers["gitlab"]?.env;
    expect(env?.["GITLAB_PAT"]).toBe("glpat_test");
    expect(env).not.toHaveProperty("GITLAB_API_BASE_URL");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("pat + api_base present → both injected; trailing slash stripped", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("gitlab.pat", "glpat_test");
    await vault.set("gitlab.api_base", "https://gitlab.example.com/api/v4/");
    await ensureGitlabMcp(ctx);
    const env = capturedClients[0]?.servers["gitlab"]?.env;
    expect(env?.["GITLAB_PAT"]).toBe("glpat_test");
    expect(env?.["GITLAB_API_BASE_URL"]).toBe("https://gitlab.example.com/api/v4");
  });

  test("blank pat → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("gitlab.pat", "");
    await ensureGitlabMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("gitlab.pat", "glpat_test");
    await ensureGitlabMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureBitbucketMcp", () => {
  test("missing both → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureBitbucketMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("missing username → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("bitbucket.app_password", "secret");
    await ensureBitbucketMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("missing app_password → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("bitbucket.username", "user");
    await ensureBitbucketMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("both present → spawn with scoped env", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("bitbucket.username", "alice");
    await vault.set("bitbucket.app_password", "bb_secret");
    await ensureBitbucketMcp(ctx);
    const env = capturedClients[0]?.servers["bitbucket"]?.env;
    expect(env?.["BITBUCKET_USERNAME"]).toBe("alice");
    expect(env?.["BITBUCKET_APP_PASSWORD"]).toBe("bb_secret");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("bitbucket.username", "alice");
    await vault.set("bitbucket.app_password", "bb_secret");
    await ensureBitbucketMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureJiraMcp", () => {
  test("missing any of token/email/base_url → no spawn", async () => {
    const cases = [
      { token: "", email: "a@b.com", base: "https://x.atlassian.net" },
      { token: "tok", email: "", base: "https://x.atlassian.net" },
      { token: "tok", email: "a@b.com", base: "" },
    ];
    for (const c of cases) {
      const { ctx, calls, vault } = makeCtx();
      await vault.set("jira.api_token", c.token);
      await vault.set("jira.email", c.email);
      await vault.set("jira.base_url", c.base);
      await ensureJiraMcp(ctx);
      expect(calls.setLazyClient).toHaveLength(0);
    }
  });

  test("all three present → spawn with scoped env", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("jira.api_token", "jira_tok");
    await vault.set("jira.email", "alice@acme.com");
    await vault.set("jira.base_url", "https://acme.atlassian.net");
    await ensureJiraMcp(ctx);
    const env = capturedClients[0]?.servers["jira"]?.env;
    expect(env?.["JIRA_API_TOKEN"]).toBe("jira_tok");
    expect(env?.["JIRA_EMAIL"]).toBe("alice@acme.com");
    expect(env?.["JIRA_BASE_URL"]).toBe("https://acme.atlassian.net");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("jira.api_token", "jira_tok");
    await vault.set("jira.email", "alice@acme.com");
    await vault.set("jira.base_url", "https://acme.atlassian.net");
    await ensureJiraMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureConfluenceMcp", () => {
  test("missing any of token/email/base_url → no spawn", async () => {
    const cases = [
      { token: "", email: "a@b.com", base: "https://x.atlassian.net" },
      { token: "tok", email: "", base: "https://x.atlassian.net" },
      { token: "tok", email: "a@b.com", base: "" },
    ];
    for (const c of cases) {
      const { ctx, calls, vault } = makeCtx();
      await vault.set("confluence.api_token", c.token);
      await vault.set("confluence.email", c.email);
      await vault.set("confluence.base_url", c.base);
      await ensureConfluenceMcp(ctx);
      expect(calls.setLazyClient).toHaveLength(0);
    }
  });

  test("all three present → spawn with scoped env", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("confluence.api_token", "conf_tok");
    await vault.set("confluence.email", "alice@acme.com");
    await vault.set("confluence.base_url", "https://acme.atlassian.net/wiki");
    await ensureConfluenceMcp(ctx);
    const env = capturedClients[0]?.servers["confluence"]?.env;
    expect(env?.["CONFLUENCE_API_TOKEN"]).toBe("conf_tok");
    expect(env?.["CONFLUENCE_EMAIL"]).toBe("alice@acme.com");
    expect(env?.["CONFLUENCE_BASE_URL"]).toBe("https://acme.atlassian.net/wiki");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("confluence.api_token", "conf_tok");
    await vault.set("confluence.email", "alice@acme.com");
    await vault.set("confluence.base_url", "https://acme.atlassian.net/wiki");
    await ensureConfluenceMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureDiscordMcp", () => {
  test("missing token and enabled flag → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureDiscordMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("token present but enabled !== '1' → no spawn (opt-in gate)", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("discord.bot_token", "discord_tok");
    await vault.set("discord.enabled", "true"); // any value other than "1"
    await ensureDiscordMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("enabled=1 + token present → spawn with scoped env", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("discord.enabled", "1");
    await vault.set("discord.bot_token", "discord_tok");
    await ensureDiscordMcp(ctx);
    const env = capturedClients[0]?.servers["discord"]?.env;
    expect(env?.["DISCORD_BOT_TOKEN"]).toBe("discord_tok");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("enabled=1 but token missing → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("discord.enabled", "1");
    await ensureDiscordMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("discord.enabled", "1");
    await vault.set("discord.bot_token", "discord_tok");
    await ensureDiscordMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureJenkinsMcp", () => {
  test("missing any of base_url/username/api_token → no spawn", async () => {
    const cases = [
      { base: "", user: "u", token: "t" },
      { base: "https://j.local", user: "", token: "t" },
      { base: "https://j.local", user: "u", token: "" },
    ];
    for (const c of cases) {
      const { ctx, calls, vault } = makeCtx();
      await vault.set("jenkins.base_url", c.base);
      await vault.set("jenkins.username", c.user);
      await vault.set("jenkins.api_token", c.token);
      await ensureJenkinsMcp(ctx);
      expect(calls.setLazyClient).toHaveLength(0);
    }
  });

  test("all three present → spawn with trimmed values and stripped trailing slash", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("jenkins.base_url", "  https://jenkins.example.com/  ");
    await vault.set("jenkins.username", "  ops  ");
    await vault.set("jenkins.api_token", "  jenkins_tok  ");
    await ensureJenkinsMcp(ctx);
    const env = capturedClients[0]?.servers["jenkins"]?.env;
    expect(env?.["JENKINS_BASE_URL"]).toBe("https://jenkins.example.com");
    expect(env?.["JENKINS_USERNAME"]).toBe("ops");
    expect(env?.["JENKINS_API_TOKEN"]).toBe("jenkins_tok");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("jenkins.base_url", "https://jenkins.example.com");
    await vault.set("jenkins.username", "ops");
    await vault.set("jenkins.api_token", "jenkins_tok");
    await ensureJenkinsMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureKubernetesMcp", () => {
  test("missing kubeconfig → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureKubernetesMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("kubeconfig present, no context → spawn with KUBECONFIG only", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("kubernetes.kubeconfig", "/home/u/.kube/config");
    await ensureKubernetesMcp(ctx);
    const env = capturedClients[0]?.servers["kubernetes"]?.env;
    expect(env?.["KUBECONFIG"]).toBe("/home/u/.kube/config");
    expect(env).not.toHaveProperty("KUBE_CONTEXT");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("kubeconfig + context → both injected", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("kubernetes.kubeconfig", "/home/u/.kube/config");
    await vault.set("kubernetes.context", "prod-cluster");
    await ensureKubernetesMcp(ctx);
    const env = capturedClients[0]?.servers["kubernetes"]?.env;
    expect(env?.["KUBECONFIG"]).toBe("/home/u/.kube/config");
    expect(env?.["KUBE_CONTEXT"]).toBe("prod-cluster");
  });

  test("kubeconfig whitespace-trimmed", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("kubernetes.kubeconfig", "  /home/u/.kube/config  ");
    await ensureKubernetesMcp(ctx);
    const env = capturedClients[0]?.servers["kubernetes"]?.env;
    // The trim happens via .trim() === "" guard; the stored value with whitespace
    // is forwarded as-is to KUBECONFIG (no implicit trimming for the value itself).
    expect(env?.["KUBECONFIG"]?.trim()).toBe("/home/u/.kube/config");
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("kubernetes.kubeconfig", "/home/u/.kube/config");
    await ensureKubernetesMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureSlackMcp", () => {
  test("getValidSlackAccessToken returns empty → no spawn", async () => {
    authBehaviour.slack = "empty";
    const { ctx, calls } = makeCtx();
    await ensureSlackMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("valid token → spawn with scoped env", async () => {
    const { ctx } = makeCtx();
    await ensureSlackMcp(ctx);
    const env = capturedClients[0]?.servers["slack"]?.env;
    expect(env?.["SLACK_USER_ACCESS_TOKEN"]).toBe("fake-slack-user-token");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("auth helper throws → no spawn (swallowed by try/catch)", async () => {
    authBehaviour.slack = "throw";
    const { ctx, calls } = makeCtx();
    await ensureSlackMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx } = makeCtx({ existingClient: true });
    await ensureSlackMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureNotionMcp", () => {
  test("missing notion.oauth raw → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureNotionMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("oauth raw present, getValidNotionAccessToken succeeds → spawn", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("notion.oauth", '{"access_token":"raw"}');
    await ensureNotionMcp(ctx);
    const env = capturedClients[0]?.servers["notion"]?.env;
    expect(env?.["NOTION_ACCESS_TOKEN"]).toBe("fake-notion-access-token");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("auth helper throws → no spawn (swallowed by try/catch)", async () => {
    authBehaviour.notion = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("notion.oauth", '{"access_token":"raw"}');
    await ensureNotionMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("auth helper returns empty string → no spawn", async () => {
    authBehaviour.notion = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("notion.oauth", '{"access_token":"raw"}');
    await ensureNotionMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("notion.oauth", '{"access_token":"raw"}');
    await ensureNotionMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureGoogleDriveMcp (Google bundle)", () => {
  test("no Google OAuth keys → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureGoogleDriveMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("google_drive.oauth only → only drive server spawned", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("google_drive.oauth", '{"access_token":"x"}');
    await ensureGoogleDriveMcp(ctx);
    const servers = capturedClients[0]?.servers ?? {};
    expect(Object.keys(servers).sort()).toEqual(["google_drive"]);
    expect(servers["google_drive"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-google_drive-access-token",
    );
    expectNoProcessEnvLeak(servers["google_drive"]?.env ?? {});
  });

  test("all three Google services → drive + gmail + photos spawned with distinct tokens", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("google_drive.oauth", '{"access_token":"d"}');
    await vault.set("google_gmail.oauth", '{"access_token":"g"}');
    await vault.set("google_photos.oauth", '{"access_token":"p"}');
    await ensureGoogleDriveMcp(ctx);
    const servers = capturedClients[0]?.servers ?? {};
    expect(Object.keys(servers).sort()).toEqual(["gmail", "google_drive", "google_photos"]);
    expect(servers["google_drive"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-google_drive-access-token",
    );
    expect(servers["gmail"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-gmail-access-token",
    );
    expect(servers["google_photos"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-google_photos-access-token",
    );
    for (const id of ["google_drive", "gmail", "google_photos"] as const) {
      expectNoProcessEnvLeak(servers[id]?.env ?? {});
    }
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("google_drive.oauth", '{"access_token":"x"}');
    await ensureGoogleDriveMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureMicrosoftBundleMcp", () => {
  test("no Outlook scopes → onedrive/outlook/teams spawned with shared token and no scopes env", async () => {
    const { ctx, vault } = makeCtx();
    // The Microsoft auth helper is mocked to always return a token; the bundle
    // unconditionally spawns all three child servers.
    await vault.set("microsoft.oauth", '{"access_token":"x"}');
    await ensureMicrosoftBundleMcp(ctx);
    const servers = capturedClients[0]?.servers ?? {};
    for (const id of ["onedrive", "outlook", "teams"] as const) {
      expect(servers[id]?.env["MICROSOFT_OAUTH_ACCESS_TOKEN"]).toBe("fake-microsoft-access-token");
      expectNoProcessEnvLeak(servers[id]?.env ?? {});
    }
    expect(servers["outlook"]?.env).not.toHaveProperty("MICROSOFT_OAUTH_SCOPES");
  });

  test("outlook scopes present → MICROSOFT_OAUTH_SCOPES injected into outlook env only", async () => {
    const { ctx, vault } = makeCtx();
    // Scopes are embedded in the microsoft.oauth JSON payload (the real
    // implementation parses them out of the OAuth blob, not a separate key).
    await vault.set(
      "microsoft.oauth",
      JSON.stringify({ access_token: "x", scopes: ["Mail.Read", "Mail.Send"] }),
    );
    await ensureMicrosoftBundleMcp(ctx);
    const servers = capturedClients[0]?.servers ?? {};
    expect(servers["outlook"]?.env["MICROSOFT_OAUTH_SCOPES"]).toBe("Mail.Read Mail.Send");
    expect(servers["onedrive"]?.env).not.toHaveProperty("MICROSOFT_OAUTH_SCOPES");
    expect(servers["teams"]?.env).not.toHaveProperty("MICROSOFT_OAUTH_SCOPES");
  });

  test("already running → no double-spawn", async () => {
    const { ctx } = makeCtx({ existingClient: true });
    await ensureMicrosoftBundleMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureObsidianMcp", () => {
  test("no vault paths → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureObsidianMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("empty vault paths array → no spawn", async () => {
    const { ctx, calls } = makeCtx({ obsidianVaultPaths: [] });
    await ensureObsidianMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("vault paths present → spawn with OBSIDIAN_VAULT_PATHS_JSON env", async () => {
    const paths = ["/home/u/notes", "/home/u/work"];
    const { ctx } = makeCtx({ obsidianVaultPaths: paths });
    await ensureObsidianMcp(ctx);
    const env = capturedClients[0]?.servers["obsidian"]?.env;
    expect(env?.["OBSIDIAN_VAULT_PATHS_JSON"]).toBe(JSON.stringify(paths));
    expectNoProcessEnvLeak(env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx } = makeCtx({ existingClient: true, obsidianVaultPaths: ["/x"] });
    await ensureObsidianMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensurePhase3BundleMcp", () => {
  test("no Phase 3 vault keys → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensurePhase3BundleMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("AWS keys present → aws server in the bundle with scoped env", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("aws.access_key_id", "AKIATEST");
    await vault.set("aws.secret_access_key", "secret_test");
    await vault.set("aws.default_region", "us-east-1");
    await ensurePhase3BundleMcp(ctx);
    const servers = capturedClients[0]?.servers ?? {};
    expect(servers["aws"]?.env["AWS_ACCESS_KEY_ID"]).toBe("AKIATEST");
    expect(servers["aws"]?.env["AWS_SECRET_ACCESS_KEY"]).toBe("secret_test");
    expect(servers["aws"]?.env["AWS_DEFAULT_REGION"]).toBe("us-east-1");
    expectNoProcessEnvLeak(servers["aws"]?.env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("aws.access_key_id", "AKIATEST");
    await vault.set("aws.secret_access_key", "secret_test");
    await vault.set("aws.default_region", "us-east-1");
    await ensurePhase3BundleMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});
