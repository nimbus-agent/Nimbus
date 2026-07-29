import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  buildPhase3Servers,
  phase3AddAirflowMcp,
  phase3AddArgocdMcp,
  phase3AddAthenaMcp,
  phase3AddAwsMcp,
  phase3AddAzureMcp,
  phase3AddBigeyeMcp,
  phase3AddBigqueryMcp,
  phase3AddCloudLoggingMcp,
  phase3AddCloudwatchMcp,
  phase3AddCodemagicMcp,
  phase3AddDagsterMcp,
  phase3AddDatabricksMcp,
  phase3AddDatadogMcp,
  phase3AddDataprofileMcp,
  phase3AddDbtMcp,
  phase3AddDependencytrackMcp,
  phase3AddElasticsearchMcp,
  phase3AddFastmailMcp,
  phase3AddFirebaseMcp,
  phase3AddFlagsmithMcp,
  phase3AddFluxMcp,
  phase3AddGcpMcp,
  phase3AddGrafanaMcp,
  phase3AddGreatExpectationsMcp,
  phase3AddGreenhouseMcp,
  phase3AddIacMcp,
  phase3AddImapMcp,
  phase3AddIntercomMcp,
  phase3AddLaunchdarklyMcp,
  phase3AddLeverMcp,
  phase3AddLocaldbMcp,
  phase3AddLookerMcp,
  phase3AddMercuryMcp,
  phase3AddMetabaseMcp,
  phase3AddMlflowMcp,
  phase3AddMonteCarloMcp,
  phase3AddNetlifyMcp,
  phase3AddNewrelicMcp,
  phase3AddPipedriveMcp,
  phase3AddPowerBiMcp,
  phase3AddPrefectMcp,
  phase3AddProtonmailMcp,
  phase3AddRaindropMcp,
  phase3AddRampMcp,
  phase3AddReadwiseMcp,
  phase3AddSagemakerMcp,
  phase3AddSemgrepMcp,
  phase3AddSentryMcp,
  phase3AddSnowflakeMcp,
  phase3AddSnykMcp,
  phase3AddSonarqubeMcp,
  phase3AddStackoverflowMcp,
  phase3AddStorybookMcp,
  phase3AddStripeMcp,
  phase3AddSupersetMcp,
  phase3AddTableauMcp,
  phase3AddTestflightMcp,
  phase3AddVercelMcp,
  phase3AddVertexAiMcp,
  phase3AddWizMcp,
  phase3AddZendeskMcp,
  phase3AddZoteroMcp,
} from "./phase3-config.ts";
import type { ServerSpec } from "./slot.ts";

let SANDBOX_CWD: string;
beforeAll(() => {
  SANDBOX_CWD = mkdtempSync(join(tmpdir(), "nimbus-phase3-config-test-"));
});
afterAll(() => {
  if (SANDBOX_CWD) rmSync(SANDBOX_CWD, { recursive: true, force: true });
});

function readManifest(spec: ServerSpec): {
  permissions: { network: string[]; filesystem: { read: string[]; write: string[] } };
} {
  const raw = spec.env?.["NIMBUS_SANDBOX_MANIFEST_JSON"];
  expect(typeof raw).toBe("string");
  return JSON.parse(raw ?? "{}") as {
    permissions: { network: string[]; filesystem: { read: string[]; write: string[] } };
  };
}

function expectSandboxed(spec: ServerSpec, expectedHost?: string): void {
  expect(spec.command).toBe(process.execPath);
  expect(spec.env?.["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
  expect(spec.env?.["NIMBUS_SANDBOX_CWD"]).toBe(SANDBOX_CWD);
  if (expectedHost !== undefined) {
    const manifest = readManifest(spec);
    expect(manifest.permissions.network).toContain(expectedHost);
  }
}

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

describe("phase3AddAzureMcp", () => {
  test("no-op when any of tenant/client/secret missing", async () => {
    const vault = createMockVault();
    await vault.set("azure.tenant_id", "T");
    await vault.set("azure.client_id", "C");
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

describe("phase3AddGrafanaMcp", () => {
  test("no-op without url + token", async () => {
    const vault = createMockVault();
    await vault.set("grafana.url", "https://grafana.example.com");
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
    expect(spec.env?.["GRAFANA_URL"]).toBe("not a url");
  });
});

describe("phase3AddSentryMcp", () => {
  test("no-op without token + org", async () => {
    const vault = createMockVault();
    await vault.set("sentry.auth_token", "tok");
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

describe("phase3AddDatadogMcp", () => {
  test("no-op without api_key + app_key", async () => {
    const vault = createMockVault();
    await vault.set("datadog.api_key", "ak");
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

describe("phase3AddSnowflakeMcp", () => {
  test("no-op without snowflake.account + token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["snowflake"]).toBeUndefined();
  });

  test("no-op when account is present but token is missing", async () => {
    const vault = createMockVault();
    await vault.set("snowflake.account", "acme-xy12345");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["snowflake"]).toBeUndefined();
  });

  test("no-op when token is present but account is missing", async () => {
    const vault = createMockVault();
    await vault.set("snowflake.oauth_token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["snowflake"]).toBeUndefined();
  });

  // Blank credentials and an account that would be unsafe to hand to a spawn (leading dash =
  // looks like a flag; control character) all leave the server unregistered.
  test.each([
    ["both are whitespace-only", "   ", "   "],
    ["account has a leading dash (unsafe)", "-bad-account", "tok"],
    ["account contains a control character (unsafe)", "acme\x01xy", "tok"],
  ])("no-op when %s", async (_label, account, token) => {
    const vault = createMockVault();
    await vault.set("snowflake.account", account);
    await vault.set("snowflake.oauth_token", token);
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["snowflake"]).toBeUndefined();
  });

  test("spawns with SNOWFLAKE_ACCOUNT/SNOWFLAKE_TOKEN env + derived host in manifest", async () => {
    const vault = createMockVault();
    await vault.set("snowflake.account", "acme-xy12345");
    await vault.set("snowflake.oauth_token", "tok-test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["snowflake"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "acme-xy12345.snowflakecomputing.com");
    expect(spec.env?.["SNOWFLAKE_ACCOUNT"]).toBe("acme-xy12345");
    expect(spec.env?.["SNOWFLAKE_TOKEN"]).toBe("tok-test");
  });

  test("prefers oauth_token over key_pair_jwt when both are set", async () => {
    const vault = createMockVault();
    await vault.set("snowflake.account", "acme-xy12345");
    await vault.set("snowflake.oauth_token", "oauth-tok");
    await vault.set("snowflake.key_pair_jwt", "jwt-tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["snowflake"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["SNOWFLAKE_TOKEN"]).toBe("oauth-tok");
  });

  test("falls back to key_pair_jwt when oauth_token is absent", async () => {
    const vault = createMockVault();
    await vault.set("snowflake.account", "acme-xy12345");
    await vault.set("snowflake.key_pair_jwt", "jwt-only");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["snowflake"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["SNOWFLAKE_TOKEN"]).toBe("jwt-only");
  });

  test("no-op when account exceeds 253 characters (unsafe)", async () => {
    const vault = createMockVault();
    await vault.set("snowflake.account", "a".repeat(254));
    await vault.set("snowflake.oauth_token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddSnowflakeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["snowflake"]).toBeUndefined();
  });
});

describe("phase3AddTableauMcp", () => {
  test("no-op without tableau.url + pat_name + pat_secret", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTableauMcp(vault, servers, SANDBOX_CWD);
    expect(servers["tableau"]).toBeUndefined();
  });

  test("no-op when only tableau.url is set (pat_name + pat_secret missing)", async () => {
    const vault = createMockVault();
    await vault.set("tableau.url", "https://tableau.example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTableauMcp(vault, servers, SANDBOX_CWD);
    expect(servers["tableau"]).toBeUndefined();
  });

  test("no-op when pat_name is missing (url + pat_secret only)", async () => {
    const vault = createMockVault();
    await vault.set("tableau.url", "https://tableau.example.com");
    await vault.set("tableau.pat_secret", "secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTableauMcp(vault, servers, SANDBOX_CWD);
    expect(servers["tableau"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("tableau.url", "   ");
    await vault.set("tableau.pat_name", "   ");
    await vault.set("tableau.pat_secret", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTableauMcp(vault, servers, SANDBOX_CWD);
    expect(servers["tableau"]).toBeUndefined();
  });

  test("spawns with TABLEAU_URL/TABLEAU_PAT_NAME/TABLEAU_PAT_SECRET env + parsed host in manifest", async () => {
    const vault = createMockVault();
    await vault.set("tableau.url", "https://tableau.example.com");
    await vault.set("tableau.pat_name", "my-pat");
    await vault.set("tableau.pat_secret", "my-secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTableauMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["tableau"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "tableau.example.com");
    expect(spec.env?.["TABLEAU_URL"]).toBe("https://tableau.example.com");
    expect(spec.env?.["TABLEAU_PAT_NAME"]).toBe("my-pat");
    expect(spec.env?.["TABLEAU_PAT_SECRET"]).toBe("my-secret");
  });

  test("spawns even when tableau.url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("tableau.url", "not a url");
    await vault.set("tableau.pat_name", "pat");
    await vault.set("tableau.pat_secret", "secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTableauMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["tableau"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["TABLEAU_URL"]).toBe("not a url");
  });
});

describe("phase3AddLookerMcp", () => {
  test("no-op without looker.base_url + client_id + client_secret", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLookerMcp(vault, servers, SANDBOX_CWD);
    expect(servers["looker"]).toBeUndefined();
  });

  test("no-op when only base_url is set (client_id + client_secret missing)", async () => {
    const vault = createMockVault();
    await vault.set("looker.base_url", "https://looker.example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLookerMcp(vault, servers, SANDBOX_CWD);
    expect(servers["looker"]).toBeUndefined();
  });

  test("no-op when client_id is missing (base_url + client_secret only)", async () => {
    const vault = createMockVault();
    await vault.set("looker.base_url", "https://looker.example.com");
    await vault.set("looker.client_secret", "secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLookerMcp(vault, servers, SANDBOX_CWD);
    expect(servers["looker"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("looker.base_url", "   ");
    await vault.set("looker.client_id", "   ");
    await vault.set("looker.client_secret", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLookerMcp(vault, servers, SANDBOX_CWD);
    expect(servers["looker"]).toBeUndefined();
  });

  test("spawns with LOOKER_BASE_URL/LOOKER_CLIENT_ID/LOOKER_CLIENT_SECRET env + parsed host in manifest", async () => {
    const vault = createMockVault();
    await vault.set("looker.base_url", "https://looker.example.com");
    await vault.set("looker.client_id", "my-client-id");
    await vault.set("looker.client_secret", "my-secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLookerMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["looker"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "looker.example.com");
    expect(spec.env?.["LOOKER_BASE_URL"]).toBe("https://looker.example.com");
    expect(spec.env?.["LOOKER_CLIENT_ID"]).toBe("my-client-id");
    expect(spec.env?.["LOOKER_CLIENT_SECRET"]).toBe("my-secret");
  });

  test("spawns even when looker.base_url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("looker.base_url", "not a url");
    await vault.set("looker.client_id", "id");
    await vault.set("looker.client_secret", "secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLookerMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["looker"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["LOOKER_BASE_URL"]).toBe("not a url");
  });
});

describe("phase3AddPowerBiMcp", () => {
  test("no-op without powerbi.tenant_id + client_id + client_secret", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPowerBiMcp(vault, servers, SANDBOX_CWD);
    expect(servers["powerbi"]).toBeUndefined();
  });

  test("no-op when only tenant_id is set (client_id + client_secret missing)", async () => {
    const vault = createMockVault();
    await vault.set("powerbi.tenant_id", "my-tenant");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPowerBiMcp(vault, servers, SANDBOX_CWD);
    expect(servers["powerbi"]).toBeUndefined();
  });

  test("no-op when client_secret is missing (tenant_id + client_id only)", async () => {
    const vault = createMockVault();
    await vault.set("powerbi.tenant_id", "my-tenant");
    await vault.set("powerbi.client_id", "my-client");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPowerBiMcp(vault, servers, SANDBOX_CWD);
    expect(servers["powerbi"]).toBeUndefined();
  });

  // Same shape as the Snowflake no-op table: blank credentials, or a tenant_id that would be
  // unsafe to hand to a spawn, both leave powerbi unregistered.
  test.each([
    ["credentials are whitespace-only", "   ", "   ", "   "],
    ["tenant_id has a leading dash (unsafe)", "-bad-tenant", "my-client-id", "my-client-secret"],
    [
      "tenant_id contains a control character (unsafe)",
      "acme\x01tenant",
      "my-client-id",
      "my-client-secret",
    ],
  ])("no-op when %s", async (_label, tenantId, clientId, clientSecret) => {
    const vault = createMockVault();
    await vault.set("powerbi.tenant_id", tenantId);
    await vault.set("powerbi.client_id", clientId);
    await vault.set("powerbi.client_secret", clientSecret);
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPowerBiMcp(vault, servers, SANDBOX_CWD);
    expect(servers["powerbi"]).toBeUndefined();
  });

  test("spawns with POWERBI_TENANT_ID/CLIENT_ID/CLIENT_SECRET env + static hosts in manifest", async () => {
    const vault = createMockVault();
    await vault.set("powerbi.tenant_id", "my-tenant-id");
    await vault.set("powerbi.client_id", "my-client-id");
    await vault.set("powerbi.client_secret", "my-client-secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPowerBiMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["powerbi"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "login.microsoftonline.com");
    const manifest = readManifest(spec);
    expect(manifest.permissions.network).toContain("login.microsoftonline.com");
    expect(manifest.permissions.network).toContain("api.powerbi.com");
    expect(spec.env?.["POWERBI_TENANT_ID"]).toBe("my-tenant-id");
    expect(spec.env?.["POWERBI_CLIENT_ID"]).toBe("my-client-id");
    expect(spec.env?.["POWERBI_CLIENT_SECRET"]).toBe("my-client-secret");
  });
});

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

describe("phase3AddZoteroMcp", () => {
  test("no-op without either zotero key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZoteroMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zotero"]).toBeUndefined();
  });

  test("no-op when only zotero.api_key is set (library required)", async () => {
    const vault = createMockVault();
    await vault.set("zotero.api_key", "zk_test_key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZoteroMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zotero"]).toBeUndefined();
  });

  test("no-op when only zotero.library is set (api_key required)", async () => {
    const vault = createMockVault();
    await vault.set("zotero.library", "users/12345");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZoteroMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zotero"]).toBeUndefined();
  });

  test("no-op when either key is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("zotero.api_key", "zk_test_key");
    await vault.set("zotero.library", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZoteroMcp(vault, servers, SANDBOX_CWD);
    expect(servers["zotero"]).toBeUndefined();
  });

  test("spawns with both env vars set + api.zotero.org in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("zotero.api_key", "zk_test_key");
    await vault.set("zotero.library", "users/12345");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddZoteroMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["zotero"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.zotero.org");
    expect(spec.env?.["ZOTERO_API_KEY"]).toBe("zk_test_key");
    expect(spec.env?.["ZOTERO_LIBRARY"]).toBe("users/12345");
  });
});

describe("phase3AddDependencytrackMcp", () => {
  test("no-op without dependencytrack.base_url + dependencytrack.api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDependencytrackMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dependencytrack"]).toBeUndefined();
  });

  test("no-op when only dependencytrack.base_url is set (api_key missing)", async () => {
    const vault = createMockVault();
    await vault.set("dependencytrack.base_url", "https://dtrack.example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDependencytrackMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dependencytrack"]).toBeUndefined();
  });

  test("no-op when only dependencytrack.api_key is set (base_url missing)", async () => {
    const vault = createMockVault();
    await vault.set("dependencytrack.api_key", "dt-key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDependencytrackMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dependencytrack"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("dependencytrack.base_url", "   ");
    await vault.set("dependencytrack.api_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDependencytrackMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dependencytrack"]).toBeUndefined();
  });

  test("spawns with DEPENDENCYTRACK_URL/DEPENDENCYTRACK_API_KEY env + parsed host in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("dependencytrack.base_url", "https://dtrack.example.com");
    await vault.set("dependencytrack.api_key", "dt-key-test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDependencytrackMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["dependencytrack"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "dtrack.example.com");
    expect(spec.env?.["DEPENDENCYTRACK_URL"]).toBe("https://dtrack.example.com");
    expect(spec.env?.["DEPENDENCYTRACK_API_KEY"]).toBe("dt-key-test");
  });

  test("spawns even when dependencytrack.base_url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("dependencytrack.base_url", "not a url");
    await vault.set("dependencytrack.api_key", "k");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDependencytrackMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["dependencytrack"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["DEPENDENCYTRACK_URL"]).toBe("not a url");
  });
});

describe("phase3AddElasticsearchMcp", () => {
  test("no-op without elasticsearch.url + elasticsearch.api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddElasticsearchMcp(vault, servers, SANDBOX_CWD);
    expect(servers["elasticsearch"]).toBeUndefined();
  });

  test("no-op when only elasticsearch.url is set (api_key missing)", async () => {
    const vault = createMockVault();
    await vault.set("elasticsearch.url", "https://es.example.com:9243");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddElasticsearchMcp(vault, servers, SANDBOX_CWD);
    expect(servers["elasticsearch"]).toBeUndefined();
  });

  test("no-op when only elasticsearch.api_key is set (url missing)", async () => {
    const vault = createMockVault();
    await vault.set("elasticsearch.api_key", "es-key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddElasticsearchMcp(vault, servers, SANDBOX_CWD);
    expect(servers["elasticsearch"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("elasticsearch.url", "   ");
    await vault.set("elasticsearch.api_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddElasticsearchMcp(vault, servers, SANDBOX_CWD);
    expect(servers["elasticsearch"]).toBeUndefined();
  });

  test("spawns with ELASTICSEARCH_URL/ELASTICSEARCH_API_KEY env + parsed host in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("elasticsearch.url", "https://my-cluster.es.example.com:9243");
    await vault.set("elasticsearch.api_key", "es-key-test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddElasticsearchMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["elasticsearch"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "my-cluster.es.example.com");
    expect(spec.env?.["ELASTICSEARCH_URL"]).toBe("https://my-cluster.es.example.com:9243");
    expect(spec.env?.["ELASTICSEARCH_API_KEY"]).toBe("es-key-test");
  });

  test("spawns even when elasticsearch.url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("elasticsearch.url", "not a url");
    await vault.set("elasticsearch.api_key", "k");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddElasticsearchMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["elasticsearch"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["ELASTICSEARCH_URL"]).toBe("not a url");
  });
});

describe("phase3AddAirflowMcp", () => {
  test("no-op without airflow.base_url + airflow.username + airflow.password", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAirflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["airflow"]).toBeUndefined();
  });

  test("no-op when password is missing", async () => {
    const vault = createMockVault();
    await vault.set("airflow.base_url", "https://airflow.example.com");
    await vault.set("airflow.username", "admin");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAirflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["airflow"]).toBeUndefined();
  });

  test("no-op when username is missing", async () => {
    const vault = createMockVault();
    await vault.set("airflow.base_url", "https://airflow.example.com");
    await vault.set("airflow.password", "secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAirflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["airflow"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("airflow.base_url", "   ");
    await vault.set("airflow.username", "   ");
    await vault.set("airflow.password", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAirflowMcp(vault, servers, SANDBOX_CWD);
    expect(servers["airflow"]).toBeUndefined();
  });

  test("spawns with AIRFLOW_URL/USERNAME/PASSWORD env + parsed host in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("airflow.base_url", "https://airflow.example.com");
    await vault.set("airflow.username", "admin");
    await vault.set("airflow.password", "secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAirflowMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["airflow"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "airflow.example.com");
    expect(spec.env?.["AIRFLOW_URL"]).toBe("https://airflow.example.com");
    expect(spec.env?.["AIRFLOW_USERNAME"]).toBe("admin");
    expect(spec.env?.["AIRFLOW_PASSWORD"]).toBe("secret");
  });

  test("spawns even when airflow.base_url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("airflow.base_url", "not a url");
    await vault.set("airflow.username", "admin");
    await vault.set("airflow.password", "secret");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAirflowMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["airflow"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["AIRFLOW_URL"]).toBe("not a url");
  });
});

describe("phase3AddPrefectMcp", () => {
  test("no-op without prefect.api_url + prefect.api_key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPrefectMcp(vault, servers, SANDBOX_CWD);
    expect(servers["prefect"]).toBeUndefined();
  });

  test("no-op when api_key is missing", async () => {
    const vault = createMockVault();
    await vault.set("prefect.api_url", "https://api.prefect.cloud/api/accounts/a/workspaces/w");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPrefectMcp(vault, servers, SANDBOX_CWD);
    expect(servers["prefect"]).toBeUndefined();
  });

  test("no-op when api_url is missing", async () => {
    const vault = createMockVault();
    await vault.set("prefect.api_key", "pnu_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPrefectMcp(vault, servers, SANDBOX_CWD);
    expect(servers["prefect"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("prefect.api_url", "   ");
    await vault.set("prefect.api_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPrefectMcp(vault, servers, SANDBOX_CWD);
    expect(servers["prefect"]).toBeUndefined();
  });

  test("spawns with PREFECT_API_URL/API_KEY env + parsed host in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("prefect.api_url", "https://api.prefect.cloud/api/accounts/a/workspaces/w");
    await vault.set("prefect.api_key", "pnu_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPrefectMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["prefect"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.prefect.cloud");
    expect(spec.env?.["PREFECT_API_URL"]).toBe(
      "https://api.prefect.cloud/api/accounts/a/workspaces/w",
    );
    expect(spec.env?.["PREFECT_API_KEY"]).toBe("pnu_test");
  });

  test("spawns even when prefect.api_url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("prefect.api_url", "not a url");
    await vault.set("prefect.api_key", "pnu_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddPrefectMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["prefect"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["PREFECT_API_URL"]).toBe("not a url");
  });
});

describe("phase3AddDagsterMcp", () => {
  test("no-op without dagster.base_url + dagster.api_token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDagsterMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dagster"]).toBeUndefined();
  });

  test("no-op when api_token is missing", async () => {
    const vault = createMockVault();
    await vault.set("dagster.base_url", "https://my-org.dagster.cloud/prod");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDagsterMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dagster"]).toBeUndefined();
  });

  test("no-op when base_url is missing", async () => {
    const vault = createMockVault();
    await vault.set("dagster.api_token", "tok_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDagsterMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dagster"]).toBeUndefined();
  });

  test("no-op when credentials are whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("dagster.base_url", "   ");
    await vault.set("dagster.api_token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDagsterMcp(vault, servers, SANDBOX_CWD);
    expect(servers["dagster"]).toBeUndefined();
  });

  test("spawns with DAGSTER_BASE_URL/API_TOKEN env + parsed host in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("dagster.base_url", "https://my-org.dagster.cloud/prod");
    await vault.set("dagster.api_token", "tok_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDagsterMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["dagster"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "my-org.dagster.cloud");
    expect(spec.env?.["DAGSTER_BASE_URL"]).toBe("https://my-org.dagster.cloud/prod");
    expect(spec.env?.["DAGSTER_API_TOKEN"]).toBe("tok_test");
  });

  test("spawns even when dagster.base_url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("dagster.base_url", "not a url");
    await vault.set("dagster.api_token", "tok_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDagsterMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["dagster"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["DAGSTER_BASE_URL"]).toBe("not a url");
  });
});

describe("phase3AddRampMcp", () => {
  test("no-op without either ramp key", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRampMcp(vault, servers, SANDBOX_CWD);
    expect(servers["ramp"]).toBeUndefined();
  });

  test("no-op when only ramp.client_id is set (secret required)", async () => {
    const vault = createMockVault();
    await vault.set("ramp.client_id", "cid_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRampMcp(vault, servers, SANDBOX_CWD);
    expect(servers["ramp"]).toBeUndefined();
  });

  test("no-op when only ramp.client_secret is set (client id required)", async () => {
    const vault = createMockVault();
    await vault.set("ramp.client_secret", "csecret_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRampMcp(vault, servers, SANDBOX_CWD);
    expect(servers["ramp"]).toBeUndefined();
  });

  test("no-op when either key is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("ramp.client_id", "cid_test");
    await vault.set("ramp.client_secret", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRampMcp(vault, servers, SANDBOX_CWD);
    expect(servers["ramp"]).toBeUndefined();
  });

  test("spawns with both env vars set + api.ramp.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("ramp.client_id", "cid_test");
    await vault.set("ramp.client_secret", "csecret_test");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddRampMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["ramp"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.ramp.com");
    expect(spec.env?.["RAMP_CLIENT_ID"]).toBe("cid_test");
    expect(spec.env?.["RAMP_CLIENT_SECRET"]).toBe("csecret_test");
  });
});

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
    expect(Object.keys(servers).sort((a, b) => a.localeCompare(b))).toEqual(
      // bigquery + cloud_logging + vertex_ai reuse gcp creds; athena + cloudwatch +
      // sagemaker reuse aws creds — all appear whenever their underlying credentials
      // are seeded.
      [
        "athena",
        "aws",
        "azure",
        "bigquery",
        "cloud_logging",
        "cloudwatch",
        "datadog",
        "gcp",
        "grafana",
        "iac",
        "newrelic",
        "sagemaker",
        "sentry",
        "snyk",
        "vertex_ai",
      ].sort((a, b) => a.localeCompare(b)),
    );
    for (const id of Object.keys(servers)) {
      expectSandboxed(servers[id] as ServerSpec);
    }
  });

  test("skips services whose preconditions fail (partial seed)", async () => {
    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA0");
    await vault.set("aws.secret_access_key", "S0");
    await vault.set("aws.default_region", "us-east-1");
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    const servers = await buildPhase3Servers(vault, SANDBOX_CWD);
    // bigquery + cloud_logging + vertex_ai reuse gcp creds; athena + cloudwatch +
    // sagemaker reuse aws creds — all appear whenever their underlying credentials
    // are seeded.
    expect(Object.keys(servers).sort((a, b) => a.localeCompare(b))).toEqual([
      "athena",
      "aws",
      "bigquery",
      "cloud_logging",
      "cloudwatch",
      "gcp",
      "sagemaker",
      "vertex_ai",
    ]);
  });
});

describe("dir-manifest connectors (addDirManifestServer)", () => {
  test("phase3AddLocaldbMcp noops when scripts_dir is unset", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLocaldbMcp(vault, servers, SANDBOX_CWD);
    expect(servers["localdb"]).toBeUndefined();
  });

  test("phase3AddLocaldbMcp spawns sandboxed with the dir added to filesystem.read", async () => {
    const vault = createMockVault();
    await vault.set("localdb.scripts_dir", "/data/sql");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLocaldbMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["localdb"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["LOCALDB_SCRIPTS_DIR"]).toBe("/data/sql");
    expect(readManifest(spec).permissions.filesystem.read).toContain("/data/sql");
  });

  test("phase3AddDataprofileMcp spawns with the configured dir", async () => {
    const vault = createMockVault();
    await vault.set("dataprofile.dir", "/data/profiles");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddDataprofileMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["dataprofile"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["DATAPROFILE_DIR"]).toBe("/data/profiles");
    expect(readManifest(spec).permissions.filesystem.read).toContain("/data/profiles");
  });

  test("phase3AddStorybookMcp spawns with the configured dir", async () => {
    const vault = createMockVault();
    await vault.set("storybook.dir", "/app/storybook-static");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddStorybookMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["storybook"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["STORYBOOK_DIR"]).toBe("/app/storybook-static");
  });

  test("phase3AddGreatExpectationsMcp uses the hyphenated script + results_dir", async () => {
    const vault = createMockVault();
    await vault.set("great_expectations.results_dir", "/gx/uncommitted");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddGreatExpectationsMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["great_expectations"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["GREAT_EXPECTATIONS_RESULTS_DIR"]).toBe("/gx/uncommitted");
  });
});

describe("phase3AddMonteCarloMcp", () => {
  test("no-op when both credentials are absent", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMonteCarloMcp(vault, servers, SANDBOX_CWD);
    expect(servers["montecarlo"]).toBeUndefined();
  });

  test("no-op when api_id is missing", async () => {
    const vault = createMockVault();
    await vault.set("montecarlo.api_token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMonteCarloMcp(vault, servers, SANDBOX_CWD);
    expect(servers["montecarlo"]).toBeUndefined();
  });

  test("no-op when api_token is missing", async () => {
    const vault = createMockVault();
    await vault.set("montecarlo.api_id", "id");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMonteCarloMcp(vault, servers, SANDBOX_CWD);
    expect(servers["montecarlo"]).toBeUndefined();
  });

  test("spawns sandboxed server with MONTECARLO_API_ID and MONTECARLO_API_TOKEN env", async () => {
    const vault = createMockVault();
    await vault.set("montecarlo.api_id", "my-api-id");
    await vault.set("montecarlo.api_token", "my-api-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMonteCarloMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["montecarlo"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "api.getmontecarlo.com");
    expect(spec.env?.["MONTECARLO_API_ID"]).toBe("my-api-id");
    expect(spec.env?.["MONTECARLO_API_TOKEN"]).toBe("my-api-token");
  });

  test("manifest declares api.getmontecarlo.com in network", async () => {
    const vault = createMockVault();
    await vault.set("montecarlo.api_id", "id");
    await vault.set("montecarlo.api_token", "tok");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddMonteCarloMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["montecarlo"];
    if (spec === undefined) return;
    const manifest = readManifest(spec);
    expect(manifest.permissions.network).toContain("api.getmontecarlo.com");
  });
});

describe("phase3AddBigeyeMcp", () => {
  test("no-op when both credentials are absent", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigeyeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["bigeye"]).toBeUndefined();
  });

  test("no-op when base_url is missing", async () => {
    const vault = createMockVault();
    await vault.set("bigeye.api_key", "key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigeyeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["bigeye"]).toBeUndefined();
  });

  test("no-op when api_key is missing", async () => {
    const vault = createMockVault();
    await vault.set("bigeye.base_url", "https://app.bigeye.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigeyeMcp(vault, servers, SANDBOX_CWD);
    expect(servers["bigeye"]).toBeUndefined();
  });

  test("spawns sandboxed server with BIGEYE_BASE_URL and BIGEYE_API_KEY env + parsed host in manifest", async () => {
    const vault = createMockVault();
    await vault.set("bigeye.base_url", "https://app.bigeye.com");
    await vault.set("bigeye.api_key", "my-api-key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigeyeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["bigeye"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "app.bigeye.com");
    expect(spec.env?.["BIGEYE_BASE_URL"]).toBe("https://app.bigeye.com");
    expect(spec.env?.["BIGEYE_API_KEY"]).toBe("my-api-key");
  });

  test("manifest contains parsed host from base_url", async () => {
    const vault = createMockVault();
    await vault.set("bigeye.base_url", "https://app.bigeye.com");
    await vault.set("bigeye.api_key", "key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigeyeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["bigeye"];
    if (spec === undefined) return;
    const manifest = readManifest(spec);
    expect(manifest.permissions.network).toContain("app.bigeye.com");
  });

  test("spawns even when base_url is not a parseable URL (hostname=null branch)", async () => {
    const vault = createMockVault();
    await vault.set("bigeye.base_url", "not a url");
    await vault.set("bigeye.api_key", "key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigeyeMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["bigeye"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["BIGEYE_BASE_URL"]).toBe("not a url");
  });
});

describe("phase3AddCodemagicMcp", () => {
  test("no-op without codemagic.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddCodemagicMcp(vault, servers, SANDBOX_CWD);
    expect(servers["codemagic"]).toBeUndefined();
  });

  test("no-op when codemagic.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("codemagic.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddCodemagicMcp(vault, servers, SANDBOX_CWD);
    expect(servers["codemagic"]).toBeUndefined();
  });

  test("spawns with CODEMAGIC_TOKEN set", async () => {
    const vault = createMockVault();
    await vault.set("codemagic.token", "cm-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddCodemagicMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["codemagic"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["CODEMAGIC_TOKEN"]).toBe("cm-test-token");
  });
});

describe("phase3AddTestflightMcp", () => {
  test("no-op without any credentials", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTestflightMcp(vault, servers, SANDBOX_CWD);
    expect(servers["testflight"]).toBeUndefined();
  });

  test("no-op when issuer_id + key_id present but private_key missing", async () => {
    const vault = createMockVault();
    await vault.set("testflight.issuer_id", "issuer");
    await vault.set("testflight.key_id", "key");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTestflightMcp(vault, servers, SANDBOX_CWD);
    expect(servers["testflight"]).toBeUndefined();
  });

  test("no-op when private_key is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("testflight.issuer_id", "issuer");
    await vault.set("testflight.key_id", "key");
    await vault.set("testflight.private_key", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTestflightMcp(vault, servers, SANDBOX_CWD);
    expect(servers["testflight"]).toBeUndefined();
  });

  test("spawns with all three credentials set", async () => {
    const vault = createMockVault();
    await vault.set("testflight.issuer_id", "issuer-1");
    await vault.set("testflight.key_id", "key-1");
    await vault.set("testflight.private_key", "NOT-A-REAL-KEY\nabc\n");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddTestflightMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["testflight"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["TESTFLIGHT_ISSUER_ID"]).toBe("issuer-1");
    expect(spec.env?.["TESTFLIGHT_KEY_ID"]).toBe("key-1");
    // The private key is passed through verbatim (not trimmed).
    expect(spec.env?.["TESTFLIGHT_PRIVATE_KEY"]).toBe("NOT-A-REAL-KEY\nabc\n");
  });
});

describe("phase3AddFirebaseMcp", () => {
  test("no-op without any credentials", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFirebaseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["firebase"]).toBeUndefined();
  });

  test("no-op when service_account_json is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("firebase.service_account_json", "   ");
    await vault.set("firebase.app_ids", "app-1");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFirebaseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["firebase"]).toBeUndefined();
  });

  test("no-op when app_ids missing (service_account_json only)", async () => {
    const vault = createMockVault();
    await vault.set("firebase.service_account_json", '{"type":"service_account"}');
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFirebaseMcp(vault, servers, SANDBOX_CWD);
    expect(servers["firebase"]).toBeUndefined();
  });

  test("spawns with both credentials set", async () => {
    const vault = createMockVault();
    await vault.set("firebase.service_account_json", '{"type":"service_account"}');
    await vault.set("firebase.app_ids", "app-1,app-2");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFirebaseMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["firebase"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["FIREBASE_SERVICE_ACCOUNT_JSON"]).toBe('{"type":"service_account"}');
    expect(spec.env?.["FIREBASE_APP_IDS"]).toBe("app-1,app-2");
  });
});

describe("phase3AddVertexAiMcp", () => {
  test("no-op without gcp.credentials_json_path", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVertexAiMcp(vault, servers, SANDBOX_CWD);
    expect(servers["vertex_ai"]).toBeUndefined();
  });

  test("spawns with default region when gcp.region is unset", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVertexAiMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["vertex_ai"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "us-central1-aiplatform.googleapis.com");
    expect(spec.env?.["VERTEX_AI_REGION"]).toBe("us-central1");
    expect(spec.env?.["GOOGLE_APPLICATION_CREDENTIALS"]).toBe("/etc/gcp.json");
    expect(spec.env?.["GOOGLE_CLOUD_PROJECT"]).toBeUndefined();
  });

  test("uses a safe custom region + propagates GOOGLE_CLOUD_PROJECT when project_id is set", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    await vault.set("gcp.project_id", "my-project");
    await vault.set("gcp.region", "europe-west4");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVertexAiMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["vertex_ai"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "europe-west4-aiplatform.googleapis.com");
    expect(spec.env?.["VERTEX_AI_REGION"]).toBe("europe-west4");
    expect(spec.env?.["GOOGLE_CLOUD_PROJECT"]).toBe("my-project");
  });

  test("falls back to default region when configured region has a leading dash (unsafe)", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    await vault.set("gcp.region", "-bad-region");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVertexAiMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["vertex_ai"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["VERTEX_AI_REGION"]).toBe("us-central1");
  });

  test("falls back to default region when configured region carries a control char (unsafe)", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    await vault.set("gcp.region", "us\x01central1");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVertexAiMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["vertex_ai"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["VERTEX_AI_REGION"]).toBe("us-central1");
  });

  test("falls back to default region when configured region is over-long (unsafe)", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    await vault.set("gcp.region", "a".repeat(1025));
    const servers: Record<string, ServerSpec> = {};
    await phase3AddVertexAiMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["vertex_ai"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["VERTEX_AI_REGION"]).toBe("us-central1");
  });
});

describe("phase3AddImapMcp", () => {
  test("no-op without host/username/password", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddImapMcp(vault, servers, SANDBOX_CWD);
    expect(servers["imap"]).toBeUndefined();
  });

  test("no-op when password missing (host + username only)", async () => {
    const vault = createMockVault();
    await vault.set("imap.host", "imap.example.com");
    await vault.set("imap.username", "me@example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddImapMcp(vault, servers, SANDBOX_CWD);
    expect(servers["imap"]).toBeUndefined();
  });

  test("spawns with IMAP creds + default port 993 in host:port network entry", async () => {
    const vault = createMockVault();
    await vault.set("imap.host", "imap.example.com");
    await vault.set("imap.username", "me@example.com");
    await vault.set("imap.password", "pw");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddImapMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["imap"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "imap.example.com:993");
    expect(spec.env?.["IMAP_HOST"]).toBe("imap.example.com");
    expect(spec.env?.["IMAP_PORT"]).toBe("993");
    expect(spec.env?.["IMAP_USERNAME"]).toBe("me@example.com");
    expect(spec.env?.["IMAP_PASSWORD"]).toBe("pw");
    expect(spec.env?.["IMAP_MAILBOX"]).toBeUndefined();
    expect(spec.env?.["IMAP_SMTP_HOST"]).toBeUndefined();
    expect(spec.env?.["IMAP_SMTP_USERNAME"]).toBeUndefined();
    expect(spec.env?.["IMAP_SMTP_PASSWORD"]).toBeUndefined();
  });

  test("custom port + mailbox + full SMTP config sets every optional env + smtp host:port", async () => {
    const vault = createMockVault();
    await vault.set("imap.host", "imap.example.com");
    await vault.set("imap.username", "me@example.com");
    await vault.set("imap.password", "pw");
    await vault.set("imap.port", "143");
    await vault.set("imap.mailbox", "INBOX/Work");
    await vault.set("imap.smtp_host", "smtp.example.com");
    await vault.set("imap.smtp_port", "587");
    await vault.set("imap.smtp_username", "smtp-me@example.com");
    await vault.set("imap.smtp_password", "smtp-pw");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddImapMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["imap"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    const manifest = readManifest(spec);
    expect(manifest.permissions.network).toContain("imap.example.com:143");
    expect(manifest.permissions.network).toContain("smtp.example.com:587");
    expect(spec.env?.["IMAP_PORT"]).toBe("143");
    expect(spec.env?.["IMAP_MAILBOX"]).toBe("INBOX/Work");
    expect(spec.env?.["IMAP_SMTP_HOST"]).toBe("smtp.example.com");
    expect(spec.env?.["IMAP_SMTP_PORT"]).toBe("587");
    expect(spec.env?.["IMAP_SMTP_USERNAME"]).toBe("smtp-me@example.com");
    expect(spec.env?.["IMAP_SMTP_PASSWORD"]).toBe("smtp-pw");
  });

  test("out-of-range port falls back to default 993", async () => {
    const vault = createMockVault();
    await vault.set("imap.host", "imap.example.com");
    await vault.set("imap.username", "me@example.com");
    await vault.set("imap.password", "pw");
    await vault.set("imap.port", "70000");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddImapMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["imap"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["IMAP_PORT"]).toBe("993");
  });

  test("non-numeric port falls back to default 993", async () => {
    const vault = createMockVault();
    await vault.set("imap.host", "imap.example.com");
    await vault.set("imap.username", "me@example.com");
    await vault.set("imap.password", "pw");
    await vault.set("imap.port", "not-a-port");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddImapMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["imap"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["IMAP_PORT"]).toBe("993");
  });
});

describe("phase3AddProtonmailMcp", () => {
  test("no-op without username/password", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddProtonmailMcp(vault, servers, SANDBOX_CWD);
    expect(servers["protonmail"]).toBeUndefined();
  });

  test("no-op when password missing (username only)", async () => {
    const vault = createMockVault();
    await vault.set("protonmail.username", "me@proton.me");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddProtonmailMcp(vault, servers, SANDBOX_CWD);
    expect(servers["protonmail"]).toBeUndefined();
  });

  test("spawns with Bridge loopback defaults (no smtp creds → no smtp host)", async () => {
    const vault = createMockVault();
    await vault.set("protonmail.username", "me@proton.me");
    await vault.set("protonmail.password", "bridge-pw");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddProtonmailMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["protonmail"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "127.0.0.1:1143");
    expect(spec.env?.["PROTONMAIL_HOST"]).toBe("127.0.0.1");
    expect(spec.env?.["PROTONMAIL_PORT"]).toBe("1143");
    expect(spec.env?.["PROTONMAIL_USERNAME"]).toBe("me@proton.me");
    expect(spec.env?.["PROTONMAIL_PASSWORD"]).toBe("bridge-pw");
    expect(spec.env?.["PROTONMAIL_MAILBOX"]).toBeUndefined();
    expect(spec.env?.["PROTONMAIL_SMTP_HOST"]).toBeUndefined();
  });

  test("custom host/port + mailbox + full SMTP creds set every optional env + smtp host:port", async () => {
    const vault = createMockVault();
    await vault.set("protonmail.username", "me@proton.me");
    await vault.set("protonmail.password", "bridge-pw");
    await vault.set("protonmail.imap_host", "127.0.0.2");
    await vault.set("protonmail.imap_port", "2143");
    await vault.set("protonmail.mailbox", "Folders/Work");
    await vault.set("protonmail.smtp_host", "127.0.0.3");
    await vault.set("protonmail.smtp_port", "2025");
    await vault.set("protonmail.smtp_username", "smtp@proton.me");
    await vault.set("protonmail.smtp_password", "smtp-pw");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddProtonmailMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["protonmail"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    const manifest = readManifest(spec);
    expect(manifest.permissions.network).toContain("127.0.0.2:2143");
    expect(manifest.permissions.network).toContain("127.0.0.3:2025");
    expect(spec.env?.["PROTONMAIL_HOST"]).toBe("127.0.0.2");
    expect(spec.env?.["PROTONMAIL_PORT"]).toBe("2143");
    expect(spec.env?.["PROTONMAIL_MAILBOX"]).toBe("Folders/Work");
    expect(spec.env?.["PROTONMAIL_SMTP_HOST"]).toBe("127.0.0.3");
    expect(spec.env?.["PROTONMAIL_SMTP_PORT"]).toBe("2025");
    expect(spec.env?.["PROTONMAIL_SMTP_USERNAME"]).toBe("smtp@proton.me");
    expect(spec.env?.["PROTONMAIL_SMTP_PASSWORD"]).toBe("smtp-pw");
  });

  test("smtp host omitted when only one of smtp_username/smtp_password is set", async () => {
    const vault = createMockVault();
    await vault.set("protonmail.username", "me@proton.me");
    await vault.set("protonmail.password", "bridge-pw");
    await vault.set("protonmail.smtp_username", "smtp@proton.me");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddProtonmailMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["protonmail"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["PROTONMAIL_SMTP_HOST"]).toBeUndefined();
    expect(spec.env?.["PROTONMAIL_SMTP_USERNAME"]).toBeUndefined();
  });
});

describe("phase3AddFastmailMcp", () => {
  test("no-op without fastmail.api_token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFastmailMcp(vault, servers, SANDBOX_CWD);
    expect(servers["fastmail"]).toBeUndefined();
  });

  test("no-op when api_token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("fastmail.api_token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFastmailMcp(vault, servers, SANDBOX_CWD);
    expect(servers["fastmail"]).toBeUndefined();
  });

  test("spawns with FASTMAIL_API_TOKEN set (no base_url override)", async () => {
    const vault = createMockVault();
    await vault.set("fastmail.api_token", "fm-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFastmailMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["fastmail"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec);
    expect(spec.env?.["FASTMAIL_API_TOKEN"]).toBe("fm-token");
    expect(spec.env?.["FASTMAIL_BASE_URL"]).toBeUndefined();
  });

  test("base_url override propagates as FASTMAIL_BASE_URL env when present", async () => {
    const vault = createMockVault();
    await vault.set("fastmail.api_token", "fm-token");
    await vault.set("fastmail.base_url", "https://api.fastmail.example.com");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddFastmailMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["fastmail"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["FASTMAIL_BASE_URL"]).toBe("https://api.fastmail.example.com");
  });
});

describe("phase3AddBigqueryMcp", () => {
  test("no-op without gcp.credentials_json_path", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigqueryMcp(vault, servers, SANDBOX_CWD);
    expect(servers["bigquery"]).toBeUndefined();
  });

  test("spawns without BIGQUERY_PROJECT when project_id unset", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigqueryMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["bigquery"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["BIGQUERY_PROJECT"]).toBeUndefined();
  });

  test("propagates BIGQUERY_PROJECT when project_id is set", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    await vault.set("gcp.project_id", "my-project");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddBigqueryMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["bigquery"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["BIGQUERY_PROJECT"]).toBe("my-project");
  });
});

describe("phase3AddCloudLoggingMcp", () => {
  test("no-op without gcp.credentials_json_path", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddCloudLoggingMcp(vault, servers, SANDBOX_CWD);
    expect(servers["cloud_logging"]).toBeUndefined();
  });

  test("propagates GOOGLE_CLOUD_PROJECT when project_id is set", async () => {
    const vault = createMockVault();
    await vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    await vault.set("gcp.project_id", "my-project");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddCloudLoggingMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["cloud_logging"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.env?.["GOOGLE_CLOUD_PROJECT"]).toBe("my-project");
  });
});

describe("AWS-family regional connectors (athena / cloudwatch / sagemaker)", () => {
  // Profile-only creds have an empty region → the per-region host arm is `[]`.
  test("athena: no regional host added when region is empty (profile-only creds)", async () => {
    const vault = createMockVault();
    await vault.set("aws.profile", "dev");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAthenaMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["athena"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    const manifest = readManifest(spec);
    expect(manifest.permissions.network.some((h) => h.startsWith("athena."))).toBe(false);
  });

  test("athena: regional host added when region is configured", async () => {
    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA1");
    await vault.set("aws.secret_access_key", "SK1");
    await vault.set("aws.default_region", "eu-west-1");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddAthenaMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["athena"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "athena.eu-west-1.amazonaws.com");
  });

  test("cloudwatch: no regional host when region empty; added when configured", async () => {
    const vaultNoRegion = createMockVault();
    await vaultNoRegion.set("aws.profile", "dev");
    const s1: Record<string, ServerSpec> = {};
    await phase3AddCloudwatchMcp(vaultNoRegion, s1, SANDBOX_CWD);
    const spec1 = s1["cloudwatch"];
    expect(spec1).toBeDefined();
    if (spec1 !== undefined) {
      const m1 = readManifest(spec1);
      expect(m1.permissions.network.some((h) => h.startsWith("logs."))).toBe(false);
    }

    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA1");
    await vault.set("aws.secret_access_key", "SK1");
    await vault.set("aws.default_region", "us-east-2");
    const s2: Record<string, ServerSpec> = {};
    await phase3AddCloudwatchMcp(vault, s2, SANDBOX_CWD);
    const spec2 = s2["cloudwatch"];
    expect(spec2).toBeDefined();
    if (spec2 === undefined) return;
    expectSandboxed(spec2, "logs.us-east-2.amazonaws.com");
  });

  test("sagemaker: no regional host when region empty; added when configured", async () => {
    const vaultNoRegion = createMockVault();
    await vaultNoRegion.set("aws.profile", "dev");
    const s1: Record<string, ServerSpec> = {};
    await phase3AddSagemakerMcp(vaultNoRegion, s1, SANDBOX_CWD);
    const spec1 = s1["sagemaker"];
    expect(spec1).toBeDefined();
    if (spec1 !== undefined) {
      const m1 = readManifest(spec1);
      expect(m1.permissions.network.some((h) => h.startsWith("api.sagemaker."))).toBe(false);
    }

    const vault = createMockVault();
    await vault.set("aws.access_key_id", "AKIA1");
    await vault.set("aws.secret_access_key", "SK1");
    await vault.set("aws.default_region", "ap-south-1");
    const s2: Record<string, ServerSpec> = {};
    await phase3AddSagemakerMcp(vault, s2, SANDBOX_CWD);
    const spec2 = s2["sagemaker"];
    expect(spec2).toBeDefined();
    if (spec2 === undefined) return;
    expectSandboxed(spec2, "api.sagemaker.ap-south-1.amazonaws.com");
  });
});
