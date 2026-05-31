import { describe, expect, test } from "bun:test";

import { mapMlflowModelToItem, modelUrl } from "../../../src/connectors/mlflow-model-mapping.ts";

const NOW = 1_700_009_999_999;
const HOST = "https://mlflow.acme.com";

const CREATED_MS = 1_613_001_791_000;
const UPDATED_MS = 1_699_900_000_000;

interface VersionOver {
  version?: string;
  current_stage?: string;
  status?: string;
  run_id?: string;
}

function version(over: VersionOver = {}): Record<string, unknown> {
  return {
    name: "fraud-detector",
    version: over.version ?? "3",
    current_stage: over.current_stage ?? "Staging",
    status: over.status ?? "READY",
    run_id: over.run_id ?? "run-abc",
    creation_timestamp: CREATED_MS,
    last_updated_timestamp: UPDATED_MS,
    source: "s3://bucket/path",
  };
}

function makeModel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "fraud-detector",
    creation_timestamp: CREATED_MS,
    last_updated_timestamp: UPDATED_MS,
    description: "Detects fraudulent transactions",
    latest_versions: [version()],
    tags: [
      { key: "team", value: "ml-platform" },
      { key: "tier", value: "1" },
    ],
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapMlflowModelToItem>[1]> = {}) {
  return {
    host: HOST,
    syncedAt: NOW,
    ...over,
  };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapMlflowModelToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapMlflowModelToItem(null, ctx())).toBeNull();
    expect(mapMlflowModelToItem("nope", ctx())).toBeNull();
    expect(mapMlflowModelToItem([1, 2], ctx())).toBeNull();
  });

  test("returns null when name is missing or not a string", () => {
    const noName = makeModel();
    delete (noName as Record<string, unknown>)["name"];
    expect(mapMlflowModelToItem(noName, ctx())).toBeNull();
    expect(mapMlflowModelToItem(makeModel({ name: 555 }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is model_<name>", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("mlflow");
    expect(row.type).toBe("ml_model");
    expect(row.externalId).toBe("model_fraud-detector");
  });

  test("title is the model name; metadata.name matches", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("fraud-detector");
    expect(meta(row)["name"]).toBe("fraud-detector");
  });

  test("description flows through to metadata + bodyPreview; missing → null + empty preview", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["description"]).toBe("Detects fraudulent transactions");
    expect(row.bodyPreview).toBe("Detects fraudulent transactions");

    const noDesc = makeModel();
    delete (noDesc as Record<string, unknown>)["description"];
    const row2 = mapMlflowModelToItem(noDesc, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["description"]).toBeNull();
    expect(row2.bodyPreview).toBe("");
  });

  test("timestamps pass through as epoch ms (no Date.parse); null when absent", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);

    const noTs = makeModel();
    delete (noTs as Record<string, unknown>)["creation_timestamp"];
    delete (noTs as Record<string, unknown>)["last_updated_timestamp"];
    const row2 = mapMlflowModelToItem(noTs, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["created_at"]).toBeNull();
    expect(meta(row2)["updated_at"]).toBeNull();
  });

  test("version_count counts latest_versions; latest fields from the single entry", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["version_count"]).toBe(1);
    expect(m["latest_version"]).toBe("3");
    expect(m["latest_stage"]).toBe("Staging");
    expect(m["latest_status"]).toBe("READY");
    expect(m["latest_run_id"]).toBe("run-abc");
  });

  test("Production-stage entry wins over a higher numeric version", () => {
    const model = makeModel({
      latest_versions: [
        version({ version: "7", current_stage: "Staging", run_id: "run-7" }),
        version({ version: "4", current_stage: "Production", run_id: "run-4" }),
      ],
    });
    const row = mapMlflowModelToItem(model, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["version_count"]).toBe(2);
    expect(m["latest_stage"]).toBe("Production");
    expect(m["latest_version"]).toBe("4");
    expect(m["latest_run_id"]).toBe("run-4");
  });

  test("with no Production entry, the highest numeric version wins", () => {
    const model = makeModel({
      latest_versions: [
        version({ version: "2", current_stage: "Staging", run_id: "run-2" }),
        version({ version: "10", current_stage: "Archived", run_id: "run-10" }),
        version({ version: "5", current_stage: "None", run_id: "run-5" }),
      ],
    });
    const row = mapMlflowModelToItem(model, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["latest_version"]).toBe("10");
    expect(m["latest_stage"]).toBe("Archived");
  });

  test("missing latest_versions: count 0, all latest_* null, summary says 'no versions'", () => {
    const noVersions = makeModel();
    delete (noVersions as Record<string, unknown>)["latest_versions"];
    const row = mapMlflowModelToItem(noVersions, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["version_count"]).toBe(0);
    expect(m["latest_version"]).toBeNull();
    expect(m["latest_stage"]).toBeNull();
    expect(m["latest_status"]).toBeNull();
    expect(m["latest_run_id"]).toBeNull();
    expect(m["summary"]).toBe("fraud-detector — no versions");
  });

  test("empty latest_versions array: count 0, latest fields null", () => {
    const row = mapMlflowModelToItem(makeModel({ latest_versions: [] }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["version_count"]).toBe(0);
    expect(meta(row)["latest_version"]).toBeNull();
  });

  test("tags flatten to a key=value string[]; missing tags → empty array", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["team=ml-platform", "tier=1"]);

    const noTags = makeModel();
    delete (noTags as Record<string, unknown>)["tags"];
    const row2 = mapMlflowModelToItem(noTags, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(meta(row2)["tags"]).toEqual([]);
  });

  test("tag entries with a missing value flatten to key=; non-object/keyless tags are skipped", () => {
    const model = makeModel({
      tags: [{ key: "env" }, { value: "orphan" }, null, 42, { key: "owner", value: "alice" }],
    });
    const row = mapMlflowModelToItem(model, ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["env=", "owner=alice"]);
  });

  test("modifiedAt prefers updated_at, then created_at, then syncedAt", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const onlyCreated = makeModel();
    delete (onlyCreated as Record<string, unknown>)["last_updated_timestamp"];
    const row2 = mapMlflowModelToItem(onlyCreated, ctx());
    if (row2 === null) throw new Error("expected mapping to succeed");
    expect(row2.modifiedAt).toBe(CREATED_MS);

    const neither = makeModel();
    delete (neither as Record<string, unknown>)["creation_timestamp"];
    delete (neither as Record<string, unknown>)["last_updated_timestamp"];
    const row3 = mapMlflowModelToItem(neither, ctx());
    if (row3 === null) throw new Error("expected mapping to succeed");
    expect(row3.modifiedAt).toBe(NOW);
  });

  test("canonical url points at the model UI fragment route; url === canonicalUrl", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://mlflow.acme.com/#/models/fraud-detector");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("model names with special characters are URL-encoded in the canonical URL", () => {
    const row = mapMlflowModelToItem(makeModel({ name: "team a/model #1" }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe("model_team a/model #1");
    expect(row.canonicalUrl).toBe("https://mlflow.acme.com/#/models/team%20a%2Fmodel%20%231");
  });

  test("syncedAt propagates", () => {
    const row = mapMlflowModelToItem(makeModel(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("modelUrl", () => {
  test("builds the model UI fragment deep link", () => {
    expect(modelUrl("https://mlflow.acme.com", "fraud-detector")).toBe(
      "https://mlflow.acme.com/#/models/fraud-detector",
    );
  });

  test("trims a trailing slash on the host", () => {
    expect(modelUrl("https://mlflow.acme.com/", "ranker")).toBe(
      "https://mlflow.acme.com/#/models/ranker",
    );
  });

  test("URL-encodes names with spaces and slashes", () => {
    expect(modelUrl("https://mlflow.acme.com", "my model/v2")).toBe(
      "https://mlflow.acme.com/#/models/my%20model%2Fv2",
    );
  });
});
