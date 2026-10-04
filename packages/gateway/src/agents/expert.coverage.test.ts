/**
 * expert.coverage.test.ts — the item-arm branches of agents/expert.ts the main suite leaves open:
 * the `opened` lane's empty case (a gap when no `opened` edge exists anywhere, silence when they
 * exist only for other items), the resolving PR's author as evidence, the resolves lane's
 * "edges exist elsewhere" silence, and an indexed item with no graph entity.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { dbRun } from "../db/write.ts";
import { upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runExpert } from "./expert.ts";

const ISSUE_URL = "https://acme.atlassian.net/browse/PLAT-9";
const OPENED_GAP = "Issues emit `opened` when the connector records an author — sync it.";
const RESOLVES_GAP =
  "A PR emits `resolves` when its body references the item key — reference it, and sync.";

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function seedIssue(db: Database, key: string, authorId: string | null): string {
  const t = Date.now();
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: key,
    title: `Issue ${key}`,
    bodyPreview: "",
    url: `https://acme.atlassian.net/browse/${key}`,
    modifiedAt: t,
    syncedAt: t,
    authorId,
    metadata: {},
  });
  return entityId(db, "issue", `jira:${key}`);
}

function seedResolvingPr(db: Database, num: number, authorId: string, issue: string): void {
  const t = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: `acme/web#${String(num)}`,
    title: `Fix ${String(num)}`,
    bodyPreview: "",
    url: `https://github.com/acme/web/pull/${String(num)}`,
    modifiedAt: t,
    syncedAt: t,
    authorId,
    metadata: { number: num, repo: "acme/web" },
  });
  upsertGraphRelation(
    db,
    entityId(db, "pr", `github:acme/web#${String(num)}`),
    issue,
    "resolves",
    t,
  );
}

function entityId(db: Database, type: string, externalId: string): string {
  const row = db
    .query("SELECT id FROM graph_entity WHERE type = ? AND external_id = ?")
    .get(type, externalId) as { id: string } | null;
  if (row === null) throw new Error(`no ${type} entity for ${externalId}`);
  return row.id;
}

function ctx(db: Database) {
  return { db, notify: () => {}, sessionId: "expert-cov" };
}

function remediations(brief: Awaited<ReturnType<typeof runExpert>>): Array<string | undefined> {
  return brief.gaps.map((g) => g.remediation);
}

describe("runExpert — the itemUrl arm's empty lanes", () => {
  test("no `opened` and no `resolves` edges anywhere: both lanes say so", async () => {
    const db = freshDb();
    seedIssue(db, "PLAT-9", null);

    const brief = await runExpert({ itemUrl: ISSUE_URL }, ctx(db));

    expect(brief.ranked).toEqual([]);
    expect(remediations(brief)).toContain(OPENED_GAP);
    expect(remediations(brief)).toContain(RESOLVES_GAP);
  });

  test("edges that exist only for OTHER items leave both lanes silent, not gapped", async () => {
    const db = freshDb();
    dbRun(db, "INSERT INTO person (id, display_name) VALUES ('p-rae', 'Rae')");
    seedIssue(db, "PLAT-9", null);
    // PLAT-10 has an opener AND a resolving PR — so neither relation is missing from the index;
    // PLAT-9 simply has none of them.
    const other = seedIssue(db, "PLAT-10", "p-rae");
    seedResolvingPr(db, 10, "p-rae", other);

    const brief = await runExpert({ itemUrl: ISSUE_URL }, ctx(db));

    expect(brief.ranked).toEqual([]);
    expect(remediations(brief)).not.toContain(OPENED_GAP);
    expect(remediations(brief)).not.toContain(RESOLVES_GAP);
  });
});

describe("runExpert — the resolving PR's author", () => {
  test("is ranked with pr_authored evidence from the resolving change", async () => {
    const db = freshDb();
    dbRun(db, "INSERT INTO person (id, display_name) VALUES ('p-lee', 'Lee')");
    const issue = seedIssue(db, "PLAT-9", null);
    seedResolvingPr(db, 482, "p-lee", issue);

    const brief = await runExpert({ itemUrl: ISSUE_URL }, ctx(db));

    expect(brief.ranked.map((f) => f.displayName)).toEqual(["Lee"]);
    const evidence = brief.ranked[0]?.evidence ?? [];
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      type: "pr_authored",
      itemId: "github:acme/web#482",
      title: "Fix 482",
      weight: 0.8,
    });
    expect(remediations(brief)).not.toContain(RESOLVES_GAP);
  });
});

describe("runExpert — an item the graph cannot reach", () => {
  test("an indexed page with no graph entity gaps in both item lanes", async () => {
    const db = freshDb();
    const t = Date.now();
    const pageUrl = "https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Runbook";
    upsertIndexedItem(db, {
      service: "confluence",
      type: "page",
      externalId: "1",
      title: "Checkout runbook",
      bodyPreview: "",
      url: pageUrl,
      modifiedAt: t,
      syncedAt: t,
      metadata: {},
    });

    const brief = await runExpert({ itemUrl: pageUrl }, ctx(db));

    const unreachable = brief.gaps.filter(
      (g) => g.detail === `\`${pageUrl}\` does not resolve to an indexed item with a graph entity.`,
    );
    expect(unreachable).toHaveLength(2);
    expect(unreachable[0]?.category).toBe("missing_entity_type");
    expect(brief.ranked).toEqual([]);
  });
});
