import { describe, expect, test } from "bun:test";

import { mapIntercomConversationToItem, stripHtml } from "./intercom-conversation-mapping.ts";

const ctx = { syncedAt: 123 };

describe("stripHtml", () => {
  test("replaces tags with spaces and collapses whitespace; non-strings are empty", () => {
    expect(stripHtml("<p>Hello</p>\n<b> world </b>")).toBe("Hello world");
    expect(stripHtml(5)).toBe("");
  });
});

describe("mapIntercomConversationToItem", () => {
  test("maps a full conversation", () => {
    const row = mapIntercomConversationToItem(
      {
        id: 77,
        state: "open",
        priority: "priority",
        open: true,
        read: false,
        admin_assignee_id: 9,
        team_assignee_id: 3,
        created_at: 10,
        updated_at: 20,
        source: {
          type: "email",
          subject: "  Help me  ",
          body: "<p>It <b>broke</b></p>",
          author: { name: "Ada", email: "a@x.io" },
        },
        contacts: { contacts: [{ id: "c1" }, { id: 2 }, { id: "" }, "junk", { id: Number.NaN }] },
        tags: { tags: [{ name: "vip" }, { name: "" }, 4] },
      },
      ctx,
    );
    expect(row?.externalId).toBe("77");
    expect(row?.title).toBe("Help me");
    expect(row?.bodyPreview).toBe("It broke");
    expect(row?.modifiedAt).toBe(20_000);
    expect(row?.metadata).toMatchObject({
      assignee_id: 9,
      team_assignee_id: 3,
      contact_ids: ["c1", "2"],
      tags: ["vip"],
      source_author_email: "a@x.io",
    });
  });

  test("a string id that is numeric is accepted; others are rejected", () => {
    expect(mapIntercomConversationToItem({ id: "123" }, ctx)?.externalId).toBe("123");
    expect(mapIntercomConversationToItem({ id: "abc" }, ctx)).toBeNull();
    expect(mapIntercomConversationToItem({ id: "" }, ctx)).toBeNull();
    expect(mapIntercomConversationToItem({}, ctx)).toBeNull();
    expect(mapIntercomConversationToItem(null, ctx)).toBeNull();
  });

  test("with no subject or body the title and preview fall back to the id and state", () => {
    const row = mapIntercomConversationToItem({ id: 5, state: "closed" }, ctx);
    expect(row?.title).toBe("Conversation 5");
    expect(row?.bodyPreview).toBe("closed");
    expect(row?.modifiedAt).toBe(123);
    const noState = mapIntercomConversationToItem({ id: 6, state: "", created_at: 4 }, ctx);
    expect(noState?.bodyPreview).toBe("Conversation 6");
    expect(noState?.modifiedAt).toBe(4_000);
  });

  test("the assignee falls back from the admin id to the nested assignee, string or number", () => {
    expect(
      mapIntercomConversationToItem({ id: 1, assignee: { id: 8 } }, ctx)?.metadata["assignee_id"],
    ).toBe(8);
    expect(
      mapIntercomConversationToItem({ id: 1, assignee: { id: "a8" } }, ctx)?.metadata[
        "assignee_id"
      ],
    ).toBe("a8");
    expect(mapIntercomConversationToItem({ id: 1 }, ctx)?.metadata["assignee_id"]).toBeNull();
  });

  test("malformed contact and tag containers yield empty lists", () => {
    const row = mapIntercomConversationToItem(
      { id: 1, contacts: { contacts: "x" }, tags: "y" },
      ctx,
    );
    expect(row?.metadata["contact_ids"]).toEqual([]);
    expect(row?.metadata["tags"]).toEqual([]);
  });
});
