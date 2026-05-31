import { describe, expect, test } from "bun:test";

import { mapFigmaFileToItem } from "../../../src/connectors/figma-file-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function file(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "abc123XYZ",
    name: "Q2 Roadmap",
    thumbnail_url: "https://s3-alpha.figma.com/thumb/abc123XYZ",
    last_modified: "2026-05-20T12:00:00Z",
    ...over,
  };
}

describe("mapFigmaFileToItem", () => {
  test("maps a well-formed file to a figma:file item", () => {
    const row = mapFigmaFileToItem(file(), { syncedAt: SYNCED_AT, projectName: "Design System" });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("figma");
    expect(row.type).toBe("file");
    expect(row.externalId).toBe("abc123XYZ");
    expect(row.title).toBe("Q2 Roadmap");
    // canonical url is constructed from the key
    expect(row.url).toBe("https://www.figma.com/file/abc123XYZ");
    expect(row.canonicalUrl).toBe("https://www.figma.com/file/abc123XYZ");
    expect(row.syncedAt).toBe(SYNCED_AT);
    expect(row.metadata["key"]).toBe("abc123XYZ");
    expect(row.metadata["name"]).toBe("Q2 Roadmap");
    expect(row.metadata["project_name"]).toBe("Design System");
    expect(row.metadata["thumbnail_url"]).toBe("https://s3-alpha.figma.com/thumb/abc123XYZ");
    // last_modified parses ISO → epoch-ms
    expect(row.metadata["last_modified"]).toBe(Date.parse("2026-05-20T12:00:00Z"));
    expect(row.modifiedAt).toBe(Date.parse("2026-05-20T12:00:00Z"));
    // bodyPreview folds in the project name
    expect(row.bodyPreview).toBe("Q2 Roadmap — Design System");
  });

  test("falls back to syncedAt for modifiedAt when last_modified is absent", () => {
    const noModified = file();
    delete noModified["last_modified"];
    const row = mapFigmaFileToItem(noModified, { syncedAt: SYNCED_AT, projectName: null });
    expect(row?.modifiedAt).toBe(SYNCED_AT);
    expect(row?.metadata["last_modified"]).toBeNull();
  });

  test("synthesizes a title when name is missing", () => {
    const noName = file();
    delete noName["name"];
    const row = mapFigmaFileToItem(noName, { syncedAt: SYNCED_AT, projectName: null });
    expect(row?.title).toBe("Figma file abc123XYZ");
    expect(row?.metadata["name"]).toBeNull();
  });

  test("bodyPreview is just the title when project name is null/empty", () => {
    const rowNull = mapFigmaFileToItem(file(), { syncedAt: SYNCED_AT, projectName: null });
    expect(rowNull?.bodyPreview).toBe("Q2 Roadmap");
  });

  test("returns null for a non-object input", () => {
    expect(mapFigmaFileToItem(null, { syncedAt: SYNCED_AT, projectName: null })).toBeNull();
    expect(mapFigmaFileToItem(42, { syncedAt: SYNCED_AT, projectName: null })).toBeNull();
    expect(mapFigmaFileToItem([], { syncedAt: SYNCED_AT, projectName: null })).toBeNull();
  });

  test("returns null when key is missing or empty", () => {
    expect(
      mapFigmaFileToItem(file({ key: undefined }), { syncedAt: SYNCED_AT, projectName: null }),
    ).toBeNull();
    expect(
      mapFigmaFileToItem(file({ key: "" }), { syncedAt: SYNCED_AT, projectName: null }),
    ).toBeNull();
  });

  test("tolerates missing thumbnail_url", () => {
    const noThumb = file();
    delete noThumb["thumbnail_url"];
    const row = mapFigmaFileToItem(noThumb, { syncedAt: SYNCED_AT, projectName: "P" });
    expect(row).not.toBeNull();
    expect(row?.metadata["thumbnail_url"]).toBeNull();
  });
});
