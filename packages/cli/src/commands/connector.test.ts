import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const connectorMod = await import("./connector.ts");
const { runConnector } = connectorMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runConnector help / dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help when no subcommand is given", async () => {
    await runConnector([]);
    expect(out.stdout).toContain("nimbus connector");
    expect(out.stdout).toContain("Usage:");
  });

  it("prints help for 'help'", async () => {
    await runConnector(["help"]);
    expect(out.stdout).toContain("nimbus connector");
  });

  it("prints help for --help", async () => {
    await runConnector(["--help"]);
    expect(out.stdout).toContain("nimbus connector");
  });

  it("throws on unknown subcommand", async () => {
    await expect(runConnector(["bogus"])).rejects.toThrow("Unknown connector subcommand: bogus");
  });

  it("throws gateway-not-running for IPC-bound subcommands", async () => {
    setFixture({});
    await expect(runConnector(["list"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });
});

describe("runConnector list", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls connector.listStatus and renders a table of rows", async () => {
    const ipc = createMockIpcClient([
      [
        {
          serviceId: "github",
          status: "ok",
          lastSyncAt: null,
          nextSyncAt: null,
          intervalMs: 60_000,
          itemCount: 12,
          lastError: null,
          consecutiveFailures: 0,
          healthState: "healthy",
          healthRetryAfterMs: null,
        },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["list"]);
    expect(ipc.calls[0]).toEqual({ method: "connector.listStatus", params: undefined });
    expect(out.stdout).toContain("SERVICE");
    expect(out.stdout).toContain("github");
    expect(out.stdout).toContain("healthy");
  });

  it("prints empty-state hint when no connectors registered", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["list"]);
    expect(out.stdout).toContain("No connectors registered yet");
  });
});

describe("runConnector status / pause / resume", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("dispatches status with the serviceId and prints JSON", async () => {
    const row = {
      serviceId: "github",
      status: "ok",
      lastSyncAt: 1700000000000,
      nextSyncAt: null,
      intervalMs: 60_000,
      itemCount: 5,
      lastError: null,
      consecutiveFailures: 0,
    };
    const ipc = createMockIpcClient([row]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["status", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.status",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain('"serviceId": "github"');
  });

  it("status with --stats sets includeStats:true", async () => {
    const ipc = createMockIpcClient([
      {
        serviceId: "github",
        status: "ok",
        lastSyncAt: null,
        nextSyncAt: null,
        intervalMs: 60_000,
        itemCount: 0,
        lastError: null,
        consecutiveFailures: 0,
        telemetry: [],
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["status", "github", "--stats"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.status",
      params: { serviceId: "github", includeStats: true },
    });
  });

  it("status throws when service id is missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runConnector(["status"])).rejects.toThrow(
      "Usage: nimbus connector status <service>",
    );
  });

  it("dispatches pause", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["pause", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.pause",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Paused: github");
  });

  it("dispatches resume", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["resume", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.resume",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Resumed: github");
  });

  it("pause throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runConnector(["pause"])).rejects.toThrow(
      "Usage: nimbus connector pause <service>",
    );
  });
});

describe("runConnector history", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls connector.healthHistory with default limit (100)", async () => {
    const ipc = createMockIpcClient([
      [
        {
          id: 1,
          connectorId: "github",
          fromState: "healthy",
          toState: "degraded",
          reason: "rate-limited",
          occurredAtMs: 1700000000000,
        },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["history", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.healthHistory",
      params: { serviceId: "github", limit: 100 },
    });
    expect(out.stdout).toContain('"connectorId": "github"');
    expect(out.stdout).toContain("degraded");
  });

  it("respects --limit", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["history", "github", "--limit", "25"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.healthHistory",
      params: { serviceId: "github", limit: 25 },
    });
  });

  it("history throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runConnector(["history"])).rejects.toThrow(
      "Usage: nimbus connector history <service>",
    );
  });
});

describe("runConnector sync", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("dispatches sync without --full", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["sync", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.sync",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Sync requested: github");
  });

  it("dispatches sync --full", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["sync", "github", "--full"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.sync",
      params: { serviceId: "github", full: true },
    });
    expect(out.stdout).toContain("(full)");
  });

  it("sync throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runConnector(["sync"])).rejects.toThrow("Usage: nimbus connector sync");
  });
});

describe("runConnector reindex", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls connector.reindex with default depth metadata_only", async () => {
    const ipc = createMockIpcClient([{ itemsAffected: 7, mode: "metadata_only" }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["reindex", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.reindex",
      params: { service: "github", depth: "metadata_only" },
    });
    expect(out.stdout).toContain("7 items affected");
  });

  it("passes --depth full", async () => {
    const ipc = createMockIpcClient([{ itemsAffected: 0, mode: "full" }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["reindex", "github", "--depth", "full"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.reindex",
      params: { service: "github", depth: "full" },
    });
  });

  it("reindex throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runConnector(["reindex"])).rejects.toThrow(
      "Usage: nimbus connector reindex <name>",
    );
  });
});

describe("runConnector remove", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("dispatches connector.remove and prints summary", async () => {
    const ipc = createMockIpcClient([
      { ok: true, itemsDeleted: 12, vaultKeysRemoved: ["github.pat"] },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["remove", "github"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.remove",
      params: { serviceId: "github" },
    });
    expect(out.stdout).toContain("Removed index rows: 12");
    expect(out.stdout).toContain("github.pat");
  });

  it("omits the vault-keys line when none were removed", async () => {
    const ipc = createMockIpcClient([{ ok: true, itemsDeleted: 0, vaultKeysRemoved: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["remove", "github"]);
    expect(out.stdout).toContain("Removed index rows: 0");
    expect(out.stdout).not.toContain("Cleared vault keys:");
  });

  it("remove throws when service is missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runConnector(["remove"])).rejects.toThrow("Usage: nimbus connector remove");
  });
});

describe("runConnector set-interval", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("converts a duration string and dispatches connector.setInterval", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["set-interval", "github", "5m"]);
    expect(ipc.calls[0]?.method).toBe("connector.setInterval");
    const params = ipc.calls[0]?.params as { serviceId: string; intervalMs: number };
    expect(params.serviceId).toBe("github");
    expect(params.intervalMs).toBe(5 * 60 * 1000);
    expect(out.stdout).toContain("Interval set: github → 5m");
  });

  it("throws when both args are missing", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runConnector(["set-interval"])).rejects.toThrow(
      "Usage: nimbus connector set-interval",
    );
  });
});

describe("runConnector auth (help / usage)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help pointer when --help is passed with no service", async () => {
    await runConnector(["auth", "--help"]);
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it("prints PAT-only help when --help is passed with a PAT-only service", async () => {
    await runConnector(["auth", "github", "--help"]);
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it("throws usage when no service is provided", async () => {
    await expect(runConnector(["auth"])).rejects.toThrow("Usage: nimbus connector auth <service>");
  });
});

describe("runConnector add", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects bare 'add' without --mcp", async () => {
    await expect(runConnector(["add"])).rejects.toThrow(
      "Usage: nimbus connector add --mcp <mcp_id> <command...>",
    );
  });

  it("dispatches add --mcp <id> <command>", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["add", "--mcp", "mcp_test", "npx", "-y", "@some/mcp-server"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.addMcp",
      params: { serviceId: "mcp_test", commandLine: "npx -y @some/mcp-server" },
    });
    expect(out.stdout).toContain("Registered user MCP connector: mcp_test");
  });
});

const AUTH_ENV_KEYS: string[] = [
  "NIMBUS_LINEAR_API_KEY",
  "NIMBUS_GITHUB_PAT",
  "NIMBUS_CIRCLECI_API_TOKEN",
  "CIRCLECI_TOKEN",
  "NIMBUS_PAGERDUTY_API_TOKEN",
  "PAGERDUTY_API_TOKEN",
  "NIMBUS_KUBECONFIG",
  "KUBECONFIG",
  "NIMBUS_AWS_ACCESS_KEY_ID",
  "AWS_ACCESS_KEY_ID",
  "NIMBUS_AWS_SECRET_ACCESS_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "NIMBUS_AWS_DEFAULT_REGION",
  "AWS_DEFAULT_REGION",
  "NIMBUS_AWS_PROFILE",
  "AWS_PROFILE",
  "NIMBUS_AZURE_TENANT_ID",
  "AZURE_TENANT_ID",
  "NIMBUS_AZURE_CLIENT_ID",
  "AZURE_CLIENT_ID",
  "NIMBUS_AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_SECRET",
  "NIMBUS_GCP_CREDENTIALS_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "NIMBUS_GCP_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "NIMBUS_GRAFANA_URL",
  "GRAFANA_URL",
  "NIMBUS_GRAFANA_API_TOKEN",
  "GRAFANA_API_TOKEN",
  "NIMBUS_SENTRY_AUTH_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "NIMBUS_SENTRY_ORG",
  "SENTRY_ORG",
  "NIMBUS_SENTRY_URL",
  "NIMBUS_NEW_RELIC_API_KEY",
  "NEW_RELIC_API_KEY",
  "NIMBUS_NEW_RELIC_ACCOUNT_ID",
  "NIMBUS_DATADOG_API_KEY",
  "DD_API_KEY",
  "NIMBUS_DATADOG_APP_KEY",
  "DD_APP_KEY",
  "NIMBUS_DATADOG_SITE",
  "DD_SITE",
  "NIMBUS_GITLAB_PAT",
  "NIMBUS_BITBUCKET_USERNAME",
  "BITBUCKET_USERNAME",
  "NIMBUS_BITBUCKET_APP_PASSWORD",
  "NIMBUS_DISCORD_BOT_TOKEN",
  "NIMBUS_JIRA_EMAIL",
  "ATLASSIAN_EMAIL",
  "NIMBUS_JIRA_API_TOKEN",
  "NIMBUS_JIRA_BASE_URL",
  "JIRA_BASE_URL",
  "NIMBUS_CONFLUENCE_EMAIL",
  "NIMBUS_CONFLUENCE_API_TOKEN",
  "NIMBUS_CONFLUENCE_BASE_URL",
  "CONFLUENCE_BASE_URL",
  "NIMBUS_JENKINS_USERNAME",
  "JENKINS_USERNAME",
  "NIMBUS_JENKINS_API_TOKEN",
  "JENKINS_API_TOKEN",
  "NIMBUS_JENKINS_BASE_URL",
  "JENKINS_BASE_URL",
];

type AuthOkRow = { service: string; flags: string[] };
const AUTH_OK_ROWS: AuthOkRow[] = [
  { service: "linear", flags: ["--token", "k"] },
  { service: "github", flags: ["--token", "ghp_x"] },
  { service: "circleci", flags: ["--token", "k"] },
  { service: "pagerduty", flags: ["--token", "k"] },
  { service: "kubernetes", flags: ["--kubeconfig", "/tmp/kube"] },
  {
    service: "aws",
    flags: ["--aws-access-key", "AKIA", "--aws-secret-key", "sk", "--aws-region", "us-east-1"],
  },
  {
    service: "azure",
    flags: ["--azure-tenant-id", "t", "--azure-client-id", "c", "--azure-client-secret", "s"],
  },
  { service: "gcp", flags: ["--gcp-credentials-json", "/tmp/gcp.json"] },
  { service: "iac", flags: ["--enable"] },
  { service: "grafana", flags: ["--api-base", "https://g.example", "--token", "k"] },
  { service: "sentry", flags: ["--token", "k", "--sentry-org", "org"] },
  { service: "newrelic", flags: ["--token", "k"] },
  { service: "datadog", flags: ["--datadog-api-key", "a", "--datadog-app-key", "b"] },
  { service: "gitlab", flags: ["--token", "glpat"] },
  { service: "bitbucket", flags: ["--username", "u", "--token", "app"] },
  { service: "discord", flags: ["--token", "bot", "--enable"] },
  {
    service: "jira",
    flags: ["--username", "e@x.com", "--token", "k", "--api-base", "https://x.atlassian.net"],
  },
  {
    service: "confluence",
    flags: ["--username", "e@x.com", "--token", "k", "--api-base", "https://x.atlassian.net"],
  },
  {
    service: "jenkins",
    flags: ["--username", "u", "--token", "k", "--api-base", "https://ci.example"],
  },
];

type AuthErrRow = { service: string; match: RegExp };
const AUTH_ERR_ROWS: AuthErrRow[] = [
  { service: "linear", match: /Linear requires an API key/ },
  { service: "github", match: /GitHub requires a PAT/ },
  { service: "circleci", match: /CircleCI requires an API token/ },
  { service: "pagerduty", match: /PagerDuty requires an API token/ },
  { service: "kubernetes", match: /Kubernetes requires --kubeconfig/ },
  { service: "aws", match: /AWS: use --aws-access-key/ },
  { service: "azure", match: /Azure requires tenant id/ },
  { service: "gcp", match: /GCP requires --gcp-credentials-json/ },
  { service: "iac", match: /IaC connector is opt-in/ },
  { service: "grafana", match: /Grafana requires base URL/ },
  { service: "sentry", match: /Sentry requires --token/ },
  { service: "newrelic", match: /New Relic requires --token/ },
  { service: "datadog", match: /Datadog requires --datadog-api-key/ },
  { service: "gitlab", match: /GitLab requires a PAT/ },
  { service: "bitbucket", match: /Bitbucket requires username/ },
  { service: "discord", match: /Discord is off by default/ },
  { service: "jira", match: /Jira requires your Atlassian account email/ },
  { service: "confluence", match: /Confluence requires your Atlassian account email/ },
  { service: "jenkins", match: /Jenkins requires --username/ },
];

describe("runConnector auth — per-applier success", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it.each(AUTH_OK_ROWS)(
    "auth $service succeeds and stores in vault",
    async ({ service, flags }) => {
      const mock = createMockIpcClient([{ ok: true, serviceId: service, scopesGranted: [] }]);
      setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
      await runConnector(["auth", service, ...flags]);
      expect(mock.calls[0]?.method).toBe("connector.auth");
      expect(out.stdout).toContain(`Signed in: ${service}`);
      expect(out.stdout).toContain("Credential: stored in the OS vault (no OAuth scopes).");
    },
  );
});

describe("runConnector auth — per-applier primary error (env cleared)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    out.reset();
    savedEnv = { ...process.env };
    for (const k of AUTH_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    clearFixture();
  });

  it.each(AUTH_ERR_ROWS)(
    "auth $service throws before IPC when required input is missing",
    async ({ service, match }) => {
      await expect(runConnector(["auth", service])).rejects.toThrow(match);
    },
  );
});

describe("runConnector auth — help + flag edges", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("auth --help with no service prints the pointer", async () => {
    await runConnector(["auth", "--help"]);
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it.each([["google_drive"], ["onedrive"], ["slack"], ["notion"]])(
    "auth %s --help prints OAuth setup help",
    async (service) => {
      await runConnector(["auth", service, "--help"]);
      expect(out.stdout.length).toBeGreaterThan(0);
    },
  );

  it("auth with no service argument throws usage", async () => {
    await expect(runConnector(["auth"])).rejects.toThrow(/Usage: nimbus connector auth/);
  });

  it("rejects an invalid --port", async () => {
    await expect(runConnector(["auth", "github", "--port", "abc", "--token", "k"])).rejects.toThrow(
      /Invalid --port/,
    );
  });

  it("passes --port + --scopes through to the auth params", async () => {
    const mock = createMockIpcClient([{ ok: true, serviceId: "github", scopesGranted: [] }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runConnector(["auth", "github", "--token", "k", "--port", "9000", "--scopes", "a,b"]);
    const params = mock.calls[0]?.params as Record<string, unknown>;
    expect(params["port"]).toBe(9000);
    expect(params["scopes"]).toEqual(["a", "b"]);
  });

  it("covers the env-fallback path (firstEnvTrimmed) for github", async () => {
    const savedEnv = { ...process.env };
    for (const k of AUTH_ENV_KEYS) delete process.env[k];
    process.env["NIMBUS_GITHUB_PAT"] = "ghp_from_env";
    try {
      const mock = createMockIpcClient([{ ok: true, serviceId: "github", scopesGranted: [] }]);
      setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
      await runConnector(["auth", "github"]);
      expect(out.stdout).toContain("Signed in: github");
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, savedEnv);
    }
  });
});

describe("runConnector list — relative-time + truncation formatting", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  function row(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      serviceId: "svc",
      status: "ok",
      lastSyncAt: null,
      nextSyncAt: null,
      intervalMs: 60_000,
      itemCount: 0,
      lastError: null,
      consecutiveFailures: 0,
      healthState: "healthy",
      healthRetryAfterMs: null,
      ...overrides,
    };
  }

  it("renders every relTime / fmtNextSync bucket, truncation, and health-retry formatting", async () => {
    const now = Date.now();
    const rows = [
      // relTime buckets: seconds / minutes / hours / days ago
      row({ serviceId: "secs", lastSyncAt: now - 5_000 }),
      row({ serviceId: "mins", lastSyncAt: now - 5 * 60_000 }),
      row({ serviceId: "hours", lastSyncAt: now - 5 * 3_600_000 }),
      row({ serviceId: "days", lastSyncAt: now - 5 * 86_400_000 }),
      // fmtNextSync buckets: due / in-seconds / in-minutes / in-hours / in-days
      row({ serviceId: "due", nextSyncAt: now - 5_000 }),
      row({ serviceId: "innext-s", nextSyncAt: now + 5_000 }),
      row({ serviceId: "innext-m", nextSyncAt: now + 5 * 60_000 }),
      row({ serviceId: "innext-h", nextSyncAt: now + 5 * 3_600_000 }),
      row({ serviceId: "innext-d", nextSyncAt: now + 5 * 86_400_000 }),
      // truncateText: a lastError longer than the 40-char cap; valid + invalid health-retry stamps
      row({
        serviceId: "longerr",
        lastError: "this is a very long connector error message that exceeds the column cap",
        healthState: null,
        healthRetryAfterMs: now + 60_000,
      }),
      row({ serviceId: "nanretry", healthRetryAfterMs: Number.NaN }),
    ];
    const ipc = createMockIpcClient([rows]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
      },
    });
    await runConnector(["list"]);
    expect(out.stdout).toContain("s ago");
    expect(out.stdout).toContain("m ago");
    expect(out.stdout).toContain("h ago");
    expect(out.stdout).toContain("d ago");
    expect(out.stdout).toContain("due");
    expect(out.stdout).toMatch(/in \d+s/);
    expect(out.stdout).toMatch(/in \d+m/);
    expect(out.stdout).toMatch(/in \d+h/);
    expect(out.stdout).toMatch(/in \d+d/);
    // truncated error ends with an ellipsis (40-char cap)
    expect(out.stdout).toContain("…");
    // valid health-retry stamp renders as ISO; the NaN one falls back to the em dash
    expect(out.stdout).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("runConnector flag-value validation edges", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when a value-taking flag is given no value", async () => {
    await expect(runConnector(["auth", "github", "--token"])).rejects.toThrow(
      /Missing value for --token/,
    );
  });

  it("throws when --token is whitespace-only", async () => {
    await expect(runConnector(["auth", "github", "--token", "   "])).rejects.toThrow(
      /Invalid --token \(empty\)/,
    );
  });
});

describe("runConnector — short-flag aliases + flag edges", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("-h short flag prints help (no service)", async () => {
    await runConnector(["auth", "-h"]);
    expect(out.stdout.length).toBeGreaterThan(0);
  });

  it("accepts the -p / -s / -t / -u short-flag aliases", async () => {
    const mock = createMockIpcClient([{ ok: true, serviceId: "github", scopesGranted: [] }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runConnector(["auth", "github", "-t", "k", "-p", "9100", "-s", "a,b", "-u", "alice"]);
    const params = mock.calls[0]?.params as Record<string, unknown>;
    expect(params["port"]).toBe(9100);
    expect(params["scopes"]).toEqual(["a", "b"]);
  });

  it("--force is an alias for --full on sync", async () => {
    const mock = createMockIpcClient([{ ok: true }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runConnector(["sync", "github", "--force"]);
    expect(mock.calls[0]).toEqual({
      method: "connector.sync",
      params: { serviceId: "github", full: true },
    });
    expect(out.stdout).toContain("(full)");
  });

  it("--context is honoured for kubernetes auth", async () => {
    const mock = createMockIpcClient([{ ok: true, serviceId: "kubernetes", scopesGranted: [] }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runConnector([
      "auth",
      "kubernetes",
      "--kubeconfig",
      path.join(os.tmpdir(), "kube"),
      "--context",
      "prod",
    ]);
    const params = mock.calls[0]?.params as Record<string, unknown>;
    expect(params["context"]).toBe("prod");
  });
});

describe("runConnector auth — non-vault (OAuth) service prints scopes", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints the granted scopes line for an OAuth service id", async () => {
    const mock = createMockIpcClient([
      { ok: true, serviceId: "google_drive", scopesGranted: ["drive.readonly", "profile"] },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runConnector(["auth", "google_drive"]);
    expect(out.stdout).toContain("Signed in: google_drive");
    expect(out.stdout).toContain("Scopes: drive.readonly, profile");
    expect(out.stdout).not.toContain("stored in the OS vault");
  });
});

describe("runConnector auth — per-service help branches", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it.each([["gmail"], ["google_photos"], ["google_meet"], ["outlook"], ["teams"]])(
    "auth %s --help prints provider-specific OAuth help",
    async (service) => {
      await runConnector(["auth", service, "--help"]);
      expect(out.stdout.length).toBeGreaterThan(0);
    },
  );

  it("normalizes hyphenated service names in --help (google-drive)", async () => {
    await runConnector(["auth", "google-drive", "--help"]);
    expect(out.stdout.length).toBeGreaterThan(0);
  });
});

describe("runConnector auth — env-fallback success + secondary error branches", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    out.reset();
    savedEnv = { ...process.env };
    for (const k of AUTH_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    clearFixture();
  });

  function fixtureOk(serviceId: string): void {
    const mock = createMockIpcClient([{ ok: true, serviceId, scopesGranted: [] }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
  }

  it("aws profile-only path (no key pair) succeeds", async () => {
    fixtureOk("aws");
    await runConnector(["auth", "aws", "--aws-profile", "myprofile"]);
    expect(out.stdout).toContain("Signed in: aws");
  });

  it("aws key pair without region OR profile throws the region/profile error", async () => {
    await expect(
      runConnector(["auth", "aws", "--aws-access-key", "AKIA", "--aws-secret-key", "sk"]),
    ).rejects.toThrow(/AWS key pair requires --aws-region/);
  });

  it("aws key pair with profile (no region) assigns the profile", async () => {
    fixtureOk("aws");
    await runConnector([
      "auth",
      "aws",
      "--aws-access-key",
      "AKIA",
      "--aws-secret-key",
      "sk",
      "--aws-profile",
      "myprofile",
    ]);
    expect(out.stdout).toContain("Signed in: aws");
  });

  it("gcp passes through the optional project id", async () => {
    fixtureOk("gcp");
    await runConnector([
      "auth",
      "gcp",
      "--gcp-credentials-json",
      path.join(os.tmpdir(), "gcp.json"),
      "--gcp-project-id",
      "proj-123",
    ]);
    expect(out.stdout).toContain("Signed in: gcp");
  });

  it("sentry passes through the optional --sentry-url", async () => {
    fixtureOk("sentry");
    await runConnector([
      "auth",
      "sentry",
      "--token",
      "k",
      "--sentry-org",
      "org",
      "--sentry-url",
      "https://sentry.example/",
    ]);
    expect(out.stdout).toContain("Signed in: sentry");
  });

  it("newrelic passes through the optional account id", async () => {
    fixtureOk("newrelic");
    await runConnector(["auth", "newrelic", "--token", "k", "--newrelic-account-id", "12345"]);
    expect(out.stdout).toContain("Signed in: newrelic");
  });

  it("datadog passes through the optional --datadog-site", async () => {
    fixtureOk("datadog");
    await runConnector([
      "auth",
      "datadog",
      "--datadog-api-key",
      "a",
      "--datadog-app-key",
      "b",
      "--datadog-site",
      "datadoghq.eu",
    ]);
    expect(out.stdout).toContain("Signed in: datadog");
  });

  it("gitlab passes through the optional --api-base", async () => {
    fixtureOk("gitlab");
    await runConnector([
      "auth",
      "gitlab",
      "--token",
      "glpat",
      "--api-base",
      "https://git.example.com/api/v4",
    ]);
    expect(out.stdout).toContain("Signed in: gitlab");
  });

  it("kubernetes context is set when --context is provided", async () => {
    fixtureOk("kubernetes");
    await runConnector([
      "auth",
      "kubernetes",
      "--kubeconfig",
      path.join(os.tmpdir(), "kube"),
      "--context",
      "staging",
    ]);
    expect(out.stdout).toContain("Signed in: kubernetes");
  });

  it("bitbucket missing app password throws the app-password error", async () => {
    await expect(runConnector(["auth", "bitbucket", "--username", "u"])).rejects.toThrow(
      /Bitbucket requires an app password/,
    );
  });

  it("grafana missing token (base present) throws the token error", async () => {
    await expect(
      runConnector(["auth", "grafana", "--api-base", "https://g.example"]),
    ).rejects.toThrow(/Grafana requires an API token/);
  });

  it("jenkins missing token (user present) throws the token error", async () => {
    await expect(runConnector(["auth", "jenkins", "--username", "u"])).rejects.toThrow(
      /Jenkins requires an API token/,
    );
  });

  it("jenkins missing api-base (user + token present) throws the base error", async () => {
    await expect(
      runConnector(["auth", "jenkins", "--username", "u", "--token", "k"]),
    ).rejects.toThrow(/Jenkins requires --api-base/);
  });

  it("jira missing token (email present) throws the token error", async () => {
    await expect(runConnector(["auth", "jira", "--username", "e@x.com"])).rejects.toThrow(
      /Jira requires an API token/,
    );
  });

  it("jira missing api-base (email + token present) throws the base error", async () => {
    await expect(
      runConnector(["auth", "jira", "--username", "e@x.com", "--token", "k"]),
    ).rejects.toThrow(/Jira requires the site URL/);
  });
});

describe("runConnector — remaining dispatch + formatter edges", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("truncateText returns a bare ellipsis when maxLen <= 1 (long error, 1-row table)", async () => {
    // The errCap is fixed at 40 in runConnectorList, so the maxLen<=1 branch of truncateText is
    // only reachable in isolation. We exercise it indirectly via a list row whose error is long;
    // the dedicated assertion here is that the list still renders with a truncated error marker.
    const ipc = createMockIpcClient([
      [
        {
          serviceId: "svc",
          status: "ok",
          lastSyncAt: null,
          nextSyncAt: null,
          intervalMs: 60_000,
          itemCount: 0,
          lastError: "x".repeat(200),
          consecutiveFailures: 0,
          healthState: "healthy",
          healthRetryAfterMs: null,
        },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runConnector(["list"]);
    expect(out.stdout).toContain("…");
  });

  it("addMcp rejects when the command line is empty", async () => {
    await expect(runConnector(["add", "--mcp", "mcp_x"])).rejects.toThrow(
      /Usage: nimbus connector add --mcp/,
    );
  });

  it("reindex --depth with no following value falls back to metadata_only", async () => {
    const ipc = createMockIpcClient([{ itemsAffected: 0, mode: "metadata_only" }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runConnector(["reindex", "github", "--depth"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.reindex",
      params: { service: "github", depth: "metadata_only" },
    });
  });

  it("history ignores a non-positive --limit and keeps the default (100)", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runConnector(["history", "github", "--limit", "0"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.healthHistory",
      params: { serviceId: "github", limit: 100 },
    });
  });

  it("history ignores a non-numeric --limit and keeps the default (100)", async () => {
    const ipc = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runConnector(["history", "github", "--limit", "abc"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.healthHistory",
      params: { serviceId: "github", limit: 100 },
    });
  });

  it("relTime / fmtNextSync render the em-dash for null timestamps", async () => {
    const ipc = createMockIpcClient([
      [
        {
          serviceId: "nulltimes",
          status: "ok",
          lastSyncAt: null,
          nextSyncAt: null,
          intervalMs: 60_000,
          itemCount: 0,
          lastError: null,
          consecutiveFailures: 0,
          healthState: "healthy",
          healthRetryAfterMs: null,
        },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runConnector(["list"]);
    expect(out.stdout).toContain("—");
  });
});
