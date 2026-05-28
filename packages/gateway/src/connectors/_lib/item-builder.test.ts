import { describe, expect, test } from "bun:test";
import { buildIndexedItem } from "./item-builder.ts";

describe("buildIndexedItem", () => {
  test("composes <service>:<external_id> id format", () => {
    const item = buildIndexedItem({
      service: "github",
      type: "pr",
      externalId: "12345",
      title: "Add foo",
      modifiedAt: 1700000000000,
      syncedAt: 1700000000001,
      metadata: { state: "open" },
    });
    expect(item.id).toBe("github:12345");
    expect(item.service).toBe("github");
    expect(item.type).toBe("pr");
    expect(item.title).toBe("Add foo");
    expect(item.metadata).toEqual({ state: "open" });
  });

  test("does not double-prefix if externalId already has service prefix", () => {
    const item = buildIndexedItem({
      service: "github",
      type: "pr",
      externalId: "github:99",
      title: "x",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(item.id).toBe("github:99");
  });

  test("preserves optional url, canonicalUrl, authorId, bodyPreview, pinned", () => {
    const item = buildIndexedItem({
      service: "linear",
      type: "issue",
      externalId: "NIM-1",
      title: "x",
      bodyPreview: "preview text",
      url: "https://linear.app/x",
      canonicalUrl: "https://linear.app/issue/NIM-1",
      authorId: "person:1",
      modifiedAt: 2,
      syncedAt: 3,
      pinned: true,
    });
    expect(item.bodyPreview).toBe("preview text");
    expect(item.url).toBe("https://linear.app/x");
    expect(item.canonicalUrl).toBe("https://linear.app/issue/NIM-1");
    expect(item.authorId).toBe("person:1");
    expect(item.pinned).toBe(true);
  });

  test("rejects empty externalId", () => {
    expect(() =>
      buildIndexedItem({
        service: "github",
        type: "pr",
        externalId: "",
        title: "x",
        modifiedAt: 1,
        syncedAt: 1,
      }),
    ).toThrow(/externalId/);
  });

  test("defaults metadata to empty object", () => {
    const item = buildIndexedItem({
      service: "github",
      type: "pr",
      externalId: "1",
      title: "x",
      modifiedAt: 1,
      syncedAt: 1,
    });
    expect(item.metadata).toEqual({});
  });
});
