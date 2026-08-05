// This is the CANONICAL test for connector-spawns.ts. It mocks the per-provider
// OAuth access-token resolvers via process-global `mock.module` and is therefore
// safe under the combined `bun test packages/gateway` run (the push-matrix "Unit +
// Coverage" job) — it never depends on the real resolver's return value.
//
// Do NOT add a sibling real-resolver test (e.g. a src-tree connector-spawns.test.ts
// that drives ensure*Mcp through the REAL getValid*AccessToken). `mock.module` is
// process-global, so this file's mocks (and slack-sync.test.ts's slack mock) leak
// into any real-resolver twin in the same process and make ensureSlackMcp spawn
// despite an absent/malformed token — green on the src-only PR gate, red on the
// combined push run. One such twin was removed for exactly this reason.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Config } from "../../../../src/config.ts";
import type { MeshSpawnContext, ServerSpec } from "../../../../src/connectors/lazy-mesh/slot.ts";
import { createMockVault } from "../../../../src/vault/mock.ts";

// Config is `as const` (mutable at runtime, not Object.frozen). ensureWorkdayMcp reads the
// tenant host/name from Config; set them deterministically per-test rather than relying on
// env-vars-before-import (which is order-dependent and fails in the combined `bun test` run
// once another file has already imported + frozen config.ts). Mirrors workday-access-token.test.ts.
const mutableWorkdayConfig = Config as { workdayTenantHost: string; workdayTenant: string };

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
  anyGoogleOAuthVaultPresent: async (vault: {
    get: (k: string) => Promise<string | null>;
  }): Promise<boolean> => {
    for (const k of [
      "google_drive.oauth",
      "google_gmail.oauth",
      "google_photos.oauth",
      "google_meet.oauth",
    ]) {
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
      google_meet: "google_meet.oauth",
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

// Workday requires tenant host + tenant in Config (read at module-init from env).
// Set them before connector-spawns.ts is imported so Config captures the values.
process.env.NIMBUS_WORKDAY_TENANT_HOST = "https://acme.workday.com";
process.env.NIMBUS_WORKDAY_TENANT = "acme";

type AuthBehaviour = "ok" | "empty" | "throw";
const authBehaviour: {
  slack: AuthBehaviour;
  notion: AuthBehaviour;
  mendeley: AuthBehaviour;
  workday: AuthBehaviour;
} = {
  slack: "ok",
  notion: "ok",
  mendeley: "ok",
  workday: "ok",
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
mock.module("../../../../src/auth/mendeley-access-token.ts", () => ({
  getValidMendeleyAccessToken: async (): Promise<string> => {
    if (authBehaviour.mendeley === "throw") throw new Error("test-injected-failure");
    if (authBehaviour.mendeley === "empty") return "";
    return "fake-mendeley-access-token";
  },
}));
mock.module("../../../../src/auth/workday-access-token.ts", () => ({
  getValidWorkdayAccessToken: async (): Promise<string> => {
    if (authBehaviour.workday === "throw") throw new Error("test-injected-failure");
    if (authBehaviour.workday === "empty") return "";
    return "fake-workday-access-token";
  },
}));

mock.module("../../../../src/auth/oauth-vault-tokens.ts", () => ({
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

// Tier-2 dedicated-spawn OAuth helpers. Each returns a fake token unless the
// per-provider behaviour is flipped to "empty" (resolves to "") or "throw".
const oauthBehaviour: Record<"hubspot" | "miro" | "canva" | "figma" | "salesforce", AuthBehaviour> =
  {
    hubspot: "ok",
    miro: "ok",
    canva: "ok",
    figma: "ok",
    salesforce: "ok",
  };

function resolveOauthToken(provider: keyof typeof oauthBehaviour, token: string): string {
  if (oauthBehaviour[provider] === "throw") throw new Error("test-injected-failure");
  if (oauthBehaviour[provider] === "empty") return "";
  return token;
}

mock.module("../../../../src/auth/hubspot-access-token.ts", () => ({
  getValidHubspotAccessToken: async (): Promise<string> =>
    resolveOauthToken("hubspot", "fake-hubspot-access-token"),
}));
mock.module("../../../../src/auth/miro-access-token.ts", () => ({
  getValidMiroAccessToken: async (): Promise<string> =>
    resolveOauthToken("miro", "fake-miro-access-token"),
}));
mock.module("../../../../src/auth/canva-access-token.ts", () => ({
  getValidCanvaAccessToken: async (): Promise<string> =>
    resolveOauthToken("canva", "fake-canva-access-token"),
}));
mock.module("../../../../src/auth/figma-access-token.ts", () => ({
  getValidFigmaAccessToken: async (): Promise<string> =>
    resolveOauthToken("figma", "fake-figma-access-token"),
}));
mock.module("../../../../src/auth/salesforce-access-token.ts", () => ({
  getValidSalesforceAuth: async (): Promise<{ accessToken: string; instanceUrl: string }> => {
    if (oauthBehaviour.salesforce === "throw") throw new Error("test-injected-failure");
    if (oauthBehaviour.salesforce === "empty") return { accessToken: "", instanceUrl: "" };
    return {
      accessToken: "fake-salesforce-access-token",
      instanceUrl: "https://acme.my.salesforce.com",
    };
  },
}));

const {
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
} = await import("../../../../src/connectors/lazy-mesh/connector-spawns.ts");

const { LAZY_MESH } = await import("../../../../src/connectors/lazy-mesh/keys.ts");

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
  authBehaviour.mendeley = "ok";
  authBehaviour.workday = "ok";
  oauthBehaviour.hubspot = "ok";
  oauthBehaviour.miro = "ok";
  oauthBehaviour.canva = "ok";
  oauthBehaviour.figma = "ok";
  oauthBehaviour.salesforce = "ok";
  process.env.NIMBUS_TEST_LEAK_CANARY = "should-not-appear";
});

function expectNoProcessEnvLeak(env: Record<string, string>): void {
  expect(env).not.toHaveProperty("NIMBUS_TEST_LEAK_CANARY");
}

function expectBaselineHostEnv(env: Record<string, string>): void {
  if (process.env.PATH !== undefined) {
    expect(env).toHaveProperty("PATH");
  }
}

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
    expect(linearSpec?.command).toBe(process.execPath);
    expect(linearSpec?.args[0]).toMatch(/[\\/]packages[\\/]gateway[\\/]src[\\/]index\.ts$/);
    expect(linearSpec?.args[1]).toBe("__nimbus-sandbox");
    // The inner command is the gateway re-executing itself in its connector role.
    expect(linearSpec?.args[2]).toBe(process.execPath);
    expect(linearSpec?.args[3]).toMatch(/[\\/]packages[\\/]gateway[\\/]src[\\/]index\.ts$/);
    expect(linearSpec?.args[4]).toBe("__nimbus-connector");
    expect(linearSpec?.args[5]).toBe("linear");
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

    expect(servers["github"]?.env["GITHUB_PAT"]).toBe("ghp_test");
    expect(servers["github_actions"]?.env["GITHUB_PAT"]).toBe("ghp_test");
    expect(servers["github"]?.command).toBe(process.execPath);
    expect(servers["github_actions"]?.command).toBe(process.execPath);
    expect(servers["github"]?.args[1]).toBe("__nimbus-sandbox");
    expect(servers["github_actions"]?.args[1]).toBe("__nimbus-sandbox");
    // The sandboxed command is the gateway re-executing itself in its connector role, with the
    // connector id as the final argument — never a path into a source tree the binary lacks.
    expect(servers["github"]?.args[4]).toBe("__nimbus-connector");
    expect(servers["github"]?.args[5]).toBe("github");
    expect(servers["github_actions"]?.args[4]).toBe("__nimbus-connector");
    expect(servers["github_actions"]?.args[5]).toBe("github-actions");
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

describe("ensureAppleMcp (iCloud Mail+Calendar, two-key gate)", () => {
  test("missing both → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureAppleMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("missing icloud_app_password → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("apple.icloud_email", "me@icloud.com");
    await ensureAppleMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("missing icloud_email → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("apple.icloud_app_password", "abcd-efgh-ijkl-mnop");
    await ensureAppleMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("blank icloud_email → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("apple.icloud_email", "");
    await vault.set("apple.icloud_app_password", "abcd-efgh-ijkl-mnop");
    await ensureAppleMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("both present → spawn apple with scoped env + iCloud host:port manifest", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("apple.icloud_email", "me@icloud.com");
    await vault.set("apple.icloud_app_password", "abcd-efgh-ijkl-mnop");
    await ensureAppleMcp(ctx);

    expect(calls.setLazyClient).toHaveLength(1);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.apple);
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(calls.scheduleLazyDisconnect).toContain(LAZY_MESH.apple);

    const spec = capturedClients[0]?.servers["apple"];
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args[0]).toMatch(/[\\/]packages[\\/]gateway[\\/]src[\\/]index\.ts$/);
    expect(spec?.args[1]).toBe("__nimbus-sandbox");
    expect(spec?.args[4]).toBe("__nimbus-connector");
    expect(spec?.args[5]).toBe("apple");
    expect(spec?.env["APPLE_ICLOUD_EMAIL"]).toBe("me@icloud.com");
    expect(spec?.env["APPLE_ICLOUD_APP_PASSWORD"]).toBe("abcd-efgh-ijkl-mnop");
    // The fixed iCloud IMAP/SMTP host:port endpoints are folded into the sandbox manifest.
    const manifestJson = spec?.env["NIMBUS_SANDBOX_MANIFEST_JSON"] ?? "";
    expect(manifestJson).toContain("imap.mail.me.com:993");
    expect(manifestJson).toContain("smtp.mail.me.com:587");
    expect(manifestJson).toContain("caldav.icloud.com");
    expectNoProcessEnvLeak(spec?.env ?? {});
  });

  test("already running → no double-spawn", async () => {
    const { ctx, calls, vault } = makeCtx({ existingClient: true });
    await vault.set("apple.icloud_email", "me@icloud.com");
    await vault.set("apple.icloud_app_password", "abcd-efgh-ijkl-mnop");
    await ensureAppleMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
    expect(calls.scheduleLazyDisconnect).toContain(LAZY_MESH.apple);
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
    await vault.set("discord.enabled", "true");
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

describe("ensureMendeleyMcp", () => {
  test("missing mendeley.oauth raw → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureMendeleyMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("oauth raw present, getValidMendeleyAccessToken succeeds → spawn", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("mendeley.oauth", '{"access_token":"raw"}');
    await ensureMendeleyMcp(ctx);
    const env = capturedClients[0]?.servers["mendeley"]?.env;
    expect(env?.["MENDELEY_ACCESS_TOKEN"]).toBe("fake-mendeley-access-token");
    expectNoProcessEnvLeak(env ?? {});
  });

  test("auth helper throws → no spawn (swallowed by try/catch)", async () => {
    authBehaviour.mendeley = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("mendeley.oauth", '{"access_token":"raw"}');
    await ensureMendeleyMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("auth helper returns empty string → no spawn", async () => {
    authBehaviour.mendeley = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("mendeley.oauth", '{"access_token":"raw"}');
    await ensureMendeleyMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("mendeley.oauth", '{"access_token":"raw"}');
    await ensureMendeleyMcp(ctx);
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
    expect(Object.keys(servers).sort((a, b) => a.localeCompare(b))).toEqual(["google_drive"]);
    expect(servers["google_drive"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-google_drive-access-token",
    );
    expectNoProcessEnvLeak(servers["google_drive"]?.env ?? {});
  });

  test("all Google services → drive + gmail + photos + meet spawned with distinct tokens", async () => {
    const { ctx, vault } = makeCtx();
    await vault.set("google_drive.oauth", '{"access_token":"d"}');
    await vault.set("google_gmail.oauth", '{"access_token":"g"}');
    await vault.set("google_photos.oauth", '{"access_token":"p"}');
    await vault.set("google_meet.oauth", '{"access_token":"m"}');
    await ensureGoogleDriveMcp(ctx);
    const servers = capturedClients[0]?.servers ?? {};
    expect(Object.keys(servers).sort((a, b) => a.localeCompare(b))).toEqual([
      "gmail",
      "google_drive",
      "google_meet",
      "google_photos",
    ]);
    expect(servers["google_drive"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-google_drive-access-token",
    );
    expect(servers["gmail"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-gmail-access-token",
    );
    expect(servers["google_photos"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-google_photos-access-token",
    );
    expect(servers["google_meet"]?.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe(
      "fake-google-google_meet-access-token",
    );
    for (const id of ["google_drive", "gmail", "google_photos", "google_meet"] as const) {
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

describe("ensureHubspotMcp (Tier-2 OAuth dedicated spawn)", () => {
  test("missing hubspot.oauth → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureHubspotMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("oauth present + valid token → spawn hubspot with scoped env + sandbox wrap", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("hubspot.oauth", '{"access_token":"raw"}');
    await ensureHubspotMcp(ctx);

    expect(calls.setLazyClient).toHaveLength(1);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.hubspot);
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(calls.scheduleLazyDisconnect).toContain(LAZY_MESH.hubspot);

    const spec = capturedClients[0]?.servers["hubspot"];
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args[0]).toMatch(/[\\/]packages[\\/]gateway[\\/]src[\\/]index\.ts$/);
    expect(spec?.args[1]).toBe("__nimbus-sandbox");
    expect(spec?.args[4]).toBe("__nimbus-connector");
    expect(spec?.args[5]).toBe("hubspot");
    expect(spec?.env["HUBSPOT_TOKEN"]).toBe("fake-hubspot-access-token");
    expect(spec?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
    expectNoProcessEnvLeak(spec?.env ?? {});
  });

  test("auth helper throws → no spawn (swallowed)", async () => {
    oauthBehaviour.hubspot = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("hubspot.oauth", '{"access_token":"raw"}');
    await ensureHubspotMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("auth helper returns empty string → no spawn", async () => {
    oauthBehaviour.hubspot = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("hubspot.oauth", '{"access_token":"raw"}');
    await ensureHubspotMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("hubspot.oauth", '{"access_token":"raw"}');
    await ensureHubspotMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureMiroMcp (Tier-2 OAuth dedicated spawn)", () => {
  test("missing miro.oauth → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureMiroMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("oauth present + valid token → spawn miro with scoped env", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("miro.oauth", '{"access_token":"raw"}');
    await ensureMiroMcp(ctx);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.miro);
    const spec = capturedClients[0]?.servers["miro"];
    expect(spec?.args[4]).toBe("__nimbus-connector");
    expect(spec?.args[5]).toBe("miro");
    expect(spec?.env["MIRO_TOKEN"]).toBe("fake-miro-access-token");
    expectNoProcessEnvLeak(spec?.env ?? {});
  });

  test("auth helper throws → no spawn (swallowed)", async () => {
    oauthBehaviour.miro = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("miro.oauth", '{"access_token":"raw"}');
    await ensureMiroMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("empty token → no spawn", async () => {
    oauthBehaviour.miro = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("miro.oauth", '{"access_token":"raw"}');
    await ensureMiroMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("miro.oauth", '{"access_token":"raw"}');
    await ensureMiroMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureCanvaMcp (Tier-2 OAuth dedicated spawn)", () => {
  test("missing canva.oauth → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureCanvaMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("oauth present + valid token → spawn canva with scoped env", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("canva.oauth", '{"access_token":"raw"}');
    await ensureCanvaMcp(ctx);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.canva);
    const spec = capturedClients[0]?.servers["canva"];
    expect(spec?.args[4]).toBe("__nimbus-connector");
    expect(spec?.args[5]).toBe("canva");
    expect(spec?.env["CANVA_TOKEN"]).toBe("fake-canva-access-token");
    expectNoProcessEnvLeak(spec?.env ?? {});
  });

  test("auth helper throws → no spawn (swallowed)", async () => {
    oauthBehaviour.canva = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("canva.oauth", '{"access_token":"raw"}');
    await ensureCanvaMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("empty token → no spawn", async () => {
    oauthBehaviour.canva = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("canva.oauth", '{"access_token":"raw"}');
    await ensureCanvaMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("canva.oauth", '{"access_token":"raw"}');
    await ensureCanvaMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureFigmaMcp (Tier-2 OAuth dedicated spawn, two-key)", () => {
  test("missing figma.oauth → no spawn", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("figma.team_id", "team-123");
    await ensureFigmaMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("oauth present but missing figma.team_id → no spawn (two-key gate)", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("figma.oauth", '{"access_token":"raw"}');
    await ensureFigmaMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("oauth + team_id + valid token → spawn figma with both env vars", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("figma.oauth", '{"access_token":"raw"}');
    await vault.set("figma.team_id", "  team-123  ");
    await ensureFigmaMcp(ctx);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.figma);
    const spec = capturedClients[0]?.servers["figma"];
    expect(spec?.args[4]).toBe("__nimbus-connector");
    expect(spec?.args[5]).toBe("figma");
    expect(spec?.env["FIGMA_TOKEN"]).toBe("fake-figma-access-token");
    expect(spec?.env["FIGMA_TEAM_ID"]).toBe("team-123");
    expectNoProcessEnvLeak(spec?.env ?? {});
  });

  test("auth helper throws → no spawn (swallowed)", async () => {
    oauthBehaviour.figma = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("figma.oauth", '{"access_token":"raw"}');
    await vault.set("figma.team_id", "team-123");
    await ensureFigmaMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("empty token → no spawn", async () => {
    oauthBehaviour.figma = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("figma.oauth", '{"access_token":"raw"}');
    await vault.set("figma.team_id", "team-123");
    await ensureFigmaMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("figma.oauth", '{"access_token":"raw"}');
    await vault.set("figma.team_id", "team-123");
    await ensureFigmaMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureSalesforceMcp (Tier-2 OAuth + per-tenant instance host)", () => {
  test("missing salesforce.oauth → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureSalesforceMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("oauth + valid auth → spawn salesforce with token + instance_url env", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("salesforce.oauth", '{"access_token":"raw","instance_url":"x"}');
    await ensureSalesforceMcp(ctx);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.salesforce);
    const spec = capturedClients[0]?.servers["salesforce"];
    expect(spec?.args[4]).toBe("__nimbus-connector");
    expect(spec?.args[5]).toBe("salesforce");
    expect(spec?.env["SALESFORCE_ACCESS_TOKEN"]).toBe("fake-salesforce-access-token");
    expect(spec?.env["SALESFORCE_INSTANCE_URL"]).toBe("https://acme.my.salesforce.com");
    // The per-tenant instance host is folded into the sandbox manifest.
    expect(spec?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toContain("acme.my.salesforce.com");
    expectNoProcessEnvLeak(spec?.env ?? {});
  });

  test("auth helper throws → no spawn (swallowed)", async () => {
    oauthBehaviour.salesforce = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("salesforce.oauth", '{"access_token":"raw"}');
    await ensureSalesforceMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("empty access token / instance url → no spawn", async () => {
    oauthBehaviour.salesforce = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("salesforce.oauth", '{"access_token":"raw"}');
    await ensureSalesforceMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("salesforce.oauth", '{"access_token":"raw"}');
    await ensureSalesforceMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});

describe("ensureWorkdayMcp (Tier-2 OAuth + per-tenant host sandbox allowlisting)", () => {
  beforeEach(() => {
    mutableWorkdayConfig.workdayTenantHost = "https://acme.workday.com";
    mutableWorkdayConfig.workdayTenant = "acme";
  });
  afterEach(() => {
    mutableWorkdayConfig.workdayTenantHost = "";
    mutableWorkdayConfig.workdayTenant = "";
  });

  test("missing workday.oauth → no spawn", async () => {
    const { ctx, calls } = makeCtx();
    await ensureWorkdayMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
    expect(calls.bumpToolsEpoch).toBe(0);
  });

  test("oauth present + valid token → spawn workday with scoped env + tenant host in manifest", async () => {
    const { ctx, calls, vault } = makeCtx();
    await vault.set("workday.oauth", '{"access_token":"raw"}');
    await ensureWorkdayMcp(ctx);

    expect(calls.setLazyClient).toHaveLength(1);
    expect(calls.setLazyClient[0]?.key).toBe(LAZY_MESH.workday);
    expect(calls.bumpToolsEpoch).toBe(1);
    expect(calls.scheduleLazyDisconnect).toContain(LAZY_MESH.workday);

    expect(capturedClients).toHaveLength(1);
    const spec = capturedClients[0]?.servers["workday"];
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args[0]).toMatch(/[\\/]packages[\\/]gateway[\\/]src[\\/]index\.ts$/);
    expect(spec?.args[1]).toBe("__nimbus-sandbox");
    expect(spec?.args[4]).toBe("__nimbus-connector");
    expect(spec?.args[5]).toBe("workday");
    expect(spec?.env["WORKDAY_ACCESS_TOKEN"]).toBe("fake-workday-access-token");
    expect(spec?.env["WORKDAY_TENANT_HOST"]).toBe("https://acme.workday.com");
    expect(spec?.env["WORKDAY_TENANT"]).toBe("acme");
    // The per-tenant host is folded into the sandbox manifest.
    expect(spec?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toContain("acme.workday.com");
    expectNoProcessEnvLeak(spec?.env ?? {});
    expectBaselineHostEnv(spec?.env ?? {});
  });

  test("auth helper throws → no spawn (swallowed by try/catch)", async () => {
    authBehaviour.workday = "throw";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("workday.oauth", '{"access_token":"raw"}');
    await ensureWorkdayMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("auth helper returns empty string → no spawn", async () => {
    authBehaviour.workday = "empty";
    const { ctx, calls, vault } = makeCtx();
    await vault.set("workday.oauth", '{"access_token":"raw"}');
    await ensureWorkdayMcp(ctx);
    expect(calls.setLazyClient).toHaveLength(0);
    expect(capturedClients).toHaveLength(0);
  });

  test("already running → no double-spawn", async () => {
    const { ctx, vault } = makeCtx({ existingClient: true });
    await vault.set("workday.oauth", '{"access_token":"raw"}');
    await ensureWorkdayMcp(ctx);
    expect(capturedClients).toHaveLength(0);
  });
});
