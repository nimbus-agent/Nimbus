/**
 * Unit tests for packages/gateway/src/ipc/connector-rpc-handlers/auth.ts
 *
 * Scope (Task 7): PAT-based connectors + observability set.
 *   github, gitlab, linear, circleci, jenkins, bitbucket
 *   grafana, sentry, newrelic, datadog, pagerduty
 *
 * Task 8 will extend this file with: aws, azure, gcp, kubernetes, discord,
 * iac, jira, confluence, and the OAuth/PKCE dispatch paths.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../../../../src/index/local-index.ts";
import { handleConnectorAuth } from "../../../../src/ipc/connector-rpc-handlers/auth.ts";
import type { ConnectorRpcHandlerContext } from "../../../../src/ipc/connector-rpc-handlers/context.ts";
import { loadSchedulerState } from "../../../../src/sync/scheduler-store.ts";
import { MockVault } from "../../../../src/vault/mock.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(
  rec: Record<string, unknown>,
  vault: MockVault,
  localIndex: LocalIndex,
): ConnectorRpcHandlerContext {
  return {
    rec,
    vault,
    localIndex,
    openUrl: async (_url: string) => {
      throw new Error("openUrl must not be called in PAT/secret connector auth tests");
    },
    syncScheduler: undefined,
    connectorMesh: undefined,
  };
}

function freshDeps(): { db: Database; vault: MockVault; localIndex: LocalIndex } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const localIndex = new LocalIndex(db);
  const vault = new MockVault();
  return { db, vault, localIndex };
}

/** Assert scheduler row was written for a given service. */
function assertSchedulerRow(db: Database, serviceId: string): void {
  const row = loadSchedulerState(db, serviceId);
  expect(row).not.toBeNull();
  expect(row?.service_id).toBe(serviceId);
}

/** Assert vault key holds the expected value. */
async function assertVaultKey(vault: MockVault, key: string, expected: string): Promise<void> {
  const val = await vault.get(key);
  expect(val).toBe(expected);
}

/** Assert vault key is absent. */
async function assertVaultKeyAbsent(vault: MockVault, key: string): Promise<void> {
  const val = await vault.get(key);
  expect(val).toBeNull();
}

/** Confirm that credential value does not appear in the JSON-serialised response. */
function assertCredentialRedacted(result: unknown, secret: string): void {
  const json = JSON.stringify(result);
  expect(json).not.toContain(secret);
}

// ─── github ─────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — github", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes github.pat and registers scheduler rows", async () => {
    const PAT = "ghp_super_secret_token_12345";
    const ctx = makeCtx({ service: "github", personalAccessToken: PAT }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect(result.kind).toBe("hit");
    const value = result.value as Record<string, unknown>;
    expect(value.ok).toBe(true);
    expect(value.serviceId).toBe("github");

    await assertVaultKey(vault, "github.pat", PAT);
    assertSchedulerRow(db, "github");
    assertSchedulerRow(db, "github_actions");
  });

  test("accepts token alias field", async () => {
    const PAT = "ghp_alias_token_abc";
    const ctx = makeCtx({ service: "github", token: PAT }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "github.pat", PAT);
  });

  test("error path: missing PAT throws ConnectorRpcError with code -32602", async () => {
    const ctx = makeCtx({ service: "github" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({
      rpcCode: -32602,
    });
    await assertVaultKeyAbsent(vault, "github.pat");
  });

  test("error path: empty personalAccessToken is rejected", async () => {
    const ctx = makeCtx({ service: "github", personalAccessToken: "   " }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({
      rpcCode: -32602,
    });
    await assertVaultKeyAbsent(vault, "github.pat");
  });

  test("redaction: PAT value does not appear in the JSON-serialised response", async () => {
    const PAT = "ghp_redact_me_please_xyz";
    const ctx = makeCtx({ service: "github", personalAccessToken: PAT }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, PAT);
  });
});

// ─── gitlab ─────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — gitlab", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes gitlab.pat and registers scheduler row", async () => {
    const PAT = "glpat-abc123";
    const ctx = makeCtx({ service: "gitlab", personalAccessToken: PAT }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "gitlab.pat", PAT);
    assertSchedulerRow(db, "gitlab");
  });

  test("happy path: optional apiBaseUrl writes gitlab.api_base stripped of trailing slashes", async () => {
    const PAT = "glpat-baseurl";
    const ctx = makeCtx(
      { service: "gitlab", personalAccessToken: PAT, apiBaseUrl: "https://gitlab.corp.example///" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "gitlab.api_base", "https://gitlab.corp.example");
  });

  test("happy path: omitting apiBaseUrl removes gitlab.api_base if present", async () => {
    // First set it
    await vault.set("gitlab.api_base", "https://old.example");
    const PAT = "glpat-no-base";
    const ctx = makeCtx({ service: "gitlab", personalAccessToken: PAT }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKeyAbsent(vault, "gitlab.api_base");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx({ service: "gitlab" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "gitlab.pat");
  });

  test("redaction: PAT value absent from response JSON", async () => {
    const PAT = "glpat-redact-this";
    const ctx = makeCtx({ service: "gitlab", personalAccessToken: PAT }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, PAT);
  });
});

// ─── linear ─────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — linear", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes linear.api_key and registers scheduler row", async () => {
    const KEY = "lin_api_key_abc123";
    const ctx = makeCtx({ service: "linear", personalAccessToken: KEY }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "linear.api_key", KEY);
    assertSchedulerRow(db, "linear");
  });

  test("accepts apiKey alias field", async () => {
    const KEY = "lin_api_key_alias";
    const ctx = makeCtx({ service: "linear", apiKey: KEY }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "linear.api_key", KEY);
  });

  test("error path: missing api key throws -32602", async () => {
    const ctx = makeCtx({ service: "linear" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "linear.api_key");
  });

  test("redaction: API key absent from response JSON", async () => {
    const KEY = "lin_redact_me_789";
    const ctx = makeCtx({ service: "linear", personalAccessToken: KEY }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, KEY);
  });
});

// ─── circleci ────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — circleci", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes circleci.api_token and registers scheduler row", async () => {
    const TOKEN = "circle_api_token_secret";
    const ctx = makeCtx({ service: "circleci", personalAccessToken: TOKEN }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "circleci.api_token", TOKEN);
    assertSchedulerRow(db, "circleci");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx({ service: "circleci" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "circleci.api_token");
  });

  test("redaction: token absent from response JSON", async () => {
    const TOKEN = "circle_redact_this_token";
    const ctx = makeCtx({ service: "circleci", personalAccessToken: TOKEN }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, TOKEN);
  });
});

// ─── jenkins ─────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — jenkins", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes jenkins base_url, username, api_token and scheduler row", async () => {
    const TOKEN = "jenkins_api_tok_secret";
    const ctx = makeCtx(
      {
        service: "jenkins",
        apiBaseUrl: "https://ci.example.com",
        username: "admin",
        personalAccessToken: TOKEN,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "jenkins.base_url", "https://ci.example.com");
    await assertVaultKey(vault, "jenkins.username", "admin");
    await assertVaultKey(vault, "jenkins.api_token", TOKEN);
    assertSchedulerRow(db, "jenkins");
  });

  test("strips trailing slashes from apiBaseUrl", async () => {
    const ctx = makeCtx(
      {
        service: "jenkins",
        apiBaseUrl: "https://ci.example.com///",
        username: "user",
        personalAccessToken: "tok",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "jenkins.base_url", "https://ci.example.com");
  });

  test("error path: missing apiBaseUrl throws -32602", async () => {
    const ctx = makeCtx(
      { service: "jenkins", username: "admin", personalAccessToken: "tok" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("error path: missing username throws -32602", async () => {
    const ctx = makeCtx(
      { service: "jenkins", apiBaseUrl: "https://ci.example.com", personalAccessToken: "tok" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx(
      { service: "jenkins", apiBaseUrl: "https://ci.example.com", username: "admin" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("redaction: api_token absent from response JSON", async () => {
    const TOKEN = "jenkins_redact_this";
    const ctx = makeCtx(
      {
        service: "jenkins",
        apiBaseUrl: "https://ci.example.com",
        username: "admin",
        personalAccessToken: TOKEN,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, TOKEN);
  });
});

// ─── bitbucket ───────────────────────────────────────────────────────────────

describe("handleConnectorAuth — bitbucket", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes bitbucket.username + bitbucket.app_password and scheduler row", async () => {
    const PWD = "bb_app_password_secret";
    const ctx = makeCtx(
      { service: "bitbucket", bitbucketUsername: "acme_user", personalAccessToken: PWD },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "bitbucket.username", "acme_user");
    await assertVaultKey(vault, "bitbucket.app_password", PWD);
    assertSchedulerRow(db, "bitbucket");
  });

  test("accepts plain username alias field", async () => {
    const PWD = "bb_app_pwd_alias";
    const ctx = makeCtx(
      { service: "bitbucket", username: "atlassian_user", personalAccessToken: PWD },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "bitbucket.username", "atlassian_user");
    await assertVaultKey(vault, "bitbucket.app_password", PWD);
  });

  test("error path: missing username throws -32602", async () => {
    const ctx = makeCtx(
      { service: "bitbucket", personalAccessToken: "some_pwd" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("error path: missing app password throws -32602", async () => {
    const ctx = makeCtx({ service: "bitbucket", bitbucketUsername: "user" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("redaction: app password absent from response JSON", async () => {
    const PWD = "bb_redact_this_password";
    const ctx = makeCtx(
      { service: "bitbucket", bitbucketUsername: "acme", personalAccessToken: PWD },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, PWD);
  });
});

// ─── grafana ─────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — grafana", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes grafana.url + grafana.api_token and scheduler row", async () => {
    const TOKEN = "glsa_api_token_secret";
    const ctx = makeCtx(
      {
        service: "grafana",
        apiBaseUrl: "https://grafana.example.com",
        personalAccessToken: TOKEN,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "grafana.url", "https://grafana.example.com");
    await assertVaultKey(vault, "grafana.api_token", TOKEN);
    assertSchedulerRow(db, "grafana");
  });

  test("strips trailing slashes from apiBaseUrl", async () => {
    const ctx = makeCtx(
      {
        service: "grafana",
        apiBaseUrl: "https://grafana.example.com///",
        personalAccessToken: "tok",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "grafana.url", "https://grafana.example.com");
  });

  test("error path: missing apiBaseUrl throws -32602", async () => {
    const ctx = makeCtx({ service: "grafana", personalAccessToken: "tok" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx(
      { service: "grafana", apiBaseUrl: "https://grafana.example.com" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("redaction: api_token absent from response JSON", async () => {
    const TOKEN = "glsa_redact_me_grafana";
    const ctx = makeCtx(
      {
        service: "grafana",
        apiBaseUrl: "https://grafana.example.com",
        personalAccessToken: TOKEN,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, TOKEN);
  });
});

// ─── sentry ──────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — sentry", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes sentry.auth_token + sentry.org_slug and scheduler row", async () => {
    const TOKEN = "sentry_auth_token_secret";
    const ctx = makeCtx(
      {
        service: "sentry",
        personalAccessToken: TOKEN,
        sentryOrgSlug: "my-org",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "sentry.auth_token", TOKEN);
    await assertVaultKey(vault, "sentry.org_slug", "my-org");
    assertSchedulerRow(db, "sentry");
  });

  test("happy path: optional sentryUrl writes sentry.url stripped of trailing slashes", async () => {
    const ctx = makeCtx(
      {
        service: "sentry",
        personalAccessToken: "tok",
        sentryOrgSlug: "myorg",
        sentryUrl: "https://sentry.self-hosted.example///",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "sentry.url", "https://sentry.self-hosted.example");
  });

  test("happy path: omitting sentryUrl removes sentry.url if previously set", async () => {
    await vault.set("sentry.url", "https://old-sentry.example");
    const ctx = makeCtx(
      { service: "sentry", personalAccessToken: "tok", sentryOrgSlug: "myorg" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKeyAbsent(vault, "sentry.url");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx({ service: "sentry", sentryOrgSlug: "myorg" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("error path: missing orgSlug throws -32602", async () => {
    const ctx = makeCtx({ service: "sentry", personalAccessToken: "tok" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("redaction: auth_token absent from response JSON", async () => {
    const TOKEN = "sentry_redact_this_token";
    const ctx = makeCtx(
      { service: "sentry", personalAccessToken: TOKEN, sentryOrgSlug: "org" },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, TOKEN);
  });
});

// ─── newrelic ────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — newrelic", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes newrelic.api_key and registers scheduler row", async () => {
    const KEY = "nr_user_api_key_secret";
    const ctx = makeCtx({ service: "newrelic", personalAccessToken: KEY }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "newrelic.api_key", KEY);
    assertSchedulerRow(db, "newrelic");
  });

  test("happy path: optional accountId writes newrelic.account_id", async () => {
    const ctx = makeCtx(
      { service: "newrelic", personalAccessToken: "key", newrelicAccountId: "12345" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "newrelic.account_id", "12345");
  });

  test("happy path: omitting accountId removes newrelic.account_id if present", async () => {
    await vault.set("newrelic.account_id", "old-acct");
    const ctx = makeCtx({ service: "newrelic", personalAccessToken: "key" }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKeyAbsent(vault, "newrelic.account_id");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx({ service: "newrelic" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "newrelic.api_key");
  });

  test("redaction: api_key absent from response JSON", async () => {
    const KEY = "nr_redact_me_key";
    const ctx = makeCtx({ service: "newrelic", personalAccessToken: KEY }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, KEY);
  });
});

// ─── datadog ─────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — datadog", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes datadog.api_key + datadog.app_key and scheduler row", async () => {
    const API_KEY = "dd_api_key_secret";
    const APP_KEY = "dd_app_key_secret";
    const ctx = makeCtx(
      { service: "datadog", datadogApiKey: API_KEY, datadogAppKey: APP_KEY },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "datadog.api_key", API_KEY);
    await assertVaultKey(vault, "datadog.app_key", APP_KEY);
    assertSchedulerRow(db, "datadog");
  });

  test("accepts plain apiKey/appKey alias fields", async () => {
    const API_KEY = "dd_api_alias";
    const APP_KEY = "dd_app_alias";
    const ctx = makeCtx(
      { service: "datadog", apiKey: API_KEY, appKey: APP_KEY },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "datadog.api_key", API_KEY);
    await assertVaultKey(vault, "datadog.app_key", APP_KEY);
  });

  test("happy path: optional datadogSite writes datadog.site", async () => {
    const ctx = makeCtx(
      {
        service: "datadog",
        datadogApiKey: "api",
        datadogAppKey: "app",
        datadogSite: "datadoghq.eu",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "datadog.site", "datadoghq.eu");
  });

  test("happy path: omitting datadogSite removes datadog.site if present", async () => {
    await vault.set("datadog.site", "datadoghq.com");
    const ctx = makeCtx(
      { service: "datadog", datadogApiKey: "api", datadogAppKey: "app" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKeyAbsent(vault, "datadog.site");
  });

  test("error path: missing apiKey throws -32602", async () => {
    const ctx = makeCtx({ service: "datadog", datadogAppKey: "app" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("error path: missing appKey throws -32602", async () => {
    const ctx = makeCtx({ service: "datadog", datadogApiKey: "api" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("redaction: api_key and app_key absent from response JSON", async () => {
    const API_KEY = "dd_api_redact_this";
    const APP_KEY = "dd_app_redact_this";
    const ctx = makeCtx(
      { service: "datadog", datadogApiKey: API_KEY, datadogAppKey: APP_KEY },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, API_KEY);
    assertCredentialRedacted(result, APP_KEY);
  });
});

// ─── pagerduty ───────────────────────────────────────────────────────────────

describe("handleConnectorAuth — pagerduty", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  test("happy path: writes pagerduty.api_token and registers scheduler row", async () => {
    const TOKEN = "pd_api_token_secret";
    const ctx = makeCtx({ service: "pagerduty", personalAccessToken: TOKEN }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "pagerduty.api_token", TOKEN);
    assertSchedulerRow(db, "pagerduty");
  });

  test("accepts token alias field", async () => {
    const TOKEN = "pd_token_alias";
    const ctx = makeCtx({ service: "pagerduty", token: TOKEN }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "pagerduty.api_token", TOKEN);
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx({ service: "pagerduty" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "pagerduty.api_token");
  });

  test("error path: empty token is rejected", async () => {
    const ctx = makeCtx({ service: "pagerduty", personalAccessToken: "  " }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "pagerduty.api_token");
  });

  test("redaction: api_token absent from response JSON", async () => {
    const TOKEN = "pd_redact_this_token";
    const ctx = makeCtx({ service: "pagerduty", personalAccessToken: TOKEN }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, TOKEN);
  });
});
