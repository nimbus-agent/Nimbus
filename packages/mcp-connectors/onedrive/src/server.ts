import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  type McpListResult,
  mcpJsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

async function graphRequest(
  token: string,
  pathOrUrl: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string; bytes: number }> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const mergedHeaders = new Headers({ Authorization: `Bearer ${token}` });
  if (init?.headers !== undefined) {
    const extra = new Headers(init.headers);
    for (const [k, v] of extra) {
      mergedHeaders.set(k, v);
    }
  }
  const res = await fetch(url, {
    ...init,
    headers: mergedHeaders,
  });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text, bytes: buf.byteLength };
}

const server = new McpServer({ name: "nimbus-onedrive", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);

const onedriveItemListArgs = z.object({
  parentId: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
  nextLink: z.url().optional(),
});

registerSimpleTool(
  "onedrive_item_list",
  "List drive items under root or a folder (by parentId). Use nextLink from prior response for pagination.",
  onedriveItemListArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = onedriveItemListArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    let path: string;
    if (parsed.data.nextLink !== undefined && parsed.data.nextLink !== "") {
      const r = await graphRequest(token, parsed.data.nextLink);
      if (!r.ok) {
        throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
      }
      return mcpJsonResult(r.json);
    }
    const pageSize = parsed.data.pageSize ?? 50;
    if (parsed.data.parentId !== undefined && parsed.data.parentId !== "") {
      path = `/me/drive/items/${encodeURIComponent(parsed.data.parentId)}/children?$top=${String(pageSize)}`;
    } else {
      path = `/me/drive/root/children?$top=${String(pageSize)}`;
    }
    const r = await graphRequest(token, path);
    if (!r.ok) {
      throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const onedriveItemGetArgs = z.object({
  itemId: z.string().min(1),
});

registerSimpleTool(
  "onedrive_item_get",
  "Get OneDrive item metadata by id (file or folder).",
  onedriveItemGetArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = onedriveItemGetArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const r = await graphRequest(
      token,
      `/me/drive/items/${encodeURIComponent(parsed.data.itemId)}`,
    );
    if (!r.ok) {
      throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const onedriveItemDownloadArgs = z.object({
  itemId: z.string().min(1),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(8 * 1024 * 1024)
    .optional(),
});

registerSimpleTool(
  "onedrive_item_download",
  "Download file content as base64 (capped by maxBytes, default 256 KiB). Folders are rejected.",
  onedriveItemDownloadArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = onedriveItemDownloadArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const maxBytes = parsed.data.maxBytes ?? 256 * 1024;
    const meta = await graphRequest(
      token,
      `/me/drive/items/${encodeURIComponent(parsed.data.itemId)}?$select=id,name,folder,file`,
    );
    if (!meta.ok) {
      throw new Error(`Graph ${String(meta.status)}: ${meta.text.slice(0, 200)}`);
    }
    const m = meta.json;
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      throw new Error("Invalid metadata response");
    }
    const folder = (m as Record<string, unknown>)["folder"];
    if (folder !== undefined && folder !== null) {
      throw new Error("Item is a folder; download applies to files only");
    }
    const res = await fetch(
      `${GRAPH}/me/drive/items/${encodeURIComponent(parsed.data.itemId)}/content`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const buf = await res.arrayBuffer();
    if (!res.ok) {
      const err = new TextDecoder().decode(buf);
      throw new Error(`Graph ${String(res.status)}: ${err.slice(0, 200)}`);
    }
    const truncated = buf.byteLength > maxBytes;
    const slice = truncated ? buf.slice(0, maxBytes) : buf;
    const b64 = Buffer.from(slice).toString("base64");
    const out = {
      itemId: parsed.data.itemId,
      encoding: "base64" as const,
      truncated,
      byteLength: buf.byteLength,
      returnedBytes: slice.byteLength,
      content: b64,
    };
    return mcpJsonResult(out);
  },
);

const onedriveItemSearchArgs = z.object({
  query: z.string().min(1).max(500),
  pageSize: z.number().int().min(1).max(100).optional(),
  nextLink: z.url().optional(),
});

registerSimpleTool(
  "onedrive_item_search",
  "Search OneDrive under /me/drive/root/search.",
  onedriveItemSearchArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = onedriveItemSearchArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const pageSize = parsed.data.pageSize ?? 25;
    let path: string;
    if (parsed.data.nextLink !== undefined && parsed.data.nextLink !== "") {
      path = parsed.data.nextLink;
    } else {
      const escaped = parsed.data.query.replaceAll("'", "''");
      path = `/me/drive/root/search(q='${escaped}')?$top=${String(pageSize)}`;
    }
    const r = await graphRequest(token, path);
    if (!r.ok) {
      throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

const onedriveItemDeleteArgs = z.object({
  itemId: z.string().min(1),
});

registerSimpleTool(
  "onedrive_item_delete",
  "Permanently delete a OneDrive item. Requires Gateway HITL onedrive.delete.",
  onedriveItemDeleteArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = onedriveItemDeleteArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const r = await graphRequest(
      token,
      `/me/drive/items/${encodeURIComponent(parsed.data.itemId)}`,
      { method: "DELETE" },
    );
    if (!r.ok && r.status !== 204) {
      throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult({ ok: true });
  },
);

const onedriveItemMoveArgs = z.object({
  itemId: z.string().min(1),
  newParentId: z.string().min(1),
  newName: z.string().min(1).max(500).optional(),
});

registerSimpleTool(
  "onedrive_item_move",
  "Move (and optionally rename) a drive item. Requires Gateway HITL onedrive.move.",
  onedriveItemMoveArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = onedriveItemMoveArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const body: Record<string, unknown> = {
      parentReference: { id: parsed.data.newParentId },
    };
    if (parsed.data.newName !== undefined) {
      body["name"] = parsed.data.newName;
    }
    const r = await graphRequest(
      token,
      `/me/drive/items/${encodeURIComponent(parsed.data.itemId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      throw new Error(`Graph ${String(r.status)}: ${r.text.slice(0, 200)}`);
    }
    return mcpJsonResult(r.json);
  },
);

await server.connect(new StdioServerTransport());
