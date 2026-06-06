import { describe, expect, test } from "bun:test";

import { filterZendeskTickets } from "../src/search-filter.ts";

function ticket(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12345,
    subject: "Checkout button unresponsive on Safari",
    description: "Customer reports the checkout button does nothing on Safari 17",
    status: "open",
    priority: "high",
    type: "incident",
    tags: ["checkout", "safari"],
    requester_id: 901,
    assignee_id: 42,
    created_at: "2024-03-01T12:00:00Z",
    updated_at: "2024-03-02T08:00:00Z",
    ...over,
  };
}

describe("filterZendeskTickets", () => {
  test("matches against ticket subject (case-insensitive)", () => {
    expect(filterZendeskTickets([ticket()], { query: "checkout button" })).toHaveLength(1);
    expect(filterZendeskTickets([ticket()], { query: "CHECKOUT BUTTON" })).toHaveLength(1);
  });

  test("matches against description, status, priority, type, and tags", () => {
    expect(filterZendeskTickets([ticket()], { query: "safari 17" })).toHaveLength(1);
    expect(filterZendeskTickets([ticket()], { query: "open" })).toHaveLength(1);
    expect(filterZendeskTickets([ticket()], { query: "high" })).toHaveLength(1);
    expect(filterZendeskTickets([ticket()], { query: "incident" })).toHaveLength(1);
    expect(filterZendeskTickets([ticket()], { query: "checkout" })).toHaveLength(1);
    expect(filterZendeskTickets([ticket()], { query: "safari" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterZendeskTickets([ticket()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the requester/assignee ids (not in the haystack)", () => {
    expect(filterZendeskTickets([ticket()], { query: "901" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterZendeskTickets([null, 42, "x", ticket()], { query: "checkout" })).toHaveLength(1);
  });

  test("tolerates missing string fields and non-string tags", () => {
    const sparse = ticket();
    delete sparse["description"];
    delete sparse["priority"];
    sparse["tags"] = [null, 7, "billing"];
    expect(filterZendeskTickets([sparse], { query: "checkout button" })).toHaveLength(1);
    expect(filterZendeskTickets([sparse], { query: "billing" })).toHaveLength(1);
    expect(filterZendeskTickets([sparse], { query: "safari 17" })).toHaveLength(0);
  });

  test("tolerates a missing tags array", () => {
    const noTags = ticket();
    delete noTags["tags"];
    expect(filterZendeskTickets([noTags], { query: "checkout button" })).toHaveLength(1);
    expect(filterZendeskTickets([noTags], { query: "safari" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => ticket({ id: i }));
    expect(filterZendeskTickets(many, { query: "checkout button", limit: 3 })).toHaveLength(3);
  });
});
