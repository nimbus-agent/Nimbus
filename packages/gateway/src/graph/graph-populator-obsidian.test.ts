import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { syncGraphFromIndexedItem } from "./graph-populator.ts";

function freshDb(): Database {
  return createMemoryIndexDb();
}

test("syncObsidianNoteGraph upserts an obsidian_note entity and backlink edges from metadata", () => {
  const db = freshDb();
  const noteId = "obsidian:abc#Welcome.md";
  const linkedId = "obsidian:abc#Other.md";

  syncGraphFromIndexedItem(db, {
    id: linkedId,
    service: "obsidian",
    type: "obsidian_note",
    title: "Other",
    bodyPreview: null,
    authorId: null,
    metadata: { vault_id: "abc", resolved_wikilink_ids: [] },
  });

  syncGraphFromIndexedItem(db, {
    id: noteId,
    service: "obsidian",
    type: "obsidian_note",
    title: "Welcome",
    bodyPreview: null,
    authorId: null,
    metadata: { vault_id: "abc", resolved_wikilink_ids: [linkedId] },
  });

  const ents = db
    .query(
      "SELECT type, external_id, label FROM graph_entity WHERE type = 'obsidian_note' ORDER BY external_id",
    )
    .all() as Array<{ type: string; external_id: string; label: string }>;
  expect(ents).toHaveLength(2);

  const rels = db.query("SELECT type FROM graph_relation").all() as Array<{ type: string }>;
  expect(rels.some((r) => r.type === "backlinks")).toBe(true);
});

test("re-syncing a note replaces its outgoing backlink edges (no leak)", () => {
  const db = freshDb();
  const a = "obsidian:abc#A.md";
  const b = "obsidian:abc#B.md";
  const c = "obsidian:abc#C.md";

  for (const id of [b, c]) {
    syncGraphFromIndexedItem(db, {
      id,
      service: "obsidian",
      type: "obsidian_note",
      title: id,
      bodyPreview: null,
      authorId: null,
      metadata: { vault_id: "abc", resolved_wikilink_ids: [] },
    });
  }

  syncGraphFromIndexedItem(db, {
    id: a,
    service: "obsidian",
    type: "obsidian_note",
    title: "A",
    bodyPreview: null,
    authorId: null,
    metadata: { vault_id: "abc", resolved_wikilink_ids: [b] },
  });

  syncGraphFromIndexedItem(db, {
    id: a,
    service: "obsidian",
    type: "obsidian_note",
    title: "A",
    bodyPreview: null,
    authorId: null,
    metadata: { vault_id: "abc", resolved_wikilink_ids: [c] },
  });

  const rels = db
    .query("SELECT from_id, to_id, type FROM graph_relation WHERE type = 'backlinks'")
    .all() as Array<{ from_id: string; to_id: string; type: string }>;
  expect(rels).toHaveLength(1);
});
