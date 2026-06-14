import type { ConnectorToolSession } from "../teamvault/connector-session.ts";

export interface ListPage {
  readonly items: unknown[];
  readonly nextCursor: string | null;
}

export const DEFAULT_LIST_PAGE_SIZE = 200;
/** Hard backstop against a misbehaving cursor that never terminates. */
const MAX_PAGES = 1000;

function extractMcpText(result: unknown): string {
  if (result !== null && typeof result === "object") {
    const content = (result as Record<string, unknown>)["content"];
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as Record<string, unknown>;
      if (typeof first["text"] === "string") return first["text"];
    }
  }
  throw new Error("connector list: unexpected MCP tool result shape");
}

export function parseMcpListPage(result: unknown): ListPage {
  const parsed = JSON.parse(extractMcpText(result)) as Record<string, unknown>;
  const items = Array.isArray(parsed["items"]) ? parsed["items"] : [];
  const nextCursor = typeof parsed["nextCursor"] === "string" ? parsed["nextCursor"] : null;
  return { items, nextCursor };
}

/** Drain a paginated `<svc>_list` tool over one session, following nextCursor to exhaustion. */
export async function drainPagedList(
  session: ConnectorToolSession,
  listToolId: string,
  pageSize: number = DEFAULT_LIST_PAGE_SIZE,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await session.call(listToolId, { cursor, limit: pageSize });
    const { items: pageItems, nextCursor } = parseMcpListPage(res);
    items.push(...pageItems);
    if (nextCursor === null || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return items;
}
