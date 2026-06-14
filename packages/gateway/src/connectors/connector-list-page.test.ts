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

  it("throws with a connector-blaming message on malformed JSON", () => {
    const badEnvelope = { content: [{ type: "text", text: "not json{" }] };
    expect(() => parseMcpListPage(badEnvelope)).toThrow(/malformed JSON/);
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

  it("terminates on a non-advancing cursor (same nextCursor twice)", async () => {
    const session: ConnectorToolSession = {
      call: async () => ({
        content: [
          { type: "text", text: JSON.stringify({ items: [{ id: 1 }], nextCursor: "same" }) },
        ],
      }),
    };
    const items = await drainPagedList(session, "snowflake_list", 200);
    // First call: cursor null → "same"; second call: "same" === cursor → break.
    // Two pages fetched, each returns one item.
    expect(items).toEqual([{ id: 1 }, { id: 1 }]);
  });

  it("stops at MAX_PAGES (1000) and warns on stderr when the cursor always advances", async () => {
    let callCount = 0;
    const session: ConnectorToolSession = {
      call: async (_toolId, args) => {
        const page = callCount;
        callCount += 1;
        const a = args as { cursor: string | null };
        const nextPage = a.cursor === null ? 1 : Number(a.cursor) + 1;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ items: [{ page }], nextCursor: String(nextPage) }),
            },
          ],
        };
      },
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    let warned = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warned += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const items = await drainPagedList(session, "snowflake_list", 1);
      expect(callCount).toBe(1000);
      expect(items.length).toBe(1000);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(warned).toContain("hit the 1000-page drain cap");
    expect(warned).toContain("snowflake_list");
  });

  it("does NOT warn when the list drains normally (nextCursor reaches null)", async () => {
    const session: ConnectorToolSession = {
      call: async () => ({
        content: [{ type: "text", text: JSON.stringify({ items: [{ id: 1 }], nextCursor: null }) }],
      }),
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    let warned = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warned += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await drainPagedList(session, "snowflake_list", 200);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(warned).toBe("");
  });
});
