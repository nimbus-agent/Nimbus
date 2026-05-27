import { describe, expect, test } from "bun:test";

import {
  mapZendeskTicketToItem,
  tagStrings,
} from "../../../src/connectors/zendesk-ticket-mapping.ts";

// 2024-03-01T12:00:00Z → Date.parse → epoch ms.
const CREATED_ISO = "2024-03-01T12:00:00Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const UPDATED_ISO = "2024-03-02T08:00:00Z";
const UPDATED_MS = Date.parse(UPDATED_ISO);

const BASE = "https://acme.zendesk.com";

function makeTicket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12345,
    subject: "Checkout button unresponsive on Safari",
    description: "Customer reports the checkout button does nothing on Safari 17",
    status: "open",
    priority: "high",
    type: "incident",
    requester_id: 901,
    assignee_id: 42,
    group_id: 7,
    organization_id: 1001,
    tags: ["checkout", "safari"],
    via: { channel: "email" },
    created_at: CREATED_ISO,
    updated_at: UPDATED_ISO,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapZendeskTicketToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapZendeskTicketToItem(null, { baseUrl: BASE, syncedAt: NOW })).toBeNull();
    expect(mapZendeskTicketToItem("nope", { baseUrl: BASE, syncedAt: NOW })).toBeNull();
    expect(mapZendeskTicketToItem(42, { baseUrl: BASE, syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or not numeric", () => {
    const noId = makeTicket();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapZendeskTicketToItem(noId, { baseUrl: BASE, syncedAt: NOW })).toBeNull();
    expect(
      mapZendeskTicketToItem(makeTicket({ id: "not-a-number" }), { baseUrl: BASE, syncedAt: NOW }),
    ).toBeNull();
  });

  test("accepts a numeric-string id (coerced to the canonical number string)", () => {
    const row = mapZendeskTicketToItem(makeTicket({ id: "678" }), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.externalId).toBe("678");
  });

  test("service/type fixed; externalId is the stringified numeric id", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("zendesk");
    expect(row.type).toBe("ticket");
    expect(row.externalId).toBe("12345");
  });

  test("title is the subject when present", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Checkout button unresponsive on Safari");
  });

  test("title falls back to `Ticket <id>` when subject missing/empty/whitespace", () => {
    const noSubject = makeTicket();
    delete (noSubject as Record<string, unknown>)["subject"];
    const row = mapZendeskTicketToItem(noSubject, { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Ticket 12345");

    const empty = mapZendeskTicketToItem(makeTicket({ subject: "   " }), {
      baseUrl: BASE,
      syncedAt: NOW,
    });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.title).toBe("Ticket 12345");
  });

  test("bodyPreview is the description when present", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Customer reports the checkout button does nothing on Safari 17");
  });

  test("bodyPreview falls back to the status label, then the title", () => {
    const noDesc = makeTicket();
    delete (noDesc as Record<string, unknown>)["description"];
    const onStatus = mapZendeskTicketToItem(noDesc, { baseUrl: BASE, syncedAt: NOW });
    if (onStatus === null) throw new Error("expected mapping to succeed");
    expect(onStatus.bodyPreview).toBe("open");

    const noStatus = makeTicket();
    delete (noStatus as Record<string, unknown>)["description"];
    delete (noStatus as Record<string, unknown>)["status"];
    const onTitle = mapZendeskTicketToItem(noStatus, { baseUrl: BASE, syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe("Checkout button unresponsive on Safari");
  });

  test("ISO-8601 timestamps → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
    expect(meta(row)["updated_at"]).toBe(Date.parse(UPDATED_ISO));
  });

  test("modifiedAt prefers updated_at, then created_at, then syncedAt", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdate = makeTicket();
    delete (noUpdate as Record<string, unknown>)["updated_at"];
    const onlyCreated = mapZendeskTicketToItem(noUpdate, { baseUrl: BASE, syncedAt: NOW });
    if (onlyCreated === null) throw new Error("expected mapping to succeed");
    expect(onlyCreated.modifiedAt).toBe(CREATED_MS);

    const noTimes = makeTicket();
    delete (noTimes as Record<string, unknown>)["updated_at"];
    delete (noTimes as Record<string, unknown>)["created_at"];
    const fallback = mapZendeskTicketToItem(noTimes, { baseUrl: BASE, syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
    expect(meta(fallback)["updated_at"]).toBeNull();
  });

  test("canonicalUrl/url is the agent-UI deep link built from the base URL", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://acme.zendesk.com/agent/tickets/12345");
    expect(row.url).toBe("https://acme.zendesk.com/agent/tickets/12345");
    expect(meta(row)["canonical_url"]).toBe("https://acme.zendesk.com/agent/tickets/12345");
  });

  test("a trailing slash on the base URL is stripped before concatenation", () => {
    const row = mapZendeskTicketToItem(makeTicket(), {
      baseUrl: "https://acme.zendesk.com/",
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://acme.zendesk.com/agent/tickets/12345");
  });

  test("canonicalUrl/url is null when baseUrl is empty", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: "", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();
  });

  test("tags are stored as the string array verbatim", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["checkout", "safari"]);
  });

  test("via_channel is read from the nested via.channel", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["via_channel"]).toBe("email");
  });

  test("via_channel is null when via is missing or not an object", () => {
    const noVia = makeTicket();
    delete (noVia as Record<string, unknown>)["via"];
    const row = mapZendeskTicketToItem(noVia, { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["via_channel"]).toBeNull();

    const badVia = mapZendeskTicketToItem(makeTicket({ via: "email" }), {
      baseUrl: BASE,
      syncedAt: NOW,
    });
    if (badVia === null) throw new Error("expected mapping to succeed");
    expect(meta(badVia)["via_channel"]).toBeNull();
  });

  test("full metadata flows through", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["ticket_id"]).toBe("12345");
    expect(m["subject"]).toBe("Checkout button unresponsive on Safari");
    expect(m["status"]).toBe("open");
    expect(m["priority"]).toBe("high");
    expect(m["type"]).toBe("incident");
    expect(m["requester_id"]).toBe(901);
    expect(m["assignee_id"]).toBe(42);
    expect(m["group_id"]).toBe(7);
    expect(m["organization_id"]).toBe(1001);
  });

  test("missing optional fields are null-passthrough in metadata", () => {
    const sparse = makeTicket();
    delete (sparse as Record<string, unknown>)["priority"];
    delete (sparse as Record<string, unknown>)["type"];
    delete (sparse as Record<string, unknown>)["requester_id"];
    delete (sparse as Record<string, unknown>)["assignee_id"];
    delete (sparse as Record<string, unknown>)["group_id"];
    delete (sparse as Record<string, unknown>)["organization_id"];
    delete (sparse as Record<string, unknown>)["tags"];
    const row = mapZendeskTicketToItem(sparse, { baseUrl: BASE, syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["priority"]).toBeNull();
    expect(m["type"]).toBeNull();
    expect(m["requester_id"]).toBeNull();
    expect(m["assignee_id"]).toBeNull();
    expect(m["group_id"]).toBeNull();
    expect(m["organization_id"]).toBeNull();
    expect(m["tags"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapZendeskTicketToItem(makeTicket(), { baseUrl: BASE, syncedAt: NOW });
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
