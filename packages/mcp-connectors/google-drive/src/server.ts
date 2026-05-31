import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  type McpListResult,
  mcpJsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import { escapeDriveQueryLiteral } from "./drive-query.ts";

const METADATA_FIELDS =
  "id, name, mimeType, description, starred, trashed, parents, webViewLink, webContentLink, size, createdTime, modifiedTime, owners(displayName,emailAddress), shared";

const GOOGLE_APPS_EXPORT_MIME: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

async function driveListFiles(
  token: string,
  pageSize: number,
  pageToken: string | undefined,
  q: string,
): Promise<unknown> {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    fields:
      "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size, description)",
    q,
  });
  if (pageToken !== undefined && pageToken !== "") {
    params.set("pageToken", pageToken);
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive API ${String(res.status)}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as unknown;
}

async function driveGetFileMetadata(token: string, fileId: string): Promise<unknown> {
  const params = new URLSearchParams({ fields: METADATA_FIELDS });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive API ${String(res.status)}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as unknown;
}

type DownloadOk = {
  fileId: string;
  name: string;
  mimeType: string;
  encoding: "base64" | "utf-8";
  exportMimeType?: string;
  truncated: boolean;
  content: string;
};

function jsonFileTooLarge(sizeBytes: number, maxBytes: number, message: string): string {
  return JSON.stringify({
    code: "FILE_TOO_LARGE",
    sizeBytes,
    maxBytes,
    message,
  });
}

async function driveDownloadGoogleAppsExport(
  token: string,
  fileId: string,
  name: string,
  mimeType: string,
  exportMime: string,
  maxBytes: number,
): Promise<{ ok: true; payload: DownloadOk } | { ok: false; message: string }> {
  const exportUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
  const res = await fetch(exportUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, message: `export ${String(res.status)}: ${body.slice(0, 200)}` };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const truncated = buf.byteLength > maxBytes;
  const slice = truncated ? buf.slice(0, maxBytes) : buf;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return {
    ok: true,
    payload: {
      fileId,
      name,
      mimeType,
      encoding: "utf-8",
      exportMimeType: exportMime,
      truncated,
      content: text,
    },
  };
}

async function driveDownloadMediaPayload(
  token: string,
  fileId: string,
  name: string,
  mimeType: string,
  meta: Record<string, unknown>,
  maxBytes: number,
): Promise<{ ok: true; payload: DownloadOk } | { ok: false; message: string }> {
  const sizeStr = meta["size"];
  if (typeof sizeStr === "string" && sizeStr !== "") {
    const n = Number.parseInt(sizeStr, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      return {
        ok: false,
        message: jsonFileTooLarge(n, maxBytes, "File exceeds maxBytes."),
      };
    }
  }

  const mediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, message: `download ${String(res.status)}: ${body.slice(0, 200)}` };
  }
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null && contentLength !== "") {
    const n = Number.parseInt(contentLength, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      return {
        ok: false,
        message: jsonFileTooLarge(n, maxBytes, "File exceeds maxBytes."),
      };
    }
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    return {
      ok: false,
      message: jsonFileTooLarge(buf.byteLength, maxBytes, "Downloaded content exceeds maxBytes."),
    };
  }
  const isTextLike = mimeType === "text/plain" || mimeType.startsWith("text/");
  if (isTextLike) {
    return {
      ok: true,
      payload: {
        fileId,
        name,
        mimeType,
        encoding: "utf-8",
        truncated: false,
        content: new TextDecoder("utf-8", { fatal: false }).decode(buf),
      },
    };
  }
  return {
    ok: true,
    payload: {
      fileId,
      name,
      mimeType,
      encoding: "base64",
      truncated: false,
      content: Buffer.from(buf).toString("base64"),
    },
  };
}

async function driveDownloadFile(
  token: string,
  fileId: string,
  maxBytes: number,
): Promise<{ ok: true; payload: DownloadOk } | { ok: false; message: string }> {
  const params = new URLSearchParams({
    fields: "id,name,mimeType,size,webViewLink",
  });
  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) {
    const body = await metaRes.text();
    return { ok: false, message: `metadata ${String(metaRes.status)}: ${body.slice(0, 200)}` };
  }
  const metaUnknown: unknown = await metaRes.json();
  if (metaUnknown === null || typeof metaUnknown !== "object" || Array.isArray(metaUnknown)) {
    return { ok: false, message: "metadata: invalid response" };
  }
  const meta = metaUnknown as Record<string, unknown>;
  const mimeType = typeof meta["mimeType"] === "string" ? meta["mimeType"] : "";
  const name = typeof meta["name"] === "string" ? meta["name"] : fileId;

  if (mimeType.startsWith("application/vnd.google-apps.")) {
    const exportMime = GOOGLE_APPS_EXPORT_MIME[mimeType];
    if (exportMime === undefined) {
      const webViewLink = typeof meta["webViewLink"] === "string" ? meta["webViewLink"] : null;
      return {
        ok: false,
        message: JSON.stringify({
          code: "EXPORT_NOT_SUPPORTED",
          mimeType,
          webViewLink,
          message:
            "This Google Workspace type is not exported as text here; use gdrive_file_metadata for webViewLink.",
        }),
      };
    }
    return driveDownloadGoogleAppsExport(token, fileId, name, mimeType, exportMime, maxBytes);
  }

  return driveDownloadMediaPayload(token, fileId, name, mimeType, meta, maxBytes);
}

async function drivePatchJson(
  token: string,
  fileId: string,
  body: Record<string, unknown>,
  query?: URLSearchParams,
): Promise<unknown> {
  const path = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  const url = query !== undefined && [...query].length > 0 ? `${path}?${query.toString()}` : path;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive API ${String(res.status)}: ${errText.slice(0, 200)}`);
  }
  return (await res.json()) as unknown;
}

async function drivePostCreateMetadata(
  token: string,
  metadata: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive API ${String(res.status)}: ${errText.slice(0, 200)}`);
  }
  return (await res.json()) as unknown;
}

async function driveMultipartCreate(
  token: string,
  metadata: { name: string; mimeType: string; parents?: string[] },
  mediaBody: string,
  mediaMime: string,
): Promise<unknown> {
  const boundary = `nimbus_${randomBytes(16).toString("hex")}`;
  const metaJson = JSON.stringify(metadata);
  const crlf = "\r\n";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metaJson,
    `--${boundary}`,
    `Content-Type: ${mediaMime}`,
    "",
    mediaBody,
    `--${boundary}--`,
  ].join(crlf);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive API ${String(res.status)}: ${errText.slice(0, 200)}`);
  }
  return (await res.json()) as unknown;
}

async function driveListParents(token: string, fileId: string): Promise<string[]> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=parents`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive API ${String(res.status)}: ${errText.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return [];
  }
  const parentsRaw = (json as Record<string, unknown>)["parents"];
  if (!Array.isArray(parentsRaw)) {
    return [];
  }
  return parentsRaw.filter((p): p is string => typeof p === "string" && p !== "");
}

const server = new McpServer({ name: "nimbus-google-drive", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);

const gdriveFileListArgs = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

registerSimpleTool(
  "gdrive_file_list",
  "List Google Drive files (metadata only). Supports pagination via pageToken from the previous response.",
  gdriveFileListArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileListArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const pageSize = parsed.data.pageSize ?? 25;
    const data = await driveListFiles(token, pageSize, parsed.data.pageToken, "trashed = false");
    return mcpJsonResult(data);
  },
);

const gdriveFileMetadataArgs = z.object({
  fileId: z.string().min(1),
});

registerSimpleTool(
  "gdrive_file_metadata",
  "Get metadata for a single Drive file or folder (owners, parents, links, mimeType, description).",
  gdriveFileMetadataArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileMetadataArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const data = await driveGetFileMetadata(token, parsed.data.fileId);
    return mcpJsonResult(data);
  },
);

const gdriveFileSearchArgs = z.object({
  query: z.string().min(1).max(500),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

registerSimpleTool(
  "gdrive_file_search",
  "Full-text search over Drive using the Drive search API (fullText contains your phrase). Non-trashed files only.",
  gdriveFileSearchArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileSearchArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const escaped = escapeDriveQueryLiteral(parsed.data.query);
    const q = `fullText contains '${escaped}' and trashed = false`;
    const pageSize = parsed.data.pageSize ?? 25;
    const data = await driveListFiles(token, pageSize, parsed.data.pageToken, q);
    return mcpJsonResult(data);
  },
);

const gdriveFileDownloadArgs = z.object({
  fileId: z.string().min(1),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .optional(),
});

registerSimpleTool(
  "gdrive_file_download",
  "Download file bytes (base64) or text (utf-8 for text/*). Google Docs → plain text export; Sheets → CSV. Capped by maxBytes (default 256 KiB, max 16 MiB).",
  gdriveFileDownloadArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileDownloadArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const maxBytes = parsed.data.maxBytes ?? 256 * 1024;
    const result = await driveDownloadFile(token, parsed.data.fileId, maxBytes);
    if (!result.ok) {
      throw new Error(result.message);
    }
    return mcpJsonResult(result.payload);
  },
);

const gdriveFileCreateArgs = z.object({
  name: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200).optional(),
  parentId: z.string().min(1).optional(),
  content: z.string().max(4_000_000).optional(),
});

registerSimpleTool(
  "gdrive_file_create",
  "Create a Google Drive file. Optional text `content` uses multipart upload. Empty file if content omitted. Requires Gateway HITL file.create.",
  gdriveFileCreateArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileCreateArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const mime = parsed.data.mimeType ?? "text/plain";
    const meta: { name: string; mimeType: string; parents?: string[] } = {
      name: parsed.data.name,
      mimeType: mime,
    };
    if (parsed.data.parentId !== undefined) {
      meta.parents = [parsed.data.parentId];
    }
    let data: unknown;
    if (parsed.data.content !== undefined && parsed.data.content !== "") {
      data = await driveMultipartCreate(token, meta, parsed.data.content, mime);
    } else {
      data = await drivePostCreateMetadata(token, meta);
    }
    return mcpJsonResult(data);
  },
);

const gdriveFileTrashArgs = z.object({
  fileId: z.string().min(1),
});

registerSimpleTool(
  "gdrive_file_trash",
  "Move a Drive file or folder to trash (recoverable). Requires Gateway HITL file.delete.",
  gdriveFileTrashArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileTrashArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const data = await drivePatchJson(token, parsed.data.fileId, { trashed: true });
    return mcpJsonResult(data);
  },
);

const gdriveFileMoveArgs = z.object({
  fileId: z.string().min(1),
  newParentId: z.string().min(1),
  removeParentId: z.string().min(1).optional(),
});

registerSimpleTool(
  "gdrive_file_move",
  "Move a file or folder to another parent folder (Drive parents). If removeParentId is omitted, the first current parent is used. Requires Gateway HITL file.move.",
  gdriveFileMoveArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileMoveArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    let remove = parsed.data.removeParentId;
    if (remove === undefined) {
      const parents = await driveListParents(token, parsed.data.fileId);
      const first = parents[0];
      if (first === undefined) {
        throw new Error("Cannot infer removeParentId: file has no parents (may be root-only)");
      }
      remove = first;
    }
    const q = new URLSearchParams({
      addParents: parsed.data.newParentId,
      removeParents: remove,
    });
    const data = await drivePatchJson(token, parsed.data.fileId, {}, q);
    return mcpJsonResult(data);
  },
);

const gdriveFileRenameArgs = z.object({
  fileId: z.string().min(1),
  newName: z.string().min(1).max(500),
});

registerSimpleTool(
  "gdrive_file_rename",
  "Rename a Drive file or folder. Requires Gateway HITL file.rename.",
  gdriveFileRenameArgs.shape,
  async (args: unknown): Promise<McpListResult> => {
    const parsed = gdriveFileRenameArgs.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    const data = await drivePatchJson(token, parsed.data.fileId, { name: parsed.data.newName });
    return mcpJsonResult(data);
  },
);

await server.connect(new StdioServerTransport());
