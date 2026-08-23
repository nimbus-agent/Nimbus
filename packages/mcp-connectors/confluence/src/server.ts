import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fetchAtlassianBasicAuthJsonText,
  normalizeRequiredSiteBaseUrl,
  requireTrimmedEnv,
} from "../../shared/atlassian-json-fetch.ts";
import { joinApiPath } from "../../shared/join-api-path.ts";
import { parseCitationsJson } from "../../shared/kb-markdown.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResultFromTextIfOk,
} from "../../shared/mcp-tool-kit.ts";
import { buildConfluenceKbPageBody } from "./kb-append.ts";

function wikiRoot(siteBase: string): string {
  const b = normalizeRequiredSiteBaseUrl(siteBase, "CONFLUENCE_BASE_URL is empty");
  return b.endsWith("/wiki") ? b : `${b}/wiki`;
}

function requireConfluenceConfig(): { wikiApi: string; email: string; token: string } {
  const baseRaw = requireTrimmedEnv("CONFLUENCE_BASE_URL", "CONFLUENCE_BASE_URL is not set");
  const email = requireTrimmedEnv("CONFLUENCE_EMAIL", "CONFLUENCE_EMAIL is not set");
  const token = requireTrimmedEnv("CONFLUENCE_API_TOKEN", "CONFLUENCE_API_TOKEN is not set");
  return {
    wikiApi: `${wikiRoot(baseRaw)}/rest/api`,
    email,
    token,
  };
}

async function confFetch(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  const { wikiApi, email, token } = requireConfluenceConfig();
  const url = joinApiPath(wikiApi, path);
  return fetchAtlassianBasicAuthJsonText(url, email, token, init);
}

const server = new McpServer({ name: "nimbus-confluence", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING confluence tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "confluence",
  scopeEnv: "NIMBUS_MCP_CONFLUENCE_WRITE_SCOPE",
  scopeKinds: ["space", "page"],
});

const confluenceLimitStartSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  start: z.number().int().min(0).optional(),
});

reg(
  "confluence_space_list",
  "List Confluence spaces (GET /space).",
  confluenceLimitStartSchema,
  async (parsed) => {
    const qs = new URLSearchParams({
      limit: String(parsed.limit ?? 25),
      start: String(parsed.start ?? 0),
    });
    const res = await confFetch(`/space?${qs.toString()}`);
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluenceSpaceContentSchema = z.object({
  spaceKey: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  start: z.number().int().min(0).optional(),
});

reg(
  "confluence_page_list",
  "List pages in a space (GET /content, type=page).",
  confluenceSpaceContentSchema,
  async (parsed) => {
    const qs = new URLSearchParams({
      type: "page",
      spaceKey: parsed.spaceKey,
      limit: String(parsed.limit ?? 50),
      start: String(parsed.start ?? 0),
      expand: "history.lastUpdated,version",
    });
    const res = await confFetch(`/content?${qs.toString()}`);
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluencePageIdSchema = z.object({ pageId: z.string().min(1) });

reg(
  "confluence_page_get",
  "Get a Confluence page with body.storage (GET /content/{id}).",
  confluencePageIdSchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.pageId);
    const res = await confFetch(
      `/content/${id}?expand=body.storage,version,history.lastUpdated,space`,
    );
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

reg(
  "confluence_blogpost_list",
  "List blog posts in a space (GET /content, type=blogpost).",
  confluenceSpaceContentSchema,
  async (parsed) => {
    const qs = new URLSearchParams({
      type: "blogpost",
      spaceKey: parsed.spaceKey,
      limit: String(parsed.limit ?? 25),
      start: String(parsed.start ?? 0),
      expand: "history.lastUpdated,version",
    });
    const res = await confFetch(`/content?${qs.toString()}`);
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluencePostIdSchema = z.object({ postId: z.string().min(1) });

reg(
  "confluence_blogpost_get",
  "Get a blog post by id (GET /content/{id}).",
  confluencePostIdSchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.postId);
    const res = await confFetch(
      `/content/${id}?expand=body.storage,version,history.lastUpdated,space`,
    );
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluenceCommentListSchema = z.object({
  pageId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  start: z.number().int().min(0).optional(),
});

reg(
  "confluence_comment_list",
  "List footer comments on a page (GET /content/{id}/child/comment).",
  confluenceCommentListSchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.pageId);
    const qs = new URLSearchParams({
      limit: String(parsed.limit ?? 50),
      start: String(parsed.start ?? 0),
      expand: "body.storage,version",
    });
    const res = await confFetch(`/content/${id}/child/comment?${qs.toString()}`);
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluencePageCreateSchema = z.object({
  spaceKey: z.string().min(1),
  title: z.string().min(1),
  storageHtml: z.string().min(1),
  parentPageId: z.string().min(1).optional(),
});

registerWriteTool(
  "confluence_page_create",
  {
    mutates: "confluence.page.create",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "space", value: p.spaceKey }),
  },
  "Create a page in a space (POST /content). Optional parentPageId.",
  confluencePageCreateSchema,
  async (parsed) => {
    const body: Record<string, unknown> = {
      type: "page",
      title: parsed.title,
      space: { key: parsed.spaceKey },
      body: {
        storage: {
          value: parsed.storageHtml,
          representation: "storage",
        },
      },
    };
    if (parsed.parentPageId !== undefined) {
      body["ancestors"] = [{ id: parsed.parentPageId }];
    }
    const res = await confFetch("/content", { method: "POST", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluenceKbAppendSchema = z.object({
  spaceKey: z.string().min(1),
  parentPageId: z.string().min(1),
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  citationsJson: z.string().optional(),
});

registerWriteTool(
  "confluence_kb_append",
  {
    mutates: "confluence.knowledge.write",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "space", value: p.spaceKey }),
  },
  "Create a knowledge-base page under a parent from simple markdown + citations (POST /content). " +
    "Used by Nimbus tribal-knowledge capture; the destination space/parent is supplied by the gateway from local config only.",
  confluenceKbAppendSchema,
  async (parsed) => {
    const body = buildConfluenceKbPageBody({
      spaceKey: parsed.spaceKey,
      parentPageId: parsed.parentPageId,
      title: parsed.title,
      bodyMarkdown: parsed.bodyMarkdown,
      citations: parseCitationsJson(parsed.citationsJson ?? "[]"),
    });
    const res = await confFetch("/content", { method: "POST", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluencePageUpdateSchema = z.object({
  pageId: z.string().min(1),
  versionNumber: z.number().int().min(1),
  title: z.string().min(1),
  storageHtml: z.string().min(1),
});

registerWriteTool(
  "confluence_page_update",
  {
    mutates: "confluence.page.update",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "page", value: p.pageId }),
  },
  "Update page body and bump version (PUT /content/{id}). Pass current version number and title.",
  confluencePageUpdateSchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.pageId);
    const body: Record<string, unknown> = {
      type: "page",
      title: parsed.title,
      version: { number: parsed.versionNumber + 1, message: "nimbus" },
      body: {
        storage: {
          value: parsed.storageHtml,
          representation: "storage",
        },
      },
    };
    const res = await confFetch(`/content/${id}`, { method: "PUT", body: JSON.stringify(body) });
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const confluenceCommentAddSchema = z.object({
  pageId: z.string().min(1),
  storageHtml: z.string().min(1),
});

registerWriteTool(
  "confluence_comment_add",
  {
    mutates: "confluence.comment.add",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "page", value: p.pageId }),
  },
  "Add a footer comment to a page (POST /content/{id}/child/comment).",
  confluenceCommentAddSchema,
  async (parsed) => {
    const id = encodeURIComponent(parsed.pageId);
    const body = {
      type: "comment",
      container: { id: parsed.pageId, type: "page" },
      body: {
        storage: {
          value: parsed.storageHtml,
          representation: "storage",
        },
      },
    };
    const res = await confFetch(`/content/${id}/child/comment`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mcpJsonResultFromTextIfOk("Confluence", res);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
