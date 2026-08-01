import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

/** There is no `runMigrations` export — this wrapper matches every other test in the repo. */
function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

import { buildProjectedBody, projectTerm, unprojectTerm } from "./glossary-project.ts";
import type { GlossaryTerm } from "./glossary-types.ts";

let db: Database;

function term(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    termKey: "cdr",
    displayTerm: "CDR",
    status: "consolidated",
    definition: "Change Data Record — the per-row change envelope.",
    definitionSource: "llm",
    docFreq: 7,
    serviceSpread: 2,
    score: 3.2,
    form: "acronym",
    firstSeenAt: 100,
    lastSeenAt: 900,
    topSources: [],
    synonyms: ["Change Data Record"],
    nearMisses: [],
    consolidatedAt: 1000,
    statsVerifiedAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

test("projects a consolidated term as a nimbus:glossary_term item", () => {
  projectTerm(db, term(), 1000);
  const row = db.query("SELECT * FROM item WHERE type = 'glossary_term'").get() as {
    service: string;
    title: string;
    body_preview: string;
  } | null;
  expect(row?.service).toBe("nimbus");
  expect(row?.title).toBe("CDR");
  expect(row?.body_preview).toContain("Change Data Record");
});

test("synonyms land in body_preview so FTS can reach them", () => {
  projectTerm(db, term(), 1000);
  const hit = db
    .query("SELECT COUNT(*) AS c FROM item_fts WHERE item_fts MATCH ?")
    .get('"change data record"') as { c: number };
  expect(hit.c).toBeGreaterThan(0);
});

test("buildProjectedBody keeps synonyms even when the definition is long", () => {
  const body = buildProjectedBody("x".repeat(900), ["Change Data Record"]);
  expect(body.length).toBeLessThanOrEqual(512);
  expect(body).toContain("Change Data Record");
});

test("buildProjectedBody omits the synonym line when there are none", () => {
  expect(buildProjectedBody("short def", [])).toBe("short def");
});

test("projection is idempotent — re-projecting updates in place", () => {
  projectTerm(db, term(), 1000);
  projectTerm(db, term({ definition: "updated definition" }), 2000);
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all()).toHaveLength(1);
});

test("unprojectTerm removes the item row", () => {
  projectTerm(db, term(), 1000);
  unprojectTerm(db, "cdr");
  expect(db.query("SELECT * FROM item WHERE type = 'glossary_term'").all()).toHaveLength(0);
});

test("unprojectTerm is safe when nothing is projected", () => {
  expect(() => unprojectTerm(db, "absent")).not.toThrow();
});

test("a term with no definition is not projected", () => {
  expect(() => projectTerm(db, term({ definition: null }), 1000)).toThrow();
});

test("the projected item's modified_at is the term's lastSeenAt (a content date), not nowMs", () => {
  // Guards against a refactor silently swapping the two args: `modified_at`
  // must track when the team last USED the term, not when Nimbus happened to
  // run the pass.
  projectTerm(db, term({ lastSeenAt: 777 }), 999_999);
  const row = db.query("SELECT modified_at FROM item WHERE type = 'glossary_term'").get() as {
    modified_at: number;
  } | null;
  expect(row?.modified_at).toBe(777);
  expect(row?.modified_at).not.toBe(999_999);
});
