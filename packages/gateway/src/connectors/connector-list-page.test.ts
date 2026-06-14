import { describe, expect, it } from "bun:test";
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";
import { drainPagedList, parseMcpListPage } from "./connector-list-page.ts";

function envelope(data: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

describe("parseMcpListPage", () => {
  it("unwraps the MCP text envelope into { items, nextCursor }", () => {
    const page = parseMcpListPage(envelope({ items: [{ id: 1 }], nextCursor: "2" }));
    expect(page).toEqual({ items: [{ id: 1 }], nextCursor: "2" });
  });

  it("defaults missing/invalid fields to [] and null", () => {
    expect(parseMcpListPage(envelope({}))).toEqual({ items: [], nextCursor: null });
  });

  it("throws on a non-MCP shape", () => {
    expect(() => parseMcpListPage({ nope: true })).toThrow(/unexpected MCP tool result/);
  });
});

describe("drainPagedList", () => {
  it("follows nextCursor until null, aggregating items, passing limit", async () => {
    const pages: Record<string, unknown> = {
      null: envelope({ items: [{ id: 1 }, { id: 2 }], nextCursor: "p2" }),
      p2: envelope({ items: [{ id: 3 }], nextCursor: null }),
    };
    const seen: Array<{ cursor: string | null; limit: number }> = [];
    const session: ConnectorToolSession = {
      call: async (_toolId, args) => {
        const a = args as { cursor: string | null; limit: number };
        seen.push(a);
        return pages[a.cursor === null ? "null" : a.cursor];
      },
    };
    const items = await drainPagedList(session, "snowflake_list", 200);
    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(seen).toEqual([
      { cursor: null, limit: 200 },
      { cursor: "p2", limit: 200 },
    ]);
  });

  it("stops at a safety page cap to avoid an infinite cursor loop", async () => {
    const session: ConnectorToolSession = {
      call: async () => ({
        content: [
          { type: "text", text: JSON.stringify({ items: [{ id: 1 }], nextCursor: "same" }) },
        ],
      }),
    };
    const items = await drainPagedList(session, "snowflake_list", 200);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(200 * 1000);
  });
});
