import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { seedEpicWithServices } from "../premortem/cohort.test-helpers.ts";
import { seedLinearScenario } from "../premortem/linear-project.test-helpers.ts";
import { seedLinearViaSync } from "../premortem/tracker-writers.test-helpers.ts";
import { type PremortemContext, runPremortem } from "./premortem.ts";

const DAY_MS = 86_400_000;
const NOW = Date.now();
const REPO = "acme/billing-api";
const UUID_RE = /^[0-9a-f-]{36}$/;

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function ctx(db: Database): PremortemContext {
  return { db, notify: () => {}, sessionId: "s1" };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const PR_TIMES = { openedAtMs: NOW - 50 * DAY_MS, mergedAtMs: NOW - 45 * DAY_MS };

/** A target project plus two past ones (one completed, one canceled with only `canceledAt`). */
async function seedWorkspace(db: Database): Promise<void> {
  await seedLinearScenario(
    db,
    [
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        name: "Checkout rewrite",
        slugId: "tgt000000001",
        statusType: "started",
        createdAt: iso(NOW - 10 * DAY_MS),
        issuePrefix: "TGT",
        repos: [REPO],
      },
      {
        id: "bbbbbbbb-0000-4000-8000-000000000002",
        name: "Billing v2",
        slugId: "old000000002",
        createdAt: iso(NOW - 200 * DAY_MS),
        completedAt: iso(NOW - 60 * DAY_MS),
        issuePrefix: "OLDA",
        repos: [REPO],
      },
      {
        id: "cccccccc-0000-4000-8000-000000000003",
        name: "Invoicing",
        slugId: "old000000003",
        statusType: "canceled",
        createdAt: iso(NOW - 300 * DAY_MS),
        completedAt: null,
        canceledAt: iso(NOW - 100 * DAY_MS),
        issuePrefix: "OLDB",
        repos: [REPO],
      },
    ],
    PR_TIMES,
  );
}

describe("runPremortem for a Linear project", () => {
  test("resolves by slug id and produces services, a Linear-only cohort and five risks", async () => {
    const db = makeDb();
    await seedWorkspace(db);
    // A Jira epic sharing the repo must never enter a Linear cohort.
    seedEpicWithServices(db, {
      key: "JIRA-1",
      services: [REPO],
      resolvedAtMs: NOW - 30 * DAY_MS,
      createdAtMs: NOW - 90 * DAY_MS,
    });

    const brief = await runPremortem({ epicRef: "linear:tgt000000001" }, ctx(db));

    expect(brief.epic).toMatchObject({
      key: "tgt000000001",
      title: "Checkout rewrite",
      tracker: "linear",
    });
    expect(brief.epic?.key).not.toMatch(UUID_RE);
    expect(brief.services).toEqual([REPO]);
    const keys = brief.cohort.members.map((m) => m.key).sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(["old000000002", "old000000003"]);
    for (const m of brief.cohort.members) {
      expect(m.key).not.toMatch(UUID_RE);
      expect(m.itemId.startsWith("linear:")).toBe(true);
      expect(m.childCount).toBe(1);
    }
    expect(brief.risks).toHaveLength(5);
    const abandonment = brief.risks.find((r) => r.kind === "abandonment");
    expect(abandonment?.summary).toContain("1 of 2 comparable epics");
    expect(brief.gaps.some((g) => g.detail.includes("compares a Linear project only"))).toBe(true);
    expect(brief.gaps.some((g) => g.detail.includes("company-managed"))).toBe(false);
  });

  test("a Linear target never pulls a Jira epic into its cohort, and the reverse", async () => {
    const db = makeDb();
    await seedWorkspace(db);
    seedEpicWithServices(db, {
      key: "JIRA-2",
      services: [REPO],
      resolvedAtMs: NOW - 30 * DAY_MS,
      createdAtMs: NOW - 90 * DAY_MS,
    });
    seedEpicWithServices(db, {
      key: "JIRA-TGT",
      services: [REPO],
      resolvedAtMs: NOW - 2 * DAY_MS,
      createdAtMs: NOW - 5 * DAY_MS,
      statusCategory: "done",
    });

    const linear = await runPremortem({ epicRef: "linear:tgt000000001" }, ctx(db));
    expect(linear.cohort.members.every((m) => m.itemId.startsWith("linear:"))).toBe(true);

    const jira = await runPremortem({ epicRef: "JIRA-TGT" }, ctx(db));
    expect(jira.cohort.members.length).toBeGreaterThan(0);
    expect(jira.cohort.members.every((m) => m.itemId.startsWith("jira:"))).toBe(true);
  });

  test.each([
    ["the UUID", "linear:aaaaaaaa-0000-4000-8000-000000000001"],
    ["the slug id, any case", "linear:TGT000000001"],
    ["the exact name, any case", "linear:checkout REWRITE"],
    ["the project URL", "linear:https://linear.app/acme/project/checkout-rewrite-tgt000000001"],
    [
      "a bare linear.app URL",
      "https://linear.app/acme/project/checkout-rewrite-tgt000000001/overview",
    ],
  ])("resolves %s", async (_label, ref) => {
    const db = makeDb();
    await seedWorkspace(db);
    const brief = await runPremortem({ epicRef: ref }, ctx(db));
    expect(brief.epic?.title).toBe("Checkout rewrite");
    expect(brief.services).toEqual([REPO]);
  });

  test("a project with no indexed issues gets the Linear no-children gap", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, {
      projects: [
        {
          id: "dddddddd-0000-4000-8000-000000000004",
          name: "Empty",
          slugId: "emp000000004",
          statusType: "started",
        },
      ],
    });
    const brief = await runPremortem({ epicRef: "linear:emp000000004" }, ctx(db));
    expect(brief.services).toEqual([]);
    expect(brief.risks).toEqual([]);
    const gap = brief.gaps.find((g) => g.detail.includes("has no issues assigned to it"));
    expect(gap?.detail).toContain("nimbus index rebody --service linear");
    expect(brief.gaps.some((g) => g.detail.includes("company-managed"))).toBe(false);
  });

  test("a not-found reference throws and says how many projects are indexed", async () => {
    const db = makeDb();
    await seedWorkspace(db);
    await expect(runPremortem({ epicRef: "linear:nope" }, ctx(db))).rejects.toThrow(
      "was not found among 3 indexed Linear projects",
    );
  });

  test("nothing indexed is an error, not an empty brief", async () => {
    const db = makeDb();
    await expect(runPremortem({ epicRef: "linear:anything" }, ctx(db))).rejects.toThrow(
      "no Linear projects are indexed",
    );
  });

  test("an empty linear: key is an error", async () => {
    const db = makeDb();
    await expect(runPremortem({ epicRef: "linear:" }, ctx(db))).rejects.toThrow(
      "names no Linear project",
    );
  });

  test("an ambiguous name lists the candidates and asks for the slug id", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, {
      projects: [
        { id: "eeeeeeee-0000-4000-8000-000000000005", name: "Payments", slugId: "pay000000005" },
        { id: "ffffffff-0000-4000-8000-000000000006", name: "payments", slugId: "pay000000006" },
      ],
    });
    await expect(runPremortem({ epicRef: "linear:Payments" }, ctx(db))).rejects.toThrow(
      /matches 2 indexed Linear projects \(.*pay000000005.*pay000000006.*\)\. Pass the slug id/s,
    );
  });

  test("candidate names in the ambiguity error carry no control or bidi characters", async () => {
    const db = makeDb();
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x202e);
    await seedLinearViaSync(db, {
      projects: [
        {
          id: "eeeeeeee-0000-4000-8000-000000000015",
          name: `One${esc}[31m${rlo}`,
          slugId: "dup000000001",
        },
        {
          id: "ffffffff-0000-4000-8000-000000000016",
          name: "Two\r\nforged",
          slugId: "dup000000001",
        },
      ],
    });
    const err = await runPremortem({ epicRef: "linear:dup000000001" }, ctx(db)).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(err).toContain("matches 2 indexed Linear projects");
    for (const cp of [0x1b, 0x202e, 0x0d, 0x0a]) {
      expect(err?.includes(String.fromCodePoint(cp))).toBe(false);
    }
  });

  test("a project whose name equals another's slug id resolves by the slug first", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, {
      projects: [
        { id: "11111111-0000-4000-8000-000000000007", name: "Alpha", slugId: "aaa000000007" },
        {
          id: "22222222-0000-4000-8000-000000000008",
          name: "aaa000000007",
          slugId: "bbb000000008",
        },
      ],
    });
    const brief = await runPremortem({ epicRef: "linear:aaa000000007" }, ctx(db));
    expect(brief.epic?.title).toBe("Alpha");
  });

  test("an unsupported tracker still gives the foreign-tracker brief", async () => {
    const db = makeDb();
    const brief = await runPremortem({ epicRef: "asana:ABC-120" }, ctx(db));
    expect(brief.epic).toBeNull();
    expect(brief.gaps.some((g) => g.detail.includes("is not a supported tracker reference"))).toBe(
      true,
    );
  });

  test("the unmined-themes gap is an upper bound and appears only when N is positive", async () => {
    const db = makeDb();
    await seedWorkspace(db);
    // The pass has run, with a watermark past every project, and left no evidence.
    db.run(
      "UPDATE premortem_pass_state SET watermark_ms = ?, watermark_id = 'zzz', last_pass_at = ? WHERE id = 1",
      [NOW, NOW],
    );
    const brief = await runPremortem({ epicRef: "linear:tgt000000001" }, ctx(db));
    const gap = brief.gaps.find((g) =>
      g.detail.startsWith("Up to 2 closed Linear project(s) may not have been mined"),
    );
    expect(gap).toBeDefined();
    expect(gap?.detail).not.toContain("were skipped");
    const themeGap = brief.gaps.find((g) => g.detail.includes("No pre-mortem themes"));
    expect(themeGap?.remediation).toContain("--refresh");
    expect(themeGap?.detail).toContain("`--refresh` mines only projects updated after");

    db.run("UPDATE premortem_pass_state SET last_pass_at = NULL WHERE id = 1");
    const quiet = await runPremortem({ epicRef: "linear:tgt000000001" }, ctx(db));
    expect(quiet.gaps.some((g) => g.detail.includes("may not have been mined"))).toBe(false);
  });

  test("watchers are proposed per mapped service", async () => {
    const db = makeDb();
    await seedWorkspace(db);
    const brief = await runPremortem(
      { epicRef: "linear:tgt000000001" },
      {
        ...ctx(db),
        resolveServiceId: (item) =>
          item.metadata["repo"] === REPO
            ? { kind: "bound", serviceId: "billing-svc" }
            : { kind: "unknown" },
      },
    );
    expect(brief.watchers.length).toBeGreaterThan(0);
  });
});
