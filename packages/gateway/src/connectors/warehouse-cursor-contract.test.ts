// packages/gateway/src/connectors/warehouse-cursor-contract.test.ts
import { describe, expect, test } from "bun:test";
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";
import { drainPagedList } from "./connector-list-page.ts";

function pagedSession(
  pages: { items: unknown[]; nextCursor: string | null }[],
): ConnectorToolSession {
  return {
    call: (_toolId, args) => {
      const { cursor } = args as { cursor: string | null };
      const idx = cursor === null ? 0 : Number.parseInt(cursor, 10);
      const page = pages[idx] ?? { items: [], nextCursor: null };
      return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(page) }] });
    },
  };
}

describe("warehouse paged-list cursor contract", () => {
  test("drains multiple pages and stops on nextCursor=null", async () => {
    const items = await drainPagedList(
      pagedSession([
        { items: [{ id: 1 }, { id: 2 }], nextCursor: "1" },
        { items: [{ id: 3 }], nextCursor: null },
      ]),
      "tableau_list",
    );
    expect(items).toHaveLength(3);
  });

  test("a single short page returns immediately", async () => {
    const items = await drainPagedList(
      pagedSession([{ items: [{ id: 1 }], nextCursor: null }]),
      "powerbi_list",
    );
    expect(items).toHaveLength(1);
  });

  test("an empty first page yields nothing", async () => {
    const items = await drainPagedList(
      pagedSession([{ items: [], nextCursor: null }]),
      "bigeye_list",
    );
    expect(items).toHaveLength(0);
  });
});
