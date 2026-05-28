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
  phase3AddArgocdMcp,
  phase3AddAwsMcp,
  phase3AddAzureMcp,
  phase3AddDatabricksMcp,
  phase3AddDatadogMcp,
  phase3AddDbtMcp,
  phase3AddFlagsmithMcp,
  phase3AddFluxMcp,
  phase3AddGcpMcp,
  phase3AddGrafanaMcp,
  phase3AddGreenhouseMcp,
  phase3AddIacMcp,
  phase3AddIntercomMcp,
  phase3AddLaunchdarklyMcp,
  phase3AddLeverMcp,
  phase3AddMercuryMcp,
  phase3AddMetabaseMcp,
  phase3AddMlflowMcp,
  phase3AddNetlifyMcp,
  phase3AddNewrelicMcp,
  phase3AddPipedriveMcp,
  phase3AddRaindropMcp,
  phase3AddReadwiseMcp,
  phase3AddSemgrepMcp,
  phase3AddSentryMcp,
  phase3AddSnykMcp,
  phase3AddSonarqubeMcp,
  phase3AddStackoverflowMcp,
  phase3AddStripeMcp,
  phase3AddSupersetMcp,
  phase3AddVercelMcp,
  phase3AddWizMcp,
  phase3AddZendeskMcp,
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

// ─── phase3AddSemgrepMcp ────────────────────────────────────────────────────

describe("phase3AddSemgrepMcp", () => {
  test("no-op without semgrep.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSemgrepMcp(vault, servers, SANDBOX_CWD);
    expect(servers["semgrep"]).toBeUndefined();
  });

  test("no-op when semgrep.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("semgrep.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSemgrepMcp(vault, servers, SANDBOX_CWD);
    expect(servers["semgrep"]).toBeUndefined();
  });

  test("spawns with SEMGREP_TOKEN set + semgrep.dev in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("semgrep.token", "semgrep-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSemgrepMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["semgrep"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "semgrep.dev");
    expect(spec.env?.["SEMGREP_TOKEN"]).toBe("semgrep-test-token");
    expect(spec.env?.["SEMGREP_DEPLOYMENT_SLUG"]).toBeUndefined();
  });

  test("deployment_slug is propagated as SEMGREP_DEPLOYMENT_SLUG env when present", async () => {
    const vault = createMockVault();
    await vault.set("semgrep.token", "sg");
    await vault.set("semgrep.deployment_slug", "acme-corp");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSemgrepMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["semgrep"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["SEMGREP_DEPLOYMENT_SLUG"]).toBe("acme-corp");
  });
});

// ─── phase3AddWizMcp ─────────────────────────────────────────────────────────

describe("phase3AddWizMcp", () => {
  test("no-op without wiz.client_id / wiz.client_secret", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddWizMcp(vault, servers, SANDBOX_CWD);
    expect(servers["wiz"]).toBeUndefined();
  });

  test("no-op when only wiz.client_id is set (secret missing)", async () => {
    const vault = createMockVault();
    await vault.set("wiz.client_id", "client-abc");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddWizMcp(vault, servers, SANDBOX_CWD);
    expect(servers["wiz"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("wiz.client_id", "   ");
    await vault.set("wiz.client_secret", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddWizMcp(vault, servers, SANDBOX_CWD);
    expect(servers["wiz"]).toBeUndefined();
  });

  test("spawns with WIZ_CLIENT_ID/SECRET set + api.app.wiz.io in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("wiz.client_id", "client-abc");
    await vault.set("wiz.client_secret", "secret-xyz");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddWizMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["wiz"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.app.wiz.io");
    expect(spec.env?.["WIZ_CLIENT_ID"]).toBe("client-abc");
    expect(spec.env?.["WIZ_CLIENT_SECRET"]).toBe("secret-xyz");
    // Regional override env vars are absent unless explicitly configured.
    expect(spec.env?.["WIZ_API_URL"]).toBeUndefined();
    expect(spec.env?.["WIZ_AUTH_URL"]).toBeUndefined();
  });

  test("regional api_url / auth_url propagate as WIZ_API_URL / WIZ_AUTH_URL env when present", async () => {
    const vault = createMockVault();
    await vault.set("wiz.client_id", "c");
    await vault.set("wiz.client_secret", "s");
    await vault.set("wiz.api_url", "https://api.us2.app.wiz.io/graphql");
    await vault.set("wiz.auth_url", "https://auth.us2.app.wiz.io/oauth/token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddWizMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["wiz"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["WIZ_API_URL"]).toBe("https://api.us2.app.wiz.io/graphql");
    expect(spec.env?.["WIZ_AUTH_URL"]).toBe("https://auth.us2.app.wiz.io/oauth/token");
  });
});

// ─── phase3AddLaunchdarklyMcp ────────────────────────────────────────────────

describe("phase3AddLaunchdarklyMcp", () => {
  test("no-op without launchdarkly.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    expect(servers["launchdarkly"]).toBeUndefined();
  });

  test("no-op when launchdarkly.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("launchdarkly.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    expect(servers["launchdarkly"]).toBeUndefined();
  });

  test("spawns with LAUNCHDARKLY_TOKEN set + app.launchdarkly.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("launchdarkly.token", "api-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["launchdarkly"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "app.launchdarkly.com");
    expect(spec.env?.["LAUNCHDARKLY_TOKEN"]).toBe("api-test-token");
    expect(spec.env?.["LAUNCHDARKLY_BASE_URL"]).toBeUndefined();
  });

  test("base_url override propagates as LAUNCHDARKLY_BASE_URL env when present", async () => {
    const vault = createMockVault();
    await vault.set("launchdarkly.token", "tok");
    await vault.set("launchdarkly.base_url", "https://app.launchdarkly.us");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["launchdarkly"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["LAUNCHDARKLY_BASE_URL"]).toBe("https://app.launchdarkly.us");
  });
});

// ─── phase3AddFlagsmithMcp ───────────────────────────────────────────────────

describe("phase3AddFlagsmithMcp", () => {
  test("no-op without flagsmith.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFlagsmithMcp(vault, servers, SANDBOX_CWD);
    expect(servers["flagsmith"]).toBeUndefined();
  });

  test("no-op when flagsmith.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("flagsmith.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFlagsmithMcp(vault, servers, SANDBOX_CWD);
    expect(servers["flagsmith"]).toBeUndefined();
  });

  test("spawns with FLAGSMITH_TOKEN set + api.flagsmith.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("flagsmith.token", "fs-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFlagsmithMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["flagsmith"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.flagsmith.com");
    expect(spec.env?.["FLAGSMITH_TOKEN"]).toBe("fs-test-token");
    expect(spec.env?.["FLAGSMITH_API_BASE"]).toBeUndefined();
  });

  test("api_base override propagates as FLAGSMITH_API_BASE env when present", async () => {
    const vault = createMockVault();
    await vault.set("flagsmith.token", "tok");
    await vault.set("flagsmith.api_base", "https://flagsmith.internal.example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFlagsmithMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["flagsmith"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["FLAGSMITH_API_BASE"]).toBe("https://flagsmith.internal.example.com");
  });
});

// ─── phase3AddArgocdMcp ──────────────────────────────────────────────────────

describe("phase3AddArgocdMcp", () => {
  test("no-op without argocd.url + argocd.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddArgocdMcp(vault, servers, SANDBOX_CWD);
    expect(servers["argocd"]).toBeUndefined();
  });

  test("no-op when only argocd.url is set (token missing)", async () => {
    const vault = createMockVault();
    await vault.set("argocd.url", "https://argocd.example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddArgocdMcp(vault, servers, SANDBOX_CWD);
    expect(servers["argocd"]).toBeUndefined();
  });

  test("no-op when only argocd.token is set (url missing)", async () => {
    const vault = createMockVault();
    await vault.set("argocd.token", "jwt-tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddArgocdMcp(vault, servers, SANDBOX_CWD);
    expect(servers["argocd"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("argocd.url", "   ");
    await vault.set("argocd.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddArgocdMcp(vault, servers, SANDBOX_CWD);
    expect(servers["argocd"]).toBeUndefined();
  });

  test("spawns with ARGOCD_URL/ARGOCD_TOKEN env + the parsed host in the manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("argocd.url", "https://argocd.example.com");
    await vault.set("argocd.token", "jwt-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddArgocdMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["argocd"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "argocd.example.com");
    expect(spec.env?.["ARGOCD_URL"]).toBe("https://argocd.example.com");
    expect(spec.env?.["ARGOCD_TOKEN"]).toBe("jwt-test-token");
  });

  test("spawns even when argocd.url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("argocd.url", "not a url");
    await vault.set("argocd.token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddArgocdMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["argocd"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["ARGOCD_URL"]).toBe("not a url");
  });
});

// ─── phase3AddFluxMcp ────────────────────────────────────────────────────────

describe("phase3AddFluxMcp", () => {
  test("no-op without flux.api_url + flux.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFluxMcp(vault, servers, SANDBOX_CWD);
    expect(servers["flux"]).toBeUndefined();
  });

  test("no-op when only flux.api_url is set (token missing)", async () => {
    const vault = createMockVault();
    await vault.set("flux.api_url", "https://k8s.example.com:6443");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFluxMcp(vault, servers, SANDBOX_CWD);
    expect(servers["flux"]).toBeUndefined();
  });

  test("no-op when only flux.token is set (api_url missing)", async () => {
    const vault = createMockVault();
    await vault.set("flux.token", "sa-jwt");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFluxMcp(vault, servers, SANDBOX_CWD);
    expect(servers["flux"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("flux.api_url", "   ");
    await vault.set("flux.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFluxMcp(vault, servers, SANDBOX_CWD);
    expect(servers["flux"]).toBeUndefined();
  });

  test("spawns with FLUX_API_URL/FLUX_TOKEN env + the parsed host in the manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("flux.api_url", "https://k8s.example.com:6443");
    await vault.set("flux.token", "sa-jwt-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFluxMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["flux"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "k8s.example.com");
    expect(spec.env?.["FLUX_API_URL"]).toBe("https://k8s.example.com:6443");
    expect(spec.env?.["FLUX_TOKEN"]).toBe("sa-jwt-token");
  });

  test("spawns even when flux.api_url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("flux.api_url", "not a url");
    await vault.set("flux.token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFluxMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["flux"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["FLUX_API_URL"]).toBe("not a url");
  });
});

// ─── phase3AddDbtMcp ─────────────────────────────────────────────────────────

describe("phase3AddDbtMcp", () => {
  test("no-op without dbt.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDbtMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dbt"]).toBeUndefined();
  });

  test("no-op when dbt.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("dbt.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDbtMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dbt"]).toBeUndefined();
  });

  test("spawns with DBT_TOKEN set + cloud.getdbt.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("dbt.token", "dbt-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDbtMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["dbt"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "cloud.getdbt.com");
    expect(spec.env?.["DBT_TOKEN"]).toBe("dbt-test-token");
    expect(spec.env?.["DBT_API_BASE"]).toBeUndefined();
  });

  test("api_base override propagates as DBT_API_BASE env when present", async () => {
    const vault = createMockVault();
    await vault.set("dbt.token", "tok");
    await vault.set("dbt.api_base", "https://emea.dbt.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDbtMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["dbt"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["DBT_API_BASE"]).toBe("https://emea.dbt.com");
  });
});

// ─── phase3AddMetabaseMcp ────────────────────────────────────────────────────

describe("phase3AddMetabaseMcp", () => {
  test("no-op without metabase.url + metabase.api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMetabaseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["metabase"]).toBeUndefined();
  });

  test("no-op when only metabase.url is set (api_key missing)", async () => {
    const vault = createMockVault();
    await vault.set("metabase.url", "https://acme.metabaseapp.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMetabaseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["metabase"]).toBeUndefined();
  });

  test("no-op when only metabase.api_key is set (url missing)", async () => {
    const vault = createMockVault();
    await vault.set("metabase.api_key", "mb-key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMetabaseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["metabase"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("metabase.url", "   ");
    await vault.set("metabase.api_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMetabaseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["metabase"]).toBeUndefined();
  });

  test("spawns with METABASE_URL/METABASE_API_KEY env + the parsed host in the manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("metabase.url", "https://acme.metabaseapp.com");
    await vault.set("metabase.api_key", "mb-key-test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMetabaseMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["metabase"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "acme.metabaseapp.com");
    expect(spec.env?.["METABASE_URL"]).toBe("https://acme.metabaseapp.com");
    expect(spec.env?.["METABASE_API_KEY"]).toBe("mb-key-test");
  });

  test("spawns even when metabase.url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("metabase.url", "not a url");
    await vault.set("metabase.api_key", "k");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMetabaseMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["metabase"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["METABASE_URL"]).toBe("not a url");
  });
});

// ─── phase3AddSupersetMcp ────────────────────────────────────────────────────

describe("phase3AddSupersetMcp", () => {
  test("no-op without any of url / username / password", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSupersetMcp(vault, servers, SANDBOX_CWD);
    expect(servers["superset"]).toBeUndefined();
  });

  test("no-op when password is missing (url + username only)", async () => {
    const vault = createMockVault();
    await vault.set("superset.url", "https://superset.acme.com");
    await vault.set("superset.username", "reader");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSupersetMcp(vault, servers, SANDBOX_CWD);
    expect(servers["superset"]).toBeUndefined();
  });

  test("no-op when username is missing (url + password only)", async () => {
    const vault = createMockVault();
    await vault.set("superset.url", "https://superset.acme.com");
    await vault.set("superset.password", "pw");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSupersetMcp(vault, servers, SANDBOX_CWD);
    expect(servers["superset"]).toBeUndefined();
  });

  test("no-op when url is missing (username + password only)", async () => {
    const vault = createMockVault();
    await vault.set("superset.username", "reader");
    await vault.set("superset.password", "pw");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSupersetMcp(vault, servers, SANDBOX_CWD);
    expect(servers["superset"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("superset.url", "   ");
    await vault.set("superset.username", "   ");
    await vault.set("superset.password", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSupersetMcp(vault, servers, SANDBOX_CWD);
    expect(servers["superset"]).toBeUndefined();
  });

  test("spawns with all three env vars + the parsed host in the manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("superset.url", "https://superset.acme.com");
    await vault.set("superset.username", "reader");
    await vault.set("superset.password", "pw-secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSupersetMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["superset"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "superset.acme.com");
    expect(spec.env?.["SUPERSET_URL"]).toBe("https://superset.acme.com");
    expect(spec.env?.["SUPERSET_USERNAME"]).toBe("reader");
    expect(spec.env?.["SUPERSET_PASSWORD"]).toBe("pw-secret");
  });

  test("spawns even when superset.url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("superset.url", "not a url");
    await vault.set("superset.username", "reader");
    await vault.set("superset.password", "pw");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSupersetMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["superset"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["SUPERSET_URL"]).toBe("not a url");
  });
});

// ─── phase3AddDatabricksMcp ──────────────────────────────────────────────────

describe("phase3AddDatabricksMcp", () => {
  test("no-op without databricks.host + databricks.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatabricksMcp(vault, servers, SANDBOX_CWD);
    expect(servers["databricks"]).toBeUndefined();
  });

  test("no-op when only databricks.host is set (token missing)", async () => {
    const vault = createMockVault();
    await vault.set("databricks.host", "https://dbc-abc123.cloud.databricks.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatabricksMcp(vault, servers, SANDBOX_CWD);
    expect(servers["databricks"]).toBeUndefined();
  });

  test("no-op when only databricks.token is set (host missing)", async () => {
    const vault = createMockVault();
    await vault.set("databricks.token", "dapi-tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatabricksMcp(vault, servers, SANDBOX_CWD);
    expect(servers["databricks"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("databricks.host", "   ");
    await vault.set("databricks.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatabricksMcp(vault, servers, SANDBOX_CWD);
    expect(servers["databricks"]).toBeUndefined();
  });

  test("spawns with DATABRICKS_HOST/DATABRICKS_TOKEN env + the parsed host in the manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("databricks.host", "https://dbc-abc123.cloud.databricks.com");
    await vault.set("databricks.token", "dapi-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatabricksMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["databricks"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "dbc-abc123.cloud.databricks.com");
    expect(spec.env?.["DATABRICKS_HOST"]).toBe("https://dbc-abc123.cloud.databricks.com");
    expect(spec.env?.["DATABRICKS_TOKEN"]).toBe("dapi-test-token");
  });

  test("spawns even when databricks.host is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("databricks.host", "not a url");
    await vault.set("databricks.token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDatabricksMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["databricks"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["DATABRICKS_HOST"]).toBe("not a url");
  });
});

// ─── phase3AddMlflowMcp ──────────────────────────────────────────────────────

describe("phase3AddMlflowMcp", () => {
  test("no-op without mlflow.host + mlflow.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMlflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["mlflow"]).toBeUndefined();
  });

  test("no-op when only mlflow.host is set (token missing)", async () => {
    const vault = createMockVault();
    await vault.set("mlflow.host", "https://mlflow.acme.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMlflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["mlflow"]).toBeUndefined();
  });

  test("no-op when only mlflow.token is set (host missing)", async () => {
    const vault = createMockVault();
    await vault.set("mlflow.token", "mlflow-tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMlflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["mlflow"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("mlflow.host", "   ");
    await vault.set("mlflow.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMlflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["mlflow"]).toBeUndefined();
  });

  test("spawns with MLFLOW_HOST/MLFLOW_TOKEN env + the parsed host in the manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("mlflow.host", "https://mlflow.acme.com");
    await vault.set("mlflow.token", "mlflow-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMlflowMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["mlflow"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "mlflow.acme.com");
    expect(spec.env?.["MLFLOW_HOST"]).toBe("https://mlflow.acme.com");
    expect(spec.env?.["MLFLOW_TOKEN"]).toBe("mlflow-test-token");
  });

  test("spawns even when mlflow.host is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("mlflow.host", "not a url");
    await vault.set("mlflow.token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMlflowMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["mlflow"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["MLFLOW_HOST"]).toBe("not a url");
  });
});

// ─── phase3AddVercelMcp ──────────────────────────────────────────────────────

describe("phase3AddVercelMcp", () => {
  test("no-op without vercel.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVercelMcp(vault, servers, SANDBOX_CWD);
    expect(servers["vercel"]).toBeUndefined();
  });

  test("no-op when vercel.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("vercel.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVercelMcp(vault, servers, SANDBOX_CWD);
    expect(servers["vercel"]).toBeUndefined();
  });

  test("spawns with VERCEL_TOKEN set + api.vercel.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("vercel.token", "vc-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVercelMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["vercel"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.vercel.com");
    expect(spec.env?.["VERCEL_TOKEN"]).toBe("vc-test-token");
    expect(spec.env?.["VERCEL_TEAM_ID"]).toBeUndefined();
  });

  test("team_id propagates as VERCEL_TEAM_ID env when present", async () => {
    const vault = createMockVault();
    await vault.set("vercel.token", "tok");
    await vault.set("vercel.team_id", "team_xyz");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVercelMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["vercel"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["VERCEL_TEAM_ID"]).toBe("team_xyz");
  });
});

// ─── phase3AddNetlifyMcp ─────────────────────────────────────────────────────

describe("phase3AddNetlifyMcp", () => {
  test("no-op without netlify.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddNetlifyMcp(vault, servers, SANDBOX_CWD);
    expect(servers["netlify"]).toBeUndefined();
  });

  test("no-op when netlify.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("netlify.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddNetlifyMcp(vault, servers, SANDBOX_CWD);
    expect(servers["netlify"]).toBeUndefined();
  });

  test("spawns with NETLIFY_TOKEN set + api.netlify.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("netlify.token", "nf-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddNetlifyMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["netlify"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.netlify.com");
    expect(spec.env?.["NETLIFY_TOKEN"]).toBe("nf-test-token");
  });
});

// ─── phase3AddStripeMcp ──────────────────────────────────────────────────────

describe("phase3AddStripeMcp", () => {
  test("no-op without stripe.api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStripeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["stripe"]).toBeUndefined();
  });

  test("no-op when stripe.api_key is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("stripe.api_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStripeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["stripe"]).toBeUndefined();
  });

  test("spawns with STRIPE_API_KEY set + api.stripe.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("stripe.api_key", "sk_test_token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStripeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["stripe"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.stripe.com");
    expect(spec.env?.["STRIPE_API_KEY"]).toBe("sk_test_token");
  });
});

// ─── phase3AddMercuryMcp ─────────────────────────────────────────────────────

describe("phase3AddMercuryMcp", () => {
  test("no-op without mercury.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMercuryMcp(vault, servers, SANDBOX_CWD);
    expect(servers["mercury"]).toBeUndefined();
  });

  test("no-op when mercury.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("mercury.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMercuryMcp(vault, servers, SANDBOX_CWD);
    expect(servers["mercury"]).toBeUndefined();
  });

  test("spawns with MERCURY_TOKEN set + api.mercury.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("mercury.token", "mercury_test_token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMercuryMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["mercury"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.mercury.com");
    expect(spec.env?.["MERCURY_TOKEN"]).toBe("mercury_test_token");
  });
});

// ─── phase3AddReadwiseMcp ────────────────────────────────────────────────────

describe("phase3AddReadwiseMcp", () => {
  test("no-op without readwise.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddReadwiseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["readwise"]).toBeUndefined();
  });

  test("no-op when readwise.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("readwise.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddReadwiseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["readwise"]).toBeUndefined();
  });

  test("spawns with READWISE_TOKEN set + readwise.io in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("readwise.token", "readwise_test_token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddReadwiseMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["readwise"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "readwise.io");
    expect(spec.env?.["READWISE_TOKEN"]).toBe("readwise_test_token");
  });
});

// ─── phase3AddRaindropMcp ────────────────────────────────────────────────────

describe("phase3AddRaindropMcp", () => {
  test("no-op without raindrop.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRaindropMcp(vault, servers, SANDBOX_CWD);
    expect(servers["raindrop"]).toBeUndefined();
  });

  test("no-op when raindrop.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("raindrop.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRaindropMcp(vault, servers, SANDBOX_CWD);
    expect(servers["raindrop"]).toBeUndefined();
  });

  test("spawns with RAINDROP_TOKEN set + api.raindrop.io in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("raindrop.token", "raindrop_test_token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRaindropMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["raindrop"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.raindrop.io");
    expect(spec.env?.["RAINDROP_TOKEN"]).toBe("raindrop_test_token");
  });
});

// ─── phase3AddIntercomMcp ────────────────────────────────────────────────────

describe("phase3AddIntercomMcp", () => {
  test("no-op without intercom.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddIntercomMcp(vault, servers, SANDBOX_CWD);
    expect(servers["intercom"]).toBeUndefined();
  });

  test("no-op when intercom.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("intercom.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddIntercomMcp(vault, servers, SANDBOX_CWD);
    expect(servers["intercom"]).toBeUndefined();
  });

  test("spawns with INTERCOM_TOKEN set + api.intercom.io in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("intercom.token", "intercom_test_token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddIntercomMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["intercom"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.intercom.io");
    expect(spec.env?.["INTERCOM_TOKEN"]).toBe("intercom_test_token");
  });
});

// ─── phase3AddZendeskMcp ─────────────────────────────────────────────────────

describe("phase3AddZendeskMcp", () => {
  test("no-op without any of url / email / api_token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZendeskMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zendesk"]).toBeUndefined();
  });

  test("no-op when api_token is missing (url + email only)", async () => {
    const vault = createMockVault();
    await vault.set("zendesk.url", "https://acme.zendesk.com");
    await vault.set("zendesk.email", "agent@acme.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZendeskMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zendesk"]).toBeUndefined();
  });

  test("no-op when email is missing (url + api_token only)", async () => {
    const vault = createMockVault();
    await vault.set("zendesk.url", "https://acme.zendesk.com");
    await vault.set("zendesk.api_token", "zd-tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZendeskMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zendesk"]).toBeUndefined();
  });

  test("no-op when url is missing (email + api_token only)", async () => {
    const vault = createMockVault();
    await vault.set("zendesk.email", "agent@acme.com");
    await vault.set("zendesk.api_token", "zd-tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZendeskMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zendesk"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("zendesk.url", "   ");
    await vault.set("zendesk.email", "   ");
    await vault.set("zendesk.api_token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZendeskMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zendesk"]).toBeUndefined();
  });

  test("spawns with the three env vars + the parsed host in the manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("zendesk.url", "https://acme.zendesk.com");
    await vault.set("zendesk.email", "agent@acme.com");
    await vault.set("zendesk.api_token", "zd-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZendeskMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["zendesk"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "acme.zendesk.com");
    expect(spec.env?.["ZENDESK_URL"]).toBe("https://acme.zendesk.com");
    expect(spec.env?.["ZENDESK_EMAIL"]).toBe("agent@acme.com");
    expect(spec.env?.["ZENDESK_API_TOKEN"]).toBe("zd-test-token");
  });

  test("spawns even when zendesk.url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("zendesk.url", "not a url");
    await vault.set("zendesk.email", "agent@acme.com");
    await vault.set("zendesk.api_token", "zd-tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZendeskMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["zendesk"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["ZENDESK_URL"]).toBe("not a url");
  });
});

// ─── phase3AddLeverMcp ───────────────────────────────────────────────────────

describe("phase3AddLeverMcp", () => {
  test("no-op without lever.api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLeverMcp(vault, servers, SANDBOX_CWD);
    expect(servers["lever"]).toBeUndefined();
  });

  test("no-op when lever.api_key is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("lever.api_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLeverMcp(vault, servers, SANDBOX_CWD);
    expect(servers["lever"]).toBeUndefined();
  });

  test("spawns with LEVER_API_KEY set + api.lever.co in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("lever.api_key", "lever_test_key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLeverMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["lever"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.lever.co");
    expect(spec.env?.["LEVER_API_KEY"]).toBe("lever_test_key");
  });
});

// ─── phase3AddGreenhouseMcp ──────────────────────────────────────────────────

describe("phase3AddGreenhouseMcp", () => {
  test("no-op without greenhouse.api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGreenhouseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["greenhouse"]).toBeUndefined();
  });

  test("no-op when greenhouse.api_key is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("greenhouse.api_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGreenhouseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["greenhouse"]).toBeUndefined();
  });

  test("spawns with GREENHOUSE_API_KEY set + harvest.greenhouse.io in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("greenhouse.api_key", "greenhouse_test_key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGreenhouseMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["greenhouse"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "harvest.greenhouse.io");
    expect(spec.env?.["GREENHOUSE_API_KEY"]).toBe("greenhouse_test_key");
  });
});

// ─── phase3AddPipedriveMcp ───────────────────────────────────────────────────

describe("phase3AddPipedriveMcp", () => {
  test("no-op without pipedrive.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPipedriveMcp(vault, servers, SANDBOX_CWD);
    expect(servers["pipedrive"]).toBeUndefined();
  });

  test("no-op when pipedrive.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("pipedrive.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPipedriveMcp(vault, servers, SANDBOX_CWD);
    expect(servers["pipedrive"]).toBeUndefined();
  });

  test("spawns with PIPEDRIVE_TOKEN set + api.pipedrive.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("pipedrive.token", "pipedrive_test_token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPipedriveMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["pipedrive"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.pipedrive.com");
    expect(spec.env?.["PIPEDRIVE_TOKEN"]).toBe("pipedrive_test_token");
  });
});

// ─── phase3AddStackoverflowMcp ───────────────────────────────────────────────

describe("phase3AddStackoverflowMcp", () => {
  test("no-op without either stackoverflow key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStackoverflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["stackoverflow"]).toBeUndefined();
  });

  test("no-op when only stackoverflow.token is set (team required)", async () => {
    const vault = createMockVault();
    await vault.set("stackoverflow.token", "so_test_token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStackoverflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["stackoverflow"]).toBeUndefined();
  });

  test("no-op when only stackoverflow.team is set (token required)", async () => {
    const vault = createMockVault();
    await vault.set("stackoverflow.team", "acme");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStackoverflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["stackoverflow"]).toBeUndefined();
  });

  test("no-op when either key is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("stackoverflow.token", "so_test_token");
    await vault.set("stackoverflow.team", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStackoverflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["stackoverflow"]).toBeUndefined();
  });

  test("spawns with both env vars set + api.stackoverflowteams.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("stackoverflow.token", "so_test_token");
    await vault.set("stackoverflow.team", "acme");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStackoverflowMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["stackoverflow"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.stackoverflowteams.com");
    expect(spec.env?.["STACKOVERFLOW_TOKEN"]).toBe("so_test_token");
    expect(spec.env?.["STACKOVERFLOW_TEAM"]).toBe("acme");
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
