import { describe, expect, test } from "bun:test";

import {
  extractSchemaFields,
  mapBigqueryTableToItem,
} from "../../../src/connectors/bigquery-table-mapping.ts";

const CTX = { project: "my-project", syncedAt: 1_700_000_000_000 };

describe("mapBigqueryTableToItem", () => {
  test("maps a full tables.get detail object (schema + counts, NO row data)", () => {
    const row = mapBigqueryTableToItem(
      {
        tableReference: { datasetId: "analytics", tableId: "events" },
        type: "TABLE",
        creationTime: "1690000000000",
        lastModifiedTime: "1699000000000",
        numRows: "12345",
        numBytes: "987654",
        schema: {
          fields: [
            { name: "event_id", type: "STRING" },
            { name: "ts", type: "TIMESTAMP" },
          ],
        },
      },
      CTX,
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("bigquery");
    expect(row?.type).toBe("table");
    expect(row?.externalId).toBe("my-project:analytics.events");
    expect(row?.title).toBe("analytics.events");
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.modifiedAt).toBe(1699000000000);
    const meta = row?.metadata as Record<string, unknown>;
    expect(meta.project).toBe("my-project");
    expect(meta.datasetId).toBe("analytics");
    expect(meta.tableId).toBe("events");
    expect(meta.tableType).toBe("TABLE");
    expect(meta.numRows).toBe(12345);
    expect(meta.numBytes).toBe(987654);
    expect(meta.schemaFields).toEqual([
      { name: "event_id", type: "STRING" },
      { name: "ts", type: "TIMESTAMP" },
    ]);
  });

  test("maps a sparse tables.list entry (no schema) using list metadata", () => {
    const row = mapBigqueryTableToItem(
      {
        tableReference: { datasetId: "raw", tableId: "logs" },
        type: "VIEW",
        creationTime: "1680000000000",
      },
      CTX,
    );
    expect(row?.metadata).toMatchObject({ tableType: "VIEW", schemaFields: [] });
    // lastModifiedTime absent → falls back to creationTime.
    expect(row?.modifiedAt).toBe(1680000000000);
  });

  test("returns null when tableId is missing", () => {
    expect(mapBigqueryTableToItem({ tableReference: { datasetId: "d" } }, CTX)).toBeNull();
  });

  test("returns null when tableReference is missing", () => {
    expect(mapBigqueryTableToItem({ type: "TABLE" }, CTX)).toBeNull();
  });

  test("returns null for non-record input", () => {
    expect(mapBigqueryTableToItem(null, CTX)).toBeNull();
    expect(mapBigqueryTableToItem([1, 2, 3], CTX)).toBeNull();
  });

  test("modifiedAt falls back to syncedAt when no timestamps present", () => {
    const row = mapBigqueryTableToItem({ tableReference: { datasetId: "d", tableId: "t" } }, CTX);
    expect(row?.modifiedAt).toBe(CTX.syncedAt);
  });

  test("friendlyName is surfaced in the title", () => {
    const row = mapBigqueryTableToItem(
      {
        tableReference: { datasetId: "d", tableId: "t" },
        friendlyName: "Daily Rollup",
      },
      CTX,
    );
    expect(row?.title).toBe("Daily Rollup (d.t)");
  });

  test("unknown table type is preserved verbatim", () => {
    const row = mapBigqueryTableToItem(
      { tableReference: { datasetId: "d", tableId: "t" }, type: "weird_thing" },
      CTX,
    );
    expect((row?.metadata as Record<string, unknown> | undefined)?.tableType).toBe("weird_thing");
  });
});

describe("extractSchemaFields", () => {
  test("flattens nested RECORD fields with dotted paths", () => {
    const fields = extractSchemaFields({
      fields: [
        { name: "id", type: "STRING" },
        {
          name: "user",
          type: "RECORD",
          fields: [
            { name: "name", type: "STRING" },
            { name: "age", type: "INTEGER" },
          ],
        },
      ],
    });
    expect(fields).toEqual([
      { name: "id", type: "STRING" },
      { name: "user", type: "RECORD" },
      { name: "user.name", type: "STRING" },
      { name: "user.age", type: "INTEGER" },
    ]);
  });

  test("returns [] for non-record / missing fields", () => {
    expect(extractSchemaFields(null)).toEqual([]);
    expect(extractSchemaFields({})).toEqual([]);
    expect(extractSchemaFields({ fields: "nope" })).toEqual([]);
  });

  test("skips fields without a name", () => {
    expect(
      extractSchemaFields({ fields: [{ type: "STRING" }, { name: "ok", type: "INT64" }] }),
    ).toEqual([{ name: "ok", type: "INT64" }]);
  });
});

describe("mapBigqueryTableToItem — value shapes and clamping", () => {
  const REF = { tableReference: { datasetId: "ds", tableId: "t" } };

  function mapped(over: Record<string, unknown>) {
    const row = mapBigqueryTableToItem({ ...REF, ...over }, CTX);
    if (row === null) throw new Error("expected mapping to succeed");
    return row;
  }

  test("counts and timestamps may arrive as numbers; a non-numeric string reads as absent", () => {
    const row = mapped({ numRows: 42, numBytes: "lots", lastModifiedTime: 1_699_000_000_001 });
    expect(row.metadata["numRows"]).toBe(42);
    expect(row.metadata["numBytes"]).toBeNull();
    expect(row.modifiedAt).toBe(1_699_000_000_001);
  });

  test("a non-record schema field is skipped and a field with no type gets an empty one", () => {
    const fields = extractSchemaFields({
      fields: ["not a field", null, 7, { name: "a", type: "STRING" }, { name: "b" }],
    });
    expect(fields).toEqual([
      { name: "a", type: "STRING" },
      { name: "b", type: "" },
    ]);
  });

  test("a title over 256 characters is clamped with an ellipsis", () => {
    const row = mapped({ friendlyName: "x".repeat(300) });
    expect(row.title).toBe(`${"x".repeat(256)}…`);
  });

  test("a description over 512 characters is clamped with an ellipsis in the preview only", () => {
    const description = "d".repeat(600);
    const row = mapped({ description });
    expect(row.bodyPreview).toBe(`${"d".repeat(512)}…`);
    expect(row.metadata["description"]).toBe(description);
  });

  test("an empty description falls back to the field summary, then the qualified name", () => {
    const withSchema = mapped({
      description: "",
      schema: { fields: [{ name: "id", type: "INT64" }] },
    });
    expect(withSchema.bodyPreview).toBe("id:INT64");
    expect(mapped({ description: "" }).bodyPreview).toBe("ds.t");
  });
});
