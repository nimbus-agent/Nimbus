import { z } from "zod";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterDagsterJobs } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["DAGSTER_BASE_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("DAGSTER_BASE_URL is not set");
  }
  return trimTrailingSlash(v);
}

function apiToken(): string {
  // Required for Dagster Cloud; self-hosted OSS may use a placeholder. The
  // gateway injects it regardless to keep spawn wiring uniform.
  const v = process.env["DAGSTER_API_TOKEN"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("DAGSTER_API_TOKEN is not set");
  }
  return v;
}

const JOBS_QUERY = `
query NimbusJobs {
  repositoriesOrError {
    __typename
    ... on RepositoryConnection {
      nodes {
        name
        location { name }
        pipelines { id name description isJob tags { key value } }
      }
    }
    ... on PythonError { message }
  }
}
`;

async function dagsterGraphql<T>(query: string): Promise<T> {
  const res = await fetch(`${apiBase()}/graphql`, {
    method: "POST",
    headers: {
      "Dagster-Cloud-Api-Token": apiToken(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Dagster ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { data?: T; errors?: unknown };
  if (parsed.errors !== undefined) {
    throw new Error(`Dagster GraphQL error: ${JSON.stringify(parsed.errors).slice(0, 400)}`);
  }
  if (parsed.data === undefined) {
    throw new Error("Dagster GraphQL: response missing `data` field");
  }
  return parsed.data;
}

interface FlatJob {
  name: string;
  repository: string;
  location: string | null;
  id: string | null;
  description: string | null;
  isJob: boolean;
  tags: Array<{ key: string; value: string }>;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function tagPairs(raw: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ key: string; value: string }> = [];
  for (const t of raw) {
    const tr = asRecord(t);
    if (tr === undefined) {
      continue;
    }
    const key = str(tr, "key");
    if (key === null) {
      continue;
    }
    out.push({ key, value: str(tr, "value") ?? "" });
  }
  return out;
}

function pipelinesOf(node: unknown): {
  repository: string;
  location: string | null;
  rows: unknown[];
} {
  const repo = asRecord(node);
  if (repo === undefined) {
    return { repository: "", location: null, rows: [] };
  }
  const locationRow = asRecord(repo["location"]);
  const pipelines = repo["pipelines"];
  return {
    repository: str(repo, "name") ?? "",
    location: locationRow === undefined ? null : str(locationRow, "name"),
    rows: Array.isArray(pipelines) ? pipelines : [],
  };
}

function pipelineToJob(p: unknown, repository: string, location: string | null): FlatJob | null {
  const pr = asRecord(p);
  if (pr === undefined) {
    return null;
  }
  const name = str(pr, "name");
  if (name === null) {
    return null;
  }
  return {
    name,
    repository,
    location,
    id: str(pr, "id"),
    description: str(pr, "description"),
    isJob: pr["isJob"] === true,
    tags: tagPairs(pr["tags"]),
  };
}

function flattenJobs(data: unknown): FlatJob[] {
  const root = asRecord(data) ?? {};
  const repos = asRecord(root["repositoriesOrError"]) ?? {};
  if (repos["__typename"] === "PythonError") {
    const message = str(repos, "message") ?? "unknown error";
    throw new Error(`Dagster repositoriesOrError PythonError: ${message}`);
  }
  const nodes = repos["nodes"];
  if (!Array.isArray(nodes)) {
    return [];
  }
  const out: FlatJob[] = [];
  for (const node of nodes) {
    const { repository, location, rows } = pipelinesOf(node);
    for (const p of rows) {
      const job = pipelineToJob(p, repository, location);
      if (job !== null) {
        out.push(job);
      }
    }
  }
  return out;
}

async function listJobs(): Promise<FlatJob[]> {
  return flattenJobs(await dagsterGraphql<unknown>(JOBS_QUERY));
}

await runReadOnlyMcpConnector("nimbus-dagster", (reg) => {
  reg(
    "dagster_list",
    "List Dagster jobs. Walks the repositories catalog via a single GraphQL query (repositoriesOrError → nodes[].pipelines[]) against POST <base_url>/graphql and flattens to jobs, each carrying its repository and code location. Returns an { items: [...] } envelope.",
    z.object({
      limit: z.number().int().min(1).max(2000).optional(),
    }),
    async (p) => {
      const jobs = await listJobs();
      const limited = p.limit === undefined ? jobs : jobs.slice(0, p.limit);
      return jsonResult({ items: limited });
    },
  );

  reg(
    "dagster_get",
    "Fetch one Dagster job by its stable id. The id is either the full location:repository:jobName triple or just the bare jobName (the first match wins when only a name is given). Throws when no job matches.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const jobs = await listJobs();
      const match = jobs.find((j) => {
        const triple = `${j.location ?? "_"}:${j.repository}:${j.name}`;
        return triple === p.id || j.name === p.id;
      });
      if (match === undefined) {
        throw new Error(`Dagster: job ${p.id} not found`);
      }
      return jsonResult(match);
    },
  );

  reg(
    "dagster_search",
    "Substring search across Dagster jobs. Matches the query (case-insensitive) against the job name, repository, code location, description, and tag keys/values. Returns a { matches: [...] } envelope.",
    searchToolInputSchema(2000),
    async (p) => {
      const jobs = await listJobs();
      const matches = filterDagsterJobs(jobs, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
