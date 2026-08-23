import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { joinApiPath } from "../../shared/join-api-path.ts";
import { parseCitationsJson } from "../../shared/kb-markdown.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  mcpJsonResultFromTextIfOk,
  parseJsonTextIfOk,
  putOptionalNonEmptyString,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import { buildNotionKbPageBody } from "./kb-append.ts";

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

async function notionFetch(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  const token = requireProcessEnv("NOTION_ACCESS_TOKEN");
  const url = joinApiPath(API, path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function richText(content: string): ReadonlyArray<Record<string, unknown>> {
  return [{ type: "text", text: { content: content.slice(0, 2000) } }];
}

const server = new McpServer({ name: "nimbus-notion", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING notion tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "notion",
  scopeEnv: "NIMBUS_MCP_NOTION_WRITE_SCOPE",
  scopeKinds: ["page", "database", "block"],
});

const notionSearchSchema = z.object({
  query: z.string().optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  startCursor: z.string().optional(),
});

function notionSearchPostBody(
  objectValue: "page" | "database",
  parsed: z.infer<typeof notionSearchSchema>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    filter: { property: "object", value: objectValue },
    page_size: parsed.pageSize ?? 50,
  };
  putOptionalNonEmptyString(body, "query", parsed.query);
  putOptionalNonEmptyString(body, "start_cursor", parsed.startCursor);
  return body;
}

reg(
  "notion_page_list",
  "Search Notion pages the integration can access (POST /v1/search, object filter page).",
  notionSearchSchema,
  async (parsed) => {
    const body = notionSearchPostBody("page", parsed);
    const res = await notionFetch("/search", { method: "POST", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionPageIdSchema = z.object({ pageId: z.string().min(1) });

reg(
  "notion_page_get",
  "Retrieve a Notion page and its direct child blocks.",
  notionPageIdSchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.pageId);
    const page = await notionFetch(`/pages/${id}`);
    const blocks = await notionFetch(`/blocks/${id}/children?page_size=100`);
    return jsonResult({
      page: parseJsonTextIfOk("Notion", page),
      blockChildren: parseJsonTextIfOk("Notion blocks", blocks),
    });
  },
);

reg(
  "notion_database_list",
  "Search Notion databases (POST /v1/search, object filter database).",
  notionSearchSchema,
  async (parsed) => {
    const body = notionSearchPostBody("database", parsed);
    const res = await notionFetch("/search", { method: "POST", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionDatabaseQuerySchema = z.object({
  databaseId: z.string().min(1),
  pageSize: z.number().int().min(1).max(100).optional(),
  startCursor: z.string().optional(),
});

reg(
  "notion_database_query",
  "Query a Notion database (POST /v1/databases/{id}/query).",
  notionDatabaseQuerySchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.databaseId);
    const body: Record<string, unknown> = {
      page_size: parsed.pageSize ?? 50,
    };
    putOptionalNonEmptyString(body, "start_cursor", parsed.startCursor);
    const res = await notionFetch(`/databases/${id}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionBlockPagedSchema = z.object({
  blockId: z.string().min(1),
  pageSize: z.number().int().min(1).max(100).optional(),
  startCursor: z.string().optional(),
});

reg(
  "notion_block_children",
  "List child blocks of a block or page (GET /v1/blocks/{id}/children).",
  notionBlockPagedSchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.blockId);
    const qs = new URLSearchParams({
      page_size: String(parsed.pageSize ?? 50),
    });
    if (parsed.startCursor !== undefined && parsed.startCursor !== "") {
      qs.set("start_cursor", parsed.startCursor);
    }
    const res = await notionFetch(`/blocks/${id}/children?${qs.toString()}`);
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

reg(
  "notion_comment_list",
  "List comments for a block or page (GET /v1/comments).",
  notionBlockPagedSchema,
  async (parsed) => {
    const qs = new URLSearchParams({
      block_id: parsed.blockId,
      page_size: String(parsed.pageSize ?? 50),
    });
    if (parsed.startCursor !== undefined && parsed.startCursor !== "") {
      qs.set("start_cursor", parsed.startCursor);
    }
    const res = await notionFetch(`/comments?${qs.toString()}`);
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionPageCreateSchema = z.object({
  parentPageId: z.string().min(1),
  title: z.string().min(1),
  titlePropertyName: z.string().min(1).optional(),
});

registerWriteTool(
  "notion_page_create",
  {
    mutates: "notion.page.create",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "page", value: p.parentPageId }),
  },
  "Create a page under a parent page (POST /v1/pages).",
  notionPageCreateSchema,
  async (parsed) => {
    const prop = parsed.titlePropertyName ?? "title";
    const body = {
      parent: { page_id: parsed.parentPageId },
      properties: {
        [prop]: {
          title: richText(parsed.title),
        },
      },
    };
    const res = await notionFetch("/pages", { method: "POST", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionKbAppendSchema = z.object({
  databaseId: z.string().min(1),
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  citationsJson: z.string().optional(),
  titlePropertyName: z.string().min(1).optional(),
});

registerWriteTool(
  "notion_kb_append",
  {
    mutates: "notion.knowledge.write",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "database", value: p.databaseId }),
  },
  "Create a knowledge-base page in a database from simple markdown + citations (POST /v1/pages). " +
    "Used by Nimbus tribal-knowledge capture; the destination database is supplied by the gateway from local config only.",
  notionKbAppendSchema,
  async (parsed) => {
    const body = buildNotionKbPageBody({
      databaseId: parsed.databaseId,
      title: parsed.title,
      bodyMarkdown: parsed.bodyMarkdown,
      citations: parseCitationsJson(parsed.citationsJson ?? "[]"),
      ...(parsed.titlePropertyName === undefined
        ? {}
        : { titlePropertyName: parsed.titlePropertyName }),
    });
    const res = await notionFetch("/pages", { method: "POST", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionPageUpdateSchema = z.object({
  pageId: z.string().min(1),
  propertiesJson: z.string().min(1),
});

registerWriteTool(
  "notion_page_update",
  {
    mutates: "notion.page.update",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "page", value: p.pageId }),
  },
  "Update page properties (PATCH /v1/pages/{id}). Pass properties JSON as string.",
  notionPageUpdateSchema,
  async (parsed) => {
    let props: unknown;
    try {
      props = JSON.parse(parsed.propertiesJson) as unknown;
    } catch {
      throw new Error("propertiesJson must be valid JSON");
    }
    if (props === null || typeof props !== "object" || Array.isArray(props)) {
      throw new Error("propertiesJson must be a JSON object");
    }
    const id = encodeURIComponent(parsed.pageId);
    const res = await notionFetch(`/pages/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: props }),
    });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionBlockAppendSchema = z.object({
  parentBlockId: z.string().min(1),
  childrenJson: z.string().min(1),
});

registerWriteTool(
  "notion_block_append",
  {
    mutates: "notion.block.append",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "block", value: p.parentBlockId }),
  },
  "Append blocks to a parent block (PATCH /v1/blocks/{id}/children). childrenJson is a JSON array of block objects.",
  notionBlockAppendSchema,
  async (parsed) => {
    let children: unknown;
    try {
      children = JSON.parse(parsed.childrenJson) as unknown;
    } catch {
      throw new Error("childrenJson must be valid JSON");
    }
    if (!Array.isArray(children)) {
      throw new TypeError("childrenJson must be a JSON array");
    }
    const id = encodeURIComponent(parsed.parentBlockId);
    const res = await notionFetch(`/blocks/${id}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children }),
    });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const notionCommentCreateSchema = z.object({
  pageId: z.string().min(1),
  text: z.string().min(1),
});

registerWriteTool(
  "notion_comment_create",
  {
    mutates: "notion.comment.create",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "page", value: p.pageId }),
  },
  "Create a comment thread on a page (POST /v1/comments).",
  notionCommentCreateSchema,
  async (parsed) => {
    const body = {
      parent: { page_id: parsed.pageId },
      rich_text: richText(parsed.text),
    };
    const res = await notionFetch("/comments", { method: "POST", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Notion", res);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
