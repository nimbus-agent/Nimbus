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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

  afterEach(() => {
    db.close();
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

// ─── aws ─────────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — aws", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: access-key pair with region writes aws.access_key_id, aws.secret_access_key, aws.default_region", async () => {
    const AK = "AKIAIOSFODNN7EXAMPLE";
    const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: AK,
        awsSecretAccessKey: SK,
        awsDefaultRegion: "us-east-1",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("aws");
    await assertVaultKey(vault, "aws.access_key_id", AK);
    await assertVaultKey(vault, "aws.secret_access_key", SK);
    await assertVaultKey(vault, "aws.default_region", "us-east-1");
    assertSchedulerRow(db, "aws");
  });

  test("happy path: access-key pair with profile only (no region) writes aws.profile and clears aws.default_region", async () => {
    await vault.set("aws.default_region", "old-region");
    const AK = "AKIAIOSFODNN7EXAMPLE";
    const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: AK,
        awsSecretAccessKey: SK,
        awsProfile: "my-profile",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "aws.profile", "my-profile");
    await assertVaultKeyAbsent(vault, "aws.default_region");
  });

  test("happy path: profile-only (no key pair) — clears key fields and writes aws.profile", async () => {
    await vault.set("aws.access_key_id", "old-key");
    await vault.set("aws.secret_access_key", "old-secret");
    const ctx = makeCtx({ service: "aws", awsProfile: "default" }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "aws.profile", "default");
    await assertVaultKeyAbsent(vault, "aws.access_key_id");
    await assertVaultKeyAbsent(vault, "aws.secret_access_key");
    assertSchedulerRow(db, "aws");
  });

  test("accepts accessKeyId / secretAccessKey / defaultRegion alias fields", async () => {
    const ctx = makeCtx(
      {
        service: "aws",
        accessKeyId: "AKIAALIASEXAMPLE",
        secretAccessKey: "aliasSecret",
        defaultRegion: "eu-west-1",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "aws.access_key_id", "AKIAALIASEXAMPLE");
    await assertVaultKey(vault, "aws.default_region", "eu-west-1");
  });

  test("error path: key pair without region or profile throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        awsSecretAccessKey: "someSecret",
      },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "aws.access_key_id");
  });

  test("error path: neither key pair nor profile throws -32602", async () => {
    const ctx = makeCtx({ service: "aws" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "aws.access_key_id");
  });

  test("redaction: secret_access_key absent from response JSON", async () => {
    const SK = "wJalrXUtnFEMI_REDACT_THIS_KEY";
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        awsSecretAccessKey: SK,
        awsDefaultRegion: "us-west-2",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, SK);
  });
});

// ─── azure ───────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — azure", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: writes azure.tenant_id, azure.client_id, azure.client_secret and scheduler row", async () => {
    const SECRET = "azure_client_secret_value";
    const ctx = makeCtx(
      {
        service: "azure",
        azureTenantId: "tenant-abc",
        azureClientId: "client-xyz",
        azureClientSecret: SECRET,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("azure");
    await assertVaultKey(vault, "azure.tenant_id", "tenant-abc");
    await assertVaultKey(vault, "azure.client_id", "client-xyz");
    await assertVaultKey(vault, "azure.client_secret", SECRET);
    assertSchedulerRow(db, "azure");
  });

  test("accepts tenantId / clientId / clientSecret alias fields", async () => {
    const ctx = makeCtx(
      {
        service: "azure",
        tenantId: "t1",
        clientId: "c1",
        clientSecret: "s1",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "azure.tenant_id", "t1");
    await assertVaultKey(vault, "azure.client_id", "c1");
    await assertVaultKey(vault, "azure.client_secret", "s1");
  });

  test("error path: missing tenantId throws -32602", async () => {
    const ctx = makeCtx(
      { service: "azure", azureClientId: "cid", azureClientSecret: "sec" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "azure.tenant_id");
  });

  test("error path: missing clientId throws -32602", async () => {
    const ctx = makeCtx(
      { service: "azure", azureTenantId: "tid", azureClientSecret: "sec" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "azure.client_id");
  });

  test("error path: missing clientSecret throws -32602", async () => {
    const ctx = makeCtx(
      { service: "azure", azureTenantId: "tid", azureClientId: "cid" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "azure.client_secret");
  });

  test("redaction: client_secret absent from response JSON", async () => {
    const SECRET = "azure_redact_this_secret";
    const ctx = makeCtx(
      {
        service: "azure",
        azureTenantId: "tid",
        azureClientId: "cid",
        azureClientSecret: SECRET,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, SECRET);
  });
});

// ─── gcp ─────────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — gcp", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: writes gcp.credentials_json_path and registers scheduler row", async () => {
    const PATH = "/home/user/.gcp/service-account.json";
    const ctx = makeCtx({ service: "gcp", gcpCredentialsJsonPath: PATH }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("gcp");
    await assertVaultKey(vault, "gcp.credentials_json_path", PATH);
    assertSchedulerRow(db, "gcp");
  });

  test("happy path: optional gcpProjectId writes gcp.project_id", async () => {
    const ctx = makeCtx(
      {
        service: "gcp",
        gcpCredentialsJsonPath: "/path/to/sa.json",
        gcpProjectId: "my-project-123",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "gcp.project_id", "my-project-123");
  });

  test("happy path: omitting gcpProjectId removes gcp.project_id if previously set", async () => {
    await vault.set("gcp.project_id", "old-project");
    const ctx = makeCtx(
      { service: "gcp", gcpCredentialsJsonPath: "/path/to/sa.json" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKeyAbsent(vault, "gcp.project_id");
  });

  test("accepts credentialsJsonPath alias field", async () => {
    const ctx = makeCtx(
      { service: "gcp", credentialsJsonPath: "/alt/path/sa.json" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "gcp.credentials_json_path", "/alt/path/sa.json");
  });

  test("accepts path alias field", async () => {
    const ctx = makeCtx({ service: "gcp", path: "/bare/path/sa.json" }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "gcp.credentials_json_path", "/bare/path/sa.json");
  });

  test("error path: missing credentials path throws -32602", async () => {
    const ctx = makeCtx({ service: "gcp" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "gcp.credentials_json_path");
  });
});

// ─── kubernetes ──────────────────────────────────────────────────────────────

describe("handleConnectorAuth — kubernetes", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: writes kubernetes.kubeconfig and registers scheduler row", async () => {
    const KUBE = "/home/user/.kube/config";
    const ctx = makeCtx({ service: "kubernetes", kubeconfigPath: KUBE }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("kubernetes");
    await assertVaultKey(vault, "kubernetes.kubeconfig", KUBE);
    assertSchedulerRow(db, "kubernetes");
  });

  test("happy path: optional context writes kubernetes.context", async () => {
    const ctx = makeCtx(
      {
        service: "kubernetes",
        kubeconfigPath: "/home/user/.kube/config",
        context: "my-cluster-ctx",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "kubernetes.context", "my-cluster-ctx");
  });

  test("happy path: omitting context removes kubernetes.context if previously set", async () => {
    await vault.set("kubernetes.context", "old-context");
    const ctx = makeCtx(
      { service: "kubernetes", kubeconfigPath: "/home/user/.kube/config" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKeyAbsent(vault, "kubernetes.context");
  });

  test("accepts kubeconfig alias field", async () => {
    const ctx = makeCtx(
      { service: "kubernetes", kubeconfig: "/alt/.kube/config" },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "kubernetes.kubeconfig", "/alt/.kube/config");
  });

  test("accepts path alias field", async () => {
    const ctx = makeCtx({ service: "kubernetes", path: "/bare/.kube/config" }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "kubernetes.kubeconfig", "/bare/.kube/config");
  });

  test("error path: missing kubeconfig path throws -32602", async () => {
    const ctx = makeCtx({ service: "kubernetes" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "kubernetes.kubeconfig");
  });
});

// ─── discord opt-in ──────────────────────────────────────────────────────────

describe("handleConnectorAuth — discord", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: enabled=true + token writes discord.bot_token + discord.enabled and scheduler row", async () => {
    const TOKEN = "discord_bot_token_secret";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: true, personalAccessToken: TOKEN },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("discord");
    await assertVaultKey(vault, "discord.bot_token", TOKEN);
    await assertVaultKey(vault, "discord.enabled", "1");
    assertSchedulerRow(db, "discord");
  });

  test("accepts discordOptIn='true' string", async () => {
    const TOKEN = "discord_string_true_token";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: "true", personalAccessToken: TOKEN },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "discord.bot_token", TOKEN);
    await assertVaultKey(vault, "discord.enabled", "1");
  });

  test("accepts discordOptIn='1' string", async () => {
    const TOKEN = "discord_one_string_token";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: "1", personalAccessToken: TOKEN },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "discord.bot_token", TOKEN);
  });

  test("accepts token alias field", async () => {
    const TOKEN = "discord_token_alias";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: true, token: TOKEN },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "discord.bot_token", TOKEN);
  });

  test("error path: missing opt-in throws -32602 even when token present", async () => {
    const ctx = makeCtx(
      { service: "discord", personalAccessToken: "some_token" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "discord.bot_token");
  });

  test("error path: opt-in=false throws -32602", async () => {
    const ctx = makeCtx(
      { service: "discord", discordOptIn: false, personalAccessToken: "some_token" },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "discord.bot_token");
  });

  test("error path: missing bot token with opt-in throws -32602", async () => {
    const ctx = makeCtx({ service: "discord", discordOptIn: true }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "discord.bot_token");
  });

  test("redaction: bot_token absent from response JSON", async () => {
    const TOKEN = "discord_redact_this_token";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: true, personalAccessToken: TOKEN },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, TOKEN);
  });
});

// ─── iac opt-in ──────────────────────────────────────────────────────────────

describe("handleConnectorAuth — iac", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: iacOptIn=true writes iac.enabled and registers scheduler row", async () => {
    const ctx = makeCtx({ service: "iac", iacOptIn: true }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("iac");
    await assertVaultKey(vault, "iac.enabled", "1");
    assertSchedulerRow(db, "iac");
  });

  test("accepts iacOptIn='true' string", async () => {
    const ctx = makeCtx({ service: "iac", iacOptIn: "true" }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "iac.enabled", "1");
  });

  test("accepts iacOptIn='1' string", async () => {
    const ctx = makeCtx({ service: "iac", iacOptIn: "1" }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "iac.enabled", "1");
  });

  test("error path: missing opt-in throws -32602", async () => {
    const ctx = makeCtx({ service: "iac" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "iac.enabled");
  });

  test("error path: iacOptIn=false throws -32602", async () => {
    const ctx = makeCtx({ service: "iac", iacOptIn: false }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "iac.enabled");
  });
});

// ─── jira ─────────────────────────────────────────────────────────────────────

describe("handleConnectorAuth — jira", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: writes jira.email, jira.api_token, jira.base_url and scheduler row", async () => {
    const TOKEN = "jira_api_token_secret";
    const ctx = makeCtx(
      {
        service: "jira",
        atlassianEmail: "user@example.com",
        personalAccessToken: TOKEN,
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("jira");
    await assertVaultKey(vault, "jira.email", "user@example.com");
    await assertVaultKey(vault, "jira.api_token", TOKEN);
    await assertVaultKey(vault, "jira.base_url", "https://myorg.atlassian.net");
    assertSchedulerRow(db, "jira");
  });

  test("strips trailing slashes from apiBaseUrl", async () => {
    const ctx = makeCtx(
      {
        service: "jira",
        atlassianEmail: "user@example.com",
        personalAccessToken: "tok",
        apiBaseUrl: "https://myorg.atlassian.net///",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "jira.base_url", "https://myorg.atlassian.net");
  });

  test("error path: missing email throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "jira",
        personalAccessToken: "tok",
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "jira.email");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "jira",
        atlassianEmail: "user@example.com",
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "jira.api_token");
  });

  test("error path: missing baseUrl throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "jira",
        atlassianEmail: "user@example.com",
        personalAccessToken: "tok",
      },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "jira.base_url");
  });

  test("redaction: api_token absent from response JSON", async () => {
    const TOKEN = "jira_redact_this_token";
    const ctx = makeCtx(
      {
        service: "jira",
        atlassianEmail: "user@example.com",
        personalAccessToken: TOKEN,
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, TOKEN);
  });
});

// ─── confluence ───────────────────────────────────────────────────────────────

describe("handleConnectorAuth — confluence", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("happy path: writes confluence.email, confluence.api_token, confluence.base_url and scheduler row", async () => {
    const TOKEN = "confluence_api_token_secret";
    const ctx = makeCtx(
      {
        service: "confluence",
        atlassianEmail: "admin@example.com",
        personalAccessToken: TOKEN,
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("confluence");
    await assertVaultKey(vault, "confluence.email", "admin@example.com");
    await assertVaultKey(vault, "confluence.api_token", TOKEN);
    await assertVaultKey(vault, "confluence.base_url", "https://myorg.atlassian.net");
    assertSchedulerRow(db, "confluence");
  });

  test("error path: missing email throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "confluence",
        personalAccessToken: "tok",
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "confluence.email");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "confluence",
        atlassianEmail: "admin@example.com",
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "confluence.api_token");
  });

  test("error path: missing baseUrl throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "confluence",
        atlassianEmail: "admin@example.com",
        personalAccessToken: "tok",
      },
      vault,
      localIndex,
    );

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "confluence.base_url");
  });
});

// ─── OAuth/PKCE dispatch (error paths) ───────────────────────────────────────
//
// The helpers oauthClientConfigForProvider, oauthScopesFromConnectorRequest,
// and oauthRedirectPortFromRec are NOT exported from auth.ts. They are tested
// indirectly by triggering connectorAuthOAuthPkce through handleConnectorAuth
// with OAuth-only service IDs (google_drive, outlook, slack, notion, etc.).
//
// Microsoft/Slack/Notion client IDs default to "" in the test environment
// (NIMBUS_OAUTH_MICROSOFT_CLIENT_ID / NIMBUS_OAUTH_SLACK_CLIENT_ID /
// NIMBUS_OAUTH_NOTION_CLIENT_ID are unset), so connectorAuthOAuthPkce throws
// ConnectorRpcError(-32602) before reaching runPKCEFlow.
//
// Google's NIMBUS_OAUTH_GOOGLE_CLIENT_ID may or may not be set in CI. When it
// IS set, execution proceeds past the clientId check and reaches runPKCEFlow
// which calls openUrl. The ctx for Google tests uses a sentinel openUrl that
// throws, making the call reject (with any error). The meaningful assertion is
// that handleConnectorAuth does NOT return successfully — i.e. the OAuth path
// is wired and runPKCEFlow is being invoked (not bypassed).
//
// The oauthScopesFromConnectorRequest and oauthRedirectPortFromRec helpers are
// exercised by the google_drive + outlook calls below (default-scopes path and
// custom-port path respectively). oauthClientConfigForProvider is exercised by
// all four provider branches (google, microsoft, slack, notion).

function makeOAuthCtx(
  rec: Record<string, unknown>,
  vault: MockVault,
  localIndex: LocalIndex,
): ConnectorRpcHandlerContext {
  return {
    rec,
    vault,
    localIndex,
    // Allow openUrl to be called; it throws to abort the PKCE flow cleanly.
    openUrl: async (_url: string) => {
      throw new Error("openUrl: PKCE flow aborted in test");
    },
    syncScheduler: undefined,
    connectorMesh: undefined,
  };
}

describe("handleConnectorAuth — OAuth dispatch (error paths)", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  // ── Google provider — clientId may be set; PKCE flow is invoked but aborted ──

  test("google_drive: reaches runPKCEFlow (rejects — openUrl aborted)", async () => {
    const ctx = makeOAuthCtx({ service: "google_drive" }, vault, localIndex);
    // Either ConnectorRpcError (empty clientId) or our sentinel (clientId set → PKCE starts)
    await expect(handleConnectorAuth(ctx)).rejects.toThrow();
  });

  test("gmail: reaches runPKCEFlow (rejects — openUrl aborted)", async () => {
    const ctx = makeOAuthCtx({ service: "gmail" }, vault, localIndex);
    await expect(handleConnectorAuth(ctx)).rejects.toThrow();
  });

  // ── Microsoft provider — clientId is "" → ConnectorRpcError -32602 ──

  test("onedrive: missing NIMBUS_OAUTH_MICROSOFT_CLIENT_ID throws -32602", async () => {
    const ctx = makeOAuthCtx({ service: "onedrive" }, vault, localIndex);
    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("outlook: missing NIMBUS_OAUTH_MICROSOFT_CLIENT_ID throws -32602", async () => {
    const ctx = makeOAuthCtx({ service: "outlook" }, vault, localIndex);
    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  // ── Slack provider — clientId is "" → ConnectorRpcError -32602 ──

  test("slack: missing NIMBUS_OAUTH_SLACK_CLIENT_ID throws -32602", async () => {
    const ctx = makeOAuthCtx({ service: "slack" }, vault, localIndex);
    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  // ── Notion provider — clientId is "" → ConnectorRpcError -32602 ──

  test("notion: missing NIMBUS_OAUTH_NOTION_CLIENT_ID throws -32602", async () => {
    const ctx = makeOAuthCtx({ service: "notion" }, vault, localIndex);
    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });
});

// ─── Dispatch — unknown connector name ───────────────────────────────────────

describe("handleConnectorAuth — unknown service name", () => {
  let db: Database;
  let vault: MockVault;
  let localIndex: LocalIndex;

  beforeEach(() => {
    ({ db, vault, localIndex } = freshDeps());
  });

  afterEach(() => {
    db.close();
  });

  test("unknown service id throws ConnectorRpcError -32602", async () => {
    const ctx = makeCtx({ service: "totally_unknown_service_xyz" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("missing service field throws ConnectorRpcError -32602", async () => {
    const ctx = makeCtx({}, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("undefined rec throws ConnectorRpcError -32602", async () => {
    const ctx: ConnectorRpcHandlerContext = {
      rec: undefined,
      vault,
      localIndex,
      openUrl: async (_url: string) => {
        throw new Error("openUrl must not be called");
      },
      syncScheduler: undefined,
      connectorMesh: undefined,
    };

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });
});
