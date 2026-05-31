import { describe, expect, test } from "bun:test";

import {
  mapLeverPostingToItem,
  tagStrings,
} from "../../../src/connectors/lever-posting-mapping.ts";

const CREATED_MS = 1_700_000_000_000;
const UPDATED_MS = 1_700_000_500_000;
const POSTING_ID = "f2f01e16-27f8-4711-a728-e7c5e8c2d4c4";

function makePosting(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POSTING_ID,
    text: "Senior Backend Engineer",
    state: "published",
    categories: {
      team: "Engineering",
      department: "Product",
      location: "Remote",
      commitment: "Full-time",
      level: "Senior",
    },
    tags: ["backend", "golang"],
    hostedUrl: "https://jobs.lever.co/acme/f2f01e16",
    applyUrl: "https://jobs.lever.co/acme/f2f01e16/apply",
    reqCode: "ENG-042",
    createdAt: CREATED_MS,
    updatedAt: UPDATED_MS,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapLeverPostingToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapLeverPostingToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapLeverPostingToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapLeverPostingToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or empty", () => {
    const noId = makePosting();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapLeverPostingToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapLeverPostingToItem(makePosting({ id: "" }), { syncedAt: NOW })).toBeNull();
  });

  test("accepts a UUID string id (NOT required to be numeric)", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe(POSTING_ID);
  });

  test("service/type fixed; externalId is the stringified id", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("lever");
    expect(row.type).toBe("posting");
    expect(row.externalId).toBe(POSTING_ID);
  });

  test("title is the trimmed posting text when present", () => {
    const row = mapLeverPostingToItem(makePosting({ text: "  Senior Backend Engineer  " }), {
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Senior Backend Engineer");
  });

  test("title falls back to `Posting <id>` when text missing/empty", () => {
    const noText = makePosting();
    delete (noText as Record<string, unknown>)["text"];
    const row = mapLeverPostingToItem(noText, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe(`Posting ${POSTING_ID}`);

    const emptyText = mapLeverPostingToItem(makePosting({ text: "   " }), { syncedAt: NOW });
    if (emptyText === null) throw new Error("expected mapping to succeed");
    expect(emptyText.title).toBe(`Posting ${POSTING_ID}`);
  });

  test("bodyPreview is the category summary joining present fields", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Engineering — Product — Remote — Full-time — Senior");
  });

  test("category summary skips absent fields", () => {
    const partial = makePosting({ categories: { team: "Engineering", location: "Remote" } });
    const row = mapLeverPostingToItem(partial, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Engineering — Remote");
  });

  test("bodyPreview falls back to state, then title", () => {
    const noCats = makePosting();
    delete (noCats as Record<string, unknown>)["categories"];
    const onState = mapLeverPostingToItem(noCats, { syncedAt: NOW });
    if (onState === null) throw new Error("expected mapping to succeed");
    expect(onState.bodyPreview).toBe("published");

    const bare = makePosting();
    delete (bare as Record<string, unknown>)["categories"];
    delete (bare as Record<string, unknown>)["state"];
    const onTitle = mapLeverPostingToItem(bare, { syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe("Senior Backend Engineer");
  });

  test("epoch-ms timestamps pass through VERBATIM (NOT parsed, NOT ×1000)", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
  });

  test("zero / missing timestamps → null", () => {
    const zeroed = mapLeverPostingToItem(makePosting({ createdAt: 0, updatedAt: 0 }), {
      syncedAt: NOW,
    });
    if (zeroed === null) throw new Error("expected mapping to succeed");
    expect(meta(zeroed)["created_at"]).toBeNull();
    expect(meta(zeroed)["updated_at"]).toBeNull();

    const missing = makePosting();
    delete (missing as Record<string, unknown>)["createdAt"];
    delete (missing as Record<string, unknown>)["updatedAt"];
    const row = mapLeverPostingToItem(missing, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBeNull();
    expect(meta(row)["updated_at"]).toBeNull();
  });

  test("a string timestamp is NOT parsed (epoch-ms only) → null", () => {
    const isoish = mapLeverPostingToItem(makePosting({ createdAt: "2024-03-01T12:00:00.000Z" }), {
      syncedAt: NOW,
    });
    if (isoish === null) throw new Error("expected mapping to succeed");
    expect(meta(isoish)["created_at"]).toBeNull();
  });

  test("modifiedAt prefers updatedAt, then createdAt, then syncedAt", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdate = makePosting();
    delete (noUpdate as Record<string, unknown>)["updatedAt"];
    const onCreated = mapLeverPostingToItem(noUpdate, { syncedAt: NOW });
    if (onCreated === null) throw new Error("expected mapping to succeed");
    expect(onCreated.modifiedAt).toBe(CREATED_MS);

    const noTimes = makePosting();
    delete (noTimes as Record<string, unknown>)["updatedAt"];
    delete (noTimes as Record<string, unknown>)["createdAt"];
    const fallback = mapLeverPostingToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("canonicalUrl/url is the hostedUrl when present", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://jobs.lever.co/acme/f2f01e16");
    expect(row.url).toBe("https://jobs.lever.co/acme/f2f01e16");
    expect(meta(row)["canonical_url"]).toBe("https://jobs.lever.co/acme/f2f01e16");
  });

  test("canonicalUrl falls back to urls.show, then applyUrl, then null", () => {
    const noHosted = makePosting();
    delete (noHosted as Record<string, unknown>)["hostedUrl"];
    (noHosted as Record<string, unknown>)["urls"] = { show: "https://jobs.lever.co/acme/show" };
    const onShow = mapLeverPostingToItem(noHosted, { syncedAt: NOW });
    if (onShow === null) throw new Error("expected mapping to succeed");
    expect(onShow.canonicalUrl).toBe("https://jobs.lever.co/acme/show");

    const onApply = makePosting();
    delete (onApply as Record<string, unknown>)["hostedUrl"];
    const apply = mapLeverPostingToItem(onApply, { syncedAt: NOW });
    if (apply === null) throw new Error("expected mapping to succeed");
    expect(apply.canonicalUrl).toBe("https://jobs.lever.co/acme/f2f01e16/apply");

    const none = makePosting();
    delete (none as Record<string, unknown>)["hostedUrl"];
    delete (none as Record<string, unknown>)["applyUrl"];
    const nullUrl = mapLeverPostingToItem(none, { syncedAt: NOW });
    if (nullUrl === null) throw new Error("expected mapping to succeed");
    expect(nullUrl.canonicalUrl).toBeNull();
    expect(nullUrl.url).toBeNull();
  });

  test("categories flatten to top-level metadata", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["team"]).toBe("Engineering");
    expect(m["department"]).toBe("Product");
    expect(m["location"]).toBe("Remote");
    expect(m["commitment"]).toBe("Full-time");
    expect(m["level"]).toBe("Senior");
  });

  test("tags are stored as the string array verbatim", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["backend", "golang"]);
  });

  test("req_code prefers reqCode, else first of requisitionCodes", () => {
    const direct = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (direct === null) throw new Error("expected mapping to succeed");
    expect(meta(direct)["req_code"]).toBe("ENG-042");

    const fromList = makePosting();
    delete (fromList as Record<string, unknown>)["reqCode"];
    (fromList as Record<string, unknown>)["requisitionCodes"] = ["REQ-1", "REQ-2"];
    const list = mapLeverPostingToItem(fromList, { syncedAt: NOW });
    if (list === null) throw new Error("expected mapping to succeed");
    expect(meta(list)["req_code"]).toBe("REQ-1");

    const none = makePosting();
    delete (none as Record<string, unknown>)["reqCode"];
    const noReq = mapLeverPostingToItem(none, { syncedAt: NOW });
    if (noReq === null) throw new Error("expected mapping to succeed");
    expect(meta(noReq)["req_code"]).toBeNull();
  });

  test("full metadata shape flows through", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["posting_id"]).toBe(POSTING_ID);
    expect(m["text"]).toBe("Senior Backend Engineer");
    expect(m["state"]).toBe("published");
    expect(m["hosted_url"]).toBe("https://jobs.lever.co/acme/f2f01e16");
    expect(m["apply_url"]).toBe("https://jobs.lever.co/acme/f2f01e16/apply");
  });

  test("missing fields are null-passthrough in metadata", () => {
    const sparse = makePosting();
    delete (sparse as Record<string, unknown>)["state"];
    delete (sparse as Record<string, unknown>)["categories"];
    delete (sparse as Record<string, unknown>)["hostedUrl"];
    delete (sparse as Record<string, unknown>)["applyUrl"];
    delete (sparse as Record<string, unknown>)["reqCode"];
    delete (sparse as Record<string, unknown>)["tags"];
    const row = mapLeverPostingToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["state"]).toBeNull();
    expect(m["team"]).toBeNull();
    expect(m["department"]).toBeNull();
    expect(m["location"]).toBeNull();
    expect(m["commitment"]).toBeNull();
    expect(m["level"]).toBeNull();
    expect(m["hosted_url"]).toBeNull();
    expect(m["apply_url"]).toBeNull();
    expect(m["req_code"]).toBeNull();
    expect(m["tags"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapLeverPostingToItem(makePosting(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("tagStrings", () => {
  test("extracts the string entries verbatim", () => {
    expect(tagStrings(["a", "b"])).toEqual(["a", "b"]);
  });

  test("tolerates non-array and non-string entries", () => {
    expect(tagStrings(undefined)).toEqual([]);
    expect(tagStrings("nope")).toEqual([]);
    expect(tagStrings([null, 7, "x", { name: "obj" }, "ok"])).toEqual(["x", "ok"]);
  });
});
