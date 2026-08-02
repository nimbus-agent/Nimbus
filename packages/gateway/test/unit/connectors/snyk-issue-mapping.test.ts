import { describe, expect, test } from "bun:test";

import { mapSnykAggregatedIssueToItem } from "../../../src/connectors/snyk-issue-mapping.ts";

function makeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: "SNYK-JS-LODASH-1018905",
    issueType: "vuln",
    pkgName: "lodash",
    pkgVersions: ["4.17.20"],
    issueData: {
      id: "SNYK-JS-LODASH-1018905",
      title: "Prototype Pollution in lodash",
      severity: "high",
      url: "https://security.snyk.io/vuln/SNYK-JS-LODASH-1018905",
      description: "Affected versions of this package are vulnerable to prototype pollution.",
      identifiers: { CVE: ["CVE-2020-8203"], CWE: ["CWE-1321"] },
      publicationTime: "2020-07-16T12:00:00.000Z",
      disclosureTime: "2020-07-15T00:00:00.000Z",
    },
    isUpgradable: true,
    isPatchable: false,
    fixInfo: {
      isUpgradable: true,
      isPatchable: false,
      isFixable: true,
      fixedIn: ["4.17.21"],
    },
  };
  return { ...base, ...overrides };
}

describe("mapSnykAggregatedIssueToItem", () => {
  const ORG_ID = "org-uuid-1";
  const PROJECT_ID = "proj-uuid-1";
  const NOW = 1_700_000_000_000;

  test("returns null when the row is not a plain object", () => {
    expect(
      mapSnykAggregatedIssueToItem(null, { orgId: ORG_ID, projectId: PROJECT_ID, syncedAt: NOW }),
    ).toBeNull();
    expect(
      mapSnykAggregatedIssueToItem("nope", {
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        syncedAt: NOW,
      }),
    ).toBeNull();
    expect(
      mapSnykAggregatedIssueToItem(42, { orgId: ORG_ID, projectId: PROJECT_ID, syncedAt: NOW }),
    ).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makeIssue();
    delete noId["id"];
    expect(
      mapSnykAggregatedIssueToItem(noId, {
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        syncedAt: NOW,
      }),
    ).toBeNull();
    expect(
      mapSnykAggregatedIssueToItem(makeIssue({ id: "" }), {
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        syncedAt: NOW,
      }),
    ).toBeNull();
  });

  test("externalId joins orgId, projectId, and issueId with slashes for cross-project uniqueness", () => {
    const row = mapSnykAggregatedIssueToItem(makeIssue(), {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.externalId).toBe("org-uuid-1/proj-uuid-1/SNYK-JS-LODASH-1018905");
  });

  test("title falls back to id when issueData.title is missing", () => {
    const row = mapSnykAggregatedIssueToItem(
      makeIssue({ issueData: { id: "X", url: "https://x.example.com" } }),
      { orgId: ORG_ID, projectId: PROJECT_ID, syncedAt: NOW },
    );
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.title).toBe("SNYK-JS-LODASH-1018905");
  });

  test("severity is copied through when it matches the four-tier enum", () => {
    for (const sev of ["critical", "high", "medium", "low"] as const) {
      const issue = makeIssue();
      (issue["issueData"] as Record<string, unknown>)["severity"] = sev;
      const row = mapSnykAggregatedIssueToItem(issue, {
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        syncedAt: NOW,
      });
      if (row === null) {
        throw new Error("expected mapping to succeed");
      }
      expect(row.metadata["severity"]).toBe(sev);
    }
  });

  test("severity defaults to null on unrecognised values", () => {
    const issue = makeIssue();
    (issue["issueData"] as Record<string, unknown>)["severity"] = "garbage";
    const row = mapSnykAggregatedIssueToItem(issue, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.metadata["severity"]).toBeNull();
  });

  test("cve_id surfaces the first CVE identifier; null when none assigned", () => {
    const withCve = mapSnykAggregatedIssueToItem(makeIssue(), {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (withCve === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(withCve.metadata["cve_id"]).toBe("CVE-2020-8203");

    const noIdentifiers = makeIssue();
    (noIdentifiers["issueData"] as Record<string, unknown>)["identifiers"] = { CVE: [] };
    const row = mapSnykAggregatedIssueToItem(noIdentifiers, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.metadata["cve_id"]).toBeNull();
  });

  test("affected_package surfaces pkgName + pkgVersions", () => {
    const row = mapSnykAggregatedIssueToItem(makeIssue(), {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    const meta = row.metadata;
    expect(meta["affected_package"]).toBe("lodash");
    expect(meta["affected_versions"]).toEqual(["4.17.20"]);
  });

  test("fix_available reflects fixInfo.isFixable; fix_version is fixedIn[0]", () => {
    const fixable = mapSnykAggregatedIssueToItem(makeIssue(), {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (fixable === null) {
      throw new Error("expected mapping to succeed");
    }
    const fm = fixable.metadata;
    expect(fm["fix_available"]).toBe(true);
    expect(fm["fix_version"]).toBe("4.17.21");

    const unfixable = makeIssue({
      fixInfo: { isFixable: false, isUpgradable: false, isPatchable: false, fixedIn: [] },
    });
    const row = mapSnykAggregatedIssueToItem(unfixable, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    const um = row.metadata;
    expect(um["fix_available"]).toBe(false);
    expect(um["fix_version"]).toBeNull();
  });

  test("project_id, org_id, type, and project_url are surfaced in metadata", () => {
    const row = mapSnykAggregatedIssueToItem(makeIssue(), {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    const meta = row.metadata;
    expect(meta["project_id"]).toBe(PROJECT_ID);
    expect(meta["org_id"]).toBe(ORG_ID);
    expect(meta["type"]).toBe("vuln");
    expect(meta["project_url"]).toBe("https://app.snyk.io/org/org-uuid-1/project/proj-uuid-1");
  });

  test("disclosed_at + published_at are stored as ISO strings; modifiedAt prefers disclosure time", () => {
    const row = mapSnykAggregatedIssueToItem(makeIssue(), {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    const meta = row.metadata;
    expect(meta["disclosed_at"]).toBe("2020-07-15T00:00:00.000Z");
    expect(meta["published_at"]).toBe("2020-07-16T12:00:00.000Z");
    expect(row.modifiedAt).toBe(Date.parse("2020-07-15T00:00:00.000Z"));
  });

  test("modifiedAt falls back to syncedAt when both disclosure + publication are missing", () => {
    const issue = makeIssue();
    const d = issue["issueData"] as Record<string, unknown>;
    delete d["disclosureTime"];
    delete d["publicationTime"];
    const row = mapSnykAggregatedIssueToItem(issue, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.modifiedAt).toBe(NOW);
  });

  test("url is taken from issueData.url; canonicalUrl is the project URL", () => {
    const row = mapSnykAggregatedIssueToItem(makeIssue(), {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.url).toBe("https://security.snyk.io/vuln/SNYK-JS-LODASH-1018905");
    expect(row.canonicalUrl).toBe("https://app.snyk.io/org/org-uuid-1/project/proj-uuid-1");
  });

  test("body falls back to title when description is missing", () => {
    const issue = makeIssue();
    const d = issue["issueData"] as Record<string, unknown>;
    delete d["description"];
    const row = mapSnykAggregatedIssueToItem(issue, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.body).toBe("Prototype Pollution in lodash");
  });
});
