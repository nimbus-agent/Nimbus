import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fetchAtlassianBasicAuthJsonText,
  normalizeRequiredSiteBaseUrl,
  requireTrimmedEnv,
} from "../../shared/atlassian-json-fetch.ts";
import { joinApiPath } from "../../shared/join-api-path.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResultFromTextIfOk,
} from "../../shared/mcp-tool-kit.ts";

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
const reg = createZodToolRegistrar(registerSimpleTool);

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

reg(
  "confluence_page_create",
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

const confluencePageUpdateSchema = z.object({
  pageId: z.string().min(1),
  versionNumber: z.number().int().min(1),
  title: z.string().min(1),
  storageHtml: z.string().min(1),
});

reg(
  "confluence_page_update",
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

reg(
  "confluence_comment_add",
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
