import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterMendeleyDocuments } from "./search-filter.ts";

const BASE = "https://api.mendeley.com";
const DOC_ACCEPT = "application/vnd.mendeley-document.1+json";

function accessToken(): string {
  const t = process.env["MENDELEY_ACCESS_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("MENDELEY_ACCESS_TOKEN is not set");
  }
  return t;
}

async function mendeleyGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken()}`, Accept: DOC_ACCEPT },
  });
  const text = await res.text();
  if (!res.ok) {
    // Include the HTTP status so an expired token (401) surfaces explicitly to the
    // gateway client; matches the zotero server's error shape.
    throw new Error(`Mendeley ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-mendeley", (reg) => {
  reg(
    "mendeley_list",
    "List the user's Mendeley library documents (`GET /documents?view=all&limit=100`). Returns the raw JSON array of document objects — each is `{ id, title, type, authors, year, source, identifiers: { doi, ... }, keywords, abstract, last_modified, websites, ... }`.",
    z.object({}),
    async () => {
      return jsonResult(await mendeleyGet(`/documents?view=all&limit=100`));
    },
  );

  reg(
    "mendeley_get",
    "Fetch one Mendeley document by its id (`GET /documents/{id}?view=all`). Returns the document object directly (NOT wrapped in an array). Throws when no match is found.",
    z.object({ id: z.string().min(1) }),
    async (p) => {
      return jsonResult(await mendeleyGet(`/documents/${encodeURIComponent(p.id)}?view=all`));
    },
  );

  reg(
    "mendeley_search",
    "Substring search across the first page of the user's library documents. Matches the query against the title, document type, abstract, source, DOI, formatted author names, and keywords (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
    async (p) => {
      const root = await mendeleyGet(`/documents?view=all&limit=100`);
      const matches = Array.isArray(root)
        ? filterMendeleyDocuments(root, { query: p.query, limit: p.limit })
        : [];
      return jsonResult({ matches });
    },
  );
});
