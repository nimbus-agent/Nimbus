/**
 * nimbus-mcp-mlflow — MLflow Model Registry API MCP server (read-only).
 * Credentials arrive as MLFLOW_HOST + MLFLOW_TOKEN env, injected at spawn
 * time. The MLflow API token is sent as `Authorization: Bearer <token>`.
 * MLflow has no universal SaaS host — each tracking server is a distinct
 * per-org URL, so there is no default for MLFLOW_HOST; it must be set.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterMlflowModels } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function apiBase(): string {
  const v = process.env["MLFLOW_HOST"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("MLFLOW_HOST is not set");
  }
  // Paths already include `/api/2.0/mlflow/...`, so the base is just the host.
  return trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const k = process.env["MLFLOW_TOKEN"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("MLFLOW_TOKEN is not set");
  }
  return { Authorization: `Bearer ${k}`, Accept: "application/json" };
}

async function mlflowGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MLflow ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

/** Pull the models array out of a registered-models/search response (`.registered_models`, else []). */
function modelsFrom(root: unknown): unknown[] {
  const models = (root as { registered_models?: unknown } | null)?.registered_models;
  return Array.isArray(models) ? models : [];
}

const mcp = new McpServer({ name: "nimbus-mlflow", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "mlflow_list",
  "List MLflow registered models (`GET /api/2.0/mlflow/registered-models/search`). Returns a single page; `limit` (1..100, default 100) caps the page size. Returns the raw `{ registered_models, next_page_token }` envelope.",
  z.object({
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const limit = p.limit ?? 100;
    const params = new URLSearchParams({ max_results: String(limit) });
    return jsonResult(
      await mlflowGet(`/api/2.0/mlflow/registered-models/search?${params.toString()}`),
    );
  },
);

reg(
  "mlflow_get",
  "Fetch one MLflow registered model by `name` (`GET /api/2.0/mlflow/registered-models/get?name={name}`). Throws when no registered model with that name exists.",
  z.object({
    name: z.string().min(1),
  }),
  async (p) => {
    const params = new URLSearchParams({ name: p.name });
    return jsonResult(
      await mlflowGet(`/api/2.0/mlflow/registered-models/get?${params.toString()}`),
    );
  },
);

reg(
  "mlflow_search",
  "Substring search across MLflow registered models. Matches the query (case-insensitive) against the model's `name`, `description`, and flattened `key=value` tags. Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const params = new URLSearchParams({ max_results: "100" });
    const root = await mlflowGet(`/api/2.0/mlflow/registered-models/search?${params.toString()}`);
    const matches = filterMlflowModels(modelsFrom(root), {
      query: p.query,
      limit: p.limit,
    });
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
