import { describe, expect, test } from "bun:test";

import { filterIntercomConversations } from "../src/search-filter.ts";

function conversation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "123456",
    type: "conversation",
    state: "open",
    priority: "priority",
    read: true,
    source: {
      type: "conversation",
      subject: "Billing bug on the Pro plan invoice",
      body: "<p>The total on my latest invoice looks wrong</p>",
      author: {
        type: "user",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    },
    tags: {
      type: "tag.list",
      tags: [
        { type: "tag", id: "t1", name: "billing" },
        { type: "tag", id: "t2", name: "urgent" },
      ],
    },
    contacts: { type: "contact.list", contacts: [{ type: "contact", id: "c1" }] },
    created_at: 1_700_000_000,
    updated_at: 1_700_500_000,
    ...over,
  };
}

describe("filterIntercomConversations", () => {
  test("matches against the conversation subject (case-insensitive)", () => {
    expect(filterIntercomConversations([conversation()], { query: "billing bug" })).toHaveLength(1);
    expect(filterIntercomConversations([conversation()], { query: "BILLING BUG" })).toHaveLength(1);
  });

  test("matches against source body, state, author name+email, and tags", () => {
    expect(
      filterIntercomConversations([conversation()], { query: "invoice looks wrong" }),
    ).toHaveLength(1);
    expect(filterIntercomConversations([conversation()], { query: "open" })).toHaveLength(1);
    expect(filterIntercomConversations([conversation()], { query: "Ada Lovelace" })).toHaveLength(
      1,
    );
    expect(
      filterIntercomConversations([conversation()], { query: "ada@example.com" }),
    ).toHaveLength(1);
    expect(filterIntercomConversations([conversation()], { query: "urgent" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterIntercomConversations([conversation()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the contact id (not in the haystack)", () => {
    expect(filterIntercomConversations([conversation()], { query: "c1" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(
      filterIntercomConversations([null, 42, "x", conversation()], { query: "billing" }),
    ).toHaveLength(1);
  });

  test("tolerates a missing source object and non-object tag entries", () => {
    const sparse = conversation();
    delete sparse["source"];
    sparse["tags"] = { tags: [null, 7, { name: "ops" }, "x"] };
    expect(filterIntercomConversations([sparse], { query: "open" })).toHaveLength(1);
    expect(filterIntercomConversations([sparse], { query: "ops" })).toHaveLength(1);
    expect(filterIntercomConversations([sparse], { query: "billing bug" })).toHaveLength(0);
  });

  test("tolerates a missing tags object", () => {
    const noTags = conversation();
    delete noTags["tags"];
    expect(filterIntercomConversations([noTags], { query: "billing bug" })).toHaveLength(1);
    expect(filterIntercomConversations([noTags], { query: "urgent" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => conversation({ id: String(i) }));
    expect(filterIntercomConversations(many, { query: "billing bug", limit: 3 })).toHaveLength(3);
  });
});
