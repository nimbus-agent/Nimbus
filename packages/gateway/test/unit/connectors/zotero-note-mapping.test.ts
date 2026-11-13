import { describe, expect, test } from "bun:test";

import {
  mapZoteroNoteToItem,
  noteBodyText,
  noteTitle,
} from "../../../src/connectors/zotero-note-mapping.ts";
import { isProseHeavy } from "../../../src/embedding/routing.ts";
import { bodyCapForItemType } from "../../../src/index/body-caps.ts";

const NOW = 1_700_009_999_999;
const MODIFIED_ISO = "2024-03-02T08:00:00Z";
const ADDED_ISO = "2024-03-01T12:00:00Z";

function makeNote(dataOver: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) {
  return {
    key: "NOTE1234",
    version: 7,
    data: {
      key: "NOTE1234",
      itemType: "note",
      note: '<div data-schema-version="9"><p>Backoff needs jitter</p><p>See section 3.</p></div>',
      parentItem: "REF00001",
      tags: [{ tag: "retries" }],
      collections: ["COLL01"],
      dateModified: MODIFIED_ISO,
      dateAdded: ADDED_ISO,
      ...dataOver,
    },
    ...rootOver,
  };
}

function mapped(raw: unknown) {
  const row = mapZoteroNoteToItem(raw, { syncedAt: NOW });
  if (row === null) throw new Error("expected mapping to succeed");
  return row;
}

describe("mapZoteroNoteToItem", () => {
  test("child note: parent key kept in metadata, body is plain text, title is the first line", () => {
    const row = mapped(makeNote());
    expect(row.service).toBe("zotero");
    expect(row.type).toBe("note");
    expect(row.externalId).toBe("NOTE1234");
    expect(row.title).toBe("Backoff needs jitter");
    expect(row.body).toBe("Backoff needs jitter See section 3.");
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
    expect(row.modifiedAt).toBe(Date.parse(MODIFIED_ISO));
    expect(row.syncedAt).toBe(NOW);
    expect(row.metadata["parent_key"]).toBe("REF00001");
    expect(row.metadata["tags"]).toEqual(["retries"]);
    expect(row.metadata["collections"]).toEqual(["COLL01"]);
    expect(row.metadata["item_type"]).toBe("note");
  });

  test("standalone note stores parent_key as null", () => {
    const standalone = makeNote();
    delete (standalone.data as Record<string, unknown>)["parentItem"];
    expect(mapped(standalone).metadata["parent_key"]).toBeNull();
    expect(mapped(makeNote({ parentItem: "" })).metadata["parent_key"]).toBeNull();
  });

  test("HTML body: derived title has no markup and entities are decoded", () => {
    const row = mapped(
      makeNote({
        note: "<div><h1><b>Tom &amp; Jerry</b>&nbsp;&lt;draft&gt;</h1><p>body</p></div>",
      }),
    );
    expect(row.title).toBe("Tom & Jerry <draft>");
    expect(row.title).not.toMatch(/<(?:div|h1|b)>/u);
    expect(row.body).toBe("Tom & Jerry <draft> body");
  });

  test("a long first line is truncated; an empty note falls back to the key", () => {
    expect(mapped(makeNote({ note: `<p>${"x".repeat(300)}</p>` })).title).toBe(
      `${"x".repeat(120)}…`,
    );
    const empty = mapped(makeNote({ note: "<div> <p></p> </div>" }));
    expect(empty.title).toBe("Note NOTE1234");
    expect(empty.body).toBe("");
  });

  test("returns null for a missing or empty key", () => {
    const noKey = makeNote();
    delete (noKey as Record<string, unknown>)["key"];
    expect(mapZoteroNoteToItem(noKey, { syncedAt: NOW })).toBeNull();
    expect(mapZoteroNoteToItem(makeNote({}, { key: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("returns null for non-notes, non-objects and rows without data", () => {
    expect(
      mapZoteroNoteToItem(makeNote({ itemType: "journalArticle" }), { syncedAt: NOW }),
    ).toBeNull();
    expect(mapZoteroNoteToItem(makeNote({ itemType: "attachment" }), { syncedAt: NOW })).toBeNull();
    expect(mapZoteroNoteToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapZoteroNoteToItem(makeNote({}, { data: "x" }), { syncedAt: NOW })).toBeNull();
  });

  test("modifiedAt falls back to dateAdded, then syncedAt", () => {
    expect(mapped(makeNote({ dateModified: undefined })).modifiedAt).toBe(Date.parse(ADDED_ISO));
    expect(mapped(makeNote({ dateModified: undefined, dateAdded: undefined })).modifiedAt).toBe(
      NOW,
    );
  });
});

describe("note text helpers", () => {
  test("noteTitle returns null when there is no text", () => {
    expect(noteTitle("")).toBeNull();
    expect(noteTitle("<div><br/></div>")).toBeNull();
  });

  test("noteBodyText leaves a literal escaped tag as text, not markup", () => {
    expect(noteBodyText("<p>use &lt;div&gt; here</p>")).toBe("use <div> here");
  });
});

describe("zotero:note privacy and storage routing", () => {
  test("gets the long body cap but is never prose-heavy (stays off the remote embedder)", () => {
    expect(bodyCapForItemType("zotero", "note")).toBe(16_384);
    expect(isProseHeavy("zotero", "note")).toBe(false);
  });
});
