import { describe, expect, test } from "bun:test";
import { mapMendeleyDocumentToItem } from "./mendeley-reference-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "9f8e-1234",
    title: "Exponential backoff with jitter",
    type: "journal",
    year: 2024,
    source: "Journal of Reliability Engineering",
    abstract: "Full-jitter retry strategies for distributed queues.",
    identifiers: { doi: "10.1145/1234567.8901234" },
    authors: [
      { first_name: "Ada", last_name: "Lovelace" },
      { first_name: "Grace", last_name: "Hopper" },
    ],
    keywords: ["reliability", "retries"],
    websites: ["https://example.org/paper"],
    last_modified: "2024-03-02T08:00:00.000Z",
    created: "2024-03-01T12:00:00.000Z",
    ...over,
  };
}

describe("mapMendeleyDocumentToItem", () => {
  test("maps a full document to a reference row", () => {
    const row = mapMendeleyDocumentToItem(doc(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("mendeley");
    expect(row.type).toBe("reference");
    expect(row.externalId).toBe("9f8e-1234");
    expect(row.title).toBe("Exponential backoff with jitter");
    expect(row.canonicalUrl).toBe("https://example.org/paper");
    expect(row.modifiedAt).toBe(Date.parse("2024-03-02T08:00:00.000Z"));
    expect(row.metadata["doi"]).toBe("10.1145/1234567.8901234");
    expect(row.metadata["creators"]).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(row.metadata["source"]).toBe("Journal of Reliability Engineering");
  });

  test("returns null when id is missing", () => {
    expect(mapMendeleyDocumentToItem(doc({ id: undefined }), { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapMendeleyDocumentToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapMendeleyDocumentToItem(42, { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("falls back to syncedAt when no timestamps, and derives a title when absent", () => {
    const row = mapMendeleyDocumentToItem(
      {
        id: "x1",
        last_modified: undefined,
        created: undefined,
        title: undefined,
        type: "book",
      },
      { syncedAt: SYNCED_AT },
    );
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.modifiedAt).toBe(SYNCED_AT);
    expect(row.title).toBe("book x1");
  });

  test("truncates an over-long abstract and over-long title", () => {
    const longAbstract = "a".repeat(900);
    const longTitle = "t".repeat(200);
    const row = mapMendeleyDocumentToItem(doc({ abstract: longAbstract, title: longTitle }), {
      syncedAt: SYNCED_AT,
    });
    if (row === null) throw new Error("expected row");
    expect((row.metadata["abstract"] as string).endsWith("…")).toBe(true);
    expect((row.metadata["abstract"] as string).length).toBe(501);
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.title.length).toBe(121);
  });

  test("tolerates non-object authors and a non-array keywords field", () => {
    const row = mapMendeleyDocumentToItem(
      doc({ authors: [null, 7, { last_name: "Knuth" }], keywords: "not-an-array" }),
      { syncedAt: SYNCED_AT },
    );
    if (row === null) throw new Error("expected row");
    expect(row.metadata["creators"]).toEqual(["Knuth"]);
    expect(row.metadata["keywords"]).toEqual([]);
  });
});
