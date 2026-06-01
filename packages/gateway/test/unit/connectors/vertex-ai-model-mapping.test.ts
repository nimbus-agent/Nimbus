import { describe, expect, test } from "bun:test";

import { mapVertexAiModelToItem } from "../../../src/connectors/vertex-ai-model-mapping.ts";

const SYNCED_AT = 1_700_000_900_000;
const PROJECT = "my-project";
const REGION = "us-central1";

describe("mapVertexAiModelToItem", () => {
  test("maps a full model to metadata-only item", () => {
    const item = mapVertexAiModelToItem(
      {
        name: "projects/my-project/locations/us-central1/models/123456789",
        displayName: "fraud-detector",
        versionId: "1",
        createTime: "2024-01-01T00:00:00Z",
        updateTime: "2024-06-15T12:00:00Z",
      },
      { project: PROJECT, region: REGION, syncedAt: SYNCED_AT },
    );
    expect(item).not.toBeNull();
    if (item === null) {
      return;
    }
    expect(item.service).toBe("vertex_ai");
    expect(item.type).toBe("model");
    expect(item.externalId).toBe("projects/my-project/locations/us-central1/models/123456789");
    expect(item.title).toBe("fraud-detector");
    // updateTime wins for modifiedAt.
    expect(item.modifiedAt).toBe(Date.parse("2024-06-15T12:00:00Z"));
    expect(item.url).toBeNull();
    expect(item.canonicalUrl).toBeNull();
    expect(item.metadata).toMatchObject({
      project: PROJECT,
      region: REGION,
      modelName: "projects/my-project/locations/us-central1/models/123456789",
      displayName: "fraud-detector",
      versionId: "1",
    });
    // No inference / prediction / output data of any kind.
    const meta = JSON.stringify(item.metadata);
    expect(meta).not.toContain("prediction");
    expect(meta).not.toContain("instances");
  });

  test("title falls back to the id segment of the resource name when no displayName", () => {
    const item = mapVertexAiModelToItem(
      { name: "projects/p/locations/us-central1/models/987" },
      { project: PROJECT, region: REGION, syncedAt: SYNCED_AT },
    );
    expect(item?.title).toBe("987");
    expect(item?.externalId).toBe("projects/p/locations/us-central1/models/987");
  });

  test("external_id falls back to <region>/<displayName> when resource name is absent", () => {
    const item = mapVertexAiModelToItem(
      { displayName: "no-name-model" },
      { project: PROJECT, region: REGION, syncedAt: SYNCED_AT },
    );
    expect(item?.externalId).toBe("us-central1/no-name-model");
    expect(item?.title).toBe("no-name-model");
  });

  test("modifiedAt falls back to createTime, then syncedAt", () => {
    const withCreate = mapVertexAiModelToItem(
      { displayName: "m", createTime: "2023-11-03T00:00:00Z" },
      { project: PROJECT, region: REGION, syncedAt: SYNCED_AT },
    );
    expect(withCreate?.modifiedAt).toBe(Date.parse("2023-11-03T00:00:00Z"));

    const bare = mapVertexAiModelToItem(
      { displayName: "m" },
      { project: PROJECT, region: REGION, syncedAt: SYNCED_AT },
    );
    expect(bare?.modifiedAt).toBe(SYNCED_AT);
  });

  test("region is always recorded in metadata + bodyPreview", () => {
    const item = mapVertexAiModelToItem(
      { name: "projects/p/locations/europe-west4/models/1", displayName: "m" },
      { project: PROJECT, region: "europe-west4", syncedAt: SYNCED_AT },
    );
    expect(item?.metadata).toMatchObject({ region: "europe-west4" });
    expect(item?.bodyPreview).toContain("region:europe-west4");
  });

  test("returns null when both resource name and display name are missing", () => {
    expect(
      mapVertexAiModelToItem(
        { versionId: "1" },
        { project: PROJECT, region: REGION, syncedAt: SYNCED_AT },
      ),
    ).toBeNull();
    expect(
      mapVertexAiModelToItem(null, { project: PROJECT, region: REGION, syncedAt: SYNCED_AT }),
    ).toBeNull();
  });
});
