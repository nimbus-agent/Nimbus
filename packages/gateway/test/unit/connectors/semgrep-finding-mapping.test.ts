import { describe, expect, test } from "bun:test";

import { mapSemgrepFindingToItem } from "../../../src/connectors/semgrep-finding-mapping.ts";

function makeFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: "12345",
    syntactic_id: "syn-67890",
    rule_name: "javascript.lang.security.audit.xss.direct-response-write",
    rule_message: "User input flows into HTTP response without escaping.",
    severity: "high",
    confidence: "high",
    categories: ["security"],
    location: {
      file_path: "src/api/user.js",
      line: 42,
      column: 10,
      end_line: 42,
      end_column: 50,
    },
    repository: {
      name: "acme/payments",
      url: "https://github.com/acme/payments",
    },
    ref: "main",
    triage_state: "untriaged",
    status: "open",
    created_at: "2024-03-15T12:00:00.000Z",
    relevant_since: "2024-03-16T09:30:00.000Z",
    line_of_code_url: "https://semgrep.dev/orgs/acme/findings/12345/code",
  };
  return { ...base, ...overrides };
}

const NOW = 1_700_000_000_000;
const SLUG = "acme-corp";

describe("mapSemgrepFindingToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapSemgrepFindingToItem(null, { deploymentSlug: SLUG, syncedAt: NOW })).toBeNull();
    expect(mapSemgrepFindingToItem("nope", { deploymentSlug: SLUG, syncedAt: NOW })).toBeNull();
    expect(mapSemgrepFindingToItem(42, { deploymentSlug: SLUG, syncedAt: NOW })).toBeNull();
  });

  test("returns null when both id and syntactic_id are missing", () => {
    const noIds = makeFinding();
    delete (noIds as Record<string, unknown>)["id"];
    delete (noIds as Record<string, unknown>)["syntactic_id"];
    expect(mapSemgrepFindingToItem(noIds, { deploymentSlug: SLUG, syncedAt: NOW })).toBeNull();
  });

  test("externalId prefers `id` over `syntactic_id`", () => {
    const row = mapSemgrepFindingToItem(makeFinding(), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe("12345");
  });

  test("externalId falls back to syntactic_id when id is missing", () => {
    const noId = makeFinding();
    delete (noId as Record<string, unknown>)["id"];
    const row = mapSemgrepFindingToItem(noId, {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe("syn-67890");
  });

  test("severity normalized to lowercase 5-tier enum; unknown → null", () => {
    for (const sev of ["critical", "high", "medium", "low", "info"]) {
      const row = mapSemgrepFindingToItem(makeFinding({ severity: sev.toUpperCase() }), {
        deploymentSlug: SLUG,
        syncedAt: NOW,
      });
      if (row === null) throw new Error("expected mapping to succeed");
      expect((row.metadata as Record<string, unknown>)["severity"]).toBe(sev);
    }
    const garbage = mapSemgrepFindingToItem(makeFinding({ severity: "garbage" }), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (garbage === null) throw new Error("expected mapping to succeed");
    expect((garbage.metadata as Record<string, unknown>)["severity"]).toBeNull();
  });

  test("confidence accepts high/medium/low only", () => {
    for (const c of ["high", "medium", "low"]) {
      const row = mapSemgrepFindingToItem(makeFinding({ confidence: c }), {
        deploymentSlug: SLUG,
        syncedAt: NOW,
      });
      if (row === null) throw new Error("expected mapping to succeed");
      expect((row.metadata as Record<string, unknown>)["confidence"]).toBe(c);
    }
  });

  test("triage_state accepts the four states", () => {
    for (const s of ["untriaged", "triaged", "ignored", "muted"]) {
      const row = mapSemgrepFindingToItem(makeFinding({ triage_state: s }), {
        deploymentSlug: SLUG,
        syncedAt: NOW,
      });
      if (row === null) throw new Error("expected mapping to succeed");
      expect((row.metadata as Record<string, unknown>)["triage_state"]).toBe(s);
    }
  });

  test("location.file_path, line, end_line, column flow into metadata as primitives", () => {
    const row = mapSemgrepFindingToItem(makeFinding(), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta["file_path"]).toBe("src/api/user.js");
    expect(meta["line"]).toBe(42);
    expect(meta["end_line"]).toBe(42);
    expect(meta["column"]).toBe(10);
  });

  test("location absent yields null file_path / null integers", () => {
    const noLoc = makeFinding();
    delete (noLoc as Record<string, unknown>)["location"];
    const row = mapSemgrepFindingToItem(noLoc, { deploymentSlug: SLUG, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta["file_path"]).toBeNull();
    expect(meta["line"]).toBeNull();
    expect(meta["end_line"]).toBeNull();
    expect(meta["column"]).toBeNull();
  });

  test("repository.name and url propagate to metadata", () => {
    const row = mapSemgrepFindingToItem(makeFinding(), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta["repository"]).toBe("acme/payments");
    expect(meta["repository_url"]).toBe("https://github.com/acme/payments");
  });

  test("categories are surfaced as a string array; non-strings filtered out", () => {
    const row = mapSemgrepFindingToItem(
      makeFinding({ categories: ["security", 42, "best-practice", null] }),
      { deploymentSlug: SLUG, syncedAt: NOW },
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect((row.metadata as Record<string, unknown>)["categories"]).toEqual([
      "security",
      "best-practice",
    ]);
  });

  test("modifiedAt prefers relevant_since over created_at; falls back to syncedAt", () => {
    const both = mapSemgrepFindingToItem(makeFinding(), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (both === null) throw new Error("expected mapping to succeed");
    expect(both.modifiedAt).toBe(Date.parse("2024-03-16T09:30:00.000Z"));

    const noDates = makeFinding();
    delete (noDates as Record<string, unknown>)["relevant_since"];
    delete (noDates as Record<string, unknown>)["created_at"];
    const fallback = mapSemgrepFindingToItem(noDates, {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("canonical URL embeds the deployment slug + finding id", () => {
    const row = mapSemgrepFindingToItem(makeFinding(), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe(`https://semgrep.dev/orgs/${SLUG}/findings/12345`);
  });

  test("url prefers line_of_code_url over canonicalUrl when set", () => {
    const row = mapSemgrepFindingToItem(makeFinding(), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBe("https://semgrep.dev/orgs/acme/findings/12345/code");
  });

  test("title + bodyPreview come from rule_message; fall back to rule_name when missing", () => {
    const withMsg = mapSemgrepFindingToItem(makeFinding(), {
      deploymentSlug: SLUG,
      syncedAt: NOW,
    });
    if (withMsg === null) throw new Error("expected mapping to succeed");
    expect(withMsg.title).toBe("User input flows into HTTP response without escaping.");

    const noMsg = makeFinding();
    delete (noMsg as Record<string, unknown>)["rule_message"];
    const row = mapSemgrepFindingToItem(noMsg, { deploymentSlug: SLUG, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("javascript.lang.security.audit.xss.direct-response-write");
  });

  test("branch falls back from ref to found_in_branch", () => {
    const noRef = makeFinding({ ref: undefined, found_in_branch: "release/2025-q1" });
    delete (noRef as Record<string, unknown>)["ref"];
    const row = mapSemgrepFindingToItem(noRef, { deploymentSlug: SLUG, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect((row.metadata as Record<string, unknown>)["branch"]).toBe("release/2025-q1");
  });
});
