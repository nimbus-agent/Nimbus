import { describe, expect, test } from "bun:test";

import {
  mapGreenhouseJobToItem,
  namedEntryNames,
  officeLocationNames,
} from "../../../src/connectors/greenhouse-job-mapping.ts";

const CREATED_ISO = "2024-03-01T12:00:00.000Z";
const UPDATED_ISO = "2024-03-02T12:00:00.000Z";
const OPENED_ISO = "2024-03-01T12:30:00.000Z";
const CLOSED_ISO = "2024-04-01T12:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const UPDATED_MS = Date.parse(UPDATED_ISO);
const OPENED_MS = Date.parse(OPENED_ISO);
const CLOSED_MS = Date.parse(CLOSED_ISO);
const JOB_ID = 4001234;

function makeJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    name: "Senior Backend Engineer",
    status: "open",
    requisition_id: "ENG-042",
    confidential: false,
    departments: [{ id: 1, name: "Engineering" }],
    offices: [{ id: 10, name: "San Francisco HQ", location: { name: "San Francisco, CA" } }],
    opened_at: OPENED_ISO,
    closed_at: CLOSED_ISO,
    created_at: CREATED_ISO,
    updated_at: UPDATED_ISO,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapGreenhouseJobToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapGreenhouseJobToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapGreenhouseJobToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapGreenhouseJobToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or non-numeric", () => {
    const noId = makeJob();
    delete noId["id"];
    expect(mapGreenhouseJobToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapGreenhouseJobToItem(makeJob({ id: "4001234" }), { syncedAt: NOW })).toBeNull();
  });

  test("accepts a numeric id; service/type fixed; externalId is the stringified id", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("greenhouse");
    expect(row.type).toBe("job");
    expect(row.externalId).toBe(String(JOB_ID));
  });

  test("title is the trimmed job name when present", () => {
    const row = mapGreenhouseJobToItem(makeJob({ name: "  Senior Backend Engineer  " }), {
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Senior Backend Engineer");
  });

  test("title falls back to `Job <id>` when name missing/empty", () => {
    const noName = makeJob();
    delete noName["name"];
    const row = mapGreenhouseJobToItem(noName, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe(`Job ${String(JOB_ID)}`);

    const emptyName = mapGreenhouseJobToItem(makeJob({ name: "   " }), { syncedAt: NOW });
    if (emptyName === null) throw new Error("expected mapping to succeed");
    expect(emptyName.title).toBe(`Job ${String(JOB_ID)}`);
  });

  test("bodyPreview is the department + office name/location summary", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Engineering — San Francisco HQ — San Francisco, CA");
  });

  test("summary skips absent department/office fields", () => {
    const partial = makeJob({ departments: [{ name: "Engineering" }], offices: [] });
    const row = mapGreenhouseJobToItem(partial, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Engineering");
  });

  test("bodyPreview falls back to status, then title", () => {
    const noOrgs = makeJob({ departments: [], offices: [] });
    const onStatus = mapGreenhouseJobToItem(noOrgs, { syncedAt: NOW });
    if (onStatus === null) throw new Error("expected mapping to succeed");
    expect(onStatus.bodyPreview).toBe("open");

    const bare = makeJob({ departments: [], offices: [] });
    delete bare["status"];
    const onTitle = mapGreenhouseJobToItem(bare, { syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe("Senior Backend Engineer");
  });

  test("ISO-8601 timestamps are parsed to epoch-ms (NOT verbatim, NOT epoch-seconds)", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
    expect(meta(row)["opened_at"]).toBe(OPENED_MS);
    expect(meta(row)["closed_at"]).toBe(CLOSED_MS);
  });

  test("an epoch-ms number timestamp is NOT accepted (ISO string only) → null", () => {
    const numeric = mapGreenhouseJobToItem(makeJob({ created_at: 1_700_000_000_000 }), {
      syncedAt: NOW,
    });
    if (numeric === null) throw new Error("expected mapping to succeed");
    expect(meta(numeric)["created_at"]).toBeNull();
  });

  test("missing / unparseable timestamps → null", () => {
    const missing = makeJob();
    delete missing["created_at"];
    delete missing["updated_at"];
    delete missing["opened_at"];
    delete missing["closed_at"];
    const row = mapGreenhouseJobToItem(missing, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBeNull();
    expect(meta(row)["updated_at"]).toBeNull();
    expect(meta(row)["opened_at"]).toBeNull();
    expect(meta(row)["closed_at"]).toBeNull();

    const garbage = mapGreenhouseJobToItem(makeJob({ created_at: "not-a-date" }), {
      syncedAt: NOW,
    });
    if (garbage === null) throw new Error("expected mapping to succeed");
    expect(meta(garbage)["created_at"]).toBeNull();
  });

  test("modifiedAt prefers updated_at, then created_at, then syncedAt", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdate = makeJob();
    delete noUpdate["updated_at"];
    const onCreated = mapGreenhouseJobToItem(noUpdate, { syncedAt: NOW });
    if (onCreated === null) throw new Error("expected mapping to succeed");
    expect(onCreated.modifiedAt).toBe(CREATED_MS);

    const noTimes = makeJob();
    delete noTimes["updated_at"];
    delete noTimes["created_at"];
    const fallback = mapGreenhouseJobToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("canonicalUrl/url is always null (no per-job public URL)", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();
  });

  test("department + office names and locations flow into metadata", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["department_names"]).toEqual(["Engineering"]);
    expect(m["office_names"]).toEqual(["San Francisco HQ"]);
    expect(m["office_locations"]).toEqual(["San Francisco, CA"]);
  });

  test("multiple departments / offices are all collected", () => {
    const multi = makeJob({
      departments: [{ name: "Engineering" }, { name: "Platform" }],
      offices: [
        { name: "SF", location: { name: "San Francisco, CA" } },
        { name: "NYC", location: { name: "New York, NY" } },
      ],
    });
    const row = mapGreenhouseJobToItem(multi, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["department_names"]).toEqual(["Engineering", "Platform"]);
    expect(m["office_names"]).toEqual(["SF", "NYC"]);
    expect(m["office_locations"]).toEqual(["San Francisco, CA", "New York, NY"]);
  });

  test("confidential flag flows through; non-boolean → null", () => {
    const row = mapGreenhouseJobToItem(makeJob({ confidential: true }), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["confidential"]).toBe(true);

    const weird = mapGreenhouseJobToItem(makeJob({ confidential: "yes" }), { syncedAt: NOW });
    if (weird === null) throw new Error("expected mapping to succeed");
    expect(meta(weird)["confidential"]).toBeNull();
  });

  test("full metadata shape flows through", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["job_id"]).toBe(String(JOB_ID));
    expect(m["name"]).toBe("Senior Backend Engineer");
    expect(m["status"]).toBe("open");
    expect(m["requisition_id"]).toBe("ENG-042");
  });

  test("missing fields are null/empty-passthrough in metadata", () => {
    const sparse = makeJob();
    delete sparse["status"];
    delete sparse["requisition_id"];
    delete sparse["confidential"];
    delete sparse["departments"];
    delete sparse["offices"];
    const row = mapGreenhouseJobToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["status"]).toBeNull();
    expect(m["requisition_id"]).toBeNull();
    expect(m["confidential"]).toBeNull();
    expect(m["department_names"]).toEqual([]);
    expect(m["office_names"]).toEqual([]);
    expect(m["office_locations"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapGreenhouseJobToItem(makeJob(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("namedEntryNames", () => {
  test("extracts the name of each entry", () => {
    expect(namedEntryNames([{ name: "Engineering" }, { name: "Product" }])).toEqual([
      "Engineering",
      "Product",
    ]);
  });

  test("tolerates non-array and non-object / nameless entries", () => {
    expect(namedEntryNames(undefined)).toEqual([]);
    expect(namedEntryNames("nope")).toEqual([]);
    expect(namedEntryNames([null, 7, { id: 1 }, { name: "" }, { name: "Ops" }])).toEqual(["Ops"]);
  });
});

describe("officeLocationNames", () => {
  test("extracts the nested location.name of each entry", () => {
    expect(
      officeLocationNames([
        { name: "SF", location: { name: "San Francisco, CA" } },
        { name: "Remote", location: { name: "Remote" } },
      ]),
    ).toEqual(["San Francisco, CA", "Remote"]);
  });

  test("tolerates non-array, missing location, and non-object location", () => {
    expect(officeLocationNames(undefined)).toEqual([]);
    expect(
      officeLocationNames([{ name: "SF" }, { location: "bad" }, { location: { name: "NYC" } }]),
    ).toEqual(["NYC"]);
  });
});
