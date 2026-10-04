/**
 * Wiz issue shapes the main mapping suite does not send: an API base that is not on an `api.`
 * host, timestamps that do not parse, and issues with no entity, type or remediation at all.
 */
import { describe, expect, test } from "bun:test";

import { issueUrl, mapWizIssueToItem } from "./wiz-issue-mapping.ts";

const NOW = 1_700_000_000_000;
const API = "https://api.app.wiz.io/graphql";

describe("issueUrl — hosts without an api. prefix", () => {
  test("keeps the host as-is when it does not start with `api.`", () => {
    expect(issueUrl("https://app.wiz.io/graphql", "iss-9")).toBe(
      "https://app.wiz.io/issues#~(issue~'iss-9)",
    );
  });

  test("only a LEADING `api.` label is stripped, not one later in the host", () => {
    expect(issueUrl("https://eu.api.wiz.example/graphql", "iss-10")).toBe(
      "https://eu.api.wiz.example/issues#~(issue~'iss-10)",
    );
  });
});

describe("mapWizIssueToItem — unparseable timestamps", () => {
  test("an unparseable updatedAt falls back to createdAt", () => {
    const row = mapWizIssueToItem(
      { id: "i-1", updatedAt: "yesterday-ish", createdAt: "2024-03-15T12:00:00.000Z" },
      { apiBaseUrl: API, syncedAt: NOW },
    );
    expect(row?.modifiedAt).toBe(Date.parse("2024-03-15T12:00:00.000Z"));
    // The raw strings are still recorded verbatim — only modifiedAt needs a parse.
    expect(row?.metadata["updated_at"]).toBe("yesterday-ish");
  });

  test("when neither timestamp parses, modifiedAt is the sync time", () => {
    const row = mapWizIssueToItem(
      { id: "i-2", updatedAt: "not a date", createdAt: "also not a date" },
      { apiBaseUrl: API, syncedAt: NOW },
    );
    expect(row?.modifiedAt).toBe(NOW);
  });
});

describe("mapWizIssueToItem — sparse issues", () => {
  test("an issue with no entity, type, remediation or description maps every one of them to null", () => {
    const row = mapWizIssueToItem({ id: "bare-1" }, { apiBaseUrl: API, syncedAt: NOW });
    if (row === null) throw new Error("expected the bare issue to map");
    expect(row.metadata["entity_id"]).toBeNull();
    expect(row.metadata["entity_name"]).toBeNull();
    expect(row.metadata["entity_type"]).toBeNull();
    expect(row.metadata["type"]).toBeNull();
    expect(row.metadata["remediation"]).toBeNull();
    expect(row.metadata["description"]).toBeNull();
    expect(row.metadata["severity"]).toBeNull();
    expect(row.metadata["status"]).toBeNull();
    expect(row.title).toBe("bare-1");
    expect(row.bodyPreview).toBe("bare-1");
    expect(row.modifiedAt).toBe(NOW);
  });

  test("an entity whose fields are not strings contributes nulls rather than coerced values", () => {
    const row = mapWizIssueToItem(
      { id: "odd-1", entity: { id: 42, name: ["db"], type: null }, type: 7, remediation: false },
      { apiBaseUrl: API, syncedAt: NOW },
    );
    expect(row?.metadata["entity_id"]).toBeNull();
    expect(row?.metadata["entity_name"]).toBeNull();
    expect(row?.metadata["entity_type"]).toBeNull();
    expect(row?.metadata["type"]).toBeNull();
    expect(row?.metadata["remediation"]).toBeNull();
  });

  test("a non-object entity is ignored", () => {
    const row = mapWizIssueToItem(
      { id: "odd-2", entity: "prod-bucket" },
      { apiBaseUrl: API, syncedAt: NOW },
    );
    expect(row?.metadata["entity_id"]).toBeNull();
    expect(row?.metadata["entity_name"]).toBeNull();
  });
});
