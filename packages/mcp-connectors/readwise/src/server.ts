import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterReadwiseBooks, filterReadwiseHighlights } from "./search-filter.ts";

const BASE = "https://readwise.io";

function apiToken(): string {
  const t = process.env["READWISE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("READWISE_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Token ${apiToken()}`, Accept: "application/json" };
}

async function readwiseGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Readwise ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-readwise", (reg) => {
  reg(
    "readwise_list",
    "List the user's Readwise highlights (`GET /api/v2/highlights/?page_size=1000`). Returns the DRF `{ count, next, previous, results: [...] }` envelope — `results` holds the highlight objects and `next` is the next-page URL (null on the last page).",
    z.object({}),
    async () => {
      return jsonResult(await readwiseGet(`/api/v2/highlights/?page_size=1000`));
    },
  );

  reg(
    "readwise_get",
    "Fetch one Readwise highlight by its id (`GET /api/v2/highlights/{id}/`). Returns the highlight object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await readwiseGet(`/api/v2/highlights/${encodeURIComponent(p.id)}/`));
    },
  );

  reg(
    "readwise_search",
    "Substring search across the user's Readwise highlights (first page only). Matches the query against the highlight text, the user's note, color, location_type, and tag names (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await readwiseGet(`/api/v2/highlights/?page_size=1000`);
      const results = (root as { results?: unknown[] } | null)?.results;
      return matchesResult(results, filterReadwiseHighlights, p);
    },
  );

  reg(
    "readwise_books_list",
    "List the user's Readwise books/articles (`GET /api/v2/books/?page_size=1000`) — the parent records a highlight's `book_id` points at. Returns the same DRF `{ count, next, previous, results: [...] }` envelope as `readwise_list`; `results` holds the book objects (`id`, `title`, `author`, `category`, `source`, `num_highlights`, `highlights_url`, `source_url`, `asin`, `tags`, `document_note`).",
    z.object({}),
    async () => {
      return jsonResult(await readwiseGet(`/api/v2/books/?page_size=1000`));
    },
  );

  reg(
    "readwise_book_get",
    "Fetch one Readwise book/article by its id (`GET /api/v2/books/{id}/`). Note the id space is SEPARATE from the highlight id space — pass a highlight's `book_id`, not its `id`. Returns the book object directly. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await readwiseGet(`/api/v2/books/${encodeURIComponent(p.id)}/`));
    },
  );

  reg(
    "readwise_books_search",
    "Substring search across the user's Readwise books/articles (first page only). Matches the query against the title, author, category, source, the user's document note, and tag names (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await readwiseGet(`/api/v2/books/?page_size=1000`);
      const results = (root as { results?: unknown[] } | null)?.results;
      return matchesResult(results, filterReadwiseBooks, p);
    },
  );
});
