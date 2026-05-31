import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchBearerAuthorizedJson, resolveUrlWithBase } from "../../shared/fetch-bearer-json.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResultIfOk,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const PHOTOS_BASE = "https://photoslibrary.googleapis.com/v1";

async function photosFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = resolveUrlWithBase(PHOTOS_BASE, path);
  return fetchBearerAuthorizedJson(url, token, init, { "Content-Type": "application/json" });
}

const server = new McpServer({ name: "nimbus-google-photos", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);
const reg = createZodToolRegistrar(registerSimpleTool);

const gphotosAlbumListArgs = z.object({
  pageSize: z.number().int().min(1).max(50).optional(),
  pageToken: z.string().optional(),
});

reg(
  "gphotos_album_list",
  "List Google Photos albums (metadata). Pagination via pageToken.",
  gphotosAlbumListArgs,
  async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const u = new URL(`${PHOTOS_BASE}/albums`);
    u.searchParams.set("pageSize", String(parsed.pageSize ?? 25));
    if (parsed.pageToken !== undefined && parsed.pageToken !== "") {
      u.searchParams.set("pageToken", parsed.pageToken);
    }
    const r = await photosFetch(token, `${u.pathname}${u.search}`);
    return mcpJsonResultIfOk("Google Photos API", r);
  },
);

const gphotosAlbumGetArgs = z.object({
  albumId: z.string().min(1),
});

reg(
  "gphotos_album_get",
  "Get a single album by id (title, mediaItemsCount, coverPhotoBaseUrl).",
  gphotosAlbumGetArgs,
  async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const r = await photosFetch(token, `/albums/${encodeURIComponent(parsed.albumId)}`);
    return mcpJsonResultIfOk("Google Photos API", r);
  },
);

const gphotosMediaListArgs = z.object({
  albumId: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

reg(
  "gphotos_media_list",
  "List media items (metadata + baseUrl/productUrl only). Optional albumId scopes to one album.",
  gphotosMediaListArgs,
  async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const body: Record<string, unknown> = {
      pageSize: parsed.pageSize ?? 50,
    };
    if (parsed.pageToken !== undefined && parsed.pageToken !== "") {
      body["pageToken"] = parsed.pageToken;
    }
    if (parsed.albumId !== undefined && parsed.albumId !== "") {
      body["albumId"] = parsed.albumId;
    }
    const r = await photosFetch(token, "/mediaItems:search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mcpJsonResultIfOk("Google Photos API", r);
  },
);

const gphotosMediaGetArgs = z.object({
  mediaItemId: z.string().min(1),
});

reg(
  "gphotos_media_get",
  "Get a single media item metadata by id.",
  gphotosMediaGetArgs,
  async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const r = await photosFetch(token, `/mediaItems/${encodeURIComponent(parsed.mediaItemId)}`);
    return mcpJsonResultIfOk("Google Photos API", r);
  },
);

const gphotosMediaSearchArgs = z.object({
  albumId: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  includeArchivedMedia: z.boolean().optional(),
  excludeNonAppCreatedData: z.boolean().optional(),
});

reg(
  "gphotos_media_search",
  "Search media items (metadata only). Optional album filter; supports pagination.",
  gphotosMediaSearchArgs,
  async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const body: Record<string, unknown> = {
      pageSize: parsed.pageSize ?? 50,
    };
    if (parsed.pageToken !== undefined && parsed.pageToken !== "") {
      body["pageToken"] = parsed.pageToken;
    }
    if (parsed.albumId !== undefined && parsed.albumId !== "") {
      body["albumId"] = parsed.albumId;
    }
    const filters: Record<string, unknown> = {};
    if (parsed.includeArchivedMedia === true) {
      filters["includeArchivedMedia"] = true;
    }
    if (parsed.excludeNonAppCreatedData === true) {
      filters["excludeNonAppCreatedData"] = true;
    }
    if (Object.keys(filters).length > 0) {
      body["filters"] = filters;
    }
    const r = await photosFetch(token, "/mediaItems:search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mcpJsonResultIfOk("Google Photos API", r);
  },
);

await server.connect(new StdioServerTransport());
