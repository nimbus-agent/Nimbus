import { describe, expect, test } from "bun:test";
import { auditCredentials, daysBetween, type LiveSecret } from "./credential-audit";
import {
  type CredentialEntry,
  HARD_DEADLINE_CRITICAL_DAYS,
  HARD_DEADLINE_LEAD_DAYS,
  LAST_MANUAL_AUDIT,
  MANUAL_AUDIT_MAX_AGE_DAYS,
} from "./credential-registry";

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
  // Org-scoped secrets never carry a `repo` (that's the whole point of the field
  // being optional) — only default one in when the (possibly-overridden) scope is
  // still "repo", so an org-scope override can't accidentally inherit "Nimbus".
  const scope = over.scope ?? "repo";
  return {
    name: "TEST_SECRET",
    scope,
    product: "actions",
    updatedAt: "2026-07-19T00:00:00Z",
    ...(scope === "repo" ? { repo: "Nimbus" } : {}),
    ...over,
  };
}

const find = (rows: readonly { name: string; status: string; detail: string }[], n: string) =>
  rows.find((r) => r.name.includes(n));

/** ISO date string exactly `days` after NOW, at midnight UTC — for hard-deadline boundary tests. */
function deadlineDaysOut(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

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

  test("an unparseable updatedAt is indeterminate, never ok, and never renders NaN", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: 30 })],
      [live({ updatedAt: "not-a-date" })],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).not.toBe("ok");
    expect(row?.status).toBe("indeterminate");
    expect(row?.detail).not.toContain("NaN");
  });

  test("a hard deadline inside the 90-day lead time warns as approaching, not as broken", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, hardDeadline: "2026-09-01" })],
      [live()],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("deadline-approaching");
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

  test("a blown deadline reads as overdue, never as a negative countdown", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, hardDeadline: "2026-01-01" })],
      [live()],
      NOW,
    );
    const row = find(rows, "TEST_SECRET");
    expect(row?.status).toBe("deadline-critical");
    expect(row?.detail).toContain("overdue by 200d");
    expect(row?.detail).not.toContain("in -200d");
  });

  // The whole point of the two-state split: a calendar row must never be
  // readable as "a provider rejected this credential". Both deadline details
  // therefore say, in words, that the credential still authenticates.
  test("both deadline states state in words that nothing has been rejected", () => {
    for (const days of [HARD_DEADLINE_LEAD_DAYS, HARD_DEADLINE_CRITICAL_DAYS]) {
      const rows = auditCredentials(
        [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(days) })],
        [live()],
        NOW,
      );
      const row = find(rows, "TEST_SECRET");
      expect(row?.detail).toContain("scheduled expiry");
      expect(row?.detail).toContain("not a rejected credential");
    }
  });

  test("an approaching deadline names the day it escalates, so the warning is actionable", () => {
    const rows = auditCredentials(
      [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(HARD_DEADLINE_LEAD_DAYS) })],
      [live()],
      NOW,
    );
    expect(find(rows, "TEST_SECRET")?.detail).toContain(
      `escalates to a hard failure at ${HARD_DEADLINE_CRITICAL_DAYS}d`,
    );
  });

  test("org visibility differs from declared warns, in either direction", () => {
    const wider = auditCredentials(
      [entry({ location: { scope: "org" }, expectedVisibility: "selected" })],
      [live({ scope: "org", visibility: "all" })],
      NOW,
    );
    const widerRow = find(wider, "TEST_SECRET");
    expect(widerRow?.status).toBe("visibility-drift");
    expect(widerRow?.detail).toContain("selected");

    const narrower = auditCredentials(
      [entry({ location: { scope: "org" }, expectedVisibility: "all" })],
      [live({ scope: "org", visibility: "selected" })],
      NOW,
    );
    const narrowerRow = find(narrower, "TEST_SECRET");
    expect(narrowerRow?.status).toBe("visibility-drift");
    expect(narrowerRow?.detail).toContain("all");
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

  test("Actions and Dependabot secrets of the same name are distinct credentials, and their labels say so", () => {
    const rows = auditCredentials(
      [entry({ name: "SHARED", product: "dependabot" })],
      [live({ name: "SHARED", product: "actions" })],
      NOW,
    );
    const matches = rows.filter((r) => r.name.includes("SHARED"));
    const names = matches.map((r) => r.name).sort();
    expect(names).toEqual(["Nimbus/SHARED", "Nimbus/SHARED (dependabot)"]);

    const byName = new Map(matches.map((r) => [r.name, r.status]));
    expect(byName.get("Nimbus/SHARED")).toBe("undocumented");
    expect(byName.get("Nimbus/SHARED (dependabot)")).toBe("missing");
  });

  test("a stale manual audit warns", () => {
    const rows = auditCredentials([], [], new Date("2027-01-01T00:00:00Z"));
    expect(find(rows, "manual audit")?.status).toBe("audit-overdue");
  });

  test("a recent manual audit does not warn", () => {
    const rows = auditCredentials([], [], NOW);
    expect(find(rows, "manual audit")?.status).toBe("ok");
  });

  describe("boundary conditions", () => {
    test("age exactly at maxAgeDays is ok, not stale", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: 30 })],
        [live({ updatedAt: "2026-06-20T00:00:00Z" })],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
    });

    test("age one day past maxAgeDays is stale", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: 30 })],
        [live({ updatedAt: "2026-06-19T00:00:00Z" })],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("stale");
    });

    test("age one day under maxAgeDays is ok", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: 30 })],
        [live({ updatedAt: "2026-06-21T00:00:00Z" })],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
    });

    test("a hard deadline exactly at the lead time warns", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(HARD_DEADLINE_LEAD_DAYS) })],
        [live()],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("deadline-approaching");
    });

    test("a hard deadline one day beyond the lead time stays quiet", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(HARD_DEADLINE_LEAD_DAYS + 1) })],
        [live()],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("ok");
    });

    test("a hard deadline one day inside the lead time warns", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(HARD_DEADLINE_LEAD_DAYS - 1) })],
        [live()],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("deadline-approaching");
    });

    // The escalation boundary. `deadline-approaching` warns; `deadline-critical`
    // fails. One day either side of HARD_DEADLINE_CRITICAL_DAYS is the exact
    // seam, so pin both sides and the boundary day itself.
    test("a hard deadline one day beyond the critical window still only warns", () => {
      const rows = auditCredentials(
        [
          entry({
            maxAgeDays: null,
            hardDeadline: deadlineDaysOut(HARD_DEADLINE_CRITICAL_DAYS + 1),
          }),
        ],
        [live()],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("deadline-approaching");
    });

    test("a hard deadline exactly at the critical window escalates to critical", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(HARD_DEADLINE_CRITICAL_DAYS) })],
        [live()],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("deadline-critical");
    });

    test("a hard deadline one day inside the critical window is critical", () => {
      const rows = auditCredentials(
        [
          entry({
            maxAgeDays: null,
            hardDeadline: deadlineDaysOut(HARD_DEADLINE_CRITICAL_DAYS - 1),
          }),
        ],
        [live()],
        NOW,
      );
      expect(find(rows, "TEST_SECRET")?.status).toBe("deadline-critical");
    });

    test("a hard deadline landing today is critical, and reads as 0 days, not overdue", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(0) })],
        [live()],
        NOW,
      );
      const row = find(rows, "TEST_SECRET");
      expect(row?.status).toBe("deadline-critical");
      expect(row?.detail).toContain("in 0d");
      expect(row?.detail).not.toContain("overdue");
    });

    test("a hard deadline one day past is critical and reads as overdue by 1d", () => {
      const rows = auditCredentials(
        [entry({ maxAgeDays: null, hardDeadline: deadlineDaysOut(-1) })],
        [live()],
        NOW,
      );
      const row = find(rows, "TEST_SECRET");
      expect(row?.status).toBe("deadline-critical");
      expect(row?.detail).toContain("overdue by 1d");
    });

    test("manual audit age exactly at the policy threshold is ok, not overdue", () => {
      const boundaryNow = new Date(
        new Date(`${LAST_MANUAL_AUDIT}T00:00:00Z`).getTime() +
          MANUAL_AUDIT_MAX_AGE_DAYS * 86_400_000,
      );
      const rows = auditCredentials([], [], boundaryNow);
      expect(find(rows, "manual audit")?.status).toBe("ok");
    });

    test("manual audit one day past the policy threshold is overdue", () => {
      const boundaryNow = new Date(
        new Date(`${LAST_MANUAL_AUDIT}T00:00:00Z`).getTime() +
          (MANUAL_AUDIT_MAX_AGE_DAYS + 1) * 86_400_000,
      );
      const rows = auditCredentials([], [], boundaryNow);
      expect(find(rows, "manual audit")?.status).toBe("audit-overdue");
    });

    test("manual audit one day under the policy threshold is ok", () => {
      const boundaryNow = new Date(
        new Date(`${LAST_MANUAL_AUDIT}T00:00:00Z`).getTime() +
          (MANUAL_AUDIT_MAX_AGE_DAYS - 1) * 86_400_000,
      );
      const rows = auditCredentials([], [], boundaryNow);
      expect(find(rows, "manual audit")?.status).toBe("ok");
    });
  });
});

describe("daysBetween", () => {
  test("counts whole days", () => {
    expect(daysBetween(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-31T00:00:00Z"))).toBe(
      30,
    );
  });

  test("is negative when `to` precedes `from`", () => {
    expect(daysBetween(new Date("2026-01-31T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(
      -30,
    );
  });
});
