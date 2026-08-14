import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  aggregateMissingEntityTypes,
  detectEmptyIndex,
  detectMissingConnector,
  detectMissingEntityType,
  detectMissingRelationEmit,
  detectMissingRelationToEntityType,
  remediationForEntityType,
} from "./gap-notes.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  return db;
}

import { LocalIndex } from "../../index/local-index.ts";

function withSchema(db: Database): Database {
  LocalIndex.ensureSchema(db);
  return db;
}

describe("detectEmptyIndex", () => {
  test("returns a gap note when item is empty", () => {
    const db = withSchema(freshDb());
    const note = detectEmptyIndex(db);
    expect(note).not.toBeNull();
    expect(note?.category).toBe("empty_index");
    expect(note?.remediation).toMatch(/nimbus connector sync/);
  });

  test("returns null when item has rows", () => {
    const db = withSchema(freshDb());
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('github:x', 'github', 'pr', 'x', 't', 0, 0)`,
    );
    expect(detectEmptyIndex(db)).toBeNull();
  });
});

describe("detectMissingConnector", () => {
  test("returns a gap note when sync_state has no row for the service", () => {
    const db = withSchema(freshDb());
    const note = detectMissingConnector(db, "pagerduty");
    expect(note?.category).toBe("missing_connector");
    expect(note?.detail).toMatch(/pagerduty/);
  });

  test("returns null when the service is registered", () => {
    const db = withSchema(freshDb());
    db.run("INSERT INTO sync_state (connector_id) VALUES ('pagerduty')");
    expect(detectMissingConnector(db, "pagerduty")).toBeNull();
  });
});

describe("detectMissingEntityType", () => {
  test("returns a gap note when graph_entity has no rows of the given type", () => {
    const db = withSchema(freshDb());
    const note = detectMissingEntityType(db, "incident");
    expect(note?.category).toBe("missing_entity_type");
    expect(note?.detail).toMatch(/incident/);
  });

  test("returns null when graph_entity has at least one row of the type", () => {
    const db = withSchema(freshDb());
    db.run(
      `INSERT INTO graph_entity (id, type, external_id, label, service)
       VALUES ('e1', 'incident', 'incident:1', 'PD-INC-1', 'pagerduty')`,
    );
    expect(detectMissingEntityType(db, "incident")).toBeNull();
  });
});

describe("remediationForEntityType", () => {
  test("returns a Phase-5 remediation hint for known data warehouse types", () => {
    expect(remediationForEntityType("dashboard")).toMatch(/Wave D/);
    expect(remediationForEntityType("data_model")).toMatch(/Wave D/);
  });

  test("returns a graph-populator hint for alert / pipeline_run", () => {
    expect(remediationForEntityType("alert")).toMatch(/graph-populator/);
    expect(remediationForEntityType("pipeline_run")).toMatch(/graph-populator/);
  });

  test("returns undefined for unknown types", () => {
    expect(remediationForEntityType("unknown_type")).toBeUndefined();
  });

  test("the incident remediation no longer promises a future populator", () => {
    expect(remediationForEntityType("incident") ?? "").not.toContain("follow-up");
  });

  test("returns a sync/rebody hint for incident", () => {
    const hint = remediationForEntityType("incident") ?? "";
    expect(hint).toMatch(/nimbus connector sync pagerduty/);
    expect(hint).toMatch(/nimbus index rebody/);
  });
});

describe("detectMissingRelationEmit", () => {
  test("returns a missing_relation_emit gap when graph_relation has no rows of the type", () => {
    const db = withSchema(freshDb());
    const note = detectMissingRelationEmit(db, "reviewed");
    expect(note?.category).toBe("missing_relation_emit");
    expect(note?.detail).toMatch(/`reviewed`/);
    expect(note?.remediation).toBeUndefined();
  });

  test("includes the supplied remediation string when provided", () => {
    const db = withSchema(freshDb());
    const note = detectMissingRelationEmit(db, "reviewed", "graph-populator follow-up");
    expect(note?.remediation).toBe("graph-populator follow-up");
  });

  test("returns null when graph_relation has at least one row of the type", () => {
    const db = withSchema(freshDb());
    db.run(
      `INSERT INTO graph_entity (id, type, external_id, label, service)
       VALUES ('e1', 'pr', 'r/x#1', 'PR x', 'github'),
              ('e2', 'person', 'alice', 'Alice', 'github')`,
    );
    db.run(
      `INSERT INTO graph_relation (from_id, to_id, type, weight, created_at)
       VALUES ('e2', 'e1', 'reviewed', 1.0, 0)`,
    );
    expect(detectMissingRelationEmit(db, "reviewed")).toBeNull();
  });
});

describe("detectMissingRelationToEntityType", () => {
  test("returns a missing_relation_emit gap when no edge of the type targets the given entity type", () => {
    const db = withSchema(freshDb());
    const note = detectMissingRelationToEntityType(db, "resolves", "incident");
    expect(note?.category).toBe("missing_relation_emit");
    expect(note?.detail).toMatch(/`resolves`/);
    expect(note?.detail).toMatch(/`incident`/);
  });

  test("includes the supplied remediation string when provided", () => {
    const db = withSchema(freshDb());
    const note = detectMissingRelationToEntityType(
      db,
      "resolves",
      "incident",
      "graph-populator follow-up",
    );
    expect(note?.remediation).toBe("graph-populator follow-up");
  });

  test("returns null when an edge of the type targets the given entity type", () => {
    const db = withSchema(freshDb());
    db.run(
      `INSERT INTO graph_entity (id, type, external_id, label, service)
       VALUES ('e1', 'incident', 'inc:1', 'Incident', 'pagerduty'),
              ('e2', 'person', 'alice', 'Alice', 'github')`,
    );
    db.run(
      `INSERT INTO graph_relation (from_id, to_id, type, weight, created_at)
       VALUES ('e2', 'e1', 'resolves', 1.0, 0)`,
    );
    expect(detectMissingRelationToEntityType(db, "resolves", "incident")).toBeNull();
  });

  test("I-2: an edge of the type that targets a DIFFERENT entity type does not suppress the gap — the exact bug this fixes", () => {
    const db = withSchema(freshDb());
    // A real `pr -> issue "resolves"` edge exists (this branch's own new edge
    // type), but nothing targets `incident`. The unscoped `detectMissingRelationEmit`
    // would find this row and wrongly report no gap.
    db.run(
      `INSERT INTO graph_entity (id, type, external_id, label, service)
       VALUES ('e1', 'issue', 'r/x#1', 'Issue', 'github'),
              ('e2', 'pr', 'r/x#2', 'PR', 'github')`,
    );
    db.run(
      `INSERT INTO graph_relation (from_id, to_id, type, weight, created_at)
       VALUES ('e2', 'e1', 'resolves', 1.0, 0)`,
    );
    expect(detectMissingRelationEmit(db, "resolves")).toBeNull();
    expect(detectMissingRelationToEntityType(db, "resolves", "incident")).not.toBeNull();
  });
});

import type { GapNote } from "./findings.ts";

describe("aggregateMissingEntityTypes", () => {
  test("collapses 3 missing_entity_type notes into 1 combined note", () => {
    const notes: GapNote[] = [
      {
        category: "missing_entity_type",
        detail: "No `data_model` graph entities — 0 data_models considered.",
      },
      {
        category: "missing_entity_type",
        detail: "No `dashboard` graph entities — 0 dashboards considered.",
      },
      {
        category: "missing_entity_type",
        detail: "No `pipeline_run` graph entities — 0 pipeline_runs considered.",
      },
    ];
    const out = aggregateMissingEntityTypes(notes);
    expect(out).toHaveLength(1);
    expect(out[0]?.detail).toMatch(/3 categories blocked/);
    expect(out[0]?.detail).toContain("`data_model`");
    expect(out[0]?.detail).toContain("`dashboard`");
    expect(out[0]?.detail).toContain("`pipeline_run`");
  });

  test("leaves 1-or-fewer missing_entity_type notes untouched", () => {
    const notes: GapNote[] = [
      {
        category: "missing_entity_type",
        detail: "No `incident` graph entities — 0 incidents considered.",
      },
      { category: "missing_connector", detail: "No sync_state row for `pagerduty`." },
    ];
    const out = aggregateMissingEntityTypes(notes);
    expect(out).toHaveLength(2);
  });
});
