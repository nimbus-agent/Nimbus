import { describe, expect, test } from "bun:test";
import { auditCredentials, daysBetween, type LiveSecret } from "./credential-audit";
import type { CredentialEntry } from "./credential-registry";

const NOW = new Date("2026-07-20T00:00:00Z");

function entry(over: Partial<CredentialEntry> = {}): CredentialEntry {
  return {
    name: "TEST_SECRET",
    state: "required",
    location: { scope: "repo", repo: "Nimbus" },
    product: "actions",
    type: "pat",
    owner: "@AsafGolombek",
    consumedBy: [".github/workflows/ci.yml"],
    maxAgeDays: 90,
    hardDeadline: null,
    note: "test",
    ...over,
  };
}

function live(over: Partial<LiveSecret> = {}): LiveSecret {
  return {
    name: "TEST_SECRET",
    scope: "repo",
    repo: "Nimbus",
    product: "actions",
    updatedAt: "2026-07-19T00:00:00Z",
    ...over,
  };
}

const find = (rows: readonly { name: string; status: string; detail: string }[], n: string) =>
  rows.find((r) => r.name.includes(n));

describe("auditCredentials", () => {
  test("a required credential that is present and fresh is ok", () => {
    const rows = auditCredentials([entry()], [live()], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a required credential that is absent is a hard failure", () => {
    const rows = auditCredentials([entry()], [], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("missing");
  });

  test("an optional credential that is absent is ok — it is legitimately unset", () => {
    const rows = auditCredentials([entry({ state: "optional" })], [], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a forbidden credential that is absent is ok", () => {
    const rows = auditCredentials([entry({ state: "forbidden", maxAgeDays: null })], [], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a forbidden credential that exists is a hard failure — it came back", () => {
    const rows = auditCredentials([entry({ state: "forbidden", maxAgeDays: null })], [live()], NOW);
    expect(find(rows, "TEST_SECRET")?.status).toBe("present");
  });

  test("a live secret absent from the manifest is a hard failure", () => {
    const rows = auditCredentials([], [live({ name: "MYSTERY_TOKEN" })], NOW);
    const row = find(rows, "MYSTERY_TOKEN");
    expect(row?.status).toBe("undocumented");
    expect(row?.detail).toContain("Nimbus");
  });

  test("an over-age secret warns and says the SECRET was last set — never that the credential is old", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: 30 })],
      [live({ updatedAt: "2026-01-01T00:00:00Z" })],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("stale");
    expect(row?.detail).toContain("secret last set");
    expect(row?.detail).not.toContain("credential is");
  });

  test("maxAgeDays null opts out of age checks entirely", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, type: "signing-key" })],
      [live({ updatedAt: "2020-01-01T00:00:00Z" })],
      NOW,
    );
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("a hard deadline inside the 90-day lead time warns", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, hardDeadline: "2026-09-01" })],
      [live()],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("deadline");
    expect(row?.detail).toContain("2026-09-01");
  });

  test("a hard deadline beyond the lead time stays quiet", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, hardDeadline: "2027-09-01" })],
      [live()],
      NOW,
    );
    expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
  });

  test("org visibility wider than declared warns", () => {
    const rows = auditCredentials(
      [entry({ location: { scope: "org" }, expectedVisibility: "selected" })],
      [live({ scope: "org", repo: undefined, visibility: "all" })],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("visibility-drift");
    expect(row?.detail).toContain("selected");
  });

  test("the same name in two repos is not confused for one credential", () => {
    const rows = auditCredentials(
      [
        entry({ name: "DUP", location: { scope: "repo", repo: "Nimbus" } }),
        entry({ name: "DUP", location: { scope: "repo", repo: "nimbus-vscode" } }),
      ],
      [live({ name: "DUP", repo: "Nimbus" })],
      NOW,
    );
    const statuses = rows
      .filter((r) => r.name.includes("DUP"))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual(["missing", "ok"]);
  });

  test("Actions and Dependabot secrets of the same name are distinct credentials", () => {
    const rows = auditCredentials(
      [entry({ name: "SHARED", product: "dependabot" })],
      [live({ name: "SHARED", product: "actions" })],
      NOW,
    );
    const statuses = rows
      .filter((r) => r.name.includes("SHARED"))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual(["missing", "undocumented"]);
  });

  test("a stale manual audit warns", () => {
    const rows = auditCredentials([], [], new Date("2027-01-01T00:00:00Z"));
    expect(find(rows, "manual audit")?.status).toBe("audit-overdue");
  });

  test("a recent manual audit does not warn", () => {
    const rows = auditCredentials([], [], NOW);
    expect(find(rows, "manual audit")?.status).toBe("ok");
  });
});

describe("daysBetween", () => {
  test("counts whole days", () => {
    expect(daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-31T00:00:00Z"))).toBe(
      30,
    );
  });
});
