import { describe, expect, test } from "bun:test";

import {
  mapIntercomConversationToItem,
  stripHtml,
} from "../../../src/connectors/intercom-conversation-mapping.ts";

// 1_700_000_000 s = 2023-11-14T22:13:20Z → ×1000 = 1_700_000_000_000 ms.
const CREATED_S = 1_700_000_000;
const CREATED_MS = 1_700_000_000_000;
const UPDATED_S = 1_700_500_000;
const UPDATED_MS = 1_700_500_000_000;

function makeConversation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "123456",
    type: "conversation",
    state: "open",
    priority: "priority",
    open: true,
    read: false,
    source: {
      type: "conversation",
      subject: "Billing bug on the Pro plan invoice",
      body: "<p>The total on my <b>latest</b> invoice looks wrong</p>",
      author: {
        type: "user",
        id: "u_1",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    },
    admin_assignee_id: 9001,
    team_assignee_id: 7,
    tags: {
      type: "tag.list",
      tags: [
        { type: "tag", id: "t1", name: "billing" },
        { type: "tag", id: "t2", name: "urgent" },
      ],
    },
    contacts: {
      type: "contact.list",
      contacts: [
        { type: "contact", id: "c1" },
        { type: "contact", id: "c2" },
      ],
    },
    created_at: CREATED_S,
    updated_at: UPDATED_S,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapIntercomConversationToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapIntercomConversationToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapIntercomConversationToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapIntercomConversationToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or non-numeric", () => {
    const noId = makeConversation();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapIntercomConversationToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(
      mapIntercomConversationToItem(makeConversation({ id: "abc" }), { syncedAt: NOW }),
    ).toBeNull();
    expect(
      mapIntercomConversationToItem(makeConversation({ id: "" }), { syncedAt: NOW }),
    ).toBeNull();
  });

  test("accepts a numeric-string id and a number id", () => {
    const strId = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (strId === null) throw new Error("expected mapping to succeed");
    expect(strId.externalId).toBe("123456");

    const numId = mapIntercomConversationToItem(makeConversation({ id: 987 }), { syncedAt: NOW });
    if (numId === null) throw new Error("expected mapping to succeed");
    expect(numId.externalId).toBe("987");
  });

  test("service/type fixed; externalId is the stringified numeric id", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("intercom");
    expect(row.type).toBe("conversation");
    expect(row.externalId).toBe("123456");
  });

  test("title is the trimmed source subject when present", () => {
    const row = mapIntercomConversationToItem(
      makeConversation({ source: { subject: "  Hello world  " } }),
      {
        syncedAt: NOW,
      },
    );
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Hello world");
  });

  test("title falls back to `Conversation <id>` when subject missing/empty", () => {
    const noSubject = makeConversation();
    delete ((noSubject as Record<string, unknown>)["source"] as Record<string, unknown>)["subject"];
    const row = mapIntercomConversationToItem(noSubject, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Conversation 123456");

    const empty = mapIntercomConversationToItem(makeConversation({ source: { subject: "   " } }), {
      syncedAt: NOW,
    });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.title).toBe("Conversation 123456");

    const noSource = makeConversation();
    delete (noSource as Record<string, unknown>)["source"];
    const bare = mapIntercomConversationToItem(noSource, { syncedAt: NOW });
    if (bare === null) throw new Error("expected mapping to succeed");
    expect(bare.title).toBe("Conversation 123456");
  });

  test("bodyPreview is the HTML-stripped source body", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("The total on my latest invoice looks wrong");
  });

  test("bodyPreview falls back to the state label, then the title", () => {
    const noBody = makeConversation({
      source: { subject: "Subj", author: { name: "x" } },
    });
    const onState = mapIntercomConversationToItem(noBody, { syncedAt: NOW });
    if (onState === null) throw new Error("expected mapping to succeed");
    expect(onState.bodyPreview).toBe("open");

    const noBodyNoState = makeConversation({
      state: "",
      source: { subject: "Subj only" },
    });
    const onTitle = mapIntercomConversationToItem(noBodyNoState, { syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe("Subj only");
  });

  test("epoch-seconds → ms conversion: created_at/updated_at × 1000", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBe(CREATED_MS);
    expect(meta(row)["created_at"]).toBe(CREATED_S * 1000);
    expect(meta(row)["updated_at"]).toBe(UPDATED_MS);
  });

  test("modifiedAt prefers updated_at, then created_at, then syncedAt", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(UPDATED_MS);

    const noUpdated = makeConversation();
    delete (noUpdated as Record<string, unknown>)["updated_at"];
    const onCreated = mapIntercomConversationToItem(noUpdated, { syncedAt: NOW });
    if (onCreated === null) throw new Error("expected mapping to succeed");
    expect(onCreated.modifiedAt).toBe(CREATED_MS);

    const noTimes = makeConversation();
    delete (noTimes as Record<string, unknown>)["updated_at"];
    delete (noTimes as Record<string, unknown>)["created_at"];
    const fallback = mapIntercomConversationToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["created_at"]).toBeNull();
    expect(meta(fallback)["updated_at"]).toBeNull();
  });

  test("created_at/updated_at of 0 maps to null (unset)", () => {
    const row = mapIntercomConversationToItem(makeConversation({ created_at: 0, updated_at: 0 }), {
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["created_at"]).toBeNull();
    expect(meta(row)["updated_at"]).toBeNull();
    expect(row.modifiedAt).toBe(NOW);
  });

  test("canonicalUrl/url is always null", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBeNull();
    expect(row.url).toBeNull();
    expect(meta(row)["canonical_url"]).toBeNull();
  });

  test("contact_ids are the contact id array (defensive)", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["contact_ids"]).toEqual(["c1", "c2"]);

    const numericContacts = makeConversation({
      contacts: { contacts: [{ id: 11 }, { id: "c3" }, null, { noid: 1 }] },
    });
    const r2 = mapIntercomConversationToItem(numericContacts, { syncedAt: NOW });
    if (r2 === null) throw new Error("expected mapping to succeed");
    expect(meta(r2)["contact_ids"]).toEqual(["11", "c3"]);
  });

  test("tags are the tag-name array (defensive over non-object entries)", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["tags"]).toEqual(["billing", "urgent"]);

    const messyTags = makeConversation({ tags: { tags: [null, 7, { name: "ops" }, { id: 1 }] } });
    const r2 = mapIntercomConversationToItem(messyTags, { syncedAt: NOW });
    if (r2 === null) throw new Error("expected mapping to succeed");
    expect(meta(r2)["tags"]).toEqual(["ops"]);

    const noTags = makeConversation();
    delete (noTags as Record<string, unknown>)["tags"];
    const r3 = mapIntercomConversationToItem(noTags, { syncedAt: NOW });
    if (r3 === null) throw new Error("expected mapping to succeed");
    expect(meta(r3)["tags"]).toEqual([]);
  });

  test("assignee_id prefers admin_assignee_id, else nested assignee.id", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["assignee_id"]).toBe(9001);
    expect(meta(row)["team_assignee_id"]).toBe(7);

    const nested = makeConversation();
    delete (nested as Record<string, unknown>)["admin_assignee_id"];
    (nested as Record<string, unknown>)["assignee"] = { id: 4242, type: "admin" };
    const r2 = mapIntercomConversationToItem(nested, { syncedAt: NOW });
    if (r2 === null) throw new Error("expected mapping to succeed");
    expect(meta(r2)["assignee_id"]).toBe(4242);

    const none = makeConversation();
    delete (none as Record<string, unknown>)["admin_assignee_id"];
    delete (none as Record<string, unknown>)["team_assignee_id"];
    const r3 = mapIntercomConversationToItem(none, { syncedAt: NOW });
    if (r3 === null) throw new Error("expected mapping to succeed");
    expect(meta(r3)["assignee_id"]).toBeNull();
    expect(meta(r3)["team_assignee_id"]).toBeNull();
  });

  test("open/read booleans flow through; null when missing/non-boolean", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["open"]).toBe(true);
    expect(meta(row)["read"]).toBe(false);

    const sparse = makeConversation();
    delete (sparse as Record<string, unknown>)["open"];
    (sparse as Record<string, unknown>)["read"] = "nope";
    const r2 = mapIntercomConversationToItem(sparse, { syncedAt: NOW });
    if (r2 === null) throw new Error("expected mapping to succeed");
    expect(meta(r2)["open"]).toBeNull();
    expect(meta(r2)["read"]).toBeNull();
  });

  test("full metadata flows through", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["conversation_id"]).toBe("123456");
    expect(m["title"]).toBe("Billing bug on the Pro plan invoice");
    expect(m["state"]).toBe("open");
    expect(m["priority"]).toBe("priority");
    expect(m["source_type"]).toBe("conversation");
    expect(m["source_subject"]).toBe("Billing bug on the Pro plan invoice");
    expect(m["source_author_name"]).toBe("Ada Lovelace");
    expect(m["source_author_email"]).toBe("ada@example.com");
  });

  test("missing source fields are null-passthrough in metadata", () => {
    const noSource = makeConversation();
    delete (noSource as Record<string, unknown>)["source"];
    delete (noSource as Record<string, unknown>)["priority"];
    const row = mapIntercomConversationToItem(noSource, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["source_type"]).toBeNull();
    expect(m["source_subject"]).toBeNull();
    expect(m["source_author_name"]).toBeNull();
    expect(m["source_author_email"]).toBeNull();
    expect(m["priority"]).toBeNull();
  });

  test("syncedAt propagates", () => {
    const row = mapIntercomConversationToItem(makeConversation(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("stripHtml", () => {
  test("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello   <b>world</b></p>")).toBe("Hello world");
    expect(stripHtml("<div>\n  line one\n  line two\n</div>")).toBe("line one line two");
  });

  test("returns empty for non-strings and empty/whitespace-only input", () => {
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml(null)).toBe("");
    expect(stripHtml(42)).toBe("");
    expect(stripHtml("")).toBe("");
    expect(stripHtml("<br/>")).toBe("");
  });

  test("plain text is returned trimmed and unchanged", () => {
    expect(stripHtml("  plain text  ")).toBe("plain text");
  });
});
