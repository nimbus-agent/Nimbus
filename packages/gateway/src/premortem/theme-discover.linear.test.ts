import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { upsertPrNamingIssue } from "./linear-project.test-helpers.ts";
import { runPremortemPass } from "./premortem-pass.ts";
import { discoverClosedEpics, mayBeUnminedLinearProjects } from "./theme-discover.ts";
import { seedJiraViaSync, seedLinearViaSync } from "./tracker-writers.test-helpers.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const P1 = "11111111-0000-4000-8000-0000000000a1";
const P2 = "22222222-0000-4000-8000-0000000000a2";
const OPEN = "33333333-0000-4000-8000-0000000000a3";

function setPassState(
  db: Database,
  watermarkMs: number,
  watermarkId: string,
  lastPassAt: number | null,
): void {
  db.run(
    "UPDATE premortem_pass_state SET watermark_ms = ?, watermark_id = ?, last_pass_at = ? WHERE id = 1",
    [watermarkMs, watermarkId, lastPassAt],
  );
}

describe("discoverClosedEpics, Linear arm", () => {
  test("discovers a closed project, not an open one, and merges both trackers by (modified_at, id)", async () => {
    const db = makeDb();
    await seedJiraViaSync(db, { epics: [{ key: "PROJ-1" }] });
    await seedLinearViaSync(db, {
      projects: [
        { id: P1, name: "Closed", updatedAt: "2026-03-01T00:00:00.000Z" },
        { id: OPEN, name: "Open", statusType: "started", updatedAt: "2026-03-02T00:00:00.000Z" },
      ],
    });
    const found = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
    expect(found.map((e) => e.itemId).sort((a, b) => a.localeCompare(b))).toEqual([
      "jira:PROJ-1",
      `linear:${P1}`,
    ]);
    const times = found.map((e) => e.modifiedAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("resumes strictly after the watermark across both arms", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, {
      projects: [
        { id: P1, name: "A", updatedAt: "2026-03-01T00:00:00.000Z" },
        { id: P2, name: "B", updatedAt: "2026-03-05T00:00:00.000Z" },
      ],
    });
    const after = Date.parse("2026-03-01T00:00:00.000Z");
    const found = discoverClosedEpics(db, {
      watermarkMs: after,
      watermarkId: `linear:${P1}`,
      batchSize: 50,
    });
    expect(found.map((e) => e.itemId)).toEqual([`linear:${P2}`]);
  });

  test("a batch is cut to batchSize after the merge", async () => {
    const db = makeDb();
    await seedJiraViaSync(db, { epics: [{ key: "PROJ-1" }, { key: "PROJ-2" }] });
    await seedLinearViaSync(db, {
      projects: [{ id: P1, name: "A", updatedAt: "2026-03-01T00:00:00.000Z" }],
    });
    expect(discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 2 })).toHaveLength(
      2,
    );
  });

  test("a project with status unknown is never discovered", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, { projects: [{ id: P1, name: "Odd", statusType: "mystery" }] });
    expect(discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 })).toEqual([]);
  });
});

describe("mayBeUnminedLinearProjects", () => {
  const OLD = "2026-03-01T00:00:00.000Z";
  const oldMs = Date.parse(OLD);

  test("counts a closed project updated at or before the watermark with no evidence", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, { projects: [{ id: P1, name: "A", updatedAt: OLD }] });
    setPassState(db, oldMs + 1, "", 1);
    expect(mayBeUnminedLinearProjects(db)).toBe(1);
    setPassState(db, oldMs, `linear:${P1}`, 1);
    expect(mayBeUnminedLinearProjects(db)).toBe(1);
  });

  test("does not count a newer, an open or an evidenced project", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, {
      projects: [
        { id: P1, name: "Newer", updatedAt: "2026-04-01T00:00:00.000Z" },
        { id: OPEN, name: "Open", statusType: "started", updatedAt: OLD },
        { id: P2, name: "Evidenced", updatedAt: OLD },
      ],
    });
    setPassState(db, oldMs + 1, "", 1);
    db.run(
      `INSERT INTO premortem_theme (id, service, label, normalized, status, confidence, updated_at)
       VALUES ('t1', 'acme/x', 'l', 'l', 'extracted', 0.5, 1)`,
    );
    db.run(
      `INSERT INTO premortem_theme_evidence (theme_id, item_id, evidence_key, label, occurred_at)
       VALUES ('t1', ?, 'k', 'l', 1)`,
      [`linear:${P2}`],
    );
    expect(mayBeUnminedLinearProjects(db)).toBe(0);
  });

  test("is 0 when the pass has never run", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, { projects: [{ id: P1, name: "A", updatedAt: OLD }] });
    setPassState(db, oldMs + 1, "", null);
    expect(mayBeUnminedLinearProjects(db)).toBe(0);
  });

  test("a project that was mined and produced no theme is still counted (an upper bound)", async () => {
    const db = makeDb();
    await seedLinearViaSync(db, { projects: [{ id: P1, name: "A", updatedAt: OLD }] });
    const r = await runPremortemPass(db, {
      nowMs: oldMs + 10,
      maxLlmCalls: 5,
      llm: { complete: async () => JSON.stringify({ themes: [] }) },
    });
    expect(r.noModel).toBe(false);
    expect(mayBeUnminedLinearProjects(db)).toBe(1);
  });
});

describe("runPremortemPass over both trackers", () => {
  test("a batch holding both writes evidence keyed by item id and the affected repo", async () => {
    const db = makeDb();
    await seedJiraViaSync(db, {
      epics: [{ key: "PROJ-1" }],
      children: [{ key: "PROJ-2", parentKey: "PROJ-1" }],
    });
    await seedLinearViaSync(db, {
      projects: [
        { id: P1, name: "Closed", updatedAt: "2026-03-01T00:00:00.000Z", content: "spec" },
      ],
      issues: [{ identifier: "ENG-1", projectId: P1 }],
    });
    const times = { openedAtMs: 1_000, mergedAtMs: 2_000 };
    upsertPrNamingIssue(db, { title: "Fix PROJ-2", repo: "acme/billing-api", ...times });
    upsertPrNamingIssue(db, { title: "Fix ENG-1", repo: "acme/billing-api", ...times });

    const r = await runPremortemPass(db, {
      nowMs: 100,
      maxLlmCalls: 5,
      llm: {
        complete: async () =>
          JSON.stringify({
            themes: [{ label: "rate limits", sources: ["jira:PROJ-1", `linear:${P1}`] }],
          }),
      },
    });
    expect(r.noModel).toBe(false);
    const rows = db
      .query("SELECT item_id FROM premortem_theme_evidence ORDER BY item_id")
      .all() as Array<{ item_id: string }>;
    expect(rows.map((x) => x.item_id)).toEqual(["jira:PROJ-1", `linear:${P1}`]);
    const theme = db.query("SELECT service FROM premortem_theme").get() as { service: string };
    expect(theme.service).toBe("acme/billing-api");
  });
});
