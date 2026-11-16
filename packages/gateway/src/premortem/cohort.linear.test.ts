import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { selectCohort } from "./cohort.ts";
import { affectedServicesForEpic, affectedServicesForEpics } from "./epic-services.ts";
import { JIRA_TRACKER, LINEAR_TRACKER } from "./epic-tracker.ts";
import { upsertPrNamingIssue } from "./linear-project.test-helpers.ts";
import { resolveLinearProject } from "./linear-project-ref.ts";
import { seedJiraViaSync, seedLinearViaSync } from "./tracker-writers.test-helpers.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const REPO = "acme/billing-api";
const TIMES = { openedAtMs: 1_000, mergedAtMs: 2_000 };
const P1 = "11111111-0000-4000-8000-0000000000b1";
const P2 = "22222222-0000-4000-8000-0000000000b2";
const OPTS = { maxCandidateScan: 200, maxCohortSize: 10 };

/** Two trackers, each built by its REAL writer, both reaching the same repo. */
async function seedBothTrackers(db: Database): Promise<void> {
  await seedJiraViaSync(db, {
    epics: [{ key: "PROJ-1" }, { key: "PROJ-9" }],
    children: [
      { key: "PROJ-2", parentKey: "PROJ-1" },
      { key: "PROJ-10", parentKey: "PROJ-9" },
    ],
  });
  await seedLinearViaSync(db, {
    projects: [
      { id: P1, name: "Linear closed", slugId: "lin000000001" },
      { id: P2, name: "Linear target", slugId: "lin000000002", statusType: "started" },
    ],
    issues: [
      { identifier: "ENG-1", projectId: P1 },
      { identifier: "ENG-2", projectId: P2 },
    ],
  });
  for (const title of ["Fix PROJ-2", "Fix PROJ-10", "Fix ENG-1", "Fix ENG-2"]) {
    upsertPrNamingIssue(db, { title, repo: REPO, ...TIMES });
  }
}

describe("selectCohort is tracker-scoped", () => {
  test("a Linear target never pulls a Jira epic into its cohort", async () => {
    const db = makeDb();
    await seedBothTrackers(db);
    const out = selectCohort(db, [REPO], {
      tracker: LINEAR_TRACKER,
      ...OPTS,
      excludeItemId: `linear:${P2}`,
    });
    expect(out.members.map((m) => m.itemId)).toEqual([`linear:${P1}`]);
    expect(out.members[0]?.key).toBe("lin000000001");
    expect(out.members[0]?.childCount).toBe(1);
  });

  test("a Jira target never pulls a Linear project into its cohort", async () => {
    const db = makeDb();
    await seedBothTrackers(db);
    const out = selectCohort(db, [REPO], {
      tracker: JIRA_TRACKER,
      ...OPTS,
      excludeItemId: "jira:PROJ-9",
    });
    expect(out.members.map((m) => m.itemId)).toEqual(["jira:PROJ-1"]);
  });

  test("an excluded item of the other tracker is refused, not trusted", async () => {
    const db = makeDb();
    await seedBothTrackers(db);
    expect(() =>
      selectCohort(db, [REPO], { tracker: LINEAR_TRACKER, ...OPTS, excludeItemId: "jira:PROJ-9" }),
    ).toThrow('belongs to "jira", not to the "linear" cohort');
  });
});

describe("affected services through a Linear project", () => {
  test("project -> issue (project_id) -> resolves -> PR repo, via the real writers", async () => {
    const db = makeDb();
    await seedBothTrackers(db);
    expect(affectedServicesForEpic(db, `linear:${P1}`)).toEqual([REPO]);
    expect(affectedServicesForEpic(db, "jira:PROJ-1")).toEqual([REPO]);
  });

  test("the batch form answers a Jira and a Linear id together", async () => {
    const db = makeDb();
    await seedBothTrackers(db);
    const out = affectedServicesForEpics(db, ["jira:PROJ-1", `linear:${P1}`, "github:nope"]);
    expect(out.get("jira:PROJ-1")).toEqual([REPO]);
    expect(out.get(`linear:${P1}`)).toEqual([REPO]);
    expect(out.has("github:nope")).toBe(false);
  });

  test("a PR indexed BEFORE its Linear issue yields no service (the stated ordering bound)", async () => {
    const db = makeDb();
    upsertPrNamingIssue(db, { title: "Fix ENG-1", repo: REPO, ...TIMES });
    await seedLinearViaSync(db, {
      projects: [{ id: P1, name: "A", slugId: "lin000000001" }],
      issues: [{ identifier: "ENG-1", projectId: P1 }],
    });
    expect(affectedServicesForEpic(db, `linear:${P1}`)).toEqual([]);
  });
});

describe("resolveLinearProject", () => {
  async function seed(db: Database): Promise<void> {
    await seedLinearViaSync(db, {
      projects: [
        { id: P1, name: "Zażółć gęślą", slugId: "lin000000001" },
        { id: P2, name: "Other", slugId: "lin000000002" },
      ],
    });
  }

  test("a non-ASCII name matches case-insensitively", async () => {
    const db = makeDb();
    await seed(db);
    expect(resolveLinearProject(db, "linear:ZAŻÓŁĆ GĘŚLĄ", "ZAŻÓŁĆ GĘŚLĄ").externalId).toBe(P1);
  });

  test("a URL with a trailing path, and a URL matched by the stored canonical url", async () => {
    const db = makeDb();
    await seed(db);
    const viaSlug = resolveLinearProject(
      db,
      "x",
      "https://linear.app/acme/project/anything-lin000000002/overview",
    );
    expect(viaSlug.externalId).toBe(P2);
    const stored = db.query("SELECT url FROM item WHERE external_id = ?").get(P1) as {
      url: string;
    };
    db.run("UPDATE item SET metadata = json_remove(metadata, '$.slug_id') WHERE external_id = ?", [
      P1,
    ]);
    expect(resolveLinearProject(db, "x", `${stored.url}/`).externalId).toBe(P1);
  });

  test("a project with no slug id displays its name, never its UUID", async () => {
    const db = makeDb();
    await seed(db);
    db.run("UPDATE item SET metadata = json_remove(metadata, '$.slug_id') WHERE external_id = ?", [
      P1,
    ]);
    const r = resolveLinearProject(db, "x", P1);
    expect(r.displayKey).toBe("Zażółć gęślą");
  });
});
