import { describe, expect, test } from "bun:test";

import { issueUrl, mapWizIssueToItem } from "../../../src/connectors/wiz-issue-mapping.ts";

function makeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: "abc-123",
    sourceRule: { id: "rule-1", name: "Publicly exposed S3 bucket" },
    severity: "HIGH",
    status: "OPEN",
    type: "TOXIC_COMBINATION",
    createdAt: "2024-03-15T12:00:00.000Z",
    updatedAt: "2024-03-16T09:30:00.000Z",
    resolvedAt: null,
    description: "Bucket is publicly readable from the internet.",
    remediation: "Set the bucket ACL to private and enable Block Public Access.",
    entity: { id: "ent-9", name: "prod-payments-bucket", type: "BUCKET" },
    projects: [{ id: "proj-1", name: "Payments", slug: "payments" }],
  };
  return { ...base, ...overrides };
}

const NOW = 1_700_000_000_000;
const API = "https://api.app.wiz.io/graphql";

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapWizIssueToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapWizIssueToItem(null, { apiBaseUrl: API, syncedAt: NOW })).toBeNull();
    expect(mapWizIssueToItem("nope", { apiBaseUrl: API, syncedAt: NOW })).toBeNull();
    expect(mapWizIssueToItem(42, { apiBaseUrl: API, syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makeIssue();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapWizIssueToItem(noId, { apiBaseUrl: API, syncedAt: NOW })).toBeNull();
    expect(mapWizIssueToItem(makeIssue({ id: "" }), { apiBaseUrl: API, syncedAt: NOW })).toBeNull();
  });

  test("service/type are fixed wiz/issue and externalId is the issue id", () => {
    const row = mapWizIssueToItem(makeIssue(), { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("wiz");
    expect(row.type).toBe("issue");
    expect(row.externalId).toBe("abc-123");
  });

  test("title comes from sourceRule.name; falls back to id when sourceRule absent", () => {
    const withRule = mapWizIssueToItem(makeIssue(), { apiBaseUrl: API, syncedAt: NOW });
    if (withRule === null) throw new Error("expected mapping to succeed");
    expect(withRule.title).toBe("Publicly exposed S3 bucket");

    const noRule = makeIssue();
    delete (noRule as Record<string, unknown>)["sourceRule"];
    const row = mapWizIssueToItem(noRule, { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("abc-123");
  });

  test("bodyPreview comes from description; falls back to title when absent", () => {
    const noDesc = makeIssue();
    delete (noDesc as Record<string, unknown>)["description"];
    const row = mapWizIssueToItem(noDesc, { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Publicly exposed S3 bucket");
  });

  test("severity accepts the 5-tier enum; unknown → null", () => {
    for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"]) {
      const row = mapWizIssueToItem(makeIssue({ severity: sev }), {
        apiBaseUrl: API,
        syncedAt: NOW,
      });
      if (row === null) throw new Error("expected mapping to succeed");
      expect(meta(row)["severity"]).toBe(sev);
    }
    const garbage = mapWizIssueToItem(makeIssue({ severity: "SEV1" }), {
      apiBaseUrl: API,
      syncedAt: NOW,
    });
    if (garbage === null) throw new Error("expected mapping to succeed");
    expect(meta(garbage)["severity"]).toBeNull();
  });

  test("status accepts the 4-state enum; unknown → null", () => {
    for (const st of ["OPEN", "IN_PROGRESS", "RESOLVED", "REJECTED"]) {
      const row = mapWizIssueToItem(makeIssue({ status: st }), { apiBaseUrl: API, syncedAt: NOW });
      if (row === null) throw new Error("expected mapping to succeed");
      expect(meta(row)["status"]).toBe(st);
    }
    const garbage = mapWizIssueToItem(makeIssue({ status: "DISMISSED" }), {
      apiBaseUrl: API,
      syncedAt: NOW,
    });
    if (garbage === null) throw new Error("expected mapping to succeed");
    expect(meta(garbage)["status"]).toBeNull();
  });

  test("source rule, entity, and free-text fields flow into metadata", () => {
    const row = mapWizIssueToItem(makeIssue(), { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["type"]).toBe("TOXIC_COMBINATION");
    expect(m["source_rule_id"]).toBe("rule-1");
    expect(m["source_rule_name"]).toBe("Publicly exposed S3 bucket");
    expect(m["entity_id"]).toBe("ent-9");
    expect(m["entity_name"]).toBe("prod-payments-bucket");
    expect(m["entity_type"]).toBe("BUCKET");
    expect(m["remediation"]).toBe("Set the bucket ACL to private and enable Block Public Access.");
    expect(m["created_at"]).toBe("2024-03-15T12:00:00.000Z");
    expect(m["updated_at"]).toBe("2024-03-16T09:30:00.000Z");
    expect(m["resolved_at"]).toBeNull();
  });

  test("projects surface as parallel id/name arrays; idless/non-object entries are dropped", () => {
    const row = mapWizIssueToItem(
      makeIssue({
        projects: [
          { id: "proj-1", name: "Payments" },
          { name: "no id — dropped" },
          null,
          { id: "proj-2" }, // name falls back to id
        ],
      }),
      { apiBaseUrl: API, syncedAt: NOW },
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["project_ids"]).toEqual(["proj-1", "proj-2"]);
    expect(meta(row)["project_names"]).toEqual(["Payments", "proj-2"]);
  });

  test("projects absent yields empty arrays", () => {
    const noProjects = makeIssue();
    delete (noProjects as Record<string, unknown>)["projects"];
    const row = mapWizIssueToItem(noProjects, { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["project_ids"]).toEqual([]);
    expect(meta(row)["project_names"]).toEqual([]);
  });

  test("modifiedAt prefers updatedAt, then createdAt, then syncedAt", () => {
    const both = mapWizIssueToItem(makeIssue(), { apiBaseUrl: API, syncedAt: NOW });
    if (both === null) throw new Error("expected mapping to succeed");
    expect(both.modifiedAt).toBe(Date.parse("2024-03-16T09:30:00.000Z"));

    const noUpdated = makeIssue();
    delete (noUpdated as Record<string, unknown>)["updatedAt"];
    const createdOnly = mapWizIssueToItem(noUpdated, { apiBaseUrl: API, syncedAt: NOW });
    if (createdOnly === null) throw new Error("expected mapping to succeed");
    expect(createdOnly.modifiedAt).toBe(Date.parse("2024-03-15T12:00:00.000Z"));

    const noDates = makeIssue();
    delete (noDates as Record<string, unknown>)["updatedAt"];
    delete (noDates as Record<string, unknown>)["createdAt"];
    const fallback = mapWizIssueToItem(noDates, { apiBaseUrl: API, syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("url and canonicalUrl agree and point at the user-facing host", () => {
    const row = mapWizIssueToItem(makeIssue(), { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBe(row.canonicalUrl);
    expect(row.canonicalUrl).toContain("https://app.wiz.io/issues");
    expect(row.canonicalUrl).toContain(encodeURIComponent("abc-123"));
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("syncedAt propagates onto the row", () => {
    const row = mapWizIssueToItem(makeIssue(), { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("issueUrl", () => {
  test("strips the leading api. segment to derive the app host", () => {
    expect(issueUrl("https://api.app.wiz.io/graphql", "iss-1")).toBe(
      `https://app.wiz.io/issues#~(issue~'${encodeURIComponent("iss-1")})`,
    );
  });

  test("regional api hosts keep their region segment after stripping api.", () => {
    expect(issueUrl("https://api.us2.app.wiz.io/graphql", "iss-2")).toBe(
      `https://us2.app.wiz.io/issues#~(issue~'${encodeURIComponent("iss-2")})`,
    );
  });

  test("falls back to a query-suffix form when the base URL does not parse", () => {
    expect(issueUrl("not a url", "iss-3")).toBe(`not a url#issue=${encodeURIComponent("iss-3")}`);
  });

  test("issue ids with reserved characters are percent-encoded", () => {
    const url = issueUrl("https://api.app.wiz.io/graphql", "a/b c");
    expect(url).toContain(encodeURIComponent("a/b c"));
  });
});
