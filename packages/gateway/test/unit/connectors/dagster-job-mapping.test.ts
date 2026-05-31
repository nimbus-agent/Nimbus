import { describe, expect, test } from "bun:test";

import {
  type DagsterFlatJob,
  mapDagsterJobToItem,
} from "../../../src/connectors/dagster-job-mapping.ts";

const NOW = 1_700_009_999_999;
const BASE_URL = "https://my-org.dagster.cloud/prod";

function makeJob(
  over: Partial<DagsterFlatJob> = {},
  rawOver: Record<string, unknown> = {},
): DagsterFlatJob {
  return {
    name: "nightly_etl",
    repository: "analytics",
    location: "analytics_code",
    raw: {
      id: "opaque-base64-id",
      name: "nightly_etl",
      description: "Nightly extract-transform-load job",
      isJob: true,
      tags: [
        { key: "team", value: "data" },
        { key: "tier", value: "1" },
      ],
      ...rawOver,
    },
    ...over,
  };
}

function ctx(over: Partial<Parameters<typeof mapDagsterJobToItem>[1]> = {}) {
  return { baseUrl: BASE_URL, syncedAt: NOW, ...over };
}

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapDagsterJobToItem", () => {
  test("returns null when the job name is empty", () => {
    expect(mapDagsterJobToItem(makeJob({ name: "" }), ctx())).toBeNull();
    expect(mapDagsterJobToItem(makeJob({ name: "   " }), ctx())).toBeNull();
  });

  test("returns null when the repository is empty", () => {
    expect(mapDagsterJobToItem(makeJob({ repository: "" }), ctx())).toBeNull();
  });

  test("service/type fixed; externalId is the location:repository:jobName triple", () => {
    const row = mapDagsterJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("dagster");
    expect(row.type).toBe("job");
    expect(row.externalId).toBe("analytics_code:analytics:nightly_etl");
  });

  test("externalId uses an underscore placeholder when location is null (NOT the opaque id)", () => {
    const row = mapDagsterJobToItem(makeJob({ location: null }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe("_:analytics:nightly_etl");
    // The opaque base64 `id` must never become the external id.
    expect(row.externalId).not.toContain("opaque-base64-id");
  });

  test("title includes name + description; canonical url derived from base + location + name", () => {
    const row = mapDagsterJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("nightly_etl — Nightly extract-transform-load job");
    expect(row.url).toBe(
      "https://my-org.dagster.cloud/prod/locations/analytics_code/jobs/nightly_etl",
    );
    expect(row.canonicalUrl).toBe(
      "https://my-org.dagster.cloud/prod/locations/analytics_code/jobs/nightly_etl",
    );
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("title is just the name when description absent", () => {
    const row = mapDagsterJobToItem(makeJob({}, { description: undefined }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("nightly_etl");
    expect(meta(row)["description"]).toBeNull();
  });

  test("canonical url is null when location is null", () => {
    const row = mapDagsterJobToItem(makeJob({ location: null }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.url).toBeNull();
    expect(row.canonicalUrl).toBeNull();
  });

  test("canonical url is null when base url is not parseable", () => {
    const row = mapDagsterJobToItem(makeJob(), ctx({ baseUrl: "not a url" }));
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
  });

  test("extracts flat fields into metadata", () => {
    const row = mapDagsterJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["name"]).toBe("nightly_etl");
    expect(m["repository"]).toBe("analytics");
    expect(m["location"]).toBe("analytics_code");
    expect(m["description"]).toBe("Nightly extract-transform-load job");
    expect(m["is_job"]).toBe(true);
    expect(m["tags"]).toEqual(["team=data", "tier=1"]);
    expect(m["tag_keys"]).toEqual(["team", "tier"]);
  });

  test("is_job is true only when literally true", () => {
    const row = mapDagsterJobToItem(makeJob({}, { isJob: "yes" }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["is_job"]).toBe(false);
  });

  test("tolerates a non-array / malformed tags value", () => {
    const a = mapDagsterJobToItem(makeJob({}, { tags: "nope" }), ctx());
    if (a === null) throw new Error("expected mapping to succeed");
    expect(meta(a)["tags"]).toEqual([]);

    const b = mapDagsterJobToItem(
      makeJob({}, { tags: [null, 7, { value: "no-key" }, { key: "ok" }] }),
      ctx(),
    );
    if (b === null) throw new Error("expected mapping to succeed");
    expect(meta(b)["tag_keys"]).toEqual(["ok"]);
    expect(meta(b)["tags"]).toEqual(["ok="]);
  });

  test("modifiedAt and syncedAt are the sync timestamp", () => {
    const row = mapDagsterJobToItem(makeJob(), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(NOW);
    expect(row.syncedAt).toBe(NOW);
  });

  test("long name + description title is truncated with an ellipsis", () => {
    const longDesc = "x".repeat(300);
    const row = mapDagsterJobToItem(makeJob({}, { description: longDesc }), ctx());
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.title.length).toBe(201);
  });
});
