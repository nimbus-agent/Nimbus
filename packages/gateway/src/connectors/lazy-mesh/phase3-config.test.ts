/**
 * Direct unit tests for `connectors/lazy-mesh/phase3-config.ts` —
 * each `phase3Add<Service>Mcp` helper has a credential-presence short-
 * circuit (no spawn) and a credentials-present branch (wraps ServerSpec
 * via the sandbox wrapper).
 *
 * These tests bypass `LazyConnectorMesh` and exercise the helpers
 * directly with a `MockVault` seeded per test. The successful spawn
 * branch is validated by inspecting the resulting `ServerSpec`: it must
 * carry a sandbox-wrapper command and the sandbox-control env vars
 * (`NIMBUS_SANDBOX_MANIFEST_JSON`, `NIMBUS_SANDBOX_CWD`) — both proofs
 * that the I15 wiring fired without going through MCPClient.
 */

import { describe, expect, test } from "bun:test";

import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  buildPhase3Servers,
  phase3AddAwsMcp,
  phase3AddAzureMcp,
  phase3AddDatadogMcp,
  phase3AddGcpMcp,
  phase3AddGrafanaMcp,
  phase3AddIacMcp,
  phase3AddNewrelicMcp,
  phase3AddSentryMcp,
  phase3AddSnykMcp,
  phase3AddSonarqubeMcp,
} from "./phase3-config.ts";
import type { ServerSpec } from "./slot.ts";

const SANDBOX_CWD = "/tmp/phase3-test-cwd";

function readManifest(spec: ServerSpec): { permissions: { network: string[] } } {
  const raw = spec.env?.["NIMBUS_SANDBOX_MANIFEST_JSON"];
  expect(typeof raw).toBe("string");
  return JSON.parse(raw ?? "{}") as { permissions: { network: string[] } };
}

function expectSandboxed(spec: ServerSpec, expectedHost?: string): void {
  // Wrapped specs carry the sandbox-control env vars and a command that
  // points at process.execPath — never the raw "bun" the helper passes.
  expect(spec.command).toBe(process.execPath);
  expect(spec.env?.["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
  expect(spec.env?.["NIMBUS_SANDBOX_CWD"]).toBe(SANDBOX_CWD);
  if (expectedHost !== undefined) {
    const manifest = readManifest(spec);
    expect(manifest.permissions.network).toContain(expectedHost);
  }
}

// ─── phase3AddAwsMcp ─────────────────────────────────────────────────────────

describe("phase3AddAwsMcp", () => {
  test("no-op when no creds present", async () => {
    const vault: NimbusVault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAwsMcp(vault, servers, SANDBOX_CWD);
    expect(servers["aws"]).toBeUndefined();
  });

  test("no-op when only access_key_id is set (no secret + no region/profile)", async () => {
    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA000");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAwsMcp(vault, servers, SANDBOX_CWD);
    expect(servers["aws"]).toBeUndefined();
  });

  test("spawns with full creds + region", async () => {
    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA0001");
    await vault.set("aws.secret_access_key", "SK0001");
    await vault.set("aws.default_region", "us-east-1");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAwsMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["aws"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["AWS_ACCESS_KEY_ID"]).toBe("AKIA0001");
    expect(spec.env?.["AWS_SECRET_ACCESS_KEY"]).toBe("SK0001");
    expect(spec.env?.["AWS_DEFAULT_REGION"]).toBe("us-east-1");
  });

  test("spawns with profile-only creds (no access keys)", async () => {
    const vault = createMockVault();
    await vault.set("aws.profile", "dev");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAwsMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["aws"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["AWS_PROFILE"]).toBe("dev");
    expect(spec.env?.["AWS_ACCESS_KEY_ID"]).toBeUndefined();
  });

  test("spawns with full creds + profile + region (extra env set)", async () => {
    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA0001");
    await vault.set("aws.secret_access_key", "SK0001");
    await vault.set("aws.default_region", "us-west-2");
    await vault.set("aws.profile", "dev");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAwsMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["aws"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["AWS_PROFILE"]).toBe("dev");
  });
});

// ─── phase3AddAzureMcp ───────────────────────────────────────────────────────

describe("phase3AddAzureMcp", () => {
  test("no-op when any of tenant/client/secret missing", async () => {
    const vault = createMockVault();
    await vault.set("azure.tenant_id", "T");
    await vault.set("azure.client_id", "C");
    // secret missing
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAzureMcp(vault, servers, SANDBOX_CWD);
    expect(servers["azure"]).toBeUndefined();
  });

  test("spawns when all three creds present", async () => {
    const vault = createMockVault();
    await vault.set("azure.tenant_id", "T");
    await vault.set("azure.client_id", "C");
    await vault.set("azure.client_secret", "S");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAzureMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["azure"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["AZURE_TENANT_ID"]).toBe("T");
    expect(spec.env?.["AZURE_CLIENT_ID"]).toBe("C");
    expect(spec.env?.["AZURE_CLIENT_SECRET"]).toBe("S");
  });
});

// ─── phase3AddGcpMcp ─────────────────────────────────────────────────────────

describe("phase3AddGcpMcp", () => {
  test("no-op without credentials_json_path", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGcpMcp(vault, servers, SANDBOX_CWD);
    expect(servers["gcp"]).toBeUndefined();
  });

  test("spawns with GOOGLE_APPLICATION_CREDENTIALS set", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGcpMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["gcp"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["GOOGLE_APPLICATION_CREDENTIALS"]).toBe("/etc/gcp.json");
  });
});

// ─── phase3AddIacMcp ─────────────────────────────────────────────────────────

describe("phase3AddIacMcp", () => {
  test("no-op when iac.enabled is unset", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddIacMcp(vault, servers, SANDBOX_CWD);
    expect(servers["iac"]).toBeUndefined();
  });

  test("no-op when iac.enabled is not exactly '1'", async () => {
    const vault = createMockVault();
    await vault.set("iac.enabled", "0");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddIacMcp(vault, servers, SANDBOX_CWD);
    expect(servers["iac"]).toBeUndefined();
  });

  test("spawns when iac.enabled='1'", async () => {
    const vault = createMockVault();
    await vault.set("iac.enabled", "1");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddIacMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["iac"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
  });
});

// ─── phase3AddGrafanaMcp ─────────────────────────────────────────────────────

describe("phase3AddGrafanaMcp", () => {
  test("no-op without url + token", async () => {
    const vault = createMockVault();
    await vault.set("grafana.url", "https://grafana.example.com");
    // token missing
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGrafanaMcp(vault, servers, SANDBOX_CWD);
    expect(servers["grafana"]).toBeUndefined();
  });

  test("spawns + merges the parsed hostname into manifest.permissions.network", async () => {
    const vault = createMockVault();
    await vault.set("grafana.url", "https://grafana.example.com");
    await vault.set("grafana.api_token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGrafanaMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["grafana"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "grafana.example.com");
    expect(spec.env?.["GRAFANA_URL"]).toBe("https://grafana.example.com");
    expect(spec.env?.["GRAFANA_API_TOKEN"]).toBe("tok");
  });

  test("spawns even when grafana.url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("grafana.url", "not a url");
    await vault.set("grafana.api_token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGrafanaMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["grafana"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    // Empty network host list (or whatever the base manifest is); the
    // important property is that the call did not throw.
    expect(spec.env?.["GRAFANA_URL"]).toBe("not a url");
  });
});

// ─── phase3AddSentryMcp ──────────────────────────────────────────────────────

describe("phase3AddSentryMcp", () => {
  test("no-op without token + org", async () => {
    const vault = createMockVault();
    await vault.set("sentry.auth_token", "tok");
    // org missing
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSentryMcp(vault, servers, SANDBOX_CWD);
    expect(servers["sentry"]).toBeUndefined();
  });

  test("spawns with token + org (no SENTRY_URL)", async () => {
    const vault = createMockVault();
    await vault.set("sentry.auth_token", "tok");
    await vault.set("sentry.org_slug", "acme");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSentryMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["sentry"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["SENTRY_AUTH_TOKEN"]).toBe("tok");
    expect(spec.env?.["SENTRY_ORG_SLUG"]).toBe("acme");
    expect(spec.env?.["SENTRY_URL"]).toBeUndefined();
  });

  test("spawns with optional SENTRY_URL set", async () => {
    const vault = createMockVault();
    await vault.set("sentry.auth_token", "tok");
    await vault.set("sentry.org_slug", "acme");
    await vault.set("sentry.url", "https://sentry.acme.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSentryMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["sentry"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["SENTRY_URL"]).toBe("https://sentry.acme.com");
  });
});

// ─── phase3AddNewrelicMcp ────────────────────────────────────────────────────

describe("phase3AddNewrelicMcp", () => {
  test("no-op without api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddNewrelicMcp(vault, servers, SANDBOX_CWD);
    expect(servers["newrelic"]).toBeUndefined();
  });

  test("spawns with NEW_RELIC_API_KEY set", async () => {
    const vault = createMockVault();
    await vault.set("newrelic.api_key", "nrk");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddNewrelicMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["newrelic"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["NEW_RELIC_API_KEY"]).toBe("nrk");
  });
});

// ─── phase3AddDatadogMcp ─────────────────────────────────────────────────────

describe("phase3AddDatadogMcp", () => {
  test("no-op without api_key + app_key", async () => {
    const vault = createMockVault();
    await vault.set("datadog.api_key", "ak");
    // app_key missing
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatadogMcp(vault, servers, SANDBOX_CWD);
    expect(servers["datadog"]).toBeUndefined();
  });

  test("spawns with api_key + app_key (no DD_SITE)", async () => {
    const vault = createMockVault();
    await vault.set("datadog.api_key", "ak");
    await vault.set("datadog.app_key", "appk");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatadogMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["datadog"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["DD_API_KEY"]).toBe("ak");
    expect(spec.env?.["DD_APP_KEY"]).toBe("appk");
    expect(spec.env?.["DD_SITE"]).toBeUndefined();
  });

  test("spawns with optional DD_SITE set", async () => {
    const vault = createMockVault();
    await vault.set("datadog.api_key", "ak");
    await vault.set("datadog.app_key", "appk");
    await vault.set("datadog.site", "eu");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatadogMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["datadog"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["DD_SITE"]).toBe("eu");
  });
});

// ─── phase3AddSnykMcp ────────────────────────────────────────────────────────

describe("phase3AddSnykMcp", () => {
  test("no-op without snyk.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnykMcp(vault, servers, SANDBOX_CWD);
    expect(servers["snyk"]).toBeUndefined();
  });

  test("no-op when snyk.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("snyk.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnykMcp(vault, servers, SANDBOX_CWD);
    expect(servers["snyk"]).toBeUndefined();
  });

  test("spawns with SNYK_TOKEN set + api.snyk.io in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("snyk.token", "snyk-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnykMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["snyk"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.snyk.io");
    expect(spec.env?.["SNYK_TOKEN"]).toBe("snyk-test-token");
  });
});

// ─── phase3AddSonarqubeMcp ──────────────────────────────────────────────────

describe("phase3AddSonarqubeMcp", () => {
  test("no-op without sonarqube.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSonarqubeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["sonarqube"]).toBeUndefined();
  });

  test("no-op when sonarqube.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("sonarqube.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSonarqubeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["sonarqube"]).toBeUndefined();
  });

  test("spawns with SONARQUBE_TOKEN set + sonarcloud.io in manifest network list (SaaS default)", async () => {
    const vault = createMockVault();
    await vault.set("sonarqube.token", "sq-test-token");
    await vault.set("sonarqube.organization", "acme");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSonarqubeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["sonarqube"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "sonarcloud.io");
    expect(spec.env?.["SONARQUBE_TOKEN"]).toBe("sq-test-token");
    expect(spec.env?.["SONARQUBE_ORGANIZATION"]).toBe("acme");
    // No URL override → env var omitted.
    expect(spec.env?.["SONARQUBE_URL"]).toBeUndefined();
  });

  test("URL override is propagated as SONARQUBE_URL env when present", async () => {
    const vault = createMockVault();
    await vault.set("sonarqube.token", "sq");
    await vault.set("sonarqube.url", "https://sonar.example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSonarqubeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["sonarqube"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["SONARQUBE_URL"]).toBe("https://sonar.example.com");
  });
});

// ─── buildPhase3Servers (aggregator) ────────────────────────────────────────

describe("buildPhase3Servers", () => {
  test("returns an empty map when the vault has no Phase-3 creds", async () => {
    const vault = createMockVault();
    const servers = await buildPhase3Servers(vault, SANDBOX_CWD);
    expect(servers).toEqual({});
  });

  test("aggregates every Phase-3 service whose creds are present", async () => {
    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA0");
    await vault.set("aws.secret_access_key", "S0");
    await vault.set("aws.default_region", "us-east-1");
    await vault.set("azure.tenant_id", "T");
    await vault.set("azure.client_id", "C");
    await vault.set("azure.client_secret", "S");
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    await vault.set("iac.enabled", "1");
    await vault.set("grafana.url", "https://g.example.com");
    await vault.set("grafana.api_token", "g");
    await vault.set("sentry.auth_token", "st");
    await vault.set("sentry.org_slug", "acme");
    await vault.set("newrelic.api_key", "nrk");
    await vault.set("datadog.api_key", "ak");
    await vault.set("datadog.app_key", "appk");
    await vault.set("snyk.token", "snyk-tok");
    const servers = await buildPhase3Servers(vault, SANDBOX_CWD);
    expect(Object.keys(servers).sort()).toEqual(
      ["aws", "azure", "datadog", "gcp", "grafana", "iac", "newrelic", "sentry", "snyk"].sort(),
    );
    // Each server should be wrapped via the sandbox wrapper.
    for (const id of Object.keys(servers)) {
      expectSandboxed(servers[id] as ServerSpec);
    }
  });

  test("skips services whose preconditions fail (partial seed)", async () => {
    const vault = createMockVault();
    // Only AWS minimum and GCP — others must not appear.
    await vault.set("aws.access_key_id", "AKIA0");
    await vault.set("aws.secret_access_key", "S0");
    await vault.set("aws.default_region", "us-east-1");
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    const servers = await buildPhase3Servers(vault, SANDBOX_CWD);
    expect(Object.keys(servers).sort()).toEqual(["aws", "gcp"]);
  });
});
