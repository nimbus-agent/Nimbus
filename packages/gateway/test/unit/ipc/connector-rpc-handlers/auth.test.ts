import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../../../../src/index/local-index.ts";
import { handleConnectorAuth } from "../../../../src/ipc/connector-rpc-handlers/auth.ts";
import type { ConnectorRpcHandlerContext } from "../../../../src/ipc/connector-rpc-handlers/context.ts";
import { loadSchedulerState } from "../../../../src/sync/scheduler-store.ts";
import { MockVault } from "../../../../src/vault/mock.ts";

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
    // Task 3 wires a real credential probe in front of every write for
    // github/gitlab/bitbucket/jenkins/jira. `null` means "no probe
    // registered" — it leaves `verified` at its pre-existing default and
    // keeps this suite offline/deterministic instead of hitting the real
    // provider APIs with fixture tokens.
    runCredentialProbe: async () => null,
  };
}

function freshDeps(): { db: Database; vault: MockVault; localIndex: LocalIndex } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const localIndex = new LocalIndex(db);
  const vault = new MockVault();
  return { db, vault, localIndex };
}

function assertSchedulerRow(db: Database, serviceId: string): void {
  const row = loadSchedulerState(db, serviceId);
  expect(row).not.toBeNull();
  expect(row?.service_id).toBe(serviceId);
}

async function assertVaultKey(vault: MockVault, key: string, expected: string): Promise<void> {
  const val = await vault.get(key);
  expect(val).toBe(expected);
}

async function assertVaultKeyAbsent(vault: MockVault, key: string): Promise<void> {
  const val = await vault.get(key);
  expect(val).toBeNull();
}

function assertCredentialRedacted(result: unknown, secret: string): void {
  const json = JSON.stringify(result);
  expect(json).not.toContain(secret);
}

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
    const fixture = "fixture-gh-1";
    const ctx = makeCtx({ service: "github", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect(result.kind).toBe("hit");
    const value = result.value as Record<string, unknown>;
    expect(value.ok).toBe(true);
    expect(value.serviceId).toBe("github");

    await assertVaultKey(vault, "github.pat", fixture);
    assertSchedulerRow(db, "github");
    assertSchedulerRow(db, "github_actions");
  });

  test("accepts token alias field", async () => {
    const fixture = "fixture-gh-2";
    const ctx = makeCtx({ service: "github", token: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "github.pat", fixture);
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
    const fixture = "fixture-gh-redact";
    const ctx = makeCtx({ service: "github", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-gl-1";
    const ctx = makeCtx({ service: "gitlab", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "gitlab.pat", fixture);
    assertSchedulerRow(db, "gitlab");
  });

  test("happy path: optional apiBaseUrl writes gitlab.api_base stripped of trailing slashes", async () => {
    const fixture = "fixture-gl-2";
    const ctx = makeCtx(
      {
        service: "gitlab",
        personalAccessToken: fixture,
        apiBaseUrl: "https://gitlab.corp.example///",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "gitlab.api_base", "https://gitlab.corp.example");
  });

  test("happy path: omitting apiBaseUrl removes gitlab.api_base if present", async () => {
    await vault.set("gitlab.api_base", "https://old.example");
    const fixture = "fixture-gl-3";
    const ctx = makeCtx({ service: "gitlab", personalAccessToken: fixture }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKeyAbsent(vault, "gitlab.api_base");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx({ service: "gitlab" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "gitlab.pat");
  });

  test("redaction: PAT value absent from response JSON", async () => {
    const fixture = "fixture-gl-redact";
    const ctx = makeCtx({ service: "gitlab", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-lin-1";
    const ctx = makeCtx({ service: "linear", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "linear.api_key", fixture);
    assertSchedulerRow(db, "linear");
  });

  test("accepts apiKey alias field", async () => {
    const fixture = "fixture-lin-2";
    const ctx = makeCtx({ service: "linear", apiKey: fixture }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "linear.api_key", fixture);
  });

  test("error path: missing api key throws -32602", async () => {
    const ctx = makeCtx({ service: "linear" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "linear.api_key");
  });

  test("redaction: API key absent from response JSON", async () => {
    const fixture = "fixture-lin-redact";
    const ctx = makeCtx({ service: "linear", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-circle";
    const ctx = makeCtx({ service: "circleci", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "circleci.api_token", fixture);
    assertSchedulerRow(db, "circleci");
  });

  test("error path: missing token throws -32602", async () => {
    const ctx = makeCtx({ service: "circleci" }, vault, localIndex);

    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    await assertVaultKeyAbsent(vault, "circleci.api_token");
  });

  test("redaction: token absent from response JSON", async () => {
    const fixture = "fixture-circle-redact";
    const ctx = makeCtx({ service: "circleci", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-jenkins";
    const ctx = makeCtx(
      {
        service: "jenkins",
        apiBaseUrl: "https://ci.example.com",
        username: "admin",
        personalAccessToken: fixture,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "jenkins.base_url", "https://ci.example.com");
    await assertVaultKey(vault, "jenkins.username", "admin");
    await assertVaultKey(vault, "jenkins.api_token", fixture);
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
    const fixture = "fixture-jenkins-redact";
    const ctx = makeCtx(
      {
        service: "jenkins",
        apiBaseUrl: "https://ci.example.com",
        username: "admin",
        personalAccessToken: fixture,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-bb";
    const ctx = makeCtx(
      { service: "bitbucket", bitbucketUsername: "acme_user", personalAccessToken: fixture },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "bitbucket.username", "acme_user");
    await assertVaultKey(vault, "bitbucket.app_password", fixture);
    assertSchedulerRow(db, "bitbucket");
  });

  test("accepts plain username alias field", async () => {
    const fixture = "fixture-bb-alias";
    const ctx = makeCtx(
      { service: "bitbucket", username: "atlassian_user", personalAccessToken: fixture },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "bitbucket.username", "atlassian_user");
    await assertVaultKey(vault, "bitbucket.app_password", fixture);
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
    const fixture = "fixture-bb-redact";
    const ctx = makeCtx(
      { service: "bitbucket", bitbucketUsername: "acme", personalAccessToken: fixture },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-grafana";
    const ctx = makeCtx(
      {
        service: "grafana",
        apiBaseUrl: "https://grafana.example.com",
        personalAccessToken: fixture,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "grafana.url", "https://grafana.example.com");
    await assertVaultKey(vault, "grafana.api_token", fixture);
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
    const fixture = "fixture-grafana-redact";
    const ctx = makeCtx(
      {
        service: "grafana",
        apiBaseUrl: "https://grafana.example.com",
        personalAccessToken: fixture,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-sentry";
    const ctx = makeCtx(
      {
        service: "sentry",
        personalAccessToken: fixture,
        sentryOrgSlug: "my-org",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "sentry.auth_token", fixture);
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
    const fixture = "fixture-sentry-redact";
    const ctx = makeCtx(
      { service: "sentry", personalAccessToken: fixture, sentryOrgSlug: "org" },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-newrelic";
    const ctx = makeCtx({ service: "newrelic", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "newrelic.api_key", fixture);
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
    const fixture = "fixture-newrelic-redact";
    const ctx = makeCtx({ service: "newrelic", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixtureA = "fixture-dd-api";
    const fixtureB = "fixture-dd-app";
    const ctx = makeCtx(
      { service: "datadog", datadogApiKey: fixtureA, datadogAppKey: fixtureB },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "datadog.api_key", fixtureA);
    await assertVaultKey(vault, "datadog.app_key", fixtureB);
    assertSchedulerRow(db, "datadog");
  });

  test("accepts plain apiKey/appKey alias fields", async () => {
    const fixtureA = "fixture-dd-api-alias";
    const fixtureB = "fixture-dd-app-alias";
    const ctx = makeCtx(
      { service: "datadog", apiKey: fixtureA, appKey: fixtureB },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "datadog.api_key", fixtureA);
    await assertVaultKey(vault, "datadog.app_key", fixtureB);
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
    const fixtureA = "fixture-dd-api-redact";
    const fixtureB = "fixture-dd-app-redact";
    const ctx = makeCtx(
      { service: "datadog", datadogApiKey: fixtureA, datadogAppKey: fixtureB },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixtureA);
    assertCredentialRedacted(result, fixtureB);
  });
});

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
    const fixture = "fixture-pd";
    const ctx = makeCtx({ service: "pagerduty", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    await assertVaultKey(vault, "pagerduty.api_token", fixture);
    assertSchedulerRow(db, "pagerduty");
  });

  test("accepts token alias field", async () => {
    const fixture = "fixture-pd-alias";
    const ctx = makeCtx({ service: "pagerduty", token: fixture }, vault, localIndex);
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "pagerduty.api_token", fixture);
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
    const fixture = "fixture-pd-redact";
    const ctx = makeCtx({ service: "pagerduty", personalAccessToken: fixture }, vault, localIndex);
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const awsId = "fixture-aws-id-1";
    const awsVal = "fixture-aws-val-1";
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: awsId,
        awsSecretAccessKey: awsVal,
        awsDefaultRegion: "us-east-1",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("aws");
    await assertVaultKey(vault, "aws.access_key_id", awsId);
    await assertVaultKey(vault, "aws.secret_access_key", awsVal);
    await assertVaultKey(vault, "aws.default_region", "us-east-1");
    assertSchedulerRow(db, "aws");
  });

  test("happy path: access-key pair with profile only (no region) writes aws.profile and clears aws.default_region", async () => {
    await vault.set("aws.default_region", "old-region");
    const awsId = "fixture-aws-id-1";
    const awsVal = "fixture-aws-val-1";
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: awsId,
        awsSecretAccessKey: awsVal,
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
        accessKeyId: "fixture-aws-id-alias",
        secretAccessKey: "fixture-aws-val-alias",
        defaultRegion: "eu-west-1",
      },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "aws.access_key_id", "fixture-aws-id-alias");
    await assertVaultKey(vault, "aws.default_region", "eu-west-1");
  });

  test("error path: key pair without region or profile throws -32602", async () => {
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: "fixture-aws-id-1",
        awsSecretAccessKey: "fixture-aws-val-err",
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
    const awsVal = "fixture-aws-redact";
    const ctx = makeCtx(
      {
        service: "aws",
        awsAccessKeyId: "fixture-aws-id-1",
        awsSecretAccessKey: awsVal,
        awsDefaultRegion: "us-west-2",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, awsVal);
  });
});

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
    const fixture = "fixture-azure";
    const ctx = makeCtx(
      {
        service: "azure",
        azureTenantId: "tenant-abc",
        azureClientId: "client-xyz",
        azureClientSecret: fixture,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("azure");
    await assertVaultKey(vault, "azure.tenant_id", "tenant-abc");
    await assertVaultKey(vault, "azure.client_id", "client-xyz");
    await assertVaultKey(vault, "azure.client_secret", fixture);
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
    const fixture = "fixture-azure-redact";
    const ctx = makeCtx(
      {
        service: "azure",
        azureTenantId: "tid",
        azureClientId: "cid",
        azureClientSecret: fixture,
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-discord";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: true, personalAccessToken: fixture },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("discord");
    await assertVaultKey(vault, "discord.bot_token", fixture);
    await assertVaultKey(vault, "discord.enabled", "1");
    assertSchedulerRow(db, "discord");
  });

  test("accepts discordOptIn='true' string", async () => {
    const fixture = "fixture-discord-str-true";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: "true", personalAccessToken: fixture },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "discord.bot_token", fixture);
    await assertVaultKey(vault, "discord.enabled", "1");
  });

  test("accepts discordOptIn='1' string", async () => {
    const fixture = "fixture-discord-str-one";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: "1", personalAccessToken: fixture },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "discord.bot_token", fixture);
  });

  test("accepts token alias field", async () => {
    const fixture = "fixture-discord-alias";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: true, token: fixture },
      vault,
      localIndex,
    );
    await handleConnectorAuth(ctx);

    await assertVaultKey(vault, "discord.bot_token", fixture);
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
    const fixture = "fixture-discord-redact";
    const ctx = makeCtx(
      { service: "discord", discordOptIn: true, personalAccessToken: fixture },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-jira";
    const ctx = makeCtx(
      {
        service: "jira",
        atlassianEmail: "user@example.com",
        personalAccessToken: fixture,
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("jira");
    await assertVaultKey(vault, "jira.email", "user@example.com");
    await assertVaultKey(vault, "jira.api_token", fixture);
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
    const fixture = "fixture-jira-redact";
    const ctx = makeCtx(
      {
        service: "jira",
        atlassianEmail: "user@example.com",
        personalAccessToken: fixture,
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    assertCredentialRedacted(result, fixture);
  });
});

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
    const fixture = "fixture-confluence";
    const ctx = makeCtx(
      {
        service: "confluence",
        atlassianEmail: "admin@example.com",
        personalAccessToken: fixture,
        apiBaseUrl: "https://myorg.atlassian.net",
      },
      vault,
      localIndex,
    );
    const result = await handleConnectorAuth(ctx);

    expect((result.value as Record<string, unknown>).ok).toBe(true);
    expect((result.value as Record<string, unknown>).serviceId).toBe("confluence");
    await assertVaultKey(vault, "confluence.email", "admin@example.com");
    await assertVaultKey(vault, "confluence.api_token", fixture);
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

function makeOAuthCtx(
  rec: Record<string, unknown>,
  vault: MockVault,
  localIndex: LocalIndex,
): ConnectorRpcHandlerContext {
  return {
    rec,
    vault,
    localIndex,
    openUrl: async (_url: string) => {
      throw new Error("openUrl: PKCE flow aborted in test");
    },
    syncScheduler: undefined,
    connectorMesh: undefined,
  };
}

const GOOGLE_CLIENT_ID_FOR_TESTS = process.env["NIMBUS_OAUTH_GOOGLE_CLIENT_ID"] ?? "";

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

  if (GOOGLE_CLIENT_ID_FOR_TESTS === "") {
    test("google_drive: missing NIMBUS_OAUTH_GOOGLE_CLIENT_ID throws -32602", async () => {
      const ctx = makeOAuthCtx({ service: "google_drive" }, vault, localIndex);
      await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    });

    test("gmail: missing NIMBUS_OAUTH_GOOGLE_CLIENT_ID throws -32602", async () => {
      const ctx = makeOAuthCtx({ service: "gmail" }, vault, localIndex);
      await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
    });
  } else {
    test("google_drive: reaches runPKCEFlow (rejects — openUrl sentinel)", async () => {
      const ctx = makeOAuthCtx({ service: "google_drive" }, vault, localIndex);
      await expect(handleConnectorAuth(ctx)).rejects.toThrow("openUrl: PKCE flow aborted in test");
    });

    test("gmail: reaches runPKCEFlow (rejects — openUrl sentinel)", async () => {
      const ctx = makeOAuthCtx({ service: "gmail" }, vault, localIndex);
      await expect(handleConnectorAuth(ctx)).rejects.toThrow("openUrl: PKCE flow aborted in test");
    });
  }

  // Each service needs its provider's client-id env var; absent it, auth is a -32602.
  test.each([
    ["onedrive", "NIMBUS_OAUTH_MICROSOFT_CLIENT_ID"],
    ["outlook", "NIMBUS_OAUTH_MICROSOFT_CLIENT_ID"],
    ["slack", "NIMBUS_OAUTH_SLACK_CLIENT_ID"],
    ["notion", "NIMBUS_OAUTH_NOTION_CLIENT_ID"],
  ])("%s: missing %s throws -32602", async (service) => {
    const ctx = makeOAuthCtx({ service }, vault, localIndex);
    await expect(handleConnectorAuth(ctx)).rejects.toMatchObject({ rpcCode: -32602 });
  });
});

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
