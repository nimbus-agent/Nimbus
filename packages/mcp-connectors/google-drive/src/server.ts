import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult,
  requireProcessEnv,
  type ZodObjectSchema,
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

const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

/**
 * Register a Drive tool whose body is the repeated shape `parse → token →
 * data = await drive<X>(token, …) → mcpJsonResult(data)`. The parse + the
 * `throw new Error(parsed.error.message)` live once in the shared registrar; the
 * handler receives the validated args + the OAuth token and returns the value to
 * wrap. Handlers needing a pre-wrap check (e.g. download's `!result.ok` throw)
 * do it inside the handler and return the payload.
 */
import { createWriteToolRegistrar, type WriteToolConfig } from "../../shared/consent-kit.ts";

/**
 * Every MUTATING google-drive tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "google-drive",
  scopeEnv: "NIMBUS_MCP_GOOGLE_DRIVE_WRITE_SCOPE",
  scopeKinds: ["folder", "file"],
});

/**
 * The write-tool equivalent of `registerDriveTool`: identical token handling and result wrapping,
 * routed through the write registrar.
 */
function registerDriveWriteTool<T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T, token: string) => Promise<unknown>,
): void {
  registerWriteTool(name, cfg, description, schema, async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    return mcpJsonResult(await handler(parsed, token));
  });
}

function registerDriveTool<T>(
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T, token: string) => Promise<unknown>,
): void {
  reg(name, description, schema, async (parsed) => {
    const token = requireProcessEnv("GOOGLE_OAUTH_ACCESS_TOKEN");
    return mcpJsonResult(await handler(parsed, token));
  });
}

const gdriveFileListArgs = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

registerDriveTool(
  "gdrive_file_list",
  "List Google Drive files (metadata only). Supports pagination via pageToken from the previous response.",
  gdriveFileListArgs,
  (args, token) => driveListFiles(token, args.pageSize ?? 25, args.pageToken, "trashed = false"),
);

const gdriveFileMetadataArgs = z.object({
  fileId: z.string().min(1),
});

registerDriveTool(
  "gdrive_file_metadata",
  "Get metadata for a single Drive file or folder (owners, parents, links, mimeType, description).",
  gdriveFileMetadataArgs,
  (args, token) => driveGetFileMetadata(token, args.fileId),
);

const gdriveFileSearchArgs = z.object({
  query: z.string().min(1).max(500),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

registerDriveTool(
  "gdrive_file_search",
  "Full-text search over Drive using the Drive search API (fullText contains your phrase). Non-trashed files only.",
  gdriveFileSearchArgs,
  (args, token) => {
    const escaped = escapeDriveQueryLiteral(args.query);
    const q = `fullText contains '${escaped}' and trashed = false`;
    return driveListFiles(token, args.pageSize ?? 25, args.pageToken, q);
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

registerDriveTool(
  "gdrive_file_download",
  "Download file bytes (base64) or text (utf-8 for text/*). Google Docs → plain text export; Sheets → CSV. Capped by maxBytes (default 256 KiB, max 16 MiB).",
  gdriveFileDownloadArgs,
  async (args, token) => {
    const result = await driveDownloadFile(token, args.fileId, args.maxBytes ?? 256 * 1024);
    if (!result.ok) {
      throw new Error(result.message);
    }
    return result.payload;
  },
);

const gdriveFileCreateArgs = z.object({
  name: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200).optional(),
  parentId: z.string().min(1).optional(),
  content: z.string().max(4_000_000).optional(),
});

registerDriveWriteTool(
  "gdrive_file_create",
  {
    mutates: "google_drive.file.create",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "folder", value: p.parentId ?? "root" }),
  },
  "Create a Google Drive file. Optional text `content` uses multipart upload. Empty file if content omitted. Requires Gateway HITL file.create.",
  gdriveFileCreateArgs,
  (args, token) => {
    const mime = args.mimeType ?? "text/plain";
    const meta: { name: string; mimeType: string; parents?: string[] } = {
      name: args.name,
      mimeType: mime,
    };
    if (args.parentId !== undefined) {
      meta.parents = [args.parentId];
    }
    if (args.content !== undefined && args.content !== "") {
      return driveMultipartCreate(token, meta, args.content, mime);
    }
    return drivePostCreateMetadata(token, meta);
  },
);

const gdriveFileTrashArgs = z.object({
  fileId: z.string().min(1),
});

registerDriveTool(
  "gdrive_file_trash",
  "Move a Drive file or folder to trash (recoverable). Requires Gateway HITL file.delete.",
  gdriveFileTrashArgs,
  (args, token) => drivePatchJson(token, args.fileId, { trashed: true }),
);

const gdriveFileMoveArgs = z.object({
  fileId: z.string().min(1),
  newParentId: z.string().min(1),
  removeParentId: z.string().min(1).optional(),
});

registerDriveWriteTool(
  "gdrive_file_move",
  {
    mutates: "google_drive.file.move",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "file", value: p.fileId }),
  },
  "Move a file or folder to another parent folder (Drive parents). If removeParentId is omitted, the first current parent is used. Requires Gateway HITL file.move.",
  gdriveFileMoveArgs,
  async (args, token) => {
    let remove = args.removeParentId;
    if (remove === undefined) {
      const parents = await driveListParents(token, args.fileId);
      const first = parents[0];
      if (first === undefined) {
        throw new Error("Cannot infer removeParentId: file has no parents (may be root-only)");
      }
      remove = first;
    }
    const q = new URLSearchParams({
      addParents: args.newParentId,
      removeParents: remove,
    });
    return drivePatchJson(token, args.fileId, {}, q);
  },
);

const gdriveFileRenameArgs = z.object({
  fileId: z.string().min(1),
  newName: z.string().min(1).max(500),
});

registerDriveWriteTool(
  "gdrive_file_rename",
  {
    mutates: "google_drive.file.rename",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "file", value: p.fileId }),
  },
  "Rename a Drive file or folder. Requires Gateway HITL file.rename.",
  gdriveFileRenameArgs,
  (args, token) => drivePatchJson(token, args.fileId, { name: args.newName }),
);

await server.connect(new StdioServerTransport());
