import { describe, expect, test } from "bun:test";

import { mapSnykAggregatedIssueToItem, projectUrl } from "./snyk-issue-mapping.ts";

const ctx = { orgId: "org", projectId: "proj", syncedAt: 500 };

describe("mapSnykAggregatedIssueToItem", () => {
  test("maps a full aggregated issue", () => {
    const row = mapSnykAggregatedIssueToItem(
      {
        id: "SNYK-1",
        issueType: "vuln",
        pkgName: "lodash",
        pkgVersions: ["4.17.0"],
        issueData: {
          title: "Prototype pollution",
          description: "Bad things",
          url: "https://snyk.io/vuln/SNYK-1",
          severity: "high",
          disclosureTime: "2026-01-01T00:00:00Z",
          publicationTime: "2026-02-01T00:00:00Z",
          identifiers: { CVE: ["", "CVE-2026-1"] },
        },
        fixInfo: { isFixable: true, fixedIn: ["4.17.21"] },
      },
      ctx,
    );
    expect(row?.externalId).toBe("org/proj/SNYK-1");
    expect(row?.title).toBe("Prototype pollution");
    expect(row?.body).toBe("Bad things");
    expect(row?.canonicalUrl).toBe(projectUrl("org", "proj"));
    expect(row?.modifiedAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(row?.metadata).toMatchObject({
      severity: "high",
      cve_id: "CVE-2026-1",
      affected_package: "lodash",
      fix_available: true,
      fix_version: "4.17.21",
      type: "vuln",
    });
  });

  test("an unknown severity is dropped; the fix flag is derived from fixedIn when isFixable is absent", () => {
    const row = mapSnykAggregatedIssueToItem(
      {
        id: "SNYK-2",
        issueData: { severity: "catastrophic", identifiers: { CVE: "not a list" } },
        fixInfo: { fixedIn: ["1.0.1"] },
      },
      ctx,
    );
    expect(row?.metadata["severity"]).toBeNull();
    expect(row?.metadata["cve_id"]).toBeNull();
    expect(row?.metadata["fix_available"]).toBe(true);
    const unfixed = mapSnykAggregatedIssueToItem({ id: "SNYK-3", fixInfo: { fixedIn: [] } }, ctx);
    expect(unfixed?.metadata["fix_available"]).toBe(false);
  });

  test("title and body fall back to the id; modified time falls back through publication to sync time", () => {
    const published = mapSnykAggregatedIssueToItem(
      {
        id: "SNYK-4",
        issueData: { disclosureTime: "bad", publicationTime: "2026-03-01T00:00:00Z" },
      },
      ctx,
    );
    expect(published?.title).toBe("SNYK-4");
    expect(published?.body).toBe("SNYK-4");
    expect(published?.modifiedAt).toBe(Date.parse("2026-03-01T00:00:00Z"));
    expect(
      mapSnykAggregatedIssueToItem({ id: "SNYK-5", issueData: { disclosureTime: "" } }, ctx)
        ?.modifiedAt,
    ).toBe(500);
  });

  test.each([[null], [{}], [{ id: "" }]])("rejects %p", (raw) => {
    expect(mapSnykAggregatedIssueToItem(raw, ctx)).toBeNull();
  });
});
