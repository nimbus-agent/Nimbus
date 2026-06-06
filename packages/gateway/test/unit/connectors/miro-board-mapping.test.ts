import { describe, expect, test } from "bun:test";

import { mapMiroBoardToItem } from "../../../src/connectors/miro-board-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;

function board(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { owner: ownerOver, ...rootOver } = over;
  return {
    id: "3458764500000000000",
    name: "Q2 Roadmap",
    description: "Planning board for the next quarter",
    createdAt: "2026-01-02T00:00:00Z",
    modifiedAt: "2026-05-20T12:00:00Z",
    viewLink: "https://miro.com/app/board/3458764500000000000=/",
    ...rootOver,
    owner: {
      name: "Ada Lovelace",
      ...ownerOver,
    },
  };
}

describe("mapMiroBoardToItem", () => {
  test("maps a well-formed board to a miro:board item", () => {
    const row = mapMiroBoardToItem(board(), { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.service).toBe("miro");
    expect(row.type).toBe("board");
    expect(row.externalId).toBe("3458764500000000000");
    expect(row.title).toBe("Q2 Roadmap");
    expect(row.url).toBe("https://miro.com/app/board/3458764500000000000=/");
    expect(row.canonicalUrl).toBe("https://miro.com/app/board/3458764500000000000=/");
    expect(row.syncedAt).toBe(SYNCED_AT);
    expect(row.metadata["name"]).toBe("Q2 Roadmap");
    expect(row.metadata["description"]).toBe("Planning board for the next quarter");
    expect(row.metadata["owner_name"]).toBe("Ada Lovelace");
    // modifiedAt parses ISO → epoch-ms
    expect(row.metadata["modifiedAt"]).toBe(Date.parse("2026-05-20T12:00:00Z"));
    expect(row.metadata["createdAt"]).toBe(Date.parse("2026-01-02T00:00:00Z"));
    expect(row.modifiedAt).toBe(Date.parse("2026-05-20T12:00:00Z"));
  });

  test("falls back to createdAt then syncedAt for modifiedAt", () => {
    const noModified = board();
    delete noModified["modifiedAt"];
    const row = mapMiroBoardToItem(noModified, { syncedAt: SYNCED_AT });
    expect(row?.modifiedAt).toBe(Date.parse("2026-01-02T00:00:00Z"));

    const noDates = board();
    delete noDates["modifiedAt"];
    delete noDates["createdAt"];
    const row2 = mapMiroBoardToItem(noDates, { syncedAt: SYNCED_AT });
    expect(row2?.modifiedAt).toBe(SYNCED_AT);
  });

  test("synthesizes a title when name is missing", () => {
    const noName = board();
    delete noName["name"];
    const row = mapMiroBoardToItem(noName, { syncedAt: SYNCED_AT });
    expect(row?.title).toBe("Miro board 3458764500000000000");
    expect(row?.metadata["name"]).toBeNull();
  });

  test("url + canonicalUrl are null when viewLink is absent", () => {
    const noLink = board();
    delete noLink["viewLink"];
    const row = mapMiroBoardToItem(noLink, { syncedAt: SYNCED_AT });
    expect(row?.url).toBeNull();
    expect(row?.canonicalUrl).toBeNull();
    expect(row?.metadata["viewLink"]).toBeNull();
  });

  test("returns null for a non-object input", () => {
    expect(mapMiroBoardToItem(null, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapMiroBoardToItem(42, { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapMiroBoardToItem([], { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    expect(mapMiroBoardToItem(board({ id: undefined }), { syncedAt: SYNCED_AT })).toBeNull();
    expect(mapMiroBoardToItem(board({ id: "" }), { syncedAt: SYNCED_AT })).toBeNull();
  });

  test("tolerates a missing owner object", () => {
    const noOwner = board();
    delete noOwner["owner"];
    const row = mapMiroBoardToItem(noOwner, { syncedAt: SYNCED_AT });
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Q2 Roadmap");
    expect(row?.metadata["owner_name"]).toBeNull();
  });
});
