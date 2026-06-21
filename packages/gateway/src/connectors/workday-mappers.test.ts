import { describe, expect, test } from "bun:test";
import type { WorkdayReport } from "../config/nimbus-toml-workday.ts";
import {
  mapJobPostingToItem,
  mapReportRowToItem,
  mapTimeOffToItem,
  mapWorkerToItem,
} from "./workday-mappers.ts";

const ctx = {
  syncedAt: 1_700_000_000_000,
  tenantHost: "https://wd5.workday.com",
  tenant: "acme",
};

// ---------------------------------------------------------------------------
// mapWorkerToItem
// ---------------------------------------------------------------------------

describe("mapWorkerToItem", () => {
  test("maps allowlisted fields and a stable id; drops PII", () => {
    const raw = {
      id: "w-1",
      name: "Ada Lovelace",
      title: "Principal Engineer",
      manager: "Charles Babbage",
      team: "Analytical Engines",
      location: "London",
      salary: 250_000,
      ssn: "123-45-6789",
      home_address: "12 Mayfair",
    };
    const item = mapWorkerToItem(raw, ctx);
    expect(item).not.toBeNull();
    expect(item?.externalId).toBe("w-1");
    expect(item?.service).toBe("workday");
    expect(item?.type).toBe("worker");
    expect(item?.title).toBe("Ada Lovelace");
    expect(item?.metadata).toMatchObject({
      title: "Principal Engineer",
      team: "Analytical Engines",
    });
    expect(JSON.stringify(item?.metadata)).not.toContain("250000");
    expect(JSON.stringify(item?.metadata)).not.toContain("123-45-6789");
    expect(JSON.stringify(item)).not.toContain("Mayfair");
  });

  test("uses workerId when id is absent", () => {
    const item = mapWorkerToItem({ workerId: "w-2", name: "Bob" }, ctx);
    expect(item?.externalId).toBe("w-2");
    expect(item?.title).toBe("Bob");
  });

  test("falls back to descriptor for title when name is missing", () => {
    const item = mapWorkerToItem({ id: "w-3", descriptor: "Carol" }, ctx);
    expect(item?.title).toBe("Carol");
  });

  test("falls back to generated title when name and descriptor are absent", () => {
    const item = mapWorkerToItem({ id: "w-4" }, ctx);
    expect(item?.title).toBe("Worker w-4");
  });

  test("returns null when worker id is missing", () => {
    expect(mapWorkerToItem({ name: "x" }, ctx)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(mapWorkerToItem(null, ctx)).toBeNull();
    expect(mapWorkerToItem("string", ctx)).toBeNull();
    expect(mapWorkerToItem(42, ctx)).toBeNull();
  });

  test("sets syncedAt and modifiedAt from ctx", () => {
    const item = mapWorkerToItem({ id: "w-5", name: "Dan" }, ctx);
    expect(item?.syncedAt).toBe(ctx.syncedAt);
    expect(item?.modifiedAt).toBe(ctx.syncedAt);
  });

  test("canonicalUrl is set in metadata and url fields", () => {
    const item = mapWorkerToItem({ id: "w-6", name: "Eve" }, ctx);
    expect(item?.url).toContain("w-6");
    expect(item?.canonicalUrl).toBe(item?.url);
    expect(item?.metadata["canonicalUrl"]).toBe(item?.url);
  });

  test("bodyPreview joins allowlisted display fields", () => {
    const item = mapWorkerToItem(
      { id: "w-7", name: "Frank", title: "Eng", team: "Platform", location: "NYC" },
      ctx,
    );
    expect(item?.bodyPreview).toContain("Eng");
    expect(item?.bodyPreview).toContain("Platform");
    expect(item?.bodyPreview).toContain("NYC");
  });
});

// ---------------------------------------------------------------------------
// mapTimeOffToItem
// ---------------------------------------------------------------------------

describe("mapTimeOffToItem", () => {
  test("keeps category + dates, drops reason/comment/medicalNote", () => {
    const item = mapTimeOffToItem(
      {
        id: "to-9",
        worker: "Ada",
        type: "Sick",
        startDate: "2026-01-02",
        endDate: "2026-01-03",
        units: 2,
        status: "Approved",
        reason: "flu",
        comment: "private",
        medicalNote: "x",
      },
      ctx,
    );
    expect(item?.type).toBe("time_off");
    expect(item?.externalId).toBe("to-9");
    expect(item?.metadata).toMatchObject({ type: "Sick", status: "Approved", units: 2 });
    expect(JSON.stringify(item)).not.toContain("flu");
    expect(JSON.stringify(item)).not.toContain("private");
    expect(JSON.stringify(item)).not.toContain("medicalNote");
  });

  test("returns null when id is missing", () => {
    expect(mapTimeOffToItem({}, ctx)).toBeNull();
    expect(mapTimeOffToItem({ worker: "Ada" }, ctx)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(mapTimeOffToItem(null, ctx)).toBeNull();
    expect(mapTimeOffToItem("string", ctx)).toBeNull();
  });

  test("title is derived from type and startDate", () => {
    const item = mapTimeOffToItem({ id: "to-10", type: "Vacation", startDate: "2026-03-01" }, ctx);
    expect(item?.title).toBe("Vacation 2026-03-01");
  });

  test("title falls back gracefully when type/startDate absent", () => {
    const item = mapTimeOffToItem({ id: "to-11" }, ctx);
    expect(item?.title).toBe("Time Off");
  });

  test("service is workday", () => {
    const item = mapTimeOffToItem({ id: "to-12", type: "Sick", startDate: "2026-01-01" }, ctx);
    expect(item?.service).toBe("workday");
  });

  test("syncedAt and modifiedAt from ctx", () => {
    const item = mapTimeOffToItem({ id: "to-13" }, ctx);
    expect(item?.syncedAt).toBe(ctx.syncedAt);
    expect(item?.modifiedAt).toBe(ctx.syncedAt);
  });
});

// ---------------------------------------------------------------------------
// mapJobPostingToItem
// ---------------------------------------------------------------------------

describe("mapJobPostingToItem", () => {
  test("maps allowlisted fields; no description body", () => {
    const raw = {
      id: "jp-1",
      title: "Staff Engineer",
      team: "Platform",
      department: "Engineering",
      location: "Remote",
      status: "Open",
      postedDate: "2026-01-15",
      description: "Do amazing things",
      qualifications: "PhD preferred",
    };
    const item = mapJobPostingToItem(raw, ctx);
    expect(item).not.toBeNull();
    expect(item?.type).toBe("job_posting");
    expect(item?.externalId).toBe("jp-1");
    expect(item?.title).toBe("Staff Engineer");
    expect(item?.metadata).toMatchObject({
      title: "Staff Engineer",
      team: "Platform",
      status: "Open",
    });
    expect(JSON.stringify(item)).not.toContain("Do amazing things");
    expect(JSON.stringify(item)).not.toContain("qualifications");
    expect(JSON.stringify(item)).not.toContain("PhD");
  });

  test("uses reqId when id is absent", () => {
    const item = mapJobPostingToItem({ reqId: "jp-2", title: "PM" }, ctx);
    expect(item?.externalId).toBe("jp-2");
  });

  test("returns null when id is missing", () => {
    expect(mapJobPostingToItem({ title: "Engineer" }, ctx)).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(mapJobPostingToItem(null, ctx)).toBeNull();
    expect(mapJobPostingToItem(42, ctx)).toBeNull();
  });

  test("title falls back to generated when absent", () => {
    const item = mapJobPostingToItem({ id: "jp-3" }, ctx);
    expect(item?.title).toBe("Job Posting jp-3");
  });

  test("service is workday and syncedAt from ctx", () => {
    const item = mapJobPostingToItem({ id: "jp-4", title: "SRE" }, ctx);
    expect(item?.service).toBe("workday");
    expect(item?.syncedAt).toBe(ctx.syncedAt);
  });

  test("bodyPreview includes team/location/status", () => {
    const item = mapJobPostingToItem(
      { id: "jp-5", title: "SWE", team: "Infra", location: "Austin", status: "Open" },
      ctx,
    );
    expect(item?.bodyPreview).toContain("Infra");
    expect(item?.bodyPreview).toContain("Austin");
    expect(item?.bodyPreview).toContain("Open");
  });
});

// ---------------------------------------------------------------------------
// mapReportRowToItem
// ---------------------------------------------------------------------------

const rpt: WorkdayReport = { label: "headcount", url: "https://wd5.workday.com/x" };

describe("mapReportRowToItem", () => {
  test("uses key_field for a stable external id", () => {
    const r = mapReportRowToItem(
      { employee_id: "e1", org: "Eng" },
      { ...rpt, keyField: "employee_id" },
      ctx,
    );
    expect(r?.externalId).toBe("headcount:e1");
    expect(r?.type).toBe("report");
  });

  test("a key_field pointing at a PII column falls back to the content hash (no PII in id/title)", () => {
    const r = mapReportRowToItem(
      { ssn: "123-45-6789", org: "Eng" },
      { ...rpt, keyField: "ssn" },
      ctx,
    );
    expect(r?.externalId.startsWith("headcount:")).toBe(true);
    // The SSN value must not surface in the id or title.
    expect(JSON.stringify(r)).not.toContain("123-45-6789");
  });

  test("an empty key_field value falls back to the content hash (no blank-suffix collisions)", () => {
    const r = mapReportRowToItem(
      { employee_id: "", org: "Eng" },
      { ...rpt, keyField: "employee_id" },
      ctx,
    );
    // Must NOT be the bare "headcount:" (which would collapse all blank-key rows together).
    expect(r?.externalId).not.toBe("headcount:");
    expect(r?.externalId.startsWith("headcount:")).toBe(true);
    expect(r?.externalId.length ?? 0).toBeGreaterThan("headcount:".length);
  });

  test("content hash distinguishes rows that a naive join would collide", () => {
    // {a:"b=c"} and {a:"b", c:""} both flatten to "a=b=c"/"a=bc=" under a naive join;
    // the JSON-encoded preimage keeps them distinct.
    const a = mapReportRowToItem({ a: "b=c" }, rpt, ctx);
    const b = mapReportRowToItem({ a: "b", c: "" }, rpt, ctx);
    expect(a?.externalId).not.toBe(b?.externalId);
  });

  test("hashes the row content when no key_field — same content yields same id (position-independent)", () => {
    const a = mapReportRowToItem({ org: "Eng", headcount: 12 }, rpt, ctx);
    const b = mapReportRowToItem({ org: "Eng", headcount: 12 }, rpt, ctx);
    const c = mapReportRowToItem({ org: "Sales", headcount: 7 }, rpt, ctx);
    expect(a?.externalId).toBe(b?.externalId);
    expect(a?.externalId).not.toBe(c?.externalId);
    expect(a?.externalId.startsWith("headcount:")).toBe(true);
  });

  test("content hash is position-independent (key order does not matter)", () => {
    const a = mapReportRowToItem({ org: "Eng", headcount: 12 }, rpt, ctx);
    const b = mapReportRowToItem({ headcount: 12, org: "Eng" }, rpt, ctx);
    expect(a?.externalId).toBe(b?.externalId);
  });

  test("applies fields allowlist / denylist when no fields config", () => {
    const r = mapReportRowToItem({ employee_id: "e1", salary: 9, ssn: "x" }, rpt, ctx);
    expect(JSON.stringify(r)).not.toContain("salary");
    expect(JSON.stringify(r)).not.toContain('"x"');
  });

  test("uses explicit fields list when provided (bypasses PII denylist per policy)", () => {
    const reportWithFields: WorkdayReport = {
      ...rpt,
      fields: ["employee_id", "org"],
    };
    const r = mapReportRowToItem(
      { employee_id: "e2", org: "HR", salary: 9 },
      reportWithFields,
      ctx,
    );
    expect(r?.metadata["employee_id"]).toBe("e2");
    expect(r?.metadata["org"]).toBe("HR");
    expect(JSON.stringify(r?.metadata)).not.toContain("salary");
  });

  test("returns null for non-object input", () => {
    expect(mapReportRowToItem(null, rpt, ctx)).toBeNull();
    expect(mapReportRowToItem("string", rpt, ctx)).toBeNull();
  });

  test("service is workday and type is report", () => {
    const r = mapReportRowToItem({ org: "Eng" }, rpt, ctx);
    expect(r?.service).toBe("workday");
    expect(r?.type).toBe("report");
  });

  test("metadata includes reportLabel", () => {
    const r = mapReportRowToItem({ org: "Eng" }, rpt, ctx);
    expect(r?.metadata["reportLabel"]).toBe("headcount");
  });

  test("url and canonicalUrl come from report.url", () => {
    const r = mapReportRowToItem({ org: "Eng" }, rpt, ctx);
    expect(r?.url).toBe(rpt.url);
    expect(r?.canonicalUrl).toBe(rpt.url);
  });

  test("syncedAt and modifiedAt from ctx", () => {
    const r = mapReportRowToItem({ org: "Eng" }, rpt, ctx);
    expect(r?.syncedAt).toBe(ctx.syncedAt);
    expect(r?.modifiedAt).toBe(ctx.syncedAt);
  });

  test("key_field falls back to hash when value is not a string", () => {
    // keyField present but value is a number — should use content hash, not the number
    const r = mapReportRowToItem({ count: 42 }, { ...rpt, keyField: "count" }, ctx);
    // externalId should still be prefixed with label and be a hash (not "headcount:42" since 42 is not a string)
    expect(r?.externalId.startsWith("headcount:")).toBe(true);
    expect(r?.externalId).not.toBe("headcount:42");
  });
});
