import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchBearerAuthorizedJson, resolveUrlWithBase } from "../../shared/fetch-bearer-json.ts";
import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";
import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";

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

/** Standard Photos tool: token → photosFetch(buildPath[, buildInit]) → mcpJsonResultIfOk("Google Photos API"). */
const registerPhotosTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "GOOGLE_OAUTH_ACCESS_TOKEN",
  serviceLabel: "Google Photos API",
  fetch: photosFetch,
});

const gphotosAlbumListArgs = z.object({
  pageSize: z.number().int().min(1).max(50).optional(),
  pageToken: z.string().optional(),
});

registerPhotosTool(
  "gphotos_album_list",
  "List Google Photos albums (metadata). Pagination via pageToken.",
  gphotosAlbumListArgs,
  (parsed) => {
    const u = new URL(`${PHOTOS_BASE}/albums`);
    u.searchParams.set("pageSize", String(parsed.pageSize ?? 25));
    if (parsed.pageToken !== undefined && parsed.pageToken !== "") {
      u.searchParams.set("pageToken", parsed.pageToken);
    }
    return `${u.pathname}${u.search}`;
  },
);

const gphotosAlbumGetArgs = z.object({
  albumId: z.string().min(1),
});

registerPhotosTool(
  "gphotos_album_get",
  "Get a single album by id (title, mediaItemsCount, coverPhotoBaseUrl).",
  gphotosAlbumGetArgs,
  (parsed) => `/albums/${encodeURIComponent(parsed.albumId)}`,
);

const gphotosMediaListArgs = z.object({
  albumId: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

registerPhotosTool(
  "gphotos_media_list",
  "List media items (metadata + baseUrl/productUrl only). Optional albumId scopes to one album.",
  gphotosMediaListArgs,
  () => "/mediaItems:search",
  (parsed) => {
    const body: Record<string, unknown> = {
      pageSize: parsed.pageSize ?? 50,
    };
    if (parsed.pageToken !== undefined && parsed.pageToken !== "") {
      body["pageToken"] = parsed.pageToken;
    }
    if (parsed.albumId !== undefined && parsed.albumId !== "") {
      body["albumId"] = parsed.albumId;
    }
    return { method: "POST", body: JSON.stringify(body) };
  },
);

const gphotosMediaGetArgs = z.object({
  mediaItemId: z.string().min(1),
});

registerPhotosTool(
  "gphotos_media_get",
  "Get a single media item metadata by id.",
  gphotosMediaGetArgs,
  (parsed) => `/mediaItems/${encodeURIComponent(parsed.mediaItemId)}`,
);

const gphotosMediaSearchArgs = z.object({
  albumId: z.string().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  includeArchivedMedia: z.boolean().optional(),
  excludeNonAppCreatedData: z.boolean().optional(),
});

registerPhotosTool(
  "gphotos_media_search",
  "Search media items (metadata only). Optional album filter; supports pagination.",
  gphotosMediaSearchArgs,
  () => "/mediaItems:search",
  (parsed) => {
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
    return { method: "POST", body: JSON.stringify(body) };
  },
);

await server.connect(new StdioServerTransport());
