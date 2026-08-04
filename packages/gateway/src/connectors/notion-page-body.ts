import type { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const NOTION_VERSION = "2022-06-28";
const BLOCKS_URL = "https://api.notion.com/v1/blocks";
const PAGE_SIZE = 100;

/** Max block-children requests one sync pass may spend on bodies, across all pages. */
export const NOTION_BODY_FETCH_BUDGET_PER_SYNC = 200;

/**
 * Max block-children requests a SINGLE page may spend. Necessary because
 * recursion follows any `has_children` block, so one list-heavy page could
 * otherwise cost dozens of requests and dominate a whole pass.
 */
export const NOTION_BODY_REQUESTS_PER_PAGE_MAX = 10;

/**
 * Depth 1 is the page's own children. 3 covers the ordinary Notion shapes —
 * `toggle` → list → sub-list, `table` → `table_row`, two levels of bullets.
 * This is a cycle guard (a `synced_block` reference can in principle loop),
 * NOT the cost bound; `NOTION_BODY_REQUESTS_PER_PAGE_MAX` is that.
 */
const MAX_DEPTH = 3;

/** Separate items in their own right — following them would double-index. */
const NOT_FOLLOWED_BLOCK_TYPES: ReadonlySet<string> = new Set(["child_page", "child_database"]);

/**
 * `capped` is PERMANENT — the page will hit the same cap on every future pass,
 * so it must never be re-fetched. `errored` is TRANSIENT and must be. The
 * global budget deliberately cannot produce either: it is checked before a page
 * starts, never during it, so every started page can afford to finish.
 */
export type NotionPageBodyOutcome = "complete" | "capped" | "errored";

export type NotionPageBodyResult = {
  text: string;
  outcome: NotionPageBodyOutcome;
  bytes: number;
};

export type NotionBlockFetchDeps = {
  accessToken: string;
  rateLimiter: ProviderRateLimiter;
  /** Mutated in place: the caller reads `left` to decide whether to start the next page. */
  budget: { left: number };
};

export function notionRichTextToPlain(richText: unknown): string {
  if (!Array.isArray(richText)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of richText) {
    const r = asRecord(item);
    if (r === undefined) {
      continue;
    }
    const t = stringField(r, "plain_text");
    if (t !== undefined && t !== "") {
      parts.push(t);
    }
  }
  return parts.join("");
}

/** A `table_row` has no `rich_text` — its text is a 2-D array of rich-text arrays. */
function notionTableRowText(payload: Record<string, unknown>): string {
  const cells = payload["cells"];
  if (!Array.isArray(cells)) {
    return "";
  }
  return cells
    .map((cell) => notionRichTextToPlain(cell))
    .filter((t) => t !== "")
    .join(" | ");
}

/**
 * A block's text lives under a key named after its own `type`, but the shape
 * under that key varies: most blocks use `rich_text`, a `table_row` uses
 * `cells`, and media blocks (`image`, `file`, `video`, `bookmark`) carry only a
 * `caption`. A `rich_text`-only reader returns nothing for a page built around
 * a table — a common way to write exactly the glossary content we want.
 */
export function notionBlockOwnText(block: Record<string, unknown>): string {
  const type = stringField(block, "type");
  if (type === undefined) {
    return "";
  }
  const payload = asRecord(block[type]);
  if (payload === undefined) {
    return "";
  }
  if (type === "table_row") {
    return notionTableRowText(payload);
  }
  const own = notionRichTextToPlain(payload["rich_text"]);
  return own === "" ? notionRichTextToPlain(payload["caption"]) : own;
}

type WalkState = { used: number; bytes: number; capped: boolean };

type ChildrenPage = { results: unknown[]; nextCursor: string | undefined };

async function fetchChildrenPage(
  deps: NotionBlockFetchDeps,
  blockId: string,
  startCursor: string | undefined,
  state: WalkState,
): Promise<ChildrenPage> {
  const qs = new URLSearchParams({ page_size: String(PAGE_SIZE) });
  if (startCursor !== undefined && startCursor !== "") {
    qs.set("start_cursor", startCursor);
  }
  const res = await fetch(
    `${BLOCKS_URL}/${encodeURIComponent(blockId)}/children?${qs.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${deps.accessToken}`,
        "Notion-Version": NOTION_VERSION,
      },
    },
  );
  const text = await res.text();
  state.bytes += text.length;
  if (res.status === 429) {
    deps.rateLimiter.penalise("notion", 60_000);
    // Back off for the whole pass rather than spending the rest of the budget
    // rediscovering the same limit page by page.
    deps.budget.left = 0;
    throw new Error("Notion blocks: rate limited");
  }
  if (!res.ok) {
    throw new Error(`Notion blocks HTTP ${String(res.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Notion blocks: invalid JSON");
  }
  const root = asRecord(parsed);
  if (root === undefined) {
    throw new TypeError("Notion blocks: non-object root");
  }
  const results = root["results"];
  if (!Array.isArray(results)) {
    throw new TypeError("Notion blocks: missing results");
  }
  const next = stringField(root, "next_cursor");
  return {
    results,
    nextCursor: root["has_more"] === true && next !== undefined && next !== "" ? next : undefined,
  };
}

async function collectChildren(
  deps: NotionBlockFetchDeps,
  state: WalkState,
  blockId: string,
  depth: number,
  out: string[],
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    if (state.used >= NOTION_BODY_REQUESTS_PER_PAGE_MAX) {
      state.capped = true;
      return;
    }
    await deps.rateLimiter.acquire("notion");
    state.used += 1;
    deps.budget.left -= 1;
    const page = await fetchChildrenPage(deps, blockId, cursor, state);
    for (const raw of page.results) {
      const block = asRecord(raw);
      if (block === undefined) {
        continue;
      }
      const type = stringField(block, "type");
      if (type === undefined) {
        continue;
      }
      const own = notionBlockOwnText(block);
      if (own !== "") {
        out.push(own);
      }
      if (block["has_children"] !== true || NOT_FOLLOWED_BLOCK_TYPES.has(type)) {
        continue;
      }
      if (depth >= MAX_DEPTH) {
        state.capped = true;
        continue;
      }
      const childId = stringField(block, "id");
      if (childId === undefined || childId === "") {
        continue;
      }
      await collectChildren(deps, state, childId, depth + 1, out);
    }
    if (page.nextCursor === undefined) {
      return;
    }
    cursor = page.nextCursor;
  }
}

/**
 * Never throws. A failure returns whatever text was gathered with
 * `outcome: "errored"`, so the page still indexes with its title, URL, and
 * any partial text recovered before the failure — not worse than a page
 * that was never fetched. Note this is not "never worse" in every sense: a
 * page that previously held a COMPLETE body and is edited again will have
 * that stored body overwritten by the new, possibly-empty errored fetch —
 * the edit made the old body stale regardless, but the replacement text can
 * still read shorter than what was there a moment ago.
 */
export async function fetchNotionPageText(
  deps: NotionBlockFetchDeps,
  pageId: string,
): Promise<NotionPageBodyResult> {
  const state: WalkState = { used: 0, bytes: 0, capped: false };
  const out: string[] = [];
  try {
    await collectChildren(deps, state, pageId, 1, out);
  } catch {
    return { text: out.join("\n"), outcome: "errored", bytes: state.bytes };
  }
  return {
    text: out.join("\n"),
    outcome: state.capped ? "capped" : "complete",
    bytes: state.bytes,
  };
}
