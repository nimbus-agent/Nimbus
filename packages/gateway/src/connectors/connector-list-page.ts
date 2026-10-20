import type { ConnectorToolSession } from "../teamvault/connector-session.ts";
import { extractMcpToolText } from "./_lib/mcp-tool-result.ts";

export interface ListPage {
  readonly items: unknown[];
  readonly nextCursor: string | null;
}

export const DEFAULT_LIST_PAGE_SIZE = 200;
/** Hard backstop against a misbehaving cursor that never terminates. */
const MAX_PAGES = 1000;

/** A generous per-page ceiling so the shared extractor is total here; not a tuned limit. */
const LIST_PAGE_MAX_BYTES = 64 * 1024 * 1024;

function extractMcpText(result: unknown): string {
  return extractMcpToolText(result, LIST_PAGE_MAX_BYTES);
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
