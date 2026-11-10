import { describe, expect, test } from "bun:test";

import { mapVertexAiModelToItem, parseIsoMs } from "./vertex-ai-model-mapping.ts";

const ctx = { project: "proj", region: "us-central1", syncedAt: 1_000 };
const NAME = "projects/p/locations/us-central1/models/123";

describe("parseIsoMs", () => {
  test("parses a trimmed RFC 3339 string, rejects anything else", () => {
    expect(parseIsoMs(" 2026-01-02T03:04:05Z ")).toBe(Date.parse("2026-01-02T03:04:05Z"));
    expect(parseIsoMs("   ")).toBeNull();
    expect(parseIsoMs("not a date")).toBeNull();
    expect(parseIsoMs(12)).toBeNull();
  });
});

describe("mapVertexAiModelToItem", () => {
  test("maps a registry entry: metadata only, the latest of update and create time", () => {
    const row = mapVertexAiModelToItem(
      {
        name: NAME,
        displayName: "Churn model",
        versionId: "4",
        createTime: "2026-01-01T00:00:00Z",
        updateTime: "2026-02-01T00:00:00Z",
      },
      ctx,
    );
    expect(row?.externalId).toBe(NAME);
    expect(row?.title).toBe("Churn model");
    expect(row?.bodyPreview).toBe(`region:us-central1, version:4, ${NAME}`);
    expect(row?.modifiedAt).toBe(Date.parse("2026-02-01T00:00:00Z"));
    expect(row?.metadata).toMatchObject({
      project: "proj",
      modelName: NAME,
      displayName: "Churn model",
      versionId: "4",
    });
  });

  test("without a display name the title is the id segment of the resource name", () => {
    const row = mapVertexAiModelToItem({ name: NAME, createTime: "2026-01-01T00:00:00Z" }, ctx);
    expect(row?.title).toBe("123");
    expect(row?.modifiedAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(row?.metadata).not.toHaveProperty("displayName");
    expect(row?.metadata).not.toHaveProperty("versionId");
  });

  test("a name without a slash is its own id segment", () => {
    expect(mapVertexAiModelToItem({ name: "plain" }, ctx)?.title).toBe("plain");
  });

  test("without a resource name the external id is region/displayName", () => {
    const row = mapVertexAiModelToItem({ displayName: "Solo", versionId: "" }, ctx);
    expect(row?.externalId).toBe("us-central1/Solo");
    expect(row?.bodyPreview).toBe("region:us-central1");
    expect(row?.modifiedAt).toBe(1_000);
    expect(row?.metadata).not.toHaveProperty("modelName");
  });

  test("a long title is clamped with an ellipsis", () => {
    const row = mapVertexAiModelToItem({ name: NAME, displayName: "x".repeat(300) }, ctx);
    expect(row?.title).toBe(`${"x".repeat(256)}…`);
  });

  test("nothing to key on, or not an object, is rejected", () => {
    expect(mapVertexAiModelToItem({}, ctx)).toBeNull();
    expect(mapVertexAiModelToItem(null, ctx)).toBeNull();
  });
});
