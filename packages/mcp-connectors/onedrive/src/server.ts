import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { resolveUrlWithBase } from "../../shared/fetch-bearer-json.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
  type ZodObjectSchema,
} from "../../shared/mcp-tool-kit.ts";
import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

async function graphRequest(
  token: string,
  pathOrUrl: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string; bytes: number }> {
  const url = resolveUrlWithBase(GRAPH, pathOrUrl);
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

import { createWriteToolRegistrar, type WriteToolConfig } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

/**
 * Every MUTATING onedrive tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "onedrive",
  scopeEnv: "NIMBUS_MCP_ONEDRIVE_WRITE_SCOPE",
  scopeKinds: ["item"],
});

/** Standard Graph tool: token → graphRequest(buildPath[, buildInit]) → mcpJsonResultIfOk("Graph", …, 200). */
/**
 * The write-tool equivalent of `registerOnedriveTool`: identical fetch and result handling, routed
 * through the write registrar.
 */
function registerOnedriveWriteTool<T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  buildPath: (p: T) => string,
  buildInit?: (p: T) => RequestInit,
): void {
  registerWriteTool(name, cfg, description, schema, async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const res = await graphRequest(token, buildPath(parsed), buildInit?.(parsed));
    return mcpJsonResultIfOk("Graph", res, 200);
  });
}

const registerOnedriveTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "MICROSOFT_OAUTH_ACCESS_TOKEN",
  serviceLabel: "Graph",
  fetch: graphRequest,
  snippetMax: 200,
});

const onedriveItemListArgs = z.object({
  parentId: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
  nextLink: z.url().optional(),
});

registerOnedriveTool(
  "onedrive_item_list",
  "List drive items under root or a folder (by parentId). Use nextLink from prior response for pagination.",
  onedriveItemListArgs,
  (data) => {
    if (data.nextLink !== undefined && data.nextLink !== "") {
      return data.nextLink;
    }
    const pageSize = data.pageSize ?? 50;
    if (data.parentId !== undefined && data.parentId !== "") {
      return `/me/drive/items/${encodeURIComponent(data.parentId)}/children?$top=${String(pageSize)}`;
    }
    return `/me/drive/root/children?$top=${String(pageSize)}`;
  },
);

const onedriveItemGetArgs = z.object({
  itemId: z.string().min(1),
});

registerOnedriveTool(
  "onedrive_item_get",
  "Get OneDrive item metadata by id (file or folder).",
  onedriveItemGetArgs,
  (data) => `/me/drive/items/${encodeURIComponent(data.itemId)}`,
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

reg(
  "onedrive_item_download",
  "Download file content as base64 (capped by maxBytes, default 256 KiB). Folders are rejected.",
  onedriveItemDownloadArgs,
  async (data) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const maxBytes = data.maxBytes ?? 256 * 1024;
    const meta = await graphRequest(
      token,
      `/me/drive/items/${encodeURIComponent(data.itemId)}?$select=id,name,folder,file`,
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
    const res = await fetch(`${GRAPH}/me/drive/items/${encodeURIComponent(data.itemId)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = await res.arrayBuffer();
    if (!res.ok) {
      const err = new TextDecoder().decode(buf);
      throw new Error(`Graph ${String(res.status)}: ${err.slice(0, 200)}`);
    }
    const truncated = buf.byteLength > maxBytes;
    const slice = truncated ? buf.slice(0, maxBytes) : buf;
    const b64 = Buffer.from(slice).toString("base64");
    const out = {
      itemId: data.itemId,
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

registerOnedriveTool(
  "onedrive_item_search",
  "Search OneDrive under /me/drive/root/search.",
  onedriveItemSearchArgs,
  (data) => {
    if (data.nextLink !== undefined && data.nextLink !== "") {
      return data.nextLink;
    }
    const pageSize = data.pageSize ?? 25;
    const escaped = data.query.replaceAll("'", "''");
    return `/me/drive/root/search(q='${escaped}')?$top=${String(pageSize)}`;
  },
);

const onedriveItemDeleteArgs = z.object({
  itemId: z.string().min(1),
});

registerWriteTool(
  "onedrive_item_delete",
  {
    mutates: "onedrive.item.delete",
    recoverable: false,
    capturePreState: (p) => Promise.resolve({ itemId: p.itemId }),
    scopeTargetOf: (p) => ({ kind: "item", value: p.itemId }),
  },
  "Permanently delete a OneDrive item. Requires Gateway HITL onedrive.delete.",
  onedriveItemDeleteArgs,
  async (data) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const r = await graphRequest(token, `/me/drive/items/${encodeURIComponent(data.itemId)}`, {
      method: "DELETE",
    });
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

registerOnedriveWriteTool(
  "onedrive_item_move",
  {
    mutates: "onedrive.item.move",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "item", value: p.itemId }),
  },
  "Move (and optionally rename) a drive item. Requires Gateway HITL onedrive.move.",
  onedriveItemMoveArgs,
  (data) => `/me/drive/items/${encodeURIComponent(data.itemId)}`,
  (data) => {
    const body: Record<string, unknown> = {
      parentReference: { id: data.newParentId },
    };
    if (data.newName !== undefined) {
      body["name"] = data.newName;
    }
    return {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  },
);

await server.connect(new StdioServerTransport());
