import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import type { GlossaryManualConfig } from "../config/nimbus-toml-glossary-terms.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { applyManualTerms } from "./glossary-manual.ts";
import { glossaryItemExternalId } from "./glossary-project.ts";
import { getTerm } from "./glossary-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

function cfg(
  terms: Array<{ termKey: string; displayTerm: string; definition: string }>,
  synonyms: Array<[string, string]> = [],
): GlossaryManualConfig {
  return { loaded: true, terms, synonyms: new Map(synonyms), skipped: [] };
}

/** Indexes `count` items whose text mentions `term`, so FTS can evidence it. */
function seedEvidence(term: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    upsertIndexedItem(db, {
      service: "slack",
      type: "message",
      externalId: `m${String(i)}`,
      title: `About ${term}`,
      bodyPreview: `We discussed ${term} at length today.`,
      url: null,
      canonicalUrl: null,
      modifiedAt: 1000 + i,
      syncedAt: 1,
      metadata: {},
    });
  }
}

function projectedExists(termKey: string): boolean {
  return (
    db
      .query("SELECT 1 FROM item WHERE service = 'nimbus' AND external_id = ?")
      .get(glossaryItemExternalId(termKey)) !== null
  );
}

test("an authored term lands consolidated with definition_source manual", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.definitionSource).toBe("manual");
  expect(t?.definition).toBe("Audit row.");
  expect(t?.displayTerm).toBe("CDR");
  expect(projectedExists("cdr")).toBe(true);
});

test("an authored term with no mined evidence is still accepted", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("consolidated");
  expect(t?.docFreq).toBe(0);
});

test("statistics are measured when evidence exists", () => {
  seedEvidence("widget", 4);
  applyManualTerms(
    db,
    cfg([{ termKey: "widget", displayTerm: "Widget", definition: "A thing." }]),
    { nowMs: 5000 },
  );
  const t = getTerm(db, "widget");
  expect(t?.docFreq).toBe(4);
  expect(t?.topSources.length).toBeGreaterThan(0);
});

test("synonyms from config reach the row", () => {
  applyManualTerms(
    db,
    cfg(
      [{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }],
      [["change data record", "cdr"]],
    ),
    { nowMs: 5000 },
  );
  expect(getTerm(db, "cdr")?.synonyms).toEqual(["change data record"]);

  // Also reach the PROJECTED body, not just the row: item_fts indexes only
  // title and body_preview, so a synonym living in the row alone would leave
  // `nimbus ask "what does change data record mean?"` finding nothing.
  const projected = db
    .query("SELECT body_preview FROM item WHERE service = 'nimbus' AND external_id = ?")
    .get(glossaryItemExternalId("cdr")) as { body_preview: string } | null;
  expect(projected?.body_preview).toContain("change data record");
});

test("an edited definition replaces the stored one", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "First." }]), {
    nowMs: 5000,
  });
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Second." }]), {
    nowMs: 6000,
  });
  expect(getTerm(db, "cdr")?.definition).toBe("Second.");
});

test("an edited display form replaces the stored one", () => {
  // The pre-pass upsert overwrites display_term UNCONDITIONALLY — the opposite
  // of the mining upsert's policy. Both directions are pinned; see the
  // mining-side test in glossary-extract.test.ts.
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "d" }]), {
    nowMs: 5000,
  });
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDRs", definition: "d" }]), {
    nowMs: 6000,
  });
  expect(getTerm(db, "cdr")?.displayTerm).toBe("CDRs");
});

test("an unchanged term is not rewritten on a later pass", () => {
  const conf = cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]);
  applyManualTerms(db, conf, { nowMs: 5000 });

  const second = applyManualTerms(db, conf, { nowMs: 6000 });

  expect(second.added).toBe(0);
  // `updated_at` is the tell: an unchanged term must not be touched at all,
  // because touching it means recomputing its statistics (2 FTS queries) on
  // every pass, after every connector sync, forever.
  expect(getTerm(db, "cdr")?.updatedAt).toBe(5000);
});

test("a changed definition IS rewritten even when the display form matches", () => {
  // Guards the unchanged-check against being too eager. Separate fixtures for
  // each field, so a check that compares only one of them cannot pass.
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "First." }]), {
    nowMs: 5000,
  });
  const second = applyManualTerms(
    db,
    cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Second." }]),
    { nowMs: 6000 },
  );
  expect(second.added).toBe(1);
  expect(getTerm(db, "cdr")?.definition).toBe("Second.");
});

test("a changed synonym set IS rewritten even when the definition matches", () => {
  const term = { termKey: "cdr", displayTerm: "CDR", definition: "Audit row." };
  applyManualTerms(db, cfg([term]), { nowMs: 5000 });
  const second = applyManualTerms(db, cfg([term], [["change data record", "cdr"]]), {
    nowMs: 6000,
  });
  expect(second.added).toBe(1);
  expect(getTerm(db, "cdr")?.synonyms).toEqual(["change data record"]);
});

test("removal demotes the row and deletes its projected item", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });
  expect(projectedExists("cdr")).toBe(true);

  const summary = applyManualTerms(db, cfg([]), { nowMs: 6000 });

  expect(summary.removed).toBe(1);
  const t = getTerm(db, "cdr");
  expect(t?.status).toBe("pending");
  expect(t?.definition).toBeNull();
  expect(t?.definitionSource).toBeNull();
  expect(projectedExists("cdr")).toBe(false);
});

test("an unreadable config deletes nothing", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });

  const summary = applyManualTerms(db, { loaded: false }, { nowMs: 6000 });

  expect(summary.removed).toBe(0);
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
  expect(projectedExists("cdr")).toBe(true);
});

test("removal leaves a mined term's own row alone", () => {
  seedEvidence("widget", 4);
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "d" }]), {
    nowMs: 5000,
  });
  db.run(
    `INSERT INTO glossary_term
       (term_key, display_term, status, definition, definition_source,
        doc_freq, first_seen_at, last_seen_at, updated_at)
     VALUES ('widget', 'Widget', 'consolidated', 'mined', 'llm', 4, 1, 2, 3)`,
  );

  applyManualTerms(db, cfg([]), { nowMs: 6000 });

  const mined = getTerm(db, "widget");
  expect(mined?.status).toBe("consolidated");
  expect(mined?.definition).toBe("mined");
});

test("the upsert is atomic — a crash between the row write and the projection rolls both back", () => {
  // Mirrors glossary-extract.test.ts's "consolidation is atomic" and
  // glossary-reconcile.test.ts's "demotion is atomic": a DB-level trigger
  // fires exactly on projectTerm's INSERT into `item`, so upsertManualTerm's
  // write has genuinely already run (not merely "about to run") before the
  // failure. This is NOT wrapped in an outer transaction, so it exercises
  // applyManualTerms's own `db.transaction()` and nothing else's.
  db.run(
    `CREATE TRIGGER simulated_crash_before_project
     BEFORE INSERT ON item
     WHEN NEW.type = 'glossary_term'
     BEGIN SELECT RAISE(ABORT, 'simulated crash before projectTerm'); END`,
  );

  expect(() =>
    applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
      nowMs: 5000,
    }),
  ).toThrow();

  db.run("DROP TRIGGER simulated_crash_before_project");

  // Had upsertManualTerm's write not been rolled back with the projection,
  // "cdr" would be sitting `consolidated` with no searchable item — the
  // exact stranded state the transaction exists to prevent.
  expect(getTerm(db, "cdr")).toBeNull();
  expect(projectedExists("cdr")).toBe(false);
});

test("the removal is atomic — a crash between unproject and demote rolls both back", () => {
  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });
  expect(projectedExists("cdr")).toBe(true);

  // Fires exactly on demoteTerm's UPDATE, after unprojectTerm's DELETE has
  // already run, so the same "already-applied first write, not merely
  // about-to-run" property holds as the upsert-atomicity test above.
  db.run(
    `CREATE TRIGGER simulated_crash_before_demote
     BEFORE UPDATE OF status ON glossary_term
     WHEN NEW.status = 'pending' AND OLD.definition_source = 'manual'
     BEGIN SELECT RAISE(ABORT, 'simulated crash before demoteTerm'); END`,
  );

  expect(() => applyManualTerms(db, cfg([]), { nowMs: 6000 })).toThrow();

  db.run("DROP TRIGGER simulated_crash_before_demote");

  // Had unprojectTerm's DELETE not been rolled back with demoteTerm's UPDATE,
  // "cdr" would have lost its searchable item while still reporting
  // `consolidated` with a `manual` definition — a stale-but-plausible-looking
  // state, worse than either committed outcome.
  expect(projectedExists("cdr")).toBe(true);
  expect(getTerm(db, "cdr")?.status).toBe("consolidated");
});

test("a mined row is taken over when an authored entry exactly matches its stored content", () => {
  // The isUnchanged guard treats a non-manual row as never "unchanged", even
  // when every AUTHORED field it compares — definition, display form,
  // synonyms — already matches verbatim. Without that guard this row would
  // look unchanged and the mined row would never be taken over by the
  // authored one, contradicting "config is desired state for the manual
  // subspace" (an authored key is always upserted, mined-or-not).
  db.run(
    `INSERT INTO glossary_term
       (term_key, display_term, status, definition, definition_source,
        doc_freq, first_seen_at, last_seen_at, synonyms, updated_at)
     VALUES ('cdr', 'CDR', 'consolidated', 'Audit row.', 'llm', 4, 1, 2, '[]', 1000)`,
  );

  applyManualTerms(db, cfg([{ termKey: "cdr", displayTerm: "CDR", definition: "Audit row." }]), {
    nowMs: 5000,
  });

  const t = getTerm(db, "cdr");
  expect(t?.definitionSource).toBe("manual");
  expect(t?.updatedAt).toBe(5000);
});
