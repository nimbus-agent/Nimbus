import { describe, expect, test } from "bun:test";

import {
  mapPipedriveDealToItem,
  pipedriveTimeMs,
} from "../../../src/connectors/pipedrive-deal-mapping.ts";

const ADD_PD = "2024-01-15 10:30:00";
const ADD_MS = Date.parse("2024-01-15T10:30:00Z");
const UPDATE_PD = "2024-02-01 08:00:00";
const UPDATE_MS = Date.parse("2024-02-01T08:00:00Z");
const WON_PD = "2024-02-10 14:15:00";
const WON_MS = Date.parse("2024-02-10T14:15:00Z");

function makeDeal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12345,
    title: "Acme Corp — annual renewal",
    value: 48000,
    currency: "USD",
    status: "open",
    stage_id: 3,
    pipeline_id: 1,
    person_id: 777,
    person_name: "Jane Roe",
    org_id: 999,
    org_name: "Acme Corporation",
    owner_name: "Sam Seller",
    probability: 80,
    label: "hot-lead",
    expected_close_date: "2024-03-01",
    won_time: null,
    close_time: null,
    add_time: ADD_PD,
    update_time: UPDATE_PD,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("pipedriveTimeMs", () => {
  test('"2024-01-15 10:30:00" parses to the correct UTC epoch-ms', () => {
    expect(pipedriveTimeMs("2024-01-15 10:30:00")).toBe(Date.parse("2024-01-15T10:30:00Z"));
    expect(pipedriveTimeMs("2024-01-15 10:30:00")).toBe(1_705_314_600_000);
  });

  test("returns null for empty / whitespace / non-string / unparseable input", () => {
    expect(pipedriveTimeMs("")).toBeNull();
    expect(pipedriveTimeMs("   ")).toBeNull();
    expect(pipedriveTimeMs(null)).toBeNull();
    expect(pipedriveTimeMs(undefined)).toBeNull();
    expect(pipedriveTimeMs(1_705_314_600_000)).toBeNull();
    expect(pipedriveTimeMs("not a date")).toBeNull();
  });
});

describe("mapPipedriveDealToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapPipedriveDealToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapPipedriveDealToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapPipedriveDealToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or not a number", () => {
    const noId = makeDeal();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapPipedriveDealToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(mapPipedriveDealToItem(makeDeal({ id: "12345" }), { syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is the stringified numeric id", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("pipedrive");
    expect(row.type).toBe("deal");
    expect(row.externalId).toBe("12345");
  });

  test("title is the deal title when present, else `Deal <id>`", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Acme Corp — annual renewal");

    const noTitle = makeDeal();
    delete (noTitle as Record<string, unknown>)["title"];
    const fallback = mapPipedriveDealToItem(noTitle, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.title).toBe("Deal 12345");

    const empty = mapPipedriveDealToItem(makeDeal({ title: "" }), { syncedAt: NOW });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.title).toBe("Deal 12345");
  });

  test("bodyPreview is `<value> <currency> — <status>` when a value is present", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("48000 USD — open");
  });

  test("bodyPreview falls back to status, then org_name, then person_name, then title", () => {
    const noValue = makeDeal();
    delete (noValue as Record<string, unknown>)["value"];
    const onStatus = mapPipedriveDealToItem(noValue, { syncedAt: NOW });
    if (onStatus === null) throw new Error("expected mapping to succeed");
    expect(onStatus.bodyPreview).toBe("open");

    const noStatus = makeDeal();
    delete (noStatus as Record<string, unknown>)["value"];
    delete (noStatus as Record<string, unknown>)["status"];
    const onOrg = mapPipedriveDealToItem(noStatus, { syncedAt: NOW });
    if (onOrg === null) throw new Error("expected mapping to succeed");
    expect(onOrg.bodyPreview).toBe("Acme Corporation");

    const noOrg = makeDeal();
    delete (noOrg as Record<string, unknown>)["value"];
    delete (noOrg as Record<string, unknown>)["status"];
    delete (noOrg as Record<string, unknown>)["org_name"];
    delete (noOrg as Record<string, unknown>)["org_id"];
    const onPerson = mapPipedriveDealToItem(noOrg, { syncedAt: NOW });
    if (onPerson === null) throw new Error("expected mapping to succeed");
    expect(onPerson.bodyPreview).toBe("Jane Roe");

    const bare = makeDeal();
    delete (bare as Record<string, unknown>)["value"];
    delete (bare as Record<string, unknown>)["status"];
    delete (bare as Record<string, unknown>)["org_name"];
    delete (bare as Record<string, unknown>)["org_id"];
    delete (bare as Record<string, unknown>)["person_name"];
    delete (bare as Record<string, unknown>)["person_id"];
    const onTitle = mapPipedriveDealToItem(bare, { syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe("Acme Corp — annual renewal");
  });

  test("Pipedrive timestamps → UTC epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapPipedriveDealToItem(makeDeal({ won_time: WON_PD, close_time: WON_PD }), {
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["add_time"]).toBe(ADD_MS);
    expect(meta(row)["update_time"]).toBe(UPDATE_MS);
    expect(meta(row)["won_time"]).toBe(WON_MS);
    expect(meta(row)["close_time"]).toBe(WON_MS);
    expect(meta(row)["add_time"]).toBe(Date.parse("2024-01-15T10:30:00Z"));
  });

  test("modifiedAt prefers update_time, then add_time, then syncedAt", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATE_MS);

    const noUpdate = makeDeal();
    delete (noUpdate as Record<string, unknown>)["update_time"];
    const onAdd = mapPipedriveDealToItem(noUpdate, { syncedAt: NOW });
    if (onAdd === null) throw new Error("expected mapping to succeed");
    expect(onAdd.modifiedAt).toBe(ADD_MS);

    const noTimes = makeDeal();
    delete (noTimes as Record<string, unknown>)["update_time"];
    delete (noTimes as Record<string, unknown>)["add_time"];
    const fallback = mapPipedriveDealToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["add_time"]).toBeNull();
    expect(meta(fallback)["update_time"]).toBeNull();
  });

  test("canonicalUrl/url are always null (deferred — needs the company domain)", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();
  });

  test("scalar person_id / org_id pass through", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["person_id"]).toBe(777);
    expect(meta(row)["org_id"]).toBe(999);
  });

  test("nested { value, name } person_id / org_id are extracted defensively", () => {
    const nested = makeDeal({
      person_id: { value: 777, name: "Jane Roe" },
      org_id: { value: 999, name: "Acme Corporation" },
    });
    delete (nested as Record<string, unknown>)["person_name"];
    delete (nested as Record<string, unknown>)["org_name"];
    const row = mapPipedriveDealToItem(nested, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["person_id"]).toBe(777);
    expect(meta(row)["org_id"]).toBe(999);
    expect(meta(row)["person_name"]).toBe("Jane Roe");
    expect(meta(row)["org_name"]).toBe("Acme Corporation");
  });

  test("full metadata flows through", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["deal_id"]).toBe("12345");
    expect(m["title"]).toBe("Acme Corp — annual renewal");
    expect(m["value"]).toBe(48000);
    expect(m["currency"]).toBe("USD");
    expect(m["status"]).toBe("open");
    expect(m["stage_id"]).toBe(3);
    expect(m["pipeline_id"]).toBe(1);
    expect(m["person_name"]).toBe("Jane Roe");
    expect(m["org_name"]).toBe("Acme Corporation");
    expect(m["owner_name"]).toBe("Sam Seller");
    expect(m["probability"]).toBe(80);
    expect(m["label"]).toBe("hot-lead");
    expect(m["expected_close_date"]).toBe("2024-03-01");
  });

  test("missing fields are null-passthrough in metadata", () => {
    const sparse = makeDeal();
    delete (sparse as Record<string, unknown>)["value"];
    delete (sparse as Record<string, unknown>)["currency"];
    delete (sparse as Record<string, unknown>)["stage_id"];
    delete (sparse as Record<string, unknown>)["pipeline_id"];
    delete (sparse as Record<string, unknown>)["person_id"];
    delete (sparse as Record<string, unknown>)["person_name"];
    delete (sparse as Record<string, unknown>)["org_id"];
    delete (sparse as Record<string, unknown>)["org_name"];
    delete (sparse as Record<string, unknown>)["owner_name"];
    delete (sparse as Record<string, unknown>)["probability"];
    delete (sparse as Record<string, unknown>)["label"];
    delete (sparse as Record<string, unknown>)["expected_close_date"];
    const row = mapPipedriveDealToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["value"]).toBeNull();
    expect(m["currency"]).toBeNull();
    expect(m["stage_id"]).toBeNull();
    expect(m["pipeline_id"]).toBeNull();
    expect(m["person_id"]).toBeNull();
    expect(m["person_name"]).toBeNull();
    expect(m["org_id"]).toBeNull();
    expect(m["org_name"]).toBeNull();
    expect(m["owner_name"]).toBeNull();
    expect(m["probability"]).toBeNull();
    expect(m["label"]).toBeNull();
    expect(m["expected_close_date"]).toBeNull();
  });

  test("syncedAt propagates", () => {
    const row = mapPipedriveDealToItem(makeDeal(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});
