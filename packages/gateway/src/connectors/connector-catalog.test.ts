import { describe, expect, test } from "bun:test";

import {
  CONNECTOR_SERVICE_IDS,
  type ConnectorServiceId,
  defaultSyncIntervalMsForService,
  GOOGLE_CONNECTOR_SERVICES,
  MICROSOFT_CONNECTOR_SERVICES,
  normalizeConnectorServiceId,
  oauthProfileForService,
} from "./connector-catalog.ts";

describe("normalizeConnectorServiceId", () => {
  test("returns the exact id when already normalised", () => {
    expect(normalizeConnectorServiceId("github")).toBe("github");
    expect(normalizeConnectorServiceId("google_drive")).toBe("google_drive");
    expect(normalizeConnectorServiceId("github_actions")).toBe("github_actions");
  });

  test("normalises case to lowercase", () => {
    expect(normalizeConnectorServiceId("GitHub")).toBe("github");
    expect(normalizeConnectorServiceId("SLACK")).toBe("slack");
  });

  test("normalises hyphens to underscores", () => {
    expect(normalizeConnectorServiceId("google-drive")).toBe("google_drive");
    expect(normalizeConnectorServiceId("github-actions")).toBe("github_actions");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeConnectorServiceId("  github  ")).toBe("github");
    expect(normalizeConnectorServiceId("\tgmail\n")).toBe("gmail");
  });

  test("returns null for unknown services", () => {
    expect(normalizeConnectorServiceId("not-a-service")).toBeNull();
    expect(normalizeConnectorServiceId("")).toBeNull();
    expect(normalizeConnectorServiceId("googl_drive")).toBeNull();
  });
});

describe("defaultSyncIntervalMsForService", () => {
  test("returns a positive integer for every catalog id", () => {
    for (const id of CONNECTOR_SERVICE_IDS) {
      const ms = defaultSyncIntervalMsForService(id);
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  });

  test("returns the documented interval for a sampling of services", () => {
    expect(defaultSyncIntervalMsForService("github")).toBe(60 * 1000);
    expect(defaultSyncIntervalMsForService("gmail")).toBe(5 * 60 * 1000);
    expect(defaultSyncIntervalMsForService("google_drive")).toBe(30 * 60 * 1000);
    expect(defaultSyncIntervalMsForService("google_photos")).toBe(6 * 60 * 60 * 1000);
    expect(defaultSyncIntervalMsForService("circleci")).toBe(90 * 1000);
    expect(defaultSyncIntervalMsForService("mendeley")).toBe(10 * 60 * 1000);
  });
});

describe("CONNECTOR_SERVICE_IDS", () => {
  test("has no duplicate entries", () => {
    const set = new Set<string>(CONNECTOR_SERVICE_IDS);
    expect(set.size).toBe(CONNECTOR_SERVICE_IDS.length);
  });

  test("contains GOOGLE_CONNECTOR_SERVICES members", () => {
    for (const svc of GOOGLE_CONNECTOR_SERVICES) {
      expect((CONNECTOR_SERVICE_IDS as readonly string[]).includes(svc)).toBe(true);
    }
  });

  test("contains MICROSOFT_CONNECTOR_SERVICES members", () => {
    for (const svc of MICROSOFT_CONNECTOR_SERVICES) {
      expect((CONNECTOR_SERVICE_IDS as readonly string[]).includes(svc)).toBe(true);
    }
  });
});

describe("oauthProfileForService — supported providers", () => {
  test("returns Google provider profile with read-only Drive scope", () => {
    const profile = oauthProfileForService("google_drive");
    expect(profile.provider).toBe("google");
    expect(profile.defaultScopes).toContain("https://www.googleapis.com/auth/drive.readonly");
  });

  test("returns Google provider profile for Gmail with read + compose scopes", () => {
    const profile = oauthProfileForService("gmail");
    expect(profile.provider).toBe("google");
    expect(profile.defaultScopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(profile.defaultScopes).toContain("https://www.googleapis.com/auth/gmail.compose");
  });

  test("returns Google provider profile for Photos", () => {
    const profile = oauthProfileForService("google_photos");
    expect(profile.provider).toBe("google");
    expect(profile.defaultScopes.length).toBeGreaterThan(0);
  });

  test("returns Microsoft provider profile for OneDrive", () => {
    const profile = oauthProfileForService("onedrive");
    expect(profile.provider).toBe("microsoft");
    expect(profile.defaultScopes).toContain("Files.Read.All");
    expect(profile.defaultScopes).toContain("offline_access");
  });

  test("returns Microsoft provider profile for Outlook", () => {
    const profile = oauthProfileForService("outlook");
    expect(profile.provider).toBe("microsoft");
    expect(profile.defaultScopes).toContain("Mail.Read");
    expect(profile.defaultScopes).toContain("Calendars.Read");
  });

  test("returns Microsoft provider profile for Teams", () => {
    const profile = oauthProfileForService("teams");
    expect(profile.provider).toBe("microsoft");
    expect(profile.defaultScopes).toContain("Team.ReadBasic.All");
  });

  test("returns Slack provider profile with chat:write scope", () => {
    const profile = oauthProfileForService("slack");
    expect(profile.provider).toBe("slack");
    expect(profile.defaultScopes).toContain("chat:write");
    expect(profile.defaultScopes).toContain("channels:read");
  });

  test("returns Notion provider profile (empty scopes)", () => {
    const profile = oauthProfileForService("notion");
    expect(profile.provider).toBe("notion");
    expect(profile.defaultScopes).toEqual([]);
  });

  test("returns Mendeley provider profile with all scope", () => {
    const profile = oauthProfileForService("mendeley");
    expect(profile.provider).toBe("mendeley");
    expect(profile.defaultScopes).toEqual(["all"]);
  });
});

describe("oauthProfileForService — unsupported providers throw structured errors", () => {
  const unsupported: ConnectorServiceId[] = [
    "github",
    "github_actions",
    "gitlab",
    "bitbucket",
    "linear",
    "jira",
    "confluence",
    "discord",
    "jenkins",
    "circleci",
    "pagerduty",
    "kubernetes",
    "aws",
    "azure",
    "gcp",
    "iac",
    "grafana",
    "sentry",
    "newrelic",
    "datadog",
  ];

  test.each(unsupported)("throws for %s", (svc) => {
    expect(() => oauthProfileForService(svc)).toThrow(/oauthProfileForService:/);
  });

  test("error message names the offending service", () => {
    try {
      oauthProfileForService("github");
      throw new Error("expected oauthProfileForService('github') to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("github");
    }
  });

  const remainingUnsupported: ConnectorServiceId[] = [
    "snyk",
    "bitrise",
    "codemagic",
    "testflight",
    "firebase",
    "sonarqube",
    "semgrep",
    "wiz",
    "launchdarkly",
    "flagsmith",
    "argocd",
    "flux",
    "dbt",
    "metabase",
    "superset",
    "databricks",
    "mlflow",
    "vercel",
    "netlify",
    "stripe",
    "mercury",
    "readwise",
    "raindrop",
    "intercom",
    "zendesk",
    "lever",
    "greenhouse",
    "pipedrive",
    "stackoverflow",
    "zotero",
    "dependencytrack",
    "airflow",
    "prefect",
    "dagster",
    "ramp",
    "bigquery",
    "athena",
    "cloudwatch",
    "sagemaker",
    "cloud_logging",
    "vertex_ai",
    "elasticsearch",
    "great_expectations",
    "imap",
    "fastmail",
    "protonmail",
    "localdb",
    "storybook",
    "dataprofile",
  ];

  test.each(remainingUnsupported)("throws for remaining unsupported service %s", (svc) => {
    expect(() => oauthProfileForService(svc)).toThrow(/oauthProfileForService:/);
  });

  test("error message includes the service id for a sampling of remaining unsupported services", () => {
    const samples: ConnectorServiceId[] = ["snyk", "stripe", "bigquery", "imap", "dataprofile"];
    for (const svc of samples) {
      let caught: unknown;
      try {
        oauthProfileForService(svc);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(svc);
    }
  });
});

describe("oauthProfileForService — remaining supported OAuth providers", () => {
  test("returns Google provider profile for google_meet with meetings scope", () => {
    const profile = oauthProfileForService("google_meet");
    expect(profile.provider).toBe("google");
    expect(profile.defaultScopes).toContain(
      "https://www.googleapis.com/auth/meetings.space.readonly",
    );
  });

  test("returns zoom provider profile with meeting and recording scopes", () => {
    const profile = oauthProfileForService("zoom");
    expect(profile.provider).toBe("zoom");
    expect(profile.defaultScopes).toContain("user:read:user");
    expect(profile.defaultScopes).toContain("meeting:read:list_meetings");
    expect(profile.defaultScopes).toContain("cloud_recording:read:list_user_recordings");
  });

  test("returns hubspot provider profile with crm deals read scope", () => {
    const profile = oauthProfileForService("hubspot");
    expect(profile.provider).toBe("hubspot");
    expect(profile.defaultScopes).toContain("crm.objects.deals.read");
    expect(profile.defaultScopes).toContain("oauth");
  });

  test("returns miro provider profile with boards:read scope", () => {
    const profile = oauthProfileForService("miro");
    expect(profile.provider).toBe("miro");
    expect(profile.defaultScopes).toContain("boards:read");
  });

  test("returns canva provider profile with design:meta:read scope", () => {
    const profile = oauthProfileForService("canva");
    expect(profile.provider).toBe("canva");
    expect(profile.defaultScopes).toContain("design:meta:read");
  });

  test("returns figma provider profile with files:read scope", () => {
    const profile = oauthProfileForService("figma");
    expect(profile.provider).toBe("figma");
    expect(profile.defaultScopes).toContain("files:read");
  });

  test("returns salesforce provider profile with api and refresh_token scopes", () => {
    const profile = oauthProfileForService("salesforce");
    expect(profile.provider).toBe("salesforce");
    expect(profile.defaultScopes).toContain("api");
    expect(profile.defaultScopes).toContain("refresh_token");
  });
});

describe("oauthProfileForService — completeness", () => {
  test("every service in CONNECTOR_SERVICE_IDS either returns a profile or throws a structured error", () => {
    for (const svc of CONNECTOR_SERVICE_IDS) {
      let result: ReturnType<typeof oauthProfileForService> | undefined;
      let caught: unknown;
      try {
        result = oauthProfileForService(svc);
      } catch (err) {
        caught = err;
      }
      if (caught !== undefined) {
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/^oauthProfileForService:/);
        expect((caught as Error).message).toContain(svc);
      } else {
        expect(result).toBeDefined();
        expect(typeof (result as ReturnType<typeof oauthProfileForService>).provider).toBe(
          "string",
        );
        expect(
          Array.isArray((result as ReturnType<typeof oauthProfileForService>).defaultScopes),
        ).toBe(true);
      }
    }
  });
});
