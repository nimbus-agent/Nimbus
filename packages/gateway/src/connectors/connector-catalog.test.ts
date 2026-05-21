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
});

describe("oauthProfileForService — unsupported providers throw structured errors", () => {
  const unsupported: readonly ConnectorServiceId[] = [
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
});
