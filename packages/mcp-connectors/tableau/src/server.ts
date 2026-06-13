import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

function tableauUrl(): string {
  const v = process.env["TABLEAU_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("TABLEAU_URL is not set");
  }
  return v;
}

function authHeader(): Record<string, string> {
  const tok = process.env["TABLEAU_TOKEN"]?.trim();
  if (tok === undefined || tok === "") {
    throw new Error("TABLEAU_TOKEN is not set");
  }
  return { "X-Tableau-Auth": tok, Accept: "application/json" };
}

interface ViewRow {
  luid: string;
  name: string;
  owner: string | null;
}

async function signin(): Promise<{ token: string; siteId: string }> {
  const patName = process.env["TABLEAU_PAT_NAME"]?.trim();
  const patSecret = process.env["TABLEAU_PAT_SECRET"]?.trim();
  if (patName === undefined || patName === "" || patSecret === undefined || patSecret === "") {
    throw new Error("TABLEAU_PAT_NAME and TABLEAU_PAT_SECRET are required");
  }
  const url = `${tableauUrl()}/api/3.4/auth/signin`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      credentials: {
        personalAccessTokenName: patName,
        personalAccessTokenSecret: patSecret,
        site: { contentUrl: "" },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tableau signin ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text) as {
    credentials?: { token?: string; site?: { id?: string } };
  };
  const token = body.credentials?.token;
  const siteId = body.credentials?.site?.id;
  if (token === undefined || siteId === undefined) {
    throw new Error("Tableau signin: missing token or site id in response");
  }
  return { token, siteId };
}

async function fetchViews(): Promise<ViewRow[]> {
  const { token, siteId } = await signin();
  const url = `${tableauUrl()}/api/3.4/sites/${siteId}/views`;
  const res = await fetch(url, { headers: { ...authHeader(), "X-Tableau-Auth": token } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tableau views ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text) as {
    views?: { view?: Array<{ luid?: string; name?: string; owner?: { name?: string } }> };
  };
  const rows: ViewRow[] = [];
  for (const v of body.views?.view ?? []) {
    if (v.luid === undefined || v.luid === "") continue;
    rows.push({
      luid: v.luid,
      name: v.name ?? "",
      owner: v.owner?.name ?? null,
    });
  }
  return rows;
}

function matchesQuery(view: ViewRow, query: string): boolean {
  const q = query.toLowerCase();
  return view.name.toLowerCase().includes(q) || view.luid.toLowerCase().includes(q);
}

await runReadOnlyMcpConnector("nimbus-tableau", (reg) => {
  reg(
    "tableau_list",
    "List Tableau views/dashboards. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const views = await fetchViews();
      const cap = p.limit ?? 200;
      return jsonResult({ items: views.slice(0, cap) });
    },
  );

  reg(
    "tableau_get",
    "Fetch one Tableau view by its luid. Throws when the view is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const views = await fetchViews();
      const found = views.find((v) => v.luid === p.id);
      if (found === undefined) {
        throw new Error(`Tableau view not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "tableau_search",
    "Substring search across Tableau views. Matches the query (case-insensitive) against view name and luid. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const views = await fetchViews();
      const matches = views.filter((v) => matchesQuery(v, p.query)).slice(0, p.limit ?? 50);
      return jsonResult({ matches });
    },
  );
});
