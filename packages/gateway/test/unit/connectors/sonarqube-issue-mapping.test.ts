import { describe, expect, test } from "bun:test";

import { mapSonarIssueToItem } from "../../../src/connectors/sonarqube-issue-mapping.ts";

function makeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    key: "AYxr_random_issue_key",
    rule: "java:S1234",
    severity: "MAJOR",
    component: "myorg_myproject:src/main/java/Foo.java",
    project: "myorg_myproject",
    line: 42,
    status: "OPEN",
    message: "Replace null check with Optional",
    effort: "10min",
    debt: "10min",
    author: "alice@example.com",
    tags: ["security", "owasp-a3"],
    creationDate: "2024-03-15T12:00:00+0000",
    updateDate: "2024-03-16T09:30:00+0000",
    type: "VULNERABILITY",
  };
  return { ...base, ...overrides };
}

const NOW = 1_700_000_000_000;
const SAAS_BASE = "https://sonarcloud.io";
const ORG = "myorg";

describe("mapSonarIssueToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(
      mapSonarIssueToItem(null, { baseUrl: SAAS_BASE, organization: ORG, syncedAt: NOW }),
    ).toBeNull();
    expect(
      mapSonarIssueToItem("nope", { baseUrl: SAAS_BASE, organization: ORG, syncedAt: NOW }),
    ).toBeNull();
    expect(
      mapSonarIssueToItem(42, { baseUrl: SAAS_BASE, organization: ORG, syncedAt: NOW }),
    ).toBeNull();
  });

  test("returns null when key is missing or empty", () => {
    const noKey = makeIssue();
    delete noKey["key"];
    expect(
      mapSonarIssueToItem(noKey, { baseUrl: SAAS_BASE, organization: ORG, syncedAt: NOW }),
    ).toBeNull();
    expect(
      mapSonarIssueToItem(makeIssue({ key: "" }), {
        baseUrl: SAAS_BASE,
        organization: ORG,
        syncedAt: NOW,
      }),
    ).toBeNull();
  });

  test("externalId is the SonarQube issue key — stable across syncs", () => {
    const row = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.externalId).toBe("AYxr_random_issue_key");
  });

  test("severity is copied through when it matches the five-tier enum", () => {
    for (const sev of ["BLOCKER", "CRITICAL", "MAJOR", "MINOR", "INFO"] as const) {
      const issue = makeIssue();
      issue["severity"] = sev;
      const row = mapSonarIssueToItem(issue, {
        baseUrl: SAAS_BASE,
        organization: ORG,
        syncedAt: NOW,
      });
      if (row === null) {
        throw new Error("expected mapping to succeed");
      }
      expect(row.metadata["severity"]).toBe(sev);
    }
  });

  test("severity defaults to null on unrecognised values", () => {
    const issue = makeIssue({ severity: "garbage" });
    const row = mapSonarIssueToItem(issue, {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.metadata["severity"]).toBeNull();
  });

  test("type accepts BUG / VULNERABILITY / CODE_SMELL and rejects others", () => {
    for (const t of ["BUG", "VULNERABILITY", "CODE_SMELL"] as const) {
      const row = mapSonarIssueToItem(makeIssue({ type: t }), {
        baseUrl: SAAS_BASE,
        organization: ORG,
        syncedAt: NOW,
      });
      if (row === null) {
        throw new Error("expected mapping to succeed");
      }
      expect(row.metadata["type"]).toBe(t);
    }

    const garbage = mapSonarIssueToItem(makeIssue({ type: "WHATEVER" }), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (garbage === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(garbage.metadata["type"]).toBeNull();
  });

  test("status accepts the five Sonar status values", () => {
    for (const s of ["OPEN", "CONFIRMED", "REOPENED", "RESOLVED", "CLOSED"] as const) {
      const row = mapSonarIssueToItem(makeIssue({ status: s }), {
        baseUrl: SAAS_BASE,
        organization: ORG,
        syncedAt: NOW,
      });
      if (row === null) {
        throw new Error("expected mapping to succeed");
      }
      expect(row.metadata["status"]).toBe(s);
    }
  });

  test("file_path extracted from component after the colon", () => {
    const row = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.metadata["file_path"]).toBe("src/main/java/Foo.java");
  });

  test("file_path is null when component is the project root (no colon)", () => {
    const row = mapSonarIssueToItem(makeIssue({ component: "myorg_myproject" }), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.metadata["file_path"]).toBeNull();
  });

  test("line is preserved as an integer; null when missing", () => {
    const withLine = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (withLine === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(withLine.metadata["line"]).toBe(42);

    const noLine = makeIssue();
    delete noLine["line"];
    const row = mapSonarIssueToItem(noLine, {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.metadata["line"]).toBeNull();
  });

  test("tags are surfaced as a string array; non-strings filtered out", () => {
    const row = mapSonarIssueToItem(makeIssue({ tags: ["sec", 42, "x", null, "owasp"] }), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.metadata["tags"]).toEqual(["sec", "x", "owasp"]);
  });

  test("rule, effort, debt, author, project_key surfaced verbatim", () => {
    const row = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    const meta = row.metadata;
    expect(meta["rule"]).toBe("java:S1234");
    expect(meta["effort"]).toBe("10min");
    expect(meta["debt"]).toBe("10min");
    expect(meta["author"]).toBe("alice@example.com");
    expect(meta["project_key"]).toBe("myorg_myproject");
  });

  test("modifiedAt prefers updateDate over creationDate; falls back to syncedAt", () => {
    const both = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (both === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(both.modifiedAt).toBe(Date.parse("2024-03-16T09:30:00+0000"));

    const noDates = makeIssue();
    delete noDates["updateDate"];
    delete noDates["creationDate"];
    const fallback = mapSonarIssueToItem(noDates, {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (fallback === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("canonical URL embeds organization on SonarCloud, omits it for self-hosted", () => {
    const saasRow = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (saasRow === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(saasRow.canonicalUrl).toBe(
      `${SAAS_BASE}/project/issues?id=myorg&issues=AYxr_random_issue_key&open=AYxr_random_issue_key`,
    );

    const selfHosted = mapSonarIssueToItem(makeIssue(), {
      baseUrl: "https://sonar.example.com",
      organization: "",
      syncedAt: NOW,
    });
    if (selfHosted === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(selfHosted.canonicalUrl).toBe(
      "https://sonar.example.com/project/issues?issues=AYxr_random_issue_key&open=AYxr_random_issue_key",
    );
  });

  test("title and bodyPreview come from message; fall back to key when message is missing", () => {
    const withMessage = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (withMessage === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(withMessage.title).toBe("Replace null check with Optional");
    expect(withMessage.bodyPreview).toBe("Replace null check with Optional");

    const noMessage = makeIssue();
    delete noMessage["message"];
    const row = mapSonarIssueToItem(noMessage, {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(row.title).toBe("AYxr_random_issue_key");
  });

  test("organization metadata is null for self-hosted, populated for SaaS", () => {
    const saas = mapSonarIssueToItem(makeIssue(), {
      baseUrl: SAAS_BASE,
      organization: ORG,
      syncedAt: NOW,
    });
    if (saas === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(saas.metadata["organization"]).toBe(ORG);

    const selfHosted = mapSonarIssueToItem(makeIssue(), {
      baseUrl: "https://sonar.example.com",
      organization: "",
      syncedAt: NOW,
    });
    if (selfHosted === null) {
      throw new Error("expected mapping to succeed");
    }
    expect(selfHosted.metadata["organization"]).toBeNull();
  });
});
