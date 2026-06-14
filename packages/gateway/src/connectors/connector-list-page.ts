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
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractMcpText(result)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `connector list: malformed JSON in MCP response: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
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
  let exhausted = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await session.call(listToolId, { cursor, limit: pageSize });
    const { items: pageItems, nextCursor } = parseMcpListPage(res);
    items.push(...pageItems);
    if (nextCursor === null || nextCursor === cursor) {
      exhausted = true;
      break;
    }
    cursor = nextCursor;
  }
  if (!exhausted) {
    // Hit the MAX_PAGES backstop with the cursor still advancing: surface the cap on stderr rather
    // than silently returning a partial list (repo convention: no silent truncation).
    process.stderr.write(
      `connector list: "${listToolId}" hit the ${String(MAX_PAGES)}-page drain cap ` +
        `(${String(items.length)} items); result may be truncated\n`,
    );
  }
  return items;
}
