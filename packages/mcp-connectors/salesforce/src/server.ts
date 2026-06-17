import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterSalesforceOpportunities } from "./search-filter.ts";

const API_VERSION = "v60.0";
const OPPORTUNITY_FIELDS =
  "Id, Name, StageName, Amount, CloseDate, Probability, Type, IsClosed, IsWon, LastModifiedDate, CreatedDate";

function accessToken(): string {
  const t = process.env["SALESFORCE_ACCESS_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SALESFORCE_ACCESS_TOKEN is not set");
  }
  return t;
}

function instanceUrl(): string {
  let raw = process.env["SALESFORCE_INSTANCE_URL"]?.trim();
  if (raw === undefined || raw === "") {
    throw new Error("SALESFORCE_INSTANCE_URL is not set");
  }
  // Strip trailing slashes without a backtracking regex.
  while (raw.endsWith("/")) {
    raw = raw.slice(0, -1);
  }
  return raw;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${accessToken()}`, Accept: "application/json" };
}

async function salesforceGet(path: string): Promise<unknown> {
  const res = await fetch(`${instanceUrl()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Salesforce ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function recordsFrom(root: unknown): unknown[] {
  const records = (root as { records?: unknown } | null)?.records;
  return Array.isArray(records) ? records : [];
}

function listQueryPath(limit: number): string {
  const soql = `SELECT ${OPPORTUNITY_FIELDS} FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT ${String(limit)}`;
  return `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
}

await runReadOnlyMcpConnector("nimbus-salesforce", (reg) => {
  reg(
    "salesforce_list",
    "List the authenticated org's Salesforce Opportunities via the SOQL query API (GET <instance_url>/services/data/v60.0/query?q=SELECT ... FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT N). Returns the { totalSize, done, records: [...], nextRecordsUrl? } envelope — `records` holds the Opportunity objects, each shaped { Id, Name, StageName, Amount, CloseDate, Probability, Type, IsClosed, IsWon, LastModifiedDate, CreatedDate }. `limit` (default 200) caps the single first-page request; when `done` is false a `nextRecordsUrl` cursor is present for the next page (the local Nimbus index has full coverage).",
    z.object({
      limit: z.number().int().min(1).max(2000).optional(),
    }),
    async (p) => {
      return jsonResult(await salesforceGet(listQueryPath(p.limit ?? 200)));
    },
  );

  reg(
    "salesforce_get",
    "Fetch one Salesforce Opportunity by its 15- or 18-character Id (GET <instance_url>/services/data/v60.0/sobjects/Opportunity/<id>). Returns the Opportunity object directly (NOT wrapped in `records`). Throws when no Opportunity with that id exists or is accessible.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(
        await salesforceGet(
          `/services/data/${API_VERSION}/sobjects/Opportunity/${encodeURIComponent(p.id)}`,
        ),
      );
    },
  );

  reg(
    "salesforce_search",
    "**Substring search over the FIRST PAGE only** (up to the queried limit of most-recently-modified Opportunities) of the authenticated org's Salesforce Opportunities. This tool runs the SOQL query once and matches the query locally (case-insensitive) against each opportunity's name, stage, and type. **Opportunities beyond the first page are not searchable here — query the local Nimbus index instead for full coverage.** Returns a { matches: [...] } envelope.",
    searchToolInputSchema(2000),
    async (p) => {
      const root = await salesforceGet(listQueryPath(2000));
      const matches = filterSalesforceOpportunities(recordsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
